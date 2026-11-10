/**
 * A broken stdin pipe must fail the kernel, not the host.
 *
 * Once the kernel's end of its stdin is closed — its process crashed before
 * Node saw `exit`, or a cell ran `os.close(0)` — the next frame the host
 * writes fails with EPIPE, emitted as an `error` event. Without a listener
 * that is an uncaught exception, and the desktop backend exits on those:
 * every session would go down because one kernel closed a pipe.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { PythonKernel, type CellOutcome } from '../src/kernel.ts'

const PYTHON = process.env['DSH_PY'] ?? 'python3'

/** Speaks just enough protocol to be ready, then closes its stdin and stays alive. */
const CLOSES_STDIN = [
  '-c',
  'import os, sys, json, time\n'
  + 'sys.stdout.write(json.dumps({"event": "ready", "protocol": 3, "python": "3.12.0-fake"}) + "\\n")\n'
  + 'sys.stdout.flush()\n'
  + 'os.close(0)\n'
  + 'time.sleep(30)\n',
]

describe('a kernel that closed its stdin', () => {
  it('turns the broken pipe into a failed cell instead of an uncaught error', async () => {
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown): void => { uncaught.push(error) }
    // Replace node:test's own handler for the duration: with it in place an
    // EPIPE fails the run from outside this test, which is the defect itself.
    const saved = process.listeners('uncaughtException')
    process.removeAllListeners('uncaughtException')
    process.on('uncaughtException', onUncaught)
    const kernel = new PythonKernel({ python: PYTHON, pythonPath: [], moduleArgs: CLOSES_STDIN, onHostRequest: () => {} }, 1)
    try {
      await kernel.start(10_000)
      await new Promise((r) => setTimeout(r, 200)) // let the kernel close its end
      // A large frame fills the pipe buffer, so the write really reaches the
      // closed end rather than sitting in a buffer until exit.
      const code = `x = ${JSON.stringify('y'.repeat(256 * 1024))}`
      const outcomes: Array<CellOutcome | 'hung'> = []
      for (let i = 0; i < 3; i += 1) {
        outcomes.push(await Promise.race([
          kernel.execute(`cell-${i}`, code),
          new Promise<'hung'>((r) => setTimeout(() => r('hung'), 3_000)),
        ]))
      }
      await new Promise((r) => setTimeout(r, 200))
      assert.deepEqual(uncaught.map(String), [], 'EPIPE must not escape as an uncaught exception')
      assert.ok(outcomes.every((o) => o !== 'hung'), `a cell on a dead pipe must settle: ${JSON.stringify(outcomes)}`)
      assert.ok(outcomes.every((o) => typeof o === 'object' && o.status === 'kernel-exit'), JSON.stringify(outcomes))
      assert.equal(kernel.ready, false, 'a kernel that cannot be written to is not ready')
    } finally {
      process.removeListener('uncaughtException', onUncaught)
      for (const listener of saved) process.on('uncaughtException', listener)
      await kernel.terminate('test done')
    }
  })
})
