/**
 * Variables survive a kernel replacement through Prime's namespace snapshot.
 *
 * Two ReplSession objects sharing one state directory stand in for "DSH quit
 * and came back": the host process that owned the first is gone, only the
 * snapshot under DSH_HOME remains.
 *
 * Needs a `dill`-capable interpreter: uv's Python 3.14 (dill cannot serialize
 * functions on 3.15). The kernel venv with `dill` is built by the plugin's own
 * code and cached outside the repository.
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { ReplSession } from '../src/session.ts'
import { testKernelPython } from './fixtures/test-kernel.ts'
import type { BoundTool } from '../src/lease.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
let venvPython = ''
before(async () => {
  venvPython = await testKernelPython()
})

const scratch = mkdtempSync(join(tmpdir(), 'dsh-snapshot-'))
const sessions: ReplSession[] = []
let counter = 0
function newSession(statePath: string | null = join(scratch, `s${++counter}`)): ReplSession {
  const session = new ReplSession({
    python: venvPython,
    vendorRoot: join(root, 'vendor', 'prime'),
    pythonRoot: join(root, 'python'),
    cwd: scratch,
    startupTimeoutMs: 60_000,
    ...(statePath === null ? {} : { statePath }),
  })
  sessions.push(session)
  return session
}
const noTools = (): Map<string, BoundTool> => new Map()
const text = (r: { logs: string[] }): string => r.logs.join('\n')
/** Past Prime's 1.5 s snapshot debounce. */
const debounce = (): Promise<void> => sleep(2_000)

after(async () => {
  await Promise.all(sessions.map((s) => s.dispose()))
  rmSync(scratch, { recursive: true, force: true })
})

const SETUP =
  'import json as j\n'
  + 'x = 41\n'
  + 'rows = [{"i": i} for i in range(3)]\n'
  + 'class Box:\n'
  + '    def __init__(self, v):\n'
  + '        self.v = v\n'
  + 'box = Box(3)\n'
  + 'def bump():\n'
  + '    return x + 1\n'

