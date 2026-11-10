import { strict as assert } from 'node:assert'
import childProcess, { type ChildProcessWithoutNullStreams } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { it, type TestContext } from 'node:test'
import { PythonKernel } from '../src/kernel.ts'
import { PROTOCOL_VERSION } from '../src/protocol.ts'

const HUNG = Symbol('hung')
async function within<T>(work: Promise<T>, ms = 1700): Promise<T | typeof HUNG> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([work, new Promise<typeof HUNG>((resolve) => {
      timer = setTimeout(() => resolve(HUNG), ms)
    })])
  } finally { clearTimeout(timer) }
}

/** Only the child spawned by this fixture is mocked; it still has a real OS pid. */
async function fixture(t: TestContext, ready = true, onFailure?: (error: Error) => void) {
  const spawn = childProcess.spawn
  let child: ChildProcessWithoutNullStreams | undefined
  t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof spawn>) => {
    child = Reflect.apply(spawn, childProcess, args) as ChildProcessWithoutNullStreams
    return child
  })
  syncBuiltinESMExports()
  const failures: Error[] = []
  const options = {
    python: process.execPath, pythonPath: [],
    moduleArgs: ['-e', `${ready ? `console.log(${JSON.stringify(JSON.stringify({ event: 'ready', protocol: PROTOCOL_VERSION, python: 'fixture' }))});` : ''}setInterval(() => {}, 1000);`],
    onHostRequest: () => {},
    onTerminationFailure: (error: Error) => { failures.push(error); onFailure?.(error) },
  }
  const kernel = new PythonKernel(options, 1)
  const started = kernel.start(ready ? 5000 : 25)
  // Observe immediately: the handshake may reject before the test awaits it.
  void started.catch(() => {})
  assert.ok(child)
  const proc = child
  const kill = proc.kill.bind(proc)
  t.after(async () => {
    t.mock.restoreAll()
    syncBuiltinESMExports()
    if (kernel.exitInfo === undefined) kill('SIGKILL')
    assert.notEqual(await within(kernel.exited), HUNG, 'fixture cleanup must really reap its child')
  })
  if (ready) await started
  return { kernel, proc, started, failures }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    throw error
  }
}

for (const mode of ['false', 'throw', 'error', 'sync-error', 'accepted-no-exit'] as const) {
  it(`terminate rejects within a host deadline when kill ${mode}, without inventing exit`, async (t) => {
    const { kernel, proc, failures } = await fixture(t)
    let signals = 0
    t.mock.method(proc, 'kill', () => {
      signals += 1
      if (mode === 'throw') throw new Error('injected kill exception')
      if (mode === 'error') queueMicrotask(() => proc.emit('error', new Error('injected kill error event')))
      if (mode === 'sync-error') proc.emit('error', new Error('injected synchronous kill error event'))
      if (mode === 'accepted-no-exit') Reflect.set(proc, 'killed', true)
      return mode !== 'false'
    })
    const pending = kernel.execute('pending', 'never answers')
    const work = kernel.terminate(`injected ${mode}`).then(() => 'resolved', (error: Error) => error)
    assert.equal(kernel.ready, false, 'authority is removed before any await')
    if (mode === 'false' || mode === 'throw' || mode === 'sync-error') assert.equal(failures.length, 1, 'owner sees synchronous signal failure')
    const result = await within(work)
    assert.notEqual(result, HUNG, 'a failed kill cannot leave the host waiting for exit forever')
    assert.ok(result instanceof Error, 'a live child is not a successful termination')
    assert.match(result.message, /terminat.*fail|failed.*terminat/i)
    assert.match(result.message, new RegExp(`pid[= ]${proc.pid}`))
    assert.equal(signals, 1, 'one signal attempt per retirement, not a busy retry loop')
    assert.equal(kernel.exitInfo, undefined)
    assert.equal(kernel.pidSnapshot, proc.pid)
    assert.ok(alive(proc.pid!))
    assert.equal(kernel.alive, true, 'killed flag does not prove the real pid is gone')
    assert.equal((await pending).status, 'kernel-exit')
    assert.equal(failures.length, 1)
    assert.equal(kernel.terminationFailure, result)
    assert.equal(await within(kernel.exited, 20), HUNG, 'exited is still tied to the real exit event')
    t.mock.restoreAll()
    syncBuiltinESMExports()
    await kernel.dispose(10)
    assert.equal(alive(proc.pid!), false, 'later disposal retries the retained child')
    assert.deepEqual(kernel.exitInfo, { code: null, signal: 'SIGKILL' })
  })
}

