/**
 * dsh-compaction-bound：DSH 自带压缩的两处收紧，不改触发点、不改模型回复上限。
 *
 * 1. 压完原样留下的近期对话改成固定量（retain.ts）；
 * 2. 写摘要那次请求换成分栏限长、用户原话照抄、在旧摘要上增量合并的指令（summary.ts）；
 * 3. 写摘要那次请求超出模型窗口时，压进窗口再发（fit.ts）。
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { live } from '../../tooling/runtime/live.mjs'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { installRetain, isPresetRegistry, mountedRetain, type PresetRegistry, type RetainState } from './retain.ts'
import { attachmentText, boundItems, checkOutput, collectUserMessages, condenseInstruction, placesById, rewriteRequest, turnSpan, type Condense, type OutputReport, type Place, type RequestLike } from './summary.ts'
import { budgetTokens, fitMessages, promptTokens, requestChars } from './fit.ts'

export const name = 'dsh-compaction-bound'

export const Config = z.object({
  /** 压完原样留下的近期对话，按宿主的估算口径（4 个字符算 1 token），不是模型分词器的精确计数。改了会重挂模式。 */
  retainTokens: z.natural().min(1000).default(12000),
  /** 写摘要用有界指令；关掉就照宿主原样。 */
  boundSummary: z.boolean().default(true).volatile(),
  /** 模型写的那部分摘要的字数上限，各栏按比例分；超了压短一次，压不下来保留原稿并记在状态文件。不含附上的用户原话。 */
  summaryChars: z.natural().min(2000).default(12000).volatile(),
  /** 附录里逐字原话的额度（写出来的行长）；放不下的旧原话降成轮次清单。 */
  userMessageChars: z.natural().min(1000).default(8000).volatile(),
  /** 附录里轮次清单的额度；超了把最早的并成一行范围。 */
  userIndexChars: z.natural().min(300).default(2000).volatile(),
  /** 原文读取说明；空串使用通用说明，{sessionId} 替换为当前会话编号。 */
  historyReaderHint: z.string().default('').volatile(),
  /** 写摘要请求超出模型窗口时，截长工具结果、拿掉最早的对话，压进窗口再发；最多重发两次。 */
  fitWindow: z.boolean().default(true).volatile(),
})

type ConfigCells = ReturnType<typeof Config>

/** 状态文件：`$DSH_HOME/plugins/compaction-bound/status.json`。宿主日志不落盘，这里留能复核的实际挂载值和最近一次写摘要的情况。 */
export function statusPath(): string {
  return join(process.env['DSH_HOME'] || join(homedir(), '.dsh'), 'plugins', 'compaction-bound', 'status.json')
}

/** 状态文件里保留的最近写摘要记录条数。 */
export const HISTORY = 20

/** 读出上次写下的写摘要记录，重启后接着记。读不到或格式不对就从空开始。 */
export function readHistory(): Record<string, unknown>[] {
  try {
    const status = JSON.parse(readFileSync(statusPath(), 'utf8')) as { history?: unknown; lastSummary?: unknown }
    if (Array.isArray(status.history)) return status.history.filter((x): x is Record<string, unknown> => x !== null && typeof x === 'object').slice(-HISTORY)
    if (status.lastSummary !== null && typeof status.lastSummary === 'object') return [status.lastSummary as Record<string, unknown>]
  } catch { /* 没有旧文件 */ }
  return []
}

