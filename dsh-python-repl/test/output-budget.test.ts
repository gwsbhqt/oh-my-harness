/**
 * One cell that dumps a huge value must not cost the model the whole shared
 * spill budget: only its start and end come back, and the notice says where
 * the rest is.
 */

import { strict as assert } from 'node:assert'
import { after, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { boundCellOutput, estimateTokens, wasCut } from '../src/output-budget.ts'
import { ReplSession } from '../src/session.ts'

it('output within the budget is returned untouched and nothing is saved', async () => {
  let saves = 0
  const logs = ['hello', 'world']
  const out = await boundCellOutput(logs, 100, async () => { saves++; return { locator: '/x' } })
  assert.deepEqual(out, logs)
  assert.equal(saves, 0)
})

it('oversized output keeps start and end, saves the whole joined text and names it', async () => {
  const big = Array.from({ length: 20_000 }, (_, i) => String(i)).join(', ')
  let saved = ''
  const out = await boundCellOutput(['printed', big], 1_000, async (text) => {
    saved = text
    return { locator: '/tmp/spill/cell.txt', retrievalHint: 'read it with read' }
  })
  assert.equal(saved, `printed\n${big}`)
  assert.ok(out[0]!.startsWith('printed\n0, 1, 2'))
  assert.ok(out[2]!.endsWith('19998, 19999'))
  assert.match(out[1]!, /characters omitted/)
  assert.match(out[3]!, /saved at \/tmp\/spill\/cell\.txt \(read it with read\)/)
  // What `_` holds is said by the kernel at cell end (python/output_notes.py); the host only says not to re-run.
  assert.match(out[3]!, /Do not run the cell again to see the rest/)
  assert.equal(wasCut(out), true)
  assert.equal(wasCut(['plain']), false)
  assert.ok(estimateTokens(out.join('\n')) <= 1_000 + 200)
})

it('non-ASCII text counts about one token per character and is never split mid code point', async () => {
  assert.equal(estimateTokens('中文'), 2)
  assert.equal(estimateTokens('abcd'), 1)
  const out = await boundCellOutput(['😀'.repeat(5_000)], 300, async () => ({ locator: '/x' }))
  assert.ok(!out[0]!.includes('\uFFFD'))
  assert.equal(Array.from(out[0]!).length, 200)
  assert.equal(Array.from(out[2]!).length, 100)
})

it('without a store, a failed save, or a zero budget the output stays whole', async () => {
  const logs = ['x'.repeat(100_000)]
  assert.deepEqual(await boundCellOutput(logs, 10, undefined), logs)
  assert.deepEqual(await boundCellOutput(logs, 10, async () => { throw new Error('ENOSPC') }), logs)
  assert.deepEqual(await boundCellOutput(logs, 0, async () => ({ locator: '/x' })), logs)
})

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const session = new ReplSession({
  python: process.env['DSH_PY'] ?? 'python3',
  vendorRoot: join(root, 'vendor', 'prime'),
  pythonRoot: join(root, 'python'),
  boundOutput: (logs) => boundCellOutput(logs, 2_000, async () => ({ locator: '/spill/run_code-cell.txt' })),
})
after(() => session.dispose())

it('a real cell ending on a 200 000-item list comes back bounded with `_` still holding it', async () => {
  const cell = await session.runCell('list(range(200_000))', new Map())
  assert.equal(cell.error, undefined)
  const text = cell.logs.join('\n')
  assert.ok(text.length < 12_000, `got ${text.length} characters`)
  assert.match(text, /saved at \/spill\/run_code-cell\.txt/)
  const again = await session.runCell('len(_)', new Map())
  assert.deepEqual(again.logs, ['200000'])
})
