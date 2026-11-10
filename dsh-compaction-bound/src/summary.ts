/**
 * 有界摘要：写摘要那次模型请求发出前，把宿主的压缩指令换成分栏限长、在旧摘要上增量合并的版本；
 * 模型写完后，插件把用户亲手发的每一条消息逐字附在摘要后面（上一份摘要附过的原样接上）。
 *
 * 用户原话不交给模型转述或挑选：模型照抄会漏、会改字。哪些算用户原话只看宿主标的消息来源，
 * 不看文字长什么样。附录有固定最大长度（boundItems）：最近的逐字，更早的只留轮次清单，
 * 原文一直在会话记录里，按轮次取回。模型写的部分另有字数上限（见 checkOutput）。
 *
 * 宿主（@deepseek-ai/dsh-compaction-basic）把指令作为最后一条用户消息追加在重放的对话后面，
 * 只换这一条不动前缀，写摘要仍能命中会话的提示缓存。宿主指令改了措辞、认不出来时原样放行。
 *
 * @module
 */

/** 宿主压缩指令的开头；认不出来就不换。 */
export const STOCK_PREFIX = 'You are now acting as a compaction engine'

/**
 * 附录：自成一个文本块。开头是标题和几行说明（原文出处、怎么取回），然后每行一个 JSON 对象，一项一行：
 * - `{"turn","time","text"}`：逐字原文，text 是这条消息各文本块；
 * - `{"turn","time","chars","head"}`：只留轮次和开头，原文在会话记录里按轮次取回；
 * - `{"turns":[from,to],"count"}`：并掉的一段最早的清单。
 * JSON 把换行、引号、反斜线都转义，项目行不会含真换行、也不会恰好等于结束行，解析逐字还原。
 * 总长受 boundItems 的两个额度约束，不随会话无限增长。
 */
export const HEADING = '## User Messages (oldest first; one JSON object per line)'
export const OPEN_TAG = '<user-messages format="json-lines-v2">'
export const CLOSE_TAG = '</user-messages>'
/** 已有检查点的上一版格式：每行一个文本块数组、全部逐字、没有轮次。 */
const V1_HEADING = '## User Messages (verbatim, oldest first; one line per message: a JSON array of its text blocks)'
const V1_OPEN = '<user-messages format="json-lines">'
/** 已有检查点的最早格式。 */
const LEGACY_HEADING = '## User Messages (verbatim, oldest first)'
const LEGACY_OPEN = '<user-messages>'
/** 清单项留原文开头多少个字。 */
export const HEAD_CHARS = 30
/** 宿主压缩写回的检查点消息的来源（@deepseek-ai/dsh-compaction 的 compactCheckpointSource）。 */
export const CHECKPOINT_KIND = 'compact-checkpoint'
/** 宿主把模型写的摘要包在这两段中间写回会话（dsh-compaction-basic 的 frameSummary）。 */
export const SUMMARY_CLOSE = '</compacted-summary>'
export const REQUIREMENTS_TITLE = 'Active User Requirements'

interface Section { title: string; share: number; hint: string }

const SECTIONS: readonly Section[] = [
  { title: 'Goal and Status', share: 0.08, hint: 'what the user ultimately wants and how far it has got' },
  { title: 'Active User Requirements', share: 0.17, hint: 'the still-valid constraints, corrections, preferences, authorizations, and decisions from the user, one short bullet each; mark any that a later user message replaced or withdrew as superseded, then drop it next time' },
  { title: 'Key Facts and Decisions', share: 0.2, hint: 'facts, findings, and decisions with their reasons that the next model cannot cheaply rediscover' },
  { title: 'Files and Code', share: 0.17, hint: 'exact path: why it matters, what changed' },
  { title: 'Errors and Fixes', share: 0.08, hint: 'only unresolved or recurring errors and how they were handled' },
  { title: 'Pending Work', share: 0.12, hint: 'requested work not yet done' },
  { title: 'Current Work and Next Step', share: 0.12, hint: 'what was in progress at this checkpoint and the single next action' },
]

