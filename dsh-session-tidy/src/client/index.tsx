/**
 * dsh-session-tidy 浏览器半：工作区「…」菜单里一项「整理本工作区」。
 *
 * 点一下直接在后台静默执行归档，不弹全屏遮罩/确认框；完成（或失败）后用应用内置的
 * 顶部横幅 Toast（@deepseek-ai/dsh-client-ui-primitives 的 Toast）告知，位置和样式与产品其它提示一致。
 * 判定与归档都在宿主半，这里只负责触发与反馈。归档可撤销，用户可在“存档”里恢复。
 *
 * @module dsh-session-tidy/client
 */
import { useSyncExternalStore } from 'react'
import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'

const ICON_KEY = 'session-tidy.archive'

interface Banner { seq: number; text: string; tone?: 'success'; holdMs?: number }
let banner: Banner | null = null
let bannerSeq = 0
const bannerSubs = new Set<() => void>()
const emitBanner = (): void => { for (const s of bannerSubs) s() }
function showBanner(text: string, tone: 'success' | undefined, holdMs?: number): void {
  bannerSeq += 1
  banner = { seq: bannerSeq, text, ...(tone === undefined ? {} : { tone }), ...(holdMs === undefined ? {} : { holdMs }) }
  emitBanner()
}
function dismissBanner(seq: number): void {
  if (banner?.seq === seq) { banner = null; emitBanner() }
}
function subscribeBanner(listener: () => void): () => void {
  bannerSubs.add(listener)
  return () => { bannerSubs.delete(listener) }
}
function getBanner(): Banner | null { return banner }

/** 常驻挂载点：把当前 banner 渲染成应用内置的顶部 Toast。 */
function BannerHost(): JSX.Element | null {
  const b = useSyncExternalStore(subscribeBanner, getBanner, getBanner)
  if (b === null) return null
  return (
    <Toast
      key={b.seq}
      text={b.text}
      onDone={() => dismissBanner(b.seq)}
      {...(b.tone === undefined ? {} : { tone: b.tone })}
      {...(b.holdMs === undefined ? {} : { holdMs: b.holdMs })}
    />
  )
}

interface TidyItem { sessionId: string; title: string; reason?: string; ageDays?: number }
interface TidyResult {
  ok?: boolean
  value?: { archived?: TidyItem[]; total?: number; workspaceTitle?: string; dryRun?: boolean }
  error?: string
}
interface Target { sessionId?: string; workspaceId?: string }
interface RunOpts { dryRun?: boolean }
type Run = (target: Target, opts?: RunOpts) => Promise<TidyResult>

/** 后台静默执行：不发预览、不弹遮罩，完成/失败各弹一条内置顶部 Toast。 */
function startTidySilent(target: Target, run: Run): void {
  run(target, { dryRun: false }).then((res) => {
    if (res && res.ok === true) {
      const n = res.value?.archived?.length ?? 0
      showBanner(n > 0 ? `已归档 ${n} 个没用会话，可在“存档”里恢复` : '这个工作区没有需要归档的会话', 'success')
    } else {
      showBanner('整理失败：' + (res?.error ?? '未知错误'), undefined, 5000)
    }
  }).catch((error) => showBanner('整理失败：' + String((error as Error)?.message ?? error), undefined, 5000))
}

function ArchiveGlyph(): JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 4.5h11M3.5 4.5v8h9v-8M6 7.2h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export const inject = ['slots', 'connection']

export function apply(ctx: ClientContext): void {
  const slots = ctx.slots as unknown as {
    register: (options: unknown, component: unknown) => () => void
    inject: (name: unknown, factory: () => () => void) => () => void
  }
  const connection = ctx.get('connection') as unknown as {
    rpc: { call: (channel: string, method: string, payload?: unknown) => Promise<unknown> }
  }
  const run: Run = async (target, opts) => {
    const payload: Record<string, unknown> = { dryRun: opts?.dryRun === true }
    if (target.workspaceId !== undefined) payload.workspaceId = target.workspaceId
    if (target.sessionId !== undefined) payload.sessionId = target.sessionId
    const r = await connection.rpc.call('/api', 'session-tidy.tidy', payload)
    return (r ?? {}) as TidyResult
  }

  // 挂一个常驻组件到应用级浮层槽，用来渲染内置 Toast。
  ctx.effect(
    () => slots.inject('shell.overlay' as never, () =>
      slots.register({ name: 'shell.overlay', id: 'session-tidy-toast' } as never, BannerHost as never)),
    'dsh-session-tidy: toast host',
  )

  // 菜单项图标：结构化菜单用 icon.key 引用这里注册的渲染器。
  ctx.effect(
    () => slots.register({ name: 'contextMenu.icon', key: ICON_KEY } as never, ArchiveGlyph as never),
    'dsh-session-tidy: menu icon',
  )

  const contextMenus = ctx.get('contextMenus') as unknown as
    | { register: (c: unknown) => () => void }
    | undefined
  if (contextMenus && typeof contextMenus.register === 'function') {
    ctx.effect(
      () =>
        contextMenus.register({
          id: 'session-tidy.workspace',
          target: 'workspace',
          order: 250,
          resolve: (ws: { workspaceId: string }) => [
            {
              id: 'session-tidy',
              label: '整理本工作区',
              icon: { key: ICON_KEY },
              run: () => { startTidySilent({ workspaceId: ws.workspaceId }, run) },
            },
          ],
        }),
      'dsh-session-tidy: workspace menu item',
    )
  }
}
