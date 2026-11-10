/**
 * dsh-monitor 的单测。
 *
 * 这里**故意不用真内核**：`ctx.jobs` / `ctx.subprocess` 用桩，是因为要验的是
 * 本插件自己的那几件事——按行切流、多字节字符跨 chunk、合并成一条通知、
 * 结束通知带不带 stderr、游标会不会回退。内核那两个 seam 各有自己的测试。
 *
 * 桩用 class、方法挂原型，和真实服务的形状一致。
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import {
  Config,
  LineReader,
  apply,
  truncateLine,
  type MonitorConfig,
  type MonitorSnapshot,
  type SuspendedMonitor,
  type RestartRecoveryResult,
  MONITOR_START_EVENT,
  type MonitorStartRequest,
  RESTART_ABORT_EVENT,
  RESTART_PREPARE_EVENT,
  RESTART_SURVIVORS_EVENT,
} from '../src/index.ts'
import { existsSync } from 'node:fs'

interface JobEntry {
  readonly id: string
  readonly spec: Record<string, unknown>
  readonly hooks: {
    cancel(reason?: string): void
    done: Promise<{ status: string; detail?: string }>
  }
  status: string
  detail: string | undefined
}

/** 只实现本插件用得到的那几个方法：start / list / get / kill / attachController。 */
class FakeJobs {
  private counter = 0
  private readonly store = new Map<string, JobEntry>()

  attachController(): () => void {
    return () => {}
  }

  start(spec: Record<string, unknown>): string {
    const id = `monitor-${++this.counter}`
    // 0.1.7 的 run 会收到注册表发的 job 句柄（id + 输出环写口）。
    const run = spec.run as (job: { id: string, append: (text: string) => void, updateProgress: (line: string) => void }) => JobEntry['hooks']
    const hooks = run({ id, append: () => {}, updateProgress: () => {} })
    const entry: JobEntry = { id, spec, hooks, status: 'running', detail: undefined }
    this.store.set(id, entry)
    void hooks.done.then(outcome => {
      entry.status = outcome.status
      entry.detail = outcome.detail
    })
    return id
  }

  list(): Array<Record<string, unknown>> {
    return [...this.store.values()].map(entry => this.snapshot(entry))
  }

  get(id: string): Record<string, unknown> {
    const entry = this.store.get(id)
    if (entry === undefined) throw new Error(`unknown job: ${id}`)
    return this.snapshot(entry)
  }

  /** 重启前暂停监听时插件会挂一个等待，好让宿主不发通用的结束通知；桩只记下被等过。 */
  readonly waited: string[] = []
  async wait(id: string): Promise<Record<string, unknown>> {
    this.waited.push(id)
    return this.get(id)
  }

  kill(id: string, _caller?: unknown, reason?: string): string {
    const entry = this.store.get(id)
    if (entry === undefined) throw new Error(`unknown job: ${id}`)
    if (entry.status !== 'running') return 'already-finished'
    entry.status = 'stopping'
    entry.hooks.cancel(reason)
    return 'requested'
  }

  private snapshot(entry: JobEntry): Record<string, unknown> {
    return {
      id: entry.id,
      kind: entry.spec.kind,
      label: entry.spec.label,
      status: entry.status,
      ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
      startedAt: Date.now(),
    }
  }
}

/** 真的起进程，只是把它包成 seam 的形状——假进程测不出「命令写错会怎样」。 */
class FakeSubprocess {
  spawn(spec: Record<string, unknown>): Record<string, unknown> {
    const argv = spec.argv as string[]
    const child = spawn(argv[0] as string, argv.slice(1), {
      cwd: spec.cwd as string,
      env: spec.env as Record<string, string>,
      stdio: ['pipe', 'pipe', 'pipe'],
      // 真 provider 终止的是**整个进程组**（`bash -c 'sleep 30'` 收到 SIGTERM 后
      // 会等前台子进程，只杀 bash 杀不干净），桩必须照做，否则测出来的是假的。
      detached: true,
    })
    let settle: (outcome: { exitCode: number | null; signal: string | null }) => void = () => {}
    const done = new Promise<{ exitCode: number | null; signal: string | null }>(resolve => {
      settle = resolve
    })
    child.on('close', (exitCode, signal) => {
      settle({ exitCode, signal })
    })
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      collected: {},
      done,
      // 也照 provider 的做法：先 SIGTERM，宽限期后还没退就 SIGKILL。bash 刚打印完第一行、
      // 还没来得及起 sleep 时收到 SIGTERM，sleep 会活下来；少了这一步，忙的机器上
      // kill 会一直停在 stopping。
      terminate: () => {
        signalGroup('SIGTERM')
        const escalate = setTimeout(() => signalGroup('SIGKILL'), (spec.graceMs as number | undefined) ?? 3000)
        escalate.unref()
        void done.then(() => clearTimeout(escalate))
      },
      waitForExit: async () => true,
    }

    function signalGroup(signal: NodeJS.Signals): void {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        child.kill(signal)
      }
    }
  }
}

/**
 * 不起真进程、由测试手动推进的子进程：要精确控制「行什么时候到、进程什么时候结束」
 * 的场景用它（真进程的时序测不稳）。
 */
class ScriptedChild {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  private settle: (outcome: { exitCode: number | null; signal: string | null }) => void = () => {}
  readonly done = new Promise<{ exitCode: number | null; signal: string | null }>(resolve => {
    this.settle = resolve
  })

  /** 关掉两条输出流、等读手把数据收完，再报进程结束——和真 provider 的顺序一致。 */
  async exit(exitCode: number | null, signal: string | null = null): Promise<void> {
    this.stdout.end()
    this.stderr.end()
    await new Promise(resolve => setTimeout(resolve, 20))
    this.settle({ exitCode, signal })
  }

  handle(): Record<string, unknown> {
    return {
      stdin: this.stdin,
      stdout: this.stdout,
      stderr: this.stderr,
      collected: {},
      done: this.done,
      terminate: () => {
        void this.exit(null, 'SIGTERM')
      },
      waitForExit: async () => true,
    }
  }
}

class ScriptedSubprocess {
  readonly children: ScriptedChild[] = []
  spawn(): Record<string, unknown> {
    const child = new ScriptedChild()
    this.children.push(child)
    return child.handle()
  }
}

