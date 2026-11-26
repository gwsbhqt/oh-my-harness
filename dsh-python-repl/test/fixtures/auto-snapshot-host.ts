import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { EventEmitter, once } from 'node:events'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { Config, PythonReplRuntime } from '../../src/index.ts'
import { PythonKernel } from '../../src/kernel.ts'
import { SNAPSHOT_DEBOUNCE_MS, SNAPSHOT_TIMEOUT_MS } from '../../src/snapshot.ts'
import { mountAgents } from './agents.ts'

const [scenario, cwd, python] = process.argv.slice(2)
assert.ok(scenario && cwd && python && process.env.DSH_HOME)
const key = 'test-autosave'
const state = join(process.env.DSH_HOME, 'plugins', 'python-repl', 'state', createHash('sha256').update(key).digest('hex').slice(0, 32))
const payload = join(state, 'kernel-state.dill')
const manifest = join(state, 'kernel-state.json')
const files = () => [readFileSync(payload), readFileSync(manifest)]
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
const context = () => runtime.stateContext(key, cwd)
const panel = () => runtime.panelState(key)

// Observe the real Python reply after the host has processed it. Repeated failures leave no file to watch.
const events = new EventEmitter()
let delayed: Promise<void> | undefined
const snapshot = PythonKernel.prototype.snapshot
PythonKernel.prototype.snapshot = async function (id, target) {
  const result = await snapshot.call(this, id, target)
  if (delayed) { events.emit('written'); await delayed }
  setImmediate(() => events.emit('finished', result))
  return result
}
const save = async (code: string) => {
  const [text, [outcome]] = await Promise.all([cell(code), once(events, 'finished', { signal: AbortSignal.timeout(30_000) })])
  return { text, status: outcome.status as string }
}

