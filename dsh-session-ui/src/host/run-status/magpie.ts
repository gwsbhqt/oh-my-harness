/**
 * 从 magpie 的请求记录里读回每次请求的分段用时。
 *
 * magpie 在请求结束时把这一次写进记录：sent_ms 是请求完整交给模型服务商的时刻，ttft_ms 是首段内容（文字、推理或工具调用），
 * ms 是收完。请求进行中这些都读不到，所以只能事后拆。Claude 那条线路 magpie 不记 sent_ms，只能拆成两段。
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { RequestTiming } from '../../shared/run-status/types.ts'

/** magpie `GET /v1/magpie/usage/requests` 每行里本插件用到的字段。 */
export interface MagpieRow {
  readonly response_id?: string
  readonly session?: string
  readonly native_session?: string
  readonly ms?: number
  readonly ttft_ms?: number
  readonly sent_ms?: number
  readonly retried_ms?: number
}

export type TimingPatch = Omit<RequestTiming, 'responseId' | 'step' | 'model' | 'totalMs' | 'end'>

/** 每次读取的最近请求记录上限；所有会话共用该记录列表。 */
export const ROW_LIMIT = 100
/** 请求结束后隔多久去找它的记录；最后一次还找不到就算没有。 */
export const LOOKUP_DELAYS = [1500, 4000, 10_000, 30_000] as const

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 网关钥匙随请求发出：本机才允许明文 http，别的机器上的网关必须走 https。 */
export function gatewayUrl(base: string, endpoint: 'usage/requests' | 'trace'): URL {
  const url = new URL(base.replace(/\/$/, '') + '/magpie/' + endpoint)
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (!(url.protocol === 'https:' || (loopback && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw new Error('magpie 地址只能是本机，或 https 的网关')
  }
  return url
}

export function requestsUrl(base: string, limit = ROW_LIMIT): URL {
  const url = gatewayUrl(base, 'usage/requests')
  url.searchParams.set('limit', String(limit))
  return url
}

/** 把 magpie 的一行拆成上传、等首段内容、返回。totalMs 是 DSH 这边量到的总时长。 */
export function splitRow(row: MagpieRow, totalMs: number): TimingPatch {
  const ms = num(row.ms)
  const ttft = num(row.ttft_ms)
  const sent = num(row.sent_ms)
  if (ms === undefined || ttft === undefined || ttft <= 0 || ttft > ms) {
    return { state: 'ok', note: 'Magpie 缺少可核对的总用时或首段内容计时，拆不开' }
  }
  const retried = num(row.retried_ms)
  const outside = totalMs - ms
  return {
    state: 'ok',
    ...sent !== undefined && sent > 0 && sent <= ttft ? { uploadMs: sent, firstTokenMs: ttft - sent } : { firstTokenMs: ttft },
    returnMs: ms - ttft,
    ...retried !== undefined && retried > 0 ? { retriedMs: retried } : {},
    ...outside >= 1000 ? { outsideMs: outside } : {},
  }
}

/** agent:false 直接连接，避免宿主的全局 fetch 代理接管。 */
export function readGatewayJson(url: URL, key: string | undefined): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const headers = { accept: 'application/json', ...key ? { authorization: `Bearer ${key}` } : {} }
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { headers, agent: false, timeout: 10_000 }, (response) => {
      const chunks: Buffer[] = []
      let length = 0
      response.on('data', (chunk: Buffer) => {
        length += chunk.length
        if (length > 8 * 1024 * 1024) request.destroy(new Error('magpie 请求记录太大'))
        else chunks.push(chunk)
      })
      response.on('error', reject)
      response.on('end', () => {
        const status = response.statusCode ?? 0
        if (status < 200 || status >= 300) return reject(new Error(`magpie 返回 HTTP ${status}${status === 401 || status === 403 ? '，网关钥匙不对' : ''}`))
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
        } catch {
          reject(new Error('magpie 返回的不是 JSON'))
        }
      })
    })
    request.once('timeout', () => request.destroy(new Error('读 magpie 超时')))
    request.once('error', reject)
    request.end()
  })
}

export function requestRows(value: unknown): MagpieRow[] {
  const rows = (value as { rows?: unknown } | null)?.rows
  if (!Array.isArray(rows)) throw new Error('magpie 返回的不是请求记录')
  return rows.filter((r): r is MagpieRow => typeof r === 'object' && r !== null)
}

export interface LookupItem {
  readonly session: string
  readonly responseId: string
}

function requestFor(rows: readonly MagpieRow[], item: LookupItem): MagpieRow | undefined {
  const matches = rows.filter(r => r.response_id === item.responseId)
  const own = matches.filter(r => (r.session || r.native_session) === item.session)
  if (own.length === 1) return own[0]
  // 老记录可能只有回复编号。出现多个候选时无法确定哪一行属于这一步。
  const only = matches.length === 1 ? matches[0] : undefined
  return only && !only.session && !only.native_session ? only : undefined
}

interface Waiting {
  readonly item: LookupItem
  readonly totalMs: number
  tries: number
  dueAt: number
}

/**
 * 排队找刚结束的请求。到点的几条合并成一次读取；找不到就按 LOOKUP_DELAYS 往后再找，
 * 最后一次还没有，记成找不到（或读不到 magpie）。
 */
export class TimingLookup {
  private readonly waiting = new Map<string, Waiting>()
  private readonly read: () => Promise<MagpieRow[]>
  private readonly done: (item: LookupItem, patch: TimingPatch) => void

  constructor(read: () => Promise<MagpieRow[]>, done: (item: LookupItem, patch: TimingPatch) => void) {
    this.read = read
    this.done = done
  }

  add(item: LookupItem, totalMs: number, now: number): void {
    this.waiting.set(`${item.session}\n${item.responseId}`, { item, totalMs, tries: 0, dueAt: now + LOOKUP_DELAYS[0] })
  }

  nextAt(): number | undefined {
    let at: number | undefined
    for (const w of this.waiting.values()) if (at === undefined || w.dueAt < at) at = w.dueAt
    return at
  }

  async poll(now: number): Promise<void> {
    const due = [...this.waiting].filter(([, w]) => w.dueAt <= now)
    if (due.length === 0) return
    let rows: MagpieRow[] | undefined
    let error: string | undefined
    try {
      rows = await this.read()
    } catch (e) {
      error = e instanceof Error ? e.message : String(e)
    }
    for (const [key, w] of due) {
      if (this.waiting.get(key) !== w) continue
      const row = rows && requestFor(rows, w.item)
      if (row !== undefined) {
        this.waiting.delete(key)
        this.done(w.item, splitRow(row, w.totalMs))
        continue
      }
      w.tries += 1
      const delay = LOOKUP_DELAYS[w.tries]
      if (delay !== undefined) {
        w.dueAt = now + delay
        continue
      }
      this.waiting.delete(key)
      this.done(w.item, error === undefined ? { state: 'missing' } : { state: 'error', note: error })
    }
  }

  forget(session: string): void {
    for (const [key, waiting] of this.waiting) {
      if (waiting.item.session === session) this.waiting.delete(key)
    }
  }

  clear(): void {
    this.waiting.clear()
  }
}
