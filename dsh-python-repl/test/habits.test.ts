/**
 * Repetition notes end to end: kernel → bootstrap._end_cell → cell logs.
 * The detection rules themselves are unit-tested in test/python/test_habits.py.
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
  const session = new ReplSession({ python: PYTHON, vendorRoot: join(root, 'vendor', 'prime'), pythonRoot: join(root, 'python') })
  sessions.push(session)
  return session
}
const noTools = (): Map<string, BoundTool> => new Map()
after(async () => {
  await Promise.all(sessions.map((s) => s.dispose()))
})

// Big enough (>= 50 shaped nodes) to be noted on its 2nd occurrence.
const block = (word: string): string => [
  `text = "a ${word} b\\nc ${word} d\\n" * 3`,
  `rows = [l.split(" ", 1) for l in text.splitlines() if l.strip()]`,
  `hits = [h for h, rest in rows if "${word}" in rest]`,
  `if hits:`,
  `    summary = ", ".join(h[:8] for h in hits)`,
  `    counts = {h: sum(1 for x, _ in rows if x == h) for h in hits}`,
  `    top = sorted(counts.items(), key=lambda kv: -kv[1])[:3]`,
  `len(rows), hits`,
].join('\n')

const NOTE = /\[dsh-python-repl\] Repeated code: .* 2nd time/

describe('repetition notes', () => {
  it('notes the second occurrence of a big block, once', async () => {
    const session = newSession()
    const first = await session.runCell(block('alpha'), noTools())
    assert.equal(first.error, undefined, JSON.stringify(first))
    assert.doesNotMatch(first.logs.join('\n'), /Repeated code/)
    const second = await session.runCell(block('beta'), noTools())
    assert.match(second.logs.join('\n'), NOTE)
    const third = await session.runCell(block('gamma'), noTools())
    assert.doesNotMatch(third.logs.join('\n'), /Repeated code/)
  })

  it('a failed cell is not counted: its retry is not repetition', async () => {
    const session = newSession()
    const failed = await session.runCell(block('alpha') + '\nraise ValueError("boom")', noTools())
    assert.notEqual(failed.error, undefined)
    const retry = await session.runCell(block('alpha'), noTools())
    assert.doesNotMatch(retry.logs.join('\n'), /Repeated code/)
  })

  it('repl.helpers lists your own functions with signature and docstring', async () => {
    const session = newSession()
    await session.runCell('def hits(text, word="x"):\n    """Lines containing word."""\n    return [l for l in text.splitlines() if word in l]\nclass Box:\n    pass', noTools())
    const result = await session.runCell('await repl.helpers()', noTools())
    const text = result.logs.join('\n')
    assert.match(text, /helpers · 2/)
    assert.match(text, /hits\(text, word=<str>\)\s+— Lines containing word\./)
    assert.match(text, /Box\s+— \(no docstring/)
  })
})
