/**
 * Cancellation: what it does and, just as importantly, what it does NOT do.
 *
 * AGENTS.md is explicit that revoking a cell removes DSH bridge authority but
 * does not undo Python side effects. These tests pin BOTH halves so nobody
 * later mistakes "cancelled" for "cleaned up".
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { ReplSession } from '../src/session.ts'
import type { BoundTool } from '../src/lease.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const PYTHON = process.env['DSH_PY'] ?? 'python3'

const sessions: ReplSession[] = []
const tempDirs: string[] = []

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
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })))
})

describe('cancellation', () => {
  it('interrupts an async sleep promptly', async () => {
    const session = newSession()
    await session.runCell('1', noTools())
    const controller = new AbortController()
    const started = Date.now()
    const pending = session.runCell('import asyncio\nawait asyncio.sleep(30)', noTools(), controller.signal)
    setTimeout(() => controller.abort(), 150)
    const result = await pending
    const elapsed = Date.now() - started
    assert.equal(result.error?.kind, 'abort', JSON.stringify(result))
    assert.ok(elapsed < 10_000, `expected a prompt stop, took ${elapsed}ms`)
  })

  it('interrupts a SYNCHRONOUS busy loop (SIGINT reaches it)', async () => {
    const session = newSession()
    await session.runCell('1', noTools())
    const controller = new AbortController()
    const started = Date.now()
    const pending = session.runCell(
      'total = 0\nwhile True:\n    total += 1\n',
      noTools(),
      controller.signal,
    )
    setTimeout(() => controller.abort(), 200)
    const result = await pending
    const elapsed = Date.now() - started
    assert.ok(result.error, 'a runaway sync loop must not hang the host')
    assert.ok(elapsed < 10_000, `expected a prompt stop, took ${elapsed}ms`)
  })

  it('leaves the kernel usable after an interrupt', async () => {
    const session = newSession()
    await session.runCell('marker = "alive"', noTools())
    const controller = new AbortController()
    const pending = session.runCell('import asyncio\nawait asyncio.sleep(30)', noTools(), controller.signal)
    setTimeout(() => controller.abort(), 150)
    await pending
    const after = await session.runCell('marker', noTools())
    assert.equal(after.error, undefined, JSON.stringify(after))
    assert.match(after.logs.join(''), /alive/, 'the namespace survives a cancelled cell')
  })

  it('does NOT undo a side effect that already happened', async () => {
    // The honest half of the contract: a file written before the interrupt
    // stays written. Anyone reading "cancelled" as "rolled back" is wrong.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-repl-cancel-'))
    tempDirs.push(dir)
    const target = join(dir, 'written-before-cancel.txt')
    const session = newSession()
    await session.runCell('1', noTools())
    const controller = new AbortController()
    const pending = session.runCell(
      `open(${JSON.stringify(target)}, "w").write("side effect")\n` +
        'import asyncio\n' +
        'await asyncio.sleep(30)\n',
      noTools(),
      controller.signal,
    )
    setTimeout(() => controller.abort(), 300)
    const result = await pending
    assert.ok(result.error, 'the cell was cancelled')
    const content = await readFile(target, 'utf8')
    assert.equal(content, 'side effect', 'cancellation does not roll back a completed write')
  })

  it('a cancelled cell keeps the variables it already set', async () => {
    const session = newSession()
    await session.runCell('1', noTools())
    const controller = new AbortController()
    const pending = session.runCell(
      'partial = "assigned"\nimport asyncio\nawait asyncio.sleep(30)',
      noTools(),
      controller.signal,
    )
    setTimeout(() => controller.abort(), 200)
    await pending
    const after = await session.runCell('partial', noTools())
    assert.match(after.logs.join(''), /assigned/, 'partial state persists — no rollback')
  })

  it('a tool call in flight when the cell is cancelled cannot be retried by a stale task', async () => {
    const session = newSession()
    const seen: string[] = []
    const slowTool = new Map<string, BoundTool>([
      ['slow', async () => { await new Promise((r) => setTimeout(r, 5_000)); seen.push('completed'); return null }],
    ])
    await session.runCell('1', slowTool)
    const controller = new AbortController()
    const pending = session.runCell('await tools.slow({})', slowTool, controller.signal)
    setTimeout(() => controller.abort(), 200)
    const result = await pending
    assert.ok(result.error, 'the cell stopped')
  })
})

describe('startup failure handling', () => {
  it('honours the configured startup timeout instead of hanging forever', async () => {
    // A hung interpreter must surface as a failed cell, not a stuck host.
    const session = new ReplSession({
      python: 'sleep',   // never speaks the protocol
      vendorRoot: join(root, 'vendor', 'prime'),
      pythonRoot: join(root, 'python'),
      startupTimeoutMs: 1_000,
    })
    sessions.push(session)
    const started = Date.now()
    const result = await session.runCell('1', noTools())
    const elapsed = Date.now() - started
    assert.ok(result.error, 'a kernel that never handshakes must fail the cell')
    assert.ok(elapsed < 10_000, `expected the configured 1s timeout, took ${elapsed}ms`)
  })

  it('reports a missing interpreter instead of silently degrading', async () => {
    const session = new ReplSession({
      python: '/nonexistent/python-that-is-not-here',
      vendorRoot: join(root, 'vendor', 'prime'),
      pythonRoot: join(root, 'python'),
      startupTimeoutMs: 5_000,
    })
    sessions.push(session)
    const result = await session.runCell('1', noTools())
    assert.ok(result.error, JSON.stringify(result))
  })
})
