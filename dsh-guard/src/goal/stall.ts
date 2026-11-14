/**
 * 空转刹车：模型连工具都调不动时（比如内核起不来，所有工具都经它），收口规则和
 * `update_goal` 都用不上，宿主仍会按轮数一轮轮自动续跑，续跑驱动只看轮数、不看这一轮
 * 做成了什么。所以按会话记录自己数，不经模型：续跑轮里没有一次工具调用成功（全失败或
 * 一次没调）算空转，有一次成功或用户亲自发消息就清零，连续若干轮空转就替模型把目标停下。
 */
export const STALL_CODE = 'no-progress'

interface TurnTally { goalRound: boolean; human: boolean; ok: number; failed: number; lastError: string | undefined }

export class StallTracker {
  private readonly turns = new Map<unknown, TurnTally>()
  private readonly streaks = new Map<unknown, number>()

  turnStart(key: unknown): void {
    this.turns.set(key, { goalRound: false, human: false, ok: 0, failed: 0, lastError: undefined })
  }

  userMessage(key: unknown, source: { kind?: unknown; round?: unknown } | undefined): void {
    const turn = this.turns.get(key)
    if (turn === undefined) return
    if (source?.kind === 'goal' && typeof source.round === 'number' && source.round > 0) turn.goalRound = true
    if (source?.kind === 'user') turn.human = true
  }

  toolResult(key: unknown, isError: boolean, reason?: string): void {
    const turn = this.turns.get(key)
    if (turn === undefined) return
    if (isError) { turn.failed += 1; turn.lastError = reason ?? turn.lastError } else turn.ok += 1
  }

  /** 一轮结束；返回续跑空转的连续轮数和最后一条工具错误。被中止的轮不算（宿主自己会暂停目标）。 */
  turnEnd(key: unknown, aborted: boolean): { streak: number; lastError: string | undefined } {
    const turn = this.turns.get(key)
    this.turns.delete(key)
    let streak = this.streaks.get(key) ?? 0
    if (turn !== undefined && !aborted) {
      if (turn.human || turn.ok > 0) streak = 0
      else if (turn.goalRound) streak += 1
    }
    this.streaks.set(key, streak)
    return { streak, lastError: turn?.lastError }
  }

  reset(key: unknown): void {
    this.streaks.delete(key)
  }

  forget(key: unknown): void {
    this.turns.delete(key)
    this.streaks.delete(key)
  }
}

/** 停下目标时写给用户和模型看的原因。 */
export function stallMessage(rounds: number, lastError: string | undefined): string {
  const tail = lastError === undefined ? '这几轮没有调用任何工具。' : `最后一次工具报错：${lastError.slice(0, 300)}`
  return `自动续跑连续 ${rounds} 轮没有一次工具调用成功，系统已停下目标，免得空转。${tail}问题解决后可以恢复目标。`
}
