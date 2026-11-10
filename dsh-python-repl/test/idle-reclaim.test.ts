/**
 * Idle kernels are stopped to free memory, and only when nothing would be lost
 * (ReplSession.reclaimIfIdle, python/idle.py). Real kernel, real snapshots.
 */
import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ReplSession } from '../src/session.ts'
import { testKernelPython } from './fixtures/test-kernel.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-idle-'))
let python = ''
let counter = 0
before(async () => { python = await testKernelPython() })
const sessions: ReplSession[] = []
after(async () => { await Promise.all(sessions.map((s) => s.dispose())); rmSync(scratch, { recursive: true, force: true }) })
function session(): ReplSession {
  const s = new ReplSession({ python, vendorRoot: join(root, 'vendor', 'prime'), pythonRoot: join(root, 'python'),
    cwd: scratch, startupTimeoutMs: 60_000, statePath: join(scratch, `s${++counter}`) })
  sessions.push(s)
  return s
}
const text = (c: { logs: string[]; error?: { message: string } }) => [...c.logs, c.error?.message ?? ''].join('\n')

describe('idle kernel reclaim', () => {
  it('stops an idle kernel; the next cell restores its variables and is told why', { timeout: 120_000 }, async () => {
    const s = session()
    assert.equal((await s.runCell('kept = {"a": 1}', new Map())).error, undefined)
    assert.equal(await s.reclaimIfIdle(60_000), 'not idle long enough')
    assert.equal(await s.reclaimIfIdle(0), undefined)
    assert.equal(s.kernelAlive, false)
    const back = await s.runCell('kept["a"]', new Map())
    assert.equal(back.error, undefined, text(back))
    assert.match(text(back), /stopped after \d+ minutes idle to free memory/)
    assert.match(text(back), /\b1\b/)
  })

  it('keeps a kernel with a running asyncio task', { timeout: 120_000 }, async () => {
    const s = session()
    assert.equal((await s.runCell('import asyncio\nt = asyncio.ensure_future(asyncio.sleep(60))', new Map())).error, undefined)
    assert.match(await s.reclaimIfIdle(0) ?? '', /^1 asyncio task\(s\) still running/)
    assert.equal(s.kernelAlive, true)
  })

  it('keeps a kernel whose snapshot cannot hold a name', { timeout: 120_000 }, async () => {
    const s = session()
    assert.equal((await s.runCell('import threading\nlock_holder = [threading.Lock()]\ngen = (i for i in range(3))', new Map())).error, undefined)
    assert.match(await s.reclaimIfIdle(0) ?? '', /snapshot could not hold/)
    assert.equal(s.kernelAlive, true)
  })
})
