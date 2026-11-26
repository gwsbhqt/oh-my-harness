import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { promisify } from 'node:util'
import { testKernelPython } from './fixtures/test-kernel.ts'

it('saves only requested roots and reads them independently across protected and repaired hosts', { timeout: 120_000 }, async () => {
  const python = await testKernelPython()
  const root = mkdtempSync(join(tmpdir(), 'recovery-copies-'))
  const home = join(root, 'home')
  const host = join(root, 'host')
  mkdirSync(home)
  const env = { ...process.env, HOME: home, DSH_HOME: host, DSH_PYTHON_REPL_TEST_HOME: host, PYTHONDONTWRITEBYTECODE: '1' }
  function run(fixture: string, phase: string, ...args: string[]) {
    return promisify(execFile)(process.execPath,
      [join(import.meta.dirname, 'fixtures', fixture), phase, root, python, ...args], { env })
  }
  try {
    await run('protected-restore-host.ts', 'seed')
    const sessions = join(host, 'plugins', 'python-repl', 'state')
    const state = join(sessions, readdirSync(sessions)[0]!)
    const original = () => {
      const archive = readdirSync(join(state, 'archive')).sort().map((file) => join('archive', file))
      return Object.fromEntries(['kernel-state.dill', 'kernel-state.json', 'lifecycle.json', ...archive]
        .map((file) => [file, readFileSync(join(state, file))]))
    }
    const before = original()
    const fixture = 'recovery-copy-host.ts'
    const receipt = JSON.parse((await run(fixture, 'save')).stdout)
    assert.deepEqual(original(), before)
    const copies = readdirSync(join(state, 'copies'))
    assert.equal(copies.length, 3)
    assert.ok(copies.includes(receipt.copy_id))
    const directory = join(state, 'copies')
    mkdirSync(join(directory, '0'.repeat(32)))
    symlinkSync(join(directory, receipt.copy_id), join(directory, '1'.repeat(32)), 'dir')
    await run(fixture, 'foreign', receipt.copy_id)
    await run(fixture, 'missing', receipt.copy_id)
    assert.deepEqual(original(), before)
    await run(fixture, 'repaired', receipt.copy_id)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
