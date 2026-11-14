/**
 * 每个会话一份「现在在干什么」的记录。只吃宿主事件，不碰宿主对象，方便单测。
 *
 * 同一时刻可能有好几件事同时成立（命令在跑，外面套着 run_code，再外面是这一步），
 * 显示时按优先级取最具体的那件：钩子 > 等你 > 压缩 > 重试 > 工具 > 模型 > 准备 > 衔接。
 */
import type { Blocker, BlockerKind, RequestTiming, RunSnapshot, Segment } from '../../shared/run-status/types.ts'

const PRIORITY: Record<BlockerKind, number> = {
  hook: 9,
  'wait-user': 8,
  compaction: 7,
  retry: 6,
  tool: 5,
  'model-output': 4,
  'model-thinking': 4,
  'model-wait': 3,
  prepare: 2,
  between: 1,
}

/** 短于这个时长的段不进「最近」列表，只计入合计；更短的零碎并进相邻的同一条。 */
const RECENT_MIN_MS = 2000
const RECENT_LIMIT = 8
const DETAIL_LIMIT = 400
const REQUEST_LIMIT = 6

interface Activity {
  kind: BlockerKind
  tag: string
  title: string
  detail?: string
  since: number
  plugin?: string
}

interface HookFrame {
  readonly id: number
  readonly plugin: string
  readonly event: string
  readonly kind: BlockerKind
  readonly since: number
  /** 正在等下游（waterfall 的 next）时为 true。 */
  waiting: boolean
  resumeAt: number
}

interface StreamInfo {
  chars: number
  part: 'reasoning' | 'text' | 'tool' | undefined
  toolName?: string
}

interface SessionState {
  running: boolean
  turn?: number | undefined
  step?: number | undefined
  turnStart?: number | undefined
  model?: string | undefined
  partial: boolean
  sawTurnStart: boolean
  /** 这一步的主线：准备、等模型、模型输出、重试、衔接。同时只有一个。 */
  phase?: Activity | undefined
  /** 工具、子调用、压缩，按 id 存。 */
  readonly side: Map<string, Activity>
  readonly hooks: HookFrame[]
  stream?: StreamInfo | undefined
  totals: Partial<Record<BlockerKind, number>>
  recent: Segment[]
  /** 这次模型请求开始的时刻（模型流开始）。 */
  reqStart?: number | undefined
  requests: RequestTiming[]
  /** 界面上这一刻显示的那件事，从何时开始算。合计就按它切分，同一时刻只记一类。 */
  span?: Span | undefined
}

/** 显示口径下正在走的一段。 */
interface Span {
  readonly kind: BlockerKind
  readonly tag: string
  readonly title: string
  readonly since: number
}

/** 宿主事件里本插件用到的形状。 */
export interface SessionEventLike {
  readonly type: string
  readonly time: number
  readonly data?: unknown
}

export type StreamFrameLike =
  | { readonly type: 'start'; readonly turn: number; readonly step: number }
  | { readonly type: 'chunk'; readonly time: number; readonly chunk: { readonly type: string; readonly blockType?: string; readonly text?: string; readonly argumentsDelta?: string; readonly name?: string } }
  | { readonly type: 'end' }

const HOOK_LABEL: Record<string, string> = {
  'agent/pre-step': '每一步开始前',
  'agent/request': '发请求前选模型',
  'agent/request-error': '模型请求失败后',
  'agent/turn-stopping': '这一轮收尾前',
  'system-prompt/assemble': '拼系统提示',
  'tools/pre-execute': '工具执行前',
  'tools/execute': '工具执行外层',
  'tools/post-execute': '工具执行后',
  'tools/ptc-dispatch-log': '记录子调用',
  'compaction/summary-error': '压缩失败后',
  'fs/write-intent': '写文件前',
  'fs/edit-intent': '改文件前',
  'approval/request': '等批准',
  'user-questions/request': '等回答',
}

export function hookLabel(event: string): string {
  return HOOK_LABEL[event] ?? event
}

function clip(text: string, limit = DETAIL_LIMIT): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function parseArgs(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === 'string') {
    try {
      return asRecord(JSON.parse(raw))
    } catch {
      return undefined
    }
  }
  return asRecord(raw)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** 一次工具调用怎么说：标签、标题、补充。 */
