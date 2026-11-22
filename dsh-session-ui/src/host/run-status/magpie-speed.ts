import type { GatewaySpeed } from '../../shared/run-status/types.ts'
import type { ResolvedMagpieGateway } from './magpie-gateway.ts'

const WINDOW_LIMIT = 60
const REFRESH_MS = 3000

/** GET /v1/magpie/trace 中参与路由页统计的字段。 */
interface Route {
  id: number
  seq?: number
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

function answered(r: Route): boolean {
  if (!r.done || typeof r.status !== 'number' || r.status >= 400) return false
  const tries = r.tries ?? []
  return tries.length === 0 || tries.some(t => t.done && typeof t.status === 'number' && t.status < 400 && !t.fail)
}

function requestSample(r: Route): Sample | undefined {
  const reasoning = r.reasoning ?? r.usage?.at(-1)?.reasoning ?? 0
  const metrics = [r.out, r.ms, r.ttft, r.firstText, r.firstReasoning, r.flow, reasoning]
  if (metrics.some(n => n != null && (!Number.isSafeInteger(n) || n < 0))) return
  return measured(r, reasoning)
}

interface SessionSample extends Sample {
  latestTps: number | null
  waits: number[]
}

type TraceWindow = Map<string, SessionSample>

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
  const sessions: TraceWindow = new Map()
  for (const id of ids) {
    const r = latest.get(id)
    if (r === undefined) throw new Error('Magpie 路由窗口缺行')
    const session = r.parentSession || r.session
    if (r.agent !== 'dsh' || !session || !answered(r)) continue
    const total = sessions.get(session) ?? { tokens: 0, ms: 0, latestTps: null, waits: [] }
    if (r.ttft !== undefined && Number.isSafeInteger(r.ttft) && r.ttft > 0) total.waits.push(r.ttft)
    const sample = requestSample(r)
    if (sample) {
      total.latestTps ??= Math.round(sample.tokens * 1000 / sample.ms)
      total.tokens += sample.tokens
      total.ms += sample.ms
    }
    sessions.set(session, total)
  }
  return sessions
}

export function sessionSpeed(window: TraceWindow, session: string): GatewaySpeed {
  const sample = window.get(session)
  const waits = sample?.waits.toSorted((a, b) => a - b) ?? []
  const middle = Math.floor(waits.length / 2)
  const firstTokenMs = waits.length === 0 ? null : (waits[middle]! + waits[Math.floor((waits.length - 1) / 2)]!) / 2
  return {
    state: 'ready',
    tps: sample?.ms ? Math.round(sample.tokens * 1000 / sample.ms) : null,
    latestTps: sample?.latestTps ?? null,
    firstTokenMs,
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
      const expires = now() + REFRESH_MS
      const entry = { base, ref, expires: Infinity, result: read(gateway).then(traceWindow).catch(() => undefined) }
      cache = entry
      void entry.result.then(() => { entry.expires = expires })
    }
    const window = await cache.result
    return window ? sessionSpeed(window, session) : { state: 'unavailable' }
  }
}
