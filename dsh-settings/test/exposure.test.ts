import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { SkillRegistry } from '@deepseek-ai/dsh-skill'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyLevel, EMPTY_DOCUMENT, formatDocument, NAME_ONLY_DESCRIPTION, parseDocument, resolvePySkill, resolveSkill,
  scopeOfSource, setLevel, type CandidateLike, type ExposureDocument,
} from '../src/skills/rules.ts'
import { filterSummaries, installFilter } from '../src/skills/filter.ts'
import { DocumentStore, findProjectRoot } from '../src/skills/store.ts'
import { route } from '../src/routes.ts'

const HOME = '/home/me'
const skill = (name: string, extra: Partial<CandidateLike> = {}): CandidateLike => ({
  name, description: `${name} 的介绍`, invocation: { modelInvocable: true, userInvocable: true }, ...extra,
})

const doc: ExposureDocument = parseDocument(JSON.stringify({
  global: { skills: { 'lark-im-live': 'off', ship: 'user-only', 'browser-use': 'name-only' }, pySkills: { 'computer-use': 'off' } },
  projects: {
    '/work/nexus': { skills: { 'lark-im-live': 'on', ship: 'off' }, pySkills: { 'computer-use': 'on' } },
    '~/dotfiles': { skills: { 'browser-use': 'on' } },
  },
}))

test('项目层盖全局层，没写的是默认 on', () => {
  assert.deepEqual(resolveSkill(doc, 'lark-im-live', undefined, HOME), { level: 'off', from: 'global' })
  assert.deepEqual(resolveSkill(doc, 'lark-im-live', '/work/nexus', HOME), { level: 'on', from: 'project' })
  assert.deepEqual(resolveSkill(doc, 'ship', '/work/nexus', HOME), { level: 'off', from: 'project' })
  assert.deepEqual(resolveSkill(doc, 'browser-use', '/work/other', HOME), { level: 'name-only', from: 'global' })
  assert.deepEqual(resolveSkill(doc, 'unknown', '/work/nexus', HOME), { level: 'on', from: 'default' })
})

test('项目键可以写 ~/ 开头', () => {
  assert.equal(resolveSkill(doc, 'browser-use', '/home/me/dotfiles', HOME).level, 'on')
})

test('普通技能和 py 技能分开管，同名不串', () => {
  assert.equal(resolvePySkill(doc, 'computer-use', undefined, HOME).level, 'off')
  assert.equal(resolvePySkill(doc, 'computer-use', '/work/nexus', HOME).level, 'on')
  assert.equal(resolveSkill(doc, 'computer-use', undefined, HOME).level, 'on')
  assert.equal(resolvePySkill(doc, 'lark-im-live', undefined, HOME).level, 'on')
})

test('每一档改写幂等：宿主 list 内部走 snapshot，过滤两遍结果不变', () => {
  const list = [skill('lark-im-live'), skill('ship'), skill('browser-use'), skill('keep')]
  const once = filterSummaries(list, doc, undefined, HOME)
  assert.deepEqual(filterSummaries(once, doc, undefined, HOME), once)
})

test('四档改写：off 拿掉、user-only 关模型调用、name-only 换短介绍、on 原样', () => {
  const s = skill('a', { whenToUse: '什么时候用' })
  assert.equal(applyLevel(s, 'on'), s)
  assert.equal(applyLevel(s, 'off'), undefined)
  assert.deepEqual(applyLevel(s, 'user-only')?.invocation, { modelInvocable: false, userInvocable: true })
  const named = applyLevel(s, 'name-only')!
  assert.equal(named.description, NAME_ONLY_DESCRIPTION)
  assert.equal('whenToUse' in named, false)
  assert.equal(named.invocation.modelInvocable, true)
})

test('技能自己声明的限制只收紧不放宽', () => {
  const userOnly = skill('a', { invocation: { modelInvocable: false, userInvocable: true } })
  assert.equal(applyLevel(userOnly, 'on')!.invocation.modelInvocable, false)
})

