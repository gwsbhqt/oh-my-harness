/**
 * PTC 创造模式（在 dsh-python-repl 里，默认关闭，由配置项 `ptcCreativeMode` 打开）。
 *
 * 打开时继承 DSH 自带的创造模式（id `cordis`），运行时只做两处微调：
 *
 * 1. 不起名字：注册表里没有名字的 `cordis` 才算内置模式，网页的名字和说明由浏览器半换成 PTC 创造模式；
 * 2. 加上 PTC 模式的工具呈现条目（从当前 PTC 模式现取），模型只看到 run_code；并补上 PTC 有、创造模式没有的通用工具
 *    （{@link CARRIED}，从当前 PTC 模式现取）：0.2.2-rc.2 起是 `tool-office`，Office 渲染、转换、重算从技能改成了这个工具。
 *
 * 工作流不在这里关：本插件（dsh-python-repl）本来就无条件关掉所有模式的工作流（见 preset-workflow.ts），
 * 所以这里只补呈现条目和照搬的通用工具，不再另记一条「关闭原因」。卸载时只撤自己补上的对象，别的插件的改动不动。
 *
 * 其余条目全部照官方创造模式当时的样子，官方以后改了创造模式自动跟上。补丁层够不着模式内部的条目，
 * 所以复用 preset-workflow.ts 的 `remount`：在模式注册表自己的记录上改、按注册表的方式重新挂载。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import {
  ownOrInherited,
  remount,
  type PresetDefinition,
  type PresetRegistry,
} from './preset-workflow.ts'

export const CREATOR_ID = 'cordis'
export const PTC_ID = 'ptc'
const PRESENTATION = new Set(['@deepseek-ai/dsh-tool-executor-ptc', '@deepseek-ai/dsh-agent-tool-presentation'])
/** 从 PTC 模式照搬的条目 id，放在 present 后面，和 PTC 模式里的顺序一样。 */
export const CARRIED: readonly string[] = ['tool-office']

type Row = Record<string, unknown>

