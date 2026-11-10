/**
 * Bounded teardown: the host, not Python, owns the deadline.
 *
 * The defect these pin: the host once delegated bounded teardown to the
 * Python side. A kernel whose event loop is blocked — a task in a sync busy
 * loop, an uninterruptible extension — then has no ceiling at all, and
 * `run_code` never returns.
 *
 * Every test here asserts a HOST-side bound: the runtime must settle within
 * its own deadline regardless of what the kernel does.
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ReplSession } from '../src/session.ts'
import type { BoundTool } from '../src/lease.ts'
const pidOf = (r: { logs: string[] }): number => Number(r.logs.join('').trim())

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const PYTHON = process.env['DSH_PY'] ?? 'python3'

const sessions: ReplSession[] = []
function newSession(extra: Partial<ConstructorParameters<typeof ReplSession>[0]> = {}): ReplSession {
  const session = new ReplSession({
    python: PYTHON,
    vendorRoot: join(root, 'vendor', 'prime'),
    pythonRoot: join(root, 'python'),
    // Short deadlines keep the suite quick; production defaults are larger.
    teardownGraceMs: 800,
    interruptGraceMs: 800,
    ...extra,
  })
  sessions.push(session)
  return session
}
const noTools = (): Map<string, BoundTool> => new Map()

/**
 * Whether a pid still exists. `kernelAlive` is not sufficient evidence: the
 * session drops its kernel reference on retirement, and `killed` only means a
 * signal was delivered (`killed` only means a signal was delivered).
 */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

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

describe('cleanup must be bounded by the HOST, not by asyncio', () => {
  it('returns within its own deadline when cleanup spins the event loop', async () => {
    const session = newSession({ teardownGraceMs: 700 })
    const started = Date.now()
    const result = await session.runCell(STUCK_AFTER_CELL, noTools())
    const elapsed = Date.now() - started

    assert.ok(
      elapsed < 15_000,
      `run_code must not hang forever; took ${elapsed}ms (a Python-side timeout cannot fire when the loop is blocked)`,
    )
    assert.ok(result.error, 'a cell whose teardown could not finish must report failure')
  })

  it('kills the kernel process instead of leaking it', async () => {
    const session = newSession({ teardownGraceMs: 500 })
    const pid = pidOf(await session.runCell('import os; os.getpid()', noTools()))
    assert.ok(pid)
    await session.runCell(STUCK_AFTER_CELL, noTools())

    assert.equal(session.kernelAlive, false, 'an unresponsive kernel must be terminated')
    // Observe the OS, not just our own bookkeeping.
    assert.ok(!processAlive(pid), `pid ${pid} must have exited, not merely been signalled`)
  })

  it('reports state loss without silently pretending nothing happened', async () => {
    // The requirement is that the loss is ANNOUNCED — not that the session is
    // over: refusing every later cell would end the session under PTC
    // (see test/kernel-rebirth.test.ts).
    const session = newSession({ teardownGraceMs: 500 })
    await session.runCell('keeper = "before"', noTools())
    await session.runCell(STUCK_AFTER_CELL, noTools())

    const next = await session.runCell(
      'try:\n    keeper\n    print("SURVIVED")\nexcept NameError:\n    print("namespace is fresh")\n',
      noTools(),
    )
    assert.match(next.logs.join(''), /namespace is fresh/, 'the old namespace must really be gone')
    assert.match(next.logs.join(''), /retired|stopped responding/i, 'and the model must be told why')
  })
})

