/**
 * Per-cell timeoutMs: run_code offers it once the runtime declares a budget;
 * expiry is a cancel (CancelledError reaches Python, never ToolCallError),
 * the kernel and its variables stay, and finished effects are not undone.
 */
import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { mountAgents } from './fixtures/agents.ts'
import { Config, PythonReplRuntime } from '../src/index.ts'

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function boot(extra: Record<string, unknown> = {}): Promise<{ ctx: Context; runtime: PythonReplRuntime }> {
  const ctx = new Context()
  await mountAgents(ctx)
  await tick()
  await ctx.plugin(PythonReplRuntime, Config({ python: process.env['DSH_PY'] ?? 'python3', residentTools: [], skillRoots: [], ...extra }))
  await tick()
  return { ctx, runtime: ctx.get('ptcRuntime') as unknown as PythonReplRuntime }
}

const started: PythonReplRuntime[] = []
after(async () => { await Promise.all(started.map((r) => r.disposeAll())) })

describe('per-cell timeoutMs', () => {
  it('declares its budget, caps a request at it, fills it in when absent, and keeps null as no deadline', async () => {
    const { runtime } = await boot({ maxCellTimeoutMs: 60_000 })
    started.push(runtime)
    assert.deepEqual(runtime.timeout, { defaultMs: 60_000, maxMs: 60_000 })
    const resolve = (timeoutMs: unknown) => runtime.resolve({ program: '1', bindings: [], cwd: '/tmp', ...(timeoutMs === undefined ? {} : { timeoutMs }) } as never).timeoutMs
    assert.equal(resolve(undefined), 60_000)
    assert.equal(resolve(1_500), 1_500)
    assert.equal(resolve(10_000_000), 60_000)
    assert.equal(resolve(null), null)
    assert.throws(() => resolve(0), /invalid timeoutMs/)
    assert.throws(() => resolve(Number.NaN), /invalid timeoutMs/)
  })

  it('a cell past its budget is cancelled: CancelledError in Python, kernel and variables kept, kind timeout', async () => {
    const { ctx, runtime } = await boot()
    started.push(runtime)
    const agents = ctx.get('agents')!
    const agent = { id: 'agent-t', sessionId: 'session-timeout' } as unknown as Agent
    const run = (program: string, timeoutMs?: number) => agents.withInitiator(agent, () =>
      runtime.run(runtime.resolve({ program, bindings: [], cwd: '/tmp', ...(timeoutMs === undefined ? {} : { timeoutMs }) } as never)))
    assert.equal((await run('kept = 41')).error, undefined)
    const started_ = Date.now()
    const slow = await run('import asyncio\nseen = []\ntry:\n    await asyncio.sleep(30)\nexcept asyncio.CancelledError:\n    seen.append("cancelled")\n    raise\nexcept Exception as e:\n    seen.append("exception " + repr(e))', 800)
    const took = Date.now() - started_
    assert.equal(slow.error?.kind, 'timeout', JSON.stringify(slow))
    assert.match(slow.error!.message, /ran past its 800 ms budget \(timeoutMs\) and was cancelled/)
    assert.match(slow.error!.message, /kernel and its variables are kept/)
    assert.ok(took < 5_000, `took ${took} ms`)
    const next = await run('(kept + 1, seen)')
    assert.equal(next.error, undefined, JSON.stringify(next))
    assert.match(next.logs.join('\n'), /\(42, \['cancelled'\]\)/)
  })

  it('a cell that finishes inside its budget is untouched', async () => {
    const { ctx, runtime } = await boot()
    started.push(runtime)
    const agents = ctx.get('agents')!
    const agent = { id: 'agent-u', sessionId: 'session-quick' } as unknown as Agent
    const done = await agents.withInitiator(agent, () => runtime.run(runtime.resolve({ program: 'import asyncio\nawait asyncio.sleep(0.1)\n"fine"', bindings: [], cwd: '/tmp', timeoutMs: 5_000 } as never)))
    assert.equal(done.error, undefined, JSON.stringify(done))
    assert.match(done.logs.join('\n'), /fine/)
  })
})