export function describeTool(name: string, rawArgs: unknown, inside?: string): Pick<Activity, 'tag' | 'title' | 'detail'> {
  const args = parseArgs(rawArgs)
  const where = inside === undefined ? '' : `${inside} 里`
  const desc = str(args?.description)
  const withDesc = (base: string) => desc === undefined ? base : `${base} · ${desc}`
  switch (name) {
    case 'bash':
    case 'pwsh': {
      const command = str(args?.command)
      const bg = args?.run_in_background === true ? '（后台）' : ''
      return { tag: '命令行', title: withDesc(`${where}在跑命令${bg}`), ...command === undefined ? {} : { detail: clip(command) } }
    }
    case 'run_code':
      return { tag: '工具', title: `在跑 Python 代码${desc === undefined ? '' : ` · ${desc}`}` }
    case 'subagent':
    case 'subagent_fork':
      return { tag: '子代理', title: `${where}等子代理干完`, ...str(args?.task) ?? str(args?.prompt) ? { detail: clip(String(args?.task ?? args?.prompt), 160) } : {} }
    case 'job_output':
      return { tag: '工具', title: `${where}等后台任务输出`, ...str(args?.job_id) ? { detail: String(args?.job_id) } : {} }
    case 'web_fetch':
    case 'web_search':
      return { tag: '联网', title: `${where}在${name === 'web_fetch' ? '抓网页' : '搜网页'}`, detail: clip(String(args?.url ?? JSON.stringify(args?.queries ?? '')), 200) }
    case 'ask_user_question':
      return { tag: '等你', title: '等你回答问题' }
    default: {
      const target = str(args?.file_path) ?? str(args?.path) ?? str(args?.pattern)
      return { tag: '工具', title: withDesc(`${where}在跑工具 ${name}`), ...target === undefined ? {} : { detail: clip(target, 200) } }
    }
  }
}

export class RunTracker {
  private readonly sessions = new Map<string, SessionState>()
  private hookSeq = 0
  /**
   * 记不记模型请求的分段用时。可以传一个现读函数：网关是后来才配置上的话，
   * 下一次请求就能开始记，不用重载插件。
   */
  private readonly trackRequests: boolean | (() => boolean)

  constructor(options: { trackRequests?: boolean | (() => boolean) } = {}) {
    this.trackRequests = options.trackRequests ?? true
  }

  /** 现读是否记录请求分段。 */
  private tracking(): boolean {
    return typeof this.trackRequests === 'function' ? this.trackRequests() : this.trackRequests
  }

  private state(id: string): SessionState {
    let s = this.sessions.get(id)
    if (s === undefined) {
      s = { running: false, partial: false, sawTurnStart: false, side: new Map(), hooks: [], totals: {}, recent: [], requests: [] }
      this.sessions.set(id, s)
    }
    return s
  }

  /**
   * 界面显示的那件事换了：把上一段结掉，从这一刻开始算新的。
   * 合计按界面显示的那一件切分：同一时刻几件事同时成立时只算最具体的那件，所以各行加起来等于这一轮的已用时间。
   */
  private sync(s: SessionState, now: number): void {
    const next = this.blocker(s, now)
    const cur = s.span
    if (next !== null && cur !== undefined && cur.kind === next.kind && cur.title === next.title) return
    this.closeSpan(s, now)
    if (next !== null) s.span = { kind: next.kind, tag: next.tag, title: next.title, since: now }
  }

  private closeSpan(s: SessionState, now: number): void {
    const span = s.span
    s.span = undefined
    if (span === undefined) return
    const ms = now - span.since
    if (ms <= 0) return
    s.totals[span.kind] = (s.totals[span.kind] ?? 0) + ms
    const last = s.recent.at(-1)
    if (last !== undefined && last.kind === span.kind && last.title === span.title) {
      s.recent[s.recent.length - 1] = { ...last, ms: last.ms + ms, end: now, count: (last.count ?? 1) + 1 }
      return
    }
    if (ms < RECENT_MIN_MS) return
    s.recent.push({ kind: span.kind, tag: span.tag, title: span.title, ms, end: now })
    if (s.recent.length > RECENT_LIMIT) s.recent.splice(0, s.recent.length - RECENT_LIMIT)
  }

