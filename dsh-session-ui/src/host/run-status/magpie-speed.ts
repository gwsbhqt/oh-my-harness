import type { GatewayRequestSpeed, GatewaySpeed } from '../../shared/run-status/types.ts'
import type { ResolvedMagpieGateway } from './magpie-gateway.ts'

const WINDOW_LIMIT = 60
const RECENT_COUNT = 3
const REFRESH_MS = 3000

/** GET /v1/magpie/trace 中参与路由页统计的字段。 */
interface Route {
  id: number
  seq?: number
  time?: string
  agent?: string
  session?: string
  parentSession?: string
  done?: boolean
  status?: number
  tries?: { done?: boolean; status?: number; fail?: string }[]
  out?: number
  ms?: number
  ttft?: number
  firstText?: number
  firstReasoning?: number
  reasoning?: number
  reasoningHidden?: boolean
  flow?: number
  usage?: { reasoning?: number }[]
}

interface Sample { tokens: number; ms: number }

function measured(r: Route, reasoning: number): Sample | undefined {
  const { out = 0, ms = 0, ttft = 0, firstText = 0, firstReasoning = 0, flow = 0 } = r
  if (ttft <= 0 || (r.reasoningHidden && firstText <= 0 && firstReasoning <= 0)) return
  let tokens = out
  let start = ttft
  if (reasoning > 0 && firstReasoning <= 0) {
    if (firstText <= 0) return
    tokens -= reasoning
    start = firstText
  } else if (reasoning > out) return
  else if (firstReasoning > 0) start = Math.min(start, firstReasoning)

  const duration = ms - start
  const answerMs = ms - (reasoning > 0 && firstText > 0 ? firstText : ttft)
  // Magpie 的 DecodeOf 排除集中送达的回复，只有能观察到生成过程的时间窗才进入平均。
  if (!(tokens > 0 && duration >= 100 && tokens * 1000 <= 10_000 * duration)) return
  if (flow > 0 && flow * 4 < answerMs) return
  if (duration < 1000 && start > 4 * duration) return
  if (reasoning > 0 && firstText > 0 && (out - reasoning) * (firstText - ttft) > 20 * reasoning * answerMs) return
  return { tokens, ms: duration }
}

function lowerBound(r: Route, reasoning: number): Sample | undefined {
  const { out = 0, ms = 0, ttft = 0, firstText = 0, flow = 0 } = r
  const answer = out - reasoning
  const afterFirst = ms - ttft
  if (ttft > 0 && reasoning > 0 && firstText <= 0 && answer >= 100 && afterFirst >= 1000
    && answer * 1000 <= 10_000 * afterFirst && !(flow > 0 && flow * 4 < afterFirst)) {
    return { tokens: answer, ms: afterFirst }
  }
  if (out >= 1000 && ms >= 1000 && out * 1000 <= 10_000 * ms) return { tokens: out, ms }
}

function requestSpeed(r: Route): { kind: GatewayRequestSpeed['kind']; sample?: Sample } {
  if (!r.done) return { kind: 'running' }
  const tries = r.tries ?? []
  const answered = !tries.length || tries.some(t => t.done && typeof t.status === 'number' && t.status < 400 && !t.fail)
  if (typeof r.status !== 'number' || r.status >= 400 || !answered) return { kind: 'unanswered' }
  const reasoning = r.reasoning ?? r.usage?.at(-1)?.reasoning ?? 0
  const metrics = [r.out, r.ms, r.ttft, r.firstText, r.firstReasoning, r.flow, reasoning]
  if (metrics.some(n => n != null && (!Number.isSafeInteger(n) || n < 0))) return { kind: 'unmeasured' }
  const decoded = measured(r, reasoning)
  if (decoded) return { kind: 'measured', sample: decoded }
  const floor = lowerBound(r, reasoning)
  return floor ? { kind: 'floor', sample: floor } : { kind: 'unmeasured' }
}

interface SessionSamples {
  requests: number
  completed: number
  measured: number
  floors: number
  tokens: number
  ms: number
  recent: GatewayRequestSpeed[]
}

interface TraceWindow { size: number; sessions: Map<string, SessionSamples> }

const emptySamples = (): SessionSamples => ({ requests: 0, completed: 0, measured: 0, floors: 0, tokens: 0, ms: 0, recent: [] })

/** 先圈定全网关最近的路由，再按会话分组。一个路由在重试和流式更新后仍只占一行。 */
export function traceWindow(value: unknown): TraceWindow {
  const trace = value as { object?: unknown; ids?: unknown; routes?: unknown } | null
  if (trace?.object !== 'trace' || !Array.isArray(trace.ids) || !trace.ids.every(Number.isSafeInteger) || !Array.isArray(trace.routes)) {
    throw new Error('Magpie 未返回完整的路由窗口')
  }
  const latest = new Map<number, Route>()
  for (const r of trace.routes as Route[]) {
    if (!r || !Number.isSafeInteger(r.id)) throw new Error('Magpie 路由缺少编号')
    const prev = latest.get(r.id)
    if (!prev || (r.seq ?? 0) >= (prev.seq ?? 0)) latest.set(r.id, r)
  }
  const ids = [...new Set<number>(trace.ids)].sort((a, b) => b - a).slice(0, WINDOW_LIMIT)
  const sessions = new Map<string, SessionSamples>()
  for (const id of ids) {
    const r = latest.get(id)
    if (r === undefined) throw new Error('Magpie 路由窗口缺行')
    const session = r.parentSession || r.session
    if (r.agent !== 'dsh' || !session) continue
    const s = sessions.get(session) ?? emptySamples()
    sessions.set(session, s)
    const { kind, sample } = requestSpeed(r)
    s.requests++
    if (r.done) s.completed++
    if (kind === 'measured' && sample) {
      s.measured++
      s.tokens += sample.tokens
      s.ms += sample.ms
    }
    if (kind === 'floor') s.floors++
    if (s.recent.length < RECENT_COUNT) {
      const time = Date.parse(r.time ?? '')
      s.recent.push({ kind, time: Number.isFinite(time) ? time : null, ...sample && { tps: Math.round(sample.tokens * 1000 / sample.ms) } })
    }
  }
  return { size: ids.length, sessions }
}

export function sessionSpeed(window: TraceWindow, session: string): GatewaySpeed {
  const s = window.sessions.get(session) ?? emptySamples()
  return {
    state: 'ready', windowSize: window.size, requests: s.requests, completed: s.completed, measured: s.measured,
    floors: s.floors, tps: s.ms > 0 ? Math.round(s.tokens * 1000 / s.ms) : null, recent: s.recent,
  }
}

/** 同一网关的多个统计卡共用一次读取。缓存里只留各会话的统计，不保留路由原文。 */
export function gatewaySpeeds(read: (gateway: ResolvedMagpieGateway) => Promise<unknown>, now = Date.now) {
  let cache: { base: string; ref: string; expires: number; result: Promise<TraceWindow | undefined> } | undefined
  return async (gateway: ResolvedMagpieGateway | undefined, session: string): Promise<GatewaySpeed> => {
    if (!gateway) {
      cache = undefined
      return { state: 'unconfigured' }
    }
    const { magpieBaseUrl: base, magpieKeyRef: ref } = gateway
    if (!cache || cache.base !== base || cache.ref !== ref || now() >= cache.expires) {
      const entry = { base, ref, expires: Infinity, result: read(gateway).then(traceWindow).catch(() => undefined) }
      cache = entry
      void entry.result.then(() => { entry.expires = now() + REFRESH_MS })
    }
    const window = await cache.result
    return window ? sessionSpeed(window, session) : { state: 'unavailable' }
  }
}
