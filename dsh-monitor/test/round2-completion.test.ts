/** Read-only installed-host probe: real jobs/processes and the unchanged generic
 * completion reporter. The idle driver/inbox below is a test double, not a live
 * AgentLoop or GUI acceptance. No source patch or private scheduler is used. */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test, type TestContext } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import { LocalJobRegistry } from '@deepseek-ai/dsh-jobs-local'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import * as monitor from '../src/index.ts'

const archive = process.env.DSH_APP_ASAR ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
interface Entry { files?: Record<string, Entry>; size?: number; offset?: string; unpacked?: boolean }
function hostFile(path: string): string {
  const buffer = readFileSync(archive)
  const header = JSON.parse(buffer.subarray(16, 16 + buffer.readUInt32LE(12)).toString()) as Entry
  let entry = header
  for (const part of path.split('/')) {
    const next = entry.files?.[part]
    assert.ok(next, `installed host entry missing: ${path}`)
    entry = next
  }
  if (entry.unpacked) return readFileSync(`${archive}.unpacked/${path}`, 'utf8')
  assert.ok(entry.offset !== undefined && entry.size !== undefined)
  const start = 8 + buffer.readUInt32LE(4) + Number(entry.offset)
  return buffer.subarray(start, start + entry.size).toString('utf8')
}
function dataModule(source: string): string {
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}
const noInstalledHost = existsSync(archive) ? false : 'No installed App; set DSH_APP_ASAR to run the host contract probe.'
async function loadReporter() {
  // Only resolve import locations for the isolated test. The host reporter body is unchanged.
  const retention = dataModule(hostFile('dsh/node_modules/@deepseek-ai/dsh-output-retention/lib/index.js'))
  const source = hostFile('dsh/node_modules/@deepseek-ai/dsh-tool-jobs/lib/index.js')
  return await import(dataModule(source.replace(/from "([^"]+)"/g, (_match, name: string) =>
    `from ${JSON.stringify(name === '@deepseek-ai/dsh-output-retention' ? retention : import.meta.resolve(name))}`)))
}

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
interface Started { id: string }
function messageText(message: UserMessage): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}
async function harness(t: TestContext, completionDelivery: 'quiet' | 'wakeup' = 'wakeup') {
  const app = new Context()
  for (const service of [Tools, Prompt, Agents, LocalJobRegistry, LocalSubprocessRuntime]) {
    await app.plugin(service as never, {} as never).ctx.fiber.await()
  }
  // DSH 0.2.2-rc.1 起 job_output 读到输出时，会按消息编号撤回还没送出的结束通知（agent.inbox.remove）。
  const inbox = {
    nextStep: [] as UserMessage[], nextTurn: [] as UserMessage[],
    remove(id: string) {
      const before = inbox.nextStep.length + inbox.nextTurn.length
      inbox.nextStep = inbox.nextStep.filter(m => (m as { id?: string }).id !== id)
      inbox.nextTurn = inbox.nextTurn.filter(m => (m as { id?: string }).id !== id)
      return inbox.nextStep.length + inbox.nextTurn.length < before
    },
  }
  const statuses: string[] = []
  const agent = {
    id: 'round2-completion', session: { id: 'round2-completion', header: { cwd: process.cwd() } },
    ctx: app, status: 'idle', inbox,
    inject(message: UserMessage) { inbox.nextStep.push(message) },
    steer(message: UserMessage) { inbox.nextStep.push(message); agent.status = 'running'; statuses.push('running') },
    followup(message: UserMessage) { inbox.nextTurn.push(message); agent.status = 'running'; statuses.push('running') },
  }
  ;(app.get('agents') as unknown as Agents).live.set(agent.id, agent)
  await app.plugin(await loadReporter(), { completionDelivery }).ctx.fiber.await()
  await app.plugin(monitor, { coalesceMs: 0, graceMs: 50 }).ctx.fiber.await()
  const registered = (app.get('tools') as unknown as Tools).registered
  const exec = { agent, signal: new AbortController().signal } as unknown as ToolRunContext
  const ids: string[] = []
  t.after(async () => {
    for (const id of ids) {
      const job = app.jobs.get(id as never, agent.id as never)
      if (job.status === 'running' || job.status === 'stopping') app.jobs.kill(id as never, agent.id as never, 'test cleanup')
      await app.jobs.wait(id as never, 10_000, agent.id as never)
    }
    await app.fiber.dispose()
  })
  const start = async (args: unknown) => {
    const result = await registered.get('monitor')!.execute(args, exec) as Started
    ids.push(result.id)
    return result
  }
  // Observe settlement without the consuming wait that suppresses native completion.
  const settled = () => new Promise<void>(resolve => {
    const off = app.jobs.events.subscribe({ owner: agent.id as never }, event => {
      if (event.type === 'settled') { off(); resolve() }
    })
  })
  const output = (id: string) => registered.get('job_output')!.execute({ job_id: id }, exec)
  return { app, agent, inbox, statuses, start, settled, output, registered, exec }
}

