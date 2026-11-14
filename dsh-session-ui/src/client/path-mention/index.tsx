/**
 * dsh-path-mention client 半：顶替聊天里「助手回复」的渲染组件，给宿主组件换一个更宽的提及解析器；
 * 再给所有文件提及加上右键菜单和拖拽。
 *
 * 宿主只把「本轮 write/edit 成功写过、或 present 交付过」的路径做成可点的提及。这里在宿主那份之外，
 * 再加上「宿主查过、本机真实存在」的路径：
 *
 * 1. 回复写完（不再流式输出）后，从原文里取出所有像路径的行内代码，发给宿主 `/dsh-path-mention/resolve`。
 * 2. 宿主回来后换一个新的解析器交给宿主组件，宿主组件重新渲染，那些片段就变成可点的提及。
 * 3. 点文件：用宿主自己的 openFile 在侧栏预览；点目录：宿主侧栏开不了工作区外的目录，改在访达打开。
 *
 * 右键和拖拽：提及按钮是宿主画的，插件改不了它的属性，所以在 document 上监听 contextmenu / dragstart。
 * 宿主画两种可点的路径，都要认：
 * - 行内代码提及：`code > button`，原文是按钮文字，按「本回复的提及表」查真实路径（宿主那份没有绝对路径时退回 title）。
 * - Markdown 文件链接 `[名字](路径)`：不在 code 里的 button，按钮文字是链接名字，路径在 title 上。
 *
 * 插槽同一个 key 只渲染优先级数字最小的那条，所以用 priority -10 注册同 key，顶替宿主那条；
 * 渲染时从插槽登记里现找宿主组件和注入，照原样转交，找不到就什么都不画。
 *
 * @module dsh-path-mention/client
 */
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { IconCopyOutlineRegular, IconFolderOpenOutlineRegular, IconRightUpOutlineRegular, Menu, Toast, writeClipboard, type MenuEntry } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
// 以下类型导入会被擦除，只为拿到 Context 的类型扩充。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { inlineCodeTokens, OPEN_PATH, OPEN_WITH_PATH, parsePathToken, RESOLVE_PATH, type Resolved, type ResolveResponse } from '../../shared/path-mention/token.ts'
import { absoluteTarget, composerMention, pickPreferred, lineSuffix, mentionLabel, mentionModelText, pastedPathText, relativePath, type MenuAction, type MentionTarget } from './menu.ts'
import { ASSISTANT_KEY, CHAT_LOCALE, SLOT } from './ids.ts'
import { openableApps } from '../../shared/path-mention/apps.ts'

const SHADOW_PRIORITY = -10
/** 拖拽时放进 dataTransfer 的私有类型，输入框据此认出是提及。 */
const DRAG_TYPE = 'application/x-dsh-path-mention'
/** 本插件画的回复外层标记，右键和拖拽只处理这里面的提及。 */
const ROOT_ATTR = 'data-path-mention-root'

type AnyProps = Record<string, unknown>
type AnyInject = (...args: unknown[]) => Record<string, unknown>

interface Mention {
  open: () => void
  label: string
  title: string
}
interface MentionResolver {
  resolve(value: string): Mention | undefined
}
// 0.2.2-rc.1 起宿主多传第二个参数（给提及挂官方右键菜单用的 getFileTriggerProps），原样转交。
type FileMentions = (owner: unknown, ...rest: unknown[]) => MentionResolver | undefined
type OpenFile = (path: string, options?: { line: number }) => unknown

interface AssistantData {
  status?: string
  blocks?: readonly { kind: string; text?: string }[]
}

/** 每条回复的外层元素 → 它的提及表（按行内代码原文查真实路径）和会话工作区。 */
interface RootInfo {
  lookup: (value: string) => MentionTarget | undefined
  cwd: string | undefined
  sessionId: string | undefined
}
const roots = new WeakMap<Element, RootInfo>()

async function fetchResolved(cwd: string | undefined, tokens: string[], signal?: AbortSignal): Promise<Record<string, Resolved>> {
  const response = await fetch(RESOLVE_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ cwd, tokens }),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) return {}
  const value = (await response.json()) as Partial<ResolveResponse>
  return typeof value.results === 'object' && value.results !== null ? value.results : {}
}

