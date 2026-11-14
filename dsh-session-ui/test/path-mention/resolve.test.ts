import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { createResolver, findFd } from '../../src/host/path-mention/resolve.ts'

const fd = findFd()
let root = ''
let home = ''

before(() => {
  root = mkdtempSync(join(tmpdir(), 'path-mention-'))
  home = join(root, 'home')
  mkdirSync(join(root, 'ws/pkg/src/cli'), { recursive: true })
  mkdirSync(join(root, 'ws/out/a'), { recursive: true })
  mkdirSync(join(root, 'ws/out/b'), { recursive: true })
  mkdirSync(join(home, 'Library/Containers/app/Data/x/msg/file/2026-10'), { recursive: true })
  writeFileSync(join(root, 'ws/pkg/src/cli/core.ts'), '')
  writeFileSync(join(root, 'ws/out/index.tsv'), '')
  writeFileSync(join(root, 'ws/out/a/dup.md'), '')
  writeFileSync(join(root, 'ws/out/b/dup.md'), '')
})
after(() => rmSync(root, { recursive: true, force: true }))

describe('把片段对到真实路径', () => {
  it('原样存在的相对路径、目录、绝对路径', async () => {
    const r = await createResolver({ fd, home }).resolve(join(root, 'ws'), ['pkg/src/cli/core.ts', 'out/', join(root, 'ws/out/index.tsv'), 'nope/x.ts'])
    assert.deepEqual(r['pkg/src/cli/core.ts'], { path: join(root, 'ws/pkg/src/cli/core.ts'), kind: 'file' })
    assert.deepEqual(r['out/'], { path: join(root, 'ws/out'), kind: 'directory' })
    assert.equal(r[join(root, 'ws/out/index.tsv')]?.kind, 'file')
    assert.equal(r['nope/x.ts'], undefined)
  })

  it('目录写法遇到文件不转', async () => {
    const r = await createResolver({ fd, home }).resolve(join(root, 'ws'), ['pkg/src/cli/core.ts/'])
    assert.equal(r['pkg/src/cli/core.ts/'], undefined)
  })

  it('带省略号的家目录路径、只写文件名、重名不转', { skip: fd === undefined ? '本机没有 fd' : false }, async () => {
    const r = await createResolver({ fd, home }).resolve(join(root, 'ws'), ['~/Library/Containers/app/.../msg/file/2026-10/', 'index.tsv', 'dup.md', 'cli/core.ts'])
    assert.deepEqual(r['~/Library/Containers/app/.../msg/file/2026-10/'], { path: join(home, 'Library/Containers/app/Data/x/msg/file/2026-10'), kind: 'directory' })
    assert.equal(r['index.tsv']?.path, join(root, 'ws/out/index.tsv'))
    assert.equal(r['cli/core.ts']?.path, join(root, 'ws/pkg/src/cli/core.ts'))
    assert.equal(r['dup.md'], undefined)
  })
})