interface Harness {
  readonly inbox: UserMessage[]
  /** 每条送进会话的消息走的是哪种投递（steer 会唤醒、inject 不唤醒）。 */
  readonly deliveries: Array<{ mode: 'steer' | 'inject' | 'followup'; text: string }>
  readonly warnings: string[]
  readonly tools: Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>
  run(name: string, args: unknown): Promise<unknown>
  status(id: string): string
  /** 触发 apply 里用 ctx.on 注册的事件监听。 */
  emit(event: string, payload: unknown): void
  parallel(event: string, payload: unknown): Promise<void>
  readonly agent: unknown
  readonly jobs: FakeJobs
}

// overrides 给的是解开 volatile ref 的裸值（0.1.7 起 Config 的输出里那些字段是
// 活 ref）；unwrap 那一侧对裸值和 ref 都兼容，所以测试照常传数字。
function harness(
  overrides: Partial<MonitorSnapshot> = {},
  subprocess: unknown = new FakeSubprocess(),
  services: Record<string, unknown> = {},
): Harness {
  const inbox: UserMessage[] = []
  const deliveries: Harness['deliveries'] = []
  const record = (mode: 'steer' | 'inject' | 'followup') => (message: UserMessage) => {
    inbox.push(message)
    const part = message.content[0]
    deliveries.push({ mode, text: part?.type === 'text' ? part.text : '' })
  }
  const warnings: string[] = []
  const handlers = new Map<string, Array<(payload: unknown) => unknown>>()
  const tools = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
  const jobs = new FakeJobs()
  const agent = {
    id: 'session-test',
    session: { id: 'session-test', header: { cwd: process.cwd() } },
    steer: record('steer'),
    inject: record('inject'),
    followup: record('followup'),
  }
  const ctx = {
    logger: () => ({ info: () => {}, warn: (message: string) => warnings.push(message), debug: () => {}, error: () => {} }),
    effect: (fn: () => unknown) => {
      fn()
    },
    on: (event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, [...handlers.get(event) ?? [], handler])
    },
    get: (name: string) => services[name],
    inject: () => {},
    jobs,
    subprocess,
    tools: {
      register: (definition: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }) => {
        tools.set(definition.name, definition)
      },
    },
    systemPrompt: { section: () => {}, getSectionOrder: () => 1600 },
  } as unknown as Context

  apply(ctx, { ...Config({}), ...overrides } as MonitorConfig)

  const exec = { agent }
  return {
    inbox,
    deliveries,
    warnings,
    tools,
    agent,
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload)
    },
    async parallel(event, payload) {
      await Promise.all((handlers.get(event) ?? []).map(handler => handler(payload)))
    },
    async run(name, args) {
      const tool = tools.get(name)
      assert.ok(tool !== undefined, `tool ${name} not registered`)
      return tool.execute(args, exec)
    },
    status(id) {
      return jobs.get(id).status as string
    },
    jobs,
  }
}

const settle = (ms = 400): Promise<void> => new Promise(resolve => {
  setTimeout(resolve, ms)
})

/**
 * 反复跑一组断言直到通过。真子进程在忙碌的机器上起得慢（并行跑检查时一次 bash
 * 启动就超过 400ms），固定睡一段再断言会把「还没跑完」误报成失败。
 */
async function eventually(check: () => void | Promise<void>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await check()
      return
    } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
}

test('stdout 的每一行都送进会话，且合成一条通知', async () => {
  const h = harness({ coalesceMs: 30 })
  const started = await h.run('monitor', { command: 'printf "a\\nb\\nc\\n"', description: '三行' }) as { id: string }
  await eventually(() => assert.equal(h.status(started.id), 'completed'))
  await settle()

  assert.equal(h.inbox.length, 1, '三行应该合并成一条通知')
  const text = h.inbox[0]?.content[0]
  assert.equal(text?.type, 'text')
  assert.match(text.type === 'text' ? text.text : '', /monitor-1 · 三行/)
  assert.match(text.type === 'text' ? text.text : '', /a\nb\nc/)
  assert.equal(started.id, 'monitor-1')
})

test('最后一行没有换行也要交出来', async () => {
  const h = harness({ coalesceMs: 30 })
  await h.run('monitor', { command: 'printf "no-newline-at-end"' })
  await eventually(() => {
    const text = h.inbox[0]?.content[0]
    assert.match(text?.type === 'text' ? text.text : '', /no-newline-at-end/)
  })
})

test('stderr 不当事件送，但会落日志并在结束通知里带上', async () => {
  const h = harness({ coalesceMs: 30 })
  const started = await h.run('monitor', {
    command: 'echo event-line; echo "boom: unknown flag" >&2; exit 3',
  }) as { id: string; log_path: string }
  await eventually(() => assert.equal(h.status('monitor-1'), 'failed'))
  await eventually(() => assert.ok(h.inbox.some(message => message.content[0]?.type === 'text' && message.content[0].text.includes('Monitor ended'))))

  const bodies = h.inbox.map(message => (message.content[0]?.type === 'text' ? message.content[0].text : ''))
  // 事件那条不能混进 stderr —— stdout 是事件流，stderr 是诊断，两者必须分开。
  // 只看正文：抬头那行是标签，没给 description 时标签就是命令本身。
  const event = bodies.find(body => body.includes('event-line'))
  assert.ok(event !== undefined, `缺少事件通知：${JSON.stringify(bodies)}`)
  const eventBody = event.split('\n\n').slice(1).join('\n\n')
  assert.equal(eventBody.includes('boom'), false, 'stderr 漏进了事件流')
  // 结束通知必须带 stderr 原文与日志路径
  const end = bodies.find(body => body.includes('Monitor ended'))
  assert.ok(end !== undefined, `缺少结束通知：${JSON.stringify(bodies)}`)
  assert.match(end, /boom: unknown flag/)
  assert.match(end, /exit code: 3/)
  assert.ok(end.includes(`Full stderr log: ${started.log_path}`), '结束通知必须指向本次监听的日志')
  assert.match(started.log_path, /monitor-1-[0-9a-f-]{36}\.log$/, '启动时就该给出独立、确定的日志路径')
  assert.equal(h.status('monitor-1'), 'failed')
})

