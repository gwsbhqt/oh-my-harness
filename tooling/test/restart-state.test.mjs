import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { pendingRestart } from '../runtime/restart-state.mjs'

test('维护重启状态：活执行者阻挡，终态与真实死 PID 可恢复，缺失和损坏严格区分', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-restart-state-'))
  const dir = join(home, 'dsh-control')
  const path = join(dir, 'restart-state.json')
  mkdirSync(dir)
  try {
    assert.equal(pendingRestart(home), undefined)
    for (const phase of ['checking', 'waiting', 'updating', 'quitting', 'starting', 'queued']) {
      writeFileSync(path, JSON.stringify({ phase, pid: process.pid, requestId: 'request' }))
      assert.deepEqual(pendingRestart(home), { phase, pid: process.pid, requestId: 'request' })
    }
    for (const phase of ['completed', 'failed', 'timed-out', 'interrupted']) {
      writeFileSync(path, JSON.stringify({ phase, pid: process.pid }))
      assert.equal(pendingRestart(home), undefined)
    }
    const child = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    writeFileSync(path, JSON.stringify({ phase: 'waiting', pid: Number(child.stdout.trim()) }))
    assert.equal(pendingRestart(home), undefined)
    for (const text of ['bad json', 'null', '{}', '{"phase":"waiting"}', '{"phase":"unknown","pid":1}']) {
      writeFileSync(path, text)
      assert.throws(() => pendingRestart(home), (error) => error.code === 'restart-state-unavailable' && error.message.includes(path))
    }
    rmSync(path)
    mkdirSync(path)
    assert.throws(() => pendingRestart(home), (error) => error.code === 'restart-state-unavailable' && /EISDIR/.test(error.message))
  } finally { rmSync(home, { recursive: true, force: true }) }
})