test('规则写错要报出每一处，不悄悄当成没写', () => {
  assert.throws(() => parseDocument('{"global":{"skills":{"a":"hidden"}},"projects":{"relative/path":{}},"extra":1}'), (e: Error) => {
    assert.match(e.message, /3 处写错/)
    assert.match(e.message, /global\.skills\.a/)
    assert.match(e.message, /绝对路径/)
    assert.match(e.message, /extra/)
    return true
  })
  assert.throws(() => parseDocument('{"global":{"pySkills":{"a":"name-only"}}}'), /只能是 on \/ off/)
  assert.throws(() => parseDocument('not json'), /不是合法 JSON/)
})

test('写出的文本排序稳定、去掉空层；setLevel 删条目回到继承', () => {
  let d = setLevel(EMPTY_DOCUMENT, { layer: 'global' }, 'skills', 'zeta', 'off')
  d = setLevel(d, { layer: 'global' }, 'skills', 'alpha', 'user-only')
  d = setLevel(d, { layer: 'project', root: '/p' }, 'pySkills', 'computer-use', 'off')
  const text = formatDocument(d)
  assert.ok(text.indexOf('alpha') < text.indexOf('zeta'))
  assert.deepEqual(parseDocument(text), d)
  d = setLevel(d, { layer: 'project', root: '/p' }, 'pySkills', 'computer-use', undefined)
  assert.deepEqual(JSON.parse(formatDocument(d)).projects, {})
  assert.throws(() => setLevel(d, { layer: 'global' }, 'pySkills', 'x', 'user-only'), /on \/ off/)
  assert.throws(() => setLevel(d, { layer: 'project', root: 'rel' }, 'skills', 'x', 'off'), /绝对路径/)
})

test('写项目时把家目录写成 ~/，已有同一项目的条目就改那条', () => {
  let d = setLevel(EMPTY_DOCUMENT, { layer: 'project', root: '/home/me/project/nexus' }, 'skills', 'a', 'off', HOME)
  assert.deepEqual(Object.keys(d.projects), ['~/project/nexus'])
  d = setLevel(d, { layer: 'project', root: '/home/me/project/nexus' }, 'skills', 'b', 'user-only', HOME)
  assert.deepEqual(Object.keys(d.projects), ['~/project/nexus'])
  assert.deepEqual(d.projects['~/project/nexus']!.skills, { a: 'off', b: 'user-only' })
  d = setLevel(d, { layer: 'project', root: '/work/abs' }, 'skills', 'a', 'off', HOME)
  assert.ok('/work/abs' in d.projects, '家目录外的项目照写绝对路径')
  const legacy = parseDocument('{"projects":{"/home/me/x":{"skills":{"a":"off"}}}}')
  assert.deepEqual(Object.keys(setLevel(legacy, { layer: 'project', root: '/home/me/x' }, 'skills', 'b', 'off', HOME).projects), ['/home/me/x'])
})

test('来源分组：项目、你自己的、内置', () => {
  assert.equal(scopeOfSource('project-agents'), 'project')
  assert.equal(scopeOfSource('project-dsh'), 'project')
  assert.equal(scopeOfSource('user-agents'), 'global')
  assert.equal(scopeOfSource('custom'), 'global')
  assert.equal(scopeOfSource('bundled'), 'builtin')
  assert.equal(scopeOfSource(undefined), 'builtin')
})

test('过滤一组摘要按会话所在项目判档', () => {
  const list = [skill('lark-im-live'), skill('ship'), skill('browser-use'), skill('keep')]
  assert.deepEqual(filterSummaries(list, doc, undefined, HOME).map((s) => [s.name, s.invocation.modelInvocable]), [['ship', false], ['browser-use', true], ['keep', true]])
  assert.deepEqual(filterSummaries(list, doc, '/work/nexus', HOME).map((s) => s.name), ['lark-im-live', 'browser-use', 'keep'])
})

