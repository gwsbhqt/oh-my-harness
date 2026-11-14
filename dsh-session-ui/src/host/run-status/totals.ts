/**
 * 整段会话的统计：从会话日志折出来，登记成宿主的会话投影（key `runStatusTotals`），
 * 网页半用 `useProjection` 读。宿主自带的「会话统计」有三处会误导人，这里换口径：
 *
 * - 墙上时间拆成「在干活、等后台通知、等你回复、长时间空闲」：自带的只算模型和工具，
 *   一轮结束到下一轮开始之间的等待全不见了。
 * - 按模型分开：中途换模型时，混成一个平均数看不出速度换了一档。
 * - 输出速度用「输出词数 ÷ 这一步模型总用时」：自带的分母从第一个可见字算起，
 *   分子却含看不见的思考词数，会把速度夸大几倍。
 * - 思考加首字等待、每步用时给中位数：平均数会被几次特别长的拖偏。
 *
 * 只读日志，不改任何事件。纯函数，测试拿真实会话日志回放。
 *
 * @module dsh-run-status/totals
 */

export const TOTALS_KEY = 'runStatusTotals'
/** 两轮之间空了这么久，就不算「等」，算离开了。 */
export const IDLE_MS = 30 * 60_000

type AnyRecord = Record<string, unknown>
const rec = (v: unknown): AnyRecord | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as AnyRecord : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)

/** 按整秒分桶的计数：键是秒数，值是步数。存中位数要用，又不能把每一步都存下来。 */
export type Histogram = Record<string, number>

export interface ModelTotals {
  readonly model: string
  readonly steps: number
  /** 每步「开始」到「回复写进日志」之和，和宿主自带的模型用时同口径。 */
  readonly llmMs: number
  readonly outputTokens: number
  /** 报了输出词数的那些步的模型用时，算速度用，分子分母对得上。 */
  readonly tokenMs: number
  readonly stepHist: Histogram
  readonly ttftHist: Histogram
}

/** 一段连续时间里的输出速度：分子是输出 token 数，分母是报了输出数的那些步的模型用时。 */
export interface SpeedTotals {
  readonly model: string
  readonly steps: number
  readonly outputTokens: number
  readonly tokenMs: number
}

/** 最近一轮（正在跑的一轮有步数了就算它）。 */
export interface TurnSpeed extends SpeedTotals {
  readonly turn: number
  readonly ttftHist: Histogram
}

/** 从最后一次换模型起（没换过就是整个会话），首字等待也按这一段算。 */
export interface SegmentSpeed extends SpeedTotals {
  /** 这一段第一步所在的轮次。 */
  readonly sinceTurn: number
  readonly ttftHist: Histogram
}

export interface TotalsState {
  readonly turns: number
  readonly steps: number
  readonly lastTurn: number | null
  /** 已结束的轮次从开始到结束之和。 */
  readonly runMs: number
  readonly runningSince: number | null
  readonly lastTurnEnd: number | null
  /** 本轮开始前空了多久，等第一步结束时看有没有人发消息再归类。 */
  readonly pendingGap: { readonly ms: number; readonly user: boolean } | null
  readonly waitUserMs: number
  readonly waitNoticeMs: number
  readonly idleMs: number
  readonly toolMs: number
  readonly compactionMs: number
  readonly model: string | null
  readonly models: readonly ModelTotals[]
  readonly lastTurnSpeed: TurnSpeed | null
  readonly segment: SegmentSpeed | null
  readonly openStep: { readonly turn: number; readonly step: number; readonly start: number; readonly firstToken: number | null } | null
  readonly pendingCalls: Readonly<Record<string, number>>
  readonly openCompactions: Readonly<Record<string, number>>
}

export interface ModelView {
  readonly model: string
  readonly steps: number
  readonly llmMs: number
  readonly outputTokens: number
  readonly tokenMs: number
  /** 每步用时的中位数，整秒。 */
  readonly medianStepMs: number | null
  /** 「这一步开始」到「第一个可见字」的中位数，整秒；含模型不显示的思考。 */
  readonly medianTtftMs: number | null
}