function isRow(value: unknown): value is Row {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 本插件添加的呈现条目/照搬条目，卸载时按身份移除。 */
const touched = new WeakMap<object, Row | null>()

/** PTC 模式里的工具呈现条目；找不到就是 undefined（PTC 模式没装上或官方改了结构）。 */
export function presentationRow(ptcPlugins: readonly unknown[] | undefined): Row | undefined {
  return (ptcPlugins ?? []).find((row): row is Row => isRow(row) && PRESENTATION.has(row['name'] as string))
}

/** PTC 模式里要照搬的条目（{@link CARRIED}），PTC 模式没有的跳过。 */
export function carriedRows(ptcPlugins: readonly unknown[] | undefined): Row[] {
  return CARRIED.flatMap((id) => (ptcPlugins ?? []).filter((row): row is Row => isRow(row) && row['id'] === id).slice(0, 1))
}

/**
 * 创造模式的条目 → PTC 创造模式的条目。不改入参，没改的条目保持原对象（`!!js` 节点和别的插件的改动都留着）。
 * 不碰工作流条目：本插件的 preset-workflow 已经无条件关掉所有模式的工作流。
 * @returns 改写后的条目；已经改过、或缺 PTC 模式的呈现条目时返回 undefined
 */
export function toPtcCreator(rows: readonly unknown[], presentation: Row | undefined, carried: readonly Row[] = []): unknown[] | undefined {
  let out = [...rows]
  let changed = false
  if (presentation !== undefined && !out.some((row) => isRow(row) && row['name'] === presentation['name'])) {
    const copy = { ...presentation }
    touched.set(copy, null)
    // 放在 present 前面，和 PTC 模式里的顺序一样
    const at = out.findIndex((row) => isRow(row) && row['id'] === 'present')
    out = at < 0 ? [...out, copy] : [...out.slice(0, at), copy, ...out.slice(at)]
    changed = true
  }
  let after = out.findIndex((row) => isRow(row) && row['id'] === 'present')
  for (const row of carried) {
    if (out.some((r) => isRow(r) && r['id'] === row['id'])) continue
    const copy = { ...row }
    touched.set(copy, null)
    after = after < 0 ? out.length : after + 1
    out = [...out.slice(0, after), copy, ...out.slice(after)]
    changed = true
  }
  return changed ? out : undefined
}

/** 撤掉 {@link toPtcCreator} 的改动：删掉补上的呈现条目和照搬的条目，其余原样保留。 */
export function fromPtcCreator(rows: readonly unknown[]): unknown[] | undefined {
  let changed = false
  const out: unknown[] = []
  for (const row of rows) {
    if (!isRow(row)) { out.push(row); continue }
    if (touched.has(row)) {
      changed = true
      const before = touched.get(row)
      if (before !== null && before !== undefined) out.push(before)
      continue
    }
    if (row['group'] === true && Array.isArray(row['config'])) {
      const children = fromPtcCreator(row['config'])
      if (children !== undefined) { changed = true; out.push({ ...row, config: children }); continue }
    }
    out.push(row)
  }
  return changed ? out : undefined
}

export interface CreatorState { ok: boolean; message?: string }

/**
 * 装到模式注册表上：已注册的创造模式现在改写重挂，之后（重新）注册的在挂载前改写。
 * @returns 卸载函数：不再改写，并把创造模式换回官方的样子
 */
export function installPtcCreator(
  registry: PresetRegistry,
  logger: { info(message: string): void; warn(message: string): void },
  state: CreatorState,
): () => Promise<void> {
  let active = true
  const ptcPlugins = () => registry.definitions.get(PTC_ID)?.config.plugins
  const enable = (rows: readonly unknown[]): unknown[] | undefined => {
    const presentation = presentationRow(ptcPlugins())
    if (presentation === undefined) {
      state.ok = false
      state.message = '找不到 PTC 模式的工具呈现条目，创造模式没改成 PTC 创造模式'
      logger.warn(state.message)
    }
    return toPtcCreator(rows, presentation, carriedRows(ptcPlugins()))
  }
  const disable = (rows: readonly unknown[]): unknown[] | undefined => fromPtcCreator(rows)
  const warn = (error: unknown) => {
    state.ok = false
    state.message = `PTC 创造模式重新挂载失败：${error instanceof Error ? error.message : String(error)}`
    logger.warn(state.message)
  }

  const previous = Object.getOwnPropertyDescriptor(registry, 'register')
  const original = ownOrInherited(registry, 'register')?.value as PresetRegistry['register']
  function register(this: unknown, definition: PresetDefinition): Promise<unknown> {
    const next = active && definition.id === CREATOR_ID ? enable(definition.plugins) : undefined
    return original.call(this, next === undefined ? definition : { ...definition, plugins: next })
  }
  Object.defineProperty(registry, 'register', { value: register, writable: true, configurable: true, enumerable: false })

  state.ok = true
  delete state.message
  const record = registry.definitions.get(CREATOR_ID)
  if (record !== undefined) {
    void remount(registry, record, enable, warn).then((done) => {
      if (!done) return
      if (record.broken === undefined) logger.info('创造模式已改成 PTC 创造模式')
      else warn(new Error(record.broken))
    })
  }

  return async () => {
    active = false
    if (Object.getOwnPropertyDescriptor(registry, 'register')?.value === register) {
      if (previous === undefined) delete (registry as { register?: unknown }).register
      else Object.defineProperty(registry, 'register', previous)
    }
    const current = registry.definitions.get(CREATOR_ID)
    if (current !== undefined) await remount(registry, current, disable, (error) => logger.warn(`创造模式还原失败：${error instanceof Error ? error.message : String(error)}`))
  }
}

/** 注册表上需要的内部成员都在才装；不在就说明 DSH 改了注册表，不装、留原因。 */
export function isPresetRegistry(value: unknown): value is PresetRegistry {
  const r = value as Partial<PresetRegistry> | undefined
  return r !== undefined && r !== null && r.definitions instanceof Map && typeof r.activate === 'function' && typeof r.collect === 'function' && typeof r.register === 'function'
}

/**
 * 按配置项 `ptcCreativeMode` 的真假装/卸 PTC 创造模式，并跟随 volatile 配置的原地更新。
 *
 * `isEnabled` 每次读当前值（配置项是 volatile 单元格，loader 原地提交新值后调用 `refresh`）。
 * 注册表可用时装上/卸下两半；`loader/volatile-update` 里 `ptcCreativeMode` 变化时重新同步。
 * @returns `refresh`：手动重新同步（测试也用它模拟开关）。
 */
export function applyPtcCreatorToggle(ctx: Context, isEnabled: () => boolean): () => void {
  const state: CreatorState = { ok: false, message: '模式注册表还没就绪' }
  let installed: (() => Promise<void>) | undefined
  let refresh: (() => void) | undefined
  ctx.inject(['agentPresets'], (scoped: Context) => {
    const registry = scoped.get('agentPresets' as never) as unknown
    if (!isPresetRegistry(registry)) {
      state.ok = false
      state.message = 'DSH 的模式注册表少了 definitions/activate/collect/register，创造模式没改成 PTC 创造模式'
      scoped.logger('python-repl').warn(state.message)
      return
    }
    const logger = scoped.logger('python-repl')
    const sync = () => {
      const on = isEnabled()
      if (on && installed === undefined) installed = installPtcCreator(registry, logger, state)
      else if (!on && installed !== undefined) {
        const dispose = installed
        installed = undefined
        void dispose()
      }
    }
    refresh = sync
    scoped.effect(() => {
      sync()
      const off = scoped.on('loader/volatile-update', (paths) => {
        if (paths.some((path) => path.length === 1 && path[0] === 'ptcCreativeMode')) sync()
      })
      return async () => {
        off()
        if (installed !== undefined) {
          const dispose = installed
          installed = undefined
          await dispose()
        }
      }
    }, 'python-repl: ptc creator')
  })
  return () => refresh?.()
}