/** 和宿主 SkillRegistry 同形状的注册表：方法在原型上，用 this 读私有状态；list 走 this.snapshot（宿主就是这样）。 */
class FakeRegistry {
  private readonly items: CandidateLike[]
  calls: unknown[] = []
  constructor(items: CandidateLike[]) { this.items = items }
  async list(options?: unknown) { return (await this.snapshot(options)).skills }
  async snapshot(options?: unknown) { this.calls.push(options); return { skills: this.items, complete: true } }
  async get(name: string, options?: unknown) { this.calls.push(options); return this.items.find((s) => s.name === name) }
}

test('宿主列技能只判一次偏好，设置页能恢复关闭的技能', async (t) => {
  const ctx = new Context()
  const registry = new SkillRegistry(ctx)
  const entry = { name: 'example-guide', description: 'Example guide', content: 'Example instructions', source: 'runtime' }
  t.after(registry.register(entry))
  const preferences = setLevel(EMPTY_DOCUMENT, { layer: 'global' }, 'skills', entry.name, 'off')
  const document = t.mock.fn(() => preferences)
  const filter = installFilter(registry, { document, projectRoot: (cwd) => cwd, home: HOME })
  t.after(() => filter.dispose())

  assert.deepEqual(await registry.list(), [])
  assert.equal(document.mock.callCount(), 1)
  assert.equal(Object.hasOwn(registry, 'list'), false)
  assert.deepEqual(await registry.snapshot(), { skills: [], complete: true })
  assert.equal(await registry.get(entry.name), undefined)
  assert.deepEqual((await filter.raw.list()).map(s => s.name), [entry.name])
  filter.dispose()
  assert.deepEqual((await registry.list()).map(s => s.name), [entry.name])
  assert.equal((await registry.snapshot()).skills[0]?.name, entry.name)
  assert.equal((await registry.get(entry.name))?.content, entry.content)
})

test('装上过滤后 list / snapshot / get 一致改写，卸载后原样', async () => {
  const reg = new FakeRegistry([skill('lark-im-live'), skill('ship'), skill('browser-use'), skill('keep')])
  const projectRoot = (cwd: string) => (cwd.startsWith('/work/nexus') ? '/work/nexus' : cwd)
  const handle = installFilter(reg, { document: () => doc, projectRoot, home: HOME })
  assert.deepEqual((await reg.list({ cwd: '/elsewhere' })).map((s) => s.name), ['ship', 'browser-use', 'keep'])
  const snap = await reg.snapshot({ cwd: '/elsewhere' })
  assert.equal(snap.complete, true)
  assert.equal(snap.skills.find((s) => s.name === 'browser-use')!.description, NAME_ONLY_DESCRIPTION)
  assert.equal(await reg.get('lark-im-live', { cwd: '/elsewhere' }), undefined, 'off 的技能加载不到')
  assert.equal((await reg.get('lark-im-live', { cwd: '/work/nexus/apps' }))!.name, 'lark-im-live', '项目里打开了就能加载')
  assert.equal((await reg.get('ship', { cwd: '/elsewhere' }))!.invocation.modelInvocable, false)
  assert.equal((await reg.get('browser-use', { cwd: '/elsewhere' }))!.description, 'browser-use 的介绍', 'name-only 真加载时给原介绍')
  assert.equal((await handle.raw.list({})).length, 4, '设置页要能看到全部，包括关掉的')
  assert.equal((await handle.raw.list({}))[2]!.description, 'browser-use 的介绍', '设置页看到原介绍')
  handle.dispose()
  assert.equal((await reg.list({ cwd: '/elsewhere' })).length, 4)
  assert.equal(Object.getOwnPropertyDescriptor(reg, 'list'), undefined, '卸载后不留自有属性')
})

