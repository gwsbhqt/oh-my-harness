/**
 * dsh-run-status 网页半，两处：
 *
 * 1. 宿主「深度求索中，用时 N」那一行后面接一小段，说清这会儿在干嘛、这一段多久。只有一行，不再展开详情。
 *    那一行不是插槽：本插件在输入框上方的 `conversation.input.dock` 放一个不可见的锚点，找到同一个会话里的
 *    `[data-chat-running]`，用 React portal 挂进它的内容区（`:scope > span:last-of-type`）。
 * 2. 输入框下方的统计卡：用宿主自带「会话统计」卡的 id（`activity`）和 order 注册，按宿主约定顶替它。
 *    点开看整段会话的时间去向、分模型的速度；会话在跑时还有本轮时间花在哪、最近几次请求的分段用时。
 *    整段数字来自宿主半登记的会话投影 `runStatusTotals`，本轮数字来自宿主半的只读路由。
 *
 * `test/host-shape.test.ts` 对着宿主核对这两处依赖的结构，宿主一改就在那里失败。
 *
 * @module dsh-run-status/client
 */
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { IconGaugeOutlineRegular, useDismissOnOutsidePointer } from '@deepseek-ai/dsh-client-ui-primitives'
import { breakdown, formatDuration, formatSpeed, formatStatDuration } from '../../shared/run-status/format.ts'
import { STATE_PATH, type BlockerKind, type RunSnapshot } from '../../shared/run-status/types.ts'
import type { TotalsView } from '../../host/run-status/totals.ts'
import { DOCK_SLOT, RUNNING_CONTENT, RUNNING_ROW, SESSION_ROOT, STATS_ENTRY_ID, STATS_ENTRY_ORDER, STATS_ENTRY_PRIORITY, STATS_SLOT, TOTALS_KEY } from './ids.ts'

export const name = 'dsh-run-status/client'
export const inject = ['slots']

const ENTRY_ID = 'run-status'
const POLL_MS = 1000

type SessionStatusMap = ReadonlyMap<string, { readonly running?: boolean } | undefined>
type UseSessionStatus = <R>(selector: (value: SessionStatusMap) => R) => R
type UseProjection = (key: string) => unknown

const TAG_COLOR: Record<BlockerKind, string> = {
  hook: '#f59e0b',
  'wait-user': '#ef4444',
  compaction: '#a78bfa',
  retry: '#ef4444',
  tool: '#60a5fa',
  'model-wait': '#22d3ee',
  'model-thinking': '#a78bfa',
  'model-output': '#34d399',
  prepare: '#94a3b8',
  between: '#94a3b8',
}

const WALL_COLOR = { run: '#34d399', notice: '#60a5fa', user: '#f59e0b', idle: '#94a3b8' } as const

const STYLE = `
.dsh-rs-inline{display:inline-flex;align-items:center;gap:6px;min-width:0;max-width:min(520px,55vw);
  color:var(--dsw-alias-label-tertiary,inherit);font-variant-numeric:tabular-nums;white-space:nowrap}
.dsh-rs-dot{flex:none;width:6px;height:6px;border-radius:50%}
.dsh-rs-tag{flex:none}
.dsh-rs-title{min-width:0;overflow:hidden;text-overflow:ellipsis}
.dsh-rs-time{flex:none}
.dsh-rs-muted{color:var(--dsw-alias-label-tertiary,inherit)}
.dsh-rs-anchor{min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}
.dsh-rs-pill{box-sizing:border-box;border-radius:var(--dsw-radius-sm);max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}
.dsh-rs-pill svg{flex:none;width:14px;height:14px}
.dsh-rs-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
@media (hover:hover){.dsh-rs-pill:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}}
.dsh-rs-pill-label{text-overflow:ellipsis;min-width:0;overflow:hidden}
.dsh-rs-sep{color:var(--dsw-alias-separator-primary);margin:0 6px}
.dsh-rs-panel{z-index:1100;box-sizing:border-box;width:max-content;min-width:min(300px, calc(100vw - 24px));max-width:min(440px, calc(100vw - 24px));border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;max-height:calc(100dvh - 24px);border:0;padding:16px;font-size:12px;line-height:18px;position:fixed;position-area:none;margin:0;top:auto;bottom:max(12px, calc(anchor(top) + 8px));left:max(12px, anchor(left));overflow:hidden auto}
.dsh-rs-panel .dsh-rs-title{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;font-weight:500;display:flex;overflow:visible}
.dsh-rs-title-label{align-items:center;gap:6px;min-width:0;display:inline-flex}
.dsh-rs-title-label svg{flex:none;width:14px;height:14px}
.dsh-rs-num{font-variant-numeric:tabular-nums}
.dsh-rs-rule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}
.dsh-rs-gap-rule{margin-top:10px}
.dsh-rs-details{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);gap:6px 16px;margin:0;display:grid}
.dsh-rs-pair{display:contents}
.dsh-rs-details dt,.dsh-rs-details dd{min-width:0;margin:0}
.dsh-rs-details dt{display:flex;align-items:center;gap:6px}
.dsh-rs-dt-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-rs-details dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
`