export interface SpeedView {
  readonly model: string
  readonly steps: number
  readonly outputTokens: number
  readonly tokenMs: number
}

export interface TotalsView {
  readonly turns: number
  readonly steps: number
  readonly runMs: number
  readonly runningSince: number | null
  readonly waitUserMs: number
  readonly waitNoticeMs: number
  readonly idleMs: number
  readonly llmMs: number
  readonly toolMs: number
  readonly compactionMs: number
  readonly model: string | null
  readonly models: readonly ModelView[]
  /** 当前速度：最近一轮。 */
  readonly current: (SpeedView & { readonly turn: number; readonly medianTtftMs: number | null }) | null
  /** 平均速度：从最后一次换模型起；`switched` 为假表示会话里没换过模型，就是整个会话的平均。 */
  readonly average: (SpeedView & { readonly sinceTurn: number; readonly switched: boolean; readonly medianTtftMs: number | null }) | null
}

export interface TotalsEvent {
  readonly type: string
  readonly time: number
  readonly data?: unknown
}

export function initTotals(): TotalsState {
  return {
    turns: 0,
    steps: 0,
    lastTurn: null,
    runMs: 0,
    runningSince: null,
    lastTurnEnd: null,
    pendingGap: null,
    waitUserMs: 0,
    waitNoticeMs: 0,
    idleMs: 0,
    toolMs: 0,
    compactionMs: 0,
    model: null,
    models: [],
    lastTurnSpeed: null,
    segment: null,
    openStep: null,
    pendingCalls: {},
    openCompactions: {},
  }
}

