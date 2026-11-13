/**
 * A subagent's turn end is its run's end: DSH releases it, stops every job it
 * started and sends no notice (dsh-subagent watchLocalSettlement,
 * dsh-jobs-local cancelForTeardown). So a subagent is told to wait in a cell,
 * and may wait minutes there; a root session keeps "end the turn, DSH wakes you".
 */
import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgents } from './fixtures/agents.ts'
import { Config, PythonReplRuntime } from '../src/index.ts'
import { CELL_INSTRUCTIONS, rewriteSdkSection } from '../src/prompt.ts'
import { traceNotes } from '../src/cell-trace.ts'
import { isSubagentAgent, SUBAGENT_WAIT_MS, waitCapFor } from '../src/subagent.ts'
import { ReplSession } from '../src/session.ts'
import type { BoundTool } from '../src/lease.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const sessions: ReplSession[] = []
const runtimes: PythonReplRuntime[] = []
after(async () => {
  await Promise.all(sessions.map((s) => s.dispose()))
  await Promise.all(runtimes.map((r) => r.disposeAll()))
})

const WAKES = /DSH wakes you/
const SUBAGENT = /You are a subagent/

describe('which sessions are subagents', () => {
  it('reads the session header DSH writes for a delegated child', () => {
    const agent = (header: Record<string, unknown>) => ({ session: { header } })
    assert.equal(isSubagentAgent(agent({ origin: 'subagent', delegationDepth: 1 })), true)
    assert.equal(isSubagentAgent(agent({ delegationDepth: 2 })), true)
    assert.equal(isSubagentAgent(agent({ cwd: '/w' })), false)
    assert.equal(isSubagentAgent(agent({ delegationDepth: 0 })), false)
    assert.equal(isSubagentAgent(undefined), false)
    assert.equal(isSubagentAgent({ id: 'no-session' }), false)
  })

  it('a subagent may wait minutes on one job; a root session keeps cellWaitMs', () => {
    assert.equal(waitCapFor(5_000, false), 5_000)
    assert.equal(waitCapFor(5_000, true), SUBAGENT_WAIT_MS)
    assert.equal(waitCapFor(900_000, true), 900_000)
    // 0 already means no cap.
    assert.equal(waitCapFor(0, true), 0)
    assert.equal(waitCapFor(0, false), 0)
  })
})

describe('model-facing text', () => {
  const official = 'official preamble\n\n```python\nclass Tools: ...\n```'

  it('the root prompt says DSH wakes you; the subagent prompt says ending the turn kills the work', () => {
    const rootText = rewriteSdkSection(official)
    assert.ok(rootText.startsWith(CELL_INSTRUCTIONS))
    assert.match(rootText, /End your reply; DSH wakes you when a background job or subagent finishes/)
    assert.match(rootText, /and DSH wakes you when it finishes; `await job` then gives its value/)
    assert.doesNotMatch(rootText, SUBAGENT)

    const sub = rewriteSdkSection(official, { subagent: true })
    assert.match(sub, SUBAGENT)
    assert.match(sub, /no notice/)
    assert.doesNotMatch(sub, WAKES)
    assert.doesNotMatch(sub, /End your reply/)
    assert.match(sub, /repl\.background[^\n]*ending your turn/)
    assert.ok(sub.endsWith('```python\nclass Tools: ...\n```'))
  })

  it('the long-Python note: root says end the turn, a subagent is told to await instead', () => {
    const trace = { calls: [], startedAt: 0, endedAt: 75_000 }
    assert.match(traceNotes(trace)[0]!, /To wait for something, end the turn/)
    const sub = traceNotes(trace, true)[0]!
    assert.match(sub, SUBAGENT)
    assert.doesNotMatch(sub, /end the turn|wake/)
  })
})

