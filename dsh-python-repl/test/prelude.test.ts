/**
 * Common standard-library names are bound before the first cell.
 *
 * The defect (sessions 2026-10-07/08, e.g. 9af1638d): a model imported `json`
 * in a `bash` subprocess, or in a kernel that was later replaced, then used it
 * in this kernel and got `NameError: name 'json' is not defined` — one wasted
 * cell each time. These names must just work, without turning into "system"
 * names: the model may import or rebind them and nothing may warn, list them as
 * its own variables, save them for revival or report them as lost.
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ReplSession } from '../src/session.ts'
import { CELL_INSTRUCTIONS } from '../src/prompt.ts'
import type { BoundTool } from '../src/lease.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const PYTHON = process.env['DSH_PY'] ?? 'python3'
const scratch = mkdtempSync(join(tmpdir(), 'dsh-prelude-'))

const sessions: ReplSession[] = []
function newSession(): ReplSession {
  const session = new ReplSession({
    python: PYTHON,
    vendorRoot: join(root, 'vendor', 'prime'),
    pythonRoot: join(root, 'python'),
    cwd: scratch,
  })
  sessions.push(session)
  return session
}
const noTools = (): Map<string, BoundTool> => new Map()
const text = (r: { logs: string[] }): string => r.logs.join('\n')

after(async () => {
  await Promise.all(sessions.map((s) => s.dispose()))
  rmSync(scratch, { recursive: true, force: true })
})

/** The names python/prelude.py binds, read from its source so the prompt cannot drift. */
function preludeNames(): string[] {
  const source = readFileSync(join(root, 'python', 'prelude.py'), 'utf8')
  const block = source.slice(source.indexOf('NAMES: dict'), source.indexOf('\n}\n'))
  return [...block.matchAll(/^\s+"(\w+)": \(/gm)].map((m) => m[1]!)
}

describe('preloaded standard-library names', () => {
  it('work in the first cell without an import', async () => {
    const session = newSession()
    const cell = await session.runCell(
      '(json.dumps({"a": 1}), Path("/x/y.txt").name, Counter("aab")["a"], os.sep, re.escape("."),\n'
      + ' sys.version_info[0], time.time() > 0, defaultdict(list)["k"], timedelta(days=2).days, timezone.utc)',
      noTools(),
    )
    assert.equal(cell.error, undefined, JSON.stringify(cell.error))
    assert.match(text(cell), /\('\{"a": 1\}', 'y\.txt', 2, '\/', '\\\\\.', 3, True, \[\], 2, datetime\.timezone\.utc\)/)
  })

  it('stay out of the user listing, and are found when asked for', async () => {
    const session = newSession()
    await session.runCell('rows = [1, 2]', noTools())
    const cell = await session.runCell(
      'everything = [i["name"] for i in (await repl.list(limit=500))["items"]]\n'
      + 'mine = [i["name"] for i in (await repl.list(origin="user", limit=500))["items"]]\n'
      + 'asked = sorted(i["name"] for i in (await repl.list(origin="preloaded", limit=500))["items"])\n'
      + 'helpers = (await repl.helpers())["items"]\n'
      + '(sorted(n for n in everything if n in ("json", "Path", "Counter", "rows")), mine,\n'
      + ' asked, helpers, (await repl.describe("Path"))["origin"])',
      noTools(),
    )
    assert.equal(cell.error, undefined, JSON.stringify(cell.error))
    const expected = [...preludeNames()].sort().map((n) => `'${n}'`).join(', ')
    assert.match(text(cell), new RegExp(`^\\(\\['rows'\\], \\['everything', 'rows'\\], \\[${expected}\\], \\[\\], 'preloaded'\\)`, 'm'))
  })

  it('may be imported again or rebound without any warning', async () => {
    const session = newSession()
    const cells = [
      'import json, os.path\nfrom pathlib import Path\nfrom collections import Counter, defaultdict',
      'json = {"mine": True}\nPath = "not a class"\ndel Counter',
      'from typing import Counter\nimport math as re',
    ]
    for (const code of cells) {
      const cell = await session.runCell(code, noTools())
      assert.equal(cell.error, undefined, JSON.stringify(cell.error))
      assert.doesNotMatch(text(cell), /system binding|restore_binding|shadow/i, code)
    }
    const check = await session.runCell(
      '((await repl.describe("json"))["origin"], "shadowed" in (await repl.describe("json")), json, re.__name__)',
      noTools(),
    )
    assert.equal(check.error, undefined, JSON.stringify(check.error))
    assert.match(text(check), /\('user', False, \{'mine': True\}, 'math'\)/)
  })

  it('the prompt names exactly what the kernel binds', () => {
    const line = CELL_INSTRUCTIONS.split('\n').find((l) => l.startsWith('- Already bound in every kernel')) ?? ''
    const named = [...line.split('Anything else')[0]!.matchAll(/`(\w+)`/g)].map((m) => m[1]!).sort()
    assert.deepEqual(named, [...preludeNames(), 'asyncio'].sort())
    assert.match(line, /a `bash` subprocess or an earlier kernel/)
  })
})