function openOnHost(path: string, action: 'open' | 'reveal'): void {
  void fetch(OPEN_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, action }),
  }).catch(() => undefined)
}

/** 用宿主头栏清单里的某个应用打开；返回宿主有没有接下（没装、不在清单里都算失败）。 */
async function openWithApp(path: string, app: string): Promise<boolean> {
  try {
    const response = await fetch(OPEN_WITH_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, app }),
    })
    return response.ok
  } catch {
    return false
  }
}


/**
 * 打开方式和宿主头栏「打开工作区」那个菜单同一份：宿主那个菜单从 `/open-in-app/apps` 拿本机装了的应用 id
 * （按宿主清单的顺序，访达在最前），图标走 `/open-in-app/icon/<id>`，名字用它的文案（命名空间 `open-in-app`、
 * 键 `app.<id>`）。三样都直接问宿主，所以显示的应用、顺序、图标、名字都和头栏一模一样。
 * 只有「打开」走本插件：宿主那个打开接口只收目录，右键的却常常是文件（见 src/apps.ts）。
 */
const APPS_ROUTE = 'open-in-app/apps'
const ICON_ROUTE = 'open-in-app/icon'
const APP_LOCALE = 'open-in-app'

let installedApps: Promise<string[]> | undefined

/** 本机装了的应用 id，整个页面只问一次（宿主那边也是一次探测、之后不变）。问不到就是空列表，下次右键再试。 */
function loadInstalledApps(): Promise<string[]> {
  installedApps ??= fetch(APPS_ROUTE, { headers: { accept: 'application/json' } })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
      const payload = (await response.json()) as { apps?: unknown }
      return openableApps(payload.apps)
    })
    .catch((error: unknown) => {
      installedApps = undefined
      console.warn('[dsh-path-mention] 拿不到本机应用清单，右键菜单只显示「显示文件位置」：', error)
      return []
    })
  return installedApps
}

/** 最近一次问到的清单：菜单打开时先用它，免得每次都闪一下「正在获取」。 */
let installedSnapshot: string[] | undefined

/**
 * 家目录。和宿主 `@` 引用菜单同一个来源（`remote.$host.home`，连上宿主后才有）；拿不到就是 undefined，
 * 相对路径只按工作区算。
 */
function hostHome(ctx: ClientContext): string | undefined {
  try {
    const home = (ctx.get('remote' as never) as { $host?: { home?: unknown } } | undefined)?.$host?.home
    return typeof home === 'string' && home !== '' ? home : undefined
  } catch {
    return undefined
  }
}

/** 宿主的文案：应用名优先用宿主那份，宿主没加载时退回常见写法。 */
interface LocaleFace {
  translate?(ns: string, key: string, params?: Record<string, unknown>): string
}
const FALLBACK_NAMES: Record<string, string> = {
  finder: '访达', terminal: '终端', cursor: 'Cursor', vscode: 'VS Code', vscodeinsiders: 'VS Code Insiders', windsurf: 'Windsurf',
  zed: 'Zed', sublimetext: 'Sublime Text', xcode: 'Xcode', androidstudio: 'Android Studio', fork: 'Fork', sourcetree: 'Sourcetree',
  github: 'GitHub Desktop', tower: 'Tower', gitkraken: 'GitKraken', smartgit: 'SmartGit', sublimemerge: 'Sublime Merge',
  ghostty: 'Ghostty', warp: 'Warp', iterm: 'iTerm2', kitty: 'kitty',
}
function appLabel(locale: LocaleFace | undefined, id: string): string {
  const key = `app.${id}`
  const translated = locale?.translate?.(APP_LOCALE, key)
  return translated !== undefined && translated !== key ? translated : FALLBACK_NAMES[id] ?? id
}

/** 落在某个可点路径上的事件：按钮、所在回复、当场就能确定的路径，以及还拿不准时交给宿主查的候选。 */
interface MentionHit {
  button: HTMLElement
  info: RootInfo
  target: MentionTarget | undefined
  candidates: string[]
}

/**
 * 认出事件落在哪个可点路径上。只认本插件包着的回复里的按钮；认不出就返回 undefined，系统右键菜单照常出现。
 * Markdown 文件链接的按钮没有公开标记，按结构认：不在 code 里、带 title、第一个子元素是图标、title 像路径。
 */
