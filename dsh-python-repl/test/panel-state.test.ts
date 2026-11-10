import { strict as assert } from 'node:assert'
import { it } from 'node:test'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { withFileSource } from '../src/panel-source.ts'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { mountAgents } from './fixtures/agents.ts'
import { Config, PythonReplRuntime } from '../src/index.ts'
import { ReplSession } from '../src/session.ts'
import { panelRoute, previewRoute } from '../src/panel-route.ts'
import { PythonKernel } from '../src/kernel.ts'
import { readPanelSnapshot, snapshotFiles } from '../src/snapshot.ts'
import type { PanelState } from '../src/panel-types.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

it('host reads regular source with byte/line/scan limits and rejects FIFO/device paths', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preview-source-'))
  const read = (filename: string, line: number, sourceEndLine: number) => withFileSource({ status: 'ok', kind: 'metadata', filename, line, sourceEndLine })
  try {
    const early = join(dir, 'early.py')
    await writeFile(early, 'def selected(x):\n    return x + 1\n' + '# filler\n'.repeat(250000))
    const result = await read(early, 1, 2)
    assert.equal(result.kind, 'source')
    assert.equal(result.source, 'def selected(x):\n    return x + 1\n')
    assert.equal(result.truncated, false)
    const late = join(dir, 'late.py')
    await writeFile(late, '#'.repeat(1024 * 1024 + 10) + '\ndef late(): return 1\n')
    const beyond = await read(late, 2, 2)
    assert.equal(beyond.kind, 'metadata')
    assert.match(beyond.reason!, /1 MiB/)
    const wide = join(dir, 'wide.py')
    await writeFile(wide, '🐈中文'.repeat(30000))
    const bounded = await read(wide, 1, 1)
    assert.equal(bounded.kind, 'source')
    assert.equal(bounded.truncated, true)
    assert.ok(Buffer.byteLength(bounded.source!, 'utf8') <= 24 * 1024)
    assert.doesNotMatch(bounded.source!, /�/)
    const many = join(dir, 'many.py')
    await writeFile(many, 'x = 1\n'.repeat(300))
    const lines = await read(many, 1, 300)
    assert.equal(lines.source!.split('\n').length - 1, 200)
    assert.equal(lines.truncated, true)
    const fifo = join(dir, 'source.fifo')
    execFileSync('mkfifo', [fifo])
    const started = performance.now()
    assert.match((await read(fifo, 1, 2)).reason!, /普通文件/)
    assert.ok(performance.now() - started < 200)
    assert.match((await read('/dev/null', 1, 2)).reason!, /普通文件/)
    assert.equal((await read(join(dir, 'missing.py'), 1, 2)).kind, 'metadata')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('real imported Python functions use bounded host source; HTTP abort and source timeout retain the slot until close', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preview-import-'))
  const modulePath = join(dir, 'preview_import_fixture.py')
  await writeFile(modulePath, 'def imported_selected(x):\n    return x + 11\n\ndef other():\n    return "EXCLUDED"\n')
  const session = new ReplSession({ python: process.env['DSH_PY'] ?? 'python3',
    vendorRoot: join(root, 'vendor/prime'), pythonRoot: join(root, 'python'), cwd: dir, startupTimeoutMs: 60_000 })
  const probe = await open(modulePath, 'r')
  const prototype = Object.getPrototypeOf(probe)
  const originalRead = prototype.read
  await probe.close()
  let server: ReturnType<typeof createServer> | undefined
  try {
    assert.equal((await session.runCell('from preview_import_fixture import imported_selected', new Map())).error, undefined)
    const epoch = (await session.panelObservation()).epoch
    const imported = await session.panelPreview('imported_selected', epoch)
    assert.equal(imported.kind, 'source', JSON.stringify(imported))
    assert.match(imported.source!, /return x \+ 11/)
    assert.doesNotMatch(imported.source!, /EXCLUDED|def other/)
    let slowReads = 0
    let closed = 0
    prototype.read = async function (...args: unknown[]) {
      slowReads++
      const close = this.close
      this.close = async function (...closeArgs: unknown[]) { closed++; return close.apply(this, closeArgs) }
      await sleep(700)
      return originalRead.apply(this, args)
    }
    try {
      const timeout = await session.panelPreview('imported_selected', epoch)
      assert.equal(timeout.status, 'timeout')
      for (let i = 0; i < 10; i++) assert.equal((await session.panelPreview('imported_selected', epoch)).status, 'busy')
      assert.equal(slowReads, 1)
      assert.equal(closed, 0)
      await sleep(300)
      assert.equal(closed, 1)
      const route = previewRoute(async ({ name, epoch: requestedEpoch }) => ({ session: 's', ...await session.panelPreview(name, requestedEpoch) }))
      server = createServer(route.handler)
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      assert.ok(address && typeof address !== 'string')
      const controller = new AbortController()
      const request = fetch(`http://127.0.0.1:${address.port}${route.path}?session=s&name=imported_selected&epoch=${epoch}`, { signal: controller.signal })
      await sleep(50)
      controller.abort()
      await assert.rejects(request, /abort/i)
      assert.equal((await session.panelPreview('imported_selected', epoch)).status, 'busy')
      await sleep(750)
      assert.equal(closed, 2)
    } finally { prototype.read = originalRead }
    assert.equal((await session.runCell('assert imported_selected(1) == 12', new Map())).error, undefined)
    assert.equal((await session.panelPreview('imported_selected', epoch)).kind, 'source')
  } finally {
    if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()))
    prototype.read = originalRead
    await session.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})