/** 第一个可见字的时刻，和宿主判定首字的规则一致：非空的文字、思考或工具调用片段。 */
export function firstTokenTime(stream: unknown): number | undefined {
  if (!Array.isArray(stream)) return undefined
  for (const raw of stream) {
    const r = rec(raw)
    if (r === undefined) continue
    if (r.type === 'chunk') {
      const chunk = rec(r.chunk)
      const t = num(r.time)
      if (chunk === undefined || t === undefined) continue
      if ((chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') && str(chunk.text) !== undefined) return t
      if (chunk.type === 'tool-call-delta' && (str(chunk.argumentsDelta) !== undefined || chunk.name !== undefined)) return t
      continue
    }
    const t0 = num(r.time0)
    if (t0 === undefined) continue
    if (r.type === 'tool-call-chunks' && r.name !== undefined) return t0
    const parts = r.type === 'tool-call-chunks' ? r.args : r.texts
    if (!Array.isArray(parts)) continue
    const dt = Array.isArray(r.dt) ? r.dt : []
    let t = t0
    for (let i = 0; i < parts.length; i += 1) {
      if (i > 0) t += num(dt[i - 1]) ?? 0
      if (typeof parts[i] === 'string' && parts[i] !== '') return t
    }
  }
  return undefined
}

function modelName(provider: unknown, model: unknown): string | null {
  const m = str(model)
  if (m === undefined) return null
  const p = str(provider)
  return p === undefined ? m : `${p}/${m}`
}

function bump(hist: Histogram, ms: number): Histogram {
  const key = String(Math.max(0, Math.round(ms / 1000)))
  return { ...hist, [key]: (hist[key] ?? 0) + 1 }
}

/** 分桶计数的中位数（整秒，毫秒表示）；没有数据时为 null。 */
export function histMedian(hist: Histogram): number | null {
  const entries = Object.entries(hist).map(([k, n]) => [Number(k), n] as const).sort((a, b) => a[0] - b[0])
  const total = entries.reduce((sum, [, n]) => sum + n, 0)
  if (total === 0) return null
  let seen = 0
  for (const [sec, n] of entries) {
    seen += n
    if (seen * 2 >= total) return sec * 1000
  }
  return null
}

function settleGap(state: TotalsState): TotalsState {
  const gap = state.pendingGap
  if (gap === null) return state
  if (gap.ms >= IDLE_MS) return { ...state, pendingGap: null, idleMs: state.idleMs + gap.ms }
  if (gap.user) return { ...state, pendingGap: null, waitUserMs: state.waitUserMs + gap.ms }
  return { ...state, pendingGap: null, waitNoticeMs: state.waitNoticeMs + gap.ms }
}

function withoutKey<T>(map: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const next: Record<string, T> = {}
  for (const [k, v] of Object.entries(map)) if (k !== key) next[k] = v
  return next
}

/** 折一条会话事件；和统计无关的事件原样返回同一个对象。 */
export function applyTotals(state: TotalsState, event: TotalsEvent): TotalsState {
  const data = rec(event.data) ?? {}
  const time = event.time
  switch (event.type) {
    case 'model/selection': {
      const model = modelName(data.provider, data.model)
      return model === null || model === state.model ? state : { ...state, model }
    }
    case 'request/header': {
      const config = rec(rec(data.header)?.config)
      const model = modelName(config?.provider, config?.model)
      return model === null || model === state.model ? state : { ...state, model }
    }
    case 'turn/start': {
      // 上一轮没写结束（宿主中途退出）时，不知道它跑到几点，空档也就不算。
      const settled = settleGap(state)
      const gap = settled.runningSince === null && settled.lastTurnEnd !== null ? Math.max(0, time - settled.lastTurnEnd) : null
      return { ...settled, runningSince: time, pendingGap: gap === null ? null : { ms: gap, user: false } }
    }
    case 'user/message': {
      if (state.pendingGap === null || state.pendingGap.user) return state
      return rec(data.source)?.kind === 'user' ? { ...state, pendingGap: { ...state.pendingGap, user: true } } : state
    }
    case 'step/start': {
      const turn = num(data.turn)
      const step = num(data.step)
      if (turn === undefined || step === undefined) return state
      return { ...state, openStep: { turn, step, start: time, firstToken: null } }
    }
    case 'assistant/attempt': {
      const open = state.openStep
      if (open === null || open.firstToken !== null || open.turn !== data.turn || open.step !== data.step) return state
      const first = firstTokenTime(data.stream)
      return first === undefined ? state : { ...state, openStep: { ...open, firstToken: first } }
    }
    case 'assistant/message': {
      const open = state.openStep
      if (open === null || open.turn !== data.turn || open.step !== data.step) return state
      const first = open.firstToken ?? firstTokenTime(data.stream) ?? null
      const llm = Math.max(0, time - open.start)
      const out = num(rec(data.usage)?.outputTokens)
      const name = state.model ?? '未知模型'
      const index = state.models.findIndex((m) => m.model === name)
      const prev: ModelTotals = index >= 0 ? state.models[index]! : { model: name, steps: 0, llmMs: 0, outputTokens: 0, tokenMs: 0, stepHist: {}, ttftHist: {} }
      const next: ModelTotals = {
        model: name,
        steps: prev.steps + 1,
        llmMs: prev.llmMs + llm,
        outputTokens: prev.outputTokens + (out ?? 0),
        tokenMs: prev.tokenMs + (out === undefined ? 0 : llm),
        stepHist: bump(prev.stepHist, llm),
        ttftHist: first === null ? prev.ttftHist : bump(prev.ttftHist, Math.max(0, first - open.start)),
      }
      const models = index >= 0 ? state.models.map((m, i) => (i === index ? next : m)) : [...state.models, next]
      const tokens = out ?? 0
      const ms = out === undefined ? 0 : llm
      const ttft = first === null ? null : Math.max(0, first - open.start)
      const seg = state.segment !== null && state.segment.model === name
        ? state.segment
        : { model: name, steps: 0, outputTokens: 0, tokenMs: 0, sinceTurn: open.turn, ttftHist: {} }
      const segment: SegmentSpeed = {
        ...seg,
        steps: seg.steps + 1,
        outputTokens: seg.outputTokens + tokens,
        tokenMs: seg.tokenMs + ms,
        ttftHist: ttft === null ? seg.ttftHist : bump(seg.ttftHist, ttft),
      }
      // 一轮里中途换了模型，就从换后的第一步重新算这一轮
      const cur = state.lastTurnSpeed !== null && state.lastTurnSpeed.turn === open.turn && state.lastTurnSpeed.model === name
        ? state.lastTurnSpeed
        : { turn: open.turn, model: name, steps: 0, outputTokens: 0, tokenMs: 0, ttftHist: {} }
      const lastTurnSpeed: TurnSpeed = {
        ...cur,
        steps: cur.steps + 1,
        outputTokens: cur.outputTokens + tokens,
        tokenMs: cur.tokenMs + ms,
        ttftHist: ttft === null ? cur.ttftHist : bump(cur.ttftHist, ttft),
      }
      return { ...state, models, segment, lastTurnSpeed, openStep: null }
    }
    case 'step/end': {
      const turn = num(data.turn)
      const settled = settleGap(state)
      return {
        ...settled,
        steps: settled.steps + 1,
        turns: turn !== undefined && settled.lastTurn === turn ? settled.turns : settled.turns + 1,
        lastTurn: turn ?? settled.lastTurn,
        openStep: null,
      }
    }
    case 'turn/end': {
      const settled = settleGap(state)
      const ran = settled.runningSince === null ? 0 : Math.max(0, time - settled.runningSince)
      return { ...settled, runMs: settled.runMs + ran, runningSince: null, lastTurnEnd: time, pendingCalls: {}, openStep: null }
    }
    case 'tool/call': {
      const id = str(data.callId)
      return id === undefined ? state : { ...state, pendingCalls: { ...state.pendingCalls, [id]: time } }
    }
    case 'tool/result': {
      const id = str(rec(rec(data.message)?.source)?.callId)
      if (id === undefined || !Object.hasOwn(state.pendingCalls, id)) return state
      return { ...state, toolMs: state.toolMs + Math.max(0, time - state.pendingCalls[id]!), pendingCalls: withoutKey(state.pendingCalls, id) }
    }
    case 'compaction/start': {
      const id = str(data.compactionId)
      return id === undefined ? state : { ...state, openCompactions: { ...state.openCompactions, [id]: time } }
    }
    case 'compaction/end': {
      const id = str(data.compactionId)
      if (id === undefined || !Object.hasOwn(state.openCompactions, id)) return state
      return { ...state, compactionMs: state.compactionMs + Math.max(0, time - state.openCompactions[id]!), openCompactions: withoutKey(state.openCompactions, id) }
    }
    default:
      return state
  }
}

let lastView: { key: string; view: TotalsView } | undefined

/** 视图内容没变就交回上一个对象：宿主按引用判断要不要推给网页，每步开头那种只动内部状态的事件就不会多推一次。 */
export function viewTotals(state: TotalsState): TotalsView {
  const view = buildView(state)
  const key = JSON.stringify(view)
  if (lastView?.key === key) return lastView.view
  lastView = { key, view }
  return view
}

function buildView(state: TotalsState): TotalsView {
  return {
    turns: state.turns,
    steps: state.steps,
    runMs: state.runMs,
    runningSince: state.runningSince,
    waitUserMs: state.waitUserMs,
    waitNoticeMs: state.waitNoticeMs,
    idleMs: state.idleMs,
    llmMs: state.models.reduce((sum, m) => sum + m.llmMs, 0),
    toolMs: state.toolMs,
    compactionMs: state.compactionMs,
    model: state.model,
    models: state.models.map((m) => ({
      model: m.model,
      steps: m.steps,
      llmMs: m.llmMs,
      outputTokens: m.outputTokens,
      tokenMs: m.tokenMs,
      medianStepMs: histMedian(m.stepHist),
      medianTtftMs: histMedian(m.ttftHist),
    })),
    current: state.lastTurnSpeed === null
      ? null
      : {
          model: state.lastTurnSpeed.model,
          steps: state.lastTurnSpeed.steps,
          outputTokens: state.lastTurnSpeed.outputTokens,
          tokenMs: state.lastTurnSpeed.tokenMs,
          turn: state.lastTurnSpeed.turn,
          medianTtftMs: histMedian(state.lastTurnSpeed.ttftHist),
        },
    average: state.segment === null
      ? null
      : {
          model: state.segment.model,
          steps: state.segment.steps,
          outputTokens: state.segment.outputTokens,
          tokenMs: state.segment.tokenMs,
          sinceTurn: state.segment.sinceTurn,
          switched: state.models.length > 1,
          medianTtftMs: histMedian(state.segment.ttftHist),
        },
  }
}

const isNum = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)
const isNumOrNull = (v: unknown): boolean => v === null || isNum(v)
const isStrOrNull = (v: unknown): boolean => v === null || typeof v === 'string'
const isNumMap = (v: unknown): boolean => rec(v) !== undefined && Object.values(rec(v)!).every(isNum)

function fail(what: string): never {
  throw new Error(`${TOTALS_KEY}: ${what} 形状不对`)
}

/** 宿主只调 `parse`：读缓存行时校验状态，发给网页前校验视图。不对就抛错，不猜。 */
export const totalsStateSchema = {
  parse(value: unknown): TotalsState {
    const s = rec(value) ?? fail('状态')
    for (const k of ['turns', 'steps', 'runMs', 'waitUserMs', 'waitNoticeMs', 'idleMs', 'toolMs', 'compactionMs']) if (!isNum(s[k])) fail(k)
    for (const k of ['lastTurn', 'runningSince', 'lastTurnEnd']) if (!isNumOrNull(s[k])) fail(k)
    if (!isStrOrNull(s.model)) fail('model')
    if (!isNumMap(s.pendingCalls) || !isNumMap(s.openCompactions)) fail('pending')
    if (s.pendingGap !== null && (rec(s.pendingGap) === undefined || !isNum(rec(s.pendingGap)!.ms) || typeof rec(s.pendingGap)!.user !== 'boolean')) fail('pendingGap')
    if (s.openStep !== null) {
      const o = rec(s.openStep) ?? fail('openStep')
      if (!isNum(o.turn) || !isNum(o.step) || !isNum(o.start) || !isNumOrNull(o.firstToken)) fail('openStep')
    }
    if (!Array.isArray(s.models)) fail('models')
    for (const raw of s.models) {
      const m = rec(raw) ?? fail('models')
      if (typeof m.model !== 'string' || !isNum(m.steps) || !isNum(m.llmMs) || !isNum(m.outputTokens) || !isNum(m.tokenMs) || !isNumMap(m.stepHist) || !isNumMap(m.ttftHist)) fail('models')
    }
    for (const [k, extra] of [['lastTurnSpeed', 'turn'], ['segment', 'sinceTurn']] as const) {
      if (s[k] === null) continue
      const sp = rec(s[k]) ?? fail(k)
      if (typeof sp.model !== 'string' || !isNum(sp.steps) || !isNum(sp.outputTokens) || !isNum(sp.tokenMs) || !isNum(sp[extra])) fail(k)
      if (!isNumMap(sp.ttftHist)) fail(k)
    }
    return value as TotalsState
  },
}

export const totalsViewSchema = {
  parse(value: unknown): TotalsView {
    const v = rec(value) ?? fail('视图')
    for (const k of ['turns', 'steps', 'runMs', 'waitUserMs', 'waitNoticeMs', 'idleMs', 'llmMs', 'toolMs', 'compactionMs']) if (!isNum(v[k])) fail(k)
    if (!isNumOrNull(v.runningSince) || !isStrOrNull(v.model) || !Array.isArray(v.models)) fail('视图')
    if (v.current !== null && rec(v.current) === undefined) fail('current')
    if (v.average !== null && rec(v.average) === undefined) fail('average')
    return value as TotalsView
  },
}

/** 交给 `ctx.sessionProjections.register` 的定义。 */
export const totalsProjection = {
  key: TOTALS_KEY,
  // 2：加了当前速度和换模型后的平均速度，旧检查点要重新从日志折
  stateVersion: 3,
  stateSchema: totalsStateSchema,
  init: () => initTotals(),
  apply: (state: TotalsState, event: TotalsEvent) => applyTotals(state, event),
  wire: { viewSchema: totalsViewSchema, view: viewTotals, summary: false },
}
