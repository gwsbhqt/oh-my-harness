/**
 * 快捷回复所在偏好文件 `$DSH_HOME/preferences.json` 的读写与校验。
 * 覆盖：默认值、写错不悄悄当成没写、原子写、只写自己的段、顺着符号链接写真实文件。
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { formatPreferences } from '../../tooling/runtime/preferences.mjs'
import {
  DEFAULT_DOCUMENT,
  QuickRepliesStore,
  quickRepliesPath,
  validateQuickReplies,
} from '../src/quick-reply/quick-replies-file.ts'

const prefs = (quickReplies: unknown) => formatPreferences({ version: 1, quickReplies })

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-settings-quick-replies-'))
}

test('默认值：一条通用预设「继续」、直接发出', () => {
  assert.deepEqual(DEFAULT_DOCUMENT.presets, ['继续'])
  assert.equal(DEFAULT_DOCUMENT.action, 'send')
})

test('路径默认是 $DSH_HOME/preferences.json，可用环境变量覆盖', () => {
  const savedHome = process.env['DSH_HOME']
  const saved = process.env['DSH_PREFERENCES_FILE']
  try {
    delete process.env['DSH_PREFERENCES_FILE']
    process.env['DSH_HOME'] = '/tmp/dsh-home'
    assert.equal(quickRepliesPath(), '/tmp/dsh-home/preferences.json')
    process.env['DSH_PREFERENCES_FILE'] = '/tmp/x.json'
    assert.equal(quickRepliesPath(), '/tmp/x.json')
  } finally {
    if (savedHome === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = savedHome
    if (saved === undefined) delete process.env['DSH_PREFERENCES_FILE']
    else process.env['DSH_PREFERENCES_FILE'] = saved
  }
})

test('校验：只写 presets 时动作默认 send，$comment 允许', () => {
  const doc = validateQuickReplies({ presets: ['a', 'b'], $comment: '随手记' })
  assert.deepEqual(doc, { presets: ['a', 'b'], action: 'send' })
})

test('写错就报错，并指出是哪一处', () => {
  assert.throws(() => validateQuickReplies([]), /顶层必须是对象/)
  assert.throws(() => validateQuickReplies({ presets: '继续' }), /presets 必须是字符串数组/)
  assert.throws(() => validateQuickReplies({ presets: ['继续', '  '] }), /是空的/)
  assert.throws(() => validateQuickReplies({ presets: [1] }), /必须是字符串/)
  assert.throws(() => validateQuickReplies({ action: 'shout' }), /action 只能是 send 或 insert/)
  assert.throws(() => validateQuickReplies({ preset: ['继续'] }), /不认识的字段 preset/)
})

test('文件不存在：用默认值，exists 为 false，不报错', () => {
  const dir = sandbox()
  try {
    const store = new QuickRepliesStore(join(dir, 'missing.json'))
    const read = store.read()
    assert.equal(read.exists, false)
    assert.equal(read.error, undefined)
    assert.deepEqual(read.doc, DEFAULT_DOCUMENT)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('文件写错：doc 是默认值，error 说明原因', () => {
  const dir = sandbox()
  try {
    const path = join(dir, 'preferences.json')
    writeFileSync(path, '{"version":1,"quickReplies":{"presets":"继续"}}')
    const read = new QuickRepliesStore(path).read()
    assert.equal(read.exists, true)
    assert.match(read.error ?? '', /presets 必须是字符串数组/)
    assert.deepEqual(read.doc, DEFAULT_DOCUMENT)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('写入后读回新内容；同一实例不需要新建', async () => {
  const dir = sandbox()
  try {
    const path = join(dir, 'preferences.json')
    const store = new QuickRepliesStore(path)
    assert.deepEqual(store.read().doc, DEFAULT_DOCUMENT)
    await store.write({ presets: ['只留一条'], action: 'insert' })
    assert.deepEqual(store.read().doc, { presets: ['只留一条'], action: 'insert' })
    assert.equal(readFileSync(path, 'utf8').endsWith('\n'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('文件是符号链接时写真实文件，链接本身留着', async () => {
  const dir = sandbox()
  try {
    const real = join(dir, 'real.json')
    const link = join(dir, 'link.json')
    writeFileSync(real, prefs({ presets: ['旧'], action: 'send' }))
    symlinkSync(real, link)
    const store = new QuickRepliesStore(link)
    await store.write({ presets: ['新'], action: 'send' })
    assert.equal(readFileSync(real, 'utf8'), prefs({ presets: ['新'], action: 'send' }))
    assert.equal(readFileSync(link, 'utf8'), readFileSync(real, 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('目录不存在时自己建', async () => {
  const dir = sandbox()
  try {
    const path = join(dir, 'nested', 'deeper', 'preferences.json')
    await new QuickRepliesStore(path).write({ presets: ['x'], action: 'send' })
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).quickReplies, { presets: ['x'], action: 'send' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('只写 quickReplies 段，其他段原样保留', async () => {
  const dir = sandbox()
  try {
    const path = join(dir, 'preferences.json')
    writeFileSync(path, JSON.stringify({ version: 1, modelTiers: { tiers: { main: [], light: [] } }, presetPreferences: { projects: { '~/dotfiles': 'cordis' } } }))
    await new QuickRepliesStore(path).write({ presets: ['只留一条'], action: 'insert' })
    const read = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(read.quickReplies, { presets: ['只留一条'], action: 'insert' })
    assert.deepEqual(read.modelTiers, { tiers: { main: [], light: [] } })
    assert.deepEqual(read.presetPreferences, { projects: { '~/dotfiles': 'cordis' } })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('校验函数直接用：未知字段被点名', () => {
  assert.throws(() => validateQuickReplies({ presets: [], extra: 1 }), /不认识的字段 extra/)
  assert.deepEqual(validateQuickReplies({ presets: [] }), { presets: [], action: 'send' })
})