function mentionAt(target: EventTarget | null): MentionHit | undefined {
  if (!(target instanceof Element)) return undefined
  const button = target.closest('button')
  if (!(button instanceof HTMLElement)) return undefined
  const root = button.closest(`[${ROOT_ATTR}]`)
  const info = root === null ? undefined : roots.get(root)
  if (info === undefined) return undefined
  const title = button.getAttribute('title') ?? undefined
  if (button.parentElement?.tagName === 'CODE') {
    const text = button.textContent ?? ''
    return { button, info, target: withLines(info.lookup(text), text), candidates: [title, text].filter((v): v is string => v !== undefined && v !== '') }
  }
  if (title === undefined || button.closest('pre, [data-code-block-content]') !== null) return undefined
  if (!(button.firstElementChild instanceof SVGElement) || parsePathToken(title) === undefined) return undefined
  const guess = absoluteTarget(title, info.cwd)
  return { button, info, target: guess, candidates: guess === undefined ? [title] : [guess.path] }
}

/** 把原文里的行号（`index.tsx:24-27`）挂到真实路径上；目录和没有行号的原样返回。 */
function withLines(target: MentionTarget | undefined, text: string): MentionTarget | undefined {
  if (target === undefined || target.kind !== 'file') return target
  const token = parsePathToken(text)
  if (token?.line === undefined) return target
  return { ...target, line: token.line, ...(token.endLine === undefined ? {} : { endLine: token.endLine }) }
}

/** 拿准真实路径和类型：表里有就用，没有（或只是按地址猜的）就让宿主后台确认一次；查不到时用猜的。 */
async function targetOf(hit: MentionHit): Promise<MentionTarget | undefined> {
  const known = hit.button.parentElement?.tagName === 'CODE' ? hit.target : undefined
  if (known !== undefined) return known
  if (hit.candidates.length === 0) return hit.target
  const results = await fetchResolved(hit.info.cwd, hit.candidates).catch(() => ({} as Record<string, Resolved>))
  for (const candidate of hit.candidates) {
    const r = results[candidate]
    if (r !== undefined) return r
  }
  return hit.target
}

/** 宿主那个菜单里的应用图标：有图就用图，没有或加载失败退回箭头图标，和宿主一样。 */
function AppIcon({ source }: { source: string | null }): JSX.Element {
  const [failed, setFailed] = useState(false)
  return source === null || failed
    ? <IconRightUpOutlineRegular size={14} />
    : <img src={source} width={14} height={14} alt="" draggable={false} style={{ display: 'block', borderRadius: 3 }} onError={() => setFailed(true)} />
}

/** 上次在本菜单里用过的应用，存在浏览器本地；头栏「打开工作区」记住的那个存在它自己的键里，只读不写。 */
const LAST_USED_KEY = 'dsh-path-mention.last-app'
const HEADER_CHOICE_KEY = 'dsh.open-in-app.choice'

