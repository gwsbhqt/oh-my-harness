/**
 * 指令只发差异：会话中途改了 AGENTS.md，只发改动的行，不再重发全文。
 *
 * ## 现象
 *
 * `dsh-agent-instructions` 发现指令文件变了，就把**新版全文**以
 * 「Updated instructions from: AGENTS.md … Use the following content instead」
 * 重新发一遍。即使只改一个词，整份规则也会重新进入上下文。
 *
 * ## 做法
 *
 * 在 `agent/pre-step` 的最外层（`prepend`，才能看到宿主插件塞进来的消息）：
 *
 * - 看到指令文件的全文（首次加载、追加、更新），按 agent 缓存「这个会话里模型
 *   已经看到的那一版」。
 * - 看到「Updated instructions from: X」时，拿缓存的上一版和新版做行级 diff，
 *   把这一段正文换成 unified diff；缓存换成新版。
 *
 * 以下情况照旧发全文，宁可多花 token 也不让模型拿到不完整的指令：
 * 缓存里没有上一版（会话恢复、插件晚加载）；上一版或新版被预算截断/省略；
 * diff 超过全文的 `maxDiffRatio`；文件太大、行级 diff 算不动。
 *
 * `source` 原样保留：宿主靠 `source.changes` 里的摘要判断「已经送达过什么」，
 * 不看正文，所以改写正文不会让它重发。
 *
 * ## 删除条件
 *
 * 上游在指令更新时只发差异（或提供这样的选项）时，删掉这一项（本文件、`index.ts` 里对应的一行和开关）。
 *
 * @module
 */

const OPEN = '<system-reminder>\n'
const CLOSE = '\n</system-reminder>'
const UPDATED_LEAD = 'This file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.'
const DIFF_LEAD = 'This file changed after it was loaded. Only the changed lines are shown, as a unified diff against the version already in this conversation (`-` removed, `+` added, other lines unchanged context); every line not shown is unchanged.'
const HEADER = /(?:^|\n\n)(Instructions from|Additional instructions from|Updated instructions from|Instructions removed): ([^\n]+)\n\n/g
/** Past this many cells the O(n·m) line diff is not worth it: send the full text. */
const MAX_DIFF_CELLS = 4_000_000

/** 一段指令：标题种类、路径、以及正文里「文件内容」的那一截。 */
export interface Section {
  kind: 'Instructions from' | 'Additional instructions from' | 'Updated instructions from' | 'Instructions removed'
  path: string
  /** Header through the end of this section, verbatim. */
  raw: string
  /** Offset of `raw` within the message body. */
  start: number
  /** The file's content as rendered (after any fixed lead sentence). */
  content: string
  /** Fixed text between header and content (lead sentence), verbatim. */
  lead: string
}

/**
 * 拆出一条指令消息里的各段。拆不出来返回空数组，调用方就原样放行。
 */
export function parseSections(body: string): Section[] {
  const heads: Array<{ index: number; headEnd: number; kind: Section['kind']; path: string }> = []
  for (const m of body.matchAll(HEADER)) {
    const index = m.index + (m[0].startsWith('\n\n') ? 2 : 0)
    heads.push({ index, headEnd: m.index + m[0].length, kind: m[1] as Section['kind'], path: m[2]! })
  }
  return heads.map((head, i) => {
    const end = i + 1 < heads.length ? heads[i + 1]!.index - 2 : body.length
    const raw = body.slice(head.index, end)
    const rest = body.slice(head.headEnd, end)
    let lead = ''
    let content = rest
    if (head.kind === 'Updated instructions from' && rest.startsWith(UPDATED_LEAD)) {
      lead = UPDATED_LEAD
      content = rest.slice(UPDATED_LEAD.length).replace(/^\n\n/, '')
    } else if (head.kind === 'Additional instructions from') {
      const cut = rest.indexOf('\n\n')
      lead = cut === -1 ? rest : rest.slice(0, cut)
      content = cut === -1 ? '' : rest.slice(cut + 2)
    }
    return { kind: head.kind, path: head.path, raw, start: head.index, content, lead }
  })
}

/** 预算截断或省略掉的路径（出现在消息开头的预算标记里）。 */
export function budgetCut(body: string): Set<string> {
  const cut = new Set<string>()
  const marker = /Workspace instruction budget \d+ bytes: ([^\n]*)/.exec(body)
  if (marker === null) return cut
  for (const part of marker[1]!.split('; ')) {
    if (part.startsWith('omitted ')) {
      for (const p of part.slice('omitted '.length).split(', ')) cut.add(p.trim())
    } else if (part.startsWith('truncated ')) {
      for (const item of part.slice('truncated '.length).split(', ')) {
        cut.add(item.replace(/ from \d+ to \d+ bytes$/, '').trim())
      }
    }
  }
  return cut
}