  private setPhase(s: SessionState, next: Activity | undefined): void {
    s.phase = next
  }

  private endSide(s: SessionState, key: string, now: number): void {
    if (!s.side.delete(key)) return
    this.sync(s, now)
  }

  private touchRunning(s: SessionState): void {
    if (!s.running) {
      s.running = true
      if (!s.sawTurnStart) s.partial = true
    }
  }

  /** agent/status：idle 时清掉所有在做的事。 */
  status(id: string, running: boolean, now: number): void {
    const s = this.state(id)
    if (running) {
      this.touchRunning(s)
      if (s.phase === undefined && s.side.size === 0) s.phase = { kind: 'between', tag: '衔接', title: '准备开始这一轮', since: now }
      this.sync(s, now)
      return
    }
    this.finish(s, now)
  }

  /** 停下：清掉所有在做的事，把正在走的一段结掉。 */
  private finish(s: SessionState, now: number): void {
    s.phase = undefined
    s.side.clear()
    s.hooks.length = 0
    s.stream = undefined
    s.running = false
    this.closeSpan(s, now)
  }

  /** session/event：会话日志新追加的一条。走 magpie 的模型回复会记一次请求并返回它，供去 magpie 找分段用时。 */
  event(id: string, e: SessionEventLike): RequestTiming | undefined {
    const s = this.state(id)
    const now = e.time
    try {
      return this.applyEvent(s, now, e)
    } finally {
      this.sync(s, now)
    }
  }

  private applyEvent(s: SessionState, now: number, e: SessionEventLike): RequestTiming | undefined {
    const d = asRecord(e.data) ?? {}
    switch (e.type) {
      case 'turn/start':
        s.turn = typeof d.turn === 'number' ? d.turn : s.turn
        s.turnStart = now
        this.closeSpan(s, now)
        s.totals = {}
        s.recent = []
        s.partial = false
        s.sawTurnStart = true
        this.touchRunning(s)
        s.phase = { kind: 'between', tag: '衔接', title: '这一轮刚开始', since: now }
        return
      case 'turn/end':
        this.finish(s, now)
        return
      case 'model/selection':
      case 'request/header': {
        const cfg = asRecord(asRecord(d.header)?.config) ?? d
        if (typeof cfg.provider === 'string' && typeof cfg.model === 'string') s.model = `${cfg.provider}/${cfg.model}`
        return
      }
      case 'step/start':
        this.touchRunning(s)
        s.step = typeof d.step === 'number' ? d.step : s.step
        this.setPhase(s, { kind: 'prepare', tag: '准备请求', title: `第 ${s.step ?? '?'} 步：组装上下文、准备发给模型`, since: now })
        return
      case 'step/end':
        this.setPhase(s, { kind: 'between', tag: '衔接', title: `第 ${s.step ?? '?'} 步结束，准备下一步`, since: now })
        return
      case 'llm/retry': {
        const failure = asRecord(d.failure)
        const retry = typeof d.retry === 'number' ? d.retry : '?'
        const max = typeof d.maxRetries === 'number' ? d.maxRetries : '?'
        const delay = typeof d.delayMs === 'number' ? `，等 ${Math.round(d.delayMs / 100) / 10} 秒` : ''
        this.setPhase(s, {
          kind: 'retry', tag: '重试',
          title: `模型请求失败，准备第 ${retry}/${max} 次重试${delay}`,
          ...str(failure?.message) ? { detail: clip(String(failure?.message)) } : {},
          since: now,
        })
        return
      }
      case 'llm/retry-started':
        this.setPhase(s, { kind: 'model-wait', tag: '等模型', title: `重试第 ${String(d.retry ?? '?')} 次：已重新发出请求，等模型开始响应`, since: now })
        return
      case 'tool/call': {
        const name = String(d.name ?? 'tool')
        const callId = String(d.callId ?? `${name}-${now}`)
        s.side.set(`call:${callId}`, { kind: 'tool', ...describeTool(name, d.arguments), since: now })
        return
      }
      case 'tool/result': {
        const callId = str(d.toolCallId) ?? str(asRecord(asRecord(d.message)?.source)?.callId) ?? str(asRecord(d.message)?.toolCallId)
        if (callId !== undefined) this.endSide(s, `call:${callId}`, now)
        return
      }
      case 'tool/ptc-dispatch-start': {
        const name = String(d.name ?? 'tool')
        s.side.set(`sub:${String(d.subCallId)}`, { kind: 'tool', ...describeTool(name, d.arguments, 'run_code'), since: now })
        return
      }
      case 'tool/ptc-dispatch':
        this.endSide(s, `sub:${String(d.subCallId)}`, now)
        return
      case 'compaction/start':
        s.side.set(`compaction:${String(d.compactionId)}`, { kind: 'compaction', tag: '压缩', title: '在压缩上下文（让模型写摘要）', since: now })
        return
      case 'compaction/end':
        this.endSide(s, `compaction:${String(d.compactionId)}`, now)
        return
      case 'assistant/message':
        return this.request(s, d, now)
      default:
    }
  }