function readStored(key: string): string | undefined {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return undefined
    const value: unknown = JSON.parse(raw)
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

function rememberLastUsed(id: string): void {
  try {
    localStorage.setItem(LAST_USED_KEY, JSON.stringify(id))
  } catch {
    // 存不下就下次照默认规则选，不影响打开。
  }
}

/**
 * 菜单内容：最上面单独一项「用 Zed 打开」这种默认打开方式（经常用，所以放第一个），然后是两种复制，
 * 再是其余打开方式（顺序和头栏一样，不重复默认那个）；文件的「显示文件位置」放在 footer。
 * 应用清单还没问到时显示一行灰的「正在获取打开方式」。
 */
export function menuItems(target: MentionTarget, cwd: string | undefined, apps: readonly string[] | undefined, label: (id: string) => string, home?: string): MenuEntry[] {
  const relative = relativePath(target.path, cwd, home)
  const copies: MenuEntry[] = [
    { id: 'copy-relative', label: '复制相对路径', icon: <IconCopyOutlineRegular size={14} />, disabled: relative === target.path },
    { id: 'copy-absolute', label: '复制绝对路径', icon: <IconCopyOutlineRegular size={14} /> },
  ]
  if (apps === undefined) return [...copies, { type: 'separator', id: 'sep-open' }, { id: 'apps-loading', label: '正在获取打开方式', disabled: true }]
  const preferred = pickPreferred(apps, readStored(LAST_USED_KEY), readStored(HEADER_CHOICE_KEY), target.kind)
  // 文件用访达打开就是「显示文件位置」，和 footer 那项重复，所以文件不列访达。
  const rest = apps.filter((id) => id !== preferred && !(id === 'finder' && target.kind === 'file'))
  const items: MenuEntry[] = []
  if (preferred !== undefined) items.push({ id: `app:${preferred}`, icon: <AppIcon source={`${ICON_ROUTE}/${preferred}`} />, label: `用 ${label(preferred)} 打开` }, { type: 'separator', id: 'sep-preferred' })
  items.push(...copies)
  if (rest.length > 0) items.push({ type: 'separator', id: 'sep-open' })
  for (const id of rest) items.push({ id: `app:${id}`, icon: <AppIcon source={`${ICON_ROUTE}/${id}`} />, label: label(id) })
  return items
}

/** 和宿主那个菜单一样：文件的「显示文件位置」固定在最底下。 */
export function menuFooter(target: MentionTarget): MenuEntry[] {
  return target.kind === 'file' ? [{ id: 'reveal', icon: <IconFolderOpenOutlineRegular size={14} />, label: '显示文件位置' }] : []
}

interface MenuState {
  target: MentionTarget
  cwd: string | undefined
  /** 右键的位置：菜单从这里弹出，不跟着按钮挪。 */
  x: number
  y: number
  label: (id: string) => string
  /** 家目录：不在工作区里的路径按 `~/…` 写相对路径。 */
  home: string | undefined
}

/**
 * 右键菜单：页面里只有一个，挂在 body 下的固定层里。
 *
 * 不抖的三个要点（2026-10-08 用户反馈「右键时整个对话左右抖一下」）：
 * - 不自动聚焦第一项：聚焦会让浏览器把焦点元素滚进可见区，带着对话区一起动。
 * - 按右键的坐标定位（宿主菜单的 anchorPoint），不按按钮的矩形，菜单不会贴着按钮来回挪。
 *   DSH 0.2.2-rc.2 起宿主菜单只认 anchorPoint，不传就贴着挂载层（窗口左上角）弹出。
 * - 挂载层设成 position:fixed、宽高为 0，不占任何版面。
 */
function ContextMenu({ state, onClose }: { state: MenuState | undefined; onClose: () => void }): JSX.Element | null {
  const [apps, setApps] = useState<string[] | undefined>(installedSnapshot)
  const [failure, setFailure] = useState<{ seq: number; text: string } | undefined>(undefined)
  const open = state !== undefined
  useEffect(() => {
    if (!open) return undefined
    let alive = true
    void loadInstalledApps().then((list) => {
      installedSnapshot = list
      if (alive) setApps(list)
    })
    return () => { alive = false }
  }, [open])

  const toast = failure === undefined ? null : <Toast key={failure.seq} text={failure.text} onDone={() => setFailure(undefined)} />
  if (state === undefined) return toast
  const { target, cwd } = state
  const fail = (text: string) => setFailure((prev) => ({ seq: (prev?.seq ?? 0) + 1, text }))
  const run = (ok: Promise<boolean>, failText: string) => {
    void ok.then((done) => { if (!done) fail(failText) })
  }
  return (
    <>
      <Menu
        open
        portal
        dense
        anchor={<span />}
        items={menuItems(target, cwd, apps, state.label, state.home)}
        footer={menuFooter(target)}
        contextual
        anchorPoint={{ x: state.x, y: state.y }}
        onSelect={(id) => {
          onClose()
          const action = id as MenuAction
          if (action === 'copy-relative') void writeClipboard(relativePath(target.path, cwd, state.home))
          else if (action === 'copy-absolute') void writeClipboard(target.path)
          else if (id === 'reveal') openOnHost(target.path, 'reveal')
          else if (id.startsWith('app:')) {
            rememberLastUsed(id.slice(4))
            run(openWithApp(target.path, id.slice(4)), '打开失败，请重试')
          }
        }}
        onClose={onClose}
      />
      {toast}
    </>
  )
}

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  const ours = new Set<unknown>()

  const hostEntry = (): StoredEntry | undefined =>
    ctx.slots.entries(SLOT as never).find((entry) => entry.options.key === ASSISTANT_KEY && !ours.has(entry.component))

  const delegateInject: AnyInject = (...args) => {
    const hostInject = hostEntry()?.inject as AnyInject | undefined
    return hostInject === undefined ? {} : hostInject(...args)
  }

  function AssistantWithPathMentions(props: AnyProps): JSX.Element | null {
    const node = props.node as { data?: AssistantData } | undefined
    const data = node?.data
    const settled = data !== undefined && data.status !== 'running'
    const cwd = typeof props.cwd === 'string' ? props.cwd : undefined
    const text = useMemo(() => (data?.blocks ?? []).filter((b) => b.kind === 'text').map((b) => b.text ?? '').join('\n\n'), [data?.blocks])
    const tokens = useMemo(() => (settled ? inlineCodeTokens(text) : []), [settled, text])
    const tokenKey = tokens.join('\u0000')
    const [resolved, setResolved] = useState<Record<string, Resolved>>({})
    const rootRef = useRef<HTMLDivElement>(null)

    useEffect(() => {
      if (tokens.length === 0) return undefined
      const controller = new AbortController()
      fetchResolved(cwd, tokens, controller.signal)
        .then((results) => {
          if (!controller.signal.aborted) setResolved(results)
        })
        .catch(() => undefined)
      return () => controller.abort()
      // tokens 由 tokenKey 代表；数组每次是新对象，不能直接放进依赖。
    }, [cwd, tokenKey])

    const hostFileMentions = props.fileMentions as FileMentions | undefined
    const openFile = props.openFile as OpenFile | undefined
    // 宿主那份解析器按 owner 生成；右键时要用它查 title，这里记下最近一次生成的。
    const hostResolverRef = useRef<MentionResolver | undefined>(undefined)
    const fileMentions = useMemo<FileMentions | undefined>(() => {
      const ourResolve = (value: string): Mention | undefined => {
        const hit = resolved[value]
        if (hit === undefined) return undefined
        const line = parsePathToken(value)?.line
        return {
          open: () => {
            if (hit.kind === 'directory') openOnHost(hit.path, 'open')
            else void openFile?.(hit.path, line === undefined ? undefined : { line })
          },
          label: hit.path,
          title: hit.path,
        }
      }
      return (owner, ...rest) => {
        const host = hostFileMentions?.(owner, ...rest)
        hostResolverRef.current = host
        return { resolve: (value) => host?.resolve(value) ?? ourResolve(value) }
      }
    }, [hostFileMentions, openFile, resolved])

    useEffect(() => {
      const el = rootRef.current
      if (el === null) return
      roots.set(el, {
        cwd,
        sessionId: el.closest('[data-conversation-session]')?.getAttribute('data-conversation-session') ?? undefined,
        lookup: (value) => {
          const hit = resolved[value]
          if (hit !== undefined) return hit
          const title = hostResolverRef.current?.resolve(value)?.title
          if (title === undefined) return undefined
          const absolute = title.startsWith('/') ? title : cwd === undefined ? undefined : `${cwd.replace(/\/+$/u, '')}/${title}`
          return absolute === undefined ? undefined : { path: absolute, kind: 'file' }
        },
      })
    })

    const Host = hostEntry()?.component as ComponentType<AnyProps> | undefined
    if (Host === undefined) return null
    return (
      <div ref={rootRef} {...{ [ROOT_ATTR]: '' }} style={{ display: 'contents' }}>
        <Host {...props} fileMentions={fileMentions} />
      </div>
    )
  }

  ours.add(AssistantWithPathMentions)
  ctx.slots.inject(SLOT as never, () => ctx.slots.register({
    name: SLOT,
    key: ASSISTANT_KEY,
    priority: SHADOW_PRIORITY,
    locale: CHAT_LOCALE,
    inject: delegateInject,
  } as never, AssistantWithPathMentions as never))

  installDocumentHandlers(ctx)
  // 页面一加载就问一次本机装了哪些应用，第一次右键时菜单就已经带着它们。
  void loadInstalledApps().then((apps) => { installedSnapshot = apps })
}

