/**
 * 会话整理用的 Jev 调用：一次一条会话，问它“是不是一次性会话、可以归档”，回一个 0~1 的概率。
 *
 * 协议与 dsh-composer / dsh-compaction-tuning 的 Jev 调用相同（插件之间不共享代码，这里只带用得上的最小一份）。
 * 失败一律抛：调用方把失败当成“这次判断不了”，会话保留。
 */

import { brotliDecompressSync, gunzipSync, zstdDecompressSync } from 'node:zlib'

export interface NoulQuestion {
  readonly type: 'noul'
  readonly instructions: string
}

export interface JevAsker {
  ask(state: unknown, questions: Record<string, NoulQuestion>, signal: AbortSignal): Promise<Record<string, number>>
}

/**
 * 按魔数兜底解压响应体。宿主的全局 fetch 会剥掉 content-encoding 头却不解压 body，
 * 不兜底就会拿到压缩字节。
 */
export function decodeBody(body: Uint8Array): Uint8Array {
  if (body[0] === 0x1f && body[1] === 0x8b) return gunzipSync(body)
  if (body[0] === 0x28 && body[1] === 0xb5 && body[2] === 0x2f && body[3] === 0xfd) return zstdDecompressSync(body)
  if (body[0] === 0x7b || body[0] === 0x5b) return body
  try {
    return brotliDecompressSync(body)
  } catch {
    return body
  }
}

export function parseAnswers(text: string, names: readonly string[]): Record<string, number> {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`Jev 返回的不是合法 JSON（开头：${JSON.stringify(text.slice(0, 40))}）`)
  }
  const answers = (parsed as { answers?: Record<string, { noul?: unknown }> } | null)?.answers
  if (answers === undefined || answers === null || typeof answers !== 'object') throw new Error('Jev 响应里没有 answers')
  const out: Record<string, number> = {}
  for (const name of names) {
    const value = answers[name]?.noul
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Jev 对 ${name} 的回答缺失`)
    out[name] = value
  }
  return out
}

export class HttpJev implements JevAsker {
  private readonly apiKey: string
  private readonly url: string
  private readonly model: string

  constructor(apiKey: string, url: string, model: string) {
    this.apiKey = apiKey
    this.url = url
    this.model = model
  }

  async ask(state: unknown, questions: Record<string, NoulQuestion>, signal: AbortSignal): Promise<Record<string, number>> {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: { 'authorization': `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.model, state, questions }),
      signal,
    })
    const text = new TextDecoder().decode(decodeBody(new Uint8Array(await response.arrayBuffer())))
    if (!response.ok) throw new Error(`Jev 请求失败（HTTP ${response.status}）：${text.slice(0, 200)}`)
    return parseAnswers(text, Object.keys(questions))
  }
}