try {
  if (scenario === 'skipped') {
    const generators = ['pending_a', 'pending_b', 'pending_c', 'pending_d']
    assert.equal((await panel()).snapshot.status, 'missing')
    const first = await save([...generators.map(name => `${name} = (v for v in ())`), 'counter = 7', 'print("created")'].join('\n'))
    assert.equal(first.status, 'ok')
    assert.equal(first.text, 'created')
    const sample = { kind: 'skipped', count: 4, names: generators.slice(0, 3) }
    const before = await panel()
    assert.deepEqual(before.autoSaveIssue, sample)
    assert.deepEqual(before.snapshot.skipped.map(({ name }) => name).sort(), generators)
    assert.ok(before.snapshot.saved.includes('counter'))
    const next = await save('print("next")')
    const notice = next.text.split('\n').find(line => line.includes('Automatic save skipped'))
    assert.ok(notice && notice.length < 320)
    assert.match(notice, /4 names.*pending_a.*pending_b.*pending_c/)
    assert.doesNotMatch(notice, /pending_d/)
    assert.ok((await context()).includes(notice.replace('[dsh-python-repl] ', '')))
    // The sample and count stay the same while an omitted name changes.
    const changed = await save('del pending_d\npending_e = (v for v in ())\nprint("changed")')
    assert.equal(changed.text, 'changed')
    const after = await panel()
    assert.deepEqual(after.autoSaveIssue, sample)
    assert.deepEqual(after.snapshot.skipped.map(({ name }) => name).sort(), [...generators.slice(0, 3), 'pending_e'])
    assert.match((await save('print("observed")')).text, /Automatic save skipped 4 names/)
    assert.equal((await save('del pending_a, pending_b, pending_c, pending_e\nprint("cleared")')).text, 'cleared')
    assert.equal((await panel()).autoSaveIssue, undefined)
    assert.doesNotMatch(await context(), /Automatic save skipped|Automatic saving has resumed/)
    assert.equal((await save('pending_one = (v for v in ())\nprint("clean")')).text, 'clean')
    const previousEpoch = session.epoch
    const restart = await cell('await repl.restart()')
    assert.match(restart, /These names could not be saved: pending_one/)
    assert.doesNotMatch(restart, /Automatic save skipped/)
    assert.equal((await panel()).autoSaveIssue, undefined)
    const restored = await cell('assert counter == 7')
    assert.match(restored, /python-state-restored/)
    assert.doesNotMatch(restored, /Automatic save skipped|Automatic saving has resumed/)
    assert.ok(session.epoch > previousEpoch)
  } else if (scenario === 'protected') {
    const modulePath = join(cwd, 'fixture_value.py')
    writeFileSync(modulePath, 'class SavedValue:\n    pass\n')
    await save("value = __import__('fixture_value').SavedValue()\ncounter = 17\npending = (v for v in ())")
    assert.match(await cell('assert counter == 17'), /Automatic save skipped/)
    assert.equal((await session.panelControl('stop')).ok, true)
    const original = files()
    unlinkSync(modulePath)
    const first = await cell("assert counter == 17 and 'value' not in globals()\ncounter = 19")
    assert.match(first, /Saving is paused/)
    assert.doesNotMatch(first, /Automatic sav/)
    assert.match(await context(), /Saving is paused/)
    assert.doesNotMatch(await context(), /Automatic sav/)
    await sleep(SNAPSHOT_DEBOUNCE_MS + 150)
    const guarded = await panel()
    assert.equal(guarded.snapshotProtected, true)
    assert.equal(guarded.autoSaveIssue, undefined)
    assert.deepEqual(files(), original)
    assert.equal(await cell('print(counter)'), '19')
    const refused = await session.panelControl('stop')
    assert.equal(refused.ok, false)
    assert.match(refused.reason ?? '', /await repl\.save_copy\("变量名"\)/)
    assert.deepEqual(files(), original)
  } else if (scenario === 'late-reply') {
    const release = Promise.withResolvers<void>()
    delayed = release.promise
    const written = once(events, 'written', { signal: AbortSignal.timeout(30_000) })
    const finished = once(events, 'finished', { signal: AbortSignal.timeout(30_000) })
    try {
      assert.equal(await cell('counter = 17\npending = (v for v in ())\nprint("queued")'), 'queued')
      await written
      await sleep(SNAPSHOT_TIMEOUT_MS + 150)
      const waiting = await panel()
      assert.equal(waiting.snapshot.status, 'available')
      assert.equal(waiting.autoSaveIssue, undefined)
      assert.doesNotMatch(await context(), /Automatic save failed/)
    } finally {
      release.resolve()
      delayed = undefined
    }
    await finished
    assert.equal((await panel()).autoSaveIssue?.kind, 'skipped')
    assert.match(await cell('assert counter == 17'), /Automatic save skipped 1 name/)
  } else {
    assert.ok(scenario === 'first-failure' || scenario === 'old-snapshot')
    const old = scenario === 'old-snapshot'
    assert.equal((await session.panelControl('start')).ok, true)
    if (old) assert.equal((await save('counter = 17\nprint("seeded")')).text, 'seeded')
    const original = old ? files() : undefined
    mkdirSync(state, { recursive: true })
    // Exercise a real file-size limit, and directory permissions when the test user is subject to them.
    const limitFileSize = !old || process.getuid?.() === 0
    const limit = 'import resource, signal\nprior_limit = resource.getrlimit(resource.RLIMIT_FSIZE)\nsignal.signal(signal.SIGXFSZ, signal.SIG_IGN)\nresource.setrlimit(resource.RLIMIT_FSIZE, (65536, prior_limit[1]))\n'
    const saveDirectory = limitFileSize ? undefined : dirname(dirname(realpathSync(payload)))
    if (saveDirectory) chmodSync(saveDirectory, 0o500)
    try {
      const update = old ? 'counter += 2' : 'counter = 19'
      const first = await save((limitFileSize ? limit : '') + `${update}\nfresh = bytes(262144)\nprint("changed")`)
      assert.equal(first.text, 'changed')
      assert.equal(first.status, 'error')
      const failed = await panel()
      assert.equal(failed.autoSaveIssue?.kind, 'failed')
      assert.equal(failed.snapshot.status, old ? 'available' : 'missing')
      assert.equal(failed.snapshotProtected, false)
      if (original) {
        assert.deepEqual(files(), original)
        assert.ok(failed.snapshot.saved.includes('counter'))
        assert.ok(!failed.snapshot.saved.includes('fresh'))
      } else {
        assert.ok(!existsSync(payload) && !existsSync(manifest))
      }
      const stateText = await context()
      assert.match(stateText, /Automatic save failed/)
      assert.equal(stateText.includes('snapshot file on disk may contain older values'), old)
      assert.doesNotMatch(stateText, /Variables are saved shortly after|Saving is paused/)
      const noticed = await save('assert counter == 19 and len(fresh) == 262144\nprint("still live")')
      assert.equal(noticed.status, 'error')
      const notice = noticed.text.split('\n').find(line => line.includes('Automatic save failed'))
      assert.ok(notice && notice.length < 420)
      assert.ok(stateText.includes(notice.replace('[dsh-python-repl] ', '')))
      assert.equal((await save('print("same failure")')).text, 'same failure')
      assert.deepEqual((await panel()).autoSaveIssue, failed.autoSaveIssue)
      if (original) assert.deepEqual(files(), original)
    } finally {
      if (saveDirectory) chmodSync(saveDirectory, 0o700)
    }
    const repair = await save((limitFileSize ? 'resource.setrlimit(resource.RLIMIT_FSIZE, prior_limit)\n' : '') + 'print("fixed")')
    assert.equal(repair.text, 'fixed')
    assert.equal(repair.status, 'ok')
    const recovered = await panel()
    assert.equal(recovered.autoSaveIssue, undefined)
    assert.ok(recovered.snapshot.saved.includes('fresh'))
    assert.doesNotMatch(await context(), /Automatic save failed|older values/)
    if (original) assert.notDeepEqual(files(), original)
    assert.match((await save('print("recovered")')).text, /Automatic saving has resumed/)
    assert.equal(await cell('print("once")'), 'once')
  }
} finally {
  PythonKernel.prototype.snapshot = snapshot
  await runtime.disposeAll()
}
