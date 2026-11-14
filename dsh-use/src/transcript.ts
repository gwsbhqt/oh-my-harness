/**
 * 把会话的原始事件日志整理成外出时要看的样子：逐轮概览、某一轮的详情、每轮最后一段回复。
 *
 * 结构参照 the session transcript reader 的 transcript.ts（插件之间不能互相导入，所以这里是一份专用精简版）：
 * 思考块不输出；注入的背景内容（技能清单、压缩检查点……）只标出长度。
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

export interface Item {
  kind: ItemKind
  turn: number
  seq: number
  time?: number
  label?: string
  isError?: boolean
  text: string
}

export interface TurnSummary {
  turn: number
  start?: number
  end?: number
  user: string
  steps: number
  toolCalls: number
  toolErrors: number
  /** completed / error / aborted / max-tokens / interrupted……；没结束为 undefined。 */
  ended?: string
  endDetail?: string
  /** 这一轮最后一段助手文字（不含工具调用）。 */
  reply?: string
  replySeq?: number
}

export interface Transcript {
  items: Item[]
  turns: TurnSummary[]
  title?: string
  cwd?: string
  lastSeq: number
  /** 最近一次 request/header 用的模型。 */
  model?: { provider: string; model: string; reasoningEffort?: string }
}

function endReason(reason: Json): { ended: string; detail?: string } {
  const kind = str(reason.kind) ?? 'unknown'
  const error = obj(reason.error)
  const code = str(error.code)
  const message = str(error.message)
  if (code !== undefined || message !== undefined) return { ended: kind, detail: [code, message].filter(Boolean).join(': ') }
  const inner = str(obj(reason.reason).kind)
  return inner === undefined ? { ended: kind } : { ended: kind, detail: inner }
}

