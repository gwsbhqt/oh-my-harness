import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CodeBlock, IconChevronRightOutlineRegular as IconChevron, IconInspectOutlineRegular as IconInspect } from '@deepseek-ai/dsh-client-ui-primitives'
import { PANEL_CONTROL_PATH, PANEL_NAME_PATH, PANEL_STATE_PATH, type PanelCell, type PanelControlAction, type PanelControlResult, type PanelLifecycle, type PanelName, type PanelNameAction, type PanelNameResult, type PanelPreview, type PanelState } from '../panel-types.ts'
import { loadPreview } from './preview-request.ts'

/** Marker on the conversation scroller while this tab is shown; the same seam dsh-context uses to drop the composer. */
const SURFACE_ATTR = 'data-kernel-panel-surface'

const css = `
[data-conversation-scroll][${SURFACE_ATTR}]>[data-composer-seat]:not(:has([data-approval-key],[data-question-key],[data-plan-review-key])),[data-conversation-scroll][${SURFACE_ATTR}]~[data-width-handle]{display:none}
.dsh-kernel-panel{--kb-line:var(--dsw-alias-border-l2,color-mix(in srgb,currentColor 12%,transparent));--kb-muted:var(--dsw-alias-label-tertiary,#888);--kb-soft:var(--dsw-alias-label-secondary,#aaa);--kb-fill:var(--dsw-alias-interactive-bg-hover,color-mix(in srgb,currentColor 6%,transparent));--kb-panel:color-mix(in srgb,currentColor 2%,transparent);--kb-ok:var(--dsw-alias-state-success-primary,#3fa66b);--kb-err:var(--dsw-alias-state-danger-primary,#d0533f);--kb-warn:var(--dsw-alias-state-warning-primary,#c48a2c);--kb-live:var(--dsw-alias-state-business-primary,#4d7cf0);--kb-class:#9b72e8;container:kernel / inline-size;height:100%;overflow:hidden auto;display:flex;flex-direction:column;box-sizing:border-box;padding:14px 24px 20px;color:var(--dsw-alias-label-primary,inherit);font-size:12px;line-height:1.5;font-variant-numeric:tabular-nums}
.dsh-kernel-panel *{box-sizing:border-box}.kb-shell{width:100%;max-width:1240px;margin:0 auto;flex:1 1 auto;min-height:0;display:flex;flex-direction:column;gap:12px}
.kb-head{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:26px}.kb-head-main{display:flex;align-items:center;gap:10px;min-width:0}.kb-head h1{font-size:15px;font-weight:600;margin:0;white-space:nowrap}
.kb-pill{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 9px;border-radius:11px;background:var(--kb-fill);font-size:11px;white-space:nowrap;flex:none}
.kb-dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:var(--kb-muted);flex:none}.kb-dot[data-tone=ok]{background:var(--kb-ok)}.kb-dot[data-tone=error]{background:var(--kb-err)}.kb-dot[data-tone=warn]{background:var(--kb-warn)}.kb-dot[data-tone=live]{background:var(--kb-live)}
.kb-head-facts{display:flex;align-items:center;gap:6px;color:var(--kb-muted);min-width:0;white-space:nowrap;overflow:hidden}.kb-head-facts code{font-size:11px;overflow:hidden;text-overflow:ellipsis;min-width:0}.kb-muted{color:var(--kb-muted)}.kb-time{color:var(--kb-muted);font-size:11px;white-space:nowrap}
.kb-error{padding:8px 12px;border-radius:8px;background:color-mix(in srgb,var(--kb-err) 9%,transparent);color:var(--kb-err)}
.kb-metrics{display:grid;grid-template-columns:repeat(7,minmax(0,1fr));border:1px solid var(--kb-line);border-radius:10px;overflow:hidden}.kb-metric{padding:9px 14px;min-width:0}.kb-metric+.kb-metric{border-left:1px solid var(--kb-line)}
.kb-metric-label{font-size:11px;color:var(--kb-muted)}.kb-metric-value{font-size:15px;font-weight:600;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.kb-metric-value small{font-size:11px;font-weight:400;color:var(--kb-muted);margin-left:4px}.kb-metric-sub{font-size:11px;color:var(--kb-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kb-stack{display:flex;height:4px;border-radius:2px;overflow:hidden;margin-top:6px;background:var(--kb-fill)}.kb-stack>span{height:100%}
.kb-row2{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:12px}.kb-card{border:1px solid var(--kb-line);border-radius:10px;padding:10px 14px 10px;min-width:0;display:flex;flex-direction:column}
.kb-card-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;margin-bottom:8px}.kb-card-title{font-weight:600}.kb-card-note{font-size:11px;color:var(--kb-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.kb-timeline{display:flex;align-items:flex-end;gap:2px;flex:1 1 auto;min-height:56px;border-bottom:1px solid var(--kb-line)}.kb-bar{flex:1 1 0;max-width:12px;min-width:2px;border:0;padding:0;border-radius:2px 2px 0 0;background:var(--kb-ok);opacity:.72;cursor:pointer;transition:opacity .12s}
.kb-bar:hover,.kb-bar[aria-pressed=true]{opacity:1}.kb-bar[aria-pressed=true]{outline:1px solid currentColor;outline-offset:1px}.kb-bar[data-tone=error]{background:var(--kb-err)}.kb-bar[data-tone=warn]{background:var(--kb-warn)}.kb-bar[data-tone=live]{background:var(--kb-live)}.kb-bar[data-tone=idle]{background:var(--kb-muted)}
.kb-epoch{flex:none;width:0;align-self:stretch;border-left:1px dashed var(--kb-line);margin:0 3px}.kb-epoch[data-host]{border-left:2px solid var(--kb-warn);opacity:.7}
.kb-legend{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;margin-top:5px;color:var(--kb-muted);font-size:11px}.kb-legend>span{display:inline-flex;align-items:center;gap:5px}.kb-legend .kb-grow{margin-left:auto}
.kb-tools{display:flex;flex-direction:column;gap:4px}.kb-tool{display:grid;grid-template-columns:minmax(0,104px) minmax(0,1fr) 44px;align-items:center;gap:8px;font-size:11px;line-height:1.3}.kb-tool code{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kb-tool>span:last-child{text-align:right;color:var(--kb-soft)}
.kb-track{height:6px;border-radius:3px;background:var(--kb-fill);overflow:hidden;display:flex}.kb-track>span{height:100%;background:var(--kb-live)}.kb-track>span+span{background:var(--kb-err)}
.kb-empty{color:var(--kb-muted);font-size:11px;padding:18px 8px;text-align:center;margin:auto 0}
.kb-browser{display:grid;grid-template-columns:268px minmax(0,1fr);border:1px solid var(--kb-line);border-radius:10px;overflow:hidden;flex:1 1 0;min-height:220px}
.kb-directory{border-right:1px solid var(--kb-line);display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--kb-panel)}.kb-search{padding:8px}
.kb-search input{width:100%;height:28px;outline:none;border:1px solid var(--kb-line);border-radius:6px;background:transparent;color:inherit;padding:0 9px;font:inherit}.kb-search input:focus{border-color:var(--kb-live)}.kb-search input::placeholder{color:var(--kb-muted)}
.kb-groups{flex:1;min-height:0;overflow:hidden auto;scrollbar-gutter:stable;padding:0 6px 8px;overscroll-behavior:contain}
.kb-group-head{--kb-indent:0px;display:flex;align-items:center;gap:6px;width:100%;height:28px;padding:0 8px 0 calc(6px + var(--kb-indent));border:0;border-radius:6px;background:transparent;color:var(--kb-soft);font:inherit;text-align:left;cursor:pointer}
.kb-group-head:hover{background:var(--kb-fill);color:var(--dsw-alias-label-primary,inherit)}.kb-group-head .kb-count{margin-left:auto}.kb-count{font-size:11px;color:var(--kb-muted);font-weight:400}
.kb-group .kb-group .kb-group-head{--kb-indent:14px}
.kb-chev{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex:none;color:var(--kb-muted);transform-origin:50% 50%;transition:transform .15s ease}.kb-chev[data-open=true]{transform:rotate(90deg)}.kb-chev svg{display:block;width:12px;height:12px}
.kb-section-label{font-size:10px;color:var(--kb-muted);padding:4px 8px 2px 26px}
.kb-name{--kb-indent:0px;display:grid;grid-template-columns:14px minmax(0,1fr) auto;align-items:center;gap:6px;width:100%;height:26px;padding:0 8px 0 calc(26px + var(--kb-indent));border:0;border-radius:6px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.kb-group .kb-group .kb-name{--kb-indent:14px}.kb-name:hover{background:var(--kb-fill)}.kb-name[aria-pressed=true]{background:color-mix(in srgb,var(--kb-live) 15%,transparent)}
.kb-name code{font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.kb-glyph{display:inline-flex;justify-content:center;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:10px;color:var(--kb-muted)}
.kb-meta{font-size:10px;color:var(--kb-muted);white-space:nowrap}[data-tone=error].kb-meta,.kb-tone[data-tone=error]{color:var(--kb-err)}[data-tone=warn].kb-meta,.kb-tone[data-tone=warn]{color:var(--kb-warn)}[data-tone=ok].kb-tone{color:var(--kb-ok)}[data-tone=live].kb-meta,.kb-tone[data-tone=live]{color:var(--kb-live)}
.kb-more{font-size:10px;color:var(--kb-muted);padding:4px 8px 6px 26px}.kb-directory-foot{padding:6px 12px;border-top:1px solid var(--kb-line);font-size:10px;color:var(--kb-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.kb-directory-foot[data-cached=true]{color:var(--kb-warn)}
.kb-preview{display:flex;flex-direction:column;min-width:0;min-height:0}.kb-preview-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 16px;border-bottom:1px solid var(--kb-line);min-height:50px}
.kb-preview-title{margin:0;font-size:13px;font-weight:600;overflow-wrap:anywhere}.kb-preview-meta{font-size:11px;color:var(--kb-muted);margin-top:1px;overflow-wrap:anywhere}.kb-actions{display:flex;gap:6px;flex:none}
.kb-head-side{display:flex;align-items:center;gap:10px;flex:none;min-width:0}.kb-controls{display:flex;gap:4px}.kb-ctl-note{font-size:11px;white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis}.kb-button:disabled{opacity:.45;cursor:default}.kb-button:disabled:hover{background:transparent}.kb-button[data-tone=error]{color:var(--kb-err);border-color:color-mix(in srgb,var(--kb-err) 45%,transparent)}.kb-button[aria-busy=true]{animation:kb-pulse 1s ease-in-out infinite}@keyframes kb-pulse{50%{opacity:.4}}
.kb-button{height:24px;padding:0 9px;border:1px solid var(--kb-line);border-radius:6px;background:transparent;color:inherit;font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}.kb-button:hover{background:var(--kb-fill)}
.kb-preview-body{flex:1;min-height:0;overflow:auto;scrollbar-gutter:stable;padding:12px 16px}.kb-facts{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px 20px;margin:0}.kb-fact{min-width:0;display:flex;flex-direction:column;gap:1px}.kb-facts dt{color:var(--kb-muted);font-size:11px}.kb-facts dd{margin:0;overflow-wrap:anywhere}.kb-facts code{font-size:11.5px;white-space:pre-wrap}.kb-fact:has(.kb-error-text){grid-column:1 / -1}.kb-error-text{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.kb-record-code{margin-top:14px}.kb-record-code-head{font-size:11px;color:var(--kb-muted);margin-bottom:6px}
.kb-notice{font-size:11px;color:var(--kb-muted);padding:7px 10px;border-left:2px solid var(--kb-line);margin:0 0 12px;overflow-wrap:anywhere}.kb-notice[data-tone=warn]{color:var(--kb-warn);border-color:color-mix(in srgb,var(--kb-warn) 45%,transparent)}
.kb-status{color:var(--kb-muted);margin:0 0 10px}.kb-loader{display:flex;align-items:center;gap:8px;color:var(--kb-muted);animation:kb-fade .15s .2s both}.kb-spinner{width:12px;height:12px;border-radius:50%;border:1.5px solid var(--kb-line);border-top-color:var(--kb-soft);animation:kb-spin .8s linear infinite}
@keyframes kb-spin{to{transform:rotate(360deg)}}@keyframes kb-fade{from{opacity:0}to{opacity:1}}
.kb-placeholder{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--kb-muted);text-align:center;padding:24px}.kb-placeholder strong{color:var(--kb-soft);font-weight:500;font-size:13px}
.kb-preview-code{max-width:100%}.kb-preview-code *{max-width:100%}
.kb-name:focus-visible,.kb-button:focus-visible,.kb-group-head:focus-visible,.kb-bar:focus-visible{outline:2px solid var(--kb-live);outline-offset:1px}
@container kernel (max-width:1100px){.kb-metrics{grid-template-columns:repeat(3,minmax(0,1fr))}.kb-metric:nth-child(4),.kb-metric:nth-child(7){border-left:0}.kb-metric:nth-child(n+4){border-top:1px solid var(--kb-line)}.kb-facts{grid-template-columns:repeat(3,minmax(0,1fr))}}
@container kernel (max-width:760px){.kb-row2{grid-template-columns:1fr}.kb-facts{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:720px){.dsh-kernel-panel{padding:12px}}
@container kernel (max-width:720px){.kb-head,.kb-preview-head{flex-wrap:wrap;align-items:flex-start}.kb-head-main{flex-wrap:wrap;flex:1 1 100%;gap:6px 10px}.kb-head-facts{flex-basis:100%;white-space:normal;overflow-wrap:anywhere}.kb-head-side{flex-wrap:wrap;gap:6px;margin-left:auto;max-width:100%}.kb-actions{flex-wrap:wrap;max-width:100%}.kb-ctl-note{white-space:normal;max-width:100%;overflow-wrap:anywhere}.kb-controls{flex-wrap:wrap}.kb-facts{grid-template-columns:76px minmax(0,1fr);gap:6px 8px}.kb-metric{padding:8px 10px}.kb-metric:nth-child(n){border-left:1px solid var(--kb-line)}.kb-metric:first-child{border-top:0}.kb-metric:nth-child(2){border-top:0}.kb-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}.kb-metric:nth-child(odd){border-left:0}.kb-metric:nth-child(n+3){border-top:1px solid var(--kb-line)}.kb-browser{grid-template-columns:1fr;flex:none}.kb-directory{border-right:0;border-bottom:1px solid var(--kb-line);max-height:300px}.kb-preview-body{max-height:440px}.kb-head-facts code{display:none}}
@media(prefers-reduced-motion:reduce){.kb-chev,.kb-bar{transition:none}.kb-button[aria-busy=true],.kb-loader,.kb-spinner{animation:none}}
`

