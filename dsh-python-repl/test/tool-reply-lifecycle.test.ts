import { strict as assert } from 'node:assert'
import { it } from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { ReplSession, type SessionOptions } from '../src/session.ts'
import { PythonKernel } from '../src/kernel.ts'
import type { BoundTool } from '../src/lease.ts'
const pidOf = (r: { logs: string[] }): number => Number(r.logs.join('').trim())

const root = fileURLToPath(new URL('..', import.meta.url))
function session(options: Partial<SessionOptions> = {}): ReplSession {
  return new ReplSession({
    python: process.env['DSH_PY'] ?? 'python3',
    vendorRoot: `${root}/vendor/prime`, pythonRoot: `${root}/python`,
    ...options,
  })
}
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

for (const timeout of [undefined, 0]) {
  it(`does not arm a reply timer with timeout ${timeout}`, { timeout: 10_000 }, async (t) => {
    const repl = session(timeout === undefined ? {} : { toolCallTimeoutMs: timeout })
    t.after(() => repl.dispose())
    await repl.runCell('0', new Map())
    const started = deferred<void>()
    const answer = deferred<unknown>()
    const tools = new Map<string, BoundTool>([['wait', () => { started.resolve(); return answer.promise }]])
    const timers = t.mock.method(globalThis, 'setTimeout')
    const running = repl.runCell('await tools.wait({})', tools)
    await started.promise
    assert.equal(timers.mock.callCount(), 0, 'DSH owns human wait duration')
    answer.resolve({ answer: 'human answered' })
    assert.equal((await running).error, undefined)
  })
}

it('clears the configured timer on successful delivery', { timeout: 10_000 }, async (t) => {
  const repl = session({ toolCallTimeoutMs: 60_000 })
  t.after(() => repl.dispose())
  await repl.runCell('0', new Map())
  const timers = t.mock.method(globalThis, 'setTimeout')
  const cleared = t.mock.method(globalThis, 'clearTimeout')
  const result = await repl.runCell('await tools.fast({})', new Map<string, BoundTool>([
    ['fast', async () => ({ ok: true })],
  ]))
  assert.equal(result.error, undefined)
  const replyTimer = timers.mock.calls.find((call) => call.arguments[1] === 60_000)?.result
  assert.ok(replyTimer)
  assert.ok(cleared.mock.calls.some((call) => call.arguments[0] === replyTimer))
})

for (const lateFailure of [false, true]) {
  it(`times out exactly once and ignores late ${lateFailure ? 'rejection' : 'success'}`, { timeout: 10_000 }, async (t) => {
    const repl = session({ toolCallTimeoutMs: 30 })
    t.after(() => repl.dispose())
    const replies = t.mock.method(PythonKernel.prototype, 'reply')
    const answer = deferred<unknown>()
    let calls = 0
    const tools = new Map<string, BoundTool>([['wait', () => { calls++; return answer.promise }]])
    const result = await repl.runCell('await tools.wait({})', tools)
    assert.match(result.error?.message ?? '', /outcome is unknown/)
    assert.match(result.error?.message ?? '', /may still run/)
    assert.match(result.error?.message ?? '', /does not cancel/)
    assert.match(result.error?.message ?? '', /No automatic retry/)
    assert.equal(replies.mock.callCount(), 1)
    if (lateFailure) answer.reject(new Error('late failure'))
    else answer.resolve({ effect: 'completed after timeout' })
    await nextTurn()
    assert.equal(replies.mock.callCount(), 1)
    assert.equal(calls, 1)
    assert.equal((await repl.runCell('42', tools)).error, undefined)
  })
}

it('delivers synchronous throws, rejection and unserializable replies as errors without hanging', { timeout: 15_000 }, async (t) => {
  const repl = session()
  t.after(() => repl.dispose())
  const cycle: Record<string, unknown> = {}
  cycle['self'] = cycle
  const cases: Array<[BoundTool, RegExp]> = [
    [() => { throw new Error('sync failure') }, /sync failure/],
    [async () => { throw new Error('async failure') }, /async failure/],
    [async () => cycle, /reply could not be delivered/],
    [async () => 1n, /reply could not be delivered/],
    [async () => ({ toJSON() { throw new Error('toJSON failed') } }), /toJSON failed/],
    [() => { throw Object.create(null) }, /unprintable tool error/],
  ]
  for (const [tool, expected] of cases) {
    const result = await repl.runCell('await tools.bad({})', new Map([['bad', tool]]))
    assert.match(result.error?.message ?? '', expected)
  }
  assert.equal((await repl.runCell('42', new Map())).error, undefined)
})

for (const revoke of ['abort', 'cell-end', 'dispose'] as const) {
  it(`clears outstanding reply bookkeeping on ${revoke}`, { timeout: 15_000 }, async (t) => {
    const repl = session({ toolCallTimeoutMs: 60_000 })
    t.after(() => repl.dispose())
    const replies = t.mock.method(PythonKernel.prototype, 'reply')
    const clearTimer = t.mock.method(globalThis, 'clearTimeout')
    const started = deferred<void>()
    const answer = deferred<unknown>()
    const tools = new Map<string, BoundTool>([['wait', () => { started.resolve(); return answer.promise }]])
    const controller = new AbortController()
    const running = repl.runCell(revoke === 'cell-end'
      ? 'import asyncio\ntask = asyncio.create_task(tools.wait({}))\nawait asyncio.sleep(0.03)'
      : 'await tools.wait({})', tools, controller.signal)
    await started.promise
    const before = clearTimer.mock.callCount()
    if (revoke === 'abort') controller.abort()
    if (revoke === 'dispose') await repl.dispose()
    await running
    assert.ok(clearTimer.mock.callCount() > before)
    answer.resolve('late effect')
    await nextTurn()
    assert.equal(replies.mock.callCount(), 0, 'revoked replies must never reach Python')
  })
}

it('awaits retirement after a corrupt frame before returning the cell', { timeout: 10_000 }, async (t) => {
  const repl = session()
  t.after(() => repl.dispose())
  const crashes: unknown[] = []
  const onCrash = (error: unknown): void => { crashes.push(error) }
  process.on('uncaughtException', onCrash)
  t.after(() => process.off('uncaughtException', onCrash))
  const pid = pidOf(await repl.runCell('import os; os.getpid()', new Map()))
  const result = await repl.runCell('import os, rlm.repl as _kernel\nos.write(_kernel._protocol_fd, b"not-json\\n")\nawait asyncio.sleep(60)', new Map())
  assert.deepEqual(crashes, [], 'nothing may escape the pipe listener')
  assert.equal(result.error?.kind, 'worker-exit')
  assert.equal(repl.kernelAlive, false)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  const next = await repl.runCell('1', new Map())
  assert.match(next.logs.join('\n'), /could not parse/, 'the next cell is told why the kernel was replaced')
})

it('preserves cancellation from a synchronous binding throw', { timeout: 10_000 }, async (t) => {
  const repl = session()
  t.after(() => repl.dispose())
  const result = await repl.runCell('await tools.stop({})', new Map<string, BoundTool>([
    ['stop', () => { throw new DOMException('cancelled', 'AbortError') }],
  ]))
  assert.match(result.error?.message ?? '', /CancelledError/)
  assert.doesNotMatch(result.error?.message ?? '', /ToolCallError/)
})