/** 右键菜单、拖拽起点、输入框落点：都挂在 document 上，插件卸载时一起撤掉。 */
function installDocumentHandlers(ctx: ClientContext): void {
  let menuRoot: Root | undefined
  let host: HTMLDivElement | undefined
  const renderMenu = (state: MenuState | undefined) => {
    if (host === undefined) {
      host = document.createElement('div')
      host.setAttribute('data-path-mention-menu', '')
      // 固定层、不占版面：菜单测量和弹出都不会推动页面。
      host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;overflow:visible;z-index:1100'
      document.body.appendChild(host)
      menuRoot = createRoot(host)
    }
    menuRoot?.render(<ContextMenu state={state} onClose={() => renderMenu(undefined)} />)
  }

  const onContextMenu = (event: MouseEvent) => {
    const at = mentionAt(event.target)
    if (at === undefined) return
    event.preventDefault()
    event.stopPropagation()
    const { clientX: x, clientY: y } = event
    // 这里吞掉的错误会让菜单悄悄不出现，所以出错一律留一行日志。
    targetOf(at)
      .then((target) => {
        if (target !== undefined) renderMenu({ target, cwd: at.info.cwd, x, y, home: hostHome(ctx), label: (id) => appLabel(ctx.get('locale' as never) as LocaleFace | undefined, id) })
      })
      .catch((error: unknown) => console.error('[dsh-path-mention] 右键菜单打开失败：', error))
  }

  // 宿主画的提及是 <button>，本身不可拖。按下时把它设成可拖，拖拽开始时把真实路径放进 dataTransfer。
  const onPointerDown = (event: PointerEvent) => {
    const at = mentionAt(event.target)
    if (at !== undefined && !at.button.draggable) at.button.draggable = true
  }

  const onDragStart = (event: DragEvent) => {
    const at = mentionAt(event.target)
    if (at === undefined || event.dataTransfer === null) return
    const { target, button } = at
    if (target === undefined) {
      // 表里没有（还没查完）：不让拖出去一段光秃秃的文字，免得落进输入框成了普通文本。
      event.preventDefault()
      return
    }
    event.dataTransfer.effectAllowed = 'copy'
    event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(target))
    event.dataTransfer.setData('text/plain', target.path)
    event.dataTransfer.setDragImage(button, 8, 8)
  }

  const composerSession = (target: EventTarget | null): string | undefined => {
    if (!(target instanceof Element)) return undefined
    const seat = target.closest('[data-composer-card], [data-composer-input]')
    if (seat === null) return undefined
    return seat.closest('[data-conversation-session]')?.getAttribute('data-conversation-session') ?? undefined
  }

  const onDragOver = (event: DragEvent) => {
    if (event.dataTransfer?.types.includes(DRAG_TYPE) !== true) return
    if (composerSession(event.target) === undefined) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  /**
   * 粘贴一个路径（可以带 `:24-27` 这类行号）进输入框：本机真的存在就换成提及块，否则照常当文字粘贴。
   * 要不要接管得在粘贴那一刻同步决定，所以先拦下，再问宿主；查不到或超过 PASTE_WAIT_MS 就把原文照常插回去。
   */
  const onPaste = (event: ClipboardEvent) => {
    const data = event.clipboardData
    if (data === null || Array.from(data.items).some((item) => item.kind === 'file')) return
    if (!(event.target instanceof Element) || event.target.closest('[data-composer-input]') === null) return
    const sessionId = composerSession(event.target)
    const raw = data.getData('text/plain')
    const candidate = pastedPathText(raw)
    if (sessionId === undefined || candidate === undefined || parsePathToken(candidate) === undefined) return
    // 文档捕获阶段比编辑器自己的粘贴处理先到：在这里停住，编辑器就不会再插一遍。
    event.preventDefault()
    event.stopPropagation()
    const editor = event.target.closest('[data-composer-input]')
    const cwd = (ctx.get('sessions' as never) as SessionsFace | undefined)?.list.getSnapshot().byId[sessionId]?.cwd
    const timeout = new Promise<Record<string, Resolved>>((done) => setTimeout(() => done({}), PASTE_WAIT_MS))
    void Promise.race([fetchResolved(cwd, [candidate]).catch(() => ({} as Record<string, Resolved>)), timeout]).then((results) => {
      const target = withLines(results[candidate], candidate)
      if (target !== undefined && insertMention(ctx, sessionId, target)) return
      if (editor instanceof HTMLElement) editor.focus()
      // 编辑器把 insertText 当成普通输入处理，效果和原本的粘贴一样。
      document.execCommand('insertText', false, raw)
    })
  }

  const onDrop = (event: DragEvent) => {
    const raw = event.dataTransfer?.getData(DRAG_TYPE)
    if (raw === undefined || raw === '') return
    const sessionId = composerSession(event.target)
    if (sessionId === undefined) return
    // 抢在编辑器自己的拖放处理前面：否则它会把 text/plain 当普通文字再插一遍。
    event.preventDefault()
    event.stopPropagation()
    let target: MentionTarget
    try {
      target = JSON.parse(raw) as MentionTarget
    } catch {
      return
    }
    insertMention(ctx, sessionId, target)
  }

  document.addEventListener('contextmenu', onContextMenu, true)
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('dragstart', onDragStart, true)
  document.addEventListener('dragover', onDragOver, true)
  document.addEventListener('drop', onDrop, true)
  document.addEventListener('paste', onPaste, true)
  const disposeSource = registerLineSource(ctx)
  ctx.effect(() => () => {
    disposeSource()
    document.removeEventListener('paste', onPaste, true)
    document.removeEventListener('contextmenu', onContextMenu, true)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('dragstart', onDragStart, true)
    document.removeEventListener('dragover', onDragOver, true)
    document.removeEventListener('drop', onDrop, true)
    const root = menuRoot
    const el = host
    menuRoot = undefined
    host = undefined
    queueMicrotask(() => {
      root?.unmount()
      el?.remove()
    })
  }, 'path-mention: document handlers')
}

