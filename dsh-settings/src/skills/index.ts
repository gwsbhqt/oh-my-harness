/**
 * dsh-settings 的技能模块（宿主半）：在设置页按「全局 / 每个项目」调整每个技能给模型看多少，
 * 普通技能和 py 技能分开管。规则存在 `~/.agents/skill-exposure.json`（dotfiles 跟踪）。
 *
 * - 普通技能：在宿主技能注册表上装一层过滤（见 filter.ts），四档 on / name-only / user-only / off。
 * - py 技能：提供 `skillExposure` 服务，python-repl 建内核时按会话的项目根问一次「哪些不导入」，两档 on / off。
 * - 设置页「技能」一页走 `/api/settings.skillsOverview`、`/api/settings.skillsSave`；保存是**一次完整提交**：
 *   页面把这一批改动一起送来，宿主在同一个串行读改写里写回，其他项目的规则原样保留。
 *
 * 改规则对新的一步立即生效（模型下一次请求前技能清单会按新规则重发）；
 * py 技能只影响之后新开的内核，已经开着的内核要 `repl.restart()` 或新会话。
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import { createRouteRegistry } from '../../../tooling/runtime/routes.mjs'
import { ownerGateway, type ConnectionLike, type HostGatewayLike, type OwnerGateway } from '../../../tooling/runtime/gateway.mjs'
import { installFilter, isRegistry, type FilterHandle, type LookupOptions } from './filter.ts'
import { expandHome, resolvePySkill, resolveSkill, scopeOfSource, setLevel, type ExposureDocument, type PyLevel, type SkillLevel } from './rules.ts'
import { DocumentStore, findProjectRoot, home } from './store.ts'
import { route, RouteError, obj } from '../routes.ts'

/** 对 python-repl 提供的服务名。python-repl 现取，没装本插件时它照旧全导入。 */
export const SERVICE = 'skillExposure'

export interface SkillExposureService {
  /** 这个工作目录下不该导入的 py 技能（按 SKILL.md 的 name，没有就是目录名）。 */
  disabledPySkills(cwd: string | undefined): string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    skillExposure: SkillExposureService
  }
}

/** python-repl 发现的一个 py 技能（它的 `pythonSkills` 服务给的，字段同它的 SkillSummary）。 */
interface PySkill {
  skill: string
  description: string
  path: string
  import_name: string | null
}

/** 能导入的 py 技能，按 python-repl 自己的发现结果；给了目录就连同那个项目里的一起列。没装 python-repl 就没有。 */
function pySkills(ctx: Context, cwd?: string): PySkill[] {
  const service = ctx.get('pythonSkills' as never) as { list?(cwd?: string): PySkill[] } | undefined
  return (service?.list?.(cwd) ?? []).filter((s) => s.import_name !== null)
}

/** 一层一层的档位改动合成一次写完：要么全成，要么全不动（store.update 串行读改写，其他项目保留）。 */
export async function saveSkills(store: DocumentStore, payload: Record<string, unknown>): Promise<void> {
  const project = typeof payload['project'] === 'string' ? payload['project'] : ''
  const layer = project === '' ? { layer: 'global' as const } : { layer: 'project' as const, root: project }
  const skills = obj(payload['skills'])
  const pyTable = obj(payload['pySkills'])
  const entries: Array<['skills' | 'pySkills', string, unknown]> = [
    ...Object.entries(skills).map(([name, level]) => ['skills', name, level] as ['skills', string, unknown]),
    ...Object.entries(pyTable).map(([name, level]) => ['pySkills', name, level] as ['pySkills', string, unknown]),
  ]
  if (entries.length === 0) return
  await store.update((current) => {
    if (current.error !== undefined) throw new RouteError('broken-file', `规则文件写错了，先修好再改：${current.error}`)
    let doc = current.doc
    for (const [kind, name, level] of entries) {
      doc = setLevel(doc, layer, kind, name, level === null || level === undefined ? undefined : String(level), home())
    }
    return doc
  })
}

