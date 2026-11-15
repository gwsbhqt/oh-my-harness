import { live } from '../../tooling/runtime/live.mjs'
import { createMethodPatcher } from '../../tooling/runtime/method-patch.mjs'
/**
 * dsh-session-link：引用另一个会话时不再整份复制，只给线索；模型用三个工具按需去读。
 * 浏览器半（`src/client/`）在会话头栏放「复制深链」按钮，复制本会话的引用链接给别的会话用。
 *
 * ## 为什么要替换官方的引用
 *
 * 官方 `dsh-session-reference` 在用户消息里认出 `dsh-session:` 引用后，把被引用会话的对话整份
 * 塞进新会话（每个来源最多上下文窗口的 20%）。有次用户只是想让新会话「去看看那个会话」，
 * 结果大量内容连同源会话里惹模型拒答的压缩检查点一起进了新会话，第一句话就被拒，
 * 连修的机会都没有。
 *
 * ## 怎么替换
 *
 * 官方服务在 `agent/pre-step` 里调自己的 `prepare()` 生成那条快照消息。这里在服务实例上把
 * `prepare` 换掉（实例自有属性遮住原型上的原实现，卸载时换回），换成只读被引用会话的原始日志、
 * 算出几行线索。`@` 补全候选、引用文字改写、消息落盘的位置都还是官方的，界面照常显示「引用了哪个会话」。
 * 官方那份快照一个字都不会生成、不会发出去。
 *
 * 服务是 cordis 代理：代理没有 defineProperty 拦截，`Object.defineProperty` 直接落到实例上，
 * 官方监听器里的 `this.prepare(...)` 走的就是这里的版本。用的是共用的 `tooling/runtime/method-patch.mjs`，
 * 和 dsh-image-cap、dsh-settings 同一份实现，原因见那边：原实现要在装之前取好，不能调用时再取。
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import { pointerSource, pointerText, UNTRUSTED, type PointerSource } from './pointer.ts'
import { buildTranscript, readTurn, renderItem, search, turnLine, type RawEvent, type Transcript } from './transcript.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'session-reference': ReturnType<typeof pointerSource>
  }
}

export const name = 'dsh-session-link'
export const inject = ['tools', 'sessionQuery']

export const Config = z.object({
  /** 替换官方引用：只给线索、不复制内容。关掉就退回官方整份复制。 */
  replaceReferences: z.boolean().default(true).volatile(),
})

type ConfigCells = ReturnType<typeof Config>

// ---- 宿主接口（只写用到的部分）----

interface SessionHeader {
  id: string
  cwd?: string
  createdAt?: number
  version?: number
}

interface SessionRecord {
  header: SessionHeader
}

export interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<readonly SessionRecord[]>
  observeSession(sessionId: string, options?: { signal?: AbortSignal; projectionMode?: 'none' }): Promise<{
    readonly source: 'live' | 'prepared'
    readonly header: SessionHeader
    readonly events: readonly RawEvent[]
    readonly cursor: number
    readonly revision?: string
    [Symbol.dispose](): void
  }>
}

interface Reference {
  sessionId: string
  label?: string
}

interface AgentLike {
  id?: string
  session?: { id?: string }
}

// 0.2.2-rc.1 起宿主在 references 和 signal 之间多传一个 route（按模型容量定预览大小），之前没有；取消信号总在最后。
type Prepare = (this: unknown, agent: AgentLike, content: unknown, references: readonly Reference[], ...rest: unknown[]) => Promise<{
  content: unknown
  additionalContext?: unknown
}>

// ---- 读会话 ----

/**
 * 模型给的会话标识换成真实 id：完整 id、去掉 `session-` 的部分、开头几位（至少 6 位）、
 * `dsh-session:` URI 或 `@[label](dsh-session:…)` 都认。对不上或对上多个时报错并列出候选。
 */