function writeStatus(status: unknown): void {
  const path = statusPath()
  mkdirSync(join(path, '..'), { recursive: true })
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(status, null, 2)}\n`)
  renameSync(temp, path)
}

export function apply(ctx: Context, config: ConfigCells): void {
  const logger = ctx.logger(name)
  const state: RetainState = { ok: false, message: '模式注册表还没就绪', presets: [] }
  let registryRef: PresetRegistry | undefined
  const history = readHistory()
  let lastSummary: Record<string, unknown> | undefined
  const report = () => {
    try {
      writeStatus({
        updatedAt: new Date().toISOString(),
        retainTokens: live(config.retainTokens),
        retain: { ...state },
        mounted: registryRef === undefined ? [] : mountedRetain(registryRef),
        ...(history.length === 0 ? {} : { lastSummary: history.at(-1), history }),
      })
    } catch (error) {
      logger.warn(`写状态文件失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  ctx.inject(['agentPresets'], (scoped: Context) => {
    const registry = scoped.get('agentPresets' as never) as unknown
    if (!isPresetRegistry(registry)) {
      state.ok = false
      state.message = 'DSH 的模式注册表少了 definitions/activate/collect/register，压缩保留量照宿主默认'
      logger.warn(state.message)
      report()
      return
    }
    registryRef = registry
    scoped.effect(() => installRetain(registry, live(config.retainTokens), logger, state, report), 'compaction-bound: retain')
  })

  /**
   * 按会话编号读会话事件，查每条消息在第几轮。走宿主的 sessionQuery.observeSession（会话的同步读法 eventAt 已弃用）。
   * 读不到就返回空表，附录的轮次记 null，压缩照常进行。
   */
  const placesOf = async (sessionId: string | undefined, signal: AbortSignal | undefined): Promise<Map<string, Place>> => {
    if (sessionId === undefined) return new Map()
    const query = ctx.get('sessionQuery' as never) as { observeSession(id: string, options?: { signal?: AbortSignal; projectionMode?: 'none' }): Promise<{ events: readonly unknown[]; [Symbol.dispose](): void }> } | undefined
    if (query === undefined) {
      logger.warn('没有 sessionQuery 服务，附录的轮次记为空')
      return new Map()
    }
    try {
      const observation = await query.observeSession(sessionId, { ...(signal === undefined ? {} : { signal }), projectionMode: 'none' })
      try {
        return placesById(observation.events as never)
      } finally {
        observation[Symbol.dispose]()
      }
    } catch (error) {
      if (signal?.aborted === true) throw error
      logger.warn(`读会话轮次失败，附录轮次记为空：${error instanceof Error ? error.message : String(error)}`)
      return new Map()
    }
  }

  // 插件自己发的压短请求、压进窗口后的重发也走 llm/stream，认出来直接放行
  const own = new WeakSet<object>()
  const llmOf = () => ctx.get('llm' as never) as {
    stream(request: unknown): AsyncIterable<unknown>
    resolveModelInfo?(provider: string, model: string, signal?: AbortSignal): Promise<{ context?: { contextWindow?: number } }>
  } | undefined
  const condenseWith = (options: RequestLike): Condense => async (original, limit) => {
    const llm = llmOf()
    if (llm === undefined || options.provider === undefined || options.model === undefined) return undefined
    const request = {
      provider: options.provider,
      model: options.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: condenseInstruction(original, limit) }] }],
      ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      purpose: 'compaction',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }
    own.add(request)
    const texts = new Map<number, string>()
    let kind: string | undefined
    let usage: unknown
    for await (const raw of llm.stream(request)) {
      const chunk = raw as { type: string; index?: number; text?: string; block?: { type?: string; text?: string }; reason?: { kind?: string }; usage?: unknown }
      if (chunk.type === 'text-delta' && typeof chunk.index === 'number') texts.set(chunk.index, (texts.get(chunk.index) ?? '') + (chunk.text ?? ''))
      else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.index === 'number') texts.set(chunk.index, chunk.block.text ?? '')
      else if (chunk.type === 'usage') usage = chunk.usage
      else if (chunk.type === 'finish') kind = chunk.reason?.kind
    }
    if (lastSummary !== undefined) lastSummary['condenseUsage'] = usage ?? null
    if (kind === 'error' || kind === 'aborted' || kind === 'max-tokens') return undefined
    return [...texts.values()].join('')
  }

  ctx.on('llm/stream' as never, ((options: RequestLike, next: () => AsyncIterable<unknown>) => {
    if (options?.purpose !== 'compaction' || own.has(options)) return next()
    if (!live(config.boundSummary) && !live(config.fitWindow)) return next()
    return bounded(options, next)
  }) as never, { global: true, prepend: true } as never)

  /** 写摘要请求：先异步读出轮次，再换指令、调下游（必要时压进窗口），最后核对字数并附原话。 */
  async function* bounded(options: RequestLike, next: () => AsyncIterable<unknown>): AsyncGenerator<unknown> {
    let attachment = ''
    let replaced = false
    const limit = live(config.summaryChars)
    if (!live(config.boundSummary)) lastSummary = { at: new Date().toISOString(), sessionId: options.sessionId ?? null, result: 'off' }
    else {
      const places = await placesOf(options.sessionId, options.signal)
      try {
        // 先取原话再换指令：只有认出并换掉宿主指令，才在输出后面附原话、核对字数，几件事同进同退
        const messages = options.messages ?? []
        const items = boundItems(collectUserMessages(messages, places), { fullChars: live(config.userMessageChars), indexChars: live(config.userIndexChars) })
        const span = turnSpan(messages, places)
        const result = rewriteRequest(options, limit)
        const count = (kind: string) => items.filter((item) => item.kind === kind).length
        const merged = items.reduce((n, item) => (item.kind === 'range' ? n + item.count : n), 0)
        if (result === 'replaced') {
          replaced = true
          attachment = attachmentText(items, { ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }), ...(span === undefined ? {} : { turns: span }) }, live(config.historyReaderHint))
          logger.info(`写摘要改用有界指令（上限 ${limit} 字），附用户原话：逐字 ${count('full')} 条、清单 ${count('index')} 条、并掉 ${merged} 条，共 ${attachment.length} 字`)
        } else if (result === 'unrecognized') logger.warn('认不出宿主的压缩指令，这次照宿主原样写摘要')
        lastSummary = { at: new Date().toISOString(), sessionId: options.sessionId ?? null, result, summaryChars: limit, userMessages: count('full'), indexed: count('index'), merged, turnsKnown: places.size > 0, ...(span === undefined ? {} : { turns: span }), attachmentChars: attachment.length }
      } catch (error) {
        logger.warn(`换压缩指令失败，照宿主原样：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const summary = lastSummary
    if (summary !== undefined) {
      history.push(summary)
      if (history.length > HISTORY) history.splice(0, history.length - HISTORY)
      report()
    }
    const stream = live(config.fitWindow) ? fitted(options, next, summary) : next()
    if (!replaced) { yield* stream; return }
    yield* checkOutput(stream, attachment, limit, condenseWith(options), (output: OutputReport) => {
      if (output.outcome === 'over-kept') logger.warn(`模型摘要 ${output.modelChars} 字超上限 ${limit}，压短没过核对（${output.reason}），保留原稿`)
      else if (output.outcome === 'condensed') logger.info(`模型摘要 ${output.modelChars} 字超上限，压短到 ${output.condensedChars} 字`)
      if (summary !== undefined) summary['output'] = output
      report()
    })
  }

  /** 每个模型「序列化字符数 ÷ 服务商回报的输入 token」，从写摘要请求的用量里学，下次发之前就能估算超不超窗。 */
  const charsPerToken = new Map<string, number>()

  const windowOf = async (options: RequestLike): Promise<number | undefined> => {
    const llm = llmOf()
    if (llm?.resolveModelInfo === undefined || options.provider === undefined || options.model === undefined) return undefined
    try {
      const window = (await llm.resolveModelInfo(options.provider, options.model, options.signal)).context?.contextWindow
      return typeof window === 'number' && window > 0 ? window : undefined
    } catch (error) {
      if (options.signal?.aborted === true) throw error
      logger.warn(`查不到 ${options.provider}/${options.model} 的窗口大小，写摘要请求不做压窗：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /**
   * 发写摘要请求；以 CONTEXT_WINDOW_EXCEEDED 结束时压进窗口重发，最多两次，失败那次的输出不交给宿主。
   * 宿主的溢出恢复和按压力压缩都把整段对话重放给模型，会话已超窗时这一步不压就永远失败。
   */
  async function* fitted(options: RequestLike & { tools?: unknown }, next: () => AsyncIterable<unknown>, summary: Record<string, unknown> | undefined): AsyncGenerator<unknown> {
    const window = await windowOf(options)
    if (window === undefined) { yield* next(); return }
    const key = `${options.provider}/${options.model}`
    const budget = budgetTokens(window, options.maxTokens)
    const fit: Record<string, unknown> = { contextWindow: window, budgetTokens: budget, overflows: 0, refits: 0 }
    const shrink = (request: RequestLike & { tools?: unknown }, targetChars: number, basis: string): readonly unknown[] | undefined => {
      const result = fitMessages(request.messages ?? [], request.tools, targetChars)
      if (result === undefined || result.afterChars >= result.beforeChars) return undefined
      Object.assign(fit, { basis, beforeChars: fit['beforeChars'] ?? result.beforeChars, afterChars: result.afterChars, trimmedToolResults: result.trimmedToolResults, droppedMessages: result.droppedMessages })
      fit['refits'] = (fit['refits'] as number) + 1
      return result.messages
    }
    const record = (outcome: string) => {
      if ((fit['refits'] as number) === 0 && (fit['overflows'] as number) === 0) return
      fit['outcome'] = outcome
      if (summary !== undefined) summary['fit'] = fit
      logger.info(`写摘要请求压窗：${JSON.stringify(fit)}`)
      report()
    }

    const known = charsPerToken.get(key)
    if (known !== undefined && !Object.isFrozen(options)) {
      const chars = requestChars(options.messages ?? [], options.tools)
      if (chars / known > budget) {
        const messages = shrink(options, Math.floor(budget * known), 'estimate')
        if (messages !== undefined) (options as { messages: readonly unknown[] }).messages = messages
      }
    }

    let request = options
    for (let attempt = 0; ; attempt++) {
      const chunks: unknown[] = []
      let finish: { type: string; reason?: { kind?: string; failure?: { code?: string } } } | undefined
      let usage: unknown
      const source = attempt === 0 ? next() : llmOf()!.stream(request)
      for await (const raw of source) {
        const chunk = raw as { type?: string; usage?: unknown }
        if (chunk?.type === 'finish') { finish = chunk as typeof finish; break }
        if (chunk?.type === 'usage') usage = chunk.usage
        chunks.push(raw)
      }
      const chars = requestChars(request.messages ?? [], request.tools)
      const prompt = promptTokens(usage)
      if (prompt !== undefined) charsPerToken.set(key, chars / prompt)
      const overflow = finish?.reason?.kind === 'error' && finish.reason.failure?.code === 'CONTEXT_WINDOW_EXCEEDED'
      if (!overflow || attempt >= 2 || options.signal?.aborted === true) {
        record(overflow ? 'still-over' : finish?.reason?.kind ?? 'unfinished')
        yield* chunks
        if (finish !== undefined) yield finish
        return
      }
      fit['overflows'] = (fit['overflows'] as number) + 1
      const ratio = charsPerToken.get(key)
      let target = ratio === undefined ? Math.floor(chars / 2) : Math.floor(budget * ratio)
      // 服务商的实际窗口比登记的小时，按比例算出来「放得下」也照样拒收，至少再砍四成
      if (target >= chars * 0.9) target = Math.floor(chars * 0.6)
      const messages = shrink(request, target, prompt !== undefined ? 'reported-usage' : ratio !== undefined ? 'learned-ratio' : 'halve')
      if (messages === undefined) {
        record('cannot-fit')
        yield* chunks
        yield finish!
        return
      }
      request = { ...options, messages }
      own.add(request)
    }
  }
}

