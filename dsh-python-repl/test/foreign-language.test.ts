/**
 * A JS/TS cell fails with a Python SyntaxError; the error then says so.
 * A Python cell with TS inside its strings must NOT be called JavaScript.
 */
import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { foreignLanguageHint } from '../src/hints.ts'
import { ReplSession } from '../src/session.ts'
import type { BoundTool } from '../src/lease.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const sessions: ReplSession[] = []
after(async () => { await Promise.all(sessions.map((s) => s.dispose())) })

describe('foreign-language hint', () => {
  it('names TypeScript when the rejected line is TS', () => {
    const code = 'const r = await tools.read({ file_path: "a" });\nconsole.log(r)'
    assert.match(foreignLanguageHint(code, 'invalid syntax (<cell-3>, line 1)'), /looks like JavaScript\/TypeScript/)
  })

  it('stays silent for a Python quoting slip inside a cell that edits TS', () => {
    const code = 'e = await edit({\n  "file_path": "x.ts",\n  "old_string": "const a = 1",\n  "new_string": "| a | "b" |",\n})'
    assert.equal(foreignLanguageHint(code, 'invalid syntax. Is this intended to be part of the string? (<cell-36>, line 4)'), '')
  })

  it('without a line number, needs two JS signs', () => {
    assert.equal(foreignLanguageHint('x = (a) => a'), '')
    assert.notEqual(foreignLanguageHint('const f = (a) => a\nconsole.log(f(1))'), '')
  })

  it('end to end: a TS cell in the real kernel gets the hint', async () => {
    const session = new ReplSession({ python: process.env['DSH_PY'] ?? 'python3', vendorRoot: join(root, 'vendor', 'prime'), pythonRoot: join(root, 'python') })
    sessions.push(session)
    const result = await session.runCell('const r = await tools.read({ file_path: "a" });\nconsole.log(r);', new Map<string, BoundTool>())
    assert.equal(result.error?.kind, 'exception')
    assert.match(result.error?.message ?? '', /SyntaxError[\s\S]*run_code executes PYTHON/)
  })
})
