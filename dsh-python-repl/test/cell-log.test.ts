import { strict as assert } from 'node:assert'
import { it } from 'node:test'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CellLog } from '../src/cell-log.ts'
import { ReplSession } from '../src/session.ts'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

it('cell log is bounded, clips text, and keeps the first retirement reason', () => {
  const log = new CellLog()
  for (let i = 0; i < 205; i++) log.settled(log.queued(`\n\n  x = ${i}  \n`), { logs: ['ok'] })
  const view = log.view()
  assert.equal(view.cells.length, 200)
  assert.equal(view.cellsDropped, 5)
  assert.equal(view.cells[0]!.seq, 6)
  assert.equal(view.cells[0]!.firstLine, 'x = 5')
  assert.equal(log.queued('y'.repeat(500)).firstLine.length, 120)
  log.kernelStarted(1)
  log.kernelEnded('stopped responding\ndetails')
  log.kernelEnded('later reason')
  assert.deepEqual(log.view().generations.map((g) => [g.epoch, g.reason]), [[1, 'stopped responding']])
  view.cells[0]!.status = 'error'
  assert.equal(log.view().cells[0]!.status, 'ok', 'view is a copy')
})

it('the record survives a new host process; cells and kernels left open are closed as cut off', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cell-log-file-'))
  const file = join(dir, 'cell-log.json')
  try {
    const first = new CellLog(file)
    first.settled(first.queued('a = 1'), { logs: ['ok'] })
    first.kernelStarted(1)
    first.running(first.queued('import time\ntime.sleep(99)'), 'cell-1-2', 1)
    await new Promise((resolve) => setTimeout(resolve, 1_300))
    const second = new CellLog(file)
    const view = second.view()
    assert.deepEqual(view.cells.map((c) => [c.seq, c.status]), [[1, 'ok'], [2, 'aborted']])
    assert.match(view.cells[1]!.error!, /DSH 重启/)
    assert.equal(view.generations[0]!.reason, 'DSH 重启')
    assert.equal(view.recordedSince, first.recordedSince)
    assert.equal(second.queued('b = 2').seq, 3, 'numbering continues')
    assert.notEqual(view.cells[0]!.host, undefined)
    const broken = join(dir, 'broken.json')
    await writeFile(broken, '{not json')
    assert.deepEqual(new CellLog(broken).view().cells, [])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('overlapping writes land in order and leave no temp file behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cell-log-flush-'))
  const file = join(dir, 'cell-log.json')
  try {
    const log = new CellLog(file)
    const writes: Promise<void>[] = []
    for (let i = 0; i < 6; i++) {
      log.settled(log.queued(`v = ${i}`), { logs: [] })
      writes.push(log.flush())
    }
    await Promise.all(writes)
    assert.deepEqual(new CellLog(file).view().cells.map((c) => [c.seq, c.status]), [1, 2, 3, 4, 5, 6].map((n) => [n, 'ok']))
    assert.deepEqual((await readdir(dir)).sort(), ['cell-log.json'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

it('closing the session writes the record at once, so a finished cell is not read back as cut off', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cell-log-close-'))
  const state = join(dir, 'state')
  const session = new ReplSession({ python: process.env['DSH_PY'] ?? 'python3', statePath: state,
    vendorRoot: join(root, 'vendor/prime'), pythonRoot: join(root, 'python'), cwd: dir, startupTimeoutMs: 60_000 })
  try {
    assert.equal((await session.runCell('x = 1', new Map())).error, undefined)
    await session.dispose()
    const view = new CellLog(join(state, 'cell-log.json')).view()
    assert.deepEqual(view.cells.map((c) => [c.firstLine, c.status]), [['x = 1', 'ok']])
  } finally { await session.dispose(); await rm(dir, { recursive: true, force: true }) }
})

it('real cells record timing, status, generation and bridge tool calls', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-cell-log-'))
  const session = new ReplSession({ python: process.env['DSH_PY'] ?? 'python3',
    vendorRoot: join(root, 'vendor/prime'), pythonRoot: join(root, 'python'), cwd: dir, startupTimeoutMs: 60_000 })
  try {
    const tools = new Map([['echo', async () => 'ok'], ['boom', async () => { throw new Error('no') }]])
    assert.equal((await session.runCell('import asyncio\nawait asyncio.sleep(0.2)\nvalue = await tools.echo({})\nawait tools.echo({})\ntry:\n    await tools.boom({})\nexcept ToolCallError:\n    pass', tools)).error, undefined)
    assert.ok((await session.runCell('raise ValueError("bad thing")', new Map())).error)
    const { cells, generations } = session.cellLog.view()
    assert.equal(cells.length, 2)
    const [first, second] = cells
    assert.equal(first!.status, 'ok')
    assert.equal(first!.id, 'cell-1-1')
    assert.equal(first!.epoch, 1)
    assert.equal(first!.firstLine, 'import asyncio')
    assert.ok(first!.endedAt! - first!.startedAt! >= 200, JSON.stringify(first))
    assert.ok(first!.startedAt! >= first!.queuedAt)
    assert.deepEqual(first!.tools, [{ name: 'echo', calls: 2, errors: 0 }, { name: 'boom', calls: 1, errors: 1 }])
    assert.equal(second!.status, 'error')
    assert.match(second!.error!, /bad thing|ValueError/)
    assert.deepEqual(second!.tools, [])
    assert.deepEqual(generations.map((g) => [g.epoch, g.endedAt]), [[1, null]])
  } finally { await session.dispose(); await rm(dir, { recursive: true, force: true }) }
})