test('待补接口：单条 inject 的正常结束不应被宿主另行唤醒', { timeout: 10_000, skip: noInstalledHost, todo: 'Host JobSpec lacks per-job completion delivery; no public pre-delivery or wake-retraction hook.' }, async t => {
  const h = await harness(t)
  const done = h.settled()
  await h.start({ command: 'printf "normal event\\n"', delivery: 'inject' })
  await done
  assert.equal(h.inbox.nextStep.length, 1, 'monitor output is queued as context')
  assert.equal(h.agent.status, 'idle', 'generic completion must honor the single-monitor inject choice')
})

test('正常对照：宿主默认会另行排入结束回合；0.2.2 起读取输出会撤回这条排队通知，之前不撤回', { timeout: 10_000, skip: noInstalledHost }, async t => {
  const h = await harness(t)
  const done = h.settled()
  const result = await h.start({ command: 'printf "normal event\\n"', delivery: 'inject' })
  await done
  assert.equal(h.agent.status, 'running')
  assert.deepEqual(h.statuses, ['running'])
  assert.equal(h.inbox.nextTurn.length, 1)
  assert.equal(h.inbox.nextTurn[0]!.source.kind, 'tool-jobs')
  assert.deepEqual(Object.keys(h.inbox.nextTurn[0]!.source).sort(), ['form', 'kind', 'summary'], 'source has no structured job identity')
  const consumed = await h.output(result.id) as { text: string; job: { id: string; status: string } }
  assert.equal(consumed.text, 'normal event\n')
  assert.equal(consumed.job.id, result.id)
  assert.equal(consumed.job.status, 'completed')
  // 宿主的任务插件会不会撤回，看它自己的代码里有没有 inbox.remove（0.2.2-rc.1 起有）。
  const retracts = hostFile('dsh/node_modules/@deepseek-ai/dsh-tool-jobs/lib/index.js').includes('inbox.remove(')
  assert.equal(h.inbox.nextTurn.length, retracts ? 0 : 1, retracts ? 'terminal read retracts the queued completion' : 'terminal read does not retract queued completion')
  assert.equal(h.agent.status, 'running', 'retraction removes the message but does not undo the wake-up')
})

test('显式 quiet 对照：正常结束保留通知但不醒，不修改用户全局设置', { timeout: 10_000, skip: noInstalledHost }, async t => {
  const h = await harness(t, 'quiet')
  const done = h.settled()
  const result = await h.start({ command: 'printf "normal event\\n"', delivery: 'inject' })
  await done
  assert.equal(h.agent.status, 'idle')
  assert.deepEqual(h.statuses, [])
  assert.equal(h.inbox.nextTurn.length, 0)
  assert.deepEqual(h.inbox.nextStep.map(message => message.source.kind), ['dsh-monitor', 'tool-jobs'])
  assert.equal((await h.output(result.id) as { text: string }).text, 'normal event\n')
})

test('真实失败对照：quiet 不丢失败、诊断和心跳历史', { timeout: 10_000, skip: noInstalledHost }, async t => {
  const h = await harness(t, 'quiet')
  const done = h.settled()
  const result = await h.start({ command: 'printf "heartbeat\\n"; printf "real failure\\n" >&2; exit 7', delivery: 'inject', ignore_stdout_lines: ['heartbeat'] })
  await done
  assert.equal(h.agent.status, 'idle')
  assert.equal(h.app.jobs.get(result.id as never, h.agent.id as never).status, 'failed')
  assert.ok(h.inbox.nextStep.some(message => message.source.kind === 'dsh-monitor' && messageText(message).includes('real failure')))
  assert.ok(h.inbox.nextStep.some(message => String(message.source.kind) === 'tool-jobs' && messageText(message).includes('failed')))
  assert.equal((await h.output(result.id) as { text: string }).text, 'heartbeat\n')
  const history = await h.registered.get('monitor_output')!.execute({ monitor_id: result.id }, h.exec) as { text: string }
  assert.equal(history.text, 'heartbeat')
})

test('消费时序对照：运行中 wait 抑制结束通知，不等于结算后的撤回', { timeout: 10_000, skip: noInstalledHost }, async t => {
  const h = await harness(t)
  const result = await h.start({ command: 'sleep 0.05; printf "awaited event\\n"', delivery: 'inject' })
  await h.app.jobs.wait(result.id as never, 10_000, h.agent.id as never)
  assert.equal(h.agent.status, 'idle')
  assert.equal(h.inbox.nextTurn.length, 0)
  assert.ok(h.inbox.nextStep.every(message => message.source.kind === 'dsh-monitor'))
  assert.equal((await h.output(result.id) as { text: string }).text, 'awaited event\n')
})