export async function resolveSessionId(query: SessionQueryLike, raw: string, signal?: AbortSignal): Promise<string> {
  let wanted = raw.trim()
  const uri = /dsh-session:([A-Za-z0-9_-]+)/.exec(wanted)
  if (uri !== null) {
    try {
      const decoded = JSON.parse(Buffer.from(uri[1]!, 'base64url').toString('utf8')) as unknown
      if (typeof decoded === 'string') wanted = decoded
    } catch { /* 不是 base64url JSON，按原文找 */ }
  }
  const records = await query.listSessions(signal)
  const ids = records.map(r => r.header.id)
  if (ids.includes(wanted)) return wanted
  const bare = wanted.replace(/^session-/, '').toLowerCase()
  if (bare.length < 6) throw new Error(`session "${raw}" is too short to identify; give at least 6 characters of its id`)
  const matches = ids.filter(id => id.replace(/^session-/, '').toLowerCase().startsWith(bare))
  if (matches.length === 1) return matches[0]!
  if (matches.length === 0) throw new Error(`no session matches "${raw}"`)
  throw new Error(`"${raw}" matches ${matches.length} sessions: ${matches.slice(0, 8).join(', ')}`)
}

/** 同一会话日志没变就复用上次整理的结果：模型往往会连着读同一个会话好几次。 */
class TranscriptCache {
  private entry: { id: string; revision: string; cursor: number; events: readonly RawEvent[]; value: { header: SessionHeader; transcript: Transcript; lastSeq: number | null } } | undefined

  private readonly query: SessionQueryLike

  constructor(query: SessionQueryLike) { this.query = query }

  async get(sessionId: string, signal?: AbortSignal) {
    const observation = await this.query.observeSession(sessionId, { ...(signal === undefined ? {} : { signal }), projectionMode: 'none' })
    try {
      signal?.throwIfAborted()
      const { source, revision, cursor } = observation
      const events = observation.events
      const e = this.entry
      if (source === 'prepared' && revision !== undefined && e !== undefined && e.id === sessionId && e.revision === revision && e.cursor === cursor && e.events === events) return e.value
      const value = { header: structuredClone(observation.header), transcript: buildTranscript(events), lastSeq: cursor < 0 ? null : cursor }
      this.entry = source === 'prepared' && revision !== undefined ? { id: sessionId, revision, cursor, events, value } : undefined
      return value
    } finally {
      observation[Symbol.dispose]()
    }
  }
}

// ---- 替换官方 prepare ----

/** 把实例上的一个方法换成补丁，返回卸载函数；方法不存在返回 undefined。层标记是 `Symbol.for('dsh-session-link.layer')`。 */
export const installLayer = createMethodPatcher('dsh-session-link')

/**
 * 替代官方 `prepare()`：同样返回「改写后的用户消息 + 一条紧跟其后的 session-reference 消息」，
 * 只是那条消息里只有线索。读不到某个会话不让整条消息失败，线索里写明读不到。
 */
export function pointerPrepare(
  original: Prepare,
  query: SessionQueryLike,
  enabled: () => boolean,
  onPrepared?: (count: number) => void,
): Prepare {
  return async function preparePointer(this: unknown, agent, content, references, ...rest) {
    if (!enabled()) return original.call(this, agent, content, references, ...rest)
    const last = rest.at(-1)
    const signal = last instanceof AbortSignal ? last : undefined
    signal?.throwIfAborted()
    const accepted = structuredClone(content)
    const self = agent.id ?? agent.session?.id
    const seen = new Set<string>()
    const inputs: Reference[] = []
    for (const r of references) {
      if (typeof r?.sessionId !== 'string' || (r.label !== undefined && typeof r.label !== 'string')) {
        throw new Error('session reference must contain a sessionId and optional string label')
      }
      if (r.sessionId === self) throw new Error('a session cannot reference itself')
      if (seen.has(r.sessionId)) continue
      seen.add(r.sessionId)
      inputs.push(r)
    }
    if (inputs.length === 0) return { content: accepted }
    const configured = (this as { config?: { maxReferences?: number } } | undefined)?.config?.maxReferences
    const maxReferences = typeof configured === 'number' ? configured : 8
    if (inputs.length > maxReferences) throw new Error(`a message may reference at most ${maxReferences} sessions`)
    const sources: PointerSource[] = await Promise.all(inputs.map(async (r): Promise<PointerSource> => {
      const label = r.label ?? r.sessionId
      try {
        const observation = await query.observeSession(r.sessionId, { ...(signal === undefined ? {} : { signal }), projectionMode: 'none' })
        try {
          signal?.throwIfAborted()
          return {
            sessionId: r.sessionId,
            label,
            cwd: observation.header.cwd,
            createdAt: observation.header.createdAt,
            formatVersion: observation.header.version,
            capturedThroughSeq: observation.cursor < 0 ? null : observation.cursor,
            transcript: buildTranscript(observation.events),
          }
        } finally {
          observation[Symbol.dispose]()
        }
      } catch (error) {
        if (signal?.aborted === true) throw error
        return { sessionId: r.sessionId, label, capturedThroughSeq: null, error: error instanceof Error ? error.message : String(error) }
      }
    }))
    signal?.throwIfAborted()
    onPrepared?.(sources.length)
    return {
      content: accepted,
      additionalContext: createUserMessage({
        source: pointerSource(sources),
        content: [{ type: 'text', text: pointerText(sources) }],
      }),
    }
  } as Prepare
}