const registerRoutes = createRouteRegistry()

export function applySkills(ctx: Context): void {
  const logger = ctx.logger('dsh-settings')
  const store = new DocumentStore()
  const document = (): ExposureDocument => store.read().doc
  const first = store.read()
  if (first.error !== undefined) logger.warn(first.error)
  else logger.info(`技能暴露规则：${first.exists ? first.path : '还没有规则文件，全部按默认显示'}`)

  // 普通技能：包注册表
  let handle: FilterHandle | undefined
  const registry = ctx.get('skills') as unknown
  if (isRegistry(registry)) {
    handle = installFilter(registry as object, { document, projectRoot: findProjectRoot, home: home(), logger })
    ctx.effect(() => () => { handle?.dispose(); handle = undefined }, 'settings: skill registry filter')
  } else {
    logger.warn('宿主技能注册表的形状对不上（list/snapshot/get），普通技能的规则不生效')
  }

  // py 技能：给 python-repl 的服务
  const service: SkillExposureService = {
    disabledPySkills(cwd) {
      const projectRoot = cwd === undefined || cwd === '' ? undefined : findProjectRoot(cwd)
      const doc = document()
      const names = new Set<string>()
      for (const [n, level] of Object.entries(doc.global.pySkills)) if (level === 'off') names.add(n)
      for (const { skill } of pySkills(ctx, cwd)) {
        if (resolvePySkill(doc, skill, projectRoot, home()).level === 'off') names.add(skill)
        else names.delete(skill)
      }
      return [...names].sort()
    },
  }
  ctx.provide(SERVICE, service)

  // 设置页接口
  ctx.inject(['connection'], (connectionCtx: Context) => {
    const connection = connectionCtx.get('connection') as { fetch?: { register?: (route: import('../routes.ts').FetchRoute) => () => void } } | undefined
    const register = connection?.fetch?.register
    if (register === undefined) return
    registerRoutes(
      (install, label) => connectionCtx.effect(install, label),
      register,
      () => [
        route('skillsOverview', async (payload) => overview(ctx, store, handle, String(obj(payload)['project'] ?? ''))),
        route('skillsSave', async (payload) => {
          await saveSkills(store, obj(payload))
          logger.info(`技能暴露：${String(obj(payload)['project'] ?? '') || '全局'} 保存了一批改动`)
          return overview(ctx, store, handle, String(obj(payload)['project'] ?? ''))
        }),
      ],
      (r) => `settings: ${r.path} route`,
    )
  })
}

