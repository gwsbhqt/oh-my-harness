import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { lstatSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { EMPTY_DOCUMENT, formatDocument, parseDocument, preferredPreset, setProjects } from '../src/presets/rules.ts'
import { DocumentStore } from '../src/presets/store.ts'
import { applyPresets, pickPreset } from '../src/presets/index.ts'
import { route } from '../src/routes.ts'

const HOME = '/home/me'

test('规则：~/ 和绝对路径的项目键都认，没写的跟随默认', () => {
  const doc = parseDocument('{"projects":{"~/dotfiles":"cordis","/work/x":"ptc"}}')
  assert.equal(preferredPreset(doc, '/home/me/dotfiles', HOME), 'cordis')
  assert.equal(preferredPreset(doc, '/work/x', HOME), 'ptc')
  assert.equal(preferredPreset(doc, '/work/y', HOME), undefined)
})

test('规则写错要报出每一处，不悄悄当成没写', () => {
  assert.throws(() => parseDocument('{"projects":{"rel/path":"ptc","/a":"bad id!","/b":3},"extra":1}'), (e: Error) => {
    assert.match(e.message, /4 处写错/)
    assert.match(e.message, /绝对路径/)
    assert.match(e.message, /extra/)
    return true
  })
  assert.throws(() => parseDocument('not json'), /不是合法 JSON/)
})

test('写入：家目录写成 ~/，同一项目已有条目就改那条，null 删掉回到跟随默认', () => {
  let d = setProjects(EMPTY_DOCUMENT, { '/home/me/dotfiles': 'cordis', '/work/abs': 'ptc' }, HOME)
  assert.deepEqual(d.projects, { '~/dotfiles': 'cordis', '/work/abs': 'ptc' })
  const legacy = parseDocument('{"projects":{"/home/me/dotfiles":"ptc"}}')
  assert.deepEqual(setProjects(legacy, { '/home/me/dotfiles': 'cordis' }, HOME).projects, { '~/dotfiles': 'cordis' })
  d = setProjects(d, { '/work/abs': null }, HOME)
  assert.deepEqual(d.projects, { '~/dotfiles': 'cordis' })
  assert.deepEqual(parseDocument(formatDocument(d)), d)
  assert.throws(() => setProjects(d, { 'rel': 'ptc' }, HOME), /绝对路径/)
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-settings-'))
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'sub', 'deep'), { recursive: true })
  mkdirSync(join(dir, 'plain'), { recursive: true })
  const file = join(dir, 'prefs.json')
  return { dir, repo, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const registry = (rows: Array<{ id: string; broken?: string }>, defaultId = 'ptc') => ({ defaultId, list: async () => rows })

test('选模式：没指定时按 cwd 所在仓库补上，子目录跟着仓库走', async () => {
  const f = fixture()
  try {
    const doc = parseDocument(JSON.stringify({ projects: { [f.repo]: 'cordis' } }))
    const reg = registry([{ id: 'ptc' }, { id: 'cordis' }])
    assert.deepEqual(await pickPreset({ cwd: f.repo }, doc, reg, HOME), { preset: 'cordis' })
    assert.deepEqual(await pickPreset({ cwd: join(f.repo, 'sub', 'deep') }, doc, reg, HOME), { preset: 'cordis' })
    assert.deepEqual(await pickPreset({ cwd: join(f.dir, 'plain') }, doc, reg, HOME), {}, '没写的项目交给宿主全局默认')
  } finally { f.cleanup() }
})

test('选模式：指定了模式的一律不动，偏好等于全局默认也不动', async () => {
  const f = fixture()
  try {
    const doc = parseDocument(JSON.stringify({ projects: { [f.repo]: 'cordis' } }))
    const reg = registry([{ id: 'ptc' }, { id: 'cordis' }])
    assert.deepEqual(await pickPreset({ cwd: f.repo, agentPreset: 'ptc' }, doc, reg, HOME), {})
    assert.deepEqual(await pickPreset({ cwd: f.repo }, doc, registry([{ id: 'ptc' }, { id: 'cordis' }], 'cordis'), HOME), {})
    assert.deepEqual(await pickPreset({}, doc, reg, HOME), {}, '没有 cwd 不猜')
  } finally { f.cleanup() }
})

test('选模式：偏好的模式不在名单或加载失败时退回全局默认，并说明原因', async () => {
  const f = fixture()
  try {
    const doc = parseDocument(JSON.stringify({ projects: { [f.repo]: 'gone' } }))
    const missing = await pickPreset({ cwd: f.repo }, doc, registry([{ id: 'ptc' }]), HOME)
    assert.equal(missing.preset, undefined)
    assert.match(missing.skipped ?? '', /不在模式名单里/)
    const doc2 = parseDocument(JSON.stringify({ projects: { [f.repo]: 'cordis' } }))
    const broken = await pickPreset({ cwd: f.repo }, doc2, registry([{ id: 'ptc' }, { id: 'cordis', broken: 'boom' }]), HOME)
    assert.equal(broken.preset, undefined)
    assert.match(broken.skipped ?? '', /加载失败（boom）/)
  } finally { f.cleanup() }
})

/** 和宿主同形状：createSession 在原型上，agents 是会话控制器服务上的实例字段。 */
class FakeAgents {
  seen: unknown[] = []
  async createSession(request: Record<string, unknown>) { this.seen.push(request); return { agentPreset: request['agentPreset'] ?? 'default' } }
}
class SessionController extends Service {
  agents = new FakeAgents()
  constructor(ctx: Context) { super(ctx, 'sessionController') }
}
class AgentPresets extends Service {
  defaultId = 'ptc'
  constructor(ctx: Context) { super(ctx, 'agentPresets') }
  async list() { return [{ id: 'ptc' }, { id: 'cordis' }] }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 20))
const plugin = () => ({ name: 'dsh-settings', apply: (ctx: Context) => applyPresets(ctx) })

test('按宿主方式加载：装上后补偏好，卸下后原样，两轮都干净', async () => {
  const f = fixture()
  const previous = process.env['DSH_PREFERENCES_FILE']
  process.env['DSH_PREFERENCES_FILE'] = f.file
  try {
    writeFileSync(f.file, JSON.stringify({ version: 1, presetPreferences: { projects: { [f.repo]: 'cordis' } } }))
    const ctx = new Context()
    const controller = new SessionController(ctx)
    new AgentPresets(ctx)
    await settle()
    const agents = controller.agents
    for (let round = 0; round < 2; round++) {
      const fiber = ctx.plugin(plugin())
      await settle()
      assert.deepEqual(await agents.createSession({ cwd: f.repo }), { agentPreset: 'cordis' }, `第 ${round + 1} 轮装上后补偏好`)
      assert.deepEqual(await agents.createSession({ cwd: f.repo, agentPreset: 'ptc' }), { agentPreset: 'ptc' }, '手动指定的不动')
      assert.deepEqual(await agents.createSession({ cwd: join(f.dir, 'plain') }), { agentPreset: 'default' }, '没写的交给宿主')
      await fiber.dispose()
      await settle()
      assert.equal(Object.hasOwn(agents, 'createSession'), false, `第 ${round + 1} 轮卸下后实例上不留包装`)
      assert.deepEqual(await agents.createSession({ cwd: f.repo }), { agentPreset: 'default' }, '卸下后回到宿主行为')
    }
  } finally {
    if (previous === undefined) delete process.env['DSH_PREFERENCES_FILE']
    else process.env['DSH_PREFERENCES_FILE'] = previous
    f.cleanup()
  }
})

test('规则文件写错时不挡建会话，交给全局默认', async () => {
  const f = fixture()
  const previous = process.env['DSH_PREFERENCES_FILE']
  process.env['DSH_PREFERENCES_FILE'] = f.file
  try {
    writeFileSync(f.file, '{ broken')
    const ctx = new Context()
    const controller = new SessionController(ctx)
    new AgentPresets(ctx)
    await settle()
    const fiber = ctx.plugin(plugin())
    await settle()
    assert.deepEqual(await controller.agents.createSession({ cwd: f.repo }), { agentPreset: 'default' })
    await fiber.dispose()
  } finally {
    if (previous === undefined) delete process.env['DSH_PREFERENCES_FILE']
    else process.env['DSH_PREFERENCES_FILE'] = previous
    f.cleanup()
  }
})

test('规则文件读写：原子写入，改完下次读到新内容', async () => {
  const f = fixture()
  try {
    const store = new DocumentStore(f.file)
    assert.equal(store.read().exists, false)
    await store.write(setProjects(EMPTY_DOCUMENT, { [f.repo]: 'cordis' }, HOME))
    assert.equal(preferredPreset(store.read().doc, f.repo, HOME), 'cordis')
    assert.match(readFileSync(f.file, 'utf8'), /"cordis"/)
  } finally { f.cleanup() }
})

test('规则文件只写自己的段，其他段原样保留', async () => {
  const f = fixture()
  try {
    writeFileSync(f.file, JSON.stringify({ version: 1, modelTiers: { tiers: { main: [], light: [] } }, quickReplies: { presets: ['继续'], action: 'send' } }))
    const store = new DocumentStore(f.file)
    await store.write(setProjects(EMPTY_DOCUMENT, { [f.repo]: 'cordis' }, HOME))
    const read = JSON.parse(readFileSync(f.file, 'utf8'))
    assert.deepEqual(read.presetPreferences, { projects: { [f.repo]: 'cordis' } })
    assert.deepEqual(read.modelTiers, { tiers: { main: [], light: [] } })
    assert.deepEqual(read.quickReplies, { presets: ['继续'], action: 'send' })
  } finally { f.cleanup() }
})

test('规则文件是链接时顺着链接写，链接保留', async () => {
  const f = fixture()
  try {
    const real = join(f.dir, 'dotfiles-copy.json')
    writeFileSync(real, '{"version":1,"presetPreferences":{"projects":{}}}')
    const link = join(f.dir, 'linked.json')
    symlinkSync(real, link)
    const store = new DocumentStore(link)
    await store.write(setProjects(store.read().doc, { [f.repo]: 'cordis' }, HOME))
    assert.equal(lstatSync(link).isSymbolicLink(), true, '保存后仍是链接')
    assert.match(readFileSync(real, 'utf8'), /"cordis"/, '内容写进了链接指向的文件')
  } finally { f.cleanup() }
})

test('接口信封：非 JSON 拒绝，处理函数报错按失败信封返回', async () => {
  const r = route('presetsOverview', async () => { throw new Error('nope') })
  const bad = await r.fetch(new Request('http://x/api/settings.presetsOverview', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } }))
  assert.equal(bad.status, 415)
  const res = await r.fetch(new Request('http://x/api/settings.presetsOverview', { method: 'POST', body: JSON.stringify({ type: 'client-request', method: 'm', rpcId: '1' }), headers: { 'content-type': 'application/json' } }))
  const body = await res.json() as { result: { ok: boolean; error: { message: string } } }
  assert.equal(body.result.ok, false)
  assert.equal(body.result.error.message, 'nope')
})