test('别的插件后来又包了一层时卸载不摘掉它的那层', async () => {
  const reg = new FakeRegistry([skill('lark-im-live')]) as unknown as Record<string, unknown> & FakeRegistry
  const handle = installFilter(reg, { document: () => doc, projectRoot: (c) => c, home: HOME })
  const ours = reg.snapshot
  const theirs = async function (this: FakeRegistry, options?: unknown) { return ours.call(this, options) }
  Object.defineProperty(reg, 'snapshot', { value: theirs, writable: true, configurable: true })
  handle.dispose()
  assert.equal(reg.snapshot, theirs)
  assert.equal((await reg.list({})).length, 1, '我们那层变成直通')
})

test('规则文件：没有时全部默认、写错时报错并按默认、改完立即读到新的', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-exposure-'))
  try {
    const path = join(dir, 'skill-exposure.json')
    const store = new DocumentStore(path)
    assert.equal(store.read().exists, false)
    await store.write(setLevel(EMPTY_DOCUMENT, { layer: 'global' }, 'skills', 'x', 'off'))
    assert.equal(store.read().doc.global.skills['x'], 'off')
    assert.equal(readFileSync(path, 'utf8').endsWith('\n'), true)
    writeFileSync(path, '{"global":{"skills":{"x":"nope"}}}')
    const broken = store.read()
    assert.match(broken.error ?? '', /写错/)
    assert.deepEqual(broken.doc, EMPTY_DOCUMENT)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('同时修改不同技能时，两项都应保存成功', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-exposure-race-'))
  try {
    const store = new DocumentStore(join(dir, 'skill-exposure.json'))
    const other = new DocumentStore(store.path)
    const save = (target: DocumentStore, name: string) => target.update(current =>
      setLevel(current.doc, { layer: 'global' }, 'skills', name, 'off'))
    const results = await Promise.allSettled([save(store, 'first'), save(other, 'second')])
    assert.deepEqual(results.map(r => r.status), ['fulfilled', 'fulfilled'])
    assert.deepEqual(store.read().doc.global.skills, { first: 'off', second: 'off' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('一次保存失败不会阻塞后续保存', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-exposure-error-'))
  try {
    const store = new DocumentStore(join(dir, 'skill-exposure.json'))
    const failed = store.update(() => { throw new Error('保存失败') })
    const saved = store.update(current => setLevel(current.doc, { layer: 'global' }, 'skills', 'next', 'off'))
    await assert.rejects(failed, /保存失败/)
    await saved
    assert.equal(store.read().doc.global.skills['next'], 'off')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('项目根取最近的 .git 祖先，没有就是目录本身', () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-exposure-root-'))
  try {
    mkdirSync(join(dir, 'repo', '.git'), { recursive: true })
    mkdirSync(join(dir, 'repo', 'apps', 'web'), { recursive: true })
    assert.equal(findProjectRoot(join(dir, 'repo', 'apps', 'web')), join(dir, 'repo'))
    mkdirSync(join(dir, 'plain'))
    assert.equal(findProjectRoot(join(dir, 'plain')), join(dir, 'plain'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('接口信封与宿主 /api 通道一致，出错带插件前缀的错误码', async () => {
  const ok = route('skillsOverview', async (p) => ({ echo: p }))
  const res = await ok.fetch(new Request('http://x/api/settings.skillsOverview', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'skillsOverview', payload: { a: 1 } }),
  }))
  assert.deepEqual(await res.json(), { type: 'server-response', rpcId: 'r1', result: { ok: true, value: { echo: { a: 1 } } } })
  const bad = route('skillsSet', async () => { throw new Error('坏了') })
  const r2 = await (await bad.fetch(new Request('http://x', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'r2', method: 'm', payload: {} }),
  }))).json() as { result: { ok: boolean; error: { code: string; message: string } } }
  assert.equal(r2.result.ok, false)
  assert.equal(r2.result.error.code, 'settings/failed')
  assert.equal(r2.result.error.message, '坏了')
  const wrongType = await route('x', async () => 1).fetch(new Request('http://x', { method: 'POST', body: '{}' }))
  assert.equal(wrongType.status, 415)
})
