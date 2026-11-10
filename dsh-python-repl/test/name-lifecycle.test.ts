/**
 * Name lifecycle (python/lifecycle.py) on a real kernel with real snapshots:
 * archive after N unused user cells, bring back on use, delete later, pins,
 * counting across kernel restarts, the short restore notice, and reset.
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ReplSession } from '../src/session.ts'
import { testKernelPython } from './fixtures/test-kernel.ts'
import { readPanelLifecycle, restoreNotice } from '../src/snapshot.ts'
import type { BoundTool } from '../src/lease.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let venvPython = ''
before(async () => {
  venvPython = await testKernelPython()
})
const scratch = mkdtempSync(join(tmpdir(), 'dsh-lifecycle-'))
const sessions: ReplSession[] = []
let counter = 0
function newSession(state = join(scratch, `s${++counter}`), archive = 3, del = 6): { session: ReplSession; state: string } {
  const session = new ReplSession({ python: venvPython, vendorRoot: join(root, 'vendor', 'prime'), pythonRoot: join(root, 'python'),
    cwd: scratch, startupTimeoutMs: 60_000, statePath: state, archiveAfterCells: archive, deleteAfterCells: del })
  sessions.push(session)
  return { session, state }
}
const noTools = (): Map<string, BoundTool> => new Map()
const text = (r: { logs: string[]; error?: { message: string } }): string => [...r.logs, r.error?.message ?? ''].join('\n')
async function ok(session: ReplSession, code: string): Promise<string> {
  const result = await session.runCell(code, noTools())
  assert.equal(result.error, undefined, text(result))
  return text(result)
}
const lifecycle = (state: string) => JSON.parse(readFileSync(join(state, 'lifecycle.json'), 'utf8'))
after(async () => {
  await Promise.all(sessions.map((s) => s.dispose()))
  rmSync(scratch, { recursive: true, force: true })
})

describe('name lifecycle', () => {
  it('archives unused names, brings them back on use, and deletes them later', { timeout: 180_000 }, async () => {
    const { session, state } = newSession()
    await ok(session, 'old = 41\nkept = [1, 2]\ndef helper():\n    return dep + 1\ndep = 9')
    await ok(session, 'x1 = 1')
    await ok(session, 'x2 = 2')
    await ok(session, 'x3 = 3')
    const archived = lifecycle(state)
    assert.deepEqual(Object.keys(archived.archived).sort(), ['dep', 'helper', 'kept', 'old'])
    assert.equal(readdirSync(join(state, 'archive')).filter((f) => f.endsWith('.dill')).length, 4)
    // Direct use brings it back before the code runs; the cell is told once.
    const back = await ok(session, 'assert old == 41')
    assert.match(back, /Brought back from the archive.*old/)
    // A function brought back pulls in the archived global it reads.
    await ok(session, 'assert helper() == 10')
    const now = Object.keys(lifecycle(state).archived)
    assert.ok(now.includes('kept') && !now.includes('old') && !now.includes('helper') && !now.includes('dep'), now.join())
    for (let i = 0; i < 6; i++) await ok(session, `y = ${i}`)
    const gone = await session.runCell('kept', noTools())
    assert.ok(gone.error)
    assert.match(text(gone), /kept.*was deleted in cell \d+ after 6 cells unused/s)
    assert.ok('kept' in lifecycle(state).deleted)
  })

  it('pins survive, repl.unarchive works, and counting continues after a restart', { timeout: 180_000 }, async () => {
    const { session, state } = newSession()
    await ok(session, 'precious = {"a": 1}\nloose = 5\nmax = max\ndef tool_fn():\n    return 1\nawait repl.keep("precious")')
    for (let i = 0; i < 4; i++) await ok(session, `z = ${i}`)
    const st = lifecycle(state)
    assert.deepEqual(st.pins, ['precious'])
    assert.ok(!('precious' in st.archived))
    assert.ok('loose' in st.archived)
    const res = await ok(session, 'r = await repl.unarchive("loose")\nassert r["ok"], r')
    assert.doesNotMatch(res, /Brought back/, 'an explicit unarchive is not repeated as a note')
    await ok(session, 'assert loose == 5')
    const cellBefore = lifecycle(state).cell
    assert.equal((await session.runCell('await repl.restart()', noTools())).error, undefined)
    const restored = await ok(session, 'assert precious == {"a": 1}\nassert loose == 5')
    assert.match(restored, /\[python-state-restored\]/)
    assert.match(restored, /Pinned with repl\.keep: precious\./)
    assert.match(restored, /more names? (was|were) archived after 3\+ cells unused/)
    assert.doesNotMatch(restored, /These names are available again/)
    assert.doesNotMatch(restored, /\bmax\b/, 'a builtin copied into globals is not listed')
    assert.ok(lifecycle(state).cell > cellBefore, 'the cell count survives the restart')
    const panel = await readPanelLifecycle(state)
    assert.ok(panel !== null && panel.pins.includes('precious'), JSON.stringify(panel))
    assert.ok(panel.deleted.some((d) => d.name === 'tool_fn') && panel.deletedTotal >= 1, JSON.stringify(panel.deleted))
    assert.ok(panel.names['precious'] !== undefined && panel.cell === lifecycle(state).cell)
  })

  it('a rebound archived name keeps the new value and an archive can be done from the panel', { timeout: 120_000 }, async () => {
    const { session, state } = newSession()
    await ok(session, 'value = 1')
    for (let i = 0; i < 3; i++) await ok(session, `w = ${i}`)
    assert.ok('value' in lifecycle(state).archived)
    await ok(session, 'value = 2')
    await ok(session, 'assert value == 2')
    assert.ok(!('value' in lifecycle(state).archived))
    const archived = await session.panelNameAction('archive', 'value')
    assert.equal(archived.ok, true, JSON.stringify(archived))
    assert.ok('value' in lifecycle(state).archived)
    assert.equal((await session.panelNameAction('keep', 'value')).ok, true)
    assert.ok(!('value' in lifecycle(state).archived), 'pinning an archived name brings it back')
    assert.equal((await session.panelNameAction('archive', 'value')).ok, false)
    assert.equal((await session.panelNameAction('unkeep', 'value')).ok, true)
    assert.equal((await session.panelNameAction('keep', 'nope')).ok, false)
    await ok(session, 'assert value == 2')
  })

  it('reset removes the records and the archive', { timeout: 120_000 }, async () => {
    const { session, state } = newSession()
    await ok(session, 'gone = 1')
    for (let i = 0; i < 3; i++) await ok(session, `w = ${i}`)
    assert.ok(existsSync(join(state, 'archive')))
    assert.equal((await session.panelControl('reset')).ok, true)
    assert.equal(existsSync(join(state, 'archive')), false)
    assert.equal(existsSync(join(state, 'lifecycle.json')), false)
    const missing = await session.runCell('gone', noTools())
    assert.ok(missing.error)
    assert.doesNotMatch(text(missing), /archived|deleted in cell/)
  })

  it('archiving off (0) keeps every name', { timeout: 120_000 }, async () => {
    const { session, state } = newSession(undefined, 0, 0)
    await ok(session, 'stay = 1')
    for (let i = 0; i < 5; i++) await ok(session, `w = ${i}`)
    await ok(session, 'assert stay == 1')
    assert.deepEqual(lifecycle(state).archived, {})
  })

  it('a name that cannot be archived is not serialized again every cell, only after it is used again', { timeout: 120_000 }, async () => {
    const { session, state } = newSession(undefined, 3, 50)
    await ok(session, 'import lifecycle as _lc\n_calls = []\n_orig = _lc._archive\n'
      + 'def _counting(name, ns):\n    _calls.append(name)\n    return _orig(name, ns)\n_lc._archive = _counting\n'
      + 'class Locked:\n    def __reduce__(self):\n        raise TypeError("cannot pickle Locked")\nbad = Locked()')
    for (let i = 0; i < 6; i++) await ok(session, `w = ${i}`)
    assert.match(lifecycle(state).names.bad.stuck, /cannot pickle Locked/)
    await ok(session, 'assert _calls.count("bad") == 1, _calls')
    await ok(session, 'bad')
    assert.equal(lifecycle(state).names.bad.stuck, undefined, 'using the name clears the mark')
    for (let i = 0; i < 3; i++) await ok(session, `w = ${i}`)
    await ok(session, 'assert _calls.count("bad") == 2, _calls')
  })
})

describe('restore notice', () => {
  it('lists pins, the most recent functions and variables, counts the rest, and always lists failures', () => {
    const many = Array.from({ length: 25 }, (_, i) => `v${i}`)
    const notice = restoreNotice({ restored: ['a'], failed: ['conn'], unsaved: [] },
      { total: 40, ordered: true, pinned: ['cfg'], functions: ['f1', 'f2'], variables: many, modules: ['np'], archived: 300, archiveAfter: 100 })
    assert.match(notice, /40 names are back/)
    assert.match(notice, /Pinned with repl\.keep: cfg\./)
    assert.match(notice, /Functions and classes \(most recently used first\): f1, f2\./)
    assert.match(notice, /Variables \(most recently used first\): v0, v1, .*v9 \(\+15 more\)\./)
    assert.match(notice, /300 more names were archived/)
    assert.match(notice, /repl\.list\(\) shows every name/)
    assert.match(notice, /could not be restored.*conn/)
    assert.doesNotMatch(notice, /v10,/)
  })
})
