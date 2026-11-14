/**
 * The kernel tab's start/stop/restart/reset buttons on a real kernel with
 * real snapshots, plus the control route's request boundary.
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { createServer, request as httpRequest } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
function newSession(): { session: ReplSession; state: string } {
  const state = join(scratch, `s${++counter}`)
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
