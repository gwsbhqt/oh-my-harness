/**
 * goal-guard（dsh-guard 的目标收口部分）：让模型自己管目标（暂停、修改、完成），并告诉它什么时候该自己收口。
 *
 * 宿主的三处限制促使了本插件：
 * 1. 暂停只有用户能恢复，模型一旦自己暂停，目标就无声卡住、用户毫不知情。
 * 2. 只在用户发消息的轮和续跑轮给模型改/完成目标的权限；重启后的「继续」这类通知轮
 *    两者都不是，模型在那一轮收不了口。
 * 3. 通用说明只说「有用的剩余工作不算卡住」，模型会把等别人、等用户也当成剩余工作，
 *    换着角度一轮轮重试，目标停不下来。
 *
 * 做法分三块：在 agent 自己的工具层遮蔽 update_goal（`goal/tool-wrap.ts`）；有目标工具的
 * 会话里加收口规则（`goal/wrap-up.ts`）；按会话记录数续跑空转、必要时替模型停下目标
 * （`goal/stall.ts`）。
 *
 * 删除条件：宿主给模型可恢复的暂停、并在非用户非续跑的轮也放行 edit / complete 时，
 * 删掉工具包装，保留收口规则和空转刹车。
 *
 * @module
 */
import { live } from '../../tooling/runtime/live.mjs'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { WRAP_UP_GUIDANCE } from './goal/wrap-up.ts'
import { STALL_CODE, StallTracker, stallMessage } from './goal/stall.ts'
import { guardUpdateGoal, type GoalHost, type GoalOps, type GoalViewLike } from './goal/tool-wrap.ts'

export { guardUpdateGoal }
export type { GoalHost, GoalOps, GoalViewLike }
export { MODEL_PAUSE_CODE } from './goal/tool-wrap.ts'
export { StallTracker, stallMessage, STALL_CODE }
export { WRAP_UP_GUIDANCE }

export const name = 'dsh-guard/goal-guard'
export const inject = ['tools', 'agents', 'systemPrompt']

export const Config = z.object({
  /** 总开关：关掉后收口规则、工具包装、空转刹车一起停用；关掉期间不累计空转，重开后从零开始。默认开、即时生效。 */
  enabled: z.boolean().default(true).volatile(),
  /**
   * 模型自己管目标：pause 改成能自己恢复的停止；edit、complete 在宿主不给权限的轮次
   * （重启后的「继续」通知轮这类既不是用户发的、也不是续跑的轮）也能做。
   */
  modelControl: z.boolean().default(true).volatile(),
  /** 有目标工具的会话里加一段收口规则：什么时候完成、暂停、改终点。 */
  wrapUpGuidance: z.boolean().default(true).volatile(),
  /** 自动续跑连续这么多轮没有一次工具调用成功，就把目标停下（记成 blocked）。0 = 不管。 */
  stallRounds: z.natural().default(3).volatile(),
})

/** schema 输出形状：volatile 字段是单元格。 */
type ConfigCells = ReturnType<typeof Config>

export interface GoalGuardConfig {
  readonly enabled: boolean
  readonly modelControl: boolean
  readonly wrapUpGuidance: boolean
  readonly stallRounds: number
}

/** 把 schema 输出（volatile 单元格）解析成普通值快照；测试也用它把 `Config({})` 摊开。 */
export function resolveConfig(config: ConfigCells): GoalGuardConfig {
  return { enabled: live(config.enabled), modelControl: live(config.modelControl), wrapUpGuidance: live(config.wrapUpGuidance), stallRounds: live(config.stallRounds) }
}

/**
 * 顶层会话：会话头没有子代理标记（`origin: 'subagent'` 或 `delegationDepth > 0`）。
 * 宿主早期版本提供过 `roots()`，某些版本又移除了，按会话头判断最稳。
 */
export function isRootAgent(agent: unknown): boolean {
  const header = (agent as { session?: { header?: { origin?: unknown; delegationDepth?: unknown } } | null | undefined })?.session?.header
  if (header === undefined || header === null) return false
  return header.origin !== 'subagent' && !(typeof header.delegationDepth === 'number' && header.delegationDepth > 0)
}