  private request(s: SessionState, d: Record<string, unknown>, now: number): RequestTiming | undefined {
    if (!this.tracking()) {
      s.reqStart = undefined
      return undefined
    }
    const source = asRecord(asRecord(d.message)?.source)
    const responseId = str(asRecord(asRecord(source?.replayState)?.response)?.responseId)
    const start = s.reqStart
    s.reqStart = undefined
    if (!str(source?.provider)?.startsWith('magpie') || responseId === undefined || start === undefined) return undefined
    const step = typeof d.step === 'number' ? d.step : s.step
    const model = str(source?.model)
    const entry: RequestTiming = { responseId, ...step === undefined ? {} : { step }, ...model === undefined ? {} : { model }, totalMs: Math.max(0, now - start), end: now, state: 'pending' }
    s.requests.push(entry)
    if (s.requests.length > REQUEST_LIMIT) s.requests.splice(0, s.requests.length - REQUEST_LIMIT)
    return entry
  }

  /** magpie 那边找到（或确定找不到）这次请求的记录后，补上分段用时。 */
  resolveRequest(id: string, responseId: string, patch: Partial<RequestTiming>): void {
    const list = this.sessions.get(id)?.requests
    const i = list?.findIndex((r) => r.responseId === responseId) ?? -1
    if (list !== undefined && i >= 0) list[i] = { ...list[i]!, ...patch, responseId }
  }

  /** agent/assistant-stream：模型流的开始、片段、结束。 */
  stream(id: string, frame: StreamFrameLike, now: number): void {
    const s = this.state(id)
    try {
      this.applyStream(s, frame, now)
    } finally {
      this.sync(s, now)
    }
  }

  private applyStream(s: SessionState, frame: StreamFrameLike, now: number): void {
    if (frame.type === 'start') {
      this.touchRunning(s)
      s.reqStart = now
      s.stream = { chars: 0, part: undefined }
      this.setPhase(s, { kind: 'model-wait', tag: '等模型', title: '请求已发出，等模型开始响应', since: now })
      return
    }
    if (frame.type === 'end') {
      s.stream = undefined
      this.setPhase(s, { kind: 'between', tag: '衔接', title: '模型回完了，正在处理它的回复', since: now })
      return
    }
    const st = s.stream ?? (s.stream = { chars: 0, part: undefined })
    const c = frame.chunk
    if (c.type === 'block-start' && c.blockType === 'reasoning') {
      st.part = 'reasoning'
      if (s.phase?.kind !== 'model-thinking') {
        this.setPhase(s, { kind: 'model-thinking', tag: '思考', title: '模型正在思考', detail: '已收到思考开始通知，上游暂未提供可展示的思考文字', since: frame.time })
      }
      return
    }
    let part: StreamInfo['part']
    let size = 0
    if (c.type === 'reasoning-delta') {
      if (s.phase?.kind === 'model-thinking' && !c.text?.trim()) return
      part = 'reasoning'
      size = c.text?.length ?? 0
    }
    else if (c.type === 'text-delta') { part = 'text'; size = c.text?.length ?? 0 }
    else if (c.type === 'tool-call-delta') {
      part = 'tool'
      size = c.argumentsDelta?.length ?? 0
      if (c.name !== undefined) st.toolName = c.name
    } else return
    st.chars += size
    const what = part === 'reasoning' ? '在思考' : part === 'text' ? '在写回复' : `在写工具调用${st.toolName === undefined ? '' : ` ${st.toolName}`}`
    const title = `模型${what}`
    if (s.phase?.kind === 'model-output' && s.phase.title === title) {
      s.phase.detail = `已输出约 ${st.chars} 字`
      return
    }
    st.part = part
    this.setPhase(s, { kind: 'model-output', tag: '模型输出', title, detail: `已输出约 ${st.chars} 字`, since: frame.time })
  }

