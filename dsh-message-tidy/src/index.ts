import { live } from '../../tooling/runtime/live.mjs'
/**
 * dsh-message-tidy：DSH 往对话里塞的消息，进模型之前整理一遍。
 *
 * 四项整理，各有开关，都挂在 `agent/pre-step` 的最外层（`prepend`，才能看到内层
 * 宿主插件塞进这一步的消息）；`source` 一律原样保留，宿主和其他插件靠它识别消息。
 *
 * | 项 | 文件 | 做什么 |
 * |---|---|---|
 * | 通知加框 | `notice.ts` | 插件通知以 user 角色进来，包上 `<system-reminder>` 并注明来源 |
 * | 任务改名 | `job.ts` | 后台任务完成通知用 `description` 当名字，不抄整条命令 |
 * | 指令只发差异 | `instructions.ts` | AGENTS.md 中途改动时只发 diff，不重发全文 |
 * | 同步骤重复通知去重 | `dedupe.ts` | 同一步一模一样的通知只留第一条 |
 *
 * 每项的现象、做法和删除条件写在各自文件开头；都被上游解决时删掉本插件。
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { InstructionDelivery } from './instructions.ts'
import { backgroundJob, relabel, type ResultLike } from './job.ts'
import { dedupeNotices } from './dedupe.ts'
import { labelNotice, type MessageLike } from './notice.ts'

export const name = 'dsh-message-tidy'

/*
 * 0.1.7 的设置模型：标了 `.volatile()` 的字段由宿主 SettingsForms 端给
 * 浏览器半（GUI 卡片是本插件 client 半自己注册的，见 src/client/index.tsx），
 * 值活在 profile patch 里；改完由 loader 原地提交进运行中的
 * 单元格（不重启插件），所以读配置必须 `live()` 现读。
 * （installSection / setSource 那套 0.1.7 已删掉。）
 */
export const Config = z.object({
  /** 通知加框：给插件通知包上系统提醒外框。 */
  noticeLabel: z.boolean().default(true).volatile(),
  /** 这些插件（通知消息的 `source.kind`）发的通知会被加框；`*` 表示所有插件通知。 */
  noticeSources: z.array(z.string()).default(['*']).volatile(),
  /** 同一步里一模一样的通知只留第一条。 */
  noticeDedupe: z.boolean().default(true).volatile(),
  /** 任务改名：后台任务完成通知用 description 当名字。 */
  jobLabel: z.boolean().default(true).volatile(),
  /** 通知里的任务名最多保留多少个字符。 */
  jobLabelMaxChars: z.natural().min(8).default(120).volatile(),
  /** 指令只发差异：AGENTS.md 中途改动时只发 diff。 */
  instructionsDiff: z.boolean().default(true).volatile(),
  /** diff 超过全文这个比例时照旧发全文。 */
  maxDiffRatio: z.number().min(0).max(1).default(0.5).volatile(),
  /** diff 每处改动前后保留几行原文。 */
  contextLines: z.natural().default(2).volatile(),
})

/** schema 输出形状：volatile 字段是单元格。 */
type ConfigCells = ReturnType<typeof Config>

/**
 * 运行时配置（volatile 单元格解析成普通值之后的形状）。
 * 字段语义见上面的 schema。
 */
export interface MessageTidyConfig {
  readonly noticeLabel: boolean
  readonly noticeSources: readonly string[]
  readonly noticeDedupe: boolean
  readonly jobLabel: boolean
  readonly jobLabelMaxChars: number
  readonly instructionsDiff: boolean
  readonly maxDiffRatio: number
  readonly contextLines: number
}

/** 一个 agent（会话）自己的记录：同一个 `bash-4`、同一份 AGENTS.md 在不同会话里互不相干。 */
interface AgentState {
  /** 后台任务 `jobId → description`。 */
  readonly jobs: Map<string, string>
  /** 指令文件 `路径 → 模型已看到的内容`。 */
  readonly instructions: InstructionDelivery
}

/** 把 schema 输出（volatile 单元格）解析成普通值快照；测试也用它把 `Config({})` 摊开。 */
export function resolveConfig(config: ConfigCells): MessageTidyConfig {
  return {
    noticeLabel: live(config.noticeLabel),
    noticeSources: live(config.noticeSources),
    noticeDedupe: live(config.noticeDedupe),
    jobLabel: live(config.jobLabel),
    jobLabelMaxChars: live(config.jobLabelMaxChars),
    instructionsDiff: live(config.instructionsDiff),
    maxDiffRatio: live(config.maxDiffRatio),
    contextLines: live(config.contextLines),
  }
}

export function apply(ctx: Context, config: ConfigCells): void {
  // volatile 单元格每次现读：设置页改完 loader 原地提交，下一次整理就用新值。
  const current = (): MessageTidyConfig => resolveConfig(config)
  const byAgent = new WeakMap<object, AgentState>()
  const bySession = new WeakMap<object, AgentState>()
  const stateOf = (agent: object): AgentState => {
    let state = byAgent.get(agent)
    if (state === undefined) {
      state = { jobs: new Map(), instructions: new InstructionDelivery() }
      byAgent.set(agent, state)
    }
    return state
  }

  ctx.on('tools/result', (exec, result) => {
    if (exec.agent === undefined) return
    const job = backgroundJob(exec, result as ResultLike)
    if (job !== undefined) stateOf(exec.agent).jobs.set(job[0], job[1])
  })

  ctx.on('session/event', (session, event) => {
    const state = bySession.get(session)
    if (state === undefined) return
    if (event.type === 'user/message') state.instructions.commit(event.data as unknown as MessageLike)
    else if (event.type === 'turn/end') state.instructions.discard()
  })

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const state = stateOf(agent)
    state.instructions.discard()
    if (agent.session !== undefined) bySession.set(agent.session, state)
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const c = current()
    state.instructions.begin(c.instructionsDiff)
    const mapped = decision.messages.map((original) => {
      let m = original as unknown as MessageLike
      // 指令缓存关掉时也不记：重新打开后宁可发一次全文，也不拿过期的上一版做 diff。
      if (c.instructionsDiff) m = state.instructions.prepare(m, c)
      // 先改名再加框：加框后正文多了一段前缀，改名的匹配本就不锚定行首，顺序只为读起来直。
      if (c.jobLabel) m = relabel(m, state.jobs, c.jobLabelMaxChars)
      if (c.noticeLabel) m = labelNotice(m, c.noticeSources)
      return m
    })
    // 去重放最后：比的是加框改名后的最终文本，且它可能让列表变短。
    const messages = c.noticeDedupe ? dedupeNotices(mapped) : mapped
    if (messages.length === decision.messages.length
      && messages.every((m, i) => m === (decision.messages[i] as unknown))) return decision
    return { ...decision, messages: messages as unknown as typeof decision.messages }
  }, { prepend: true })
}
