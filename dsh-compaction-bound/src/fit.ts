/**
 * 写摘要请求超出模型窗口时，把这次请求压进窗口。
 *
 * 宿主的压缩（dsh-compaction-basic）为了命中缓存，写摘要时把要压掉的整段对话原样重放给模型。
 * 会话一旦已经超过模型登记的窗口，这次请求同样超窗：服务商拒收，或 pi-ai 发现实际输入超过
 * 登记窗口、把正常写完的摘要也判成 CONTEXT_WINDOW_EXCEEDED。压缩于是永远失败，会话再也回不到窗口内。
 * 这里只改这一次写摘要请求，不动会话记录；被拿掉的用户原话照样由附录逐字带上。
 *
 * @module
 */
import { CHECKPOINT_KIND } from './summary.ts'

interface Block { type?: string; text?: string; id?: string }
interface Msg { role?: string; content?: unknown; source?: { kind?: string }; toolCallId?: string }

/** 工具结果里单个文本块超过这个长度才截，截后留开头和结尾。 */
export const TOOL_TEXT_KEEP = 1500
const TOOL_HEAD = 1000
const TOOL_TAIL = 400

/** 一条消息按序列化后的字符数计。字符和 token 的换算比例按同一口径从服务商回报的用量里学。 */
export function messageChars(message: unknown): number {
  return JSON.stringify(message)?.length ?? 0
}

export function requestChars(messages: readonly unknown[], tools: unknown): number {
  let total = tools === undefined ? 0 : JSON.stringify(tools).length
  for (const m of messages) total += messageChars(m)
  return total
}

/** 服务商回报的这次请求输入 token 数；没有回报返回 undefined。 */
export function promptTokens(usage: unknown): number | undefined {
  if (usage === null || typeof usage !== 'object') return undefined
  const u = usage as { inputTokens?: number; outputTokens?: number; totalTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  const fromTotal = typeof u.totalTokens === 'number' && typeof u.outputTokens === 'number' ? u.totalTokens - u.outputTokens : undefined
  const summed = (u.inputTokens ?? 0) + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
  const tokens = Math.max(fromTotal ?? 0, summed)
  return tokens > 0 ? tokens : undefined
}

/** 写摘要请求能用的输入 token：窗口扣掉这次请求预留的输出，再留一成余量给估算误差。 */
export function budgetTokens(contextWindow: number, maxTokens: number | undefined): number {
  const reserve = Math.min(maxTokens ?? 0, Math.floor(contextWindow / 2))
  return Math.floor((contextWindow - reserve) * 0.9)
}

export interface FitResult {
  messages: readonly unknown[]
  trimmedToolResults: number
  droppedMessages: number
  beforeChars: number
  afterChars: number
}

export function omittedNote(dropped: number): string {
  return `[${dropped} earlier messages of this span were left out of this request so that it fits the model's context window. `
    + 'Summarize what is shown; any earlier checkpoint above still applies. The user messages that were left out are attached verbatim after your checkpoint.]'
}

function trimToolText(text: string): string {
  const omitted = text.length - TOOL_HEAD - TOOL_TAIL
  return `${text.slice(0, TOOL_HEAD)}\n[... ${omitted} characters of this tool result omitted to fit the context window ...]\n${text.slice(-TOOL_TAIL)}`
}

function trimToolMessage(message: Msg): Msg | undefined {
  if (!Array.isArray(message.content)) return undefined
  let changed = false
  const content = (message.content as Block[]).map((block) => {
    if (block?.type !== 'text' || typeof block.text !== 'string' || block.text.length <= TOOL_TEXT_KEEP) return block
    changed = true
    return Object.freeze({ ...block, text: trimToolText(block.text) })
  })
  return changed ? Object.freeze({ ...message, content: Object.freeze(content) }) : undefined
}

/**
 * 把写摘要请求压到 targetChars 以内（含 tools 的字符数）。
 *
 * 先从最早的工具结果开始截长文本；还不够，就从最早处整段拿掉消息，切口只落在用户消息前面，
 * 而且切口之后的每个工具结果，它对应的工具调用也在切口之后，不会留下孤立的工具结果。
 * 开头的系统提示、拿掉部分里的上一份检查点、最后那条压缩指令始终保留。
 * @returns 压不进去返回 undefined，调用方照原请求发。
 */
export function fitMessages(messages: readonly unknown[], tools: unknown, targetChars: number): FitResult | undefined {
  const list = [...messages] as Msg[]
  const beforeChars = requestChars(list, tools)
  if (beforeChars <= targetChars) return { messages, trimmedToolResults: 0, droppedMessages: 0, beforeChars, afterChars: beforeChars }
  if (list.length < 3) return undefined
  const head = list[0]?.role === 'system' ? 1 : 0
  const last = list.length - 1
  let total = beforeChars
  let trimmed = 0
  for (let i = head; i < last && total > targetChars; i++) {
    if (list[i]!.role !== 'tool') continue
    const next = trimToolMessage(list[i]!)
    if (next === undefined) continue
    total += messageChars(next) - messageChars(list[i])
    list[i] = next
    trimmed++
  }
  if (total <= targetChars) return { messages: Object.freeze(list), trimmedToolResults: trimmed, droppedMessages: 0, beforeChars, afterChars: total }

  // 每个工具结果对应的调用在第几条；切口 k 合法要求 k 之后没有工具结果的调用落在 k 之前
  const callAt = new Map<string, number>()
  list.forEach((m, i) => {
    if (m.role === 'assistant' && Array.isArray(m.content)) for (const b of m.content as Block[]) if (b?.type === 'tool-call' && typeof b.id === 'string') callAt.set(b.id, i)
  })
  const minCallFrom = new Array<number>(list.length + 1).fill(Number.POSITIVE_INFINITY)
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i]!
    const call = m.role === 'tool' && typeof m.toolCallId === 'string' ? (callAt.get(m.toolCallId) ?? -1) : Number.POSITIVE_INFINITY
    minCallFrom[i] = Math.min(minCallFrom[i + 1]!, call)
  }
  const fixed = (head === 1 ? messageChars(list[0]) : 0) + (tools === undefined ? 0 : JSON.stringify(tools).length)
  let suffix = 0
  for (let i = head; i < list.length; i++) suffix += messageChars(list[i])
  let checkpoints = 0
  for (let k = head; k < last; k++) {
    const m = list[k]!
    if (k > head && m.role === 'user' && minCallFrom[k]! >= k) {
      const kept = list.slice(head, k).filter((x) => x.role === 'user' && x.source?.kind === CHECKPOINT_KIND)
      const note = omittedNote(k - head - kept.length)
      const size = fixed + checkpoints + suffix + note.length + 40
      if (size <= targetChars) {
        const content = Array.isArray(m.content) ? m.content : []
        const first = Object.freeze({ ...m, content: Object.freeze([Object.freeze({ type: 'text', text: note }), ...content]) })
        const out = Object.freeze([...list.slice(0, head), ...kept, first, ...list.slice(k + 1)])
        return { messages: out, trimmedToolResults: trimmed, droppedMessages: k - head - kept.length, beforeChars, afterChars: requestChars(out, tools) }
      }
    }
    suffix -= messageChars(m)
    if (m.role === 'user' && m.source?.kind === CHECKPOINT_KIND) checkpoints += messageChars(m)
  }
  return undefined
}