/** 粘贴路径时最多等宿主多久；超时就照常当文字粘贴，免得输入框半天没反应。 */
const PASTE_WAIT_MS = 1200

/** 带行号的提及块归本插件的引用来源管：发给模型时写清行号，点开时跳到那一行。 */
const LINE_SOURCE = 'path-mention'

/** 提及块里存的数据：路径按宿主写法（相对工作区或绝对），加起止行。 */
interface LineRef {
  path: string
  line: number
  endLine?: number
}

function parseLineRef(ref: string): LineRef | undefined {
  try {
    const value = JSON.parse(ref) as Partial<LineRef>
    return typeof value.path === 'string' && typeof value.line === 'number' ? (value as LineRef) : undefined
  } catch {
    return undefined
  }
}

/** 和宿主 `fileAddressFor` 一样的文件地址：工作区内写相对路径，工作区外原样写绝对路径。 */
function fileAddress(sessionId: string, cwd: string | undefined, path: string): string {
  const encode = (segment: string) => encodeURIComponent(segment).replace(/%3A/giu, ':')
  let normalized = path.replace(/\\/gu, '/')
  const root = cwd === undefined ? '' : cwd.replace(/\\/gu, '/').replace(/\/+$/u, '')
  if (root !== '' && normalized === root) normalized = ''
  else if (root !== '' && normalized.startsWith(`${root}/`)) normalized = normalized.slice(root.length + 1)
  normalized = normalized.replace(/^(?:\.\/)+/u, '')
  return `dsh-resource://file/session/${encode(sessionId)}/${normalized.split('/').map(encode).join('/')}`
}