describe('a kernel in a subagent session', () => {
  function session(subagent: boolean): ReplSession {
    const s = new ReplSession({ python: process.env['DSH_PY'] ?? 'python3', vendorRoot: join(root, 'vendor', 'prime'), pythonRoot: join(root, 'python'),
      cellWaitMs: 300, subagent, subagentWaitMs: 900 })
    sessions.push(s)
    return s
  }
  function tools(waits: number[]): Map<string, BoundTool> {
    return new Map<string, BoundTool>([
      ['bash', async () => ({ kind: 'background', jobId: 'job-1', cwd: '/' })],
      ['job_output', async (args) => {
        const ms = (args as { timeout_ms?: number }).timeout_ms ?? 0
        waits.push(ms)
        await sleep(Math.min(ms, 1_000))
        return { text: '', job: { id: 'job-1', kind: 'bash', label: 'x', status: 'running', startedAt: 1 } }
      }],
    ])
  }

  it('root: `await job` and job_output waits stop at cellWaitMs and say DSH wakes you', async () => {
    const waits: number[] = []
    const cell = await session(false).runCell('j = await bash("make", "build", run_in_background=True)\nawait j', tools(waits))
    assert.match(cell.error?.message ?? '', /still running after 0\.3s; it keeps running\. DSH wakes you when it finishes/)
    assert.ok(waits.length > 0 && waits.every((ms) => ms <= 300), `waits: ${waits.join(', ')}`)
  })

  it('subagent: the same wait runs to the longer cap and says to keep waiting in a cell', async () => {
    const waits: number[] = []
    const cell = await session(true).runCell('j = await bash("make", "build", run_in_background=True)\nawait j', tools(waits))
    const text = cell.error?.message ?? ''
    assert.match(text, /still running after 0\.9s; it keeps running\. You are a subagent/)
    assert.doesNotMatch(text, WAKES)
    assert.ok(waits.some((ms) => ms > 300) && waits.every((ms) => ms <= 900), `waits: ${waits.join(', ')}`)
  })

  it('repl.background describes itself for the kind of session', async () => {
    const doc = async (subagent: boolean) => (await session(subagent).runCell('repl.background.__doc__', new Map())).logs.join('\n')
    assert.match(await doc(false), /DSH wakes you when it finishes/)
    const sub = await doc(true)
    assert.match(sub, /You are a subagent: `await` it before you finish, because ending your turn stops it with no notice/)
    assert.doesNotMatch(sub, WAKES)
  })
})

describe('the runtime tells the kernel which kind of session it serves', () => {
  async function boot(): Promise<{ ctx: Context; runtime: PythonReplRuntime }> {
    const ctx = new Context()
    await mountAgents(ctx)
    await new Promise<void>((resolve) => setImmediate(resolve))
    await ctx.plugin(PythonReplRuntime, Config({ python: process.env['DSH_PY'] ?? 'python3', residentTools: [], skillRoots: [], cellWaitMs: 5_000 }))
    await new Promise<void>((resolve) => setImmediate(resolve))
    const runtime = ctx.get('ptcRuntime') as unknown as PythonReplRuntime
    runtimes.push(runtime)
    return { ctx, runtime }
  }
  const probe = 'import os, dsh_kernel\n(os.environ.get("DSH_PYTHON_REPL_SUBAGENT"), dsh_kernel._WAIT_MS, dsh_kernel._SUBAGENT)'

  it('root session: no subagent flag, cellWaitMs as configured', async () => {
    const { ctx, runtime } = await boot()
    const agent = { id: 'root-a', sessionId: 'root-session', session: { header: { cwd: '/tmp' } } } as unknown as Agent
    const done = await ctx.get('agents')!.withInitiator(agent, () => runtime.run(runtime.resolve({ program: probe, bindings: [], cwd: '/tmp' } as never)))
    assert.equal(done.error, undefined, JSON.stringify(done))
    assert.match(done.logs.join('\n'), /\(None, 5000, False\)/)
  })

  it('subagent session: flagged, and the wait cap raised', async () => {
    const { ctx, runtime } = await boot()
    const agent = { id: 'child-a', sessionId: 'child-session', session: { header: { cwd: '/tmp', origin: 'subagent', delegationDepth: 1 } } } as unknown as Agent
    const done = await ctx.get('agents')!.withInitiator(agent, () => runtime.run(runtime.resolve({ program: probe, bindings: [], cwd: '/tmp' } as never)))
    assert.equal(done.error, undefined, JSON.stringify(done))
    assert.match(done.logs.join('\n'), new RegExp(`\\('1', ${SUBAGENT_WAIT_MS}, True\\)`))
  })
})
describe('the assembled system prompt', () => {
  it('a subagent scope gets the subagent preamble, a root scope the original', async () => {
    const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
    const { ToolRuntime } = await import('@deepseek-ai/dsh-tools')
    const PtcExecutor = await import('@deepseek-ai/dsh-tool-executor-ptc')
    const { apply } = await import('../src/index.ts')
    const ctx = new Context()
    await mountAgents(ctx)
    await ctx.plugin({ apply, Config }, { python: process.env['DSH_PY'] ?? 'python3', skillRoots: [] })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(PtcExecutor, { maxParallelSubCalls: 10 })
    await new Promise<void>((resolve) => setImmediate(resolve))
    runtimes.push(ctx.get('ptcRuntime') as unknown as PythonReplRuntime)
    const prompt = ctx.get('systemPrompt')!
    const sdk = async (scope: Agent) => (await prompt.assemble({ scope })).sections.find((section) => section.name === 'tools:sdk')!.text
    const rootText = await sdk({ id: 'p-root', sessionId: 'p-root', session: { header: {} } } as unknown as Agent)
    const childText = await sdk({ id: 'p-child', sessionId: 'p-child', session: { header: { origin: 'subagent', delegationDepth: 1 } } } as unknown as Agent)
    assert.match(rootText, /End your reply; DSH wakes you when a background job or subagent finishes/)
    assert.doesNotMatch(rootText, SUBAGENT)
    assert.match(childText, /You are a subagent: ending your turn ends your run/)
    assert.doesNotMatch(childText, WAKES)
  })
})
