import { strict as assert } from 'node:assert'
import { after, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ReplSession } from '../src/session.ts'
import type { BoundTool } from '../src/lease.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const session = new ReplSession({ python: process.env['DSH_PY'] ?? 'python3', vendorRoot: join(root, 'vendor', 'prime'), pythonRoot: join(root, 'python') })
after(() => session.dispose())

it('public read_window validates cursor, rejects known truncation, never claims losslessness', async () => {
  const tools = new Map<string, BoundTool>([['read', async () => ({ path: '/fixture', offset: 1, totalLines: 3,
    lines: [{ number: 1, text: 'a' }, { number: 2, text: 'b' }] })]])
  const cell = await session.runCell(`r = await read({"file_path": "/fixture"})
w = await repl.read_window(r, offset=1, limit=2000)
assert w["next_offset"] == 3 and w["byte_completeness"] == "unknown"
try:
    await repl.require_complete(r)
except ValueError as exc:
    assert "byte completeness" in str(exc)
else:
    raise AssertionError("read completeness was accepted")
r["lines"][1]["text"] = "b... (line truncated to 2000 chars)"
try:
    await repl.read_window(r)
except ValueError as exc:
    assert "truncation marker" in str(exc)
else:
    raise AssertionError("known truncation was accepted")
True`, tools)
  assert.equal(cell.error, undefined, JSON.stringify(cell.error))
  assert.match(cell.logs.join(''), /True/)
})

it('real kernel displays short write/edit values while preserving full data across cells', async () => {
  const value = { path: '/fixture', before: 'OLD'.repeat(400000), after: 'NEW'.repeat(400000) }
  const tools = new Map<string, BoundTool>([['write', async () => value], ['edit', async () => value]])
  for (const tool of ['write', 'edit']) {
    const cell = await session.runCell(`saved = await ${tool}({"file_path": "/fixture"})
print(saved)
saved`, tools)
    assert.equal(cell.error, undefined)
    assert.ok(cell.logs.join('').length < 2500)
    assert.doesNotMatch(cell.logs.join(''), /OLDOLD|NEWNEW/)
    const next = await session.runCell('len(saved["after"]), len(_["before"])', tools)
    assert.equal(next.error, undefined)
    assert.match(next.logs.join(''), /1200000/)
  }
})