/**
 * 行级 unified diff。先剥掉首尾相同的行（改一两行时几乎零开销），再对中间
 * 部分做最长公共子序列。太大算不动时返回 undefined。
 *
 * @returns 只含 hunk 的 diff 文本（不含 ---/+++ 文件头）；相同时返回空串
 */
export function unifiedDiff(before: string, after: string, context = 2): string | undefined {
  const a = before.split('\n')
  const b = after.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const am = a.slice(head, a.length - tail)
  const bm = b.slice(head, b.length - tail)
  if (am.length === 0 && bm.length === 0) return ''
  if ((am.length + 1) * (bm.length + 1) > MAX_DIFF_CELLS) return undefined

  // LCS table over the differing middle.
  const w = bm.length + 1
  const lcs = new Uint32Array((am.length + 1) * w)
  for (let i = am.length - 1; i >= 0; i--) {
    for (let j = bm.length - 1; j >= 0; j--) {
      lcs[i * w + j] = am[i] === bm[j] ? lcs[(i + 1) * w + j + 1]! + 1 : Math.max(lcs[(i + 1) * w + j]!, lcs[i * w + j + 1]!)
    }
  }
  type Op = { t: ' ' | '-' | '+'; line: string; ai: number; bi: number }
  const ops: Op[] = []
  for (let k = 0; k < head; k++) ops.push({ t: ' ', line: a[k]!, ai: k, bi: k })
  let i = 0
  let j = 0
  while (i < am.length || j < bm.length) {
    if (i < am.length && j < bm.length && am[i] === bm[j]) {
      ops.push({ t: ' ', line: am[i]!, ai: head + i, bi: head + j }); i++; j++
    } else if (i < am.length && (j === bm.length || lcs[(i + 1) * w + j]! >= lcs[i * w + j + 1]!)) {
      ops.push({ t: '-', line: am[i]!, ai: head + i, bi: head + j }); i++
    } else {
      ops.push({ t: '+', line: bm[j]!, ai: head + i, bi: head + j }); j++
    }
  }
  for (let k = 0; k < tail; k++) {
    const ai = a.length - tail + k
    const bi = b.length - tail + k
    ops.push({ t: ' ', line: a[ai]!, ai, bi })
  }

  // Group changes into hunks with `context` lines around them.
  const changed = ops.map((op, k) => (op.t === ' ' ? -1 : k)).filter((k) => k >= 0)
  const hunks: string[] = []
  let k = 0
  while (k < changed.length) {
    const from = Math.max(0, changed[k]! - context)
    let to = Math.min(ops.length - 1, changed[k]! + context)
    while (k + 1 < changed.length && changed[k + 1]! - context <= to + 1) {
      k++
      to = Math.min(ops.length - 1, changed[k]! + context)
    }
    k++
    const slice = ops.slice(from, to + 1)
    const aStart = slice[0]!.ai + 1
    const bStart = slice[0]!.bi + 1
    const aLen = slice.filter((op) => op.t !== '+').length
    const bLen = slice.filter((op) => op.t !== '-').length
    hunks.push(`@@ -${aLen === 0 ? aStart - 1 : aStart},${aLen} +${bLen === 0 ? bStart - 1 : bStart},${bLen} @@`)
    for (const op of slice) hunks.push(`${op.t}${op.line}`)
  }
  return hunks.join('\n')
}

/** diff 的取舍参数。 */
export interface DiffOptions {
  /** diff 超过全文这个比例时照旧发全文。 */
  readonly maxDiffRatio: number
  /** diff 每处改动前后保留几行原文。 */
  readonly contextLines: number
}

/** 进入一步的消息里本插件关心的那部分形状。 */
export interface MessageLike {
  readonly role: string
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>
  readonly source?: { readonly kind?: string } & Record<string, unknown>
  readonly [key: string]: unknown
}

/**
 * 在临时副本上处理一条指令消息，能省就把「Updated」段换成 diff。
 *
 * @param message - 这一步要进入对话的一条消息
 * @param seen - 从已提交基准复制的临时记录，会被就地更新；不能直接传入已送达记录
 * @param config - 当前配置
 * @returns 改好的新消息；无需改动时原样返回
 */
