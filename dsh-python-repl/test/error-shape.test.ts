/**
 * What a failed cell shows the model (python/cell_errors.py): its own lines,
 * one marker for frames elsewhere, the message once, and an actionable line
 * for common tool failures. Real kernel; tools are host fixtures.
 */
import { strict as assert } from 'node:assert'
import { after, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ReplSession } from '../src/session.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'dsh-error-shape-'))
writeFileSync(join(dir, 'buggylib.py'), 'def run(x):\n    return helper(x)\n\ndef helper(x):\n    return x + "s"\n')
const session = new ReplSession({ python: process.env['DSH_PY'] ?? 'python3', vendorRoot: join(root, 'vendor', 'prime'), pythonRoot: join(root, 'python'), cwd: dir })
after(async () => { await session.dispose(); rmSync(dir, { recursive: true, force: true }) })
const message = (cell: { error?: { message: string } }) => cell.error?.message ?? ''
const count = (text: string, part: string) => text.split(part).length - 1

it('skill error labels recognize both skill roots and source packages',async()=>{
  assert.equal(message(await session.runCell('import cell_errors\nassert cell_errors._where("/checkout/skills/demo-tool/src/demo/api.py") == ("library", "skill demo-tool")\nassert cell_errors._where("/checkout/extensions/demo/src/demo_skill/api.py") == ("library", "skill demo-skill")',new Map())), '')
})

it('a failed tool call: the cell line, one marker, the message once, and what to do', async () => {
  const tools = new Map([['read', async () => { throw new Error('cannot read "/x/y.py": not found') }]])
  const text = message(await session.runCell('x = 1\nr = await read({"file_path": "/x/y.py"})', tools))
  assert.match(text, /^ToolCallError: cannot read "\/x\/y\.py": not found/)
  assert.equal(count(text, 'cannot read "/x/y.py": not found'), 1, text)
  assert.match(text, /File "<cell-\d+>", line 2/)
  assert.match(text, /\[\d+ frames? inside the DSH bridge not shown\]/)
  assert.doesNotMatch(text, /dsh_kernel\.py|dsh_kernel\.ToolCallError/)
  assert.match(text, /\/x does not exist either; the deepest existing directory is \/\. await glob/)
})

it('a stdlib error keeps the cell line and folds the library frames', async () => {
  const text = message(await session.runCell('import json\njson.loads("not json")', new Map()))
  assert.match(text, /^JSONDecodeError: Expecting value/)
  assert.match(text, /\[\d+ frames? inside json not shown\]/)
  assert.doesNotMatch(text, /decoder\.py/)
})

it('a bug inside a library keeps the frame that raised it', async () => {
  const text = message(await session.runCell('import buggylib\nbuggylib.run(1)', new Map()))
  assert.match(text, /^TypeError: unsupported operand/)
  assert.match(text, /buggylib\.py", line 5, in helper/)
  assert.match(text, /\[1 frame inside buggylib\.py not shown\]/)
})

it('the session\'s own functions keep every frame', async () => {
  assert.equal(message(await session.runCell('def outer():\n    return inner()\n\ndef inner():\n    return {}["k"]', new Map())), '')
  const text = message(await session.runCell('outer()', new Map()))
  assert.match(text, /in outer/)
  assert.match(text, /in inner/)
  assert.doesNotMatch(text, /not shown/)
})

it('a missing key on a tool result names its keys; slicing it says it is a dict', async () => {
  const tools = new Map([['read', async () => ({ path: '/a', offset: 1, lines: [{ number: 1, text: 'hi' }], totalLines: 1 })]])
  assert.equal(message(await session.runCell('r = await read({"file_path": "/a"})\nassert r["text"] == r.text == "hi"', tools)), '')
  const text = message(await session.runCell('r["body"]', new Map()))
  assert.match(text, /'body' is not a key of this tool result; its keys are 'path', 'offset', 'lines', 'totalLines'/)
  const sliced = message(await session.runCell('r[:10]', new Map()))
  assert.match(sliced, /is a dict, not text or a list, so it cannot be sliced/)
})

it('awaiting a plain value names the synchronous function and says to remove await, once', async () => {
  const text = message(await session.runCell('def sync():\n    return {"a": 1}\nawait sync()', new Map()))
  assert.match(text, /can't be awaited/)
  assert.match(text, /`sync` is a plain \(synchronous\) function: it already returned a dict, so remove the `await`/)
  assert.equal(count(text, 'remove the `await`'), 1, text)
  assert.doesNotMatch(text, /drop `await`/)
})

it('a call with a parameter the function does not take lists its real parameters', async () => {
  const text = message(await session.runCell('class Snap:\n    def find(self, role=None, name=None):\n        pass\nsnap = Snap()\nsnap.find(idx=2)', new Map()))
  assert.match(text, /unexpected keyword argument 'idx'/)
  assert.match(text, /`snap\.find` takes find\(role=None, name=None\): pass only these parameters/)
})

it('an edit that matched several places says how to fix it', async () => {
  const tools = new Map([['edit', async () => { throw new Error('old_string matched 3 times in "/a.py"') }]])
  const text = message(await session.runCell('await edit({"file_path": "/a.py", "old_string": "x", "new_string": "y"})', tools))
  assert.match(text, /Make old_string longer so it matches exactly one place, or pass replace_all=True/)
  const host = message(await session.runCell('await edit({"file_path": "/a.py", "old_string": "x", "new_string": "y"})',
    new Map([['edit', async () => { throw new Error('old_string matched 2 times in "/a.py"; provide a more specific old_string or set replace_all to true') }]])))
  assert.doesNotMatch(host, /Make old_string longer/, 'the host already said what to do')
})
