/**
 * `repl`: the agent's view of its own kernel.
 *
 * The hard requirement is that introspection is READ-ONLY: listing variables
 * must not call user `__repr__`/`__len__`/properties, because that would run
 * arbitrary code (and, with a hostile or expensive object, hang the cell).
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ReplSession } from '../src/session.ts'
import type { BoundTool } from '../src/lease.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const PYTHON = process.env['DSH_PY'] ?? 'python3'

const sessions: ReplSession[] = []
function newSession(): ReplSession {
  const session = new ReplSession({
    python: PYTHON,
    vendorRoot: join(root, 'vendor', 'prime'),
    pythonRoot: join(root, 'python'),
  })
  sessions.push(session)
  return session
}
const noTools = (): Map<string, BoundTool> => new Map()

after(async () => {
  await Promise.all(sessions.map((s) => s.dispose()))
})

describe('repl.info', () => {
  it('reports the live kernel, and never claims to be idle from inside a cell', async () => {
    const session = newSession()
    const result = await session.runCell('(await repl.info())["state"]', noTools())
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.match(result.logs.join(''), /running-this-cell/)
  })

  it('reports the interpreter actually running', async () => {
    const session = newSession()
    const result = await session.runCell('(await repl.info())["python"]', noTools())
    assert.match(result.logs.join(''), /3\.\d+\.\d+/)
  })
})

describe('repl.list', () => {
  it('shows user variables with a safe summary', async () => {
    const session = newSession()
    await session.runCell('rows = [1, 2, 3]\nlabel = "hello"', noTools())
    const result = await session.runCell(
      'names = (await repl.list(origin="user"))["items"]\n'
      + '{i["name"]: i["summary"] for i in names if i["name"] in ("rows", "label")}',
      noTools(),
    )
    const text = result.logs.join('')
    assert.match(text, /'rows': 'list, len=3'/)
    assert.match(text, /'label': 'str, len=5'/)
  })

  it('filters by kind', async () => {
    const session = newSession()
    await session.runCell('def helper():\n    return 1\nvalue = 2', noTools())
    const result = await session.runCell(
      '[i["name"] for i in (await repl.list(kind="function", origin="user"))["items"]]',
      noTools(),
    )
    assert.match(result.logs.join(''), /helper/)
    assert.ok(!result.logs.join('').includes('value'))
  })

  it('does not list internal housekeeping aliases as imports', async () => {
    const session = newSession()
    await session.runCell('1', noTools())
    const result = await session.runCell(
      '[i["name"] for i in (await repl.list(origin="import"))["items"] if i["name"] in ("_b", "_j", "_i", "_l", "_bg")]',
      noTools(),
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.equal(result.logs.join('').trim(), '[]')
  })

  it('does NOT execute a user __repr__ or __len__ while listing', async () => {
    const session = newSession()
    await session.runCell(
      'side_effects = []\n'
      + 'class Hostile:\n'
      + '    def __repr__(self):\n'
      + '        side_effects.append("repr")\n'
      + '        return "boom"\n'
      + '    def __len__(self):\n'
      + '        side_effects.append("len")\n'
      + '        return 1\n'
      + '    @property\n'
      + '    def trap(self):\n'
      + '        side_effects.append("property")\n'
      + '        return 1\n'
      + 'danger = Hostile()\n',
      noTools(),
    )
    await session.runCell('await repl.list()', noTools())
    const check = await session.runCell('side_effects', noTools())
    assert.match(check.logs.join(''), /\[\]/, 'introspection must not run user code')
  })

  it('continues across real cells without bookkeeping names breaking pagination', async () => {
    const session = newSession()
    await session.runCell('for i in range(25):\n    globals()[f"row_{i:02}"] = [i]', noTools())
    const first = await session.runCell('page = await repl.list(query="row_", limit=10)\nnames = [i["name"] for i in page["items"]]', noTools())
    assert.equal(first.error, undefined)
    const result = await session.runCell(
      'while page["next_cursor"] is not None:\n'
      + '    page = await repl.list(query="row_", limit=10, cursor=page["next_cursor"])\n'
      + '    names += [i["name"] for i in page["items"]]\n'
      + '(len(names), len(set(names)), names[-1], page["next_cursor"])', noTools())
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.match(result.logs.join(''), /\(25, 25, 'row_24', None\)/)
  })

  it('bounds its output', async () => {
    const session = newSession()
    await session.runCell(
      'for i in range(100):\n    globals()[f"var_{i}"] = i\n',
      noTools(),
    )
    const result = await session.runCell(
      'r = await repl.list(limit=10)\n(len(r["items"]), r["next_cursor"] is not None)',
      noTools(),
    )
    assert.match(result.logs.join(''), /\(10, True\)/)
  })
})

describe('repl.describe', () => {
  it('gives a real signature and definition site for a user function', async () => {
    const session = newSession()
    await session.runCell('def add(a, b=2):\n    """Add two numbers."""\n    return a + b', noTools())
    const result = await session.runCell(
      'd = await repl.describe("add")\n(d["kind"], d["signature"], d["doc"])',
      noTools(),
    )
    const text = result.logs.join('')
    assert.match(text, /'function'/)
    assert.match(text, /add\(a, b=2\)/)
    assert.match(text, /Add two numbers\./)
  })

  it('lists public methods and docstrings for repl and tools', async () => {
    const session = newSession()
    const result = await session.runCell(
      'r = await repl.describe("repl")\n'
      + 't = await repl.describe("tools")\n'
      + '([m["name"] for m in r["methods"]], [m["doc"] for m in r["methods"] if m["name"] == "install"], [m["name"] for m in t["methods"]])',
      noTools(),
    )
    const text = result.logs.join('')
    assert.match(text, /'install'/)
    assert.match(text, /install/)
    assert.match(text, /'describe', 'list'/)
  })

  it('reports an unbound name instead of raising', async () => {
    const session = newSession()
    const result = await session.runCell('(await repl.describe("nope"))["status"]', noTools())
    assert.equal(result.error, undefined)
    assert.match(result.logs.join(''), /unbound/)
  })

  it('describe advice does not depend on an overwritten repl', async () => {
    const session = newSession()
    await session.runCell('saved_repl = repl\nrepl = "clobbered"', noTools())
    const result = await session.runCell('(await saved_repl.describe("repl"))["reason"]', noTools())
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.match(result.logs.join(''), /import bootstrap/)
    assert.doesNotMatch(result.logs.join(''), /call await repl\.restore_binding/)
  })

  it('flags a shadowed system binding and names the fix', async () => {
    const session = newSession()
    await session.runCell('tools = "clobbered"', noTools())
    const result = await session.runCell('d = await repl.describe("tools")\n(d["shadowed"], d["reason"])', noTools())
    const text = result.logs.join('')
    assert.match(text, /True/)
    assert.match(text, /restore_binding/)
  })
})

describe('shadowed-binding warning', () => {
  it('warns in the same cell that clobbers a system name', async () => {
    // The tool must actually be GRANTED for its name to be a system binding:
    // a deployment that never exposed `bash` has nothing to warn about.
    const session = newSession()
    const tools = new Map<string, BoundTool>([['bash', async () => null]])
    await session.runCell('1', tools)
    const result = await session.runCell('bash = "not a tool anymore"', tools)
    const text = result.logs.join('')
    assert.match(text, /system binding\(s\) replaced/)
    assert.match(text, /bash/)
    assert.match(text, /restore_binding/)
  })

  it('says it once, and again only when the set of replaced names changes', async () => {
    const session = newSession()
    const tools = new Map<string, BoundTool>([['glob', async () => null], ['bash', async () => null]])
    const notices = async (code: string) => (await session.runCell(code, tools)).logs.join('').match(/system binding\(s\) replaced/g)?.length ?? 0
    assert.equal(await notices('import glob'), 1)
    assert.match((await session.runCell('import glob as _g; _g', tools)).logs.join(''), /module 'glob'/)
    assert.equal(await notices('x = 1'), 0, 'an unchanged replacement is not repeated every cell')
    assert.equal(await notices('bash = 2'), 1, 'a newly replaced name is reported')
  })

  it('names the parenthesized await when a coroutine is indexed', async () => {
    const session = newSession()
    const result = await session.runCell('async def rows():\n    return [1, 2]\nawait rows()[0]', noTools())
    assert.match(result.error?.message ?? '', /`rows\(\)` is async and was not awaited yet: write `\(await rows\(\)\)\[0\]`/)
  })

  it('stays quiet when nothing is shadowed', async () => {
    const session = newSession()
    const result = await session.runCell('ordinary = 1', noTools())
    assert.ok(!result.logs.join('').includes('system binding'))
  })

  it('restore_binding puts the tool proxy back', async () => {
    const session = newSession()
    const tools = new Map<string, BoundTool>([['bash', async () => ({ stdout: 'real' })]])
    await session.runCell('bash = "clobbered"', tools)
    const restored = await session.runCell('(await repl.restore_binding("bash"))["restored"]', tools)
    assert.match(restored.logs.join(''), /True/)
    const usable = await session.runCell('(await bash({"command": "x"}))["stdout"]', tools)
    assert.equal(usable.error, undefined, JSON.stringify(usable))
    assert.match(usable.logs.join(''), /real/)
  })

  it('refuses to "restore" a name the bridge does not own', async () => {
    const session = newSession()
    const result = await session.runCell(
      'r = await repl.restore_binding("my_variable")\n(r["restored"], r["reason"])',
      noTools(),
    )
    assert.match(result.logs.join(''), /False/)
    assert.match(result.logs.join(''), /not a bridge-managed binding/)
  })
})
