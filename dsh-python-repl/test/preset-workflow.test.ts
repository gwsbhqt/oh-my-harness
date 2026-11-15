import { strict as assert } from 'node:assert'
import { it } from 'node:test'
import { Context, Service } from '../../tooling/test-support/preset-workflow.ts'
import { Loader, EntryTree, Group } from '../../tooling/test-support/preset-workflow.ts'
import { PythonReplRuntime } from '../../tooling/test-support/preset-workflow.ts'
import { toPtcCreator, fromPtcCreator } from '../src/ptc-creator.ts'
import {
  applyPresetWorkflowOff,
  remount,
  withoutWorkflow,
  withWorkflowRestored,
  type PresetDefinition,
  type PresetGeneration,
  type PresetRecord,
} from '../../tooling/test-support/preset-workflow.ts'
import { seen as runCodeSeen } from './preset-fixtures/run-code.ts'

const WORKFLOW = '@deepseek-ai/dsh-workflow-ptc'
const fixture = (name: string) => new URL(`./preset-fixtures/${name}`, import.meta.url).href

// 按 0.1.7 随附模式的结构裁剪：cordis/standard 的 delegation 组开着 workflow-ptc，ptc 模式里它是关的。
function presetRows(workflowDisabled: boolean): unknown[] {
  return [
    { id: 'persona', name: '@deepseek-ai/dsh-persona' },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: { __jsExpr: "process.platform === 'win32'" } },
    {
      id: 'planning', name: 'cordis:group', group: true, isolate: { planMode: true },
      config: [{ id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode' }],
    },
    {
      id: 'delegation', name: 'cordis:group', group: true, isolate: { workflowEngine: true },
      config: [
        { id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', config: { provider: 'spawn' } },
        { id: 'workflow-ptc', name: WORKFLOW, config: { provider: 'spawn' }, ...(workflowDisabled ? { disabled: true } : {}) },
        { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow', ...(workflowDisabled ? { disabled: true } : {}) },
      ],
    },
  ]
}

const cordisPreset = (): PresetDefinition => ({ id: 'cordis', order: 4, plugins: presetRows(false) })
const ptcPreset = (): PresetDefinition => ({
  id: 'ptc', order: 1, plugins: [...presetRows(true), { id: 'tool-presentation', name: 'run-code' }],
})

type Row = Record<string, unknown>
const delegationOf = (rows: readonly unknown[]) => rows.find((row) => (row as Row).id === 'delegation') as Row
const childIds = (group: Row) => (group.config as Row[]).map((row) => row.id)

const isOff = (row: Row) => row.disabled === true
const workflowRows = (rows: readonly unknown[]) => (delegationOf(rows).config as Row[]).filter((row) => row.id === 'workflow-ptc' || row.id === 'tool-workflow')

it('switches off both workflow rows in the delegation group and leaves the rest as they were', () => {
  const before = presetRows(false)
  const after = withoutWorkflow(before)
  assert.ok(after)
  assert.deepEqual(childIds(delegationOf(after)), ['tool-subagent', 'workflow-ptc', 'tool-workflow'])
  assert.ok(workflowRows(after).every(isOff))
  // 没改的条目保持原对象：`!!js` 节点和别的插件的改写都原样留下。
  for (const index of [0, 1, 2]) assert.equal(after[index], before[index])
  assert.equal((delegationOf(after).config as Row[])[0], (delegationOf(before).config as Row[])[0])
  assert.deepEqual(before, presetRows(false), 'input rows are not mutated')
})

it('leaves presets whose workflows are already off untouched, and overrides a !!js expression', () => {
  assert.equal(withoutWorkflow(presetRows(true)), undefined)
  assert.equal(withoutWorkflow(ptcPreset().plugins), undefined)
  const rows = presetRows(false)
  ;((delegationOf(rows).config as Row[])[1]!).disabled = { __jsExpr: 'false' }
  assert.ok(workflowRows(withoutWorkflow(rows)!).every(isOff))
})

it('reaches nested groups', () => {
  const nested = [{ id: 'outer', name: 'cordis:group', group: true, config: presetRows(false) }]
  const after = withoutWorkflow(nested)!
  assert.ok(workflowRows((after[0] as Row).config as unknown[]).every(isOff))
})

it('undoes only its own rewrite, keeping edits another plugin made meanwhile', () => {
  const rewritten = withoutWorkflow(presetRows(false))!
  assert.deepEqual(withWorkflowRestored(rewritten), presetRows(false))
  const delegation = delegationOf(rewritten)
  const edited = rewritten.map((row) => row === delegation
    ? { ...delegation, config: [...(delegation.config as Row[]), { id: 'other', name: 'other-plugin' }] }
    : row)
  const restored = withWorkflowRestored(edited)!
  assert.deepEqual(childIds(delegationOf(restored)), ['tool-subagent', 'workflow-ptc', 'tool-workflow', 'other'])
  assert.ok(!workflowRows(restored).some(isOff))
  assert.equal(withWorkflowRestored(presetRows(false)), undefined)
  // 另一个插件早先自己关掉的不算我们的，撤销时不打开。
  assert.equal(withWorkflowRestored(presetRows(true)), undefined)
})

// ---------------------------------------------------------------------------
// 真实 cordis + loader（与 App 0.1.7 内同版本、同字节）
// ---------------------------------------------------------------------------

interface Loaded {
  ctx: Context
  await(): Promise<void>
  dispose(): Promise<void>
}

// 测试替身不是带类型的 cordis 插件；这里只要 fiber 的生命周期。
function load(owner: Context, plugin: unknown, config?: unknown): Loaded {
  return (owner.plugin as unknown as (plugin: unknown, config?: unknown) => { ctx: Context })(plugin, config).ctx.fiber as unknown as Loaded
}

class PresetTree extends EntryTree {
  write() {}
  // cordis-plugin-loader 1.1（DSH 0.2.2-rc.1）起持久化改由 commit 承担。
  commit() {}
}

/** 按行 name 换成测试替身；别的都用空插件，只观察 ptcRuntime 这一条线。 */
function standIns(rows: readonly unknown[]): unknown[] {
  return rows.map((raw) => {
    const row = { ...(raw as Row) }
    if (row.group === true) return { ...row, config: standIns(row.config as unknown[]) }
    row.name = row.name === WORKFLOW ? fixture('workflow.mjs')
      : row.name === 'run-code' ? fixture('run-code.ts')
      : fixture('noop.mjs')
    // 替身里不需要按平台开关的条目；表达式求值不是这里要测的。
    if (typeof row.disabled === 'object') delete row.disabled
    return row
  })
}

function withinFiber(fiber: any, root: any): boolean {
  for (let current = fiber; ; current = current.parent.fiber) {
    if (current === root) return true
    if (current.parent.fiber === current) return false
  }
}

/** 同宿主 mountPreset：有失败行或服务漏到根 realm 就拒绝挂载。 */
async function mountRows(owner: Context, rows: readonly unknown[]) {
  let tree!: PresetTree
  const fiber = load(owner, { inject: ['loader'], apply: (ctx: Context) => {
    tree = new PresetTree(ctx)
    ctx.effect(() => () => tree.root.stop())
  } })
  await fiber.await()
  await tree.root.update(standIns(rows) as never)
  await tree.await()
  const failed: string[] = []
  const languages: Record<string, string | undefined> = {}
  for (const entry of tree.entries()) {
    if (entry.options.group || entry.disabled) continue
    try {
      await entry.fiber!.await()
      languages[entry.options.id!] = (entry.fiber!.ctx.get('ptcRuntime') as { language?: string } | undefined)?.language
    } catch (error) {
      failed.push(`${entry.options.id}: ${(error as Error).message}`)
    }
  }
  const store = (owner as any).reflect.store
  const rootIsolate = (owner as any).root[Context.isolate]
  // cordis 4.1（DSH 0.2.2-rc.1）起服务表条目记的是 ctx，之前是 fiber；照官方注册表的 leakedServices 取。
  const leaked = Object.getOwnPropertySymbols(store)
    .filter((key) => store[key] !== undefined && withinFiber(store[key].ctx?.fiber ?? store[key].fiber, fiber) && rootIsolate[store[key].name] === key)
    .map((key) => store[key].name)
  if (failed.length > 0 || leaked.length > 0) {
    fiber.dispose()
    throw new Error([...failed, ...leaked.map((name) => `leaked ${name}`)].join('\n'))
  }
  return { fiber, languages }
}

async function hostWithPython(): Promise<Context> {
  const app = new Context()
  await load(app, Loader).await()
  ;(app.loader as unknown as { builtins: Record<string, unknown> }).builtins.group = Group
  await load(app, PythonReplRuntime, { python: 'python3' }).await()
  assert.equal((app.get('ptcRuntime') as { language: string }).language, 'python')
  return app
}

it('real cordis loader: with workflows off the preset mounts, and everything in it sees the Python runtime', async () => {
  const app = await hostWithPython()
  await assert.rejects(mountRows(app, cordisPreset().plugins), /workflow-ptc: workflow-ptc requires the Node TypeScript PTC runtime/)
  const { fiber, languages } = await mountRows(app, withoutWorkflow(cordisPreset().plugins)!)
  assert.equal(languages['workflow-ptc'], undefined, 'the workflow engine is not mounted')
  assert.equal(languages['tool-subagent'], 'python')
  assert.equal(languages['persona'], 'python')
  fiber.dispose()
})

// ---------------------------------------------------------------------------
// 注册表：按 dsh-agent-preset-registry 0.1.7 的 register/activate/collect 写，
// 挂成真实 cordis 服务，所以方法调用同样经过服务代理。
// ---------------------------------------------------------------------------

interface Generation extends PresetGeneration {
  fiber: { dispose(): unknown }
  languages: Record<string, string | undefined>
  collected: boolean
}

class Registry extends Service {
  definitions = new Map<string, PresetRecord & { generation?: Generation }>()
  callers = new Map<string, unknown>()
  owner: Context
  constructor(ctx: Context) {
    super(ctx, 'agentPresets')
    this.owner = ctx
  }

  async register(definition: PresetDefinition) {
    if (this.definitions.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`)
    // 宿主在这里取 `this.ctx` 当作 record.context（模式的 baseUrl 从它来）。
    this.callers.set(definition.id, (this as unknown as { ctx: Context }).ctx.fiber)
    const record: PresetRecord & { generation?: Generation } = { config: definition, ready: Promise.resolve() }
    this.definitions.set(definition.id, record)
    let disposed = false
    const unregister = async () => {
      if (disposed) return
      disposed = true
      this.definitions.delete(definition.id)
      await record.ready
      if (record.generation !== undefined) {
        record.generation.retired = true
        await this.collect(record.generation)
      }
    }
    record.ready = this.activate(record)
    await record.ready
    return unregister
  }

  async activate(record: PresetRecord & { generation?: Generation }) {
    try {
      const { fiber, languages } = await mountRows(this.owner, record.config.plugins)
      record.generation = { fiber, languages, users: 0, retired: false, collected: false }
    } catch (error) {
      record.broken = (error as Error).message
    }
  }

  async collect(generation: PresetGeneration) {
    const own = generation as Generation
    if (!own.retired || own.users !== 0) return
    own.collected = true
    await own.fiber.dispose()
  }
}

/** 像 dsh-agent-preset 那样通过 ctx.agentPresets 注册。 */
function declare(app: Context, definition: PresetDefinition, fibers?: Map<string, unknown>) {
  return load(app, {
    inject: ['agentPresets'],
    apply: (ctx: Context) => {
      fibers?.set(definition.id, ctx.fiber)
      ctx.effect(() => {
        const pending = (ctx.get('agentPresets') as unknown as Registry).register(definition)
        return async () => (await pending)()
      })
    },
  })
}

async function settle(registry: Registry): Promise<void> {
  for (;;) {
    const readies = [...registry.definitions.values()].map((record) => record.ready)
    await Promise.all(readies)
    await new Promise<void>((resolve) => setImmediate(resolve))
    if ([...registry.definitions.values()].every((record, index) => record.ready === readies[index])) return
  }
}

async function hostWithRegistry() {
  const app = await hostWithPython()
  await load(app, Registry).await()
  const registry = app.get('agentPresets') as unknown as Registry
  const raw = (registry as unknown as Record<symbol, Registry>)[Symbol.for('cordis.original')] ?? registry
  return { app, registry: raw }
}

function ours(app: Context) {
  return load(app, { apply: (ctx: Context) => applyPresetWorkflowOff(ctx) })
}

it('the workflow-off reason is python-repl only: the PTC creator neither adds nor owns it', () => {
  const rows = presetRows(false)
  // 创造模式只补呈现条目，不动工作流
  const creatorOn = toPtcCreator(rows, { id: 'tool-presentation', name: '@deepseek-ai/dsh-tool-executor-ptc' })!
  assert.deepEqual(workflowRows(creatorOn), workflowRows(rows), 'the creator leaves workflow rows untouched')
  // python-repl 关掉工作流后，创造模式撤销只删自己的呈现条目，不会把工作流打开
  const off = withoutWorkflow(creatorOn)!
  const creatorOff = fromPtcCreator(off)!
  assert.ok(workflowRows(creatorOff).every(isOff), 'the creator dispose does not restore workflows it never turned off')
  // 只有 python-repl 撤销才把工作流打开
  assert.ok(!workflowRows(withWorkflowRestored(creatorOff)!).some(isOff), 'removing the python-repl reason restores workflows')
})

it('presets registered before the plugin: cordis is remounted with workflows off, ptc stays byte-for-byte', async () => {
  const { app, registry } = await hostWithRegistry()
  runCodeSeen.length = 0
  await declare(app, cordisPreset()).await()
  await declare(app, ptcPreset()).await()
  await settle(registry)
  const cordis = registry.definitions.get('cordis')!
  const ptc = registry.definitions.get('ptc')!
  assert.match(cordis.broken ?? '', /workflow-ptc requires the Node TypeScript PTC runtime/)
  assert.equal(cordis.generation, undefined)
  const ptcConfig = ptc.config
  const ptcGeneration = ptc.generation

  const plugin = ours(app)
  await plugin.await()
  await settle(registry)

  assert.equal(cordis.broken, undefined)
  // 读回注册表里的记录，不沿用上面 assert.equal 收窄过的类型。
  assert.ok(registry.definitions.get('cordis')!.generation !== undefined)
  assert.ok(workflowRows(cordis.config.plugins).every(isOff))
  assert.equal(ptc.config, ptcConfig, 'ptc record is not rewritten')
  assert.equal(ptc.generation, ptcGeneration, 'ptc record is not remounted')
  assert.deepEqual(runCodeSeen, ['python'], "ptc preset's run_code still sees the Python runtime")

  const mounted = registry.definitions.get('cordis')!.generation!
  await plugin.dispose()
  await settle(registry)
  assert.deepEqual(cordis.config.plugins, presetRows(false), 'dispose restores the declared rows')
  assert.match(cordis.broken ?? '', /workflow-ptc requires/)
  assert.equal(cordis.generation, undefined)
  assert.ok(mounted.retired && mounted.collected, 'the workflow-off generation is retired and collected')
  assert.equal(ptc.generation, ptcGeneration)
})

it('presets registered after the plugin are rewritten before they mount', async () => {
  const { app, registry } = await hostWithRegistry()
  const plugin = ours(app)
  await plugin.await()
  const fibers = new Map<string, unknown>()
  await declare(app, cordisPreset(), fibers).await()
  await declare(app, ptcPreset()).await()
  await settle(registry)

  const cordis = registry.definitions.get('cordis')!
  assert.equal(registry.callers.get('cordis'), fibers.get('cordis'), 'the wrapped register still sees the declaring plugin as its caller')
  assert.equal(cordis.broken, undefined)
  assert.ok(cordis.generation !== undefined && workflowRows(cordis.config.plugins).every(isOff))
  assert.deepEqual(registry.definitions.get('ptc')!.config.plugins, ptcPreset().plugins)

  await plugin.dispose()
  await settle(registry)
  assert.deepEqual(cordis.config.plugins, presetRows(false))
  // 撤掉之后再注册的模式不再被改写。
  await declare(app, { id: 'standard', plugins: presetRows(false) }).await()
  await settle(registry)
  assert.match(registry.definitions.get('standard')!.broken ?? '', /workflow-ptc requires/)
})

it('an agent holding the old generation keeps it until it lets go', async () => {
  const { app, registry } = await hostWithRegistry()
  const plugin = ours(app)
  await plugin.await()
  await declare(app, cordisPreset()).await()
  await settle(registry)
  const cordis = registry.definitions.get('cordis')!
  const held = cordis.generation!
  held.users++
  await plugin.dispose()
  await settle(registry)
  assert.ok(held.retired)
  assert.equal(held.collected, false, 'a generation with users is not collected')
  held.users--
  await registry.collect(held)
  assert.ok(held.collected)
})

it('serialises with another plugin rewriting the same record, and dispose keeps its edit', async () => {
  const { app, registry } = await hostWithRegistry()
  await declare(app, cordisPreset()).await()
  await settle(registry)
  const cordis = registry.definitions.get('cordis')!
  const otherRow = { id: 'other', name: '@example/other' }
  const addOther = (rows: readonly unknown[]) => rows.some((row) => (row as Row).id === 'other') ? undefined : [...rows, otherRow]

  // 两边在同一拍内排队：第二个改写必须读到第一个的结果，而不是注册时那份。
  const plugin = ours(app)
  await plugin.await()
  const warnings: unknown[] = []
  await remount(registry, cordis, addOther, (error) => warnings.push(error))
  await settle(registry)
  assert.deepEqual(warnings, [])
  assert.ok(cordis.config.plugins.includes(otherRow))
  assert.ok(workflowRows(cordis.config.plugins).every(isOff))
  assert.equal(cordis.broken, undefined)

  await plugin.dispose()
  await settle(registry)
  assert.ok(cordis.config.plugins.includes(otherRow), "the other plugin's row survives our dispose")
  assert.ok(!workflowRows(cordis.config.plugins).some(isOff))
})

it('a register wrapper installed on top of ours survives our dispose', async () => {
  const { app, registry } = await hostWithRegistry()
  const plugin = ours(app)
  await plugin.await()
  const inner = Object.getOwnPropertyDescriptor(registry, 'register')!.value as Registry['register']
  const calls: string[] = []
  const outer = function (this: unknown, definition: PresetDefinition) {
    calls.push(definition.id)
    return inner.call(this, definition)
  }
  Object.defineProperty(registry, 'register', { value: outer, writable: true, configurable: true })
  await plugin.dispose()
  assert.equal(Object.getOwnPropertyDescriptor(registry, 'register')!.value, outer)
  await declare(app, cordisPreset()).await()
  await settle(registry)
  assert.deepEqual(calls, ['cordis'])
  assert.deepEqual(registry.definitions.get('cordis')!.config.plugins, presetRows(false), 'ours passes through once disposed')
})