/** 样式标签按插件名找；插件热更新后页面里还留着旧版的标签，内容不同就换成这一版。 */
function ensureStyle(): void {
  if (typeof document === 'undefined') return
  let tag = document.querySelector<HTMLStyleElement>('style[data-plugin="dsh-run-status"]')
  if (tag === null) {
    tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-run-status'
    document.head.appendChild(tag)
  }
  if (tag.textContent !== STYLE) tag.textContent = STYLE
}

interface PollState { snap: RunSnapshot | null; skew: number }
interface Poller { state: PollState; listeners: Set<(s: PollState) => void>; timer?: ReturnType<typeof setTimeout>; alive: boolean }
// 同一个会话的上下两处共用一个轮询，不各问各的
const pollers = new Map<string, Poller>()

function startPoller(sessionId: string): Poller {
  const existing = pollers.get(sessionId)
  if (existing !== undefined) return existing
  const poller: Poller = { state: { snap: null, skew: 0 }, listeners: new Set(), alive: true }
  pollers.set(sessionId, poller)
  const tick = async () => {
    try {
      const res = await fetch(`${STATE_PATH}?session=${encodeURIComponent(sessionId)}`, { cache: 'no-store', headers: { accept: 'application/json' } })
      if (res.ok) {
        const snap = await res.json() as RunSnapshot
        poller.state = { snap, skew: Date.now() - snap.now }
        for (const fn of poller.listeners) fn(poller.state)
      }
    } catch {
      // 宿主半不在或网络抖动：这一秒不更新，下一秒再问。
    }
    if (poller.alive) poller.timer = setTimeout(tick, POLL_MS)
  }
  void tick()
  return poller
}

/** 只在会话在跑时轮询；返回最近一次快照和宿主与本机的时钟差。 */
function useSnapshot(sessionId: string | undefined, running: boolean): PollState {
  const [state, setState] = useState<PollState>({ snap: null, skew: 0 })
  useEffect(() => {
    if (sessionId === undefined || !running) {
      setState({ snap: null, skew: 0 })
      return
    }
    const poller = startPoller(sessionId)
    poller.listeners.add(setState)
    setState(poller.state)
    return () => {
      poller.listeners.delete(setState)
      if (poller.listeners.size > 0) return
      poller.alive = false
      if (poller.timer !== undefined) clearTimeout(poller.timer)
      pollers.delete(sessionId)
    }
  }, [sessionId, running])
  return state
}

/** 每半秒重画一次：让秒数自己走，也顺便重新找宿主那一行（它随会话起停挂载、卸载）。 */
function useTick(active: boolean): number {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 500)
    return () => clearInterval(timer)
  }, [active])
  return active ? Date.now() : now
}

/** 从锚点出发，找同一个会话里宿主「深度求索中」那一行的内容区。 */
function findRunningContent(anchor: HTMLElement | null): HTMLElement | null {
  const root = anchor?.closest(SESSION_ROOT)
  const row = root?.querySelector<HTMLElement>(RUNNING_ROW)
  return row?.querySelector<HTMLElement>(RUNNING_CONTENT) ?? null
}

interface Props {
  readonly sessionId?: string
  readonly useSessionStatus?: UseSessionStatus
  readonly useProjection?: UseProjection
}

function useRunning(props: Props): boolean {
  return props.useSessionStatus?.((map) => map.get(props.sessionId ?? '')?.running === true) ?? false
}

function RunStatusAnchor(props: Props): JSX.Element {
  const running = useRunning(props)
  const { snap, skew } = useSnapshot(props.sessionId, running)
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null)
  const now = useTick(running)
  useEffect(ensureStyle, [])

  const target = running ? findRunningContent(anchor) : null
  const b = snap?.running === true ? snap.blocker : null
  const hidden = <span ref={setAnchor} hidden data-run-status-anchor="" />
  if (target === null || snap === null || b === null) return hidden

  const tip = [b.title, b.detail, b.plugin === undefined ? undefined : `来自插件：${b.plugin}`, '本轮详情在输入框下方的统计卡里'].filter(Boolean).join('\n')
  const inline = (
    <span className="dsh-rs-inline" data-run-status={b.kind} title={tip}>
      <span className="dsh-rs-muted">·</span>
      <span className="dsh-rs-dot" style={{ background: TAG_COLOR[b.kind] }} />
      <span className="dsh-rs-tag" style={{ color: TAG_COLOR[b.kind] }}>{b.tag}</span>
      <span className="dsh-rs-title">{b.title}</span>
      <span className="dsh-rs-time">{formatDuration(now - skew - b.since)}</span>
    </span>
  )
  return (
    <>
      {hidden}
      {createPortal(inline, target)}
    </>
  )
}

