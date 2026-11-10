/**
 * When the host cannot confirm a kernel process stopped, the session must not
 * hang, must not reuse that kernel, must say the process may still be alive
 * (with its pid), and must keep it so a later close can retry.
 *
 * Real Python kernels; only `kill` on the spawned child is replaced, the same
 * seam test/kernel-termination.test.ts uses for PythonKernel alone.
 */
import { strict as assert } from 'node:assert'
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { fileURLToPath } from 'node:url'
import { it, type TestContext } from 'node:test'
import { ReplSession, type SessionOptions } from '../src/session.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
/** The value of `work`, or a failure when it does not settle in time: a hang is the defect under test. */
async function within<T>(work: Promise<T>, ms = 8000): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms)
    })])
  } finally { clearTimeout(timer) }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

/** Every child the session spawns, with a switch that makes its kill fail. */
function harness(t: TestContext, options: Partial<SessionOptions> = {}) {
  const spawn = childProcess.spawn
  const children: ChildProcessWithoutNullStreams[] = []
  const state = { mode: 'ok' as 'ok' | 'false' | 'throw', signals: 0 }
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
    const child = Reflect.apply(spawn, childProcess, args) as ChildProcessWithoutNullStreams
    const real = child.kill.bind(child)
    child.kill = ((signal?: NodeJS.Signals | number) => {
      state.signals += 1
      if (state.mode === 'throw') throw new Error('injected kill exception')
      if (state.mode === 'false') return false
      return real(signal)
    }) as typeof child.kill
    children.push(child)
    return child
  })
  syncBuiltinESMExports()
  const repl = new ReplSession({
    python: process.env['DSH_PY'] ?? 'python3',
    vendorRoot: `${root}/vendor/prime`, pythonRoot: `${root}/python`,
    ...options,
  })
  t.after(async () => {
    state.mode = 'ok'
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await repl.dispose().catch(() => undefined)
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  return { repl, children, state }
}

it('a restart whose kill fails starts a fresh kernel and names the old pid as possibly alive', { timeout: 30_000 }, async (t) => {
  const { repl, children, state } = harness(t)
  assert.equal((await repl.runCell('x = 1', new Map())).error, undefined)
  const oldPid = children[0]!.pid!
  state.mode = 'false'
  await within(repl.runCell('await repl.restart("test")', new Map()))
  state.mode = 'ok'
  assert.ok(alive(oldPid), 'the fixture really left the old process running')
  assert.deepEqual(repl.unterminatedPids, [oldPid])

  const next = await within(repl.runCell('"x" in globals()', new Map()))
  assert.equal(next.error, undefined, JSON.stringify(next.error))
  assert.match(next.logs.join('\n'), /False/, 'the next cell never reuses the half-stopped kernel')
  assert.equal(children.length, 2)
  assert.notEqual(children[1]!.pid, oldPid)
  const notice = next.logs.join('\n')
  assert.match(notice, new RegExp(`pid ${oldPid}\\).*could not be confirmed stopped`))
  assert.match(notice, /may still be running/)
  assert.doesNotMatch(notice, /is gone|has exited|was killed/)
  const later = await within(repl.runCell('1', new Map()))
  assert.doesNotMatch(later.logs.join('\n'), /could not be confirmed stopped/, 'said once')

  await repl.dispose()
  assert.equal(alive(oldPid), false, 'closing the session retries the retained process')
  assert.deepEqual(repl.unterminatedPids, [])
})

it('dispose that cannot stop the kernel rejects with its pid, and a second dispose really retries', { timeout: 30_000 }, async (t) => {
  const { repl, children, state } = harness(t, { teardownGraceMs: 50 })
  assert.equal((await repl.runCell('import time', new Map())).error, undefined)
  const pid = children[0]!.pid!
  // A non-daemon thread keeps the interpreter from exiting on its own after the shutdown request.
  assert.equal((await repl.runCell('import threading, time; threading.Thread(target=time.sleep, args=(60,)).start()', new Map())).error, undefined)
  state.mode = 'throw'
  const first = await within(repl.dispose().then(() => 'resolved', (error: Error) => error))
  assert.ok(first instanceof Error, 'a kernel that did not exit is not a successful close')
  assert.match(first.message, new RegExp(`pids still running: ${pid}`))
  assert.ok(alive(pid))
  const refused = await repl.runCell('1', new Map())
  assert.equal(refused.error?.kind, 'worker-exit', 'a closed session never starts or reuses a kernel')
  state.mode = 'ok'
  await repl.dispose()
  assert.equal(alive(pid), false)
})

it('a corrupt frame with a failing kill signals once, is reported, and the next cell gets a new kernel', { timeout: 30_000 }, async (t) => {
  const { repl, children, state } = harness(t)
  assert.equal((await repl.runCell('0', new Map())).error, undefined)
  const oldPid = children[0]!.pid!
  state.mode = 'throw'
  const broken = await within(repl.runCell('import os, rlm.repl as _kernel\nos.write(_kernel._protocol_fd, b"not-json\\n")\nawait asyncio.sleep(60)', new Map()))
  assert.equal(broken.error?.kind, 'worker-exit')
  assert.equal(state.signals, 1, 'the kernel and the session share one termination')
  state.mode = 'ok'
  assert.deepEqual(repl.unterminatedPids, [oldPid])
  const next = await within(repl.runCell('1 + 1', new Map()))
  assert.equal(next.error, undefined, JSON.stringify(next.error))
  assert.notEqual(children.at(-1)!.pid, oldPid)
  assert.match(next.logs.join('\n'), new RegExp(`could not parse.*pid ${oldPid}\\)`, 's'))
})

it('a failed start whose termination already failed is not signalled again automatically', { timeout: 30_000 }, async (t) => {
  const { repl, children, state } = harness(t, { startupTimeoutMs: 1 })
  state.mode = 'false'
  const result = await within(repl.runCell('1', new Map()))
  assert.equal(result.error?.kind, 'worker-exit')
  assert.match(result.error?.message ?? '', /terminat.*fail|failed.*terminat/i)
  assert.equal(state.signals, 1, 'the start path already tried; no second automatic SIGKILL')
  const pid = children[0]!.pid!
  assert.deepEqual(repl.unterminatedPids, [pid])
  assert.ok(alive(pid))
  state.mode = 'ok'
  await repl.dispose()
  assert.equal(alive(pid), false, 'an explicit close retries it')
})