/** 设置页一次拿全：规则文件状态、可选项目、当前视角下每个技能的档和来源。 */
async function overview(ctx: Context, store: DocumentStore, handle: FilterHandle | undefined, project: string) {
  const read = store.read()
  const doc = read.doc
  const h = home()
  const root = project === '' ? undefined : project
  const projects = await knownProjects(ctx, doc)
  let skills: Array<Record<string, unknown>> = []
  let skillsError: string | undefined
  if (handle === undefined) skillsError = '宿主技能注册表对不上，普通技能的规则没装上'
  else {
    // 个人技能、项目技能的来源是各会话模式自己挂的（skill-filesystem 在模式里），不带模式作用域只看得到全局的几个。
    // 照宿主 skills/list 的做法借默认模式的作用域；没有模式注册表就退回全局视图。
    const presets = ctx.get('agentPresets' as never) as { acquireScope?(id?: string): Promise<{ key: unknown } & AsyncDisposable> } | undefined
    let lease: ({ key: unknown } & AsyncDisposable) | undefined
    try {
      try { lease = await presets?.acquireScope?.() } catch { lease = undefined }
      // 全局视角不能拿家目录当 cwd：~/.agents/skills 同时是「家目录这个项目」的项目技能目录，个人技能会被算成项目技能。
      const all = await handle.raw.list({ cwd: root ?? '/', ...(lease === undefined ? {} : { scope: lease.key }) } as LookupOptions)
      skills = all.map((s) => {
        const resolved = resolveSkill(doc, s.name, root, h)
        const scope = scopeOfSource(s['source'])
        return {
          name: s.name,
          description: s.description,
          path: typeof s['path'] === 'string' ? s['path'] : undefined,
          source: typeof s['source'] === 'string' ? s['source'] : undefined,
          scope,
          declared: s.invocation,
          level: resolved.level,
          from: resolved.from,
          global: doc.global.skills[s.name] ?? null,
          project: root === undefined ? null : (projectEntry(doc, root, h)?.skills[s.name] ?? null),
        }
      })
    } catch (error) {
      skillsError = error instanceof Error ? error.message : String(error)
    } finally {
      await lease?.[Symbol.asyncDispose]()
    }
  }
  const py = pySkills(ctx, root).map((s) => {
    const resolved = resolvePySkill(doc, s.skill, root, h)
    return {
      name: s.skill,
      description: s.description,
      importName: s.import_name,
      dir: s.path,
      level: resolved.level,
      from: resolved.from,
      global: doc.global.pySkills[s.skill] ?? null,
      project: root === undefined ? null : (projectEntry(doc, root, h)?.pySkills[s.skill] ?? null),
    }
  })
  return {
    home: h,
    path: read.path,
    exists: read.exists,
    ...(read.error === undefined ? {} : { fileError: read.error }),
    project: root ?? null,
    projects,
    skills,
    ...(skillsError === undefined ? {} : { skillsError }),
    pySkills: py,
  }
}

function projectEntry(doc: ExposureDocument, root: string, h: string) {
  for (const [k, layer] of Object.entries(doc.projects)) if (expandHome(k, h) === root) return layer
  return undefined
}

const gateways = new WeakMap<Context, OwnerGateway>()

/** 宿主网关加本机所有者身份；每个插件 Context 只建一个身份，宿主缺网关或连接服务时给 undefined。 */
function gatewayOf(ctx: Context): OwnerGateway | undefined {
  const cached = gateways.get(ctx)
  if (cached !== undefined) return cached
  const gateway = ctx.get('typertGateway' as never) as HostGatewayLike | undefined
  const connection = ctx.get('connection' as never) as ConnectionLike | undefined
  if (gateway === undefined || connection === undefined) return undefined
  const owned = ownerGateway(gateway, connection)
  gateways.set(ctx, owned)
  return owned
}

/** 可选项目：侧栏工作区的项目根，加上规则文件里已经写了的项目。 */
async function knownProjects(ctx: Context, doc: ExposureDocument): Promise<Array<{ root: string; title: string; configured: boolean }>> {
  const h = home()
  const out = new Map<string, { root: string; title: string; configured: boolean }>()
  for (const key of Object.keys(doc.projects)) {
    const root = expandHome(key, h)
    out.set(root, { root, title: root.split('/').pop() || root, configured: true })
  }
  const gateway = gatewayOf(ctx)
  if (gateway !== undefined) {
    try {
      const stream = await gateway.stream({ namespace: 'workspace', method: 'follow', args: {} })
      for await (const item of stream) {
        const items = obj(obj(item)['value'])['items']
        if (Array.isArray(items)) {
          for (const w of items) {
            const path = obj(w)['path']
            if (typeof path !== 'string' || path === '') continue
            const root = findProjectRoot(path)
            if (!out.has(root)) out.set(root, { root, title: String(obj(w)['title'] ?? '') || root.split('/').pop() || root, configured: false })
          }
        }
        break
      }
    } catch {
      // 拿不到工作区就只列规则文件里写过的
    }
  }
  return [...out.values()].sort((a, b) => Number(b.configured) - Number(a.configured) || a.title.localeCompare(b.title))
}

export type { SkillLevel, PyLevel }
