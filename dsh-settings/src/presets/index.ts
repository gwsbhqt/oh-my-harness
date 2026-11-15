/**
 * dsh-settings 的模式偏好模块（宿主半）：按工作区选新会话的默认模式。
 *
 * 新建会话统一走会话控制器内部的 `agents.createSession(request)`：网页没指定模式时 request 里
 * 没有 agentPreset，宿主就用全局默认；本模块包住这一个方法，没指定时按 request.cwd 所在项目补上
 * 偏好的模式，指定了（模式按钮上手动选的、「创建你的插件」、恢复空白会话）一律不动。
 * 这是宿主内部方法：DSH 改了它，新会话就都回到全局默认，设置页顶部亮出原因。
 *
 * 端点：`/api/settings.presetsOverview`、`/api/settings.presetsSave`。规则在共用偏好文件
 * `$DSH_HOME/preferences.json` 的 `presetPreferences` 段。
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import { createRouteRegistry } from '../../../tooling/runtime/routes.mjs'
import { ownerGateway, type ConnectionLike, type HostGatewayLike, type OwnerGateway } from '../../../tooling/runtime/gateway.mjs'
import { installMethodPatch } from './patch.ts'
import { expandHome, preferredPreset, setProjects, type PresetDocument } from './rules.ts'
import { DocumentStore, findProjectRoot, home } from './store.ts'
import { route, RouteError, obj } from '../routes.ts'

/** DSH 存全局默认模式的设置命名空间和字段（宿主自己的「Agent 预设」页写的也是这里）。 */
const REGISTRY_NS = 'agent-preset-registry'

interface PresetRow {
  id: string
  name?: string
  description?: string
  broken?: string
}

interface PresetRegistry {
  readonly defaultId: string
  list(): Promise<PresetRow[]>
}

interface CreateRequest {
  cwd?: unknown
  agentPreset?: unknown
  [key: string]: unknown
}

type CreateSession = (request: CreateRequest) => Promise<unknown>

/** 包装装没装上；设置页顶部按它提示。 */
interface HookState {
  ok: boolean
  message?: string
}

function registryOf(ctx: Context): PresetRegistry | undefined {
  const value = ctx.get('agentPresets' as never) as Partial<PresetRegistry> | undefined
  return value !== undefined && typeof value.list === 'function' && typeof value.defaultId === 'string' ? value as PresetRegistry : undefined
}

/**
 * 没指定模式的新会话该用哪个：按 cwd 所在项目查偏好，偏好的模式要在名单里、没坏。
 * 返回 undefined 表示不动 request（交给宿主用全局默认）。
 */
export async function pickPreset(request: CreateRequest, doc: PresetDocument, registry: PresetRegistry | undefined, h: string): Promise<{ preset?: string; skipped?: string }> {
  if (request.agentPreset !== undefined || typeof request.cwd !== 'string' || request.cwd === '' || registry === undefined) return {}
  const root = findProjectRoot(request.cwd)
  const preset = preferredPreset(doc, root, h)
  if (preset === undefined || preset === registry.defaultId) return {}
  const row = (await registry.list()).find((p) => p.id === preset)
  if (row === undefined) return { skipped: `${root} 偏好的模式 ${preset} 不在模式名单里，这次用全局默认` }
  if (row.broken !== undefined) return { skipped: `${root} 偏好的模式 ${preset} 加载失败（${row.broken}），这次用全局默认` }
  return { preset }
}

const registerRoutes = createRouteRegistry()

