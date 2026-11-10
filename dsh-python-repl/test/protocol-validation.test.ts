import { strict as assert } from 'node:assert'
import { it } from 'node:test'
import { PythonKernel } from '../src/kernel.ts'
import { parseEvent } from '../src/protocol.ts'
const python = process.env['DSH_PY'] ?? 'python3'
const invalid = [
  { event: 'stdout', id: null }, { event: 'stdout', id: 'x', text: 42 },
  { event: 'done' }, { event: 'done', id: 'x', status: 'unknown' },
  { event: 'mispelled' }, { event: 'ready', protocol: 3 },
  { event: 'result', id: null, text: 'x' }, { event: 'display', id: null, data: [] },
  { event: 'host_request', id: 'x' }, { event: 'error', id: 'x', ename: 42, evalue: 'x' },
  { event: 'error', id: 'x', ename: 'E', evalue: 'x', traceback: [1] },
  { event: 'error', id: 'x', ename: 'E', evalue: 'x', traceback: 'not a list' },
  { event: 'stdout', id: 7, text: 'x' }, { event: 'ready', protocol: '3', python: '3.14' },
  { event: 'host_request', data: {} }, { event: 'display', id: null, data: null },
]
for (const frame of invalid) {
  it(`rejects malformed JSON frame ${JSON.stringify(frame)}`, () => {
    const line = JSON.stringify(frame)
    assert.equal(parseEvent(line), undefined)
  })
}
it('accepts all documented events and preserves additional business fields', () => {
  const frames = [{ event: 'ready', protocol: 3, python: 'fixture' },
    { event: 'stdout', id: null, text: 'x' }, { event: 'stderr', id: 'x', text: '' },
    { event: 'result', id: 'x', text: 'x' }, { event: 'display', id: null, data: { image: 'x' } },
    { event: 'host_request', id: 'x', data: [null, { business: 'unbounded shape' }] },
    { event: 'error', id: null, ename: 'E', evalue: 'x', traceback: ['line'] },
    { event: 'done', id: 'x', status: 'error', extra: { business: [1, 2] } }]
  for (const frame of frames) assert.deepEqual(parseEvent(JSON.stringify(frame)), frame)
})
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
function kernel(payload: string, options: Partial<ConstructorParameters<typeof PythonKernel>[0]> = {}) {
  const code = `import sys,time,json\nprint(json.dumps(dict(event='ready',protocol=3,python='fixture')),flush=True)\nsys.stdin.readline()\nsys.stdout.write(${JSON.stringify(payload)}); sys.stdout.flush()\ntime.sleep(3)\n`
  return new PythonKernel({ python, pythonPath: [], moduleArgs: ['-c', code], onHostRequest: () => {}, ...options }, 1)
}
async function bounded<T>(work: Promise<T>): Promise<T | 'hung'> {
  let timer: NodeJS.Timeout | undefined
  try { return await Promise.race([work, new Promise<'hung'>(r => { timer = setTimeout(() => r('hung'), 800) })]) }
  finally { clearTimeout(timer) }
}
for (const frame of [{ event: 'stdout', id: null }, { event: 'mispelled' }]) {
  it(`bad frame retires only its kernel: ${frame.event}`, { timeout: 6000 }, async () => {
    let reported = false
    const bad = kernel(`${JSON.stringify(frame)}\n`, { onCorruptFrame: () => { reported = true } })
    const good = kernel(JSON.stringify({ event: 'done', id: 'good', status: 'ok' }) + '\n')
    try {
      await Promise.all([bad.start(), good.start()])
      const pid = bad.pidSnapshot!
      const result = await bounded(bad.execute('x', '1'))
      assert.notEqual(result, 'hung')
      assert.equal((result as { status: string }).status, 'kernel-exit')
      await bad.exited
      assert.equal(reported, true)
      assert.equal(alive(pid), false)
      assert.equal(good.ready, true)
      assert.equal((await good.execute('good', '1')).status, 'ok', 'another kernel must still complete work')
    } finally { await Promise.all([bad.terminate('test cleanup'), good.terminate('test cleanup')]) }
  })
}
for (const newline of ['', '\n']) {
  it(`bounds an oversized ${newline ? 'complete' : 'unterminated'} frame before parsing`, { timeout: 6000 }, async () => {
    const reported: string[] = []
    const k = kernel('x'.repeat(2048) + newline, { maxFrameBytes: 1024, onCorruptFrame: (line) => { reported.push(line) } })
    try {
      await k.start()
      assert.notEqual(await bounded(k.execute('x', '1')), 'hung')
      await k.exited
      assert.match(reported.join('\n'), /1024.*bytes/)
      assert.equal(alive(k.pidSnapshot!), false)
    } finally { await k.terminate('test cleanup') }
  })
}
it('does not cap accumulated business output or batched small frames', { timeout: 6000 }, async () => {
  const frames = Array.from({ length: 100 }, () => JSON.stringify({ event: 'stdout', id: 'x', text: 'a'.repeat(400) }) + '\n').join('')
  const k = kernel(frames + JSON.stringify({ event: 'done', id: 'x', status: 'ok' }) + '\n', { maxFrameBytes: 1024 })
  try {
    await k.start()
    const result = await k.execute('x', '1')
    assert.equal(result.status, 'ok')
    assert.equal(result.logs.join('').length, 40000)
  } finally { await k.terminate('test cleanup') }
})
for (const kind of ['unattributed', 'host', 'settled', 'corrupt', 'exit'] as const) {
  it(`throwing ${kind} callback cannot escape or strand a pending cell`, { timeout: 6000 }, async () => {
    const fail = () => { throw new Error('callback failed') }
    const frames = { unattributed: { event: 'stdout', id: null, text: 'x' }, host: { event: 'host_request', id: 'x', data: null },
      settled: { event: 'done', id: 'x', status: 'ok' }, corrupt: { event: 'unknown' }, exit: { event: 'done', id: 'x', status: 'ok' } }
    const k = kernel(`${JSON.stringify(frames[kind])}\n`, {
      ...(kind === 'unattributed' ? { onUnattributedOutput: fail } : {}), ...(kind === 'host' ? { onHostRequest: fail } : {}),
      ...(kind === 'settled' ? { onCellSettled: fail } : {}), ...(kind === 'corrupt' ? { onCorruptFrame: fail } : {}),
      ...(kind === 'exit' ? { onExit: fail } : {}),
    })
    try {
      await k.start()
      const result = await bounded(k.execute('x', '1'))
      assert.notEqual(result, 'hung')
      if (kind === 'exit') await k.terminate('trigger exit callback')
      else {
        assert.equal((result as { status: string }).status, 'kernel-exit')
        await k.exited
      }
      assert.equal(alive(k.pidSnapshot!), false)
    } finally { await k.terminate('test cleanup') }
  })
}
