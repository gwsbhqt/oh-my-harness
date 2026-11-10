/**
 * dsh-compaction-bound：DSH 自带压缩的两处收紧，不改触发点、不改模型回复上限。
 *
 * 1. 压完原样留下的近期对话改成固定量（retain.ts）；
 * 2. 写摘要那次请求换成分栏限长、用户原话照抄、在旧摘要上增量合并的指令（summary.ts）。
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

  // 插件自己发的压短请求也走 llm/stream，认出来直接放行
  const own = new WeakSet<object>()
  const condenseWith = (options: RequestLike): Condense => async (original, limit) => {
    const llm = ctx.get('llm' as never) as { stream(request: unknown): AsyncIterable<unknown> } | undefined
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
    if (options?.purpose !== 'compaction' || own.has(options) || !live(config.boundSummary)) return next()
    return bounded(options, next)
  }) as never, { global: true, prepend: true } as never)

  /** 写摘要请求：先异步读出轮次，再换指令、调下游，最后核对字数并附原话。 */
  async function* bounded(options: RequestLike, next: () => AsyncIterable<unknown>): AsyncGenerator<unknown> {
    let attachment = ''
    let replaced = false
    const limit = live(config.summaryChars)
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
      history.push(lastSummary)
      if (history.length > HISTORY) history.splice(0, history.length - HISTORY)
      report()
    } catch (error) {
      logger.warn(`换压缩指令失败，照宿主原样：${error instanceof Error ? error.message : String(error)}`)
    }
    const stream = next()
    if (!replaced) { yield* stream; return }
    const summary = lastSummary
    yield* checkOutput(stream, attachment, limit, condenseWith(options), (output: OutputReport) => {
      if (output.outcome === 'over-kept') logger.warn(`模型摘要 ${output.modelChars} 字超上限 ${limit}，压短没过核对（${output.reason}），保留原稿`)
      else if (output.outcome === 'condensed') logger.info(`模型摘要 ${output.modelChars} 字超上限，压短到 ${output.condensedChars} 字`)
      if (summary !== undefined) summary['output'] = output
      report()
    })
  }
}
