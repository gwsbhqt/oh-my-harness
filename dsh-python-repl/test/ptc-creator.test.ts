import { strict as assert } from 'node:assert'
import { it } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  applyPtcCreatorToggle,
  carriedRows,
  fromPtcCreator,
  installPtcCreator,
  isPresetRegistry,
  presentationRow,
  toPtcCreator,
  type CreatorState,
} from '../src/ptc-creator.ts'
import type { PresetDefinition, PresetGeneration, PresetRecord } from '../src/preset-workflow.ts'

type Row = Record<string, unknown>

const cordisRows = (): unknown[] => [
  { id: 'persona', name: '@deepseek-ai/dsh-persona' },
  { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', config: { customSkillDirs: [{ __jsExpr: 'dir' }] } },
  {
    id: 'delegation', name: 'cordis:group', group: true, config: [
      { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent' },
      { id: 'workflow-ptc', name: '@deepseek-ai/dsh-workflow-ptc', config: { provider: 'spawn' } },
      { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
    ],
  },
  { id: 'tool-cordis', name: '@deepseek-ai/dsh-tool-cordis' },
  { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
]
const presentation = { id: 'tool-presentation', name: '@deepseek-ai/dsh-agent-tool-presentation', config: { mode: 'ptc' } }
const office = { id: 'tool-office', name: '@deepseek-ai/dsh-tool-office' }
const ids = (rows: readonly unknown[]) => rows.map((r) => (r as Row)['id'])
const group = (rows: readonly unknown[]) => rows.find((r) => (r as Row)['id'] === 'delegation') as Row

it('0.2.2-rc.1 起 PTC 模式的呈现条目是 tool-executor-ptc，照样认出', () => {
  const executor = { id: 'tool-executor-ptc', name: '@deepseek-ai/dsh-tool-executor-ptc' }
  assert.equal(presentationRow([{ id: 'present', name: '@deepseek-ai/dsh-tool-present' }, executor]), executor)
  assert.equal(presentationRow([{ id: 'present' }]), undefined)
})

it('继承创造模式：在 present 前补呈现条目、其余条目保持原对象，且不碰工作流', () => {
  const rows = cordisRows()
  const out = toPtcCreator(rows, presentation)!
  assert.deepEqual(ids(out), ['persona', 'skill-filesystem', 'delegation', 'tool-cordis', 'tool-presentation', 'present'])
  assert.equal(out[0], rows[0], '没改的条目保持原对象')
  assert.equal(out[1], rows[1], '技能目录照官方创造模式')
  // 工作流不在这里关：python-repl 的 preset-workflow 负责
  assert.deepEqual((group(out)['config'] as Row[]).map((r) => [r['id'], r['disabled'] ?? false]), [['tool-subagent', false], ['workflow-ptc', false], ['tool-workflow', false]])
  assert.equal(toPtcCreator(out, presentation), undefined, '已经改过的不再改')
  assert.deepEqual(fromPtcCreator(out), rows, '撤回后和官方一样')
  assert.equal(fromPtcCreator(rows), undefined)
})

it('工具呈现条目按官方两种写法都认；创造模式已带就不重复补', () => {
  const executor = { id: 'tool-executor-ptc', name: '@deepseek-ai/dsh-tool-executor-ptc' }
  const rows = [...cordisRows(), executor]
  assert.equal(toPtcCreator(rows, executor), undefined, '已经带呈现条目、又没别的要补时不再改')
  const out = toPtcCreator(rows, executor, [office])!
  assert.equal(out.filter((r) => (r as Row)['id'] === 'tool-executor-ptc').length, 1, '呈现条目只有一条')
  assert.ok(out.some((r) => (r as Row)['id'] === 'tool-office'))
})

it('从 PTC 模式照搬 tool-office，放在 present 后面，撤回时一并去掉', () => {
  const ptc = [{ id: 'present', name: '@deepseek-ai/dsh-tool-present' }, office, { id: 'tool-plugin-manager', name: '@x/pm' }]
  assert.deepEqual(carriedRows(ptc), [office])
  assert.deepEqual(carriedRows([{ id: 'present' }]), [], 'PTC 模式没有就不补')
  const rows = cordisRows()
  const out = toPtcCreator(rows, presentation, carriedRows(ptc))!
  assert.deepEqual(ids(out), ['persona', 'skill-filesystem', 'delegation', 'tool-cordis', 'tool-presentation', 'present', 'tool-office'])
  assert.equal(toPtcCreator(out, presentation, carriedRows(ptc)), undefined, '已经改过的不再改')
  assert.deepEqual(fromPtcCreator(out), rows, '撤回后和官方一样')
  const official = [...rows, { ...office, config: { official: true } }]
  const kept = toPtcCreator(official, presentation, carriedRows(ptc))!
  assert.deepEqual(kept.filter((r) => (r as Row)['id'] === 'tool-office'), [official.at(-1)], '官方创造模式自己带了就用官方那份')
})

it('官方创造模式新加的条目自动带上', () => {
  const rows = [...cordisRows(), { id: 'tool-new', name: '@deepseek-ai/dsh-tool-new' }]
  assert.ok(toPtcCreator(rows, presentation)!.some((r) => (r as Row)['id'] === 'tool-new'))
})

it('卸载只撤自己的对象，别的插件后来加的条目保留', () => {
  const out = toPtcCreator(cordisRows(), presentation, [office])!
  const other = { id: 'other', name: '@example/other' }
  const withOther = [...out, other]
  const restored = fromPtcCreator(withOther)!
  assert.ok(restored.includes(other), '第三方条目保留')
  assert.deepEqual(restored.filter((r) => r !== other), cordisRows())
})

/** 和宿主模式注册表同形状：definitions、register、activate、collect。 */
class Registry extends Service {
  definitions = new Map<string, PresetRecord>()
  activations = 0
  constructor(ctx: Context) { super(ctx, 'agentPresets') }
  get defaultId() { return 'ptc' }
  async list() { return [...this.definitions.values()].map((r) => ({ id: r.config.id, ...(r.config.name === undefined ? {} : { name: r.config.name }) })) }
  async register(definition: PresetDefinition) {
    const record: PresetRecord = { config: definition, ready: Promise.resolve() }
    this.definitions.set(definition.id, record)
    record.ready = this.activate(record)
    await record.ready
    return async () => { this.definitions.delete(definition.id) }
  }
  async activate(record: PresetRecord) { this.activations++; record.generation = { users: 0, retired: false } }
  async collect(_generation: PresetGeneration) {}
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

it('真实注册表：装上改成 PTC 创造模式、卸下回到官方，两轮都干净，内置模式始终无名', async () => {
  const ctx = new Context()
  const registry = new Registry(ctx)
  assert.ok(isPresetRegistry(registry))
  await registry.register({ id: 'ptc', plugins: [presentation, office] })
  await registry.register({ id: 'cordis', plugins: cordisRows() })
  await settle()
  const cordis = () => registry.definitions.get('cordis')!
  for (let round = 0; round < 2; round++) {
    const dispose = installPtcCreator(registry, { info() {}, warn() {} }, { ok: true })
    await settle()
    await cordis().ready
    assert.equal(cordis().config.name, undefined, `第 ${round + 1} 轮装上后不起名，仍算内置模式`)
    assert.deepEqual(ids(cordis().config.plugins), ['persona', 'skill-filesystem', 'delegation', 'tool-cordis', 'tool-presentation', 'present', 'tool-office'])
    await dispose()
    await settle()
    await cordis().ready
    assert.deepEqual(cordis().config.plugins, cordisRows(), `第 ${round + 1} 轮卸下后和官方一样`)
    assert.equal(Object.hasOwn(registry, 'register'), false, '卸下后注册表上不留包装')
  }
})

it('装上后重新注册的创造模式在挂载前就改好', async () => {
  const ctx = new Context()
  const registry = new Registry(ctx)
  await registry.register({ id: 'ptc', plugins: [presentation, office] })
  await settle()
  const dispose = installPtcCreator(registry, { info() {}, warn() {} }, { ok: true })
  await settle()
  await registry.register({ id: 'cordis', plugins: cordisRows() })
  const record = registry.definitions.get('cordis')!
  assert.equal(record.config.name, undefined)
  assert.ok((record.config.plugins as Row[]).some((r) => r['id'] === 'tool-presentation'))
  await dispose()
})

it('开关默认关：不装就不改创造模式；打开装上、关闭还原、卸载还原', async () => {
  const ctx = new Context()
  const registry = new Registry(ctx)
  await registry.register({ id: 'ptc', plugins: [presentation, office] })
  await registry.register({ id: 'cordis', plugins: cordisRows() })
  await settle()
  const cordis = () => registry.definitions.get('cordis')!
  let enabled = false
  let refresh: (() => void) | undefined
  const fiber = ctx.plugin({ apply: (c) => { refresh = applyPtcCreatorToggle(c, () => enabled) } })
  await settle()
  assert.equal(refresh !== undefined, true, '注册表就绪后有刷新函数')
  // 默认关：不改
  await cordis().ready
  assert.deepEqual(cordis().config.plugins, cordisRows(), '默认关不装')
  // 打开：模拟 volatile 原地更新后刷新
  enabled = true
  refresh!()
  await settle()
  await cordis().ready
  assert.ok((cordis().config.plugins as Row[]).some((r) => r['id'] === 'tool-presentation'), '打开后补上呈现条目')
  assert.ok((cordis().config.plugins as Row[]).some((r) => r['id'] === 'tool-office'), '打开后带上 tool-office')
  // 关闭：再刷新，还原
  enabled = false
  refresh!()
  await settle()
  await cordis().ready
  assert.deepEqual(cordis().config.plugins, cordisRows(), '关闭后还原')
  // 打开后卸载插件，也要还原
  enabled = true
  refresh!()
  await settle()
  await cordis().ready
  assert.ok((cordis().config.plugins as Row[]).some((r) => r['id'] === 'tool-presentation'))
  await fiber.dispose()
  await settle()
  await cordis().ready
  assert.deepEqual(cordis().config.plugins, cordisRows(), '卸载后还原')
})

it('volatile 更新事件驱动开关（loader/volatile-update 里 ptcCreativeMode 变化时重新同步）', async () => {
  const ctx = new Context()
  const registry = new Registry(ctx)
  await registry.register({ id: 'ptc', plugins: [presentation, office] })
  await registry.register({ id: 'cordis', plugins: cordisRows() })
  await settle()
  const cordis = () => registry.definitions.get('cordis')!
  let enabled = false
  const fiber = ctx.plugin({ apply: (c) => { applyPtcCreatorToggle(c, () => enabled) } })
  await settle()
  enabled = true
  ctx.emit('loader/volatile-update', [['ptcCreativeMode']])
  await settle()
  await cordis().ready
  assert.ok((cordis().config.plugins as Row[]).some((r) => r['id'] === 'tool-presentation'), '事件驱动打开')
  enabled = false
  ctx.emit('loader/volatile-update', [['ptcCreativeMode']])
  await settle()
  await cordis().ready
  assert.deepEqual(cordis().config.plugins, cordisRows(), '事件驱动关闭')
  await fiber.dispose()
})
