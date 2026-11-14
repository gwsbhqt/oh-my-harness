/**
 * 验证保存时对 cordis.patch.*.yml 的格式归一化：规则本身、幂等、只作用于目标文件，
 * 以及按宿主方式加载入口后，writeFileAtomic 保存链接时落盘的是归一化内容且链接、权限不变。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lstat, mkdtemp, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import * as entry from '../src/index.ts'

const settle = () => new Promise(resolve => setTimeout(resolve, 20))

async function load() {
  const ctx = new Context()
  const fiber = ctx.plugin({ name: entry.name, apply: entry.applyConfigWrite })
  await settle()
  return fiber
}

test('dshVolatile：去掉安全标量的引号', () => {
  const e = entry.dshVolatile
  assert.equal(e('model: "group/deepseek-v4.1-flash"\n'), 'model: group/deepseek-v4.1-flash\n')
  assert.equal(e('  reasoningEffort: "high"\n'), '  reasoningEffort: high\n')
})

test('dshVolatile：YAML 关键字和数字保留引号，不改变语义', () => {
  const e = entry.dshVolatile
  assert.equal(e('flag: "on"\n'), 'flag: "on"\n')
  assert.equal(e('n: "123"\n'), 'n: "123"\n')
  assert.equal(e('ok: "true"\n'), 'ok: "true"\n')
})

test('dshVolatile：行内数组去内边距、逗号后一个空格', () => {
  const e = entry.dshVolatile
  assert.equal(e('exclude: [ read, glob, grep ]\n'), 'exclude: [read, glob, grep]\n')
  assert.equal(e('args: [ mcp, image ]\n'), 'args: [mcp, image]\n')
  assert.equal(e('keep: [ "a", "b" ]\n'), 'keep: [ "a", "b" ]\n', '含引号的数组原样不动')
})

test('dshVolatile：双引号里 \\U emoji 转义还原成字符', () => {
  const e = entry.dshVolatile
  assert.equal(e('emoji: "\\U0001F4B0"\n'), 'emoji: "💰"\n')
})

test('dshVolatile：块标量内容不动，注释保留', () => {
  const e = entry.dshVolatile
  const text = 'note: |\n  "x": "y"\n  [ q ]\n\n# 注释: "保留"\nmodel: "m"\n'
  const out = e(text)
  assert.ok(out.includes('  "x": "y"\n'), '块内容原样')
  assert.ok(out.includes('  [ q ]\n'), '块内容原样')
  assert.ok(out.includes('# 注释: "保留"'), '注释原样')
  assert.ok(out.includes('model: m\n'), '块外照常归一化')
})

test('dshVolatile：幂等', () => {
  const e = entry.dshVolatile
  const once = e('model: "a/b"\nexclude: [ x, y ]\nnote: |\n  raw: "z"\n')
  assert.equal(e(once), once)
})

test('isDshPatchFile 只认 profile 补丁层文件名', () => {
  assert.equal(entry.isDshPatchFile('cordis.patch.main.yml'), true)
  assert.equal(entry.isDshPatchFile('cordis.patch.yml'), true)
  assert.equal(entry.isDshPatchFile('/x/profiles/desktop/cordis.patch.mbp.yml'), true)
  assert.equal(entry.isDshPatchFile('cordis.yml'), false)
  assert.equal(entry.isDshPatchFile('conf.yaml'), false)
  assert.equal(entry.isDshPatchFile('cordis.patch.yml.bak-hermes'), false)
})

test('保存 cordis.patch 链接：落盘内容是归一化后的，链接和权限不变', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'symlink-norm-'))
  try {
    await writeFile(join(dir, 'cordis.patch.main.yml'), 'seed\n')
    await symlink('cordis.patch.main.yml', join(dir, 'cordis.patch.yml'))
    const fiber = await load()
    const dsh = 'model: "group/deepseek-v4.1-flash"\nreasoningEffort: "high"\nexclude: [ read, glob, grep ]\nargs: [ mcp, image ]\n'
    await writeFileAtomic(join(dir, 'cordis.patch.yml'), dsh, { mode: 0o600 })
    assert.ok((await lstat(join(dir, 'cordis.patch.yml'))).isSymbolicLink(), '链接还在')
    assert.equal(
      await readFile(join(dir, 'cordis.patch.main.yml'), 'utf8'),
      'model: group/deepseek-v4.1-flash\nreasoningEffort: high\nexclude: [read, glob, grep]\nargs: [mcp, image]\n',
    )
    assert.equal((await stat(join(dir, 'cordis.patch.main.yml'))).mode & 0o777, 0o600, '权限保持 600')
    await fiber.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('保存非补丁文件时不改格式', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'symlink-nonpatch-'))
  try {
    await writeFile(join(dir, 'conf.main.yaml'), 'old\n')
    await symlink('conf.main.yaml', join(dir, 'conf.yaml'))
    const fiber = await load()
    await writeFileAtomic(join(dir, 'conf.yaml'), 'a: "b"\n', { mode: 0o600 })
    assert.equal(await readFile(join(dir, 'conf.main.yaml'), 'utf8'), 'a: "b"\n')
    await fiber.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('加载器隐藏名 .<目标>.<pid>.<seq>.tmp 保存 cordis.patch 也归一化', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'symlink-norm-loader-'))
  try {
    await writeFile(join(dir, 'cordis.patch.main.yml'), 'seed\n')
    await symlink('cordis.patch.main.yml', join(dir, 'cordis.patch.yml'))
    const fiber = await load()
    const tmp = join(dir, `.cordis.patch.yml.${process.pid}.0.tmp`)
    await writeFile(tmp, 'exclude: [ a, b ]\n')
    await rename(tmp, join(dir, 'cordis.patch.yml'))
    assert.equal(await readFile(join(dir, 'cordis.patch.main.yml'), 'utf8'), 'exclude: [a, b]\n')
    await fiber.dispose()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 旧 fish DshVolatileTest 原样例迁移：规则与原实现逐条一致。
// 覆盖单/双引号/转义/普通值、binary/数字/boolean 保留，!!js 与列表块及其块后同层字段，
// 带引号逗号的数组不动，magpie 与 DSH 两种写风格归一后相等且幂等。
// ---------------------------------------------------------------------------

test('dshVolatile：magpie 与 DSH 两种写风格归一后一致', () => {
  const e = entry.dshVolatile
  const magpie = '            input: [text, image]\n            name: "Flash API \\U0001F4B0"'
  const dsh = '            input: [ text, image ]\n            name: "Flash API 💰"'
  assert.equal(e(magpie), e(dsh))
})

test('dshVolatile：混合写风格幂等', () => {
  const e = entry.dshVolatile
  const text = '            input: [ text, image ]\n            name: "Flash API \\U0001F4B0"'
  const once = e(text)
  assert.equal(e(once), once)
})

test('dshVolatile：去引号的 model 与行内数组 args', () => {
  const e = entry.dshVolatile
  assert.equal(e('    model: "claude/opus"\n    args: [ mcp, image ]'), '    model: claude/opus\n    args: [mcp, image]')
})

test('dshVolatile：标量类型与字面块保留原样，仅块外归一', () => {
  const e = entry.dshVolatile
  const text = [
    'number: "123"',
    'boolean: "true"',
    'binary: "0b10"',
    'escaped: "\\\\U0001F4B0"',
    "single: '\\U0001F4B0'",
    'plain: \\U0001F4B0',
    'script: |',
    '  model: "claude/opus"',
    '  args: [ mcp, image ]',
    '  literal: \\U0001F4B0',
    'model: "claude/opus"',
    '',
  ].join('\n')
  const idx = text.lastIndexOf('model: "claude/opus"')
  const expected = text.slice(0, idx) + 'model: claude/opus\n'
  assert.equal(e(text), expected)
})

test('dshVolatile：!!js 标签块与列表项块内容保留，块后同层字段归一', () => {
  const e = entry.dshVolatile
  for (const text of [
    'expr: !!js |\n  model: "claude/opus"\n  args: [ a, b ]\n',
    'items:\n  - script: |\n      model: "claude/opus"\n    other: "claude/opus"\n',
  ]) {
    const out = e(text)
    assert.ok(out.includes('model: "claude/opus"'), '块内容保持引号: ' + JSON.stringify(text))
    assert.equal(e(out), out, '幂等: ' + JSON.stringify(text))
  }
  const listed = 'items:\n  - script: |\n      a: b\n    other: "claude/opus"\n'
  assert.ok(e(listed).endsWith('    other: claude/opus\n'), '列表块后同层字段归一')
})

test('dshVolatile：行内数组不动带引号的逗号', () => {
  const e = entry.dshVolatile
  const text = '    args: ["a,b", c]'
  assert.equal(e(text), text)
})