describe('variables survive a kernel replacement', () => {
  it('restored functions never borrow source from a new cell with the same filename', { timeout: 180_000 }, async () => {
    const session = newSession()
    const originalSource = 'def identity_target():\n    return 1\n'
    // The fresh kernel spends one vendor cell number on the restore summary; spend one here too, so the
    // first fresh cell really reuses this cell's filename and the identity check is what tells them apart.
    assert.equal((await session.panelControl('start')).ok, true)
    assert.equal((await session.panelNameAction('keep', 'not_defined_yet')).ok, false)
    assert.equal((await session.runCell(originalSource, noTools())).error, undefined)
    const originalEpoch = (await session.panelObservation()).epoch
    const original = await session.panelPreview('identity_target', originalEpoch)
    assert.equal(original.kind, 'source', JSON.stringify(original))
    assert.equal(original.source, originalSource)
    assert.equal((await session.runCell('await repl.restart()', noTools())).error, undefined)
    const newSource = 'def fresh_target():\n    return 2\n'
    const firstFreshCell = await session.runCell(newSource, noTools())
    assert.equal(firstFreshCell.error, undefined, JSON.stringify(firstFreshCell))
    const freshEpoch = (await session.panelObservation()).epoch
    assert.ok(freshEpoch > originalEpoch)
    const fresh = await session.panelPreview('fresh_target', freshEpoch)
    assert.equal(fresh.filename, original.filename, 'restarting repeats the actual vendor cell filename')
    assert.equal(fresh.source, newSource)
    const restored = await session.panelPreview('identity_target', freshEpoch)
    assert.equal(restored.filename, fresh.filename)
    assert.equal(restored.kind, 'metadata', JSON.stringify(restored))
    assert.equal(restored.source, undefined)
    assert.equal(restored.sourceEndLine, undefined)
    assert.match(restored.reason!, /原始源码/)
    assert.equal((await session.runCell('assert identity_target() == 1 and fresh_target() == 2', noTools())).error, undefined)
    assert.equal((await session.runCell('from json import dumps as imported_json_dumps', noTools())).error, undefined)
    const imported = await session.panelPreview('imported_json_dumps', freshEpoch)
    assert.equal(imported.kind, 'source', JSON.stringify(imported))
    assert.match(imported.source!, /def dumps\(/)
  })


  it('a new host process restores data, functions and classes, and says which', { timeout: 180_000 }, async () => {
    const dir = join(scratch, 'restart')
    const first = newSession(dir)
    const defined = await first.runCell(SETUP, noTools())
    assert.equal(defined.error, undefined, JSON.stringify(defined.error))
    await first.dispose()
    assert.ok(existsSync(join(dir, 'kernel-state.dill')), 'closing the session writes the final snapshot')
    assert.ok(existsSync(join(dir, 'kernel-state.json')))

    const second = newSession(dir)
    const cell = await second.runCell('x = 100\n(bump(), len(rows), box.v, j.dumps(1), Box(5).v)', noTools())
    assert.equal(cell.error, undefined, JSON.stringify(cell.error))
    assert.match(text(cell), /\(101, 3, 3, '1', 5\)/, 'a restored function reads the live namespace')
    const notice = text(cell).slice(text(cell).indexOf('[python-state-restored]'))
    assert.match(notice, /6 names are back\./)
    assert.match(notice, /Functions and classes[^\n]*: Box, bump\./)
    assert.match(notice, /Variables[^\n]*: box, rows, x\./)
    assert.match(notice, /Modules: j\./)
    assert.doesNotMatch(notice, /\btools\b|\brepl\b|\bjson\b|\bPath\b/, 'bridge and preloaded names are not the user\'s')

    const later = await second.runCell('1 + 1', noTools())
    assert.doesNotMatch(text(later), /python-state-restored/, 'the notice is told once')
  })

  it('system names are rebuilt, never restored (as Prime); the user own names come back', { timeout: 180_000 }, async () => {
    const session = newSession()
    const setup = await session.runCell('json = {"mine": True}\ndef glob(p):\n    return "mine"', noTools())
    assert.equal(setup.error, undefined, JSON.stringify(setup.error))
    assert.equal((await session.runCell('await repl.restart()', noTools())).error, undefined)
    const fresh = await session.runCell('(type(json).__name__, glob("x"), type(repl).__name__, (await repl.info())["epoch"])', noTools())
    assert.equal(fresh.error, undefined, JSON.stringify(fresh.error))
    assert.match(text(fresh), /\('module', 'mine', '_Repl', 2\)/)
    assert.match(text(fresh), /1 name is back\.\n[^\n]*: glob\./)
  })

  it('a top-level tool granted after start is not snapshotted; once revoked, the user may reuse its name', { timeout: 180_000 }, async () => {
    const dir = join(scratch, 'late-grant')
    const first = newSession(dir)
    assert.equal((await first.runCell('1', noTools())).error, undefined)
    const withGlob = new Map<string, BoundTool>([['glob', async () => 'proxy']])
    assert.equal((await first.runCell('await glob({})', withGlob)).error, undefined)
    await first.dispose()
    const second = newSession(dir)
    const fresh = await second.runCell('"glob" in globals()', noTools())
    assert.equal(fresh.error, undefined, JSON.stringify(fresh.error))
    assert.match(text(fresh), /False/, 'no dead proxy comes back from the snapshot')
    assert.equal((await second.runCell('def glob(p):\n    return "mine"', noTools())).error, undefined)
    await second.dispose()
    assert.match(text(await newSession(dir).runCell('glob("x")', noTools())), /mine/)
  })

  it('closing the session also saves what a failed cell changed (as Prime)', { timeout: 180_000 }, async () => {
    const dir = join(scratch, 'failed-cell')
    const first = newSession(dir)
    assert.equal((await first.runCell('ok_value = 1', noTools())).error, undefined)
    assert.ok((await first.runCell('loaded = [1, 2, 3]\nloaded.bad()', noTools())).error)
    await first.dispose()
    const second = newSession(dir)
    const cell = await second.runCell('loaded', noTools())
    assert.equal(cell.error, undefined, JSON.stringify(cell.error))
    assert.match(text(cell), /\[1, 2, 3\]/)
  })

  it('internal housekeeping aliases never replace user bindings, including after restore', { timeout: 180_000 }, async () => {
    const dir = join(scratch, 'internal-aliases')
    const first = newSession(dir)
    const setup = await first.runCell('_b = "B"\n_j = "J"\n_i = "I"\n_l = "L"\n_bg = "BG"', noTools())
    assert.equal(setup.error, undefined, JSON.stringify(setup))
    assert.equal((await first.runCell('tick = 1', noTools())).error, undefined)
    assert.equal((await first.panelObservation()).epoch >= 1, true)
    await first.panelNameAction('keep', 'value_not_real')
    const values = await first.runCell('(_b, _j, _i, _l, _bg)', noTools())
    assert.match(text(values), /\('B', 'J', 'I', 'L', 'BG'\)/)
    await first.dispose()
    const second = newSession(dir)
    const restored = await second.runCell('(_b, _j, _i, _l, _bg)', noTools())
    assert.equal(restored.error, undefined, JSON.stringify(restored))
    assert.match(text(restored), /\('B', 'J', 'I', 'L', 'BG'\)/)
  })

  it('restores functions that reference system namespaces', { timeout: 180_000 }, async () => {
    const dir = join(scratch, 'system-refs')
    const first = newSession(dir)
    const withTopLevel: Map<string, BoundTool> = new Map(
      (['read', 'write', 'edit', 'bash', 'glob', 'grep'] as const).map((name) => [name, async () => null]),
    )
    const setup = await first.runCell([
      'def uses_skills():',
      '    return skills is not None',
      'async def uses_skills_async():',
      '    return skills is not None',
      'def uses_system_names():',
      '    return (repl is not None, tools is not None)',
      'def uses_top_tools():',
      '    return (read is not None, write is not None, edit is not None, bash is not None, glob is not None, grep is not None)',
    ].join('\n'), withTopLevel)
    assert.equal(setup.error, undefined, JSON.stringify(setup))
    await first.dispose()
    const second = newSession(dir)
    const cell = await second.runCell('(uses_skills(), await uses_skills_async(), uses_system_names(), uses_top_tools())', withTopLevel)
    assert.equal(cell.error, undefined, JSON.stringify(cell))
    assert.match(text(cell), /\(True, True, \(True, True\), \(True, True, True, True, True, True\)\)/)
    assert.doesNotMatch(text(cell), /could not be restored|must be recreated/)
  })

  it('repl.restart() restores the state at the end of the restarting cell', { timeout: 180_000 }, async () => {
    const session = newSession()
    const cell = await session.runCell('late = "set in the restarting cell"\nawait repl.restart()', noTools())
    assert.equal(cell.error, undefined, JSON.stringify(cell.error))
    assert.match(text(cell), /with the variables saved at the end of this cell/)
    const fresh = await session.runCell('late', noTools())
    assert.equal(fresh.error, undefined, JSON.stringify(fresh.error))
    assert.match(text(fresh), /'set in the restarting cell'/)
  })

  for (const mode of ['w', 'w+', 'x']) {
    for (const savedClosed of [false, true]) {
      it(`repl.restart() preserves files for ${savedClosed ? 'closed' : 'open'} ${mode} handles, including nested handles`, { timeout: 180_000 }, async () => {
        const fixture = mkdtempSync(join(scratch, 'write-handles-'))
        const paths = [join(fixture, 'direct.txt'), join(fixture, 'nested.txt')]
        const contents = ['direct: keep this content\n中文\n', 'nested: keep this content\n中文\n']
        const session = newSession()
        const setup = await session.runCell([
          `file_paths = ${JSON.stringify(paths)}`,
          `file_contents = ${JSON.stringify(contents)}`,
          `saved_mode = ${JSON.stringify(mode)}`,
          'direct_handle = open(file_paths[0], saved_mode, encoding="utf-8")',
          'nested_handles = {"items": [open(file_paths[1], saved_mode, encoding="utf-8")]}',
          'for _handle, _content in zip([direct_handle, nested_handles["items"][0]], file_contents):',
          '    _handle.write(_content)',
          '    _handle.flush()',
          `    ${savedClosed ? '_handle.close()' : 'assert not _handle.closed'}`,
        ].join('\n'), noTools())
        assert.equal(setup.error, undefined, JSON.stringify(setup))
        assert.deepEqual(paths.map((path) => readFileSync(path, 'utf8')), contents)
        const epoch = (await session.panelObservation()).epoch
        const restart = await session.runCell('await repl.restart()', noTools())
        assert.equal(restart.error, undefined, JSON.stringify(restart))
        const restored = await session.runCell([
          'for _handle, _path, _content in zip([direct_handle, nested_handles["items"][0]], file_paths, file_contents):',
          '    assert _handle.closed, "restored handles must be closed placeholders"',
          '    assert _handle.name == _path and _handle.mode == saved_mode',
          '    for _operation in (lambda: _handle.read(), lambda: _handle.write("must not write")):',
          '        try:',
          '            _operation()',
          '        except ValueError as _error:',
          '            assert "closed" in str(_error)',
          '        else:',
          '            raise AssertionError("a restored file handle performed I/O")',
          '    with open(_path, encoding="utf-8") as _reopened:',
          '        assert _reopened.read() == _content, "explicit reopening must still read the original content"',
          'print("restored handles are closed; explicit reopening preserved both files")',
        ].join('\n'), noTools())
        assert.equal(restored.error, undefined, JSON.stringify(restored))
        assert.match(text(restored), /restored handles are closed; explicit reopening preserved both files/)
        assert.match(text(restored), /\[python-state-restored\]/)
        assert.match(text(restored), /Changes to the working directory and environment variables were not saved/)
        assert.match(text(restored), /Restored file handles are closed placeholders; explicitly reopen files before reading or writing\./)
        assert.ok((await session.panelObservation()).epoch > epoch, 'the assertions ran in a replacement kernel')
        assert.deepEqual(paths.map((path) => readFileSync(path, 'utf8')), contents, 'restoring direct and nested handles must not truncate their files')
        await session.dispose()
        assert.deepEqual(paths.map((path) => readFileSync(path, 'utf8')), contents, 'closing the replacement kernel must preserve the files too')
      })
    }
  }

  it('a value the snapshot cannot hold is named, not silently dropped', { timeout: 180_000 }, async () => {
    const session = newSession()
    assert.equal((await session.runCell('kept = 1\ngen = (i for i in range(3))', noTools())).error, undefined)
    assert.equal((await session.runCell('await repl.restart()', noTools())).error, undefined)
    const fresh = await session.runCell('kept', noTools())
    assert.equal(fresh.error, undefined, JSON.stringify(fresh.error))
    assert.match(text(fresh), /1 name is back\.\nVariables[^\n]*: kept\./)
    assert.match(text(fresh), /never saved and must be recreated if needed: gen\./)
  })

  it('a crashed kernel comes back with the last automatic snapshot', { timeout: 180_000 }, async () => {
    const session = newSession()
    assert.equal((await session.runCell('saved_before = 7', noTools())).error, undefined)
    await debounce()
    const crash = await session.runCell('import os\nos._exit(3)', noTools())
    assert.equal(crash.error?.kind, 'worker-exit')
    assert.match(crash.error?.message ?? '', /restores the variables saved after the last successful cell/)
    const fresh = await session.runCell('saved_before', noTools())
    assert.equal(fresh.error, undefined, JSON.stringify(fresh.error))
    assert.match(text(fresh), /^7$/m)
    assert.match(text(fresh), /1 name is back\.\nVariables[^\n]*: saved_before\./)
  })

  it('without a state path nothing is saved or claimed', { timeout: 180_000 }, async () => {
    const session = newSession(null)
    assert.equal((await session.runCell('y = 1', noTools())).error, undefined)
    assert.equal((await session.runCell('await repl.restart()', noTools())).error, undefined)
    const fresh = await session.runCell('"y" in globals()', noTools())
    assert.equal(fresh.error, undefined, JSON.stringify(fresh.error))
    assert.match(text(fresh), /^False$/m)
    assert.doesNotMatch(text(fresh), /python-state-restored/)
  })
})
