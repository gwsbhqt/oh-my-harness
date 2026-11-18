/**
 * The kernel tab's start/stop/restart/reset buttons on a real kernel with
 * real snapshots, plus the control route's request boundary.
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { createServer, request as httpRequest } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { ReplSession } from '../src/session.ts'
import { testKernelPython } from './fixtures/test-kernel.ts'
import { controlRoute } from '../src/panel-route.ts'
import { snapshotFiles } from '../src/snapshot.ts'
import type { BoundTool } from '../src/lease.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let venvPython = ''
before(async () => {
  venvPython = await testKernelPython()
})
const scratch = mkdtempSync(join(tmpdir(), 'dsh-use-'))
const sessions: ReplSession[] = []
let counter = 0
function newSession(state = join(scratch, `s${++counter}`)): { session: ReplSession; state: string } {
  const session = new ReplSession({ python: venvPython, vendorRoot: join(root, 'vendor', 'prime'),
    pythonRoot: join(root, 'python'), cwd: scratch, startupTimeoutMs: 60_000, statePath: state })
  sessions.push(session)
  return { session, state }
}
const noTools = (): Map<string, BoundTool> => new Map()
const text = (r: { logs: string[] }): string => r.logs.join('\n')
after(async () => {
  await Promise.all(sessions.map((s) => s.dispose()))
  rmSync(scratch, { recursive: true, force: true })
})

function gatedSave(state: string): { code: string; attempts: string; release: string } {
  const attempts = join(state, 'saves')
  const release = join(state, 'release')
  const code = [
    'class Sample:',
    '    def __reduce__(self):',
    '        import time',
    `        with open(${JSON.stringify(attempts)}, "a") as record:`,
    '            record.write("save\\n")',
    `        while not Path(${JSON.stringify(release)}).exists():`,
    '            try:',
    '                time.sleep(0.01)',
    '            except KeyboardInterrupt:',
    '                continue',
    '        return (int, (2,))',
    'progress = Sample()',
  ].join('\n')
  return { code, attempts, release }
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!existsSync(path)) {
    assert.ok(Date.now() < deadline, `expected the kernel to write ${path}`)
    await sleep(20)
  }
}

describe('kernel tab control', () => {
  it('starts a kernel before any cell, and the first cell still gets its tools', { timeout: 120_000 }, async () => {
    const { session } = newSession()
    assert.equal((await session.panelObservation()).started, false)
    const started = await session.panelControl('start')
    assert.deepEqual(started, { action: 'start', ok: true, epoch: 1 })
    const live = await session.panelObservation()
    assert.equal(live.alive, true)
    assert.equal(live.namespaceStatus, 'live')
    assert.equal((await session.panelControl('start')).reason, '内核已经在运行')
    const cell = await session.runCell('value = await tools.echo({})\nassert value == "pong"', new Map([['echo', async () => 'pong']]))
    assert.equal(cell.error, undefined, JSON.stringify(cell))
    assert.equal((await session.panelObservation()).epoch, 1, 'the cell reused the started kernel')
  })

  it('stop saves, the next cell restores and is told why; restart keeps variables', { timeout: 180_000 }, async () => {
    const { session } = newSession()
    assert.equal((await session.runCell('kept = 41\ndef bump():\n    return kept + 1', noTools())).error, undefined)
    const stopped = await session.panelControl('stop')
    assert.equal(stopped.ok, true)
    assert.equal((await session.panelObservation()).alive, false)
    assert.equal((await session.panelControl('stop')).reason, '内核没有在运行')
    const after1 = await session.runCell('assert bump() == 42', noTools())
    assert.equal(after1.error, undefined, JSON.stringify(after1))
    assert.match(text(after1), /stopped the Python kernel from the kernel tab/)
    assert.match(text(after1), /python-state-restored/)
    const restarted = await session.panelControl('restart')
    assert.equal(restarted.ok, true)
    assert.equal(restarted.epoch, 3)
    assert.equal((await session.panelObservation()).alive, true)
    const after2 = await session.runCell('assert bump() == 42', noTools())
    assert.equal(after2.error, undefined, JSON.stringify(after2))
    assert.match(text(after2), /restarted the Python kernel from the kernel tab/)
    const generations = session.cellLog.view().generations
    assert.deepEqual(generations.map((g) => g.reason), ['在内核页手动关闭', '在内核页手动重启', null])
  })

  it('reset drops the namespace and the snapshot, and an old debounced save cannot bring it back', { timeout: 180_000 }, async () => {
    const { session, state } = newSession()
    assert.equal((await session.runCell('secret = 7', noTools())).error, undefined)
    await sleep(2_000)
    assert.ok(existsSync(snapshotFiles(state).path), 'the debounced snapshot was written')
    assert.equal((await session.runCell('secret = 8', noTools())).error, undefined)
    const reset = await session.panelControl('reset')
    assert.equal(reset.ok, true)
    assert.equal(existsSync(snapshotFiles(state).path), false)
    await sleep(2_000)
    const cell = await session.runCell('assert "secret" not in globals()', noTools())
    assert.equal(cell.error, undefined, JSON.stringify(cell))
    assert.match(text(cell), /reset the Python kernel/)
    assert.doesNotMatch(text(cell), /python-state-restored/)
  })

  it('a failed write keeps both buttons on the live kernel, and an explicit reset still clears it', { timeout: 120_000 }, async () => {
    const { session, state } = newSession()
    assert.equal((await session.runCell('progress = 2', noTools())).error, undefined)
    const target = snapshotFiles(state).path
    mkdirSync(target) // A directory at the payload destination makes the real rename fail.
    const epoch = session.epoch
    for (const action of ['stop', 'restart'] as const) {
      const result = await session.panelControl(action)
      assert.equal(result.ok, false, JSON.stringify(result))
      assert.equal(result.epoch, epoch)
      assert.match(result.reason!, /已保留当前内核.*write failed/)
      assert.equal((await session.runCell('assert progress == 2', noTools())).error, undefined)
      assert.equal(session.cellLog.view().generations.at(-1)?.reason, null)
    }
    rmdirSync(target)
    const reset = await session.panelControl('reset')
    assert.equal(reset.ok, true)
    assert.equal(reset.epoch, epoch + 1)
    assert.equal(existsSync(target), false)
    assert.equal((await session.runCell('assert "progress" not in globals()', noTools())).error, undefined)
  })

  it('a click takes the current state even when a task changed it after a confirmed automatic save', { timeout: 120_000 }, async () => {
    const { session, state } = newSession()
    const release = join(state, 'advance')
    const updated = join(state, 'advanced')
    const setup = await session.runCell([
      'progress = 1', 'async def advance():', `    while not Path(${JSON.stringify(release)}).exists():`,
      '        await asyncio.sleep(0.01)', '    global progress', '    progress = 2', `    Path(${JSON.stringify(updated)}).touch()`,
      'asyncio.create_task(advance())', 'None',
    ].join('\n'), noTools())
    assert.equal(setup.error, undefined, JSON.stringify(setup))
    await waitForFile(snapshotFiles(state).manifestPath)
    writeFileSync(release, '')
    await waitForFile(updated)
    assert.equal((await session.panelControl('restart')).ok, true)
    const readback = await session.runCell('assert progress == 2', noTools())
    assert.equal(readback.error, undefined, JSON.stringify(readback))
  })

  it('a click during an automatic save shares its result, and a queued cell uses the resulting kernel', { timeout: 120_000 }, async () => {
    const { session, state } = newSession()
    const { code, attempts, release } = gatedSave(state)
    const setup = await session.runCell(code, noTools())
    assert.equal(setup.error, undefined, JSON.stringify(setup))
    await waitForFile(attempts)
    const epoch = session.epoch
    const restarting = session.panelControl('restart')
    const duplicate = await session.panelControl('stop')
    assert.equal(duplicate.ok, false)
    assert.match(duplicate.reason!, /上一个操作/)
    const next = session.runCell('assert progress == 2', noTools())
    writeFileSync(release, '')
    assert.deepEqual(await restarting, { action: 'restart', ok: true, epoch: epoch + 1 })
    assert.equal((await next).error, undefined)
    assert.equal(readFileSync(attempts, 'utf8'), 'save\n')
  })

  it('closing the session during a restart shares the save and leaves the kernel stopped', { timeout: 120_000 }, async () => {
    const { session, state } = newSession()
    const { code, attempts, release } = gatedSave(state)
    const restarting = session.runCell(`${code}\nawait repl.restart()`, noTools())
    await waitForFile(attempts)
    const epoch = session.epoch
    const closing = session.dispose()
    writeFileSync(release, '')
    const [restart] = await Promise.all([restarting, closing])
    assert.match(restart.error?.message ?? '', /session disposed/)
    assert.doesNotMatch(text(restart), /Kernel restarted as requested/)
    assert.equal(session.kernelAlive, false)
    assert.equal(session.epoch, epoch)
    assert.equal(readFileSync(attempts, 'utf8'), 'save\n')
    assert.ok(existsSync(snapshotFiles(state).path))
  })

  it('cancelling while a restart saves leaves the next cell on the same kernel', { timeout: 120_000 }, async () => {
    const { session, state } = newSession()
    const { code, attempts, release } = gatedSave(state)
    const controller = new AbortController()
    const restarting = session.runCell(`${code}\nawait repl.restart()`, noTools(), controller.signal)
    await waitForFile(attempts)
    const epoch = session.epoch
    controller.abort()
    try {
      assert.equal((await restarting).error?.kind, 'abort')
      assert.equal(session.kernelAlive, true)
      const next = session.runCell('assert isinstance(progress, Sample)\nprogress = 2', noTools())
      writeFileSync(release, '')
      assert.equal((await next).error, undefined)
      assert.equal(session.epoch, epoch)
      assert.equal(readFileSync(attempts, 'utf8'), 'save\n')
    } finally { writeFileSync(release, '') }
  })

  it('a save that finishes after its deadline neither retries the serializer nor discards a queued change', { timeout: 120_000 }, async () => {
    const { session, state } = newSession()
    const { code, attempts, release } = gatedSave(state)
    assert.equal((await session.runCell(code, noTools())).error, undefined)
    const epoch = session.epoch
    const first = session.panelControl('restart')
    try {
      await waitForFile(attempts)
      const timedOut = await first
      assert.equal(timedOut.ok, false)
      assert.match(timedOut.reason!, /超时/)
      const again = await session.panelControl('stop')
      assert.equal(again.ok, false)
      assert.match(again.reason!, /超时/)
      const next = session.runCell('progress = 3', noTools())
      writeFileSync(release, '')
      assert.equal((await next).error, undefined)
      assert.equal(session.epoch, epoch)
      await session.dispose()
      assert.equal(readFileSync(attempts, 'utf8'), 'save\n')
      const readback = await newSession(state).session.runCell('assert progress == 3', noTools())
      assert.equal(readback.error, undefined, JSON.stringify(readback))
    } finally { writeFileSync(release, '') }
  })

  it('a successful manual restart names anything the snapshot skipped', { timeout: 120_000 }, async () => {
    const { session } = newSession()
    assert.equal((await session.runCell('progress = 2\nstream = (i for i in range(3))', noTools())).error, undefined)
    const restarted = await session.panelControl('restart')
    assert.equal(restarted.ok, true)
    assert.match(restarted.reason!, /未能保存.*stream/)
    const readback = await session.runCell('assert progress == 2 and "stream" not in globals()', noTools())
    assert.equal(readback.error, undefined)
    assert.match(text(readback), /never saved.*stream/)
  })

  it('is refused while a cell runs and never interrupts it', { timeout: 120_000 }, async () => {
    const { session } = newSession()
    const running = session.runCell('import time\ntime.sleep(0.8)\nfinished = True', noTools())
    await sleep(100)
    for (const action of ['stop', 'restart', 'reset', 'start'] as const) {
      const refused = await session.panelControl(action)
      assert.equal(refused.ok, false, action)
      assert.match(refused.reason!, /正在执行/)
    }
    assert.equal((await running).error, undefined)
    assert.equal((await session.runCell('assert finished', noTools())).error, undefined)
  })
})

describe('control route', () => {
  it('accepts same-origin POST and the desktop proxy Origin-less POST, with a known action', async () => {
    const calls: string[] = []
    const route = controlRoute(async (session, action) => { calls.push(`${session}:${action}`); return { action, ok: true, epoch: 1 } })
    const server = createServer((req, res) => route.handler(req, res))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const send = (method: string, path: string, headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode!)) })
      req.on('error', reject); req.end()
    })
    const self = `http://127.0.0.1:${port}`
    try {
      assert.equal(await send('POST', '/dsh-python-repl/control?session=s&action=stop', { origin: self, 'sec-fetch-site': 'same-origin' }), 200)
      assert.equal(await send('GET', '/dsh-python-repl/control?session=s&action=stop', { origin: self }), 403)
      // 桌面端外壳经自己的代理转发页面请求，转发前删掉 Origin/Host/Sec-Fetch-Site；
      // 这种缺 Origin 的 POST 是可信的本页操作，必须放行，否则启动/重置按钮一律 403。
      assert.equal(await send('POST', '/dsh-python-repl/control?session=s&action=stop', {}), 200, 'desktop proxy drops Origin')
      assert.equal(await send('POST', '/dsh-python-repl/control?session=s&action=stop', { origin: 'http://evil.example' }), 403)
      assert.equal(await send('POST', '/dsh-python-repl/control?session=s&action=stop', { origin: self, 'sec-fetch-site': 'cross-site' }), 403)
      assert.equal(await send('POST', '/dsh-python-repl/control?session=s&action=exec', { origin: self }), 400)
      assert.deepEqual(calls, ['s:stop', 's:stop'])
    } finally { server.close() }
  })
})