export function applyPresets(ctx: Context): void {
  const logger = ctx.logger('dsh-settings')
  const store = new DocumentStore()
  const first = store.read()
  if (first.error !== undefined) logger.warn(first.error)
  const hook: HookState = { ok: false, message: '会话控制器还没就绪' }

  ctx.inject(['sessionController'], (scoped: Context) => {
    const controller = scoped.get('sessionController' as never) as { agents?: unknown } | undefined
    const agents = controller?.agents
    const install = typeof agents === 'object' && agents !== null
      ? installMethodPatch<CreateSession>(agents, 'createSession', (original) => async function (this: unknown, request: CreateRequest) {
        let next = request
        try {
          const read = store.read()
          if (read.error === undefined) {
            const picked = await pickPreset(request, read.doc, registryOf(ctx), home())
            if (picked.skipped !== undefined) logger.warn(picked.skipped)
            if (picked.preset !== undefined) next = { ...request, agentPreset: picked.preset }
          }
        } catch (error) {
          // 偏好出任何问题都不能挡住建会话：退回宿主的全局默认
          logger.warn(`读工作区模式偏好失败，这次用全局默认：${error instanceof Error ? error.message : String(error)}`)
        }
        return original.call(this, next)
      })
      : undefined
    if (install === undefined) {
      hook.ok = false
      hook.message = 'DSH 的会话控制器里找不到建会话的方法（sessionController.agents.createSession），工作区偏好不生效，新会话都用全局默认'
      logger.warn(hook.message)
      return
    }
    hook.ok = true
    delete hook.message
    scoped.effect(() => () => {
      install()
      hook.ok = false
      hook.message = '会话控制器已卸载'
    }, 'settings: presets createSession')
  })

  ctx.inject(['connection'], (connectionCtx: Context) => {
    const connection = connectionCtx.get('connection') as { fetch?: { register?: (route: import('../routes.ts').FetchRoute) => () => void } } | undefined
    const register = connection?.fetch?.register
    if (register === undefined) return
    registerRoutes(
      (install, label) => connectionCtx.effect(install, label),
      register,
      () => [
        route('presetsOverview', async () => overview(ctx, store, hook)),
        route('presetsSave', async (payload) => {
          await save(ctx, store, obj(payload), logger)
          return overview(ctx, store, hook)
        }),
      ],
      (r) => `settings: ${r.path} route`,
    )
  })
}

async function save(ctx: Context, store: DocumentStore, payload: Record<string, unknown>, logger: ReturnType<Context['logger']>): Promise<void> {
  const registry = registryOf(ctx)
  if (registry === undefined) throw new RouteError('unavailable', 'DSH 的模式注册表不可用')
  const known = new Set((await registry.list()).map((p) => p.id))
  const changes: Record<string, string | null> = {}
  for (const [root, value] of Object.entries(obj(payload['projects']))) {
    if (value !== null && (typeof value !== 'string' || !known.has(value))) throw new RouteError('unknown-preset', `没有这个模式：${String(value)}`)
    changes[root] = value as string | null
  }
  const wanted = payload['default']
  if (wanted !== undefined && (typeof wanted !== 'string' || !known.has(wanted))) throw new RouteError('unknown-preset', `没有这个模式：${String(wanted)}`)

  if (Object.keys(changes).length > 0) {
    const current = store.read()
    if (current.error !== undefined) throw new RouteError('broken-file', `规则文件写错了，先修好再改：${current.error}`)
    await store.write(setProjects(current.doc, changes, home()))
    logger.info(`工作区模式偏好：${Object.entries(changes).map(([root, preset]) => `${root} → ${preset ?? '跟随默认'}`).join('，')}`)
  }
  if (typeof wanted === 'string' && wanted !== registry.defaultId) {
    const settings = ctx.get('settings' as never) as { update?(ns: string, patch: Record<string, unknown>): Promise<void> } | undefined
    if (typeof settings?.update !== 'function') throw new RouteError('unavailable', 'DSH 的设置服务不可用，全局默认模式没改')
    await settings.update(REGISTRY_NS, { selectedDefault: wanted })
    logger.info(`全局默认模式 → ${wanted}`)
  }
}

/** 设置页一次拿全：规则文件状态、包装状态、模式名单、全局默认和每个工作区的偏好。 */
async function overview(ctx: Context, store: DocumentStore, hook: HookState) {
  const read = store.read()
  const registry = registryOf(ctx)
  const h = home()
  const presets = registry === undefined ? [] : (await registry.list()).map((p) => ({
    id: p.id,
    ...(p.name === undefined ? {} : { name: p.name }),
    ...(p.broken === undefined ? {} : { broken: p.broken }),
  }))
  const projects = (await knownProjects(ctx, read.doc)).map((p) => ({ ...p, preset: preferredPreset(read.doc, p.root, h) ?? null }))
  return {
    path: read.path,
    exists: read.exists,
    ...(read.error === undefined ? {} : { fileError: read.error }),
    hook: { ...hook },
    globalDefault: registry?.defaultId ?? null,
    presets,
    projects,
  }
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
async function knownProjects(ctx: Context, doc: PresetDocument): Promise<Array<{ root: string; title: string; configured: boolean }>> {
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
            const title = String(obj(w)['title'] ?? '') || root.split('/').pop() || root
            const known = out.get(root)
            if (known === undefined) out.set(root, { root, title, configured: false })
            else known.title = title
          }
        }
        break
      }
    } catch {
      // 拿不到工作区就只列规则文件里写过的
    }
  }
  return [...out.values()].sort((a, b) => a.title.localeCompare(b.title))
}
