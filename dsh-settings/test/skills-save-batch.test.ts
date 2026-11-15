/**
 * 技能页「一次完整提交」的批量保存语义（saveSkills）。
 *
 * 覆盖真实边界，不只是迁来的单条改写测试：
 * - 全批有效：skills 与 pySkills 多个条目一起写入；
 * - 中途一条无效：整批不写盘（临时文件都不留，磁盘字节不变）；
 * - 保留其他项目：只改目标层，别的项目规则原样；
 * - 并发两次保存：串行读改写，两条都落地、互不覆盖。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { saveSkills } from '../src/skills/index.ts'
import { DocumentStore } from '../src/skills/store.ts'
import { EMPTY_DOCUMENT, setLevel } from '../src/skills/rules.ts'

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-settings-skills-batch-'))
}

test('全批有效：skills 与 pySkills 多个条目一次写入', async () => {
  const dir = sandbox()
  try {
    const store = new DocumentStore(join(dir, 'skill-exposure.json'))
    await saveSkills(store, { skills: { alpha: 'off', beta: 'name-only' }, pySkills: { gamma: 'off' } })
    const doc = store.read().doc
    assert.deepEqual(doc.global.skills, { alpha: 'off', beta: 'name-only' })
    assert.deepEqual(doc.global.pySkills, { gamma: 'off' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('中途一条无效：整批不写盘，磁盘字节不变', async () => {
  const dir = sandbox()
  try {
    const path = join(dir, 'skill-exposure.json')
    const store = new DocumentStore(path)
    // 先写入一份基线
    await store.write(setLevel(EMPTY_DOCUMENT, { layer: 'global' }, 'skills', 'base', 'off'))
    const before = readFileSync(path, 'utf8')
    // 第一个有效、第二个档位非法：setLevel 在中途抛出，store.update 不应 write
    await assert.rejects(saveSkills(store, { skills: { first: 'off', bad: 'nope' } }), /档位只能是/)
    assert.equal(readFileSync(path, 'utf8'), before, '整批失败后磁盘内容原样')
    assert.deepEqual(store.read().doc.global.skills, { base: 'off' }, '内存也不留半截')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('保留其他项目：只改目标层，别的项目规则原样', async () => {
  const dir = sandbox()
  try {
    const store = new DocumentStore(join(dir, 'skill-exposure.json'))
    const projectA = join(dir, 'proj-a')
    const projectB = join(dir, 'proj-b')
    await store.write(setLevel(setLevel(EMPTY_DOCUMENT, { layer: 'project', root: projectB }, 'skills', 'keep', 'off'), { layer: 'global' }, 'skills', 'g0', 'on'))
    await saveSkills(store, { project: projectA, skills: { moved: 'off' } })
    const doc = store.read().doc
    // 项目 B 那条还在
    const entryB = Object.entries(doc.projects).find(([k]) => k === projectB || k.endsWith('proj-b'))
    assert.ok(entryB, '项目 B 仍存在')
    assert.equal((entryB![1].skills as Record<string, string>)['keep'], 'off')
    // 项目 A 新写入
    const entryA = Object.entries(doc.projects).find(([k]) => k === projectA || k.endsWith('proj-a'))
    assert.ok(entryA, '项目 A 已写入')
    assert.equal((entryA![1].skills as Record<string, string>)['moved'], 'off')
    // 全局那条不被项目写覆盖
    assert.equal(doc.global.skills['g0'], 'on')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('并发两次保存：串行读改写，两条都落地', async () => {
  const dir = sandbox()
  try {
    const path = join(dir, 'skill-exposure.json')
    const a = new DocumentStore(path)
    const b = new DocumentStore(path)
    const results = await Promise.allSettled([
      saveSkills(a, { skills: { first: 'off' } }),
      saveSkills(b, { skills: { second: 'name-only' } }),
    ])
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled'])
    assert.deepEqual(a.read().doc.global.skills, { first: 'off', second: 'name-only' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