  /** 某个插件的钩子开始处理。返回句柄，用来标记等下游和结束。 */
  hookStart(id: string, plugin: string, event: string, now: number): number {
    const s = this.state(id)
    const kind: BlockerKind = event === 'approval/request' || event === 'user-questions/request' ? 'wait-user' : 'hook'
    const frame: HookFrame = { id: ++this.hookSeq, plugin, event, kind, since: now, waiting: false, resumeAt: now }
    s.hooks.push(frame)
    this.touchRunning(s)
    this.sync(s, now)
    return frame.id
  }

  private frame(id: string, handle: number): [SessionState, HookFrame] | undefined {
    const s = this.sessions.get(id)
    const f = s?.hooks.find((h) => h.id === handle)
    return s === undefined || f === undefined ? undefined : [s, f]
  }

  /** 钩子把控制权交给下游（调了 next）。 */
  hookWait(id: string, handle: number, now: number): void {
    const hit = this.frame(id, handle)
    if (hit === undefined || hit[1].waiting) return
    hit[1].waiting = true
    this.sync(hit[0], now)
  }

  /** 下游返回，钩子接着跑。 */
  hookResume(id: string, handle: number, now: number): void {
    const hit = this.frame(id, handle)
    if (hit === undefined || !hit[1].waiting) return
    hit[1].waiting = false
    hit[1].resumeAt = now
    this.sync(hit[0], now)
  }

  hookEnd(id: string, handle: number, now: number): void {
    const hit = this.frame(id, handle)
    if (hit === undefined) return
    const [s, f] = hit
    s.hooks.splice(s.hooks.indexOf(f), 1)
    this.sync(s, now)
  }

  private blocker(s: SessionState, now: number): Blocker | null {
    if (!s.running) return null
    const candidates: Activity[] = []
    for (const h of s.hooks) {
      if (h.waiting) continue
      candidates.push(h.kind === 'hook'
        ? { kind: 'hook', tag: '钩子', title: `插件 ${h.plugin} 在处理「${hookLabel(h.event)}」`, since: h.resumeAt, plugin: h.plugin }
        : { kind: 'wait-user', tag: '等你', title: h.event === 'approval/request' ? '等你批准这次操作' : '等你回答问题', since: h.since, plugin: h.plugin })
    }
    candidates.push(...s.side.values())
    if (s.phase !== undefined) candidates.push(s.phase)
    let best: Activity | undefined
    for (const a of candidates) {
      if (best === undefined || PRIORITY[a.kind] > PRIORITY[best.kind] || (PRIORITY[a.kind] === PRIORITY[best.kind] && a.since > best.since)) best = a
    }
    if (best === undefined) return { kind: 'between', tag: '衔接', title: '在跑，但还没收到这一步的任何动静', since: now }
    return { ...best }
  }

  snapshot(id: string, now: number): RunSnapshot {
    const s = this.sessions.get(id)
    if (s === undefined) return { sessionId: id, now, running: false, blocker: null, totals: {}, recent: [], partial: false }
    return {
      sessionId: id,
      now,
      running: s.running,
      ...s.turn === undefined ? {} : { turn: s.turn },
      ...s.step === undefined ? {} : { step: s.step },
      ...s.turnStart === undefined ? {} : { turnStart: s.turnStart },
      ...s.model === undefined ? {} : { model: s.model },
      blocker: this.blocker(s, now),
      totals: { ...s.totals },
      ...s.span === undefined ? {} : { current: { kind: s.span.kind, since: s.span.since } },
      recent: [...s.recent],
      partial: s.partial,
      ...s.requests.length === 0 ? {} : { requests: [...s.requests] },
    }
  }

  runningIds(): string[] {
    return [...this.sessions].filter(([, s]) => s.running).map(([id]) => id)
  }

  forget(id: string): void {
    this.sessions.delete(id)
  }
}