interface InputTriggersFace {
  registerSource(source: unknown): () => void
}
interface SidebarRightFace {
  openResource(address: string, options?: { params: { line: number } }): void
}

let lineSourceRegistered = false

/**
 * 在输入框的 `@` 引用里登记一个只管「带行号文件」的来源。它不出现在 `@` 补全菜单里（候选永远为空），
 * 只负责两件事：发送时把提及块写成「@路径 第 24–27 行」，点提及块时在侧栏打开并跳到起始行。
 * 不带行号的提及块仍归宿主自己的来源，和从访达拖文件进来的完全一样。
 */
function registerLineSource(ctx: ClientContext): () => void {
  const triggers = ctx.get('inputTriggers' as never) as InputTriggersFace | undefined
  if (typeof triggers?.registerSource !== 'function') return () => {}
  const source = {
    trigger: '@',
    name: LINE_SOURCE,
    order: 1000,
    showGroupTitle: false,
    candidates: () => Promise.resolve([]),
    onPick: () => undefined,
    openReference(session: { sessionId: string }, reference: { ref: string }) {
      const value = parseLineRef(reference.ref)
      const sidebar = ctx.get('sidebarRight' as never) as SidebarRightFace | undefined
      if (value === undefined || sidebar === undefined) return false
      const cwd = (ctx.get('sessions' as never) as SessionsFace | undefined)?.list.getSnapshot().byId[session.sessionId]?.cwd
      sidebar.openResource(fileAddress(session.sessionId, cwd, value.path), { params: { line: value.line } })
      return true
    },
    codec: {
      clipboardText: (ref: string) => {
        const value = parseLineRef(ref)
        return value === undefined ? ref : `@${value.path}${lineSuffix({ path: value.path, kind: 'file', line: value.line, ...(value.endLine === undefined ? {} : { endLine: value.endLine }) })}`
      },
      serialize: (ref: string) => {
        const value = parseLineRef(ref)
        if (value === undefined) return Promise.reject(new Error(`path-mention: 无法识别的提及 ${ref}`))
        const text = mentionModelText({ path: value.path, kind: 'file', line: value.line, ...(value.endLine === undefined ? {} : { endLine: value.endLine }) }, undefined)
        return text === undefined ? Promise.reject(new Error(`path-mention: 路径写不进提及 ${value.path}`)) : Promise.resolve(text)
      },
    },
  }
  let dispose: () => void
  try {
    dispose = triggers.registerSource(source)
  } catch (error) {
    console.warn('[dsh-path-mention] 登记带行号的提及来源失败，带行号的路径会退回普通提及：', error)
    return () => {}
  }
  lineSourceRegistered = true
  return () => {
    lineSourceRegistered = false
    dispose()
  }
}

