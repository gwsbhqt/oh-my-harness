/**
 * Adjacent stream output must arrive as it was written, not as fragments.
 *
 * CPython's `print` calls `write()` once per argument AND once per separator:
 * `print("x:", 42)` produces `"x:"`, `" "`, `"42"`, `"\n"` — four calls. The
 * kernel emits one frame per call, so the model used to receive four separate
 * log entries for a single print. In a long task every `print("label:", v)`
 * became a cluster of short lines with blank gaps between them (reported from
 * a real session, 2026-09-22).
 *
 * The fix joins CONSECUTIVE stream frames. The boundaries that must survive:
 *
 * - `result` (the trailing expression) is a different kind of output and must
 *   never be glued onto preceding prints.
 * - stdout and stderr must not merge into each other.
 * - separate cells must never share a buffer.
 *
 * Those boundaries are why this is not a blind `join('')`.
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

describe('print output arrives whole', () => {
  it('keeps a multi-argument print on one line', async () => {
    const session = newSession()
    const result = await session.runCell('print("alpha", "beta", "gamma")', noTools())
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.deepEqual(
      result.logs,
      ['alpha beta gamma\n'],
      'one print is one piece of output, not one entry per argument',
    )
  })

  it('keeps the common label-then-value shape intact', async () => {
    const session = newSession()
    const result = await session.runCell('print("count:", 42)', noTools())
    assert.deepEqual(result.logs, ['count: 42\n'])
  })

  it('joins several prints into one run of text', async () => {
    const session = newSession()
    const result = await session.runCell('print("a")\nprint("b")\nprint("c")', noTools())
    assert.deepEqual(result.logs, ['a\nb\nc\n'], 'consecutive stream output is one block')
  })

  it('does NOT glue the trailing expression onto preceding output', async () => {
    // The result is a different kind of output; merging it would make the
    // displayed value indistinguishable from whatever was printed before it.
    const session = newSession()
    const result = await session.runCell('print("printed")\n1 + 1', noTools())
    assert.deepEqual(result.logs, ['printed\n', '2'])
  })

  it('does not merge stdout into stderr', async () => {
    const session = newSession()
    const result = await session.runCell(
      'import sys\nprint("to stdout")\nprint("to stderr", file=sys.stderr)\nsys.stderr.flush()',
      noTools(),
    )
    const joined = result.logs.join('')
    assert.match(joined, /to stdout/)
    assert.match(joined, /to stderr/)
    assert.ok(
      !result.logs.some((entry) => /to stdout/.test(entry) && /to stderr/.test(entry)),
      'the two streams must stay distinguishable',
    )
  })

  it('keeps each cell output to its own cell', async () => {
    const session = newSession()
    const a = await session.runCell('print("cell one")', noTools())
    const b = await session.runCell('print("cell two")', noTools())
    assert.deepEqual(a.logs, ['cell one\n'])
    assert.deepEqual(b.logs, ['cell two\n'])
  })

  it('preserves the exact text, including deliberate blank lines', async () => {
    const session = newSession()
    const result = await session.runCell('print("top\\n\\nbottom")', noTools())
    assert.deepEqual(result.logs, ['top\n\nbottom\n'], 'coalescing must not rewrite content')
  })

  it('does not swallow output written without a trailing newline', async () => {
    const session = newSession()
    const result = await session.runCell('print("no newline", end="")\n"done"', noTools())
    assert.deepEqual(result.logs, ['no newline', "'done'"])
  })
})
