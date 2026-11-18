/**
 * 在宿主技能注册表（`ctx.skills`，`@deepseek-ai/dsh-skill`）上装一层过滤：
 * 宿主的 `list` 从 `snapshot` 取清单，两者共用过滤后的结果。`get` 独立加载正文，单独应用调用权限。
 *
 * ## 为什么要包注册表的方法
 *
 * 注册表没有过滤钩子（0.2.0-rc.2）：插件只能 `registerProvider` 加来源，改不了别的来源给出的条目；
 * 同名靠「近的层优先」裁决，个人技能盖不过项目技能。所以这里直接在注册表实例上放同名自有属性，
 * 调用原方法拿到结果再改写；卸载时只撤自己装的那一层（别的插件后来又包了一层就留一层直通）。
 * 做法与 dsh-compaction-tuning 包模式注册表的 `register` 相同：服务对象读出来是代理，
 * 只能看自有属性描述符判断「现在装的是不是我们那一份」。
 *
 * ## 删除条件
 *
 * 宿主给技能注册表加上按名覆盖可见性的公开配置（像 Claude Code 的 skillOverrides）后，本文件整个删掉。
 */
import { applyLevel, resolveSkill, scopeOfSource, type CandidateLike, type ExposureDocument, type SkillLevel } from './rules.ts'

/** 注册表里用到的三个方法。 */
export interface RegistryLike {
  list(options?: LookupOptions): Promise<CandidateLike[]>
  snapshot(options?: LookupOptions): Promise<{ skills: CandidateLike[]; complete: boolean }>
  get(name: string, options?: LookupOptions): Promise<CandidateLike | undefined>
}

export interface LookupOptions {
  cwd?: string
  scope?: unknown
  signal?: AbortSignal
  [key: string]: unknown
}

export interface FilterDeps {
  document(): ExposureDocument
  projectRoot(cwd: string): string
  home: string
  /** 摘要里看不到来源时，用它判断（测试和宿主都能给）。 */
  logger?: { warn(message: string): void }
}

/** 改写一组摘要：off 拿掉，user-only 关掉模型调用，name-only 换短介绍。 */
export function filterSummaries<T extends CandidateLike>(skills: readonly T[], doc: ExposureDocument, root: string | undefined, home: string): T[] {
  const out: T[] = []
  for (const skill of skills) {
    const changed = applyLevel(skill, resolveSkill(doc, skill.name, root, home).level)
    if (changed !== undefined) out.push(changed)
  }
  return out
}

function rootOf(options: LookupOptions | undefined, deps: FilterDeps): string | undefined {
  const cwd = options?.cwd
  return typeof cwd === 'string' && cwd !== '' ? deps.projectRoot(cwd) : undefined
}

/** 不过滤，原样调注册表；设置页列全量技能时用（被设成 off 的也要能在页面上改回来）。 */
export interface RawAccess {
  list(options?: LookupOptions): Promise<CandidateLike[]>
}

export interface FilterHandle {
  raw: RawAccess
  dispose(): void
}

function findMethod(target: object, key: string): unknown {
  for (let proto: object | null = Object.getPrototypeOf(target); proto !== null; proto = Object.getPrototypeOf(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, key)
    if (descriptor !== undefined) return descriptor.value
  }
  return undefined
}

export function isRegistry(value: unknown): value is RegistryLike {
  if (typeof value !== 'object' || value === null) return false
  const r = value as Record<string, unknown>
  return typeof r['list'] === 'function' && typeof r['snapshot'] === 'function' && typeof r['get'] === 'function'
}

/**
 * 装上过滤。`target` 是注册表实例（服务代理也可以：定义属性会落到实例上）。
 */
export function installFilter(target: object, deps: FilterDeps): FilterHandle {
  const obj = target as Record<string, unknown>
  const keys = ['snapshot', 'get'] as const
  const own = Object.fromEntries(keys.map((k) => [k, Object.getOwnPropertyDescriptor(obj, k)]))
  // 取原始函数，调用时把调用方的 this 原样交回去（注册表方法里要用 this 的私有状态）。
  const inner = Object.fromEntries(keys.map((k) => [k, (own[k]?.value ?? findMethod(obj, k)) as (...args: unknown[]) => Promise<unknown>]))
  let active = true

  const wrappers = {
    snapshot: async function (this: unknown, options?: LookupOptions) {
      const snap = await inner['snapshot']!.call(this, options) as { skills: CandidateLike[]; complete: boolean }
      if (!active) return snap
      return { ...snap, skills: filterSummaries(snap.skills, deps.document(), rootOf(options, deps), deps.home) }
    },
    get: async function (this: unknown, name: string, options?: LookupOptions) {
      const skill = await inner['get']!.call(this, name, options) as CandidateLike | undefined
      if (!active || skill === undefined) return skill
      const level: SkillLevel = resolveSkill(deps.document(), skill.name, rootOf(options, deps), deps.home).level
      // name-only 只改清单里的介绍；真加载时要给完整正文和原介绍，否则模型加载了也看不到说明。
      if (level === 'name-only') return skill
      return applyLevel(skill, level)
    },
  }
  for (const k of keys) Object.defineProperty(obj, k, { value: wrappers[k], writable: true, configurable: true, enumerable: false })

  return {
    // 直接调原始 snapshot：宿主 list 里的 this.snapshot 会走到我们包过的那层，设置页就看不到关掉的技能了。
    raw: { list: async (options) => (await inner['snapshot']!.call(target, options) as { skills: CandidateLike[] }).skills },
    dispose() {
      active = false
      for (const k of keys) {
        if (Object.getOwnPropertyDescriptor(obj, k)?.value !== wrappers[k]) continue
        const previous = own[k]
        if (previous === undefined) delete obj[k]
        else Object.defineProperty(obj, k, previous)
      }
    },
  }
}

export { scopeOfSource }
