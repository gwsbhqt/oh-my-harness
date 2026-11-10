/**
 * `sys.exit` in a cell must fail the cell, not end the kernel.
 *
 * Session d63c7d92 (2026-10, twice): a nested triple-quote ended a string
 * early, so a test file's `sys.exit(int(os.environ.get(...)))` ran at the top
 * level. The kernel exited with code 0 and every variable was gone. The
 * vendored kernel catches BaseException around the cell task, but asyncio
 * re-raises SystemExit to the event loop, so that guard never sees it.
 *
 * `os._exit` and signals are deliberately left alone: they are explicit
 * process-level actions, not a mistake Python can turn into an exception.
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ReplSession } from '../src/session.ts'
import type { BoundTool } from '../src/lease.ts'
const pidOf = (r: { logs: string[] }): number => Number(r.logs.join('').trim())

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sessions: ReplSession[] = []
after(async () => { await Promise.all(sessions.map((s) => s.dispose())) })
const noTools = (): Map<string, BoundTool> => new Map()

function newSession(): ReplSession {
  const session = new ReplSession({
    python: process.env['DSH_PY'] ?? 'python3',
    vendorRoot: join(root, 'vendor', 'prime'),
    pythonRoot: join(root, 'python'),
    teardownGraceMs: 2_000,
    interruptGraceMs: 2_000,
  })
  sessions.push(session)
  return session
}

const EXITS: Array<[string, string]> = [
  ['sys.exit(0)', 'import sys\nsys.exit(0)'],
  ['sys.exit(3)', 'import sys\nsys.exit(3)'],
  ['the field case', 'import os, sys\nsys.exit(int(os.environ.get("REMOTE_HOST_STUB_CODE", "0")))'],
  ['exit()', 'exit()'],
  ['quit(2)', 'quit(2)'],
  ['raise SystemExit', 'raise SystemExit(1)'],
  ['inside an awaited coroutine', 'import sys\nasync def f():\n    sys.exit(4)\nawait f()'],
  ['from a function defined earlier', 'import sys as _s\ndef bail():\n    _s.exit(5)\nbail()'],
]

describe('SystemExit in a cell', () => {
  for (const [label, code] of EXITS) {
    it(`${label}: the cell fails with an explanation and the kernel keeps its variables`, { timeout: 20_000 }, async () => {
      const session = newSession()
      assert.equal((await session.runCell('kept = 41', noTools())).error, undefined)
      const pid = pidOf(await session.runCell('import os; os.getpid()', noTools()))
      const result = await session.runCell(code, noTools())
      assert.equal(result.error?.kind, 'exception', JSON.stringify(result.error))
      assert.match(result.error?.message ?? '', /sys\.exit/)
      assert.match(result.error?.message ?? '', /raise/)
      const next = await session.runCell('kept + 1', noTools())
      assert.equal(next.error, undefined, JSON.stringify(next.error))
      assert.ok(next.logs.includes('42'), 'variables survive')
      assert.equal(pidOf(await session.runCell('import os; os.getpid()', noTools())), pid, 'same kernel process')
    })
  }

  it('a cell may still catch SystemExit itself', { timeout: 20_000 }, async () => {
    const session = newSession()
    const result = await session.runCell(
      'import sys\ntry:\n    sys.exit(7)\nexcept SystemExit as e:\n    code = e.code\ncode',
      noTools(),
    )
    assert.equal(result.error, undefined, JSON.stringify(result.error))
    assert.ok(result.logs.includes('7'))
  })
})
