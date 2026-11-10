/**
 * 真 seam 的集成冒烟：不验插件逻辑（那是 monitor.test.ts 的事），只验
 * 「插件对 ctx.jobs / ctx.subprocess 的用法和真实现一致」——桩再像也不是真的。
 *
 * 起一个裸 cordis Context，挂上真的 LocalJobRegistry 与 LocalSubprocessRuntime，
 * 再用两个最小的假服务补上 tools / systemPrompt，然后跑一条真命令。
 * 被替掉的只有「注册工具」和「系统提示」这两件与进程行为无关的事。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { LocalJobRegistry } from '@deepseek-ai/dsh-jobs-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import * as monitorPlugin from '../src/index.ts'
import { Config, type MonitorConfig } from '../src/index.ts'

interface ToolLike {
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

class FakeTools extends Service {
  readonly registered = new Map<string, ToolLike>()
  constructor(ctx: Context) {
    super(ctx, 'tools')
  }

  register(definition: ToolLike & { name: string }): void {
    this.registered.set(definition.name, definition)
  }
}

class FakePrompt extends Service {
  constructor(ctx: Context) {
    super(ctx, 'systemPrompt')
  }

  section(): () => void {
    return () => {}
  }

  getSectionOrder(): number {
    return 1600
  }
}

/**
 * 真注册表在有 owner 的 job 上要求「agent 必须是注册表里活着的那个实例」
 * （它会用 owner.ctx 挂清理 effect）。这里补一个最小的 agents 服务，
 * 让这条真实约束也能被走一遍。
 */
class FakeAgents extends Service {
  private readonly live = new Map<string, unknown>()
  constructor(ctx: Context) {
    super(ctx, 'agents')
  }

  register(agent: { id: string }): void {
    this.live.set(agent.id, agent)
  }

  get(id: string): unknown {
    return this.live.get(id)
  }
}

const settle = (ms: number): Promise<void> => new Promise(resolve => {
  setTimeout(resolve, ms)
})

test('真 jobs + 真 subprocess：一条命令的输出进会话，job_list 能看到它', async () => {
  const ctx = new Context()
  ctx.plugin(LocalJobRegistry)
  ctx.plugin(LocalSubprocessRuntime)
  ctx.plugin(FakeTools)
  ctx.plugin(FakePrompt)
  ctx.plugin(FakeAgents)
  await settle(200)

  assert.ok(ctx.get('jobs') !== undefined, 'jobs 服务没挂上')
  assert.ok(ctx.get('subprocess') !== undefined, 'subprocess 服务没挂上')

  const inbox: string[] = []
  const agent = {
    id: 'session-integration',
    // 0.1.7 的任务注册表按会话 id 认 owner，再到 agents 服务里找活实例。
    session: { id: 'session-integration', header: { cwd: process.cwd() } },
    // 真注册表会拿 owner.ctx 挂清理 effect（agent 销毁时收尸）。
    ctx: { effect: (fn: () => unknown) => { fn() } },
    steer: (message: { content: Array<{ type: string; text?: string }> }) => {
      inbox.push(message.content[0]?.text ?? '')
    },
  }
  ;(ctx.get('agents') as unknown as FakeAgents).register(agent)

  // 插件按它真实的形态加载（含 inject 声明），配置只把合并窗口调小。
  ctx.plugin({ ...monitorPlugin, config: Config({ coalesceMs: 50 }) as MonitorConfig })
  await settle(200)

  const tools = (ctx.get('tools') as unknown as FakeTools).registered
  const monitor = tools.get('monitor')
  assert.ok(monitor !== undefined, 'monitor 工具没注册上')

  const started = await monitor.execute(
    { command: 'echo 真进程的一行; echo 诊断 >&2', description: '集成冒烟' },
    { agent },
  ) as { id: string }
  // 宿主 0.2.1 起任务编号是随机串，不再从 1 数。
  assert.match(started.id, /^monitor-[0-9a-f]{8,}$/, 'job id 应该由真注册表发')

  await settle(600)
  assert.equal(inbox.length, 1, `该只有一条事件通知：${JSON.stringify(inbox)}`)
  assert.match(inbox[0] ?? '', /真进程的一行/)

  const listed = await (tools.get('monitor_list') as ToolLike).execute({}, { agent }) as {
    monitors: Array<{ id: string; status: string }>
  }
  assert.deepEqual(listed.monitors.map(row => row.id), [started.id])

  // 真注册表那边也要能看见它 —— 说明 job_list / job_kill 对它同样管用。
  // 注意要带 caller：注册表的可见性是按 owner 围的，不带 caller 只看得见无主任务。
  const jobs = ctx.get('jobs') as unknown as { list: (caller?: unknown) => Array<{ kind: string }> }
  assert.equal(jobs.list(agent.session.id).filter(job => job.kind === 'monitor').length, 1)
})

test('真 jobs：job_output 读回的输出保留行边界（空行不丢）', async () => {
  const ctx = new Context()
  ctx.plugin(LocalJobRegistry)
  ctx.plugin(LocalSubprocessRuntime)
  ctx.plugin(FakeTools)
  ctx.plugin(FakePrompt)
  ctx.plugin(FakeAgents)
  await settle(200)
  const agent = {
    id: 'session-lines',
    session: { id: 'session-lines', header: { cwd: process.cwd() } },
    ctx: { effect: (fn: () => unknown) => { fn() } },
    steer: () => {},
  }
  ;(ctx.get('agents') as unknown as FakeAgents).register(agent)
  ctx.plugin({ ...monitorPlugin, config: Config({ coalesceMs: 50 }) as MonitorConfig })
  await settle(200)

  const tools = (ctx.get('tools') as unknown as FakeTools).registered
  const started = await (tools.get('monitor') as ToolLike).execute(
    { command: "printf 'line-A\\n\\nline-C\\n'", description: '行边界' },
    { agent },
  ) as { id: string }
  await settle(600)

  // 宿主 job_output 把 chunks 的 text 原样 join('') 给模型
  const jobs = ctx.get('jobs') as unknown as { read: (id: string, caller?: string) => { chunks: Array<{ text: string }> } }
  const read = jobs.read(started.id, agent.session.id)
  const text = read.chunks.map(chunk => chunk.text).join('')
  assert.equal(text, 'line-A\n\nline-C\n', `job 输出拼接后应逐行一致：${JSON.stringify(read.chunks)}`)
})
