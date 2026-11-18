/** Shared lists must remain one object through the real kernel's restart and name lifecycle. */
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { BoundTool } from '../src/lease.ts'
import { ReplSession } from '../src/session.ts'
import { testKernelPython } from './fixtures/test-kernel.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

async function withKernel(run: (cell: (code: string) => Promise<void>, session: ReplSession, state: string) => Promise<void>,
  tools = new Map<string, BoundTool>()) {
  const python = await testKernelPython()
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-shared-refs-'))
  const state = join(cwd, 'state')
  const session = new ReplSession({ python, vendorRoot: join(root, 'vendor', 'prime'), pythonRoot: join(root, 'python'),
    cwd, statePath: state, startupTimeoutMs: 60_000 })
  try {
    await run(async (code) => {
      const result = await session.runCell(code, tools)
      assert.equal(result.error, undefined, [...result.logs, result.error?.message].join('\n'))
    }, session, state)
  } finally {
    await session.dispose()
    await rm(cwd, { recursive: true, force: true })
  }
}

it('preserves direct and nested aliases on a kernel restart', { timeout: 120_000 }, async () => {
  await withKernel(async (cell) => {
    await cell('items = []\nalias = items\nbox = {"rows": (items,)}\nother = []')
    await cell('await repl.restart()')
    await cell('assert alias is items is box["rows"][0]\nassert other is not items\n'
      + 'alias.append(17)\nassert box["rows"][0].pop() == 17 and items == []')
  })
})

it('keeps edits through a live alias after 100 idle cells and a manual archive attempt', { timeout: 180_000 }, async () => {
  await withKernel(async (cell, session, state) => {
    await cell('older = []\nalias = older\nbox = {"rows": (older,)}\nindependent = []')
    for (let i = 0; i < 100; i++) await cell(`box["rows"][0].append(${i})`)
    const records = JSON.parse(await readFile(join(state, 'lifecycle.json'), 'utf8'))
    assert.ok('independent' in records.archived, 'the ordinary archive threshold was reached')
    assert.equal((await session.panelNameAction('archive', 'older')).ok, false)
    await cell('assert older is alias is box["rows"][0]\nassert older == list(range(100))\n'
      + 'alias.clear()\nassert box["rows"][0] == []')
  })
})

it('keeps the shared list and row returned by the grep helper across restart and archive', { timeout: 180_000 }, async () => {
  const tools = new Map<string, BoundTool>([['grep', async () => ({
    matches: [{ path: 'sample.txt', lineNumber: 1, line: 'item' }],
  })]])
  await withKernel(async (cell) => {
    await cell('result = await grep(pattern="item")\nrows = result.matches\nrow = rows[0]')
    await cell('await repl.restart()')
    await cell('assert rows is result.matches and row is rows[0]\nrow["line"] = "edited"\nassert result.matches[0].line == "edited"')
    for (let i = 0; i < 100; i++) await cell('rows[0]["lineNumber"] += 1')
    await cell('assert result.matches is rows and row is rows[0]\nassert row.lineNumber == 101\n'
      + 'assert result.matches.pop() is row and rows == []')
  }, tools)
})

