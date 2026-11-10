/**
 * What a cell is told about its own output and edit misses, on a real kernel:
 * after a cut, what `_` holds; a soft note on a large output; the closest
 * text when an edit's old_string is not in the file.
 */
import { strict as assert } from 'node:assert'
import { after, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ReplSession } from '../src/session.ts'
import { boundCellOutput } from '../src/output-budget.ts'
import type { BoundTool } from '../src/lease.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = mkdtempSync(join(tmpdir(), 'dsh-output-notes-'))
const sessions: ReplSession[] = []
function session(budget?: number): ReplSession {
  const s = new ReplSession({ python: process.env['DSH_PY'] ?? 'python3', vendorRoot: join(root, 'vendor', 'prime'), pythonRoot: join(root, 'python'),
    ...(budget === undefined ? {} : { boundOutput: (logs: readonly string[]) => boundCellOutput(logs, budget, async () => ({ locator: '/tmp/saved.txt' })) }) })
  sessions.push(s)
  return s
}
after(async () => { await Promise.all(sessions.map((s) => s.dispose())); rmSync(dir, { recursive: true, force: true }) })
const all = (cell: { logs: string[]; error?: { message: string } }) => [...cell.logs, cell.error?.message ?? ''].join('\n')

it('a cut cell says what `_` holds, or that it holds an earlier result', async () => {
  const s = session(200)
  const value = all(await s.runCell('[{"id": i, "name": "n"} for i in range(3000)]', new Map()))
  assert.match(value, /budget for one cell/)
  assert.match(value, /`_` holds this cell's value, a list of 3000 items; items are dicts with keys 'id', 'name'/)
  const printed = all(await s.runCell('print("y" * 20000)', new Map()))
  assert.match(printed, /This cell ended without a value, so `_` still holds an earlier result/)
})

it('a large but uncut output gets one soft note, then not again for ten cells', async () => {
  const s = session()
  assert.match(all(await s.runCell('print("z" * 20000)', new Map())), /This cell displayed about 50\d\d tokens/)
  assert.doesNotMatch(all(await s.runCell('print("z" * 20000)', new Map())), /This cell displayed about/)
})

it('an edit whose old_string is not in the file shows the closest lines', async () => {
  const path = join(dir, 'mod.py')
  writeFileSync(path, 'def total(rows):\n    return sum(r["amount"] for r in rows)\n')
  const tools = new Map<string, BoundTool>([['edit', async () => { throw new Error(`old_string was not found in "${path}"`) }]])
  const text = all(await session().runCell(`await edit({"file_path": ${JSON.stringify(path)}, "old_string": "def total(rows):\\n    return sum(r['amount'] for r in rows)", "new_string": "x"})`, tools))
  assert.match(text, /Closest text in the file \(lines 1-2, \d+% alike\); copy old_string from it:\n1: def total\(rows\):\n2:     return sum\(r\["amount"\] for r in rows\)/)
})
