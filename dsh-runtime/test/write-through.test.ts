/**
 * 按宿主方式加载入口，用真实临时文件验证：保存顶替链接时写进链接指向的文件，
 * 其余改名原样，卸载后完全恢复。测试文件用具名导入 `rename`，
 * 顺带验证 ESM 具名导入也拿到了这层包装（宿主模块都是这样导入的）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import fsp, { lstat, mkdtemp, readFile, readlink, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import * as entry from '../src/index.ts'

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'symlink-write-'))
  await writeFile(join(dir, 'conf.main.yaml'), 'old\n')
  await symlink('conf.main.yaml', join(dir, 'conf.yaml'))
  return {
    dir,
    link: join(dir, 'conf.yaml'),
    main: join(dir, 'conf.main.yaml'),
    [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }),
  }
}

async function load() {
  const ctx = new Context()
  const fiber = ctx.plugin({ name: entry.name, apply: entry.applyConfigWrite })
  await settle()
  return fiber
}

const isLink = async (path: string) => (await lstat(path)).isSymbolicLink()

test('DSH 的 writeFileAtomic 写进链接指向的文件，链接还在，权限按调用方给的', async () => {
  await using f = await fixture()
  const fiber = await load()
  await writeFileAtomic(f.link, 'new\n', { mode: 0o600 })
  assert.ok(await isLink(f.link))
  assert.equal(await readlink(f.link), 'conf.main.yaml')
  assert.equal(await readFile(f.main, 'utf8'), 'new\n')
  assert.equal((await stat(f.main)).mode & 0o777, 0o600)
  await fiber.dispose()
})

test('加载器那种 `<目标>.tmp` 的保存也顺着链接写', async () => {
  await using f = await fixture()
  const fiber = await load()
  await writeFile(`${f.link}.tmp`, 'tree\n')
  await rename(`${f.link}.tmp`, f.link)
  assert.ok(await isLink(f.link))
  assert.equal(await readFile(f.main, 'utf8'), 'tree\n')
  await fiber.dispose()
})

test('0.2.2-rc.1 起加载器保存 profile 用的隐藏名 `.<目标>.<进程号>.<序号>.tmp` 也顺着链接写', async () => {
  await using f = await fixture()
  const fiber = await load()
  const tmp = join(f.dir, `.${basename(f.link)}.${process.pid}.0.tmp`)
  await writeFile(tmp, 'hidden\n')
  await rename(tmp, f.link)
  assert.ok(await isLink(f.link))
  assert.equal(await readFile(f.main, 'utf8'), 'hidden\n')
  await fiber.dispose()
})

test('多层链接写到最后那个文件；链接指向的文件还不存在时新建它', async () => {
  await using f = await fixture()
  await symlink('conf.yaml', join(f.dir, 'outer.yaml'))
  await symlink('missing.yaml', join(f.dir, 'dangling.yaml'))
  const fiber = await load()
  await writeFileAtomic(join(f.dir, 'outer.yaml'), 'deep\n', { mode: 0o600 })
  await writeFileAtomic(join(f.dir, 'dangling.yaml'), 'born\n', { mode: 0o600 })
  assert.ok(await isLink(join(f.dir, 'outer.yaml')))
  assert.equal(await readFile(f.main, 'utf8'), 'deep\n')
  assert.ok(await isLink(join(f.dir, 'dangling.yaml')))
  assert.equal(await readFile(join(f.dir, 'missing.yaml'), 'utf8'), 'born\n')
  await fiber.dispose()
})

test('多层悬空链接保持不变并创建最终目标', async () => {
  await using f = await fixture()
  const inner = join(f.dir, 'inner.yaml')
  const outer = join(f.dir, 'chain.yaml')
  const target = join(f.dir, 'new.yaml')
  await symlink('new.yaml', inner)
  await symlink(inner, outer)
  const fiber = await load()
  try {
    await writeFileAtomic(outer, 'created\n', { mode: 0o600 })
    assert.ok(await isLink(outer))
    assert.ok(await isLink(inner))
    assert.equal(await readFile(target, 'utf8'), 'created\n')
  } finally { await fiber.dispose() }
})

test('循环链接拒绝写入并保持链接', async () => {
  await using f = await fixture()
  const a = join(f.dir, 'loop-a')
  const b = join(f.dir, 'loop-b')
  await symlink('loop-b', a)
  await symlink('loop-a', b)
  const fiber = await load()
  try {
    await assert.rejects(writeFileAtomic(a, 'bad', { mode: 0o600 }))
    assert.ok(await isLink(a))
    assert.ok(await isLink(b))
  } finally { await fiber.dispose() }
})

test('不是保存的改名、目标不是链接的保存，都原样执行', async () => {
  await using f = await fixture()
  const fiber = await load()
  await writeFile(join(f.dir, 'other'), 'other\n')
  await rename(join(f.dir, 'other'), f.link)
  assert.ok(!(await isLink(f.link)), '名字对不上临时文件规则的改名照常顶替链接')
  assert.equal(await readFile(f.main, 'utf8'), 'old\n')
  await writeFileAtomic(f.link, 'plain\n', { mode: 0o600 })
  assert.equal(await readFile(f.link, 'utf8'), 'plain\n')
  await fiber.dispose()
})

test('装卸两轮：卸载后换回原函数，保存又会顶替链接', async () => {
  const original = fsp.rename
  for (let round = 0; round < 2; round++) {
    await using f = await fixture()
    const fiber = await load()
    assert.notEqual(fsp.rename, original)
    await fiber.dispose()
    await settle()
    assert.equal(fsp.rename, original)
    await writeFileAtomic(f.link, 'after\n', { mode: 0o600 })
    assert.ok(!(await isLink(f.link)))
    assert.equal(await readFile(f.main, 'utf8'), 'old\n')
  }
})

test('别人在上面又包了一层时，卸载不动那层，本层只原样转发', async () => {
  await using f = await fixture()
  const fiber = await load()
  const ours = fsp.rename
  let calls = 0
  const outer: typeof fsp.rename = (from, to) => (calls++, ours(from, to))
  fsp.rename = outer
  try {
    await fiber.dispose()
    await settle()
    assert.equal(fsp.rename, outer)
    await writeFile(`${f.link}.tmp`, 'x\n')
    await fsp.rename(`${f.link}.tmp`, f.link)
    assert.equal(calls, 1)
    assert.ok(!(await isLink(f.link)), '卸载后本层不再改道')
  } finally {
    fsp.rename = ours
  }
})
