import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { Config, PythonReplRuntime } from '../../src/index.ts'
import { PythonKernel } from '../../src/kernel.ts'
import { mountAgents } from './agents.ts'

const [mode, scenario, cwd, python] = process.argv.slice(2)
assert.ok(mode && scenario && cwd && python && process.env.DSH_HOME)
const key = 'snapshot-store-test'
const state = join(process.env.DSH_HOME, 'plugins', 'python-repl', 'state', createHash('sha256').update(key).digest('hex').slice(0, 32))
const payload = join(state, 'kernel-state.dill')
const manifest = join(state, 'kernel-state.json')
const store = join(state, `.snapshot-${createHash('sha256').update('kernel-state.dill').digest('hex')}`)
const current = join(store, 'current')
const ctx = new Context()
await mountAgents(ctx)
await ctx.plugin(PythonReplRuntime, Config({ python, skillRoots: [], projectSkillRoots: [], archiveAfterCells: 0, deleteAfterCells: 0 }))
await new Promise<void>(resolve => setImmediate(resolve))
const runtime = ctx.get('ptcRuntime') as PythonReplRuntime
const session = runtime.sessionFor(key, cwd, python)
const cell = async (code: string) => {
  const result = await session.runCell(code, new Map())
  assert.equal(result.error, undefined, JSON.stringify(result))
  return result.logs.join('\n').trimEnd()
}
const panel = () => runtime.panelState(key)
const context = () => runtime.stateContext(key, cwd)
const separateNames = scenario === 'changed-names' || scenario === 'restore-switch'
try {
  if (mode === 'seed') {
    await cell('counter = 7' + (separateNames ? '\nold_only = 11\nold_skip = (v for v in ())' : ''))
    if (scenario === 'broken') await cell('print((await repl.save_copy("counter"))["copy_id"])')
    assert.equal((await session.panelControl('stop')).ok, true)
    assert.match(readlinkSync(current), /^[0-9a-f]{32}$/)
    assert.equal((await panel()).snapshot.status, 'available')
  } else if (mode === 'publish') {
    await cell('assert old_only == 11\ndel old_only\nnew_only = 42\nnew_skip = (v for v in ())\ncounter = 9')
    assert.equal((await session.panelControl('stop')).ok, true)
  } else if (mode === 'restore-switch') {
    // A second real host publishes after Python restored the old data, before TypeScript consumes its receipt.
    const restore = PythonKernel.prototype.restore
    PythonKernel.prototype.restore = async function (id, target) {
      const result = await restore.call(this, id, target)
      if (result.status === 'ok') await promisify(execFile)(process.execPath, [process.argv[1]!, 'publish', scenario, cwd, python])
      return result
    }
    try {
      const revived = await cell('assert counter == 7 and old_only == 11 and "new_only" not in globals()')
      assert.match(revived, /never saved.*old_skip/)
      assert.doesNotMatch(revived, /new_skip/)
      const disk = (await panel()).snapshot
      assert.ok(disk.saved.includes('new_only') && !disk.saved.includes('old_only'))
      assert.deepEqual(disk.skipped.map(item => item.name), ['new_skip'])
    } finally { PythonKernel.prototype.restore = restore }
  } else if (mode === 'fail') {
    // Only the publication of a complete new generation fails; staging and the initial legacy/empty marker still work.
    const fault = `import os, errno, re\nreplace = os.replace\ndef fail(src, dst, *args, **kwargs):\n    if os.path.basename(dst) == 'current' and os.path.islink(src) and re.fullmatch(r'[a-f0-9]{32}', os.readlink(src)):\n        raise OSError(errno.EIO, 'fixture commit failure')\n    return replace(src, dst, *args, **kwargs)\nos.replace = fail`
    await cell(`exec(${JSON.stringify(fault)}, {})\n` + (separateNames ? 'del old_only\nnew_only = 42\nnew_skip = (v for v in ())\n' : '') + 'counter = 9')
    const deadline = Date.now() + 15_000
    while ((await panel()).autoSaveIssue?.kind !== 'failed' && Date.now() < deadline) await sleep(50)
    const failed = await panel()
    assert.equal(failed.autoSaveIssue?.kind, 'failed')
    assert.equal(failed.snapshot.status, scenario === 'first' ? 'missing' : 'available')
    const stop = await session.panelControl('stop')
    assert.equal(stop.ok, false)
    assert.match(stop.reason ?? '', /fixture commit failure/)
    assert.match(await cell('print(counter)'), /^9$/m)
  } else if (mode === 'observe') {
    const disk = (await panel()).snapshot
    if (scenario === 'first') {
      assert.equal(disk.status, 'missing')
      assert.doesNotMatch(await context(), /A saved Python state exists/)
      assert.equal(await cell('print("counter" in globals())'), 'False')
    } else if (scenario === 'legacy') {
      assert.equal(disk.status, 'error')
      assert.match(await context(), /A saved Python state exists/)
      const out = await cell('print(counter, _legacy)')
      assert.match(out, /^31 13$/m)
      assert.equal((await panel()).snapshotProtected, false)
      assert.ok(!existsSync(store))
    } else {
      assert.equal(disk.status, 'available')
      assert.ok(disk.saved.includes('counter') && disk.sizes?.counter)
      if (separateNames) {
        assert.ok(disk.saved.includes('old_only') && !disk.saved.includes('new_only'))
        assert.deepEqual(disk.skipped.map(item => item.name), ['old_skip'])
        assert.ok(disk.sizes?.old_only && !disk.sizes?.new_only)
      }
      const restored = await cell('assert counter == 7' + (separateNames ? '\nassert old_only == 11 and "new_only" not in globals()' : ''))
      if (separateNames) assert.match(restored, /never saved.*old_skip/)
      assert.doesNotMatch(restored, /new_skip|Saving is paused/)
    }
  } else {
    assert.ok(mode === 'broken' || mode === 'conflict')
    assert.equal((await panel()).snapshot.status, 'error')
    assert.match(await context(), /could not be read/)
    const original = readFileSync(manifest)
    const first = await cell('assert "counter" not in globals()\nlocal_value = 19')
    assert.match(first, /Saving is paused/)
    assert.match(first, /Restore failed: could not read saved snapshot/)
    assert.equal((await panel()).snapshotProtected, true)
    assert.equal((await session.panelControl('stop')).ok, false)
    assert.deepEqual(readFileSync(manifest), original)
    if (mode === 'broken') {
      const reset = await session.panelControl('reset')
      assert.equal(reset.ok, true, reset.reason)
      assert.equal((await panel()).snapshot.status, 'missing')
      assert.equal((await panel()).snapshotProtected, false)
      assert.ok(!existsSync(store) && !existsSync(payload))
      await cell('assert "local_value" not in globals() and "counter" not in globals()\ncopies = await repl.list_copies()\nassert len(copies) == 1 and (await repl.read_copy(copies[0]))["values"]["counter"] == 7')
    }
  }
} finally { await runtime.disposeAll() }
