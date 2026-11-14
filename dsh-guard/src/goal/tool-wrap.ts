/**
 * 工具包装：在每个 agent 自己的工具层注册同名 `update_goal`，遮蔽预设层的版本
 * （宿主注册表明文支持 scoped 遮蔽，与 dsh-grep-scope 同一做法）。
 *
 * - pause：宿主的暂停只有用户能恢复，模型一旦自己暂停，目标会无声卡住、用户毫不知情。
 *   所以改记成代码 `model-paused` 的 blocked：宿主允许模型 resume blocked，等的事情有了
 *   结果模型自己就能接上；界面上同样显示为卡住并带原因，用户也能在面板恢复。这不占宿主的
 *   轮数门槛，因为暂停是停下，不会让目标多跑。
 * - edit、complete、blocked、resume：先交给宿主；宿主只因「这一轮没有权限」拒绝时，
 *   顶层会话直接调目标服务补上。轮数门槛、版本过期等其他拒绝原样抛出。
 *   用户亲手点的暂停（phase `paused`）不恢复：那是用户明确叫停，只有用户能撤回。
 * - 子代理不补位：目标属于顶层会话。
 */
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

/** 模型暂停记成这个代码的 blocked：宿主允许模型 resume blocked，不允许 resume paused。 */
export const MODEL_PAUSE_CODE = 'model-paused'
/** 宿主「这一轮没有权限」的错误代码：只有它才走补位，别的错误（版本过期、轮数门槛）原样抛。 */
const NO_AUTHORITY = 'GOAL_TOOL_AUTHORITY_REQUIRED'

/** 补位要用到的宿主能力；测试传假的。 */
export interface GoalHost {
  /** 调用方是不是顶层会话（子代理不补位）。 */
  isRoot(agent: unknown): boolean
  /** 这个会话的目标服务。 */
  goals(agent: unknown): GoalOps | undefined
}

export interface GoalOps {
  block(agent: unknown, ref: GoalRef, reason: { code: string; message: string }): GoalViewLike
  edit(agent: unknown, ref: GoalRef, replacements: { objective?: string; maxGoalRounds?: number }): GoalViewLike
  complete(agent: unknown, ref: GoalRef): GoalViewLike
  resume(agent: unknown, ref: GoalRef): GoalViewLike
  get(agent: unknown): GoalViewLike | undefined
}

interface GoalRef { id: string; revision: number }

export interface GoalViewLike {
  id: string
  revision: number
  objective: string
  phase: string
  roundsStarted: number
  maxGoalRounds: number
  activation?: string
  blockedReason?: { code: string; message: string }
}

interface UpdateArgs {
  goal_id?: string
  revision?: number
  action?: string
  objective?: string
  max_goal_rounds?: number
  blocked_reason?: string
}

const hasText = (v: string | undefined): v is string => v !== undefined && v.trim() !== ''
const hasCap = (v: number | undefined): v is number => v !== undefined && v !== 0

/** 和宿主 update_goal 一样的紧凑结果。 */
function value(goal: GoalViewLike): unknown {
  return {
    goal: {
      id: goal.id,
      revision: goal.revision,
      objective: goal.objective,
      phase: goal.phase,
      roundsStarted: goal.roundsStarted,
      maxGoalRounds: goal.maxGoalRounds,
      ...goal.blockedReason === undefined ? {} : { blockedReason: { code: goal.blockedReason.code, message: goal.blockedReason.message } },
    },
    activation: goal.activation,
  }
}

/**
 * 包住宿主的 `update_goal`，让模型自己能暂停、修改、完成目标：
 * - pause：改记成代码 `model-paused` 的 blocked，模型之后能自己 resume。
 * - edit、complete、blocked、resume：先交给宿主；宿主只因「这一轮没有权限」拒绝时，
 *   顶层会话直接调目标服务补上。轮数门槛、版本过期等其他拒绝原样抛出。
 *
 * @param original - 宿主注册的 `update_goal` 定义
 * @param enabled - 开关（可传函数现读 volatile 单元格）
 * @param host - 补位用的宿主能力
 * @returns 同名同 schema 的替代定义
 */
export function guardUpdateGoal(original: ToolDefinition, enabled: boolean | (() => boolean), host: GoalHost): ToolDefinition {
  return {
    ...original,
    async execute(args: unknown, exec: ToolRunContext) {
      const on = typeof enabled === 'function' ? enabled() : enabled
      if (!on) return original.execute(args, exec)
      const a = args as UpdateArgs
      const agent = (exec as { agent?: unknown }).agent
      const direct = (): { ops: GoalOps; ref: GoalRef } => {
        const ops = agent === undefined || !host.isRoot(agent) ? undefined : host.goals(agent)
        if (ops === undefined) throw new HarnessError('只有顶层会话能自己管目标', 'GOAL_GUARD_ROOT_ONLY')
        if (!hasText(a.goal_id) || typeof a.revision !== 'number') throw new HarnessError('goal_id 和 revision 要用 get_goal 读到的原值', 'GOAL_TOOL_INVALID_UPDATE')
        return { ops, ref: { id: a.goal_id, revision: a.revision } }
      }
      if (a.action === 'pause') {
        if (hasText(a.objective) || hasCap(a.max_goal_rounds)) throw new HarnessError('pause 只收 blocked_reason（暂停原因）；改目标用 edit', 'GOAL_TOOL_INVALID_UPDATE')
        const { ops, ref } = direct()
        return value(ops.block(agent, ref, { code: MODEL_PAUSE_CODE, message: hasText(a.blocked_reason) ? a.blocked_reason.trim() : '模型暂停，没写原因' }))
      }
      try {
        return await original.execute(args, exec)
      } catch (error) {
        if ((error as { code?: unknown }).code !== NO_AUTHORITY) throw error
        const { ops, ref } = direct()
        if (a.action === 'complete') return value(ops.complete(agent, ref))
        if (a.action === 'resume') {
          // 用户在面板亲手点的暂停只有用户能撤回；模型自己的暂停（记成 blocked）和停用续行的目标模型能恢复。
          if (ops.get(agent)?.phase === 'paused') throw new HarnessError('这个目标是用户亲手暂停的，只有用户能恢复；需要继续就在回复里说明', 'GOAL_TOOL_RESUME_PAUSED')
          return value(ops.resume(agent, ref))
        }
        if (a.action === 'blocked' && hasText(a.blocked_reason)) return value(ops.block(agent, ref, { code: 'model-reported', message: a.blocked_reason }))
        if (a.action === 'edit' && (hasText(a.objective) || hasCap(a.max_goal_rounds))) {
          return value(ops.edit(agent, ref, { ...hasText(a.objective) ? { objective: a.objective } : {}, ...hasCap(a.max_goal_rounds) ? { maxGoalRounds: a.max_goal_rounds } : {} }))
        }
        throw error
      }
    },
  }
}