test('独立 registry 的同号监听不会覆盖哨兵或上次运行的 stderr 日志', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'monitor-log-runs-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const sentinelPath = join(dir, 'monitor-1.log')
  const sentinel = Buffer.from('旧诊断\n\0sentinel\n')
  writeFileSync(sentinelPath, sentinel)

  const paths: string[] = []
  for (const diagnostic of ['first-run', 'second-run']) {
    const sub = new ScriptedSubprocess()
    // 每个 harness 都建立独立 FakeJobs，模拟宿主重建 registry 后计数重置。
    const h = harness({ logDir: dir }, sub)
    const started = await h.run('monitor', { command: 'fixture', description: diagnostic }) as { id: string; log_path: string }
    const child = sub.children[0]
    assert.ok(child !== undefined)
    child.stderr.write(`${diagnostic}\n`)
    await child.exit(1)
    await eventually(() => assert.equal(h.status(started.id), 'failed'))
    await eventually(() => assert.equal(readFileSync(started.log_path, 'utf8'), `${diagnostic}\n`))
    assert.equal(started.id, 'monitor-1')
    assert.deepEqual(readFileSync(sentinelPath), sentinel, '原有同名文件的字节必须保留')
    paths.push(started.log_path)
  }

  assert.notEqual(paths[0], paths[1], '同号任务的两次独立运行必须使用不同日志')
  assert.equal(readFileSync(paths[0] as string, 'utf8'), 'first-run\n', '第二次运行不能改写第一次的日志')
  assert.equal(readFileSync(paths[1] as string, 'utf8'), 'second-run\n')
})

test('首次日志路径被抢先占用时 wx 拒绝覆盖已有字节', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'monitor-log-collision-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const sub = new ScriptedSubprocess()
  const h = harness({ logDir: dir }, sub)
  const started = await h.run('monitor', { command: 'fixture' }) as { id: string; log_path: string }
  const sentinel = Buffer.from('抢先创建的文件\n')
  writeFileSync(started.log_path, sentinel, { flag: 'wx' })
  const child = sub.children[0]
  assert.ok(child !== undefined)
  child.stderr.write('new-error\n')
  await eventually(() => assert.equal(h.warnings.filter(message => message.includes('stderr 日志')).length, 1))
  child.stderr.write('another-error\n')
  await child.exit(1)
  await eventually(() => assert.equal(h.status(started.id), 'failed'))
  assert.deepEqual(readFileSync(started.log_path), sentinel)
  assert.equal(h.warnings.filter(message => message.includes('stderr 日志')).length, 1)
})

test('同一记录重拉后沿用日志路径并追加两轮 stderr', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'monitor-log-restart-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const sub = new ScriptedSubprocess()
  const h = harness({ logDir: dir, restartDelayMs: 10, restartLimit: 1, restartResetMs: 0 }, sub)
  const started = await h.run('monitor', { command: 'fixture', restart: 'on-failure' }) as { id: string; log_path: string }
  const first = sub.children[0]
  assert.ok(first !== undefined)
  first.stderr.write('before-restart\n')
  await first.exit(1)
  await eventually(() => assert.equal(sub.children.length, 2))
  const second = sub.children[1]
  assert.ok(second !== undefined)
  const peek = await h.run('monitor_output', { monitor_id: started.id }) as { log_path: string; restarts: number }
  assert.equal(peek.log_path, started.log_path)
  assert.equal(peek.restarts, 1)
  second.stderr.write('after-restart\n')
  await second.exit(1)
  await eventually(() => assert.equal(h.status(started.id), 'failed'))
  await eventually(() => assert.equal(readFileSync(started.log_path, 'utf8'), 'before-restart\nafter-restart\n'))
  assert.deepEqual(h.warnings.filter(message => message.includes('stderr 日志')), [])
})

test('正常退出不补结束通知 —— 通用任务通知已经说过一次了', async () => {
  const h = harness({ coalesceMs: 30 })
  const started = await h.run('monitor', { command: 'echo line; echo noise >&2' }) as { id: string }
  await eventually(() => assert.equal(h.status(started.id), 'completed'))
  await settle()
  assert.equal(h.inbox.length, 1, `只该有一条事件通知：${JSON.stringify(h.inbox.map(m => m.content))}`)
})

test('一行没产出就退出 —— 结束通知要指出命令很可能起错了', async () => {
  const h = harness({ coalesceMs: 30 })
  await h.run('monitor', { command: 'exit 7' })
  await eventually(() => {
    const end = h.inbox
      .map(message => (message.content[0]?.type === 'text' ? message.content[0].text : ''))
      .find(body => body.includes('Monitor ended'))
    assert.ok(end !== undefined)
    assert.match(end, /produced no stdout/)
  })
})

test('monitor_output 看尾巴不回退游标，monitor_kill 能停掉长驻进程', async () => {
  const h = harness({ coalesceMs: 30 })
  const started = await h.run('monitor', { command: 'echo one; sleep 30', description: '长驻' }) as { id: string }
  await eventually(async () => {
    const peek = await h.run('monitor_output', { monitor_id: started.id }) as { text: string }
    assert.equal(peek.text, 'one')
  })

  const first = await h.run('monitor_output', { monitor_id: started.id }) as { text: string; status: string }
  const second = await h.run('monitor_output', { monitor_id: started.id }) as { text: string }
  assert.equal(first.text, 'one')
  assert.equal(second.text, 'one', '非消费式读取不能被第一次读空')
  assert.equal(first.status, 'running')

  const killed = await h.run('monitor_kill', { monitor_id: started.id, reason: '测试' }) as { outcome: string }
  assert.equal(killed.outcome, 'requested')
  await eventually(() => assert.equal(h.status(started.id), 'killed'))
})

test('默认不重拉：进程退出即结束（一次性命令要的就是这个）', async () => {
  const h = harness({ coalesceMs: 10 })
  const started = await h.run('monitor', { command: 'exit 1' }) as { id: string; restart: string }
  assert.equal(started.restart, 'never')
  await eventually(() => assert.equal(h.status(started.id), 'failed'))
  const out = await h.run('monitor_output', { monitor_id: started.id }) as { restarts: number }
  assert.equal(out.restarts, 0)
})

test('崩溃自动重拉：按次数上限停下来，次数写进结束通知', async () => {
  const h = harness({
    coalesceMs: 10,
    restartDelayMs: 20,
    restartMaxDelayMs: 50,
    restartLimit: 3,
    restartResetMs: 60_000,
  })
  const started = await h.run('monitor', {
    command: 'echo boom; exit 1',
    description: '崩溃循环',
    restart: 'on-failure',
  }) as { id: string; restart: string }
  assert.equal(started.restart, 'on-failure')
  await eventually(() => assert.equal(h.status(started.id), 'failed', '到上限后必须结算，不能一直挂着'))
  await settle(100)
  const out = await h.run('monitor_output', { monitor_id: started.id }) as { restarts: number }
  assert.equal(out.restarts, 3)

  const bodies = h.inbox.map(message => (message.content[0]?.type === 'text' ? message.content[0].text : ''))
  const end = bodies.find(body => body.includes('Monitor ended'))
  assert.ok(end !== undefined, `缺少结束通知：${JSON.stringify(bodies)}`)
  assert.match(end, /Restarted 3 time\(s\) in total \(limit reached\)/)
  // 崩溃循环不能刷屏：前 3 次各报一条，第 4 次（到上限）报的是结束通知
  const restartNotices = bodies.filter(body => body.includes('process exited, restarting'))
  assert.equal(restartNotices.length, 3, `重拉通知条数不对：${JSON.stringify(restartNotices)}`)
})