// ---- 工具 ----

const TEXT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    text: { type: 'string', required: true },
    next_offset: { type: 'integer' },
    next_char_offset: { type: 'integer' },
  },
} as const

const SESSION_PARAM = {
  type: 'string',
  required: true,
  description: 'Session id: the full id, or at least its first 6 characters after "session-" (e.g. "0123abcd"), or a dsh-session: URI.',
} as const

export function registerTools(ctx: Context, query: SessionQueryLike): void {
  const cache = new TranscriptCache(query)
  const tools = (ctx as unknown as { tools: { register(def: unknown): void } }).tools

  tools.register(defineTool({
    name: 'session_overview',
    description: [
      'Overview of another DSH session: title, working directory, and one line per turn — what the user asked,',
      'how many steps and tool calls it took, and how the turn ended (including error codes such as REFUSAL or EMPTY_RESPONSE).',
      'Use it first when the user points you at a session. Read details with session_turn.',
      UNTRUSTED,
    ].join(' '),
    parameters: {
      session: SESSION_PARAM,
      from_turn: { type: 'integer', description: 'First turn to list. Defaults to the start; long sessions list 60 turns per call.' },
    },
    output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value.text }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const id = await resolveSessionId(query, args.session, exec.signal)
      const { header, transcript } = await cache.get(id, exec.signal)
      const from = Math.max(1, args.from_turn ?? 1)
      const listed = transcript.turns.filter(t => t.turn >= from).slice(0, 60)
      const head = [
        `session ${id}${transcript.title === undefined ? '' : ` · "${transcript.title}"`}`,
        `cwd ${header.cwd ?? '(unknown)'} · ${transcript.turns.length} turns · ${transcript.items.length} records`,
        '',
      ]
      const lines = listed.map(t => turnLine(t))
      const last = listed.at(-1)
      const more = last !== undefined && transcript.turns.some(t => t.turn > last.turn)
      if (more) lines.push(`… more turns: call again with from_turn=${last.turn + 1}`)
      return { text: [...head, ...lines].join('\n') || '(empty session)' }
    },
  }))

  tools.register(defineTool({
    name: 'session_turn',
    description: [
      'Read one turn of another DSH session in order: user messages, assistant replies, tool calls with their',
      'arguments, tool results (errors marked), failed model requests, and how the turn ended. Model reasoning is not included.',
      'Long turns are paged: pass next_offset back as offset. Each record is cut at item_chars. To read a long record completely, pass its offset and char_offset=0, then next_char_offset.',
      'Injected background (skill lists, compaction checkpoints, other sessions\' snapshots) is only named with its size unless include_injected is true.',
      UNTRUSTED,
    ].join(' '),
    parameters: {
      session: SESSION_PARAM,
      turn: { type: 'integer', required: true, description: 'Turn number, from session_overview or session_grep.' },
      offset: { type: 'integer', description: 'Record index within the turn to start from. Defaults to 0.' },
      char_offset: { type: 'integer', description: 'Read only the record at offset, starting at this character in its rendered text. Start at 0 to read a long record without truncation, then pass next_char_offset. Omit for normal multi-record paging.' },
      max_chars: { type: 'integer', description: 'Character budget for this page. Defaults to 12000.' },
      item_chars: { type: 'integer', description: 'Maximum characters shown per record. Defaults to 2000.' },
      include_injected: { type: 'boolean', description: 'Show injected background content instead of naming it. Defaults to false.' },
    },
    output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value.text }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const id = await resolveSessionId(query, args.session, exec.signal)
      const { transcript } = await cache.get(id, exec.signal)
      if (!transcript.turns.some(t => t.turn === args.turn)) {
        const range = transcript.turns.length === 0 ? 'it has no turns' : `turns are 1–${transcript.turns.at(-1)!.turn}`
        return { text: `session ${id} has no turn ${args.turn}; ${range}` }
      }
      const pageBudget = Math.min(50_000, Math.max(1000, args.max_chars ?? 12_000))
      // 翻页提示也计入返回上限，预留空间避免正文填满后再溢出。
      const contentBudget = pageBudget - 320
      if (args.char_offset !== undefined) {
        const records = transcript.items.filter(i => i.turn === args.turn)
        const offset = Math.max(0, args.offset ?? 0)
        const record = records[offset]
        if (record === undefined) return { text: `turn ${args.turn} has no record at offset ${offset}` }
        const rendered = renderItem(record, { itemChars: record.text.length, includeInjected: args.include_injected === true })
        const start = Math.max(0, args.char_offset)
        const end = Math.min(rendered.length, start + contentBudget)
        const more = end < rendered.length
        return {
          text: rendered.slice(start, end) + `\n\n[turn ${args.turn}, record ${offset}, ${record.kind}: ${more ? `continue with offset=${offset}, char_offset=${end}` : 'end of record'}]`,
          ...(more ? { next_char_offset: end } : {}),
        }
      }
      const page = readTurn(transcript, args.turn, args.offset ?? 0, contentBudget, {
        itemChars: Math.min(50_000, Math.max(200, args.item_chars ?? 2000)),
        includeInjected: args.include_injected === true,
      })
      const footer = page.nextOffset === undefined
        ? `\n\n[end of turn ${args.turn}: ${page.total} records]`
        : `\n\n[turn ${args.turn}: showing records ${args.offset ?? 0}–${page.nextOffset - 1} of ${page.total}; continue with offset=${page.nextOffset}]`
      const detailHint = '\n[For a truncated record, read its offset with char_offset=0 and continue with next_char_offset.]'
      return { text: page.text + footer + detailHint, ...(page.nextOffset === undefined ? {} : { next_offset: page.nextOffset }) }
    },
  }))

  tools.register(defineTool({
    name: 'session_grep',
    description: [
      'Search another DSH session for literal text (case-insensitive, whitespace-flexible) across user messages,',
      'assistant replies, tool calls, tool results and errors. Each hit gives the turn and the offset to pass to session_turn.',
      UNTRUSTED,
    ].join(' '),
    parameters: {
      session: SESSION_PARAM,
      query: { type: 'string', required: true, description: 'Text to find.' },
      limit: { type: 'integer', description: 'Maximum hits to return. Defaults to 20.' },
      include_injected: { type: 'boolean', description: 'Also search injected background content. Defaults to false.' },
    },
    output: { schema: TEXT_OUTPUT, render: (_args, value) => [{ type: 'text', text: value.text }] },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (args.query.length > 2000) throw new Error('search query must be at most 2000 characters')
      const id = await resolveSessionId(query, args.session, exec.signal)
      const { transcript } = await cache.get(id, exec.signal)
      const { hits, total } = search(transcript, args.query, Math.min(100, Math.max(1, args.limit ?? 20)), args.include_injected === true)
      if (total === 0) return { text: `no match for "${args.query}" in session ${id}` }
      const lines = hits.map(h => `turn ${h.turn} · offset ${h.offset} · ${h.kind}${h.label === undefined ? '' : ` ${h.label}`} · seq ${h.seq}\n    ${h.snippet}`)
      if (total > hits.length) lines.push(`… ${total - hits.length} more hits; raise limit or narrow the query`)
      return { text: `${total} hit${total === 1 ? '' : 's'} in session ${id}\n\n${lines.join('\n')}` }
    },
  }))
}

export function apply(ctx: Context, config: ConfigCells): void {
  const logger = ctx.logger(name)

  const query = (ctx as unknown as { sessionQuery: SessionQueryLike }).sessionQuery
  registerTools(ctx, query)

  ctx.inject(['sessionReferenceResolver'], (scoped: Context) => {
    const resolver = scoped.get('sessionReferenceResolver') as object | undefined
    if (resolver === undefined) return
    const restore = installLayer<Prepare>(resolver, 'prepare', original => pointerPrepare(
      original,
      query,
      () => live(config.replaceReferences) as boolean,
      count => logger.debug(`会话引用只给线索：${count} 个会话`),
    ))
    if (restore === undefined) {
      logger.warn('sessionReferenceResolver 上没有 prepare（DSH 内部结构可能变了）：引用会退回官方的整份复制')
      return
    }
    scoped.effect(() => restore)
  })
}
