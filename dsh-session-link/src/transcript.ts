/**
 * 把一个会话的原始事件日志整理成三种按需读取的视图：逐轮概览、单轮详情（分页）、全文搜索。
 *
 * 读的是完整原始日志（`sessionQuery.observeSession`），不是模型当前看到的表层：压缩掉的早期轮次、
 * 工具调用和结果、每轮怎么结束（报错码）都在。模型的思考（reasoning 块）不输出。
 *
 * 注入进会话的背景内容（技能清单、运行时快照、压缩检查点、别的会话的引用快照……）默认只标出
 * 「这里有一段多长的什么」，要看得显式要求：它们往往很长，也是上一次整份复制惹出麻烦的那类内容。
 *
 * @module
 */

export interface RawEvent {
  type: string
  seq?: number
  time?: number
  data?: unknown
}

type Json = Record<string, unknown>

function obj(v: unknown): Json {
  return typeof v === 'object' && v !== null ? v as Json : {}
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

/** 内容块里的文字；图片、文件写成占位，思考块丢掉。 */
function blocksText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const raw of content) {
    const b = obj(raw)
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b.type === 'image') parts.push('[image]')
    else if (b.type === 'file') parts.push(`[file${typeof b.name === 'string' ? ` ${b.name}` : ''}]`)
  }
  return parts.join('\n')
}

export type ItemKind = 'user' | 'injected' | 'assistant' | 'tool-call' | 'tool-result' | 'attempt-failed' | 'turn-end'

/** 一轮里按时间顺序的一条记录。`text` 是完整原文，渲染时再截断。 */
export interface Item {
  kind: ItemKind
  turn: number
  seq: number
  time?: number
  /** injected 的来源类型（skill-catalog、compact-checkpoint……）；tool-call / tool-result 的工具名。 */
  label?: string
  callId?: string
  isError?: boolean
  text: string
}

export interface TurnSummary {
  turn: number
  start?: number
  end?: number
  /** 这一轮用户亲手发的话（多条用空行连起来）。 */
  user: string
  steps: number
  toolCalls: number
  toolErrors: number
  /** 被注入的背景内容类型及字数，比如 compact-checkpoint 23 万字。 */
  injected: { label: string; chars: number }[]
  /** completed / error / aborted / max-tokens / interrupted……；还没结束为 undefined。 */
  ended?: string
  /** 结束原因的细节：报错码和报错文字。 */
  endDetail?: string
}

export interface Transcript {
  items: Item[]
  turns: TurnSummary[]
  title?: string
  firstTime?: number
  lastTime?: number
}

function endReason(reason: Json): { ended: string; detail?: string } {
  const kind = str(reason.kind) ?? 'unknown'
  const error = obj(reason.error)
  const code = str(error.code)
  const message = str(error.message)
  if (code !== undefined || message !== undefined) {
    return { ended: kind, detail: [code, message].filter(Boolean).join(': ') }
  }
  const inner = obj(reason.reason)
  const innerKind = str(inner.kind)
  return innerKind === undefined ? { ended: kind } : { ended: kind, detail: innerKind }
}