function asTotals(value: unknown): TotalsView | undefined {
  return typeof value === 'object' && value !== null && Array.isArray((value as TotalsView).models) ? value as TotalsView : undefined
}

/** 宿主自带的统计投影里卡片要用的几项。 */
interface HostStats {
  readonly turns: number
  readonly steps: number
  readonly llmMs: number
  readonly toolMs: number
  readonly ttftMs: number
  readonly ttftSteps: number
  readonly decodeTokens: number
  readonly decodeMs: number
}

function asHostStats(value: unknown): HostStats | undefined {
  const v = value as Partial<HostStats> | null | undefined
  return typeof v?.turns === 'number' && typeof v.steps === 'number' && typeof v.llmMs === 'number' && typeof v.toolMs === 'number' ? v as HostStats : undefined
}

const wholeSecond = (ms: number): number => Math.floor(ms / 1000) * 1000

interface Row {
  readonly key: string
  readonly label: string
  readonly value: string
  readonly dot?: string
  readonly title?: string
}

/** 一组「左说明、右数字」，和宿主自带弹窗同一种排法；几组之间用细线隔开。 */
function Rows({ rows }: { rows: readonly Row[] }): JSX.Element {
  return (
    <dl className="dsh-rs-details">
      {rows.map((r) => (
        <div key={r.key} className="dsh-rs-pair" title={r.title}>
          <dt>{r.dot !== undefined && <span className="dsh-rs-dot" style={{ background: r.dot }} />}<span className="dsh-rs-dt-text">{r.label}</span></dt>
          <dd>{r.value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** 完整统计未加载时，只显示已知耗时，避免把宿主接收速度当成生成速度。 */
function hostRows(host: HostStats): Row[] {
  const rows: Row[] = []
  if (host.llmMs > 0) rows.push({ key: 'llm', label: '模型用时', value: formatStatDuration(host.llmMs) })
  if (host.toolMs > 0) rows.push({ key: 'tool', label: '工具调用用时', value: formatStatDuration(host.toolMs) })
  rows.push({ key: 'unavailable', label: '速度统计', value: '暂不可用，请重启 DSH', title: '完整统计尚未加载，不能用宿主的接收内容时间推算生成速度。' })
  return rows
}

function wallRows(totals: TotalsView, hostNow: number): Row[] {
  const live = totals.runningSince === null ? 0 : Math.max(0, hostNow - totals.runningSince)
  return [
    { key: 'run', label: '累计工作用时', ms: totals.runMs + live, title: '每轮从开始到结束，加上正在跑的这一轮' },
    { key: 'user', label: '等你回复', ms: totals.waitUserMs, title: '一轮停下后，等你发下一条消息' },
    { key: 'notice', label: '等后台通知', ms: totals.waitNoticeMs, title: '一轮停下后，等后台任务、子会话或通知把它叫醒' },
  ].filter((r) => r.key === 'run' || r.ms >= 1000).map((r) => ({ key: r.key, label: r.label, value: formatStatDuration(r.ms), title: r.title }))
}

function workRows(totals: TotalsView): Row[] {
  return [
    { key: 'llm', label: '模型用时', value: formatStatDuration(totals.llmMs) },
    { key: 'tool', label: '工具调用用时', value: formatStatDuration(totals.toolMs) },
  ]
}

const tps = (s: { outputTokens: number; tokenMs: number }): string => `${formatSpeed(s.outputTokens, s.tokenMs)} tok/s`
const SPEED_NOTE = '上报的输出 token 总数除以对应请求的总用时，包含等待、思考和接收内容，不含工具执行；只统计已完成且上报输出数的请求。'
const CONTENT_NOTE = '从每步开始到收到第一段文字、思考文字或工具调用的等待时间，含请求准备；取中位数，一半请求不超过这个时间。'
const GENERATION_NOTE = '当前接口没有提供与全部输出 token 对应的准确生成计时；不能用含隐藏思考的 token 数除以接收文字的时间。'

function speedRows(totals: TotalsView, running: boolean): Row[] {
  const rows: Row[] = []
  const value = (s: { outputTokens: number; tokenMs: number; medianTtftMs: number | null }): string =>
    [tps(s), s.medianTtftMs === null ? null : `等内容 ${formatStatDuration(s.medianTtftMs)}`].filter(Boolean).join(' · ')
  const scope = running ? '速度截至上次已完成请求，进行中的耗时仍实时更新。' : '只统计已完成请求。'
  const note = `${SPEED_NOTE}${CONTENT_NOTE}${GENERATION_NOTE}${scope}`
  const avg = totals.average
  if (avg != null && avg.tokenMs > 0) {
    const since = avg.switched ? `第 ${avg.sinceTurn} 轮换模型后` : '本会话'
    rows.push({ key: 'average', label: avg.switched ? '换模型后平均' : '会话平均', value: value(avg), title: `${avg.model}，${since}。${note}` })
  }
  const cur = totals.current
  if (cur != null && cur.tokenMs > 0) {
    rows.push({ key: 'current', label: `第 ${cur.turn} 轮平均`, value: value(cur), title: `${cur.model}，第 ${cur.turn} 轮。${note}` })
  }
  return rows
}

function turnRows(snap: RunSnapshot, hostNow: number): Row[] {
  const head = snap.turn === undefined ? '本轮' : `第 ${snap.turn} 轮`
  const rows: Row[] = []
  if (snap.turnStart !== undefined) rows.push({ key: 'turn-time', label: `${head}用时`, value: formatStatDuration(Math.max(0, hostNow - snap.turnStart)) })
  if (snap.partial) rows.push({ key: 'partial', label: '分段统计范围', value: '本轮开头未记录' })
  rows.push(...breakdown(snap, hostNow).map((r) => ({ key: r.kind, label: `${head} · ${r.name}`, value: formatStatDuration(r.ms), dot: TAG_COLOR[r.kind] })))
  return rows
}

function StatsPill(props: Props): JSX.Element | null {
  const totals = asTotals(props.useProjection?.(TOTALS_KEY))
  const host = asHostStats(props.useProjection?.('sessionStats'))
  const running = useRunning(props)
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLSpanElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  // DSH 0.2.2-rc.2 起基础组件不再导出 useAnchoredPosition，宿主自带统计卡改用 CSS 锚点定位，这里照做。
  const anchorName = `--dsh-rs-${useId().replaceAll(':', '')}`
  useDismissOnOutsidePointer(rootRef, open, setOpen, panelRef)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  const { snap, skew } = useSnapshot(props.sessionId, running && open)
  const now = useTick(open)
  useEffect(ensureStyle, [])
  const steps = totals?.steps ?? host?.steps ?? 0
  if (steps === 0) return null

  // 每次请求结束后才有完整的 token 数，卡面沿用最近一轮已完成请求的速度。
  const cur = totals?.current
  const speed = cur != null && cur.tokenMs > 0 ? `含等待 ${tps(cur)}` : null
  const counts = `${totals?.turns ?? host?.turns ?? 0} 轮 ${steps} 步`
  const text = speed === null ? counts : `${counts} · ${speed}`
  const hostNow = now - skew
  const icon = <IconGaugeOutlineRegular />
  return (
    <span ref={rootRef} className="dsh-rs-anchor" data-composer-stat={STATS_ENTRY_ID} style={{ anchorName } as CSSProperties}>
      <button type="button" className="dsh-rs-pill" aria-haspopup="dialog" aria-expanded={open} aria-label={text} onClick={() => setOpen((v) => !v)}>
        {icon}
        <span className="dsh-rs-pill-label">{counts}{speed !== null && <><span className="dsh-rs-sep" aria-hidden="true">·</span>{speed}</>}</span>
      </button>
      {open && createPortal(
        <div ref={panelRef} className="dsh-rs-panel" role="dialog" aria-label="会话统计" style={{ positionAnchor: anchorName } as CSSProperties}>
          <div className="dsh-rs-title"><span className="dsh-rs-title-label">{icon}会话统计</span><span className="dsh-rs-num">{counts}</span></div>
          <div className="dsh-rs-rule" aria-hidden="true" />
          {(totals === undefined
            ? [host === undefined ? [] : hostRows(host)]
            : [wallRows(totals, hostNow), workRows(totals), speedRows(totals, running), running && snap?.running === true ? turnRows(snap, hostNow) : []]
          ).filter((group) => group.length > 0).map((group, i) => (
            <div key={i}>
              {i > 0 && <div className="dsh-rs-rule dsh-rs-gap-rule" aria-hidden="true" />}
              <Rows rows={group} />
            </div>
          ))}
        </div>,
        document.body,
      )}
    </span>
  )
}

export function apply(ctx: Context): void {
  const slots = (ctx as unknown as { slots: { inject: (slot: string, fn: () => unknown) => void; register: (options: unknown, component: unknown) => unknown } }).slots
  slots.inject(DOCK_SLOT, () => slots.register({ name: DOCK_SLOT, id: ENTRY_ID, order: 50 }, RunStatusAnchor))
  slots.inject(STATS_SLOT, () => slots.register({ name: STATS_SLOT, id: STATS_ENTRY_ID, order: STATS_ENTRY_ORDER, priority: STATS_ENTRY_PRIORITY }, StatsPill))
}