test('正常退出不重拉（on-failure 只管失败）', async () => {
  const h = harness({ coalesceMs: 10, restartDelayMs: 20, restartLimit: 0 })
  const started = await h.run('monitor', { command: 'echo done; exit 0', restart: 'on-failure' }) as { id: string }
  await eventually(() => assert.equal(h.status(started.id), 'completed'))
  const out = await h.run('monitor_output', { monitor_id: started.id }) as { restarts: number }
  assert.equal(out.restarts, 0)
})

test('重拉等待窗口里 kill：job 必须结算，不能永远挂在 running', async () => {
  const h = harness({ coalesceMs: 10, restartDelayMs: 400, restartLimit: 0 })
  const started = await h.run('monitor', { command: 'exit 1', restart: 'on-failure' }) as { id: string }
  await settle(150) // 进程已经退出，正处在退避等待里（这一刻没有活着的进程）
  assert.equal(h.status(started.id), 'running', '等待窗口里 job 仍是 running')

  const killed = await h.run('monitor_kill', { monitor_id: started.id, reason: '测试' }) as { outcome: string }
  assert.equal(killed.outcome, 'requested')
  await eventually(() => assert.equal(h.status(started.id), 'killed', '窗口里被 kill 也要有终态'))
})

test('重拉会重建两条流：上一轮的半行不会粘到新进程前面', async () => {
  const h = harness({ coalesceMs: 10, restartDelayMs: 20, restartLimit: 1, restartResetMs: 60_000 })
  // 两轮都是「吐出没有换行的半行然后退出」。若 reader 被复用，第二轮的
  // 半行会跟上一轮的残留拼成一行，看起来像一条根本不存在的消息。
  await h.run('monitor', {
    command: 'printf "half-line"; exit 1',
    description: '半行',
    restart: 'on-failure',
  })
  await eventually(() => assert.equal(bodiesOf(h).filter(body => body.includes('half-line')).length, 2, '两轮各自都要交出自己的半行'))
  await settle(100)
  const bodies = bodiesOf(h)
  assert.equal(bodies.some(body => body.includes('half-linehalf-line')), false, '两轮的半行粘在了一起')
  assert.equal(bodies.filter(body => body.includes('half-line')).length, 2, '两轮各自都要交出自己的半行')
})

test('monitor_list 只列 monitor，运行中的排前面', async () => {
  const h = harness({ coalesceMs: 30 })
  const short = await h.run('monitor', { command: 'echo done', description: '短命' }) as { id: string }
  await eventually(() => assert.equal(h.status(short.id), 'completed'))
  await h.run('monitor', { command: 'sleep 30', description: '长命' })

  const listed = await h.run('monitor_list', {}) as { monitors: Array<{ status: string; label: string; last_line_at?: number }> }
  assert.deepEqual(listed.monitors.map(row => row.label), ['长命', '短命'])
  // 「还在不在干活」的判据：出过输出的带最后输出时间，没出过的没有。
  assert.equal(listed.monitors[0]!.last_line_at, undefined)
  assert.ok(typeof listed.monitors[1]!.last_line_at === 'number' && listed.monitors[1]!.last_line_at! <= Date.now())
})

test('非持久监听在 agent 转 idle 时被停掉', async () => {
  // 直接驱动 apply 注册的那个 agent/status 监听。
  const handlers: Array<(payload: { agent: unknown; status: string }) => void> = []
  const inbox: UserMessage[] = []
  const jobs = new FakeJobs()
  const agent = {
    id: 'session-x',
    session: { header: { cwd: process.cwd() } },
    steer: (message: UserMessage) => inbox.push(message),
  }
  const tools = new Map<string, { execute: (args: unknown, exec: unknown) => Promise<unknown> }>()
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }),
    effect: (fn: () => unknown) => {
      fn()
    },
    on: (event: string, handler: (payload: { agent: unknown; status: string }) => void) => {
      if (event === 'agent/status') handlers.push(handler)
    },
    get: () => undefined,
    inject: () => {},
    jobs,
    subprocess: new FakeSubprocess(),
    tools: {
      register: (definition: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }) => {
        tools.set(definition.name, definition)
      },
    },
    systemPrompt: { section: () => {}, getSectionOrder: () => 1600 },
  } as unknown as Context
  apply(ctx, Config({}) as MonitorConfig)

  const monitor = tools.get('monitor')
  assert.ok(monitor !== undefined)
  const started = await monitor.execute(
    { command: 'sleep 30', persistent: false },
    { agent },
  ) as { id: string }
  assert.equal(jobs.get(started.id).status, 'running')

  for (const handler of handlers) handler({ agent, status: 'idle' })
  await eventually(() => assert.equal(jobs.get(started.id).status, 'killed'))
})

test('LineReader：多字节字符跨 chunk 不裂，半行留到下一批', async () => {
  const lines: string[] = []
  const reader = new LineReader(line => lines.push(line), () => {})
  const stream = new PassThrough()
  reader.attach(stream)

  const payload = Buffer.from('测试员：示例事件\n第二行', 'utf8')
  // 从汉字中间切开，验证包含多字节字符的事件流。
  stream.write(payload.subarray(0, 5))
  stream.write(payload.subarray(5, 11))
  stream.write(payload.subarray(11))
  stream.end()
  await once(stream, 'end')

  assert.deepEqual(lines, ['测试员：示例事件', '第二行'])
})

test('超长单行截断时显式标注，不静默砍', () => {
  const line = 'x'.repeat(100)
  const cut = truncateLine(line, 10)
  assert.match(cut, /^x{10}…\[\+90 bytes truncated\]$/)
  assert.equal(truncateLine('短', 10), '短')
})

/** 所有送进会话的正文。 */
function bodiesOf(h: Harness): string[] {
  return h.inbox.map(message => (message.content[0]?.type === 'text' ? message.content[0].text : ''))
}

