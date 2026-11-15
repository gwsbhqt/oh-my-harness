/**
 * dsh-settings 的快捷回复模块（宿主半）：预设和点击动作的读写接口。
 *
 * 预设和动作在 `$DSH_HOME/preferences.json` 的 `quickReplies` 段（dotfiles 跟踪，换机跟着走），
 * 不写进 profile 补丁——主配置里只剩 `quickReply` 这个开关（在根 `Config`）。浏览器半经共享 `/api` 通道的
 * `/api/settings.quickRepliesOverview`、`/api/settings.quickRepliesSave` 读写这份文件。
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import { createRouteRegistry } from '../../../tooling/runtime/routes.mjs'
import {
  QuickRepliesStore,
  validateQuickReplies,
  type QuickRepliesDocument,
} from './quick-replies-file.ts'
import { route, RouteError, obj } from '../routes.ts'

/** 页面要的全部内容：预设、动作，以及文件在哪、在不在、有没有写错。 */
export function overview(store: QuickRepliesStore): Record<string, unknown> {
  const read = store.read()
  return {
    presets: read.doc.presets,
    action: read.doc.action,
    path: read.path,
    exists: read.exists,
    ...(read.error === undefined ? {} : { error: read.error }),
  }
}

/** 整份写回：页面每次改完都送完整列表，宿主只认这一份。 */
export async function save(store: QuickRepliesStore, payload: Record<string, unknown>): Promise<unknown> {
  const current = store.read()
  if (current.error !== undefined) throw new RouteError('broken-file', `快捷回复文件写错了，先修好再改：${current.error}`)
  const wanted: QuickRepliesDocument = {
    presets: (payload['presets'] ?? current.doc.presets) as string[],
    action: (payload['action'] ?? current.doc.action) as QuickRepliesDocument['action'],
  }
  const doc = validateQuickReplies(wanted)
  await store.write(doc)
  return overview(store)
}

const registerRoutes = createRouteRegistry()

export function applyQuickReply(ctx: Context): void {
  const store = new QuickRepliesStore()
  const logger = ctx.logger('dsh-settings')
  const first = store.read()
  if (first.error !== undefined) logger.warn(first.error)

  ctx.inject(['connection'], (connectionCtx: Context) => {
    const connection = connectionCtx.get('connection') as { fetch?: { register?: (route: import('../routes.ts').FetchRoute) => () => void } } | undefined
    const register = connection?.fetch?.register
    if (register === undefined) return
    registerRoutes(
      (install, label) => connectionCtx.effect(install, label),
      register,
      () => [
        route('quickRepliesOverview', async () => overview(store)),
        route('quickRepliesSave', async (payload) => {
          const value = await save(store, obj(payload))
          const doc = store.read().doc
          logger.info(`快捷回复：${doc.presets.length} 条预设，点一条${doc.action === 'send' ? '直接发出' : '填进输入框'}`)
          return value
        }),
      ],
      (r) => `settings: ${r.path} route`,
    )
  })
}