it('preview HTTP boundary only accepts exact names, epochs and same-origin GET requests', async () => {
  let calls = 0
  const route = previewRoute(async ({ session, name, epoch }) => {
    calls++
    return { session, name, epoch, status: 'ok', kind: 'json', value: name === 'oversized' ? '🐈'.repeat(20000) : 123 }
  })
  const server = createServer(route.handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}${route.path}`
  const query = '?session=test&name=target&epoch=1'
  try {
    for (const site of ['cross-site', 'same-site']) {
      assert.equal((await fetch(url + query, { headers: { 'sec-fetch-site': site } })).status, 403)
    }
    assert.equal((await fetch(url + query, { headers: { origin: 'https://foreign.invalid' } })).status, 403)
    assert.equal((await fetch(url + query, { method: 'POST' })).status, 403)
    for (const name of ['target.x', 'target[0]', 'target()', 'a'.repeat(257)]) {
      assert.equal((await fetch(`${url}?session=s&epoch=1&name=${encodeURIComponent(name)}`)).status, 400)
    }
    for (const epoch of ['', '-1', '1.5', 'NaN', '9007199254740992']) {
      assert.equal((await fetch(`${url}?session=s&name=target&epoch=${epoch}`)).status, 400)
    }
    assert.equal(calls, 0)
    const response = await fetch(url + query)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), { session: 'test', name: 'target', epoch: 1, status: 'ok', kind: 'json', value: 123 })
    assert.equal(calls, 1)
    const oversized = await fetch(`${url}?session=s&name=oversized&epoch=1`)
    const bounded = await oversized.text()
    assert.ok(Buffer.byteLength(bounded, 'utf8') <= 64 * 1024)
    assert.equal(JSON.parse(bounded).status, 'error')
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
})

it('click preview observes real values and single-function source without tools, and remains usable after timeout', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-preview-live-'))
  const session = new ReplSession({ python: process.env['DSH_PY'] ?? 'python3',
    vendorRoot: join(root, 'vendor/prime'), pythonRoot: join(root, 'python'), cwd: dir, startupTimeoutMs: 60_000 })
  const original = PythonKernel.prototype.previewName
  let requests = 0
  PythonKernel.prototype.previewName = function (...args) { requests++; return original.apply(this, args) }
  try {
    assert.equal((await session.panelPreview('target', 0)).status, 'not-started')
    assert.equal(session.kernelAlive, false)
    const setup = await session.runCell(`
calls = []
class Meta(type):
    def __getattribute__(self, key):
        calls.append(key)
        raise AssertionError(key)
class Hostile(list, metaclass=Meta):
    def __getattribute__(self, key):
        calls.append(key)
        raise AssertionError(key)
    def __repr__(self):
        calls.append('repr')
        raise AssertionError('repr')
    def __len__(self):
        calls.append('len')
        raise AssertionError('len')
    def __iter__(self):
        calls.append('iter')
        raise AssertionError('iter')
    @property
    def __dict__(self):
        calls.append('descriptor')
        raise AssertionError('descriptor')
hostile = Hostile()
target = [1, 2, 3]
huge = ['🐈中文' * 100000] * 100000
bigint = 1 << 100000
cycle = []
cycle.append(cycle)
def selected(x):
    return x + 1

def unrelated():
    return 'DO_NOT_INCLUDE'
imported_function = len
`, new Map())
    assert.equal(setup.error, undefined, JSON.stringify(setup))
    const epoch = (await session.panelObservation()).epoch
    const baselineCalls = (await session.panelPreview('calls', epoch)).value
    assert.equal((await session.panelPreview('target', epoch - 1)).status, 'stale')
    assert.equal((await session.panelPreview('absent', epoch)).status, 'missing')
    assert.equal((await session.panelPreview('target[0]', epoch)).status, 'error')
    assert.deepEqual((await session.panelPreview('target', epoch)).value, [1, 2, 3])
    const source = await session.panelPreview('selected', epoch)
    assert.equal(source.kind, 'source', JSON.stringify(source))
    assert.match(source.source!, /return x \+ 1/)
    assert.doesNotMatch(source.source!, /DO_NOT_INCLUDE|unrelated/)
    for (const name of ['huge', 'bigint', 'cycle', 'hostile', 'Hostile', 'imported_function']) {
      const preview = await session.panelPreview(name, epoch)
      assert.equal(preview.status, 'ok', JSON.stringify(preview))
      assert.ok(Buffer.byteLength(JSON.stringify(preview), 'utf8') <= 64 * 1024)
    }
    assert.deepEqual((await session.panelPreview('calls', epoch)).value, baselineCalls)
    const running = session.runCell('import time; time.sleep(0.6); finished = True', new Map())
    const start = performance.now()
    assert.equal((await session.panelPreview('target', epoch)).status, 'busy')
    assert.ok(performance.now() - start < 200)
    assert.equal((await running).error, undefined)
    const block = await session.runCell('async def obstruct_preview():\n    await asyncio.sleep(0.15)\n    time.sleep(1.3)\n    globals()["background_finished"] = True\nobstruction_preview = asyncio.create_task(obstruct_preview())', new Map())
    assert.equal(block.error, undefined)
    await sleep(250)
    const before = requests
    const timeoutStart = performance.now()
    const timedOut = await session.panelPreview('target', epoch)
    assert.equal(timedOut.status, 'timeout', JSON.stringify(timedOut))
    assert.ok(performance.now() - timeoutStart < 600)
    for (let i = 0; i < 20; i++) assert.equal((await session.panelPreview('target', epoch)).status, 'busy')
    assert.equal(requests - before, 1)
    await sleep(1100)
    assert.equal((await session.runCell('assert background_finished and finished', new Map())).error, undefined)
    assert.deepEqual((await session.panelPreview('target', epoch)).value, [1, 2, 3])
    assert.equal((await session.runCell('await repl.restart()', new Map())).error, undefined)
    assert.equal((await session.panelPreview('target', epoch)).status, 'not-started')
    assert.equal((await session.runCell('after_restart = 1', new Map())).error, undefined)
    const newEpoch = (await session.panelObservation()).epoch
    assert.ok(newEpoch > epoch)
    assert.equal((await session.panelPreview('target', epoch)).status, 'stale')
    assert.equal((await session.panelPreview('after_restart', newEpoch)).value, 1)
  } finally {
    PythonKernel.prototype.previewName = original
    await session.dispose()
    await rm(dir, { recursive: true, force: true })
  }
})


it('GET boundary rejects foreign pages and writes before touching runtime state', async () => {
  let calls = 0
  const route = panelRoute(async (session) => { calls++; return { session } as PanelState })
  const server = createServer(route.handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address !== null && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}${route.path}`
  try {
    for (const site of ['cross-site', 'same-site']) {
      assert.equal((await fetch(`${url}?session=s`, { headers: { 'sec-fetch-site': site } })).status, 403)
    }
    assert.equal((await fetch(`${url}?session=s`, { method: 'POST' })).status, 403)
    assert.equal((await fetch(url)).status, 400)
    assert.equal((await fetch(`${url}?session=${'s'.repeat(4097)}`)).status, 400)
    assert.equal(calls, 0)
    for (const site of ['same-origin', 'none']) {
      const response = await fetch(`${url}?session=a%2Fb`, { headers: { 'sec-fetch-site': site } })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-store')
      assert.deepEqual(await response.json(), { session: 'a/b' })
    }
    assert.equal(calls, 2)
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())) }
})