/** 从原始事件日志建出逐条记录和逐轮汇总。 */
export function buildTranscript(events: readonly RawEvent[]): Transcript {
  const items: Item[] = []
  const turns = new Map<number, TurnSummary>()
  const toolNames = new Map<string, string>()
  let current = 0
  let title: string | undefined
  let firstTime: number | undefined
  let lastTime: number | undefined

  const turnOf = (n: number): TurnSummary => {
    let t = turns.get(n)
    if (t === undefined) {
      t = { turn: n, user: '', steps: 0, toolCalls: 0, toolErrors: 0, injected: [] }
      turns.set(n, t)
    }
    return t
  }

  for (const ev of events) {
    const data = obj(ev.data)
    const seq = num(ev.seq) ?? items.length
    const time = num(ev.time)
    if (time !== undefined) {
      firstTime ??= time
      lastTime = time
    }
    const dataTurn = num(data.turn)
    if (dataTurn !== undefined) current = dataTurn
    const at = { turn: current, seq, ...(time === undefined ? {} : { time }) }

    switch (ev.type) {
      case 'session/title': {
        title = str(data.title) ?? title
        break
      }
      case 'turn/start': {
        const t = turnOf(current)
        if (time !== undefined) t.start = time
        break
      }
      case 'turn/end': {
        const t = turnOf(current)
        if (time !== undefined) t.end = time
        const { ended, detail } = endReason(obj(data.reason))
        t.ended = ended
        if (detail !== undefined) t.endDetail = detail
        items.push({ ...at, kind: 'turn-end', text: detail === undefined ? ended : `${ended} — ${detail}` })
        break
      }
      case 'step/start': {
        turnOf(current).steps++
        break
      }
      case 'user/message': {
        const source = obj(data.source)
        const kind = str(source.kind) ?? 'user'
        const text = blocksText(data.content)
        // 正常消息由 preStep 在 turn/start 后落盘；未开轮或已结束时的消息归到待开始的一轮。
        const turn = dataTurn ?? (current === 0 ? 1 : turns.get(current)?.ended !== undefined ? current + 1 : current)
        const t = turnOf(turn)
        if (kind === 'user') {
          t.user = t.user === '' ? text : `${t.user}\n\n${text}`
          items.push({ ...at, turn, kind: 'user', text })
        } else {
          t.injected.push({ label: kind, chars: text.length })
          items.push({ ...at, turn, kind: 'injected', label: kind, text })
        }
        break
      }
      case 'assistant/message': {
        const message = obj(data.message)
        const content = Array.isArray(message.content) ? message.content : []
        let parts: string[] = []
        const flush = () => {
          const text = parts.join('\n')
          if (text.trim() !== '') items.push({ ...at, kind: 'assistant', text })
          parts = []
        }
        for (const raw of content) {
          const b = obj(raw)
          if (b.type !== 'tool-call') {
            const text = blocksText([raw])
            if (text !== '') parts.push(text)
            continue
          }
          flush()
          const name = str(b.name) ?? 'tool'
          const callId = str(b.id) ?? ''
          toolNames.set(callId, name)
          turnOf(current).toolCalls++
          const args = typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {})
          items.push({ ...at, kind: 'tool-call', label: name, callId, text: args })
        }
        flush()
        break
      }
      case 'tool/result': {
        const message = obj(data.message)
        const callId = str(message.toolCallId) ?? ''
        const isError = message.isError === true
        if (isError) turnOf(current).toolErrors++
        items.push({
          ...at,
          kind: 'tool-result',
          label: toolNames.get(callId) ?? 'tool',
          callId,
          isError,
          text: blocksText(message.content),
        })
        break
      }
      case 'assistant/attempt': {
        // 失败的那次尝试：流里带 error finish。重试成功的尝试不记。
        const stream = Array.isArray(data.stream) ? data.stream : []
        for (const raw of stream) {
          const chunk = obj(obj(raw).chunk)
          const reason = obj(chunk.reason)
          if (chunk.type === 'finish' && reason.kind === 'error') {
            const failure = obj(reason.failure)
            items.push({ ...at, kind: 'attempt-failed', text: [str(failure.code), str(failure.message)].filter(Boolean).join(': ') })
          }
        }
        break
      }
      default:
        break
    }
  }
  return {
    items,
    turns: [...turns.values()].filter(t => t.turn > 0).sort((a, b) => a.turn - b.turn),
    ...(title === undefined ? {} : { title }),
    ...(firstTime === undefined ? {} : { firstTime }),
    ...(lastTime === undefined ? {} : { lastTime }),
  }
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

