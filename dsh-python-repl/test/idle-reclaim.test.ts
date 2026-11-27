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

  it('keeps a kernel with a running child process', { timeout: 120_000 }, async () => {
    const s = session()
    const start = await s.runCell('import subprocess, sys\n_child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])', new Map())
    assert.equal(start.error, undefined, text(start))
    try {
      assert.match(await s.reclaimIfIdle(0) ?? '', /child processes running in the kernel/)
      assert.equal(s.kernelAlive, true)
    } finally {
      const cleanup = await s.runCell('_child.terminate()\n_child.wait(timeout=5)', new Map())
      assert.equal(cleanup.error, undefined, text(cleanup))
    }
  })

  it('keeps a direct child in a new process group until it exits', { timeout: 120_000 }, async () => {
    const s = session()
    const start = await s.runCell([
      'import os, subprocess, sys',
      '_child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(20)"], process_group=0,',
      '                          stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)',
      'assert os.getpgid(_child.pid) != os.getpgrp() and os.getsid(_child.pid) == os.getsid(0)',
    ].join('\n'), new Map())
    assert.equal(start.error, undefined, text(start))
    try {
      assert.match(await s.reclaimIfIdle(0) ?? '', /child processes running in the kernel/)
      assert.equal(s.kernelAlive, true)
    } finally {
      if (s.kernelAlive) {
        const cleanup = await s.runCell('_child.terminate()\n_child.wait(timeout=5)\ndel _child', new Map())
        assert.equal(cleanup.error, undefined, text(cleanup))
      }
    }
    assert.equal(await s.reclaimIfIdle(0), undefined)
    assert.equal(s.kernelAlive, false)
  })

  it('reclaims a kernel when its direct child has explicitly started a separate session', { timeout: 120_000 }, async () => {
    const s = session()
    const start = await s.runCell([
      'import os, subprocess, sys',
      '_pid = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(20)"], start_new_session=True,',
      '                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).pid',
      'assert os.getsid(_pid) == _pid and os.getsid(_pid) != os.getsid(0)',
      'print(_pid)',
    ].join('\n'), new Map())
    assert.equal(start.error, undefined, text(start))
    const pid = Number(start.logs.find(line => /^\s*\d+\s*$/.test(line)))
    assert.ok(Number.isSafeInteger(pid) && pid > 0, text(start))
    try {
      assert.equal(await s.reclaimIfIdle(0), undefined)
      assert.equal(s.kernelAlive, false)
      process.kill(pid, 0)
    } finally {
      process.kill(pid, 'SIGTERM')
    }
  })

  it('keeps a kernel with a running non-daemon thread', { timeout: 120_000 }, async () => {
    const s = session()
    const start = await s.runCell('import threading\n_stop = threading.Event()\n_t = threading.Thread(target=_stop.wait, args=(60,), daemon=False)\n_t.start()', new Map())
    assert.equal(start.error, undefined, text(start))
    try {
      assert.match(await s.reclaimIfIdle(0) ?? '', /^1 thread\(s\) still running/)
      assert.equal(s.kernelAlive, true)
    } finally {
      const cleanup = await s.runCell('_stop.set()\n_t.join(timeout=5)', new Map())
      assert.equal(cleanup.error, undefined, text(cleanup))
    }
  })

  it('keeps a kernel whose snapshot cannot hold a name', { timeout: 120_000 }, async () => {
    const s = session()
    assert.equal((await s.runCell('import threading\nlock_holder = [threading.Lock()]\ngen = (i for i in range(3))', new Map())).error, undefined)
    assert.match(await s.reclaimIfIdle(0) ?? '', /snapshot could not hold/)
    assert.equal(s.kernelAlive, true)
  })
})
