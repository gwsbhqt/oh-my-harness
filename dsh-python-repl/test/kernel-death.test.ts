/**
 * A kernel that dies on its own must never hang the cell that was running.
 *
 * Field 2026-09-27: a cell ran `os.kill(os.getpid(), signal.SIGKILL)`. The
 * process was gone, yet `run_code` never returned and the user's Stop button
 * could not end the turn — the app had to be restarted. Node reports a
 * signal death as `exitCode === null` (only `signalCode` is set), and the
 * kernel's "already exited?" checks read `exitCode`, so shutdown waited for an
 * `exit` event that had already fired.
 *
 * Every assertion here is bounded: a regression must show up as a failed
 * race against a deadline, not as a suite that never finishes.
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ReplSession, type CellResult } from '../src/session.ts'
import { PythonKernel } from '../src/kernel.ts'
import type { BoundTool } from '../src/lease.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const PYTHON = process.env['DSH_PY'] ?? 'python3'

const sessions: ReplSession[] = []
function newSession(): ReplSession {
  const session = new ReplSession({
    python: PYTHON,
    vendorRoot: join(root, 'vendor', 'prime'),
    pythonRoot: join(root, 'python'),
    teardownGraceMs: 800,
    interruptGraceMs: 800,
  })
  sessions.push(session)
  return session
}
const noTools = (): Map<string, BoundTool> => new Map()

const HUNG = Symbol('hung')

/** Resolve with the value, or with HUNG once `ms` passes. */
async function within<T>(work: Promise<T>, ms: number): Promise<T | typeof HUNG> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<typeof HUNG>((resolve) => {
    timer = setTimeout(() => resolve(HUNG), ms)
  })
  try {
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

after(async () => {
  // A hung dispose would keep the suite alive forever; bound it too.
  await within(Promise.all(sessions.map((s) => s.dispose())), 5_000)
})

const SELF_KILL =
  'import os, signal\n'
  + 'print("about to die")\n'
  + 'os.kill(os.getpid(), signal.SIGKILL)\n'

describe('a kernel killed by a signal mid-cell', () => {
  it('returns worker-exit instead of hanging', async () => {
    const session = newSession()
    await session.runCell('keeper = 1', noTools())
    const result = await within(session.runCell(SELF_KILL, noTools()), 5_000)
    assert.notEqual(result, HUNG, 'run_code must return after the kernel died, not wait forever')
    const cell = result as CellResult
    assert.equal(cell.error?.kind, 'worker-exit', JSON.stringify(cell))
    assert.match(cell.error?.message ?? '', /SIGKILL/, 'say how the kernel died')
    assert.match(cell.logs.join(''), /about to die/, 'what the cell printed before dying is kept')
  })

  it('starts a fresh kernel for the next cell and says the variables are gone', async () => {
    const session = newSession()
    await session.runCell('keeper = 1', noTools())
    const before = session.epoch
    assert.notEqual(await within(session.runCell(SELF_KILL, noTools()), 5_000), HUNG)

    const next = await within(
      session.runCell('try:\n    keeper\n    print("SURVIVED")\nexcept NameError:\n    print("fresh")\n', noTools()),
      30_000,
    )
    assert.notEqual(next, HUNG, 'the next cell must not inherit the hang')
    const cell = next as CellResult
    assert.equal(cell.error, undefined, JSON.stringify(cell))
    assert.match(cell.logs.join(''), /fresh/)
    assert.ok(session.epoch > before, 'a replacement kernel is a new generation')
    assert.match(cell.logs.join(''), /gone|lost/i, 'the model must be told its state is gone')
  })

  it('a Stop pressed after the kernel died still ends the cell', async () => {
    const session = newSession()
    await session.runCell('1', noTools())
    const controller = new AbortController()
    const pending = session.runCell(
      'import os, signal, time\n'
      + 'os.kill(os.getpid(), signal.SIGKILL)\n'
      + 'time.sleep(60)\n',
      noTools(),
      controller.signal,
    )
    await new Promise((r) => setTimeout(r, 300))
    controller.abort()
    const result = await within(pending, 5_000)
    assert.notEqual(result, HUNG, 'Stop must end a cell whose kernel is already dead')
    assert.ok((result as CellResult).error, 'a cell whose kernel died is not a success')
    const next = await within(session.runCell('"alive again"', noTools()), 30_000)
    assert.notEqual(next, HUNG)
    assert.match((next as CellResult).logs.join(''), /alive again/)
  })
})

describe('shutting down a kernel that a signal already killed', () => {
  async function killedKernel(): Promise<PythonKernel> {
    const kernel = new PythonKernel({
      python: PYTHON,
      pythonPath: [join(root, 'vendor', 'prime'), join(root, 'python', 'compat'), join(root, 'python')],
      onHostRequest: () => {},
    }, 1)
    await kernel.start(30_000)
    process.kill(kernel.pidSnapshot ?? 0, 'SIGKILL')
    await kernel.exited
    return kernel
  }

  it('terminate() returns at once', async () => {
    const kernel = await killedKernel()
    assert.deepEqual(kernel.exitInfo, { code: null, signal: 'SIGKILL' })
    assert.notEqual(await within(kernel.terminate('test'), 2_000), HUNG)
  })

  it('dispose() returns at once', async () => {
    const kernel = await killedKernel()
    assert.notEqual(await within(kernel.dispose(200), 2_000), HUNG)
  })
})