/** 按总字数预算生成指令；各栏上限按比例分，取整到百。 */
export function boundedInstruction(budgetChars: number): string {
  const cap = (share: number) => Math.max(200, Math.floor((budgetChars * share) / 100) * 100)
  const sections = SECTIONS.flatMap((s) => [`## ${s.title} (at most ${cap(s.share)} characters)`, `- [${s.hint}]`, ''])
  return [
    'You are now acting as a compaction engine for this AI coding assistant. Condense the conversation ABOVE into a checkpoint that lets another model resume the work with no loss of essential context.',
    '',
    `Every message the user typed is attached to the checkpoint after your text, automatically, inside a <user-messages> block: recent ones verbatim, older ones only as a turn index whose originals stay readable in the session log. A <user-messages> block already in the prior checkpoint is carried forward the same way. Do not copy user messages or that block. Because older user messages may appear only as an index, every still-valid user requirement must stay in the Active User Requirements section; refer to user wording only where a short phrase is needed to make a requirement unambiguous.`,
    '',
    `Hard size limit for the text you write: under ${budgetChars} characters in total, and each section has its own limit below. When a section would overflow, drop resolved, superseded, or reconstructible detail (anything the next model can re-read from files, git, or tools) instead of exceeding the limit. Never pad a section to reach its limit.`,
    '',
    'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
    '',
    ...sections,
    'Rules:',
    '- If the conversation already contains a <compacted-summary> block, it is the PRIOR checkpoint and the base of this one. Update it in place: keep still-true bullets, delete finished or stale items, add new ones. Do not keep a section long just because the prior checkpoint was long.',
    '- Write in concise English. Preserve exact file paths, commands, error strings, identifiers, numeric values, and commit hashes.',
    '- Do NOT mention this summarization request or that the context was compacted.',
    '- Output only the checkpoint text: do not call any tool or take any other action.',
  ].join('\n')
}

interface TextBlock { type: string; text?: string }
interface MessageLike { role?: string; content?: unknown; source?: { kind?: string } }
export interface RequestLike { purpose?: string; messages?: readonly unknown[]; provider?: string; model?: string; maxTokens?: number; sessionId?: string; signal?: AbortSignal }

/** 一条用户消息：它的各个文本块，逐字。图片等非文本块不进附录。 */
export type UserMessage = readonly string[]

function textBlocks(message: MessageLike): string[] {
  if (!Array.isArray(message.content)) return []
  return (message.content as TextBlock[]).filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text!)
}

/** 写摘要请求里宿主那条指令所在的位置；不是写摘要请求或认不出来返回 -1。 */
export function stockInstructionIndex(options: RequestLike): number {
  if (options.purpose !== 'compaction' || !Array.isArray(options.messages) || options.messages.length === 0) return -1
  const index = options.messages.length - 1
  const last = options.messages[index] as MessageLike
  if (last?.role !== 'user' || !Array.isArray(last.content) || last.content.length !== 1) return -1
  const block = last.content[0] as TextBlock
  return block?.type === 'text' && typeof block.text === 'string' && block.text.startsWith(STOCK_PREFIX) ? index : -1
}

/** 附录里的一项。turn 为 null 是插件拿不到轮次的旧条目（上一版格式带过来的）。 */
export type Item =
  | { kind: 'full'; turn: number | null; time?: string; text: UserMessage }
  | { kind: 'index'; turn: number | null; time?: string; chars: number; head: string }
  | { kind: 'range'; from: number | null; to: number | null; count: number }

/** 一项写成附录里的一行。 */
export function itemLine(item: Item): string {
  const at = (turn: number | null, time?: string) => ({ turn, ...(time === undefined ? {} : { time }) })
  if (item.kind === 'full') return JSON.stringify({ ...at(item.turn, item.time), text: item.text })
  if (item.kind === 'index') return JSON.stringify({ ...at(item.turn, item.time), chars: item.chars, head: item.head })
  return JSON.stringify({ turns: [item.from, item.to], count: item.count })
}

function parseItem(line: string): Item | undefined {
  let value: unknown
  try { value = JSON.parse(line) } catch { return undefined }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  const turnOk = (t: unknown): t is number | null => t === null || (typeof t === 'number' && Number.isInteger(t))
  const time = typeof v['time'] === 'string' ? { time: v['time'] } : {}
  if (Array.isArray(v['text']) && v['text'].every((t) => typeof t === 'string') && turnOk(v['turn'])) return { kind: 'full', turn: v['turn'], ...time, text: v['text'] as string[] }
  if (typeof v['head'] === 'string' && typeof v['chars'] === 'number' && turnOk(v['turn'])) return { kind: 'index', turn: v['turn'], ...time, chars: v['chars'], head: v['head'] }
  const turns = v['turns']
  if (Array.isArray(turns) && turns.length === 2 && turns.every(turnOk) && typeof v['count'] === 'number') return { kind: 'range', from: turns[0] as number | null, to: turns[1] as number | null, count: v['count'] }
  return undefined
}