export function buildTranscript(events: readonly RawEvent[]): Transcript {
  const items: Item[] = []
  const turns = new Map<number, TurnSummary>()
  const toolNames = new Map<string, string>()
  let current = 0
  let title: string | undefined
  let cwd: string | undefined
  let lastSeq = -1
  let model: Transcript['model']

  const turnOf = (n: number): TurnSummary => {
    let t = turns.get(n)
    if (t === undefined) {
      t = { turn: n, user: '', steps: 0, toolCalls: 0, toolErrors: 0 }
      turns.set(n, t)
    }
    return t
  }

  for (const ev of events) {
    const data = obj(ev.data)
    const seq = num(ev.seq)
    if (seq !== undefined && seq > lastSeq) lastSeq = seq
    const time = num(ev.time)
    const dataTurn = num(data.turn)
    if (dataTurn !== undefined) current = dataTurn
    const at = { turn: current, seq: seq ?? lastSeq, ...(time === undefined ? {} : { time }) }

    switch (ev.type) {
      case 'session': {
        cwd = str((ev as unknown as Json).cwd) ?? cwd
        break
      }
      case 'session/title':
        title = str(data.title) ?? title
        break
      case 'request/header': {
        const config = obj(obj(data.header).config)
        const provider = str(config.provider)
        const m = str(config.model)
        if (provider !== undefined && m !== undefined) {
          const effort = str(config.reasoningEffort)
          model = { provider, model: m, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
        }
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
      case 'step/start':
        turnOf(current).steps++
        break
      case 'user/message': {
        const kind = str(obj(data.source).kind) ?? 'user'
        const text = blocksText(data.content)
        const turn = dataTurn ?? (current === 0 ? 1 : turns.get(current)?.ended !== undefined ? current + 1 : current)
        const t = turnOf(turn)
        // 历史日志曾用 remote-control 记录用户发言；这里只解码旧数据，不注册旧运行时入口。
        if (kind === 'user' || kind === 'remote-control') {
          t.user = t.user === '' ? text : `${t.user}\n\n${text}`
          items.push({ ...at, turn, kind: 'user', text })
        } else {
          items.push({ ...at, turn, kind: 'injected', label: kind, text })
        }
        break
      }
      case 'assistant/message': {
        const content = Array.isArray(obj(data.message).content) ? obj(data.message).content as unknown[] : []
        let parts: string[] = []
        const flush = () => {
          const text = parts.join('\n')
          if (text.trim() !== '') {
            items.push({ ...at, kind: 'assistant', text })
            const t = turnOf(current)
            t.reply = text
            t.replySeq = at.seq
          }
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
          toolNames.set(str(b.id) ?? '', name)
          turnOf(current).toolCalls++
          const args = typeof b.arguments === 'string' ? b.arguments : JSON.stringify(b.arguments ?? {})
          items.push({ ...at, kind: 'tool-call', label: name, text: args })
        }
        flush()
        break
      }
      case 'tool/result': {
        const message = obj(data.message)
        const isError = message.isError === true
        if (isError) turnOf(current).toolErrors++
        items.push({ ...at, kind: 'tool-result', label: toolNames.get(str(message.toolCallId) ?? '') ?? 'tool', isError, text: blocksText(message.content) })
        break
      }
      case 'assistant/attempt': {
        for (const raw of Array.isArray(data.stream) ? data.stream : []) {
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
    turns: [...turns.values()].filter((t) => t.turn > 0).sort((a, b) => a.turn - b.turn),
    lastSeq,
    ...(title === undefined ? {} : { title }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(model === undefined ? {} : { model }),
  }
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`
}

export function clock(ms: number | undefined): string {
  if (ms === undefined) return '--:--'
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function turnLine(t: TurnSummary, userChars = 120): string {
  const status = t.ended === undefined ? '进行中' : t.endDetail === undefined ? t.ended : `${t.ended}（${oneLine(t.endDetail, 100)}）`
  const work = `${t.steps} 步，${t.toolCalls} 次工具${t.toolErrors > 0 ? `（${t.toolErrors} 次失败）` : ''}`
  const user = t.user === '' ? '（没有用户文字）' : oneLine(t.user, userChars)
  return `第 ${t.turn} 轮 · ${clock(t.start)} · ${work} · ${status}\n    问：${user}${t.reply === undefined ? '' : `\n    答：${oneLine(t.reply, userChars)}`}`
}

export function renderItem(item: Item, itemChars: number): string {
  const cut = (text: string) => text.length <= itemChars ? text : `${text.slice(0, itemChars)}\n…（还有 ${text.length - itemChars} 字，加 --chars 看更多）`
  switch (item.kind) {
    case 'user': return `[用户 · seq ${item.seq}]\n${cut(item.text)}`
    case 'injected': return `[注入的背景 ${item.label} · ${item.text.length} 字 · 不显示]`
    case 'assistant': return `[助手 · seq ${item.seq}]\n${cut(item.text)}`
    case 'tool-call': return `[调用 ${item.label} · seq ${item.seq}]\n${cut(item.text)}`
    case 'tool-result': return `[结果 ${item.label}${item.isError ? ' · 出错' : ''} · seq ${item.seq}]\n${cut(item.text)}`
    case 'attempt-failed': return `[模型请求失败 · seq ${item.seq}] ${cut(item.text)}`
    case 'turn-end': return `[第 ${item.turn} 轮结束：${cut(item.text)}]`
  }
}

/** 某一轮的详情；`tools` 为 false 时略掉工具调用和结果，只看对话。 */
export function renderTurn(transcript: Transcript, turn: number, options: { itemChars: number; tools: boolean; maxChars: number }): string {
  const items = transcript.items.filter((i) => i.turn === turn && (options.tools || (i.kind !== 'tool-call' && i.kind !== 'tool-result')))
  if (items.length === 0) return `第 ${turn} 轮没有记录`
  const out: string[] = []
  let used = 0
  let skipped = 0
  for (const item of items) {
    const text = renderItem(item, options.itemChars)
    if (used + text.length > options.maxChars && out.length > 0) { skipped++; continue }
    out.push(text)
    used += text.length + 2
  }
  if (skipped > 0) out.push(`…（后面还有 ${skipped} 条没显示：--max 是这一轮总共显示的字数，现在是 ${options.maxChars}，调大能看全${options.tools ? '；去掉 --tools 只看对话' : ''}）`)
  return out.join('\n\n')
}
