import assert from 'node:assert/strict'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { updateVolatile } from '@deepseek-ai/cosmokit'
import { LocalJobRegistry } from '@deepseek-ai/dsh-jobs-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import * as monitor from '../src/index.ts'

class Tools extends Service {
  registered = new Map<string, ToolDefinition>()
  constructor(ctx: Context) { super(ctx, 'tools') }
  register(definition: ToolDefinition) { this.registered.set(definition.name, definition); return () => {} }
}
class Prompt extends Service {
  constructor(ctx: Context) { super(ctx, 'systemPrompt') }
  section() { return () => {} }
  getSectionOrder() { return 1 }
}
class Agents extends Service {
  live = new Map<string, unknown>()
  constructor(ctx: Context) { super(ctx, 'agents') }
  get(id: string) { return this.live.get(id) }
}
class Sessions extends Service {
  readonly owners = new Map<string, unknown>()
  constructor(ctx: Context) { super(ctx, 'sessionController' as never) }
  async resolveAgent(id: string) {
    const agent = this.owners.get(id)
    return agent === undefined ? { error: new Error('owner unavailable') } : { agent }
  }
}
interface Started {
  id: string
  delivery: string
  persistent: boolean
  ignore_stdout_lines: string[]
}
interface History { text: string; restarts: number }

