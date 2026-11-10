/**
 * After a context compaction the cells that made a variable are gone from the
 * conversation; the runtime context names what the kernel still holds, so the
 * model reuses it instead of reading or fetching the data again.
 */

import { strict as assert } from 'node:assert'
import { it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Config, PythonReplRuntime } from '../src/index.ts'

it('lists the kernel\'s names once a compaction ends, and only the user\'s own', async () => {
  const ctx = new Context()
  await ctx.plugin(PythonReplRuntime, Config({ python: process.env['DSH_PY'] ?? 'python3', skillRoots: [] }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const runtime = ctx.get('ptcRuntime') as PythonReplRuntime
  const emit = ctx.emit.bind(ctx) as unknown as (name: string, ...args: unknown[]) => void
  const key = 'compaction-names'
  try {
    const session = runtime.sessionFor(key)
    const cell = await session.runCell('rows = [1, 2]\ndef helper(): return rows', new Map())
    assert.equal(cell.error, undefined, JSON.stringify(cell))
    assert.doesNotMatch(await runtime.stateContext(key), /last context compaction/)

    emit('session/event', { id: key }, { type: 'compaction/end', data: {} })
    const context = await runtime.stateContext(key)
    const line = context.split('\n').find((l) => l.includes('last context compaction')) ?? ''
    assert.match(line, /held these names/)
    assert.match(line, /\bhelper\b/)
    assert.match(line, /\brows\b/)
    for (const system of ['tools', 'skills', 'repl', 'json', 'asyncio']) {
      assert.doesNotMatch(line, new RegExp(`[:,] ${system}(,|\\.$)`), `${system} is a system name, not the user's`)
    }

    emit('session/event', { id: 'some-other-session' }, { type: 'compaction/end', data: {} })
    assert.equal(await runtime.stateContext(key), context, 'another session\'s compaction changes nothing here')
  } finally { await runtime.disposeAll() }
})

it('bounds UTF-8 compaction notices and replaces them on the next compaction', async () => {
  const ctx = new Context()
  await ctx.plugin(PythonReplRuntime, Config({ python: process.env['DSH_PY'] ?? 'python3', skillRoots: [] }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  const runtime = ctx.get('ptcRuntime') as PythonReplRuntime
  const emit = ctx.emit.bind(ctx) as unknown as (name: string, ...args: unknown[]) => void
  const key = 'compaction-bounds'
  const line = (context: string): string => context.split('\n').find((l) => l.includes('last context compaction')) ?? ''
  try {
    const session = runtime.sessionFor(key)
    const compact = async (): Promise<string> => {
      emit('session/event', { id: key }, { type: 'compaction/end', data: {} })
      return line(await runtime.stateContext(key))
    }
    assert.equal((await session.runCell('globals().update({f"v{i:03}": i for i in range(205)})', new Map())).error, undefined)
    const counted = await compact()
    assert.match(counted, /v199/)
    assert.doesNotMatch(counted, /v200/)
    assert.match(counted, /and 5 more/)

    assert.equal((await session.runCell('for key in list(globals()):\n    if key.startswith("v"): del globals()[key]\nglobals().update({"变量" * 30 + str(i): i for i in range(40)})\ndel key', new Map())).error, undefined)
    const bounded = await compact()
    assert.ok(Buffer.byteLength(bounded, 'utf8') <= 4096)
    assert.match(bounded, /await repl.list/)
    assert.doesNotMatch(bounded, /v199/)

    assert.equal((await session.runCell('for key in list(globals()):\n    if key.startswith("变量"): del globals()[key]\nglobals()["巨" * 5000] = 1\ndel key', new Map())).error, undefined)
    const oversized = await compact()
    assert.ok(Buffer.byteLength(oversized, 'utf8') <= 4096)
    assert.match(oversized, /and 1 more/)
    assert.doesNotMatch(oversized, /held no variables/)
  } finally { await runtime.disposeAll() }
})
