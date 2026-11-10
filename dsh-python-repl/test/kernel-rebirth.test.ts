/**
 * After a kernel is retired, the NEXT cell must start a fresh one.
 *
 * The defect this pins, found in a real GUI session (2026-09-22): a kernel
 * the host had to retire — correct so far — made the session refuse every
 * later cell with the same retirement message, forever. Six cells over several minutes all came
 * back identical.
 *
 * Under PTC, `run_code` is the agent's ONLY tool. A permanently retired
 * kernel therefore does not degrade the session, it ends it: the agent can
 * still talk but can no longer act, with no way back except a new session.
 *
 * Retirement is supposed to mean "this kernel is gone and your variables with
 * it" — a state-loss event, like the documented lazy-start path. It was never
 * supposed to mean "this session is over".
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ReplSession } from '../src/session.ts'
import type { BoundTool } from '../src/lease.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const PYTHON = process.env['DSH_PY'] ?? 'python3'

const sessions: ReplSession[] = []
function newSession(extra: Partial<ConstructorParameters<typeof ReplSession>[0]> = {}): ReplSession {
  const session = new ReplSession({
    python: PYTHON,
    vendorRoot: join(root, 'vendor', 'prime'),
    pythonRoot: join(root, 'python'),
    teardownGraceMs: 700,
    interruptGraceMs: 700,
    ...extra,
  })
  sessions.push(session)
  return session
}
const noTools = (): Map<string, BoundTool> => new Map()

after(async () => {
  await Promise.all(sessions.map((s) => s.dispose()))
})

/** A task that blocks the event loop once the host's end-of-cell request arrives: the kernel stops answering. */
const STUCK_AFTER_CELL =
  'import asyncio, time, rlm.repl as _r\n'
  + 'async def stuck():\n'
  + '    while not any(i.endswith(":end") for i in _r._inflight):\n'
  + '        await asyncio.sleep(0)\n'
  + '    time.sleep(30)\n'
  + 't = asyncio.create_task(stuck())\n'

describe('a retired kernel must be replaced, not remembered forever', () => {
  it('runs the very next cell on a fresh kernel', async () => {
    const session = newSession()
    const first = await session.runCell(STUCK_AFTER_CELL, noTools())
    assert.ok(first.error, 'the cell whose kernel stopped answering must report the problem')

    const next = await session.runCell('1 + 1', noTools())
    assert.equal(
      next.error,
      undefined,
      `the next cell must run on a new kernel, got: ${JSON.stringify(next.error)}`,
    )
    assert.match(next.logs.join(''), /2/)
  })

  it('bumps the epoch so stale leases can never be honoured', async () => {
    const session = newSession()
    const before = session.epoch
    await session.runCell(STUCK_AFTER_CELL, noTools())
    await session.runCell('1', noTools())
    assert.ok(
      session.epoch > before,
      'a replacement kernel is a new generation; reusing the epoch would let a stale run id match',
    )
  })

  it('tells the model its variables are gone, exactly once', async () => {
    const session = newSession()
    await session.runCell('keeper = "from the old kernel"', noTools())
    await session.runCell(STUCK_AFTER_CELL, noTools())

    const next = await session.runCell(
      'try:\n    keeper\n    print("SURVIVED")\nexcept NameError:\n    print("gone as expected")\n',
      noTools(),
    )
    assert.equal(next.error, undefined, JSON.stringify(next.error))
    const text = next.logs.join('')
    assert.match(text, /gone as expected/, 'the namespace really is fresh')
    assert.match(text, /state|lost|restart|gone/i, 'and the model must be told, not left to guess')

    // The notice is a one-shot event, not a permanent condition.
    const third = await session.runCell('"third cell"', noTools())
    assert.ok(
      !/was retired/.test(third.logs.join('')),
      'repeating the retirement notice on every later cell is what made this look permanent',
    )
  })

  it('keeps working across repeated retirements', async () => {
    // Whatever the model does, the session must stay usable.
    const session = newSession()
    for (let round = 0; round < 2; round += 1) {
      await session.runCell(STUCK_AFTER_CELL, noTools())
      const recovered = await session.runCell(`${round} + 100`, noTools())
      assert.equal(recovered.error, undefined, `round ${round} failed to recover`)
      assert.match(recovered.logs.join(''), new RegExp(String(round + 100)))
    }
  })

  it('delivers the notice through the real runtime, not just the session', async () => {
    // End-to-end: what the MODEL sees. The session keeps the notice on a
    // one-shot channel; `PythonReplRuntime.run` is what appends it to the
    // cell's logs. Testing only the session layer would miss a broken hand-off.
    const { Context } = await import('@deepseek-ai/cordis')
    const { mountAgents } = await import('./fixtures/agents.ts')
    const { Config, PythonReplRuntime } = await import('../src/index.ts')
    const ctx = new Context()
    // The runtime refuses callers it cannot attribute to a session, so the
    // registry has to exist before it — same shape as test/identity.test.ts.
    await mountAgents(ctx)
    await new Promise((r) => setTimeout(r, 0))
    await ctx.plugin(PythonReplRuntime, Config({
      python: PYTHON,
      startupTimeoutMs: 30_000,
      teardownGraceMs: 700,
      interruptGraceMs: 700,
      toolCallTimeoutMs: 0,
      residentTools: [],
      skillRoots: [],
    }))
    await new Promise((r) => setTimeout(r, 0))
    const runtime = ctx.get('ptcRuntime') as unknown as {
      run: (r: unknown) => Promise<{ logs: string[]; error?: unknown }>
      disposeAll: () => Promise<void>
    }
    const signal = new AbortController().signal
    const agents = ctx.get('agents') as unknown as {
      withInitiator: <T>(a: unknown, op: () => T) => T
    }
    const agent = { id: 'agent-rebirth', sessionId: 'session-rebirth' }
    const run = (program: string): Promise<{ logs: string[]; error?: unknown }> =>
      agents.withInitiator(agent, () => runtime.run({ program, bindings: [], signal }))
    try {
      await run('marker = 1')
      await run(STUCK_AFTER_CELL)
      const after = await run('"recovered"')
      assert.equal(after.error, undefined, 'the model must get a working cell back')
      assert.match(
        after.logs.join(''),
        /retired|state|lost|stopped/i,
        'and the state-loss notice must reach the model, not stay inside the session',
      )
    } finally {
      await runtime.disposeAll()
    }
  })

  it('still refuses to run after an explicit dispose', async () => {
    // Rebirth applies to a kernel the HOST killed, not to a session the owner
    // shut down — otherwise dispose() would silently resurrect a process.
    const session = newSession()
    await session.runCell('1', noTools())
    await session.dispose()
    const after_ = await session.runCell('1', noTools())
    assert.ok(after_.error, 'a disposed session must stay disposed')
    assert.match(after_.error?.message ?? '', /disposed/)
  })
})
