/**
 * 从 magpie 的请求记录里读回每次请求的分段用时。
 *
 * magpie 在请求结束时把这一次写进记录：sent_ms 是请求完整交给模型服务商的时刻，ttft_ms 是第一个字，
 * ms 是收完。请求进行中这些都读不到，所以只能事后拆。Claude 那条线路 magpie 不记 sent_ms，只能拆成两段。
 */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { RequestTiming } from '../../shared/run-status/types.ts'

/** magpie `GET /v1/magpie/usage/requests` 每行里本插件用到的字段。 */
export interface MagpieRow {
  readonly response_id?: string
  readonly ms?: number
  readonly ttft_ms?: number
  readonly sent_ms?: number
  readonly retried_ms?: number
}

export type TimingPatch = Omit<RequestTiming, 'responseId' | 'step' | 'model' | 'totalMs' | 'end'>

/** 一次拉多少行。Studio 上所有会话的请求都在里面，一两分钟内的够用。 */
export const ROW_LIMIT = 100
/** 请求结束后隔多久去找它的记录；最后一次还找不到就算没有。 */
export const LOOKUP_DELAYS = [1500, 4000, 10_000, 30_000] as const

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** 网关钥匙随请求发出：本机才允许明文 http，别的机器上的网关必须走 https。 */
export function requestsUrl(base: string, limit = ROW_LIMIT): URL {
  const url = new URL(base.replace(/\/$/, '') + '/magpie/usage/requests')
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if (!(url.protocol === 'https:' || (loopback && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw new Error('magpie 地址只能是本机，或 https 的网关')
  }
  url.searchParams.set('limit', String(limit))
  return url
}

/** 把 magpie 的一行拆成上传、等首字、返回。totalMs 是 DSH 这边量到的总时长。 */
export function splitRow(row: MagpieRow, totalMs: number): TimingPatch {
  const ms = num(row.ms)
  const ttft = num(row.ttft_ms)
  const sent = num(row.sent_ms)
  if (ms === undefined || ttft === undefined || ttft <= 0) return { state: 'ok', note: 'magpie 没记下第一个字的时刻，拆不开' }
  const retried = num(row.retried_ms)
  const outside = totalMs - ms
  return {
    state: 'ok',
    ...sent !== undefined && sent > 0 && sent <= ttft ? { uploadMs: sent, firstTokenMs: ttft - sent } : { firstTokenMs: ttft },
    returnMs: Math.max(0, ms - ttft),
    ...retried !== undefined && retried > 0 ? { retriedMs: retried } : {},
    ...outside >= 1000 ? { outsideMs: outside } : {},
  }
}

/** agent:false 直接连接，避免宿主的全局 fetch 代理接管。 */
export function readRows(url: URL, key: string | undefined): Promise<MagpieRow[]> {
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
          const rows = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { rows?: unknown }).rows
          if (!Array.isArray(rows)) return reject(new Error('magpie 返回的不是请求记录'))
          resolve(rows.filter((r): r is MagpieRow => typeof r === 'object' && r !== null))
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

export interface LookupItem {
  readonly session: string
  readonly responseId: string
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
      const row = rows?.find((r) => r.response_id === w.item.responseId)
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