/** 逐字项降成清单项：留轮次、时间、总字数和开头 HEAD_CHARS 个字。 */
export function toIndex(item: Item & { kind: 'full' }): Item {
  const joined = item.text.join('\n')
  return { kind: 'index', turn: item.turn, ...(item.time === undefined ? {} : { time: item.time }), chars: joined.length, head: [...joined].slice(0, HEAD_CHARS).join('') }
}

/** 附录两部分的额度，按写出来的行长（含换行）算。 */
export interface Bound { fullChars: number; indexChars: number }

/**
 * 把附录压进固定长度：从最新往前逐字放，放满 fullChars 为止，更早的一律降成清单项（不跳着放，保持时间顺序）；
 * 清单部分超过 indexChars 就把最早的清单项并进最前面那行范围。单条比额度还长的也降成清单项。
 */
export function boundItems(items: readonly Item[], bound: Bound): Item[] {
  const out = [...items]
  let used = 0
  let cut = -1
  for (let i = out.length - 1; i >= 0; i--) {
    const item = out[i]!
    const size = itemLine(item).length + 1
    if (item.kind !== 'full' || used + size > bound.fullChars) { cut = i; break }
    used += size
  }
  for (let i = 0; i <= cut; i++) {
    const item = out[i]!
    if (item.kind === 'full') out[i] = toIndex(item)
  }
  const indexSize = () => out.reduce((n, item) => (item.kind === 'full' ? n : n + itemLine(item).length + 1), 0)
  while (indexSize() > bound.indexChars) {
    const first = out.findIndex((item) => item.kind === 'index')
    if (first < 0) break
    const item = out[first] as Item & { kind: 'index' }
    const at = out.findIndex((x) => x.kind === 'range')
    const range = (at < 0 ? { kind: 'range', from: null, to: null, count: 0 } : out[at]) as Item & { kind: 'range' }
    const pick = (a: number | null, b: number | null, f: (x: number, y: number) => number) => (a === null ? b : b === null ? a : f(a, b))
    const merged: Item = { kind: 'range', from: pick(range.from, item.turn, Math.min), to: pick(range.to, item.turn, Math.max), count: range.count + 1 }
    if (at < 0) out.splice(first, 1, merged)
    else { out[at] = merged; out.splice(first, 1) }
  }
  return out
}

/** 附录开头的说明：原文出处和取回方法。会话编号不知道时不写。 */
export interface Source { sessionId?: string; turns?: readonly [number, number] }

/** 附在摘要后面的那一块；没有用户原话时返回空串。 */
export function attachmentText(items: readonly Item[], source: Source = {}, historyReaderHint = ''): string {
  if (items.length === 0) return ''
  const notes: string[] = []
  if (source.sessionId !== undefined) {
    const span = source.turns === undefined ? '' : ` This checkpoint replaced turns ${source.turns[0]}-${source.turns[1]}; any original message, tool output, or reply from them can be read the same way.`
    const reader = historyReaderHint === ''
      ? `Originals stay in the session log for session "${source.sessionId}". Read them by turn with a session-history reader provided by your host; this plugin does not provide one.`
      : historyReaderHint.split('{sessionId}').join(source.sessionId)
    notes.push(`${reader}${span}`)
  }
  if (items.some((item) => item.kind !== 'full')) notes.push('Lines with "head" or "turns" are older user messages not attached in full; read them by turn before relying on their wording. A null turn has no known turn: search the original session log using its head if your host provides history search. If the required reader is unavailable, report that before relying on the exact wording.')
  return ['', HEADING, ...notes, OPEN_TAG, ...items.map(itemLine), CLOSE_TAG].join('\n')
}

/**
 * 把一整块文字当附录解析；必须整块恰好是 attachmentText 写出的样子，否则返回 undefined。
 * 上一版（全逐字、无轮次）和最早格式也认，项的轮次记为 null。
 */