function clock(ms: number | undefined): string {
  if (ms === undefined) return '--:--'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function chars(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k chars` : `${n} chars`
}

/** 一轮的一行概览。 */
export function turnLine(t: TurnSummary, userChars = 160): string {
  const status = t.ended === undefined ? 'running or unfinished' : t.endDetail === undefined ? t.ended : `${t.ended} (${oneLine(t.endDetail, 120)})`
  const work = `${t.steps} step${t.steps === 1 ? '' : 's'}, ${t.toolCalls} tool call${t.toolCalls === 1 ? '' : 's'}${t.toolErrors > 0 ? ` (${t.toolErrors} failed)` : ''}`
  const injected = t.injected.length === 0 ? '' : ` · injected: ${t.injected.map(i => `${i.label} ${chars(i.chars)}`).join(', ')}`
  const user = t.user === '' ? '(no user text)' : oneLine(t.user, userChars)
  return `turn ${t.turn} · ${clock(t.start)} · ${work} · ${status}${injected}\n    user: ${user}`
}

export interface RenderOptions {
  /** 每条记录最多显示的字数，超出截断并标明原长。 */
  itemChars: number
  /** 是否展开注入的背景内容。 */
  includeInjected: boolean
}

/** 一条记录渲染成文字。 */
export function renderItem(item: Item, options: RenderOptions): string {
  const cut = (text: string) => text.length <= options.itemChars
    ? text
    : `${text.slice(0, options.itemChars)}\n… [${text.length - options.itemChars} more chars; raise item_chars to see more]`
  switch (item.kind) {
    case 'user':
      return `[user · seq ${item.seq}]\n${cut(item.text)}`
    case 'injected':
      return options.includeInjected
        ? `[injected context: ${item.label} · seq ${item.seq}]\n${cut(item.text)}`
        : `[injected context: ${item.label}, ${chars(item.text.length)} · seq ${item.seq} — not shown; pass include_injected=true to read it]`
    case 'assistant':
      return `[assistant · seq ${item.seq}]\n${cut(item.text)}`
    case 'tool-call':
      return `[tool call ${item.label} · ${item.callId} · seq ${item.seq}]\n${cut(item.text)}`
    case 'tool-result':
      return `[tool result ${item.label} · ${item.callId}${item.isError ? ' · ERROR' : ''} · seq ${item.seq}]\n${cut(item.text)}`
    case 'attempt-failed':
      return `[model request failed · seq ${item.seq}] ${cut(item.text)}`
    case 'turn-end':
      return `[turn ${item.turn} ended: ${cut(item.text)}]`
  }
}

export interface Page {
  text: string
  /** 还有下一页时，下次传的 offset。 */
  nextOffset?: number
  total: number
}

/**
 * 一轮的详情，按条目分页：`offset` 是从这一轮第几条开始，`maxChars` 是这一页的字数上限。
 * 至少消费一条，保证翻页总能前进；单条超出整页预算时截断并提示提高 max_chars。
 */
export function readTurn(transcript: Transcript, turn: number, offset: number, maxChars: number, options: RenderOptions): Page {
  const items = transcript.items.filter(i => i.turn === turn)
  const out: string[] = []
  const budget = Math.max(0, Math.floor(maxChars))
  let used = 0
  let k = Math.min(items.length, Math.max(0, Math.floor(offset)))
  for (; k < items.length; k++) {
    const text = renderItem(items[k]!, options)
    const separator = out.length === 0 ? 0 : 2
    if (used + separator + text.length > budget) {
      if (out.length > 0) break
      const marker = '\n… [page truncated; raise max_chars to read this record]'
      out.push(budget >= marker.length ? text.slice(0, budget - marker.length) + marker : text.slice(0, budget))
      k++
      break
    }
    out.push(text)
    used += separator + text.length
  }
  return {
    text: out.join('\n\n'),
    total: items.length,
    ...(k < items.length ? { nextOffset: k } : {}),
  }
}

export interface Hit {
  turn: number
  seq: number
  kind: ItemKind
  label?: string
  snippet: string
  /** 这一条在该轮里的序号，可以直接当 session_turn 的 offset。 */
  offset: number
}

/** 不区分大小写的字面搜索，空白按任意空白匹配。 */
export function search(transcript: Transcript, query: string, limit: number, includeInjected: boolean): { hits: Hit[]; total: number } {
  const words = query.trim().split(/\s+/).filter(Boolean).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  if (words.length === 0) return { hits: [], total: 0 }
  const pattern = new RegExp(words.join('\\s+'), 'i')
  const position = new Map<Item, number>()
  const perTurn = new Map<number, number>()
  for (const item of transcript.items) {
    const n = perTurn.get(item.turn) ?? 0
    position.set(item, n)
    perTurn.set(item.turn, n + 1)
  }
  const hits: Hit[] = []
  let total = 0
  for (const item of transcript.items) {
    if (item.kind === 'injected' && !includeInjected) continue
    const m = pattern.exec(item.text)
    if (m === null) continue
    total++
    if (hits.length >= limit) continue
    const from = Math.max(0, m.index - 80)
    const to = Math.min(item.text.length, m.index + Math.min(m[0].length, 160) + 80)
    hits.push({
      turn: item.turn,
      seq: item.seq,
      kind: item.kind,
      ...(item.label === undefined ? {} : { label: item.label }),
      snippet: `${from > 0 ? '…' : ''}${item.text.slice(from, to).replace(/\s+/g, ' ')}${to < item.text.length ? '…' : ''}`,
      offset: position.get(item) ?? 0,
    })
  }
  return { hits, total }
}

export { clock, oneLine }