it('disk snapshot errors remain distinct from missing, with actual payload stat and complete lists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-panel-disk-'))
  const files = snapshotFiles(dir)
  try {
    assert.equal((await readPanelSnapshot(dir)).status, 'missing')
    await writeFile(files.path, 'actual payload')
    const incomplete = await readPanelSnapshot(dir)
    assert.equal(incomplete.status, 'error')
    assert.equal(incomplete.bytes, (await stat(files.path)).size)
    assert.match(incomplete.error ?? '', /manifest/)
    await writeFile(files.manifestPath, '{bad json')
    assert.equal((await readPanelSnapshot(dir)).status, 'error')
    const savedNames = Array.from({ length: 1001 }, (_, i) => `item${i}`)
    const timestamp = new Date().toISOString()
    await writeFile(files.manifestPath, JSON.stringify({ version: 1, timestamp, savedNames,
      bytes: 999999, skipped: [{ name: 'socket', reason: 'not serializable' }], pruned: ['large'] }))
    const snapshot = await readPanelSnapshot(dir)
    assert.equal(snapshot.status, 'available')
    assert.equal(snapshot.savedAt, timestamp)
    assert.equal(snapshot.bytes, (await stat(files.path)).size)
    assert.deepEqual(snapshot.saved, savedNames)
    assert.deepEqual(snapshot.skipped, [{ name: 'socket', reason: 'not serializable' }])
    assert.deepEqual(snapshot.trimmed, ['large'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('unknown and unstarted sessions do not construct or launch a kernel', async () => {
  const ctx = new Context()
  await mountAgents(ctx)
  await ctx.plugin(PythonReplRuntime, Config({ python: '/nonexistent/panel-must-not-start-python', skillRoots: [] }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const runtime = ctx.get('ptcRuntime') as PythonReplRuntime
  try {
    const state = await runtime.panelState('panel-never-started')
    assert.equal((await runtime.panelPreview('panel-never-started', 'target', 0)).status, 'not-started')
    assert.equal(runtime.sessions.size, 0)
    assert.equal(state.started, false)
    assert.equal(state.alive, false)
    assert.equal(state.namespaceReason, 'not-started')
    const session = runtime.sessionFor('panel-existing-unstarted')
    assert.equal((await runtime.panelState('panel-existing-unstarted')).started, false)
    assert.equal(session.kernelAlive, false)
  } finally { await runtime.disposeAll() }
})

it('a kernel-produced snapshot stays readable after its runtime session is removed', { timeout: 120_000 }, async () => {
  const ctx = new Context()
  await mountAgents(ctx)
  await ctx.plugin(PythonReplRuntime, Config({ python: process.env['DSH_PY'] ?? 'python3', skillRoots: [] }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const runtime = ctx.get('ptcRuntime') as PythonReplRuntime
  const key = 'panel-real-persisted-snapshot'
  try {
    const interpreter = await runtime.interpreterFor(process.env['DSH_PY'] ?? 'python3')
    const result = await runtime.sessionFor(key, undefined, interpreter.python).runCell('persisted_panel_rows = [1, 2, 3]', new Map())
    assert.equal(result.error, undefined, JSON.stringify(result))
    await runtime.disposeAll()
    const state = await runtime.panelState(key)
    assert.equal(runtime.sessions.size, 0)
    assert.equal(state.started, false)
    assert.equal(state.alive, false)
    assert.equal(state.snapshot.status, 'available', JSON.stringify(state.snapshot))
    const dir = join(process.env['DSH_HOME']!, 'plugins/python-repl/state', createHash('sha256').update(key).digest('hex').slice(0, 32))
    const files = snapshotFiles(dir)
    const manifest = JSON.parse(await readFile(files.manifestPath, 'utf8')) as { timestamp: string; savedNames: string[]; skipped: Array<{ name: string; reason: string }>; pruned: string[] }
    assert.equal(state.snapshot.savedAt, manifest.timestamp)
    assert.equal(state.snapshot.bytes, (await stat(files.path)).size)
    assert.deepEqual(state.snapshot.saved, manifest.savedNames)
    assert.deepEqual(state.snapshot.skipped, manifest.skipped)
    assert.deepEqual(state.snapshot.trimmed, manifest.pruned)
    assert.ok(state.snapshot.saved.includes('persisted_panel_rows'))
  } finally { await runtime.disposeAll() }
})

it('real list_names is value-free and complete, busy reads return timestamped cache without interrupting code', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-panel-live-'))
  const session = new ReplSession({ python: process.env['DSH_PY'] ?? 'python3',
    vendorRoot: join(root, 'vendor/prime'), pythonRoot: join(root, 'python'), cwd: dir, startupTimeoutMs: 60_000 })
  try {
    const setup = await session.runCell(`
calls = []
class HostileMeta(type):
    def __getattribute__(self, name):
        calls.append(name)
        raise RuntimeError("metaclass hook")
class Hostile(list, metaclass=HostileMeta):
    def __repr__(self):
        calls.append("repr")
        raise RuntimeError("repr hook")
    def __len__(self):
        calls.append("len")
        raise RuntimeError("len hook")
    def __getattribute__(self, name):
        calls.append(name)
        raise RuntimeError("attribute hook")
hostile = Hostile()
secret_number = 918273645
secret_text = "PANEL_SECRET_SENTINEL"
rows = ["hidden", "contents"]
def helper(): return 1
_internal = None
for i in range(1001): globals()["many_%04d" % i] = i
import math as imported_math
from math import sqrt as imported_function
from collections import deque as imported_class
`, new Map())
    assert.equal(setup.error, undefined, JSON.stringify(setup))
    const live = await session.panelObservation()
    assert.equal(live.namespaceStatus, 'live', JSON.stringify(live))
    assert.equal(live.complete, true)
    assert.equal(live.names.length, live.total)
    assert.equal(live.names.filter((x) => x.name.startsWith('many_')).length, 1001)
    assert.equal(live.names.find((x) => x.name === 'secret_number')?.summary, 'int')
    assert.equal(live.names.find((x) => x.name === 'hostile')?.summary, 'Hostile')
    assert.equal(live.names.find((x) => x.name === 'rows')?.summary, 'list, len=2')
    assert.equal(live.names.find((x) => x.name === 'helper')?.kind, 'function')
    assert.equal(live.names.find((x) => x.name === 'imported_math')?.origin, 'import')
    assert.equal(live.names.find((x) => x.name === 'imported_function')?.origin, 'import')
    assert.equal(live.names.find((x) => x.name === 'imported_class')?.origin, 'import')
    const repeat = await session.panelObservation()
    assert.equal(repeat.names.find((x) => x.name === 'calls')?.summary, live.names.find((x) => x.name === 'calls')?.summary)
    assert.equal(live.names.find((x) => x.name === '_internal')?.origin, 'internal')
    assert.equal(live.names.find((x) => x.name === 'tools')?.origin, 'system')
    assert.equal(live.names.find((x) => x.name === 'json')?.origin, 'preloaded')
    assert.doesNotMatch(JSON.stringify(live), /918273645|PANEL_SECRET_SENTINEL|hidden|contents/)
    assert.ok(live.python && live.executable && live.cwd === await realpath(dir))
    const running = session.runCell('import time\ntime.sleep(0.6)\ncompleted = True', new Map())
    const started = performance.now()
    const busy = await session.panelObservation()
    assert.ok(performance.now() - started < 200)
    assert.equal(busy.busy, true)
    assert.equal(busy.namespaceStatus, 'cached')
    assert.equal(busy.namespaceReason, 'busy')
    assert.equal(busy.observedAt, repeat.observedAt)
    assert.deepEqual(busy.names, repeat.names)
    assert.equal((await running).error, undefined)
    const verify = await session.runCell('assert completed is True', new Map())
    assert.equal(verify.error, undefined, JSON.stringify(verify))
    assert.ok((await session.panelObservation()).names.some((x) => x.name === 'completed'))
    const block = await session.runCell('async def obstruct():\n    await asyncio.sleep(0.15)\n    time.sleep(0.9)\n    globals()["background_finished"] = True\nobstruction = asyncio.create_task(obstruct())', new Map())
    assert.equal(block.error, undefined)
    await sleep(250)
    const timeoutStarted = performance.now()
    const timedOut = await session.panelObservation()
    assert.ok(performance.now() - timeoutStarted < 600)
    assert.equal(timedOut.namespaceStatus, 'cached')
    assert.equal(timedOut.namespaceReason, 'timeout')
    await sleep(900)
    const afterTimeout = await session.runCell('assert background_finished is True', new Map())
    assert.equal(afterTimeout.error, undefined, JSON.stringify(afterTimeout))
    assert.equal((await session.panelObservation()).namespaceStatus, 'live')
  } finally { await session.dispose(); await rm(dir, { recursive: true, force: true }) }
})