type Tone = 'ok' | 'error' | 'warn' | 'live' | 'idle'
const cellMeta: Record<PanelCell['status'], { label: string; tone: Tone }> = {
  queued: { label: '排队中', tone: 'idle' }, running: { label: '运行中', tone: 'live' }, ok: { label: '成功', tone: 'ok' },
  error: { label: '出错', tone: 'error' }, aborted: { label: '已取消', tone: 'warn' }, 'kernel-exit': { label: '内核退出', tone: 'error' },
}
const origins = [
  { key: 'user', label: '自己定义的', values: ['user'] },
  { key: 'import', label: '导入的', values: ['import'] },
  { key: 'system', label: '系统给的', values: ['system', 'preloaded', 'internal'] },
] as const
const kinds: Array<{ kind: PanelName['kind']; label: string; glyph: string; color: string }> = [
  { kind: 'function', label: '函数', glyph: 'ƒ', color: 'var(--kb-live)' },
  { kind: 'class', label: '类', glyph: 'C', color: 'var(--kb-class)' },
  { kind: 'data', label: '变量', glyph: '{}', color: 'var(--kb-ok)' },
  { kind: 'module', label: '模块', glyph: 'M', color: 'var(--kb-warn)' },
  { kind: 'system', label: '系统', glyph: '⌘', color: 'var(--kb-muted)' },
]
const kindInfo = Object.fromEntries(kinds.map(item => [item.kind, item])) as Record<PanelName['kind'], (typeof kinds)[number]>
const isFunction = (item: PanelName) => item.kind === 'function' || item.kind === 'class'
const ROW_LIMIT = 300
const LARGEST_SHOWN = 15
/** Hover text naming the biggest names in the last snapshot. */
const largestNote = (snapshot: PanelState['snapshot'] | undefined) => {
  const entries = Object.entries(snapshot?.sizes ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
  return entries.length === 0 ? undefined : `最大：${entries.map(([name, bytes]) => `${name} ${size(bytes)}`).join('、')}${snapshot?.sizesComplete === false ? '（只读了一部分）' : ''}`
}
const TIMELINE_CELLS = 80
const snapshotGroups = [{ key: 'saved', label: '已保存' }, { key: 'skipped', label: '已跳过' }, { key: 'trimmed', label: '已裁剪' }] as const
const skillStatus: Record<string, { label: string; tone: Tone }> = {
  available: { label: '已导入', tone: 'ok' }, loaded: { label: '已导入', tone: 'ok' }, unavailable: { label: '导入失败', tone: 'error' }, failed: { label: '导入失败', tone: 'error' },
  'docs-only': { label: '仅说明', tone: 'idle' }, disabled: { label: '已停用', tone: 'idle' }, candidate: { label: '待导入', tone: 'idle' },
}
const previewStatus: Record<PanelPreview['status'], string> = {
  ok: '', missing: '这个名字已经不存在了，请在目录中重新选择。', busy: '内核正在执行，空下来后会自动重新读取。',
  timeout: '这次读取用时过长，已停止等待，可以稍后重试。', 'not-started': '这个会话的内核尚未启动。',
  'kernel-exit': '内核已停止，请等它重新启动后再读取。', stale: '内核已换代，请在目录更新后重新选择。', error: '暂时无法读取，请稍后重试。',
}

const clock = (value: string | number | null | undefined) => value == null ? '—' : new Date(value).toLocaleTimeString('zh-CN', { hour12: false })
const dateTime = (value: string | number | null | undefined) => {
  if (value == null) return '—'
  const date = new Date(value)
  return `${date.getMonth() + 1}/${date.getDate()} ${clock(value)}`
}
const size = (value: number | null | undefined) => value == null ? '—' : value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 ** 2).toFixed(1)} MB`
const dur = (ms: number | null | undefined) => {
  if (ms == null) return '—'
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`
  return `${Math.floor(ms / 60_000)}m ${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`
}
const clip = (text?: string | null) => text ? text.length > 2400 ? `${text.slice(0, 2400)}…` : text : null
const ran = (cell: PanelCell, now: number) => cell.startedAt == null ? null : (cell.endedAt ?? now) - cell.startedAt
const namesPending: Record<NonNullable<PanelState['namespaceReason']>, string> = {
  busy: '内核正在执行，结束后读取名字', 'not-started': '内核还没启动，可点右上角「启动」', timeout: '读取名字超时，稍后自动重试',
  'kernel-exit': '内核已停止', error: '暂时读不到名字，稍后自动重试',
}
const pendingText = (state: PanelState | null) => state === null ? '读取中' : state.namespaceStatus === 'unavailable' ? namesPending[state.namespaceReason ?? 'error'] : null
const toolText = (cell: PanelCell) => cell.tools.length === 0 ? '没有调用 DSH 工具'
  : cell.tools.map(tool => `${tool.name} ×${tool.calls}${tool.errors ? `（失败 ${tool.errors}）` : ''}`).join('、')