export function parseAttachment(block: string): Item[] | undefined {
  const lines = block.split('\n')
  if (lines.length < 4 || lines[0] !== '' || lines.at(-1) !== CLOSE_TAG) return legacy(block)
  if (lines[1] === HEADING) {
    const open = lines.indexOf(OPEN_TAG, 2)
    if (open < 0 || lines.slice(2, open).some((line) => line.startsWith('{') || line === CLOSE_TAG)) return undefined
    const out: Item[] = []
    for (const line of lines.slice(open + 1, -1)) {
      const item = parseItem(line)
      if (item === undefined) return undefined
      out.push(item)
    }
    return out
  }
  if (lines[1] === V1_HEADING && lines[2] === V1_OPEN) {
    const out: Item[] = []
    for (const line of lines.slice(3, -1)) {
      let value: unknown
      try { value = JSON.parse(line) } catch { return undefined }
      if (!Array.isArray(value) || value.some((t) => typeof t !== 'string')) return undefined
      out.push({ kind: 'full', turn: null, text: value as string[] })
    }
    return out
  }
  return legacy(block)
}

function legacy(block: string): Item[] | undefined {
  const head = `\n${LEGACY_HEADING}\n${LEGACY_OPEN}\n<m>`
  const tail = `</m>\n${CLOSE_TAG}`
  if (!block.startsWith(head) || !block.endsWith(tail) || block.length < head.length + tail.length) return undefined
  return block.slice(head.length, block.length - tail.length).split('</m>\n<m>').map((item) => ({ kind: 'full', turn: null, text: [item.split('<\\/m>').join('</m>')] }))
}

/** 宿主写回的检查点消息里本插件附的那一块：模型摘要之后、`</compacted-summary>` 之前的最后一块。 */
export function carriedFromCheckpoint(message: MessageLike): Item[] {
  if (message.source?.kind !== CHECKPOINT_KIND || !Array.isArray(message.content)) return []
  const content = message.content as TextBlock[]
  if (content.length < 4 || content.at(-1)?.type !== 'text' || content.at(-1)?.text !== SUMMARY_CLOSE) return []
  const block = content.at(-2)
  if (block?.type !== 'text' || typeof block.text !== 'string') return []
  return parseAttachment(block.text) ?? []
}

/** 消息在会话里的位置：第几轮、什么时间（本地「月-日 时:分」）。 */
export interface Place { turn: number; time?: string }

interface EventLike { type?: string; time?: number; data?: { turn?: unknown; id?: unknown } }

