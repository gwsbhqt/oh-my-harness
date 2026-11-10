/**
 * 压缩后原样留下多少近期对话：给每个模式里 `@deepseek-ai/dsh-compaction-basic` 那一行补上 `retainTokens`。
 *
 * 补丁层只能整份替换模式的条目清单，够不着里面的一行；整份覆盖 PTC 模式会让它不再跟着 DSH 升级。
 * 包住模式注册表的 `register`，在注册表自己的记录上改写，再按它的方式重新挂载。
 * 只补没写保留量的行（行里已有 `retainTokens` / `retainRatio` 的不动），其余键原样保留；卸载时只撤自己补的。
 *
 * @module
 */

export const COMPACTION_PACKAGE = '@deepseek-ai/dsh-compaction-basic'

type Row = Record<string, unknown>

export interface PresetDefinition {
  readonly id: string
  readonly plugins: readonly unknown[]
  readonly [key: string]: unknown
}
interface MountedEntry { options: { name?: unknown; group?: unknown }; fiber?: { state?: unknown; effectiveConfig?: unknown } }
export interface PresetGeneration { users: number; retired: boolean; mount?: { tree?: { entries(): Iterable<MountedEntry> } } }
export interface PresetRecord { config: PresetDefinition; ready: Promise<void>; generation?: PresetGeneration; broken?: string }
export interface PresetRegistry {
  readonly definitions: Map<string, PresetRecord>
  register(definition: PresetDefinition): Promise<unknown>
  activate(record: PresetRecord): Promise<void>
  collect(generation: PresetGeneration): Promise<void>
}

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 本插件改过的行 → 改之前的行，卸载时按身份换回。 */
const touched = new WeakMap<object, Row>()

function hasRetention(config: unknown): boolean {
  return isRow(config) && (config['retainTokens'] !== undefined || config['retainRatio'] !== undefined)
}

/**
 * 给清单里（含嵌套组）每一行压缩引擎补 `retainTokens`。不改入参，没改的行保持原对象。
 * @returns 改写后的清单；没有可补的行返回 undefined
 */
export function withRetain(rows: readonly unknown[], retainTokens: number): unknown[] | undefined {
  let changed = false
  const out = rows.map((row) => {
    if (!isRow(row)) return row
    if (row['group'] === true && Array.isArray(row['config'])) {
      const children = withRetain(row['config'], retainTokens)
      if (children === undefined) return row
      changed = true
      return { ...row, config: children }
    }
    if (row['name'] !== COMPACTION_PACKAGE || touched.has(row)) return row
    const config = row['config']
    if (config !== undefined && !isRow(config)) return row
    if (hasRetention(config)) return row
    changed = true
    const next = { ...row, config: { ...(config ?? {}), retainTokens } }
    touched.set(next, row)
    return next
  })
  return changed ? out : undefined
}

/** 撤掉 {@link withRetain} 补的值。 */
export function withoutRetain(rows: readonly unknown[]): unknown[] | undefined {
  let changed = false
  const out = rows.map((row) => {
    if (!isRow(row)) return row
    const before = touched.get(row)
    if (before !== undefined) { changed = true; return before }
    if (row['group'] === true && Array.isArray(row['config'])) {
      const children = withoutRetain(row['config'])
      if (children === undefined) return row
      changed = true
      return { ...row, config: children }
    }
    return row
  })
  return changed ? out : undefined
}

/** 本插件补过、当前仍生效的保留量；没有返回 undefined。给状态和测试用。 */
export function injectedRetain(rows: readonly unknown[]): number | undefined {
  for (const row of rows) {
    if (!isRow(row)) continue
    if (touched.has(row) && isRow(row['config'])) return row['config']['retainTokens'] as number
    if (row['group'] === true && Array.isArray(row['config'])) {
      const found = injectedRetain(row['config'])
      if (found !== undefined) return found
    }
  }
  return undefined
}

/** 改写一条记录并照注册表的方式重新挂载，保留其他配置和卸载链。 */
export function remount(
  registry: PresetRegistry,
  record: PresetRecord,
  rewrite: (config: PresetDefinition) => PresetDefinition | undefined,
  onError: (error: unknown) => void,
): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    if (registry.definitions.get(record.config.id) !== record) return false
    const config = rewrite(record.config)
    if (config === undefined) return false
    const previous = record.generation
    record.config = config
    await registry.activate(record)
    if (record.generation === previous) delete record.generation
    else delete record.broken
    if (previous !== undefined) {
      previous.retired = true
      await registry.collect(previous)
    }
    return true
  }
  const turn = record.ready.then(run, run).catch((error: unknown) => {
    onError(error)
    return false
  })
  // 宿主的诊断、retain、unregister 都等 ready，它不能 reject
  record.ready = turn.then(() => undefined)
  return turn
}