const SKILL_CALL = /skills\.([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?\s*\(/g
/** 保存的这格源码里看起来调用的技能方法（skills.模块.函数(））。按代码识别，不是宿主观测。 */
function skillText(code: string | undefined): string | null {
  if (code === undefined) return null
  const counts = new Map<string, number>()
  for (const match of code.matchAll(SKILL_CALL)) {
    const name = match[2] === undefined ? (match[1] ?? '') : `${match[1]}.${match[2]}`
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  if (counts.size === 0) return null
  return [...counts].map(([name, n]) => `${name} ×${n}`).join('、')
}

const controlText: Record<PanelControlAction, { label: string; running: string; done: string }> = {
  start: { label: '启动', running: '正在启动内核…', done: '内核已启动' },
  stop: { label: '关闭', running: '正在保存快照并关闭…', done: '内核已关闭' },
  restart: { label: '重启', running: '正在重启内核…', done: '内核已重启' },
  reset: { label: '重置', running: '正在重置内核…', done: '内核已重置，变量和快照都已清空' },
}

/** Start/stop/restart/reset; reset asks once in place, and nothing runs while a cell does. */
function KernelControls({ sessionId, state, onDone }: { sessionId: string; state: PanelState | null; onDone: () => void }) {
  const [pending, setPending] = useState<PanelControlAction | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [note, setNote] = useState<{ text: string; tone: Tone } | null>(null)
  useEffect(() => {
    if (!confirming) return
    const timer = window.setTimeout(() => setConfirming(false), 4000)
    return () => window.clearTimeout(timer)
  }, [confirming])
  useEffect(() => {
    if (note === null || pending !== null) return
    const timer = window.setTimeout(() => setNote(null), 5000)
    return () => window.clearTimeout(timer)
  }, [note, pending])
  useEffect(() => { setConfirming(false); setNote(null) }, [sessionId])
  const run = async (action: PanelControlAction) => {
    setConfirming(false)
    setPending(action)
    setNote({ text: controlText[action].running, tone: 'idle' })
    try {
      const query = new URLSearchParams({ session: sessionId, action })
      const response = await fetch(`${PANEL_CONTROL_PATH}?${query}`, { method: 'POST', cache: 'no-store' })
      const result = await response.json() as Partial<PanelControlResult>
      setNote(result.ok === true ? { text: result.reason ?? controlText[action].done, tone: result.reason ? 'idle' : 'ok' }
        : { text: result.reason ?? `操作失败（${response.status}）`, tone: 'error' })
    } catch (err) {
      setNote({ text: err instanceof Error ? err.message : String(err), tone: 'error' })
    } finally {
      setPending(null)
      onDone()
    }
  }
  const busy = state === null || pending !== null || (state.busy && pending === null)
  const why = state?.busy && pending === null ? '内核正在执行代码，等这一格结束再操作' : undefined
  const button = (action: PanelControlAction, title: string) => <button type="button" className="kb-button" disabled={busy}
    aria-busy={pending === action} title={why ?? title} onClick={() => action === 'reset' ? setConfirming(true) : void run(action)}>{controlText[action].label}</button>
  return <div className="kb-head-side">
    {note && <span className="kb-ctl-note kb-tone" data-tone={note.tone} role="status" title={note.text}>{note.text}</span>}
    {confirming ? <div className="kb-controls">
      <button type="button" className="kb-button" data-tone="error" onClick={() => void run('reset')}>确认重置：清空全部变量</button>
      <button type="button" className="kb-button" onClick={() => setConfirming(false)}>取消</button>
    </div> : <div className="kb-controls" role="group" aria-label="内核控制">
      {state?.alive ? <>
        {button('restart', '保存快照后换一个新内核，变量会恢复')}
        {button('stop', '保存快照后关闭内核，下次执行代码或点启动时恢复变量')}
      </> : button('start', '现在启动内核，有快照就恢复变量')}
      {button('reset', '关闭内核并删除快照，换一个空内核')}
    </div>}
  </div>
}


type Life = { pinned: boolean; last: number | null; toArchive: number | null; toDelete: number | null; stuck?: string }
/** Where one live name stands in the archive/delete countdown; null when the lifecycle has no record of it. */
function lifeOf(lc: PanelLifecycle | null | undefined, name: string): Life | null {
  if (!lc) return null
  const pinned = lc.pins.includes(name)
  const rec = lc.names[name]
  if (!rec) return pinned ? { pinned, last: null, toArchive: null, toDelete: null } : null
  const idle = Math.max(0, lc.cell - rec.t)
  return { pinned, last: rec.t, toArchive: lc.archiveAfter ? Math.max(0, lc.archiveAfter - idle) : null,
    toDelete: lc.deleteAfter ? Math.max(0, lc.deleteAfter - idle) : null, ...(rec.stuck ? { stuck: rec.stuck } : {}) }
}
const lifeLabel = (life: Life | null) => life === null ? null : life.pinned ? '钉住' : life.stuck ? '无法归档'
  : life.toArchive != null ? `${life.toArchive} 格后归档` : life.toDelete != null ? `${life.toDelete} 格后删除` : null
const lifeTone = (life: Life | null): Tone | undefined => life === null ? undefined : life.pinned ? 'live' : life.stuck ? 'error'
  : (life.toArchive ?? life.toDelete ?? Infinity) <= 10 ? 'warn' : undefined
const kindName: Record<string, string> = { function: '函数', class: '类', data: '变量', module: '模块', system: '系统' }
const nameDone: Record<PanelNameAction, string> = { keep: '已钉住', unkeep: '已取消钉住', unarchive: '已取回', archive: '已归档' }
const key0 = (s: { type: string; name?: string; item?: { name: string } } | null) => s === null ? '' : s.item?.name ?? s.name ?? s.type

function Chevron({ open }: { open: boolean }) {
  return <span className="kb-chev" data-open={open} aria-hidden><IconChevron size={12}/></span>
}

type SnapshotGroup = (typeof snapshotGroups)[number]['key']
type Selection =
  | { type: 'object'; item: PanelName }
  | { type: 'cell'; seq: number }
  | { type: 'skill'; name: string }
  | { type: 'snapshot'; group: SnapshotGroup; name: string }
  | { type: 'snapshot-summary' }
  | { type: 'archived'; name: string }
  | { type: 'deleted'; name: string }
type RecordSelection = Exclude<Selection, { type: 'object' }>
const selectionKey = (s: Selection | null) => s === null ? '' : s.type === 'object' ? `o:${s.item.name}` : s.type === 'cell' ? `c:${s.seq}`
  : s.type === 'skill' ? `k:${s.name}` : s.type === 'snapshot' ? `s:${s.group}:${s.name}` : s.type === 'archived' ? `a:${s.name}` : s.type === 'deleted' ? `d:${s.name}` : 'summary'

interface RecordView { title: string; summary: string; note: string; tone?: Tone; facts: Array<[string, ReactNode]>; code?: string; codeClipped?: boolean; codeLines?: number; codeMissing?: string; output?: string; outputClipped?: boolean }
function recordDetails(selection: RecordSelection, state: PanelState | null, now: number): RecordView {
  const snapshot = state?.snapshot
  const lc = state?.lifecycle
  if (selection.type === 'archived' || selection.type === 'deleted') {
    const archived = selection.type === 'archived'
    const entry = archived ? lc?.archived.find(item => item.name === selection.name) : lc?.deleted.find(item => item.name === selection.name)
    if (!entry || !lc) return { title: selection.name, summary: archived ? '已归档' : '已删除', note: '这条记录已经不在了：名字可能已被取回、重新赋值或删除。', facts: [] }
    const left = lc.deleteAfter ? Math.max(0, lc.deleteAfter - (lc.cell - entry.t)) : null
    const facts: Array<[string, ReactNode]> = [
      ['类型', kindName[entry.k] ?? entry.k], ['首次出现', `第 ${entry.b} 格`], ['上次使用', `第 ${entry.t} 格（${lc.cell - entry.t} 格前）`],
      [archived ? '归档于' : '删除于', `第 ${entry.at} 格`],
    ]
    if (archived && 'bytes' in entry) facts.push(['归档大小', size(entry.bytes as number)])
    if (archived) facts.push(['删除', lc.pins.includes(selection.name) ? '已钉住，不会删除' : left == null ? '未启用自动删除' : `再过 ${left} 格不用就删除`])
    return { title: selection.name, summary: archived ? '已归档 · 不在内核里' : '已删除 · 只留记录', tone: archived ? 'warn' : 'error', facts,
      note: archived ? `${entry.at - entry.t >= lc.archiveAfter && lc.archiveAfter > 0 ? `超过 ${lc.archiveAfter} 格没用，` : '手动归档，'}已移出内核，存在单独的归档文件里，不随快照恢复。代码用到它时会自动取回，也可以点「取回」。`
        : `超过 ${lc.deleteAfter} 格没用，值已经删除，只留这条记录。模型再用到它时会被告知需要重新计算。` }
  }
  if (selection.type === 'cell') {
    const cell = state?.cells?.find(item => item.seq === selection.seq)
    if (cell === undefined) return { title: `第 ${selection.seq} 格`, summary: '执行记录', note: '这条记录已不在保留范围内（只保留最近 200 格）。', facts: [] }
    const meta = cellMeta[cell.status]
    const wait = (cell.startedAt ?? cell.endedAt ?? now) - cell.queuedAt
    const facts: Array<[string, ReactNode]> = [
      ['状态', <span className="kb-tone" data-tone={meta.tone}>{meta.label}</span>],
      ['运行编号', <code>{cell.id}</code>],
      ['内核', cell.epoch == null ? '还没交给内核' : `第 ${cell.epoch} 代`],
      ['提交时间', clock(cell.queuedAt)],
      ['开始前等待', dur(wait)],
      ['执行耗时', cell.startedAt == null ? '没有开始执行' : `${dur(ran(cell, now))}${cell.endedAt == null ? '（进行中）' : ''}`],
      ['结束时间', clock(cell.endedAt)],
      ['代码行数', `${cell.lines} 行`],
      ['返回的输出', cell.outputChars == null ? '—' : `${cell.outputChars.toLocaleString()} 字符`],
      ['DSH 工具调用', toolText(cell)],
    ]
    const skill = skillText(cell.code)
    if (skill) facts.push(['技能调用', <span>{skill} <span className="kb-muted">（按代码识别，不算 DSH 工具）</span></span>])
    if (cell.error) facts.push(['错误', <span className="kb-tone kb-error-text" data-tone="error" title={cell.error}>{cell.error}</span>])
    return { title: `第 ${cell.seq} 格`, summary: `执行记录 · ${meta.label}`, tone: meta.tone, facts,
      ...(cell.code === undefined
        ? { codeMissing: cell.firstLine }
        : { code: cell.code, codeClipped: cell.codeClipped === true, codeLines: cell.lines }),
      ...(cell.output === undefined ? {} : { output: cell.output, outputClipped: cell.outputClipped === true }),
      note: '开始前等待包括排队、启动内核和同步工具。记录跟着会话保存，DSH 重启后还在；只留最近 200 格，保存每格的代码和返回结果（过长会截断），不保存变量值。' }
  }
  if (selection.type === 'skill') {
    const skill = state?.skillReport?.skills.find(item => item.skill === selection.name)
    const status = skill ? skillStatus[skill.status] : undefined
    return { title: selection.name, summary: '技能导入记录', note: skill ? '这个会话启动内核时的技能导入情况。' : '这个技能已经不在当前导入记录中。', facts: [
      ['状态', skill ? <span className="kb-tone" data-tone={status?.tone ?? 'idle'}>{status?.label ?? skill.status}</span> : '已不在记录中'],
      ['内核名称', skill?.import_name ? <code>{skill.import_name}</code> : '—'],
      ['说明', clip(skill?.description) ?? '—'],
      ['原因', skill?.status === 'docs-only' ? '这个技能只提供操作说明，不需要导入 Python。' : clip(skill?.reason) ?? '—'],
    ] }
  }
  const base: Array<[string, ReactNode]> = [['快照时间', dateTime(snapshot?.savedAt)], ['文件大小', size(snapshot?.bytes)]]
  if (selection.type === 'snapshot-summary') return { title: '快照概况', summary: '上次保存的记录', note: snapshot?.error ?? '内核换代后，新内核从这份快照恢复变量。', facts: [
    ['状态', snapshot?.status === 'available' ? '已保存' : snapshot?.status === 'error' ? '读取失败' : snapshot?.status === 'disabled' ? '未启用' : '尚无快照'], ...base,
    ['已保存', `${snapshot?.saved.length ?? 0} 个名字`], ['已跳过', `${snapshot?.skipped.length ?? 0} 个名字`], ['已裁剪', `${snapshot?.trimmed.length ?? 0} 个名字`],
  ] }
  const group = snapshotGroups.find(item => item.key === selection.group)!
  const exists = selection.group === 'skipped' ? snapshot?.skipped.some(item => item.name === selection.name) : snapshot?.[selection.group].includes(selection.name)
  return { title: selection.name, summary: `快照记录 · ${group.label}`, note: exists ? '这是上次快照的保存记录，不代表对象现在的值。' : '这条记录已经不在最新快照中，请重新选择。', facts: [
    ['保存情况', exists ? group.label : '已不在记录中'], ...base,
    ['说明', selection.group === 'skipped' ? clip(snapshot?.skipped.find(item => item.name === selection.name)?.reason) ?? '—'
      : selection.group === 'trimmed' ? '为了控制快照大小，保存时移除了这条记录。' : '上次保存时保留了这个名字；当前内容可能已经变化。'],
  ] }
}

/** Puts the marker on the conversation scroller for as long as the tab is mounted. */
function useHiddenComposer(ref: { current: HTMLElement | null }) {
  useLayoutEffect(() => {
    const scroller = ref.current?.closest('[data-conversation-scroll]')
    if (scroller == null || scroller.hasAttribute(SURFACE_ATTR)) return
    scroller.setAttribute(SURFACE_ATTR, '')
    return () => scroller.removeAttribute(SURFACE_ATTR)
  }, [ref])
}

function Group({ id, label, count, open, onToggle, children }: { id: string; label: string; count: number | string; open: boolean; onToggle: (id: string) => void; children: ReactNode }) {
  return <div className="kb-group">
    <button type="button" className="kb-group-head" aria-expanded={open} onClick={() => onToggle(id)}><Chevron open={open}/><span>{label}</span><span className="kb-count">{count}</span></button>
    {open && children}
  </div>
}

function Row({ glyph, name, meta, tone, pressed, label, title, onClick }: { glyph: ReactNode; name: string; meta: string; tone?: Tone | undefined; pressed: boolean; label: string; title?: string | undefined; onClick: () => void }) {
  return <button type="button" className="kb-name" aria-pressed={pressed} aria-label={label} title={title} onClick={onClick}>
    <span className="kb-glyph" aria-hidden>{glyph}</span><code>{name}</code><span className="kb-meta" data-tone={tone}>{meta}</span>
  </button>
}

const More = ({ hidden }: { hidden: number }) => hidden > 0 ? <div className="kb-more">还有 {hidden} 项未列出，输入关键字缩小范围</div> : null

interface DirectoryProps {
  state: PanelState | null
  query: string
  selected: string
  open: Record<string, boolean>
  onToggle: (id: string) => void
  onObject: (item: PanelName) => void
  onRecord: (item: RecordSelection) => void
}

const Directory = memo(function Directory({ state, query, selected, open, onToggle, onObject, onRecord }: DirectoryProps) {
  const search = query.trim().toLowerCase()
  const hit = (text: string) => !search || text.toLowerCase().includes(search)
  const isOpen = (id: string) => search !== '' || open[id] === true
  const cells = useMemo(() => [...(state?.cells ?? [])].reverse(), [state?.cells])
  const cellHits = cells.filter(cell => hit(`#${cell.seq} ${cell.firstLine} ${cell.code ?? ''} ${cell.tools.map(tool => tool.name).join(' ')}`))
  const names = (state?.names ?? []).filter(item => hit(item.name))
  const skills = (state?.skillReport?.skills ?? []).filter(item => hit(`${item.skill} ${item.description ?? ''}`))
  const snapshot = state?.snapshot
  const snapshotHits = snapshotGroups.map(group => ({ ...group, items: (group.key === 'skipped' ? snapshot?.skipped.map(item => item.name) : snapshot?.[group.key] ?? [])?.filter(hit) ?? [] }))
  const summaryHit = hit('快照概况')
  const snapshotCount = snapshotHits.reduce((total, group) => total + group.items.length, 0)
  const lc = state?.lifecycle
  const pinnedHits = names.filter(item => lc?.pins.includes(item.name))
  const archivedHits = (lc?.archived ?? []).filter(item => hit(item.name))
  const deletedHits = (lc?.deleted ?? []).filter(item => hit(item.name))
  const sizes = state?.snapshot.sizes
  const largest = sizes === undefined ? [] : names.filter(item => (sizes[item.name] ?? 0) >= 1024)
    .sort((a, b) => sizes[b.name]! - sizes[a.name]!).slice(0, LARGEST_SHOWN)
  const total = cellHits.length + names.length + skills.length + snapshotCount + Number(summaryHit) + archivedHits.length + deletedHits.length
  const nameRow = (item: PanelName, bySize = false) => {
    const life = lifeOf(lc, item.name)
    const bytes = sizes?.[item.name]
    return <Row key={item.name} glyph={kindInfo[item.kind].glyph} name={item.name} meta={bySize ? size(bytes) : lifeLabel(life) ?? kindInfo[item.kind].label} tone={bySize ? undefined : lifeTone(life)}
      pressed={selected === `o:${item.name}`} label={`预览 ${item.name}`} title={`${item.name} · ${item.summary}${bytes != null ? ` · 快照中 ${size(bytes)}` : ''}${life?.last != null ? ` · 上次使用第 ${life.last} 格` : ''}${life?.stuck ? ` · 无法归档：${life.stuck}` : ''}`} onClick={() => onObject(item)}/>
  }
  const pending = pendingText(state)
  return <>
    <div className="kb-groups">
      <Group id="cells" label="执行记录" count={cellHits.length} open={isOpen('cells')} onToggle={onToggle}>
        {cellHits.slice(0, ROW_LIMIT).map(cell => {
          const meta = cellMeta[cell.status]
          const calls = cell.tools.reduce((sum, tool) => sum + tool.calls, 0)
          const duration = cell.startedAt != null && cell.endedAt != null ? dur(cell.endedAt - cell.startedAt) : meta.label
          const busyRow = cell.status === 'running' || cell.status === 'queued'
          return <Row key={cell.seq} glyph={<span className="kb-dot" data-tone={meta.tone}/>} name={cell.firstLine || `第 ${cell.seq} 格`}
            meta={busyRow ? meta.label : `${calls > 0 ? `${calls} 次 · ` : ''}${duration}`} tone={meta.tone === 'ok' ? undefined : meta.tone}
            pressed={selected === `c:${cell.seq}`} label={`查看第 ${cell.seq} 格`} title={`第 ${cell.seq} 格 · ${meta.label} · 工具调用 ${calls} 次\n${cell.firstLine}`} onClick={() => onRecord({ type: 'cell', seq: cell.seq })}/>
        })}
        <More hidden={cellHits.length - ROW_LIMIT}/>
        {!cellHits.length && <div className="kb-more">{search ? '没有匹配的执行记录' : '这个会话还没有执行过代码'}</div>}
      </Group>
      {largest.length > 0 && <Group id="largest" label="快照里最大的" count={largest.length} open={isOpen('largest')} onToggle={onToggle}>
        {largest.map(item => nameRow(item, true))}
        <div className="kb-more">按上次快照里的字节数排；大而不用的可以点开后归档</div>
      </Group>}
      {lc && pinnedHits.length > 0 && <Group id="pinned" label="钉住" count={pinnedHits.length} open={isOpen('pinned')} onToggle={onToggle}>
        {pinnedHits.slice(0, ROW_LIMIT).map(item => nameRow(item))}
      </Group>}
      {origins.map(group => {
        const items = names.filter(item => (group.values as readonly string[]).includes(item.origin))
        let budget = ROW_LIMIT
        return <Group key={group.key} id={group.key} label={group.label} count={pending ? '—' : items.length} open={isOpen(group.key)} onToggle={onToggle}>
          {[true, false].map(functions => {
            const part = items.filter(item => isFunction(item) === functions)
            const shown = part.slice(0, Math.max(0, budget))
            budget -= shown.length
            return part.length > 0 && <Fragment key={String(functions)}>
              <div className="kb-section-label">{functions ? '函数与类' : '变量与模块'}</div>
              {shown.map(item => nameRow(item))}
              <More hidden={part.length - shown.length}/>
            </Fragment>
          })}
          {!items.length && <div className="kb-more">{pending ?? (search ? '没有匹配的名字' : '暂无名字')}</div>}
        </Group>
      })}
      {lc && <Group id="archived" label="已归档" count={archivedHits.length} open={isOpen('archived')} onToggle={onToggle}>
        {archivedHits.slice(0, ROW_LIMIT).map(item => <Row key={item.name} glyph={kinds.find(k => k.kind === item.k)?.glyph ?? '{}'} name={item.name} meta={size(item.bytes)}
          pressed={selected === `a:${item.name}`} label={`查看已归档 ${item.name}`} title={`${item.name} · 第 ${item.at} 格归档`} onClick={() => onRecord({ type: 'archived', name: item.name })}/>)}
        <More hidden={archivedHits.length - ROW_LIMIT}/>
        {!archivedHits.length && <div className="kb-more">{search ? '没有匹配的归档' : `还没有名字超过 ${lc.archiveAfter || '—'} 格没用`}</div>}
      </Group>}
      {lc && <Group id="deleted" label="已删除" count={search ? deletedHits.length : lc.deletedTotal} open={isOpen('deleted')} onToggle={onToggle}>
        {deletedHits.slice(0, ROW_LIMIT).map(item => <Row key={item.name} glyph="×" name={item.name} meta={`第 ${item.at} 格`}
          pressed={selected === `d:${item.name}`} label={`查看已删除 ${item.name}`} title={`${item.name} · 第 ${item.at} 格删除`} onClick={() => onRecord({ type: 'deleted', name: item.name })}/>)}
        {!search && lc.deletedTotal > lc.deleted.length && <div className="kb-more">只列最近 {lc.deleted.length} 条，共 {lc.deletedTotal} 条</div>}
        {!deletedHits.length && <div className="kb-more">{search ? '没有匹配的删除记录' : '还没有删除过名字'}</div>}
      </Group>}
      <Group id="skills" label="技能导入" count={skills.length} open={isOpen('skills')} onToggle={onToggle}>
        {skills.map(skill => {
          const status = skillStatus[skill.status]
          return <Row key={skill.skill} glyph="◇" name={skill.skill} meta={status?.label ?? skill.status} tone={status?.tone === 'error' ? 'error' : undefined}
            pressed={selected === `k:${skill.skill}`} label={`查看技能 ${skill.skill}`} title={skill.description} onClick={() => onRecord({ type: 'skill', name: skill.skill })}/>
        })}
        {!skills.length && <div className="kb-more">暂无技能记录</div>}
      </Group>
      <Group id="snapshot" label="快照明细" count={snapshotCount} open={isOpen('snapshot')} onToggle={onToggle}>
        {summaryHit && <Row glyph="▤" name="快照概况" meta={size(snapshot?.bytes)} pressed={selected === 'summary'} label="查看快照概况" onClick={() => onRecord({ type: 'snapshot-summary' })}/>}
        {snapshotHits.map(group => <Group key={group.key} id={`snapshot-${group.key}`} label={group.label} count={group.items.length} open={isOpen(`snapshot-${group.key}`)} onToggle={onToggle}>
          {group.items.slice(0, ROW_LIMIT).map(name => <Row key={name} glyph="▤" name={name} meta={group.label} pressed={selected === `s:${group.key}:${name}`}
            label={`查看快照 ${group.label} ${name}`} title={name} onClick={() => onRecord({ type: 'snapshot', group: group.key, name })}/>)}
          <More hidden={group.items.length - ROW_LIMIT}/>
          {!group.items.length && <div className="kb-more">无{group.label}记录</div>}
        </Group>)}
      </Group>
      {search && !total && <div className="kb-more">没有找到匹配的记录</div>}
    </div>
    <div className="kb-directory-foot" data-cached={state?.namespaceStatus === 'cached'} role="status" title={state?.namespaceStatus === 'cached' ? `目录暂未更新，显示 ${clock(state.observedAt)} 读到的名字；共 ${total} 项` : undefined}>{state?.namespaceStatus === 'cached'
      ? `目录暂未更新 · 读取于 ${clock(state.observedAt)}` : `共 ${total} 项 · 对象点击后才读取内容`}</div>
  </>
})

function Timeline({ cells, now, selected, onSelect }: { cells: PanelCell[]; now: number; selected: string; onSelect: (seq: number) => void }) {
  const recent = cells.slice(-TIMELINE_CELLS)
  const max = Math.max(1, ...recent.map(cell => ran(cell, now) ?? 0))
  const scale = Math.log10(max + 1)
  const bars: ReactNode[] = []
  recent.forEach((cell, index) => {
    const previous = recent[index - 1]
    if (previous !== undefined && previous.host != null && cell.host != null && previous.host !== cell.host) {
      bars.push(<span key={`h${cell.seq}`} className="kb-epoch" data-host="" title={`DSH 在这里重启过（${clock(cell.host)} 启动）`}/>)
    } else if (previous !== undefined && previous.epoch != null && cell.epoch != null && previous.epoch !== cell.epoch) {
      bars.push(<span key={`e${cell.seq}`} className="kb-epoch" title={`第 ${cell.epoch} 代内核从这里开始`}/>)
    }
    const meta = cellMeta[cell.status]
    const ms = ran(cell, now)
    const ratio = ms == null ? 4 / 72 : (4 + (Math.log10(ms + 1) / scale) * 64) / 72
    const height = `${Math.min(ratio, 0.96) * 100}%`
    bars.push(<button key={cell.seq} type="button" className="kb-bar" data-tone={meta.tone} style={{ height }} aria-pressed={selected === `c:${cell.seq}`}
      aria-label={`第 ${cell.seq} 格，${meta.label}，${dur(ms)}`} title={`第 ${cell.seq} 格 · ${meta.label} · ${dur(ms)}\n${cell.firstLine}`} onClick={() => onSelect(cell.seq)}/>)
  })
  return <div className="kb-timeline">{bars}</div>
}

export interface KernelPanelProps { sessionId: string }

export function KernelPanel({ sessionId }: KernelPanelProps) {
  const root = useRef<HTMLDivElement>(null)
  useHiddenComposer(root)
  const [state, setState] = useState<PanelState | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [stateError, setStateError] = useState('')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({ cells: true, user: true })
  const [selected, setSelected] = useState<Selection | null>(null)
  const [preview, setPreview] = useState<PanelPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewNote, setPreviewNote] = useState('')
  const [previewAt, setPreviewAt] = useState<number | null>(null)
  const request = useRef<{ id: number; controller?: AbortController }>({ id: 0 })
  const refreshState = useRef<() => void>(() => {})
  const epoch = state?.epoch ?? 0
  const epochRef = useRef(epoch)
  epochRef.current = epoch

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    let pending = false
    let timer: number | undefined
    let lastKey = ''
    const refresh = async () => {
      if (!active || pending || document.hidden) return
      pending = true
      window.clearTimeout(timer)
      let busy = false
      try {
        const response = await fetch(`${PANEL_STATE_PATH}?session=${encodeURIComponent(sessionId)}`, { cache: 'no-store', signal: controller.signal })
        if (!response.ok) throw new Error(`状态读取失败（${response.status}）`)
        const text = await response.text()
        const result: PanelState = JSON.parse(text)
        busy = result.busy || (result.cells ?? []).some(cell => cell.status === 'running' || cell.status === 'queued')
        // Unchanged state keeps its identity, so the directory skips re-rendering.
        const key = text.replace(/"now":\d+,/, '')
        if (active) {
          setNow(result.now)
          if (key !== lastKey) { lastKey = key; setState(result) }
          setStateError('')
        }
      } catch (err) {
        if (active && !controller.signal.aborted) setStateError(err instanceof Error ? err.message : String(err))
      } finally {
        pending = false
        if (active) timer = window.setTimeout(() => void refresh(), busy ? 1500 : 5000)
      }
    }
    const onVisible = () => { if (!document.hidden) void refresh() }
    refreshState.current = () => void refresh()
    setState(null)
    setQuery('')
    setSelected(null)
    void refresh()
    document.addEventListener('visibilitychange', onVisible)
    return () => { active = false; controller.abort(); window.clearTimeout(timer); document.removeEventListener('visibilitychange', onVisible) }
  }, [sessionId])

  useEffect(() => {
    request.current.controller?.abort()
    request.current.id += 1
    setSelected(current => current?.type === 'object' ? null : current)
    setPreview(null)
    setPreviewNote('')
    setPreviewAt(null)
    setPreviewLoading(false)
    return () => { request.current.controller?.abort(); request.current.id += 1 }
  }, [sessionId, epoch])

  const beginPreview = useCallback(async (item: PanelName) => {
    request.current.controller?.abort()
    const id = ++request.current.id
    const controller = new AbortController()
    request.current.controller = controller
    setSelected({ type: 'object', item })
    setPreview(null)
    setPreviewLoading(true)
    setPreviewNote('')
    setPreviewAt(null)
    const timer = window.setTimeout(() => controller.abort(), 4000)
    try {
      const value = await loadPreview({ session: sessionId, name: item.name, epoch: epochRef.current }, controller.signal)
      if (request.current.id === id) { setPreview(value); setPreviewAt(Date.now()) }
    } catch (err) {
      if (request.current.id === id) setPreviewNote(controller.signal.aborted ? '读取超时，已停止等待。可以重新读取。' : err instanceof Error ? err.message : String(err))
    } finally {
      window.clearTimeout(timer)
      if (request.current.id === id) setPreviewLoading(false)
    }
  }, [sessionId])
  const cancelPreview = () => {
    request.current.id += 1
    request.current.controller?.abort()
    setPreviewLoading(false)
    setPreviewNote('已取消读取。')
  }
  const selectRecord = useCallback((item: RecordSelection) => {
    request.current.controller?.abort()
    request.current.id += 1
    setSelected(item)
    setPreview(null)
    setPreviewLoading(false)
    setPreviewNote('')
    setPreviewAt(null)
  }, [])
  const onObject = useCallback((item: PanelName) => void beginPreview(item), [beginPreview])
  const kernelBusy = state?.busy === true
  const [nameNote, setNameNote] = useState<{ text: string; tone: Tone } | null>(null)
  const [namePending, setNamePending] = useState(false)
  useEffect(() => { setNameNote(null) }, [key0(selected)])
  const nameAction = async (action: PanelNameAction, name: string) => {
    setNamePending(true)
    setNameNote(null)
    try {
      const query = new URLSearchParams({ session: sessionId, action, name })
      const response = await fetch(`${PANEL_NAME_PATH}?${query}`, { method: 'POST', cache: 'no-store' })
      const result = await response.json() as Partial<PanelNameResult>
      setNameNote(result.ok === true ? { text: nameDone[action], tone: 'ok' } : { text: result.reason ?? `操作失败（${response.status}）`, tone: 'error' })
    } catch (err) {
      setNameNote({ text: err instanceof Error ? err.message : String(err), tone: 'error' })
    } finally {
      setNamePending(false)
      refreshState.current()
    }
  }
  // A name archived or brought back (by a click, the model, or the sweep) keeps the selection on the same name.
  useEffect(() => {
    if (selected === null || state === null) return
    if (selected.type === 'archived') {
      const item = state.names.find(entry => entry.name === selected.name)
      if (item) void beginPreview(item)
    } else if (selected.type === 'object' && !state.names.some(entry => entry.name === selected.item.name)
      && state.lifecycle?.archived.some(entry => entry.name === selected.item.name)) {
      selectRecord({ type: 'archived', name: selected.item.name })
    }
  }, [state])
  // A preview refused because a cell was running is read again once a state poll newer than the refusal finds the kernel idle;
  // waiting for a busy→idle edge misses cells shorter than the idle poll interval.
  useEffect(() => {
    if (preview?.status !== 'busy' || selected?.type !== 'object' || previewLoading || previewAt == null) return
    if (!kernelBusy && now > previewAt) { void beginPreview(selected.item); return }
    const timer = window.setTimeout(() => refreshState.current(), 1500)
    return () => window.clearTimeout(timer)
  }, [preview, kernelBusy, now, previewLoading])
  const toggle = useCallback((id: string) => setOpen(current => ({ ...current, [id]: !current[id] })), [])
  const selectCell = useCallback((seq: number) => {
    setOpen(current => current['cells'] ? current : { ...current, cells: true })
    selectRecord({ type: 'cell', seq })
  }, [selectRecord])

  const stats = useMemo(() => {
    const cells = state?.cells ?? []
    const finished = cells.filter(cell => cell.startedAt != null && cell.endedAt != null).map(cell => cell.endedAt! - cell.startedAt!).sort((a, b) => a - b)
    const count = (status: PanelCell['status']) => cells.filter(cell => cell.status === status).length
    const tools = new Map<string, { name: string; calls: number; errors: number }>()
    for (const cell of cells) for (const tool of cell.tools) {
      const entry = tools.get(tool.name) ?? { name: tool.name, calls: 0, errors: 0 }
      entry.calls += tool.calls
      entry.errors += tool.errors
      tools.set(tool.name, entry)
    }
    const ranked = [...tools.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
    const names = state?.names ?? []
    return {
      cells: cells.length, ok: count('ok'), failed: count('error') + count('kernel-exit'), aborted: count('aborted'),
      totalMs: finished.reduce((total, ms) => total + ms, 0), medianMs: finished.length ? finished[Math.floor((finished.length - 1) / 2)]! : null,
      maxMs: finished.length ? finished[finished.length - 1]! : null, toolCalls: ranked.reduce((total, tool) => total + tool.calls, 0),
      toolErrors: ranked.reduce((total, tool) => total + tool.errors, 0), tools: ranked,
      origin: (key: string) => names.filter(item => key === 'system' ? ['system', 'preloaded', 'internal'].includes(item.origin) : item.origin === key).length,
      kinds: kinds.map(item => ({ ...item, count: names.filter(name => name.kind === item.kind).length })).filter(item => item.count > 0),
    }
  }, [state?.cells, state?.names])

  const key = selectionKey(selected)
  const selectedObject = selected?.type === 'object' ? state?.names.find(item => item.name === selected.item.name) ?? selected.item : null
  const previewOutdated = preview?.status === 'ok' && previewAt != null && (state?.cells ?? []).some(cell =>
    (cell.startedAt ?? cell.queuedAt) > previewAt || (cell.endedAt ?? 0) > previewAt)
  const objectMissing = selected?.type === 'object' && state?.namespaceStatus === 'live' && !state.names.some(item => item.name === selected.item.name)
  const record = selected && selected.type !== 'object' ? recordDetails(selected, state, now) : null
  const currentObject = selected?.type === 'snapshot' ? state?.names.find(item => item.name === selected.name) : undefined
  const source = preview?.kind === 'source'
  const content = preview?.status === 'ok' ? source ? preview.source ?? '' : JSON.stringify(preview.value ?? null, null, 2) : ''
  const snapshot = state?.snapshot
  const skills = state?.skillReport?.skills ?? []
  const skillsLoaded = skills.filter(item => item.status === 'available' || item.status === 'loaded').length
  const skillsFailed = skills.filter(item => item.status === 'unavailable' || item.status === 'failed').length
  const status: { label: string; tone: Tone } = !state ? { label: '读取中', tone: 'idle' } : state.busy ? { label: '正在执行', tone: 'live' }
    : state.alive ? { label: '运行中', tone: 'ok' } : state.epoch ? { label: '已停止', tone: 'warn' } : { label: '尚未启动', tone: 'idle' }
  const generations = state?.generations ?? []
  const ended = generations.filter(item => item.endedAt != null)
  const topTool = stats.tools[0]?.calls ?? 1

  return <div ref={root} className="dsh-kernel-panel" data-testid="kernel-panel" data-conversation-composer-overlay=""><style>{css}</style><div className="kb-shell">
    <header className="kb-head">
      <div className="kb-head-main">
        <h1>内核</h1>
        <span className="kb-pill" role="status"><span className="kb-dot" data-tone={status.tone}/>{status.label}</span>
        <span className="kb-head-facts">
          {state?.python ? <span title={state.executable ?? undefined}>Python {state.python}</span> : <span>{state?.epoch ? '内核已关闭，执行代码或点「启动」时从快照恢复' : '内核还没启动，执行代码时会自动启动'}</span>}
          {state?.epoch ? <span>· 第 {state.epoch} 代</span> : null}
          {state?.cwd && <><span>·</span><code title={state.cwd}>{state.cwd}</code></>}
        </span>
      </div>
      <div className="kb-head-side"><KernelControls sessionId={sessionId} state={state} onDone={() => refreshState.current()}/><span className="kb-time">{state ? `更新于 ${clock(now)}` : '等待内核状态'}</span></div>
    </header>
    {stateError && <div role="alert" className="kb-error">{stateError}{state ? '，下面保留上次读取的状态。' : ''}</div>}
    <section className="kb-metrics" aria-label="内核概况">
      <div className="kb-metric"><div className="kb-metric-label">名字</div><div className="kb-metric-value">{state?.total ?? '—'}<small>个</small></div>
        <div className="kb-metric-sub" title={state?.namespaceStatus === 'cached' ? `内核正忙，显示 ${clock(state.observedAt)} 读到的目录` : undefined}>{pendingText(state) ?? `自定义 ${stats.origin('user')} · 导入 ${stats.origin('import')} · 系统 ${stats.origin('system')}`}</div>
        {stats.kinds.length > 0 && <div className="kb-stack" title={stats.kinds.map(item => `${item.label} ${item.count}`).join(' · ')}>{stats.kinds.map(item => <span key={item.kind} style={{ flexGrow: item.count, background: item.color }}/>)}</div>}</div>
      <div className="kb-metric"><div className="kb-metric-label">执行</div><div className="kb-metric-value">{stats.cells}<small>格</small></div>
        <div className="kb-metric-sub">成功 {stats.ok} · 出错 {stats.failed} · 取消 {stats.aborted}</div></div>
      <div className="kb-metric"><div className="kb-metric-label">执行耗时</div><div className="kb-metric-value">{stats.cells ? dur(stats.totalMs) : '—'}<small>合计</small></div>
        <div className="kb-metric-sub">中位 {dur(stats.medianMs)} · 最长 {dur(stats.maxMs)}</div></div>
      <div className="kb-metric"><div className="kb-metric-label">工具调用</div><div className="kb-metric-value">{stats.toolCalls}<small>次</small></div>
        <div className="kb-metric-sub">{stats.tools.length} 种工具 · 失败 {stats.toolErrors}</div></div>
      <div className="kb-metric"><div className="kb-metric-label">上次快照</div><div className="kb-metric-value">{snapshot?.status === 'available' ? size(snapshot.bytes) : snapshot?.status === 'error' ? '读取失败' : snapshot?.status === 'disabled' ? '未启用' : '尚无'}</div>
        <div className="kb-metric-sub" title={largestNote(snapshot)}>{snapshot?.status === 'available' ? `${dateTime(snapshot.savedAt)} · ${snapshot.saved.length} 个名字` : '成功执行后自动保存'}</div></div>
      <div className="kb-metric"><div className="kb-metric-label">名字去留</div><div className="kb-metric-value">{state?.lifecycle ? state.lifecycle.archived.length : '—'}<small>已归档</small></div>
        <div className="kb-metric-sub" title={state?.lifecycle ? `超过 ${state.lifecycle.archiveAfter} 格没用就归档，超过 ${state.lifecycle.deleteAfter} 格删除；0 表示关闭。第 ${state.lifecycle.cell} 格` : undefined}>{state?.lifecycle
          ? `钉住 ${state.lifecycle.pins.length} · 已删除 ${state.lifecycle.deletedTotal} · ${state.lifecycle.archiveAfter || '—'}/${state.lifecycle.deleteAfter || '—'} 格` : '执行代码后开始记录'}</div></div>
      <div className="kb-metric"><div className="kb-metric-label">技能</div><div className="kb-metric-value">{state?.skillReport ? skillsLoaded : '—'}<small>已导入</small></div>
        <div className="kb-metric-sub">{state?.skillReport ? `共 ${skills.length} 个 · 失败 ${skillsFailed}` : '内核启动时导入'}</div></div>
    </section>
    <section className="kb-row2">
      <div className="kb-card">
        <div className="kb-card-head"><span className="kb-card-title">执行节奏</span><span className="kb-card-note">{state?.recordedSince ? `${dateTime(state.recordedSince)} 起记录${(state.cellsDropped ?? 0) > 0 ? `，较早的 ${state.cellsDropped} 格未保留` : ''} · 最近 ${Math.min(TIMELINE_CELLS, stats.cells)} 格` : '这个会话还没有执行记录'}</span></div>
        {stats.cells ? <>
          <Timeline cells={state?.cells ?? []} now={now} selected={key} onSelect={selectCell}/>
          <div className="kb-legend">
            {(['ok', 'error', 'warn', 'live'] as const).map(tone => <span key={tone}><span className="kb-dot" data-tone={tone}/>{tone === 'ok' ? '成功' : tone === 'error' ? '出错' : tone === 'warn' ? '取消' : '运行中'}</span>)}
            <span>柱高按耗时对数</span>
            <span className="kb-grow" title={ended.map(item => `第 ${item.epoch} 代 ${clock(item.startedAt)}–${clock(item.endedAt)}${item.reason ? `：${item.reason}` : ''}`).join('\n') || undefined}>
              {generations.length > 1 ? `内核换过 ${generations.length - 1} 次，虚线是换代处` : generations.length === 1 ? `第 ${generations[0]!.epoch} 代内核 ${clock(generations[0]!.startedAt)} 启动` : ''}
            </span>
          </div>
        </> : <div className="kb-empty">这个会话还没有执行过代码</div>}
      </div>
      <div className="kb-card">
        <div className="kb-card-head"><span className="kb-card-title">工具调用</span><span className="kb-card-note">代码里调用的 DSH 工具</span></div>
        {stats.tools.length ? <div className="kb-tools">{stats.tools.slice(0, 5).map(tool => <div className="kb-tool" key={tool.name} title={`${tool.name}：${tool.calls} 次，失败 ${tool.errors} 次`}>
          <code>{tool.name}</code>
          <span className="kb-track"><span style={{ width: `${((tool.calls - tool.errors) / topTool) * 100}%` }}/>{tool.errors > 0 && <span style={{ width: `${(tool.errors / topTool) * 100}%` }}/>}</span>
          <span>{tool.calls}</span>
        </div>)}
        {stats.tools.length > 5 && <div className="kb-muted" style={{ fontSize: 11 }}>另有 {stats.tools.length - 5} 种工具</div>}</div>
          : <div className="kb-empty">还没有工具调用</div>}
      </div>
    </section>
    <section className="kb-browser" aria-label="名字与内容浏览器">
      <aside className="kb-directory">
        <div className="kb-search"><input aria-label="搜索目录" placeholder="搜索执行记录、对象、技能或快照…" value={query} onChange={event => setQuery(event.target.value)}/></div>
        <Directory state={state} query={query} selected={key} open={open} onToggle={toggle} onObject={onObject} onRecord={selectRecord}/>
      </aside>
      <article className="kb-preview" aria-label="内容预览" aria-busy={previewLoading}>
        {!selected ? <div className="kb-placeholder"><IconInspect size={22}/><strong>点选左侧条目查看详情</strong><span>函数显示源码，变量读取 JSON；执行记录显示每格的代码、耗时和工具调用。</span></div> : <>
          <div className="kb-preview-head">
            <div style={{ minWidth: 0 }}><h2 className="kb-preview-title"><code>{record?.title ?? selectedObject?.name}</code></h2>
              <div className="kb-preview-meta">{record ? record.summary : selectedObject ? `${kindInfo[selectedObject.kind].label} · ${selectedObject.summary}${state?.snapshot.sizes?.[selectedObject.name] != null ? ` · 快照中 ${size(state.snapshot.sizes[selectedObject.name])}` : ''}${previewAt && preview?.status === 'ok' ? ` · 读取于 ${clock(previewAt)}` : ''}` : ''}</div></div>
            <div className="kb-actions">{nameNote && <span className="kb-ctl-note kb-tone" data-tone={nameNote.tone} role="status" title={nameNote.text}>{nameNote.text}</span>}
              {(() => {
                const lc = state?.lifecycle
                const target = selectedObject?.name ?? (selected?.type === 'archived' ? selected.name : null)
                if (!lc || target === null || (selectedObject && !lc.names[target] && !lc.pins.includes(target))) return null
                const pinned = lc.pins.includes(target)
                const off = kernelBusy || namePending || !state?.alive
                const why = !state?.alive ? '内核没有在运行，先启动内核' : kernelBusy ? '内核正在执行代码，等这一格结束再操作' : undefined
                const btn = (action: PanelNameAction, label: string, title: string) => <button key={action} type="button" className="kb-button" disabled={off} aria-busy={namePending}
                  title={why ?? title} onClick={() => void nameAction(action, target)}>{label}</button>
                return selected?.type === 'archived'
                  ? <>{btn('unarchive', '取回', '把它放回内核，重新开始计格')}{btn('keep', '取回并钉住', '放回内核并钉住，以后不再归档或删除')}</>
                  : <>{pinned ? btn('unkeep', '取消钉住', '取消钉住，从这一格重新开始计格') : btn('keep', '钉住', '钉住后不会被归档或删除')}
                    {!pinned && btn('archive', '归档', '马上移出内核，代码用到时自动取回')}</>
              })()}
              {selectedObject ? previewLoading ? <button type="button" className="kb-button" onClick={cancelPreview}>取消</button>
              : <button type="button" className="kb-button" onClick={() => void beginPreview(selectedObject)}>重新读取</button>
              : <>{currentObject && <button type="button" className="kb-button" onClick={() => void beginPreview(currentObject)}>查看当前对象</button>}<button type="button" className="kb-button" onClick={() => refreshState.current()}>刷新</button></>}</div>
          </div>
          <div className="kb-preview-body" aria-live="polite">
            {record ? <>
              <p className="kb-notice">{record.note}</p>
              {record.facts.length > 0 && <dl className="kb-facts">{record.facts.map(([label, value]) => <div className="kb-fact" key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>}
              {record.code !== undefined
                ? <div className="kb-record-code">
                    <div className="kb-record-code-head">执行的代码</div>
                    {record.codeClipped && <p className="kb-notice" data-tone="warn">这一格的代码较长，只保留并显示开头的部分。</p>}
                    <CodeBlock className="kb-preview-code" code={record.code} lang="python" copyLabel="复制" copiedLabel="已复制" lineNumbers toolbarLabels={{ codeLabel: 'Python', wrapLabel: '自动换行', unwrapLabel: '取消换行' }}/>
                  </div>
                : record.codeMissing !== undefined
                  ? <p className="kb-notice" data-tone="warn">这一格没有保存完整代码，只有首行：<code>{record.codeMissing || '（空）'}</code></p>
                  : null}
              {record.output !== undefined && <div className="kb-record-code">
                <div className="kb-record-code-head">返回结果</div>
                {record.outputClipped && <p className="kb-notice" data-tone="warn">这一格的输出较长，只保留并显示开头的部分。</p>}
                {record.output === ''
                  ? <p className="kb-notice">这一格没有输出。</p>
                  : <CodeBlock className="kb-preview-code" code={record.output} lang="text" copyLabel="复制" copiedLabel="已复制" lineNumbers={false}
                      toolbarLabels={{ codeLabel: '输出', wrapLabel: '自动换行', unwrapLabel: '取消换行' }}/>}
              </div>}
            </> : <>
              {previewLoading && <div className="kb-loader"><span className="kb-spinner" aria-hidden/>正在读取 {selectedObject?.name}…</div>}
              {previewNote && <p className="kb-status">{previewNote}</p>}
              {preview && preview.status !== 'ok' && <p className="kb-status">{previewStatus[preview.status]}{preview.reason && preview.status !== 'busy' && <><br/>{preview.reason}</>}</p>}
              {preview?.status === 'ok' && <>
                 {objectMissing ? <p className="kb-notice" data-tone="warn">这个名字已不在当前内核中。下面保留的是上次读取的内容。</p>
                   : previewOutdated && <p className="kb-notice" data-tone="warn">读取后又执行了代码，内容可能已经变化。点击「重新读取」查看当前内容。</p>}
                {preview.truncated && <p className="kb-notice" data-tone="warn">内容较大，只显示部分预览。{preview.reason ?? ''}</p>}
                {!preview.truncated && preview.reason && <p className="kb-notice">{preview.reason}</p>}
                {preview.filename && <p className="kb-preview-meta" style={{ margin: '0 0 10px' }}>{preview.filename}{preview.line ? `:${preview.line}` : ''}</p>}
                <CodeBlock className="kb-preview-code" code={content} lang={source ? 'python' : 'json'} copyLabel="复制" copiedLabel="已复制" lineNumbers={source}
                  toolbarLabels={{ codeLabel: source ? 'Python 源码' : preview.kind === 'metadata' ? '对象信息' : 'JSON', wrapLabel: '自动换行', unwrapLabel: '取消换行' }}/>
              </>}
            </>}
          </div>
        </>}
      </article>
    </section>
  </div></div>
}