async function harness(t: TestContext, config: Record<string, unknown> = {}) {
  const app = new Context()
  for (const service of [Tools, Prompt, Agents, Sessions, LocalJobRegistry, LocalSubprocessRuntime]) {
    await app.plugin(service as never, {} as never).ctx.fiber.await()
  }
  const calls: Array<{ mode: string; text: string }> = []
  const receive = (mode: string) => (message: UserMessage) => {
    calls.push({ mode, text: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') })
  }
  const agent = {
    id: 'monitor-delivery-test', session: { id: 'monitor-delivery-test', header: { cwd: process.cwd() } },
    ctx: app, status: 'running', steer: receive('steer'), inject: receive('inject'), followup: receive('followup'),
  }
  ;(app.get('agents') as unknown as Agents).live.set(agent.id, agent)
  // cordis 4.1 起插件实例上的 config 是原始配置，带热改引用的解析结果只交给 apply，所以在这里接住。
  let resolved: { delivery: Parameters<typeof updateVolatile>[0] } | undefined
  const wrapped = { ...monitor, apply: (ctx: Context, cfg: never) => { resolved = cfg; return monitor.apply(ctx, cfg) } }
  const plugin = app.plugin(wrapped as never, { coalesceMs: 0, graceMs: 50, ...config } as never).ctx.fiber
  await plugin.await()
  t.after(async () => {
    for (const owner of (app.get('agents') as unknown as Agents).live.keys()) {
      for (const job of app.jobs.list(owner as never)) {
        if (job.status === 'running' || job.status === 'stopping') app.jobs.kill(job.id, owner as never, 'test cleanup')
        await app.jobs.wait(job.id, 10_000, owner as never)
      }
    }
    await app.fiber.dispose()
  })
  const tools = (app.get('tools') as unknown as Tools).registered
  const exec = { agent, signal: new AbortController().signal } as unknown as ToolRunContext
  const run = async (args: unknown) => await tools.get('monitor')!.execute(args, exec) as Started
  const finish = async (started: Started) => {
    await app.jobs.wait(started.id as never, 10_000, agent.id as never)
    assert.equal(app.jobs.get(started.id as never, agent.id as never).status, 'completed')
  }
  const history = async (started: Started) => await tools.get('monitor_output')!.execute({ monitor_id: started.id }, exec) as History
  const render = (started: Started) => tools.get('monitor')!.output.render({}, started as never).map(block => block.type === 'text' ? block.text : '').join('\n')
  const addOwner = (id: string) => {
    const calls: Array<{ mode: string; text: string }> = []
    const receive = (mode: string) => (message: UserMessage) => {
      calls.push({ mode, text: message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') })
    }
    const agent = {
      id, session: { id, header: { cwd: process.cwd() } }, ctx: app, status: 'idle',
      steer: receive('steer'), inject: receive('inject'), followup: receive('followup'),
    }
    ;(app.get('agents') as unknown as Agents).live.set(id, agent)
    ;(app.get('sessionController' as never) as unknown as Sessions).owners.set(id, agent)
    return { agent, calls }
  }
  const parallel = app.parallel.bind(app) as unknown as (event: string, payload: unknown) => Promise<void>
  return { app, calls, agent, run, finish, history, render, plugin, config: () => resolved!, addOwner, parallel }
}

async function eventually(check: () => void): Promise<void> {
  const deadline = Date.now() + 10_000
  for (;;) {
    try { check(); return } catch (error) {
      if (Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
}

test('跨插件启动：真实 jobs 与 stdout 只归目标会话，不唤醒调用方或目标模型', async t => {
  const h = await harness(t, { delivery: 'followup', defaultTimeoutMs: 1, restart: 'always' })
  const target = h.addOwner('target-original-session')
  ;(h.app.get('sessionController' as never) as unknown as Sessions).owners.set('target-alias', target.agent)
  const request: monitor.MonitorStartRequest = {
    owner: 'target-alias', command: 'printf "目标会话输出\\n"', cwd: process.cwd(), label: '指定原会话服务',
  }
  await h.parallel(monitor.MONITOR_START_EVENT, request)
  assert.ok(request.result)
  assert.deepEqual(request.result, { id: request.result.id, owner: target.agent.session.id, label: request.label, command: request.command, cwd: request.cwd })
  await h.app.jobs.wait(request.result.id as never, 10_000, target.agent.session.id as never)
  assert.equal(h.app.jobs.get(request.result.id as never, target.agent.session.id as never).status, 'completed')
  assert.equal(h.app.jobs.list(h.agent.session.id as never).length, 0)
  assert.deepEqual(h.app.jobs.list(target.agent.session.id as never).map(job => job.id), [request.result.id])
  assert.deepEqual(h.calls, [])
  assert.equal(target.calls.length, 1)
  assert.equal(target.calls[0]!.mode, 'inject')
  assert.match(target.calls[0]!.text, /目标会话输出/)
  assert.equal(target.agent.status, 'idle')
})

test('跨插件启动：restart 原样记进监听，重启前暂停时也带着；不认识的值直接拒绝', async t => {
  const h = await harness(t, { delivery: 'followup' })
  const target = h.addOwner('target-restart-policy')
  await assert.rejects(() => h.parallel(monitor.MONITOR_START_EVENT, {
    owner: target.agent.session.id, command: 'true', cwd: process.cwd(), label: '坏设置', restart: 'always',
  } as unknown as monitor.MonitorStartRequest), (error: AggregateError) => error.errors.some((e: Error) => /restart 只能是 never 或 on-failure/.test(e.message)))
  assert.equal(h.app.jobs.list(target.agent.session.id as never).length, 0)
  const request: monitor.MonitorStartRequest = {
    owner: target.agent.session.id, command: 'exec sleep 30', cwd: process.cwd(), label: '重拉起的服务', restart: 'never',
  }
  await h.parallel(monitor.MONITOR_START_EVENT, request)
  const suspended: monitor.SuspendedMonitor[] = []
  await h.parallel(monitor.RESTART_PREPARE_EVENT, suspended)
  assert.deepEqual(suspended.map(item => ({ id: item.id, restart: item.restartPolicy, delivery: item.delivery })),
    [{ id: request.result!.id, restart: 'never', delivery: 'inject' }])
  await h.app.jobs.wait(request.result!.id as never, 10_000, target.agent.session.id as never)
  rmSync(join(process.env.DSH_HOME!, 'monitor', 'suspended.json'))
})

test('跨插件启动：quiet 的监听输出不推进会话，只能回看；暂停与接回都保持安静', async t => {
  const h = await harness(t, { delivery: 'followup' })
  const target = h.addOwner('target-quiet-session')
  await assert.rejects(() => h.parallel(monitor.MONITOR_START_EVENT, {
    owner: target.agent.session.id, command: 'true', cwd: process.cwd(), label: '坏设置', quiet: 'yes',
  } as unknown as monitor.MonitorStartRequest))
  const request: monitor.MonitorStartRequest = {
    owner: target.agent.session.id, command: 'printf "安静服务输出\\n"; exec sleep 30', cwd: process.cwd(), label: '安静服务', quiet: true,
  }
  await h.parallel(monitor.MONITOR_START_EVENT, request)
  const started = request.result!
  await eventually(() => assert.match(h.app.jobs.read(started.id as never, target.agent.session.id as never).chunks.map(c => c.text).join(''), /安静服务输出/))
  const suspended: monitor.SuspendedMonitor[] = []
  await h.parallel(monitor.RESTART_PREPARE_EVENT, suspended)
  assert.deepEqual(suspended.map(item => item.quiet), [true])
  await h.app.jobs.wait(started.id as never, 10_000, target.agent.session.id as never)
  const recovery: monitor.RestartRecoveryResult = { revived: [], failed: [] }
  await h.parallel(monitor.RESTART_ABORT_EVENT, recovery)
  assert.deepEqual(recovery.failed, [])
  const revived = h.app.jobs.list(target.agent.session.id as never).find(job => job.status === 'running')!
  await eventually(() => assert.match(h.app.jobs.read(revived.id as never, target.agent.session.id as never).chunks.map(c => c.text).join(''), /安静服务输出/))
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.ok(target.calls.every(call => !call.text.includes('安静服务输出')), target.calls.map(call => call.text).join('\n---\n'))
  assert.deepEqual(h.calls, [])
  await h.app.jobs.kill(revived.id as never, target.agent.session.id as never)
})

test('跨插件启动：prepare + abort 后真实进程仍归原目标，恢复和 stdout 都不唤醒模型', async t => {
  const h = await harness(t, { delivery: 'followup' })
  const target = h.addOwner('target-recovery-session')
  const request: monitor.MonitorStartRequest = {
    owner: target.agent.session.id, command: 'printf "恢复服务输出\\n"; exec sleep 30', cwd: process.cwd(), label: '恢复测试服务',
  }
  await h.parallel(monitor.MONITOR_START_EVENT, request)
  const started = request.result!
  await eventually(() => assert.ok(target.calls.some(call => call.text.includes('恢复服务输出'))))
  const suspended: monitor.SuspendedMonitor[] = []
  await h.parallel(monitor.RESTART_PREPARE_EVENT, suspended)
  assert.deepEqual(suspended.map(item => ({ owner: item.owner, delivery: item.delivery, restart: item.restartPolicy, timeout: item.timeoutMs, ignored: item.ignoreStdoutLines })),
    [{ owner: target.agent.session.id, delivery: 'inject', restart: 'on-failure', timeout: 0, ignored: [] }])
  const saved = JSON.parse(readFileSync(join(process.env.DSH_HOME!, 'monitor', 'suspended.json'), 'utf8')) as monitor.SuspendedMonitor[]
  assert.equal(saved[0]!.owner, target.agent.session.id)
  await h.app.jobs.wait(started.id as never, 10_000, target.agent.session.id as never)
  target.calls.length = 0
  const recovery: monitor.RestartRecoveryResult = { revived: [], failed: [] }
  await h.parallel(monitor.RESTART_ABORT_EVENT, recovery)
  assert.deepEqual(recovery, { revived: [started.id], failed: [] })
  await eventually(() => assert.ok(target.calls.some(call => call.text.includes('恢复服务输出'))))
  const running = h.app.jobs.list(target.agent.session.id as never).filter(job => job.status === 'running')
  assert.equal(running.length, 1)
  assert.notEqual(running[0]!.id, started.id)
  assert.equal(h.app.jobs.list(h.agent.session.id as never).length, 0)
  assert.deepEqual(h.calls, [])
  assert.ok(target.calls.some(call => call.text.includes('relaunched')))
  assert.ok(target.calls.every(call => call.mode === 'inject'))
  assert.equal(target.agent.status, 'idle')
})

test('单条 delivery 使用真正 stdout，返回配置并分别走 inject/steer/followup', async t => {
  const h = await harness(t)
  for (const delivery of ['inject', 'steer', 'followup']) {
    const started = await h.run({ command: `printf '${delivery}真实输出\n'`, delivery })
    await h.finish(started)
    assert.equal(started.delivery, delivery)
    assert.equal(started.persistent, true)
    assert.equal(h.calls.at(-1)!.mode, delivery)
    assert.match(h.calls.at(-1)!.text, new RegExp(delivery + '真实输出'))
  }
})

test('未传 delivery 仍现读 volatile，而显式 delivery 固定', async t => {
  const h = await harness(t)
  const fixed = await h.run({ command: 'sleep 0.15; printf "fixed\n"', delivery: 'inject' })
  const inherited = await h.run({ command: 'sleep 0.15; printf "inherited\n"' })
  updateVolatile(h.config().delivery, monitor.Config({ delivery: 'followup' }).delivery)
  await h.finish(fixed)
  await h.finish(inherited)
  assert.equal(h.calls.find(call => call.text.endsWith('\nfixed\n</system-reminder>'))!.mode, 'inject')
  assert.equal(h.calls.find(call => call.text.endsWith('\ninherited\n</system-reminder>'))!.mode, 'followup')
})

test('显式忽略的心跳不投递但真实输出可回看，默认不忽略', async t => {
  const h = await harness(t)
  const started = await h.run({ command: 'printf "heartbeat\nreal event\nheartbeat-extra\n"', ignore_stdout_lines: ['heartbeat'] })
  await h.finish(started)
  assert.deepEqual(started.ignore_stdout_lines, ['heartbeat'])
  assert.ok(h.calls.every(call => !call.text.endsWith('\nheartbeat')))
  assert.ok(h.calls.some(call => call.text.includes('real event')))
  assert.ok(h.calls.some(call => call.text.includes('heartbeat-extra')))
  assert.equal((await h.history(started)).text, 'heartbeat\nreal event\nheartbeat-extra')
  const read = h.app.jobs.read(started.id as never, h.agent.id as never)
  assert.equal(read.chunks.map(chunk => chunk.text).join(''), 'heartbeat\nreal event\nheartbeat-extra\n')
  const plain = await h.run({ command: 'printf "heartbeat\n"' })
  await h.finish(plain)
  assert.ok(h.calls.at(-1)!.text.includes('heartbeat'))
})

test('忽略按完整原始行精确匹配，不按截断后的前缀误吞', async t => {
  const h = await harness(t, { maxLineBytes: 3 })
  const result = await h.run({ command: 'printf "heartbeat-long\nheartbeat-short\n"', ignore_stdout_lines: ['heartbeat-long'] })
  await h.finish(result)
  assert.equal(h.calls.length, 1)
  assert.match(h.calls[0]!.text, /bytes truncated/)
})

test('异常退出仍保留真实失败和诊断，不因忽略心跳变成功', async t => {
  const h = await harness(t)
  const result = await h.run({ command: 'printf "heartbeat\n"; printf "failure detail\n" >&2; exit 7', delivery: 'inject', ignore_stdout_lines: ['heartbeat'] })
  await h.app.jobs.wait(result.id as never, 10_000, h.agent.id as never)
  assert.equal(h.app.jobs.get(result.id as never, h.agent.id as never).status, 'failed')
  assert.ok(h.calls.some(call => call.text.includes('failure detail')))
  assert.ok(h.calls.every(call => call.mode === 'inject'))
})

test('只输出显式忽略心跳的正常命令不冒充没有 stdout', async t => {
  const h = await harness(t)
  const result = await h.run({ command: 'printf "heartbeat\n"', ignore_stdout_lines: ['heartbeat'] })
  await h.finish(result)
  assert.deepEqual(h.calls, [])
})

test('重拉后保持单条 delivery 和忽略设置', async t => {
  const h = await harness(t, { restartDelayMs: 1, restartMaxDelayMs: 1, restartLimit: 1 })
  const result = await h.run({ command: 'printf "heartbeat\nreal event\n"; exit 3', delivery: 'inject', ignore_stdout_lines: ['heartbeat'], restart: 'on-failure' })
  await h.app.jobs.wait(result.id as never, 10_000, h.agent.id as never)
  assert.equal(h.app.jobs.get(result.id as never, h.agent.id as never).status, 'failed')
  assert.ok(h.calls.length > 0)
  assert.ok(h.calls.every(call => call.mode === 'inject' && !call.text.includes('\nheartbeat')))
  const history = await h.history(result)
  assert.equal(history.restarts, 1)
  assert.equal(history.text, 'heartbeat\nreal event\nheartbeat\nreal event')
})

test('未指定 delivery 的返回说明不承诺一定唤醒', async t => {
  const h = await harness(t, { delivery: 'inject' })
  const result = await h.run({ command: 'printf "default\n"' })
  await h.finish(result)
  assert.equal(result.delivery, 'plugin-default')
  assert.match(h.render(result), /live plugin setting/)
  assert.doesNotMatch(h.render(result), /steer\/followup wake/)
})

test('非持久返回文案说明回合结束即停，inject 不承诺自动唤醒', async t => {
  const h = await harness(t)
  const result = await h.run({ command: 'printf "done\n"', persistent: false, delivery: 'inject' })
  await h.finish(result)
  assert.match(h.render(result), /turn ends|goes idle/)
  assert.match(h.render(result), /does not wake|without waking/)
})