test('进程结束时队列里剩下的行全部送完，不停在「还在排队」', async () => {
  const sub = new ScriptedSubprocess()
  const h = harness({}, sub)
  await h.run('monitor', { command: 'cat big.log', description: '一次性吐完' })
  const child = sub.children[0]
  assert.ok(child !== undefined)
  // 默认 coalesceMs=200、maxLinesPerNotice=50：150 行一次性进队，进程随即退出。
  child.stdout.write(Array.from({ length: 150 }, (_, i) => `line-${i}`).join('\n') + '\n')
  await child.exit(0)
  const deliveredLines = () => bodiesOf(h).flatMap(body => body.split('\n')).filter(line => /^line-\d+$/.test(line))
  await eventually(() => assert.equal(deliveredLines().length, 150))

  const bodies = bodiesOf(h)
  const delivered = deliveredLines()
  assert.equal(delivered.length, 150, `应送出 150 行，实际 ${delivered.length} 行：${JSON.stringify(bodies.map(b => b.slice(-40)))}`)
  assert.equal(bodies.at(-1)?.includes('more lines queued'), false, '最后一条消息不能再说还有行在排队')
})

test('stderr 日志写不进去只记一条 warn，不抛成未捕获异常', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'monitor-ro-'))
  chmodSync(dir, 0o555)
  try {
    const h = harness({ coalesceMs: 30, logDir: dir })
    const started = await h.run('monitor', { command: 'echo oops >&2; echo oops2 >&2; echo ok' }) as { id: string }
    await eventually(() => {
      assert.equal(h.status(started.id), 'completed')
      assert.ok(bodiesOf(h).some(body => body.split('\n').slice(1).includes('ok')), 'stdout 照常送达')
    })
    const logWarnings = h.warnings.filter(message => message.includes('stderr 日志'))
    assert.equal(logWarnings.length, 1, `应只有一条日志失败的 warn：${JSON.stringify(h.warnings)}`)
  } finally {
    chmodSync(dir, 0o755)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('被叫停且没出过行：不补「命令很可能起错了」的结束通知，也不唤醒会话', async () => {
  const sub = new ScriptedSubprocess()
  const h = harness({ coalesceMs: 30 }, sub)
  // 非持久监听随回合结束被停
  const idle = await h.run('monitor', { command: 'wait-for-event', persistent: false }) as { id: string }
  h.emit('agent/status', { agent: h.agent, status: 'idle' })
  // 模型主动 monitor_kill
  const killed = await h.run('monitor', { command: 'wait-for-event-2' }) as { id: string }
  await h.run('monitor_kill', { monitor_id: killed.id, reason: '不需要了' })
  await eventually(() => {
    assert.equal(h.status(idle.id), 'killed')
    assert.equal(h.status(killed.id), 'killed')
  })
  await settle(300)
  assert.equal(bodiesOf(h).some(body => body.includes('command is likely wrong') || body.includes('Monitor ended')), false)
  assert.deepEqual(h.deliveries.filter(d => d.mode !== 'inject'), [], '有人叫停的监听不能唤醒会话')
  assert.equal(bodiesOf(h).some(body => body.includes(killed.id)), false, 'monitor_kill 停掉的不补任何通知')
})

test('非持久监听因回合结束被停、命令还没跑完：补一条不唤醒的通知，下一轮模型能看到', async () => {
  const sub = new ScriptedSubprocess()
  // 插件默认投递是会唤醒的 steer：这条通知也必须走不唤醒的那条路。
  const h = harness({ coalesceMs: 30, delivery: 'steer' }, sub)
  const started = await h.run('monitor', { command: 'pnpm install', description: '装依赖', persistent: false }) as { id: string }
  h.emit('agent/status', { agent: h.agent, status: 'idle' })
  await eventually(() => assert.equal(h.status(started.id), 'killed'))
  await eventually(() => assert.equal(h.deliveries.length, 1))
  await settle(100)

  assert.equal(h.deliveries.length, 1, `只该有一条通知：${JSON.stringify(h.deliveries)}`)
  const notice = h.deliveries[0]
  assert.ok(notice !== undefined)
  assert.equal(notice.mode, 'inject', '回合结束后会话已空闲，这条通知不能把它叫醒')
  assert.ok(notice.text.includes(`${started.id} · 装依赖 · stopped at turn end`) && notice.text.includes('did not finish'), notice.text)
  assert.match(notice.text, /persistent:false/)
  assert.match(notice.text, /monitor_output/)
  const message = h.inbox[0]
  assert.equal(message?.source?.kind, 'dsh-monitor')
  assert.equal((message?.source as { form?: string } | undefined)?.form, 'notice')
})

test('非持久监听的命令已经自己跑完，回合结束时不补「被停止」通知', async () => {
  const sub = new ScriptedSubprocess()
  const h = harness({ coalesceMs: 30 }, sub)
  const started = await h.run('monitor', { command: 'echo done', persistent: false }) as { id: string }
  const child = sub.children[0]
  assert.ok(child !== undefined)
  child.stdout.write('done\n')
  await child.exit(0)
  await eventually(() => assert.equal(h.status(started.id), 'completed'))
  const before = h.deliveries.length
  h.emit('agent/status', { agent: h.agent, status: 'idle' })
  await settle(200)
  assert.equal(h.status(started.id), 'completed')
  assert.equal(h.deliveries.slice(before).length, 0, '已经自然退出的命令不该再收到「被停止」通知')
  assert.equal(bodiesOf(h).some(body => body.includes('stopped at turn end')), false)
})

test('持久监听不受回合结束影响：照常运行、不补通知', async () => {
  const sub = new ScriptedSubprocess()
  const h = harness({ coalesceMs: 30 }, sub)
  const started = await h.run('monitor', { command: 'tail -f log' }) as { id: string }
  h.emit('agent/status', { agent: h.agent, status: 'idle' })
  await settle(200)
  assert.equal(h.status(started.id), 'running')
  assert.deepEqual(h.deliveries, [])
  await h.run('monitor_kill', { monitor_id: started.id })
  await eventually(() => assert.equal(h.status(started.id), 'killed'))
})

test('超时被停照样补结束通知，但不说「命令很可能起错了」', async () => {
  const sub = new ScriptedSubprocess()
  const h = harness({ coalesceMs: 30 }, sub)
  await h.run('monitor', { command: 'wait-for-event', timeout_ms: 50 })
  await eventually(() => assert.ok(bodiesOf(h).some(body => body.includes('Monitor ended'))))
  const bodies = bodiesOf(h)
  const end = bodies.find(body => body.includes('Monitor ended'))
  assert.ok(end !== undefined, `超时要补结束通知：${JSON.stringify(bodies)}`)
  assert.match(end, /timeout/)
  assert.equal(end.includes('命令很可能起错了'), false, '超时停掉不等于命令起错了')
})


test('跨插件启动先等目标解析，环境来自真实目标；错误不会伪报成功', async () => {
  const sub = new ScriptedSubprocess()
  let release: () => void = () => {}
  const ready = new Promise<void>(resolve => { release = resolve })
  const target = { session: { id: 'target-real-id' }, inject: () => {}, steer: () => assert.fail('不能唤醒模型') }
  const resolved: string[] = []
  const environments: unknown[] = []
  const h = harness({}, sub, {
    sessionController: { resolveAgent: async (owner: string) => { resolved.push(owner); await ready; return { agent: target } } },
    shellEnv: { collect: (exec: { agent: unknown }) => { environments.push(exec.agent); return {} } },
  })
  const request: MonitorStartRequest = { owner: 'target-alias', command: 'listen', cwd: process.cwd(), label: '后台服务' }
  const pending = h.parallel(MONITOR_START_EVENT, request)
  assert.deepEqual(resolved, ['target-alias'])
  assert.equal(request.result, undefined)
  assert.equal(sub.children.length, 0)
  assert.deepEqual(h.jobs.list(), [])
  release()
  await pending
  assert.equal(request.result!.owner, target.session.id)
  assert.deepEqual(environments, [target])
  assert.equal(sub.children.length, 1)
  await h.run('monitor_kill', { monitor_id: request.result!.id })
})

test('跨插件启动拒绝空命令、空 owner、无效目录或不可用会话，不启动进程或登记任务', async () => {
  const sub = new ScriptedSubprocess()
  const h = harness({}, sub, { sessionController: { resolveAgent: async () => ({ error: new Error('owner unavailable') }) } })
  const base: MonitorStartRequest = { owner: 'target', command: 'listen', cwd: process.cwd(), label: '后台服务' }
  const cases: Array<[Partial<MonitorStartRequest>, RegExp]> = [
    [{ command: '  ' }, /command/],
    [{ owner: '  ' }, /owner/],
    [{ cwd: '' }, /绝对目录/],
    [{ cwd: '.' }, /绝对目录/],
    [{ cwd: join(process.env.DSH_HOME!, 'missing-directory') }, /ENOENT/],
    [{ cwd: new URL(import.meta.url).pathname }, /已存在的目录/],
    [{}, /owner unavailable/],
  ]
  for (const [overrides, expected] of cases) {
    const request = { ...base, ...overrides }
    await assert.rejects(h.parallel(MONITOR_START_EVENT, request), expected)
    assert.equal(request.result, undefined)
    assert.equal(sub.children.length, 0)
    assert.deepEqual(h.jobs.list(), [])
  }
})

test('跨插件启动把启动异常原样交给调用者，不留下任务或成功回执', async () => {
  const failure = new Error('spawn refused')
  const h = harness({}, { spawn: () => { throw failure } }, {
    sessionController: { resolveAgent: async () => ({ agent: h.agent }) },
  })
  const request: MonitorStartRequest = { owner: 'session-test', command: 'listen', cwd: process.cwd(), label: '后台服务' }
  await assert.rejects(h.parallel(MONITOR_START_EVENT, request), error => error === failure)
  assert.equal(request.result, undefined)
  assert.deepEqual(h.jobs.list(), [])
  assert.deepEqual(h.deliveries, [])
})

// ── 跟着 DSH 重启续上 ─────────────────────────────────────────────────

const suspendedFile = (): string => join(process.env.DSH_HOME as string, 'monitor', 'suspended.json')

test('重启前：持久监听报为可续，暂停时落盘再停，宿主不会因此发结束通知', async () => {
  rmSync(suspendedFile(), { force: true })
  const sub = new ScriptedSubprocess()
  const h = harness({ coalesceMs: 0 }, sub)
  const kept = await h.run('monitor', { command: 'example-listen', description: '示例监听', restart: 'on-failure', delivery: 'steer', ignore_stdout_lines: ['hb'], timeout_ms: 600_000 }) as { id: string }
  const temp = await h.run('monitor', { command: 'pnpm install', persistent: false }) as { id: string }

  const ids = new Set<string>()
  h.emit(RESTART_SURVIVORS_EVENT, ids)
  assert.deepEqual([...ids], [kept.id], '只有持久监听算可续；非持久的本来就随回合结束')

  const out: SuspendedMonitor[] = []
  h.emit(RESTART_PREPARE_EVENT, out)
  assert.deepEqual(out.map(item => item.id), [kept.id])
  await eventually(() => assert.equal(h.status(kept.id), 'killed'))
  assert.equal(h.status(temp.id), 'running', '暂停只碰可续的监听')
  assert.deepEqual(h.jobs.waited, [kept.id], '挂上等待，宿主就不会把暂停当成结束去叫醒主人')
  assert.deepEqual(h.deliveries, [], '暂停不给主人发任何通知')

  const saved = JSON.parse(readFileSync(suspendedFile(), 'utf8')) as SuspendedMonitor[]
  assert.equal(saved.length, 1)
  const item = saved[0]!
  assert.equal(item.command, 'example-listen')
  assert.equal(item.owner, 'session-test')
  assert.equal(item.restartPolicy, 'on-failure')
  assert.equal(item.delivery, 'steer')
  assert.deepEqual(item.ignoreStdoutLines, ['hb'])
  assert.ok(item.timeoutMs > 0 && item.timeoutMs <= 600_000, '剩余寿命照算，不重新给满')
  assert.equal(JSON.stringify(item).includes('PATH'), false, '环境变量不落盘')
  await h.run('monitor_kill', { monitor_id: temp.id })
  rmSync(suspendedFile(), { force: true })
})

test('新进程起来：按暂停记录接回监听，用主人会话现算环境，并给主人一条不唤醒的说明', async () => {
  rmSync(suspendedFile(), { force: true })
  // 上一个进程暂停的监听
  const before = harness({ coalesceMs: 0 }, new ScriptedSubprocess())
  await before.run('monitor', { command: 'example-listen', description: '示例监听', restart: 'on-failure' })
  before.emit(RESTART_PREPARE_EVENT, [])
  assert.ok(existsSync(suspendedFile()))

  // 新进程：插件加载时就去接回
  const sub = new ScriptedSubprocess()
  const resolved: string[] = []
  const owner = {
    id: 'session-test',
    session: { id: 'session-test', header: { cwd: process.cwd(), id: 'session-test' } },
    steer: () => {}, inject: () => {}, followup: () => {},
  }
  const after = harness({ coalesceMs: 0 }, sub, {
    sessionController: { resolveAgent: async (id: string) => { resolved.push(id); return { agent: owner } } },
  })
  await eventually(() => assert.equal(sub.children.length, 1, '接回的监听要真的拉起'))
  // 2026-10-09 真实重启：新进程编号从头数，正好又是 monitor-1，原文案说「旧编号 monitor-1 已经不存在」自相矛盾
  assert.deepEqual(resolved, ['session-test'], '按记录里的会话找主人，没加载就先加载')
  assert.equal(existsSync(suspendedFile()), false, '确认接回成功后才删除记录')
  const list = await after.run('monitor_list', {}) as { monitors: { id: string; status: string; label: string }[] }
  assert.deepEqual(list.monitors.map(m => [m.label, m.status]), [['示例监听', 'running']])
})

test('接回时说明新编号和中间漏掉的时间段；找不到会话的跳过，不影响别的', async () => {
  rmSync(suspendedFile(), { force: true })
  const now = Date.now()
  const items: SuspendedMonitor[] = [
    { id: 'monitor-7', label: '示例监听', command: 'example-listen', cwd: process.cwd(), owner: 'session-gone', ignoreStdoutLines: [], restartPolicy: 'on-failure', timeoutMs: 0, suspendedAt: now - 5000 },
    { id: 'monitor-8', label: '日志跟随', command: 'tail -f x', cwd: process.cwd(), owner: 'session-test', ignoreStdoutLines: [], restartPolicy: 'never', timeoutMs: 0, suspendedAt: now - 5000 },
    { id: 'monitor-9', label: '很久以前', command: 'old', cwd: process.cwd(), owner: 'session-test', ignoreStdoutLines: [], restartPolicy: 'never', timeoutMs: 0, suspendedAt: now - 2 * 60 * 60_000 },
  ]
  mkdirSync(join(process.env.DSH_HOME as string, 'monitor'), { recursive: true })
  writeFileSync(suspendedFile(), JSON.stringify(items))
  const notices: { mode: string; text: string }[] = []
  const owner = {
    id: 'session-test',
    session: { id: 'session-test', header: { cwd: process.cwd(), id: 'session-test' } },
    steer: (m: UserMessage) => notices.push({ mode: 'steer', text: (m.content[0] as { text: string }).text }),
    inject: (m: UserMessage) => notices.push({ mode: 'inject', text: (m.content[0] as { text: string }).text }),
    followup: (m: UserMessage) => notices.push({ mode: 'followup', text: (m.content[0] as { text: string }).text }),
  }
  const sub = new ScriptedSubprocess()
  const h = harness({ coalesceMs: 0 }, sub, {
    sessionController: {
      resolveAgent: async (id: string) => id === 'session-test' ? { agent: owner } : { error: new Error(`session "${id}" not found`) },
    },
  })
  await eventually(() => assert.equal(notices.length, 1))
  assert.equal(sub.children.length, 1, '找不到会话的、太旧的都不拉')
  assert.equal(notices[0]!.mode, 'inject', '说明不唤醒主人，下一轮顺带看到')
  assert.match(notices[0]!.text, /DSH just restarted\. The monitor monitor-8 \(日志跟随\) you had running was relaunched automatically, the new id is monitor-1; the old id monitor-8 no longer exists/)
  assert.match(notices[0]!.text, /output produced during that gap was not delivered/)
  assert.ok(h.warnings.some(w => w.includes('monitor-7') && w.includes('没能接回')), '找不到会话要留日志')
  assert.ok(h.warnings.some(w => w.includes('monitor-9') && w.includes('太旧')), '太旧的记录要留日志')
  await h.run('monitor_kill', { monitor_id: 'monitor-1' })
})

test('接回后编号正好和原来一样：说「编号还是」，不说旧编号不存在', async () => {
  rmSync(suspendedFile(), { force: true })
  mkdirSync(join(process.env.DSH_HOME as string, 'monitor'), { recursive: true })
  writeFileSync(suspendedFile(), JSON.stringify([{ id: 'monitor-1', label: '测试', command: 'x', cwd: process.cwd(), owner: 'session-test', ignoreStdoutLines: [], restartPolicy: 'never', timeoutMs: 0, suspendedAt: Date.now() - 6000 }]))
  const notices: string[] = []
  const owner = {
    id: 'session-test',
    session: { id: 'session-test', header: { cwd: process.cwd(), id: 'session-test' } },
    steer: () => {}, followup: () => {},
    inject: (m: UserMessage) => notices.push((m.content[0] as { text: string }).text),
  }
  const h = harness({ coalesceMs: 0 }, new ScriptedSubprocess(), { sessionController: { resolveAgent: async () => ({ agent: owner }) } })
  await eventually(() => assert.equal(notices.length, 1))
  assert.match(notices[0]!, /was relaunched automatically, the id is still monitor-1, with the same command/)
  assert.doesNotMatch(notices[0]!, /已经不存在/)
  await h.run('monitor_kill', { monitor_id: 'monitor-1' })
})

test('重启没成：按记录马上接回，并告诉主人', async () => {
  rmSync(suspendedFile(), { force: true })
  const sub = new ScriptedSubprocess()
  const h = harness({ coalesceMs: 0 }, sub, {
    sessionController: { resolveAgent: async () => ({ agent: h.agent }) },
  })
  const started = await h.run('monitor', { command: 'example-listen', description: '示例监听' }) as { id: string }
  h.emit(RESTART_PREPARE_EVENT, [])
  await eventually(() => assert.equal(h.status(started.id), 'killed'))
  const result: RestartRecoveryResult = { revived: [], failed: [] }
  await h.parallel(RESTART_ABORT_EVENT, result)
  assert.deepEqual(result, { revived: [started.id], failed: [] })
  await eventually(() => assert.equal(sub.children.length, 2))
  await eventually(() => assert.ok(h.deliveries.some(d => d.mode === 'inject' && /The DSH restart did not succeed/.test(d.text))))
  assert.equal(existsSync(suspendedFile()), false)
})


function suspendedItem(id: string, command = 'listen'): SuspendedMonitor {
  return { id, label: id, command, cwd: process.cwd(), owner: 'session-test', ignoreStdoutLines: [], restartPolicy: 'never', timeoutMs: 0, suspendedAt: Date.now() }
}

function saveSuspended(items: SuspendedMonitor[]): void {
  mkdirSync(join(process.env.DSH_HOME as string, 'monitor'), { recursive: true })
  writeFileSync(suspendedFile(), JSON.stringify(items))
}

async function rollback(h: Harness): Promise<RestartRecoveryResult> {
  const result: RestartRecoveryResult = { revived: [], failed: [] }
  await h.parallel(RESTART_ABORT_EVENT, result)
  return result
}

test('rollback 等待主人解析完成，不预报成功；并发恢复只拉起一次', async () => {
  rmSync(suspendedFile(), { force: true })
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const sub = new ScriptedSubprocess()
  const h = harness({}, sub, { sessionController: { resolveAgent: async () => { await gate; return { agent: h.agent } } } })
  await Promise.resolve()
  const item = suspendedItem('monitor-10')
  saveSuspended([item])
  const out: RestartRecoveryResult = { revived: [], failed: [] }
  const first = h.parallel(RESTART_ABORT_EVENT, out)
  const second = rollback(h)
  await Promise.resolve()
  assert.deepEqual(out, { revived: [], failed: [] })
  assert.equal(existsSync(suspendedFile()), true)
  assert.equal(sub.children.length, 0)
  release()
  await first
  assert.deepEqual(out, { revived: [item.id], failed: [] })
  assert.deepEqual(await second, { revived: [], failed: [] })
  assert.equal(sub.children.length, 1)
  await h.run('monitor_kill', { monitor_id: 'monitor-1' })
})

test('rollback 部分启动失败：只删除成功项、失败通知主人、第二次只重试失败项', async () => {
  rmSync(suspendedFile(), { force: true })
  const sub = new ScriptedSubprocess()
  let fail = true
  const h = harness({}, { spawn: (spec: Record<string, unknown>) => {
    if (fail && (spec.argv as string[]).includes('bad-listen')) throw new Error('spawn refused')
    return sub.spawn()
  } }, { sessionController: { resolveAgent: async () => ({ agent: h.agent }) } })
  await Promise.resolve()
  const good = suspendedItem('monitor-10')
  const bad = suspendedItem('monitor-11', 'bad-listen')
  saveSuspended([good, bad])
  assert.deepEqual(await rollback(h), { revived: [good.id], failed: [{ id: bad.id, owner: bad.owner, error: 'spawn refused' }] })
  assert.deepEqual(JSON.parse(readFileSync(suspendedFile(), 'utf8')), [bad])
  assert.ok(h.deliveries.some(d => d.mode === 'steer' && /monitor-11[\s\S]*recovery failed[\s\S]*spawn refused/.test(d.text)), JSON.stringify(h.deliveries))
  fail = false
  assert.deepEqual(await rollback(h), { revived: [bad.id], failed: [] })
  assert.equal(sub.children.length, 2, '成功项不能重复拉起')
  assert.equal(existsSync(suspendedFile()), false)
  for (const item of h.jobs.list()) if (item.status === 'running') await h.run('monitor_kill', { monitor_id: item.id })
})

test('rollback 主人解析失败：返回失败并保留记录，主人恢复可再次尝试', async () => {
  rmSync(suspendedFile(), { force: true })
  let fail = true
  const sub = new ScriptedSubprocess()
  const h = harness({}, sub, { sessionController: { resolveAgent: async () => fail ? { error: new Error('owner unavailable') } : { agent: h.agent } } })
  const started = await h.run('monitor', { command: 'listen' }) as { id: string }
  h.emit(RESTART_PREPARE_EVENT, [])
  await eventually(() => assert.equal(h.status(started.id), 'killed'))
  const original = readFileSync(suspendedFile(), 'utf8')
  const result = await rollback(h)
  assert.deepEqual(result, { revived: [], failed: [{ id: started.id, owner: 'session-test', error: 'owner unavailable' }] })
  assert.equal(readFileSync(suspendedFile(), 'utf8'), original)
  assert.ok(h.deliveries.some(d => d.mode === 'steer' && /owner unavailable/.test(d.text)), JSON.stringify(h.deliveries))
  fail = false
  assert.deepEqual(await rollback(h), { revived: [started.id], failed: [] })
  assert.equal(sub.children.length, 2)
  await h.run('monitor_kill', { monitor_id: 'monitor-2' })
})

test('下一次 prepare 不覆盖以前恢复失败项，等待恢复时新暂停项也不能丢失', async () => {
  rmSync(suspendedFile(), { force: true })
  let release: () => void = () => {}
  const gate = new Promise<void>(resolve => { release = resolve })
  const sub = new ScriptedSubprocess()
  const h = harness({}, sub, { sessionController: { resolveAgent: async () => { await gate; return { agent: h.agent } } } })
  const started = await h.run('monitor', { command: 'new-listen' }) as { id: string }
  const previous = suspendedItem('monitor-10')
  saveSuspended([previous])
  const restoring = rollback(h)
  await Promise.resolve()
  const prepared: SuspendedMonitor[] = []
  h.emit(RESTART_PREPARE_EVENT, prepared)
  const saved = JSON.parse(readFileSync(suspendedFile(), 'utf8')) as SuspendedMonitor[]
  assert.deepEqual(saved.map(item => item.id), [previous.id, started.id])
  release()
  assert.deepEqual(await restoring, { revived: [previous.id], failed: [] })
  assert.deepEqual(JSON.parse(readFileSync(suspendedFile(), 'utf8')), prepared, '旧项恢复成功不能覆盖刚新增的暂停项')
  assert.deepEqual(await rollback(h), { revived: [started.id], failed: [] })
  assert.equal(existsSync(suspendedFile()), false)
  for (const item of h.jobs.list()) if (item.status === 'running') await h.run('monitor_kill', { monitor_id: item.id })
})

test('暂停文件损坏时恢复报错，原始内容不会被删', async () => {
  rmSync(suspendedFile(), { force: true })
  const h = harness({}, new ScriptedSubprocess())
  await Promise.resolve()
  const raw = '{broken json'
  mkdirSync(join(process.env.DSH_HOME as string, 'monitor'), { recursive: true })
  writeFileSync(suspendedFile(), raw)
  await assert.rejects(rollback(h), SyntaxError)
  assert.equal(readFileSync(suspendedFile(), 'utf8'), raw)
  rmSync(suspendedFile(), { force: true })
})