describe('an abort during execution must revoke first and be bounded', () => {
  it('revokes authority the moment abort is requested, before the cell settles', async () => {
    const session = newSession()
    const attempted: string[] = []
    const tools = new Map<string, BoundTool>([
      ['probe', async () => { attempted.push('called'); return null }],
    ])
    await session.runCell('1', tools)

    const controller = new AbortController()
    // The cell catches the interrupt and then tries to use its tools anyway.
    const pending = session.runCell(
      'import asyncio\n'
      + 'try:\n'
      + '    await asyncio.sleep(5)\n'
      + 'except BaseException:\n'
      + '    try:\n'
      + '        await tools.probe({})\n'
      + '    except BaseException:\n'
      + '        pass\n',
      tools,
      controller.signal,
    )
    setTimeout(() => controller.abort(), 120)
    await pending

    assert.deepEqual(attempted, [], 'a cancelled cell must lose tool authority immediately')
  })

  it('answers a cancel quickly and kills an uninterruptible cell only when the next cell arrives', async () => {
    // DETERMINISTIC: `signal.SIG_IGN` makes the process genuinely ignore
    // SIGINT, so the cooperative interrupt provably cannot work and the host
    // deadline is the only thing that can end this. A bare `try/except` loop
    // would not do: CPython can still interrupt it between bytecodes.
    const session = newSession({ interruptGraceMs: 700 })
    const pidBefore = pidOf(await session.runCell('import os; os.getpid()', noTools()))
    assert.ok(pidBefore, 'the kernel must be running before we try to kill it')

    const controller = new AbortController()
    const pending = session.runCell(
      'import signal, time\n'
      + 'signal.signal(signal.SIGINT, signal.SIG_IGN)   # cooperative interrupt now impossible\n'
      + 'while True:\n'
      + '    time.sleep(0.05)\n',
      noTools(),
      controller.signal,
    )
    // Let the cell install the handler before cancelling.
    await new Promise((r) => setTimeout(r, 250))
    const cancelled = Date.now()
    controller.abort()
    const result = await pending
    assert.equal(result.error?.kind, 'abort')
    assert.ok(Date.now() - cancelled < 3_000, 'the cancel is answered without waiting for the kernel')
    // As Prime: the cancel alone never kills, so whatever the cell built is still there.
    assert.ok(processAlive(pidBefore), `pid ${pidBefore} must survive the cancel itself`)

    const arrived = Date.now()
    const next = await session.runCell('1', noTools())
    const elapsed = Date.now() - arrived
    assert.ok(!processAlive(pidBefore), `pid ${pidBefore} must no longer exist`)
    assert.ok(elapsed >= 700, `the next cell interrupts for the whole grace period before killing; took ${elapsed}ms`)
    assert.ok(elapsed < 15_000, `but it must still be bounded; took ${elapsed}ms`)
    assert.match(next.logs.join('\n'), /still running 700ms after the next cell arrived/, 'the next cell is told why the kernel was replaced')
  })

  it('keeps the kernel and its variables when a cancelled cell stops before the grace runs out', async () => {
    const session = newSession({ interruptGraceMs: 5_000 })
    const pidBefore = pidOf(await session.runCell('import os; os.getpid()', noTools()))
    const controller = new AbortController()
    const pending = session.runCell(
      'import time\n'
      + 'marker = "built before the cancel"\n'
      + 'try:\n'
      + '    time.sleep(30)\n'
      + 'except KeyboardInterrupt:\n'
      + '    pass   # swallows the first interrupt and keeps going\n'
      + 'time.sleep(30)\n',
      noTools(),
      controller.signal,
    )
    await new Promise((r) => setTimeout(r, 250))
    controller.abort()
    assert.equal((await pending).error?.kind, 'abort')

    const next = await session.runCell('(os.getpid(), marker)', noTools())
    assert.equal(next.error, undefined, JSON.stringify(next.error))
    assert.match(next.logs.join('\n'), new RegExp(`\\(${pidBefore}, 'built before the cancel'\\)`), 'the next cell re-interrupts it; same kernel, same variables')
  })

  it('still lets a well-behaved cell be interrupted without killing the kernel', async () => {
    const session = newSession({ interruptGraceMs: 3_000 })
    await session.runCell('marker = "alive"', noTools())
    const controller = new AbortController()
    const pending = session.runCell('import asyncio\nawait asyncio.sleep(30)', noTools(), controller.signal)
    setTimeout(() => controller.abort(), 120)
    const result = await pending
    assert.equal(result.error?.kind, 'abort')

    const after = await session.runCell('marker', noTools())
    assert.equal(after.error, undefined, 'a cooperative interrupt must not destroy the namespace')
    assert.match(after.logs.join(''), /alive/)
  })
})

describe('authority must end when `done` is parsed, not a microtask later', () => {
  // NOTE on what these can and cannot show. A task spawned by a cell runs
  // WHILE the cell is still open, so a call it makes immediately is legitimate
  // and must succeed. The invariant under test is narrower: once the cell has
  // settled, no further call may reach a binding — including a call whose
  // frame shares the pipe chunk with `done`.
  const trailer = (delay: string): string =>
    'import asyncio\n'
    + 'async def trailer():\n'
    + `    await asyncio.sleep(${delay})\n`
    + '    try:\n'
    + '        await tools.late({})\n'
    + '    except BaseException:\n'
    + '        pass\n'
    + 't = asyncio.create_task(trailer())\n'

  it('refuses a call from a task that outlived its cell', async () => {
    const session = newSession()
    const served: string[] = []
    const tools = new Map<string, BoundTool>([
      ['late', async () => { served.push('served'); return null }],
    ])
    await session.runCell('1', tools)
    await session.runCell(trailer('0.15'), tools)
    await session.runCell('import asyncio\nawait asyncio.sleep(0.4)', tools)
    assert.deepEqual(served, [], 'a settled cell must not reach its bindings')
  })

  it('refuses late calls after an errored cell too', async () => {
    const session = newSession()
    const served: string[] = []
    const tools = new Map<string, BoundTool>([
      ['late', async () => { served.push('served'); return null }],
    ])
    await session.runCell('1', tools)
    await session.runCell(
      `${trailer('0.15')}raise ValueError("cell fails right after spawning")\n`,
      tools,
    )
    await session.runCell('import asyncio\nawait asyncio.sleep(0.4)', tools)
    assert.deepEqual(served, [])
  })

  it('still allows a call made while the cell is genuinely open', async () => {
    // The counterpart: revoking too eagerly would break ordinary concurrency.
    const session = newSession()
    const served: string[] = []
    const tools = new Map<string, BoundTool>([
      ['late', async () => { served.push('served'); return null }],
    ])
    await session.runCell(
      'import asyncio\n'
      + 'async def worker():\n'
      + '    await tools.late({})\n'
      + 't = asyncio.create_task(worker())\n'
      + 'await t\n',
      tools,
    )
    assert.deepEqual(served, ['served'], 'work awaited inside the cell is legitimate')
  })
})