export function condense<M extends MessageLike>(message: M, seen: Map<string, string>, config: DiffOptions): M {
  if (message.role !== 'user' || message.source?.kind !== 'agent-instructions') return message
  let changed = false
  const content = message.content.map((block) => {
    if (block.type !== 'text' || block.text === undefined) return block
    const text = block.text
    if (!text.startsWith(OPEN) || !text.endsWith(CLOSE)) return block
    const body = text.slice(OPEN.length, text.length - CLOSE.length)
    const cut = budgetCut(body)
    let out = body
    // Walk back to front so earlier offsets stay valid while splicing.
    for (const section of parseSections(body).reverse()) {
      const { kind, path } = section
      if (kind === 'Instructions removed') {
        seen.delete(path)
        continue
      }
      if (cut.has(path)) {
        seen.delete(path)
        continue
      }
      const previous = seen.get(path)
      seen.set(path, section.content)
      if (kind !== 'Updated instructions from' || previous === undefined || section.lead !== UPDATED_LEAD) continue
      const diff = unifiedDiff(previous, section.content, config.contextLines)
      // 无差异时保留全文；不生成无法独立恢复指令内容的空补丁。
      if (diff === undefined || diff === '' || diff.length > section.content.length * config.maxDiffRatio) continue
      const replacement = `${kind}: ${path}\n\n${DIFF_LEAD}\n\n` + '```diff\n' + diff + '\n```'
      out = out.slice(0, section.start) + replacement + out.slice(section.start + section.raw.length)
      changed = true
    }
    return out === body ? block : { ...block, text: OPEN + out + CLOSE }
  })
  return changed ? { ...message, content } : message
}

function instructionKey(message: MessageLike): string | undefined {
  if (message.role !== 'user' || message.source?.kind !== 'agent-instructions') return undefined
  // 宿主提交时深拷贝消息；不能用对象身份确认是哪条待送达指令。
  return JSON.stringify([message.content, message.source])
}

/*
 * dsh-prompt-prefix 把与固定内容相同的工作规范基线换成一句指针，原文进了系统提示词，模型照样看得到。
 * 两个插件都挂 `agent/pre-step` 外层，谁在外面取决于加载先后：它在里面时，指针消息对应的原消息记在这张表里；
 * 它在外面时，提交的是指针，`source` 原样保留。原消息不能挂在指针消息上：宿主记录消息时遇到符号键整轮报错。
 */
const PINNED_ORIGINALS = ((globalThis as Record<symbol, unknown>)[Symbol.for('dsh-prompt-prefix.originals')] ??= new WeakMap()) as WeakMap<object, unknown>
const PINNED_POINTER = /<!-- prompt-prefix pin=[0-9a-f]{32} -->/

function pinnedOriginal(message: MessageLike): MessageLike | undefined {
  const original = PINNED_ORIGINALS.get(message)
  return typeof original === 'object' && original !== null ? original as MessageLike : undefined
}

function isPinnedPointer(message: MessageLike): boolean {
  if (message.source?.['baseline'] !== true) return false
  return message.content.some((block) => block.type === 'text' && PINNED_POINTER.test(block.text ?? ''))
}

/** 只有宿主提交的指令才能作为下一次差异的基准。 */
export class InstructionDelivery {
  private readonly delivered = new Map<string, string>()
  private working = new Map<string, string>()
  private pending: Array<{ key: string; source: string; seen: Map<string, string> }> = []

  begin(enabled: boolean): void {
    this.discard()
    if (!enabled) this.delivered.clear()
    this.working = new Map(this.delivered)
  }

  prepare<M extends MessageLike>(message: M, config: DiffOptions): M {
    const original = pinnedOriginal(message)
    if (original !== undefined) condense(original, this.working, config)
    const out = condense(message, this.working, config)
    const key = instructionKey(out)
    if (key !== undefined) this.pending.push({ key, source: JSON.stringify(out.source), seen: new Map(this.working) })
    return out
  }

  commit(message: MessageLike): void {
    const key = instructionKey(message)
    if (key === undefined) return
    const next = this.pending[0]
    const pinned = next !== undefined && isPinnedPointer(message) && next.source === JSON.stringify(message.source)
    if (next === undefined || (next.key !== key && !pinned)) {
      // 其他插件改写、乱序或未记录的指令，无法证明基准完整，下一次发全文。
      this.delivered.clear()
      this.discard()
      return
    }
    this.pending.shift()
    this.delivered.clear()
    for (const [path, content] of next.seen) this.delivered.set(path, content)
  }

  discard(): void {
    this.pending = []
    this.working.clear()
  }
}