interface SessionsFace {
  scope(id: string): ClientContext | undefined
  list: { getSnapshot(): { byId: Record<string, { cwd?: string } | undefined> } }
}
interface InputFace {
  addFiles(references: readonly { source: string; ref: string; label: string; appearance?: 'file' | 'folder'; clipboardText: string }[], ids: readonly never[]): boolean
  focus(): void
}

/**
 * 往某个会话的输入框光标处插入一个文件提及块，和宿主从访达拖文件进来走同一个接口（addFiles）。
 * 不带行号时生成的提及块和宿主的一模一样，发出去也是同样的 `@路径`；带行号时归本插件的来源管
 * （显示 `index.tsx:24-27`，发出去是「@路径 第 24–27 行」）。
 * @returns 插进去了没有。
 */
function insertMention(ctx: ClientContext, sessionId: string, target: MentionTarget): boolean {
  const sessions = ctx.get('sessions' as never) as SessionsFace | undefined
  const scope = sessions?.scope(sessionId)
  const conversation = scope?.get('conversation' as never) as { input?: { for(actx: ClientContext): InputFace } } | undefined
  if (scope === undefined || conversation?.input === undefined) return false
  const cwd = sessions?.list.getSnapshot().byId[sessionId]?.cwd
  const ref = composerMention(target, cwd)
  if (ref === undefined) return false
  const withLine = target.kind === 'file' && target.line !== undefined && lineSourceRegistered
  const plain: MentionTarget = { path: target.path, kind: target.kind }
  const reference = withLine
    ? {
        source: LINE_SOURCE,
        ref: JSON.stringify({ path: ref.replace(/^@"?|"$/gu, ''), line: target.line, ...(target.endLine === undefined ? {} : { endLine: target.endLine }) }),
        label: mentionLabel(target),
        appearance: 'file' as const,
        clipboardText: `${ref}${lineSuffix(target)}`,
      }
    : { source: 'reference', ref, label: mentionLabel(plain), appearance: target.kind === 'directory' ? ('folder' as const) : ('file' as const), clipboardText: ref }
  const input = conversation.input.for(scope)
  if (!input.addFiles([reference], [])) return false
  input.focus()
  return true
}