it('dispose rejects a false kill and a later dispose really retries', async (t) => {
  const { kernel, proc } = await fixture(t)
  t.mock.method(proc, 'kill', () => false)
  const result = await within(kernel.dispose(10).then(() => 'resolved', (error: Error) => error))
  assert.notEqual(result, HUNG)
  assert.ok(result instanceof Error)
  assert.equal(kernel.exitInfo, undefined)
  assert.ok(alive(proc.pid!))
  t.mock.restoreAll()
  syncBuiltinESMExports()
  await kernel.dispose(10)
  assert.equal(alive(proc.pid!), false)
})

it('dispose catches a kill exception inside its grace timer instead of escaping the host', async (t) => {
  const { kernel, proc, failures } = await fixture(t)
  t.mock.method(proc, 'kill', () => { throw new Error('injected dispose timer exception') })
  const result = await within(kernel.dispose(10).then(() => 'resolved', (error: Error) => error))
  assert.notEqual(result, HUNG)
  assert.ok(result instanceof Error)
  assert.equal(failures.length, 1)
  assert.equal(kernel.exitInfo, undefined)
  assert.ok(alive(proc.pid!))
})

it('a failed handshake reports both startup and kill failure with its real pid retained', async (t) => {
  const { kernel, proc, started } = await fixture(t, false)
  t.mock.method(proc, 'kill', () => false)
  const result = await within(started.then(() => 'resolved', (error: Error) => error))
  assert.notEqual(result, HUNG)
  assert.ok(result instanceof Error)
  assert.match(result.message, /handshake timed out/)
  assert.match(result.message, /terminat.*fail|failed.*terminat/i)
  assert.equal(kernel.exitInfo, undefined)
  assert.equal(kernel.pidSnapshot, proc.pid)
})

it('cancelling startup does not automatically replay a failed signal during handshake unwind', async (t) => {
  const { kernel, proc, started } = await fixture(t, false)
  let signals = 0
  t.mock.method(proc, 'kill', () => { signals += 1; return false })
  await assert.rejects(kernel.terminate('startup cancelled'), /kill returned false/)
  await assert.rejects(started, /startup cancelled.*termination failed/)
  assert.equal(signals, 1)
  assert.equal(kernel.exitInfo, undefined)
  assert.ok(alive(proc.pid!))
})

it('corrupt-frame retirement observes kill rejection and synchronously reports it to the owner', async (t) => {
  const { kernel, proc, failures } = await fixture(t)
  t.mock.method(proc, 'kill', () => { throw new Error('injected corrupt-frame kill exception') })
  const pending = kernel.execute('pending', '')
  proc.stdout.emit('data', 'not-json\n')
  assert.equal(kernel.ready, false)
  assert.equal(failures.length, 1)
  assert.equal((await pending).status, 'kernel-exit')
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(kernel.exitInfo, undefined)
  assert.ok(alive(proc.pid!))
})

it('invalid termination budgets reject without sending signals or leaking exit observers', async (t) => {
  const { kernel, proc } = await fixture(t)
  let signals = 0
  t.mock.method(proc, 'kill', () => { signals += 1; return true })
  const listeners = proc.listenerCount('exit')
  for (const budget of [NaN, Infinity, -1, 0.5, 2_147_483_648]) {
    await assert.rejects(kernel.terminate('invalid budget', budget), /timeoutMs must be a safe integer/)
    assert.equal(proc.listenerCount('exit'), listeners)
  }
  assert.equal(signals, 0)
  assert.equal(kernel.exitInfo, undefined)
})

it('concurrent termination callers join one signal and one deadline', async (t) => {
  const { kernel, proc } = await fixture(t)
  let signals = 0
  t.mock.method(proc, 'kill', () => { signals += 1; return true })
  const listeners = proc.listenerCount('exit')
  const first = kernel.terminate('one', 30)
  const second = kernel.terminate('two', 30)
  assert.equal(first, second)
  const results = await Promise.allSettled([first, second])
  assert.equal(signals, 1)
  assert.equal(proc.listenerCount('exit'), listeners, 'deadline clears its real-exit observer')
  assert.equal(results[0]?.status, 'rejected')
  assert.equal(results[1]?.status, 'rejected')
})

it('an owner failure callback cannot escape or replace the termination diagnosis', async (t) => {
  const { kernel, proc } = await fixture(t, true, () => { throw new Error('owner callback failed') })
  t.mock.method(proc, 'kill', () => false)
  await assert.rejects(kernel.terminate('owner failure'), /kill returned false.*Owner notification failed: owner callback failed/)
  assert.equal(kernel.exitInfo, undefined)
})

it('normal SIGKILL and repeated disposal observe a real OS exit', async (t) => {
  const { kernel, proc } = await fixture(t)
  await kernel.terminate('normal control')
  await kernel.exited
  assert.equal(alive(proc.pid!), false)
  assert.deepEqual(kernel.exitInfo, { code: null, signal: 'SIGKILL' })
  await Promise.all([kernel.dispose(10), kernel.dispose(10)])
})