function localTime(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 从会话事件里查每条消息（按消息 id）在第几轮。轮次号取自宿主 turn/start 事件的 turn 字段。 */
export function placesById(events: Iterable<EventLike | undefined>): Map<string, Place> {
  const out = new Map<string, Place>()
  let turn: number | undefined
  for (const event of events) {
    if (event === undefined) continue
    if (event.type === 'turn/start' && typeof event.data?.turn === 'number') turn = event.data.turn
    else if (turn !== undefined && typeof event.data?.id === 'string' && /\/message$/.test(event.type ?? '')) out.set(event.data.id, { turn, ...(typeof event.time === 'number' ? { time: localTime(event.time) } : {}) })
  }
  return out
}

/** 这次被压掉的消息覆盖的轮次范围；一条都对不上时返回 undefined。 */
export function turnSpan(messages: readonly unknown[], places: ReadonlyMap<string, Place>): [number, number] | undefined {
  let span: [number, number] | undefined
  for (const raw of messages) {
    const id = (raw as { id?: unknown })?.id
    const place = typeof id === 'string' ? places.get(id) : undefined
    if (place === undefined) continue
    span = span === undefined ? [place.turn, place.turn] : [Math.min(span[0], place.turn), Math.max(span[1], place.turn)]
  }
  return span
}

/**
 * 这次要附的全部项，按重放顺序：旧检查点附过的先接上，再是这段里用户新发的（逐字，带轮次）。
 * 只凭宿主标的来源：`user` 是用户亲手发的，逐块原样收；`compact-checkpoint` 只读插件附的那一块。
 * 其余来源（提醒、通知、工具结果、模型回复）里就算出现同样的标记也不收。
 */
export function collectUserMessages(messages: readonly unknown[], places: ReadonlyMap<string, Place> = new Map()): Item[] {
  const out: Item[] = []
  for (const raw of messages) {
    const message = raw as MessageLike & { id?: unknown }
    if (message?.role !== 'user') continue
    const kind = message.source?.kind
    if (kind === CHECKPOINT_KIND) out.push(...carriedFromCheckpoint(message))
    else if (kind === 'user') {
      const texts = textBlocks(message)
      if (texts.length === 0) continue
      const place = typeof message.id === 'string' ? places.get(message.id) : undefined
      out.push({ kind: 'full', turn: place?.turn ?? null, ...(place?.time === undefined ? {} : { time: place.time }), text: texts })
    }
  }
  return out
}

/**
 * 就地换掉指令。`llm/stream` 瀑布的 next() 不接受新参数，下游读的是同一个 options 对象，只能就地改；
 * 宿主每次都现建这个对象，冻结了就不换。
 * @returns 'replaced' 已换；'skipped' 不是写摘要请求；'unrecognized' 是写摘要请求但认不出指令或对象不可改
 */
export function rewriteRequest(options: RequestLike, budgetChars: number): 'replaced' | 'skipped' | 'unrecognized' {
  if (options.purpose !== 'compaction') return 'skipped'
  const index = stockInstructionIndex(options)
  if (index < 0 || Object.isFrozen(options)) return 'unrecognized'
  const messages = [...(options.messages as readonly unknown[])]
  const last = messages[index] as MessageLike
  messages[index] = Object.freeze({ ...last, content: Object.freeze([Object.freeze({ type: 'text', text: boundedInstruction(budgetChars) })]) })
  ;(options as { messages: readonly unknown[] }).messages = Object.freeze(messages)
  return 'replaced'
}

interface ParsedSection { title: string; body: string }

/** 按 `## ` 标题切栏；模型有时把「(at most N characters)」也抄进标题，去掉再比。 */
export function sectionsOf(text: string): ParsedSection[] {
  const out: ParsedSection[] = []
  for (const line of text.split('\n')) {
    const match = /^## (.+?)(?:\s*\(at most \d+ characters\))?\s*$/.exec(line)
    if (match) out.push({ title: match[1]!, body: '' })
    else if (out.length > 0) out.at(-1)!.body += `${line}\n`
  }
  return out
}

/** 压短稿能不能替换原稿：在上限内、栏目一个不少且顺序不变、「用户要求」栏逐字不变。能用返回 undefined，否则返回原因。 */
export function rejectCondensed(original: string, condensed: string, limit: number): string | undefined {
  if (condensed.length > limit) return `压短稿 ${condensed.length} 字仍超上限 ${limit}`
  const before = sectionsOf(original)
  const after = sectionsOf(condensed)
  const requirements = before.find((s) => s.title === REQUIREMENTS_TITLE)
  if (requirements === undefined) return '原稿没有用户要求栏，无法核对压短稿是否丢要求'
  if (before.map((s) => s.title).join('\n') !== after.map((s) => s.title).join('\n')) return '压短稿栏目和原稿不一致'
  if (after.find((s) => s.title === REQUIREMENTS_TITLE)!.body.trim() !== requirements.body.trim()) return '压短稿改动了用户要求栏'
  return undefined
}

/** 让模型压短超限摘要的那条消息。只给这份摘要，不重放对话，输入很小。 */
export function condenseInstruction(original: string, limit: number): string {
  return [
    `The checkpoint below is ${original.length} characters; it must be under ${limit}. Rewrite it shorter.`,
    `- Keep every "## " heading, in the same order, with the same title text.`,
    `- Copy the "## ${REQUIREMENTS_TITLE}" section exactly, character for character.`,
    '- Shorten only the other sections: drop resolved, superseded, or reconstructible detail; keep exact paths, commands, identifiers, numbers, and hashes that remain.',
    '- Output only the rewritten checkpoint, with no preface.',
    '',
    '<checkpoint>',
    original,
    '</checkpoint>',
  ].join('\n')
}

interface ChunkLike { type: string; index?: number; text?: string; blockType?: string; block?: { type?: string; text?: string }; reason?: { kind?: string } }

/** 模型写完后的处理结果，写进状态文件备查。 */
export interface OutputReport {
  outcome: 'within' | 'condensed' | 'over-kept' | 'failed'
  modelChars: number
  limit: number
  condensedChars?: number
  reason?: string
}

/** 压短：成功返回新稿，失败返回 undefined（调用方保证最多调一次）。 */
export type Condense = (original: string, limit: number) => Promise<string | undefined>

const isTextChunk = (chunk: ChunkLike, textIndices: Set<number>) =>
  chunk.type === 'text-delta' || (chunk.type === 'block-start' && chunk.blockType === 'text') || (chunk.type === 'block-end' && chunk.block?.type === 'text') ||
  ((chunk.type === 'block-start' || chunk.type === 'block-end') && typeof chunk.index === 'number' && textIndices.has(chunk.index))

/** 按宿主 BlockAssembler 的口径取模型写的正文：各文本块以 block-end 为准，没有就拼增量。 */
function modelText(chunks: readonly ChunkLike[]): { text: string; textIndices: Set<number> } {
  const order: number[] = []
  const deltas = new Map<number, string>()
  const ended = new Map<number, string>()
  for (const chunk of chunks) {
    if (typeof chunk.index !== 'number' || !isTextChunk(chunk, new Set())) continue
    if (!deltas.has(chunk.index)) { order.push(chunk.index); deltas.set(chunk.index, '') }
    if (chunk.type === 'text-delta') deltas.set(chunk.index, deltas.get(chunk.index)! + (chunk.text ?? ''))
    if (chunk.type === 'block-end' && !ended.has(chunk.index)) ended.set(chunk.index, chunk.block?.text ?? '')
  }
  return { text: order.map((i) => ended.get(i) ?? deltas.get(i)!).join(''), textIndices: new Set(order) }
}

function* textBlock(index: number, text: string): Generator<unknown> {
  yield { type: 'block-start', index, blockType: 'text' }
  yield { type: 'text-delta', index, text }
  yield { type: 'block-end', index, block: { type: 'text', text } }
}

/**
 * 包住写摘要的输出流。先收齐（宿主本来也要等写完才落地），再按结束原因处理：
 * - 出错、取消、写到回复上限：原样透传，不附原话，宿主照常判失败；
 * - 正文不超 limit：原样放出，后面附原话；
 * - 超了：调一次 condense，压短稿过了 rejectCondensed 就替换正文；不过就保留原稿、记 over-kept。
 *   不截断、不重试第二次。
 */
export async function* checkOutput(stream: AsyncIterable<unknown>, attachment: string, limit: number, condense: Condense, onReport: (report: OutputReport) => void): AsyncGenerator<unknown> {
  const chunks: ChunkLike[] = []
  let finish: ChunkLike | undefined
  for await (const raw of stream) {
    const chunk = raw as ChunkLike
    if (chunk?.type === 'finish') { finish = chunk; break }
    chunks.push(chunk)
  }
  const kind = finish?.reason?.kind
  const { text, textIndices } = modelText(chunks)
  if (kind === 'error' || kind === 'aborted' || kind === 'max-tokens') {
    onReport({ outcome: 'failed', modelChars: text.length, limit, reason: String(kind) })
    yield* chunks
    if (finish !== undefined) yield finish
    return
  }
  let maxIndex = -1
  for (const chunk of chunks) if (typeof chunk.index === 'number' && chunk.index > maxIndex) maxIndex = chunk.index
  let replacement: string | undefined
  if (text.length <= limit) onReport({ outcome: 'within', modelChars: text.length, limit })
  else {
    let condensed: string | undefined
    let reason: string | undefined
    try {
      condensed = await condense(text, limit)
      reason = condensed === undefined ? '压短请求没有正常写完' : rejectCondensed(text, condensed, limit)
    } catch (error) {
      reason = `压短请求失败：${error instanceof Error ? error.message : String(error)}`
    }
    if (reason === undefined) {
      replacement = condensed
      onReport({ outcome: 'condensed', modelChars: text.length, limit, condensedChars: condensed!.length })
    } else onReport({ outcome: 'over-kept', modelChars: text.length, limit, ...(condensed === undefined ? {} : { condensedChars: condensed.length }), reason })
  }
  if (replacement === undefined) yield* chunks
  else {
    for (const chunk of chunks) if (!isTextChunk(chunk, textIndices)) yield chunk
    yield* textBlock(++maxIndex, replacement)
  }
  if (attachment.length > 0) yield* textBlock(++maxIndex, attachment)
  if (finish !== undefined) yield finish
}