export function apply(ctx: Context, config: ConfigCells): void {
  const current = (): GoalGuardConfig => resolveConfig(config)
  ctx.systemPrompt.section({
    name: 'goal-guard-wrap-up',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GOAL'),
    text: ({ scope }) => current().enabled && current().wrapUpGuidance && ctx.tools.get('update_goal', scope) !== undefined ? WRAP_UP_GUIDANCE : '',
  })
  const host: GoalHost = {
    isRoot: isRootAgent,
    goals: (agent) => (agent as Agent).ctx.get('goals' as never) as GoalOps | undefined,
  }
  const owners = new Map<Agent, () => void>()
  // update_goal 由宿主的目标工具在「预设（PTC 等）的层」注册，不在全局层：必须带 agent 查，
  // 全局查永远拿不到、静默不装。启动中恢复的 agent 可能早于预设层就绪，找不到就在之后的
  // 每个 agent/pre-step 重试（中间件，主 agent 每步经过）。子代理不遮蔽：宿主本来就拒它们
  // 的 pause（需要顶层 agent 的人类回合）。
  const tryInstall = (agent: Agent) => {
    if (owners.has(agent)) return
    const original = ctx.tools.get('update_goal', agent)
    if (original === undefined) return
    // agent 自己的层注册同名即遮蔽预设层（同 grep-scope 的做法；own 层最后写入、覆盖继承层）。
    const registry = agent.ctx.get('tools')
    if (registry === undefined) throw new Error('goal-guard: agent 工具层不可用')
    owners.set(agent, registry.register(guardUpdateGoal(original, () => current().enabled && current().modelControl, host)))
  }
  ctx.on('agent/created', ({ agent }) => {
    tryInstall(agent)
    return undefined
  })
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    tryInstall(agent)
    return next()
  })
  ctx.on('agent/disposed', ({ agent }) => {
    owners.get(agent)?.()
    owners.delete(agent)
    stalls.forget(agent)
    return undefined
  })
  const stalls = new StallTracker()
  ctx.on('session/event' as never, ((session: { id: string }, event: { type: string; data: Record<string, unknown> }) => {
    const agent = ctx.agents.get(session.id as never) as Agent | undefined
    if (agent === undefined || (agent as { session?: unknown }).session !== session) return
    // 总开关关掉期间不计数：清掉这次会话的计数，重开后从零开始，不拿关闭期间的轮次去刹车。
    if (!current().enabled) {
      stalls.forget(agent)
      return
    }
    switch (event.type) {
      case 'turn/start': stalls.turnStart(agent); return
      case 'user/message': stalls.userMessage(agent, event.data['source'] as { kind?: unknown; round?: unknown } | undefined); return
      case 'tool/result': {
        const message = event.data['message'] as { isError?: unknown } | undefined
        const error = event.data['error'] as { reason?: string; code?: string } | undefined
        stalls.toolResult(agent, message?.isError === true, error?.reason ?? error?.code)
        return
      }
      case 'turn/end': {
        const reason = event.data['reason'] as { kind?: unknown } | undefined
        const { streak, lastError } = stalls.turnEnd(agent, reason?.kind === 'aborted')
        const limit = current().stallRounds
        if (limit === 0 || streak < limit || !isRootAgent(agent)) return
        // 不在记录事件的同步回调里改目标：目标变更会再写会话记录。
        queueMicrotask(() => {
          // 排队到执行之间总开关可能被关掉：关掉就不停目标。
          if (!current().enabled) return
          try {
            const ops = host.goals(agent)
            const goal = ops?.get(agent)
            if (ops === undefined || goal === undefined || goal.phase !== 'active') return
            ops.block(agent, { id: goal.id, revision: goal.revision }, { code: STALL_CODE, message: stallMessage(streak, lastError) })
            stalls.reset(agent)
          } catch (error) {
            ctx.logger.warn(`goal-guard: 停下空转目标失败：${error instanceof Error ? error.message : String(error)}`)
          }
        })
        return
      }
      default:
    }
  }) as never)
  for (const agent of ctx.agents.list()) tryInstall(agent)
  ctx.effect(() => () => {
    for (const dispose of owners.values()) dispose()
    owners.clear()
  }, 'goal-guard registrations')
}
