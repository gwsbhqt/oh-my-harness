/** Snapshot sizes come from Prime's record headers only (src/snapshot.ts readSnapshotSizes). */
import { strict as assert } from 'node:assert'
import { it } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSnapshotSizes } from '../src/snapshot.ts'

const MAGIC = Buffer.from('PRIME-AGENT-KERNEL-SNAPSHOT-V2\n')
function record(name: string, bytes: number): Buffer {
  const n = Buffer.from(name)
  const head = Buffer.alloc(12 + n.length)
  head.writeUInt32LE(n.length, 0); n.copy(head, 4); head.writeBigUInt64LE(BigInt(bytes), 4 + n.length)
  return Buffer.concat([head, Buffer.alloc(bytes, 7)])
}

it('reads each name\'s bytes without the values; damage and legacy files are reported, not guessed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sizes-'))
  try {
    const good = join(dir, 'good.dill')
    writeFileSync(good, Buffer.concat([MAGIC, record('rows', 5000), record('名字', 12), record('x', 0)]))
    assert.deepEqual(await readSnapshotSizes(good), { sizes: { rows: 5000, '名字': 12, x: 0 }, complete: true })
    const cut = join(dir, 'cut.dill')
    writeFileSync(cut, Buffer.concat([MAGIC, record('a', 10), record('b', 100)]).subarray(0, MAGIC.length + 13 + 10 + 20))
    assert.deepEqual(await readSnapshotSizes(cut), { sizes: { a: 10 }, complete: false })
    const legacy = join(dir, 'legacy.dill')
    writeFileSync(legacy, Buffer.from('\x80\x04 dill pickle'))
    assert.equal(await readSnapshotSizes(legacy), null)
    assert.equal(await readSnapshotSizes(join(dir, 'missing.dill')), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