function ownOrInherited(target: object, key: string): PropertyDescriptor | undefined {
  for (let at: object | null = target; at !== null; at = Object.getPrototypeOf(at)) {
    const found = Object.getOwnPropertyDescriptor(at, key)
    if (found !== undefined) return found
  }
  return undefined
}

export interface RetainState { ok: boolean; message?: string; presets: string[] }

export interface MountedRetain { preset: string; broken?: string; rows: Array<{ retainTokens?: unknown; fiberState?: unknown }> }

/** 从每个模式实际挂载的树里读压缩引擎行的生效配置（宿主解析后的值，不是本插件写进记录的值）。 */
export function mountedRetain(registry: PresetRegistry): MountedRetain[] {
  return [...registry.definitions.values()].map((record) => {
    const rows: MountedRetain['rows'] = []
    const tree = record.generation?.mount?.tree
    if (tree !== undefined && typeof tree.entries === 'function') {
      for (const entry of tree.entries()) {
        if (entry.options?.group || entry.options?.name !== COMPACTION_PACKAGE) continue
        const config = entry.fiber?.effectiveConfig
        rows.push({ retainTokens: isRow(config) ? config['retainTokens'] : undefined, fiberState: entry.fiber?.state })
      }
    }
    return { preset: record.config.id, ...(record.broken === undefined ? {} : { broken: record.broken }), rows }
  })
}

/**
 * 装到模式注册表上：已注册的模式现在改写重挂，之后（重新）注册的在挂载前改写。
 * 挂载失败就换回原样再挂一次，压缩照宿主默认的保留量走。
 * @returns 卸载函数：不再改写，并把模式换回原样
 */
export function installRetain(
  registry: PresetRegistry,
  retainTokens: number,
  logger: { info(message: string): void; warn(message: string): void },
  state: RetainState,
  onSettled: () => void = () => undefined,
): () => Promise<void> {
  let active = true
  const rewrite = (config: PresetDefinition): PresetDefinition | undefined => {
    const plugins = withRetain(config.plugins, retainTokens)
    return plugins === undefined ? undefined : { ...config, plugins }
  }
  const restore = (config: PresetDefinition): PresetDefinition | undefined => {
    const plugins = withoutRetain(config.plugins)
    return plugins === undefined ? undefined : { ...config, plugins }
  }
  const mark = (id: string) => { if (!state.presets.includes(id)) state.presets.push(id) }
  const settle = (record: PresetRecord) => (done: boolean) => {
    if (!done) return
    if (record.broken === undefined) { mark(record.config.id); return }
    state.ok = false
    state.message = `模式 ${record.config.id} 补保留量后挂载失败（${record.broken}），已换回原样`
    logger.warn(state.message)
    void remount(registry, record, restore, () => undefined)
  }
  const warn = (error: unknown) => {
    state.ok = false
    state.message = `重新挂载模式失败：${error instanceof Error ? error.message : String(error)}`
    logger.warn(state.message)
  }

  const previous = Object.getOwnPropertyDescriptor(registry, 'register')
  const original = ownOrInherited(registry, 'register')?.value as PresetRegistry['register']
  function register(this: unknown, definition: PresetDefinition): Promise<unknown> {
    const next = active ? rewrite(definition) : undefined
    if (next !== undefined) mark(definition.id)
    const done = original.call(this, next ?? definition)
    void done.then(onSettled, () => undefined)
    return done
  }
  Object.defineProperty(registry, 'register', { value: register, writable: true, configurable: true, enumerable: false })

  state.ok = true
  delete state.message
  void Promise.all([...registry.definitions.values()].map((record) => remount(registry, record, rewrite, warn).then(settle(record)))).then(onSettled)
  logger.info(`压缩后近期原文保留量补为 ${retainTokens}（估算 token）`)

  return async () => {
    active = false
    if (Object.getOwnPropertyDescriptor(registry, 'register')?.value === register) {
      if (previous === undefined) delete (registry as { register?: unknown }).register
      else Object.defineProperty(registry, 'register', previous)
    }
    state.presets.length = 0
    await Promise.all([...registry.definitions.values()].map((record) =>
      remount(registry, record, restore, (error) => logger.warn(`模式 ${record.config.id} 还原失败：${error instanceof Error ? error.message : String(error)}`))))
  }
}

/** 注册表上需要的内部成员都在才装；不在说明 DSH 改了注册表，不装、留原因。 */
export function isPresetRegistry(value: unknown): value is PresetRegistry {
  const r = value as Partial<PresetRegistry> | undefined
  return r !== undefined && r !== null && r.definitions instanceof Map && typeof r.activate === 'function' && typeof r.collect === 'function' && typeof r.register === 'function'
}
