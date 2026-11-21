import { z } from 'zod'

/** 同一条消息被编辑时保留编号，但宿主会重新插入。只保留各位置最后一次插入的事件序号。 */
export const nextStepInsertionProjection = {
  key: 'dshUseNextStepInsertions',
  stateVersion: 1,
  stateSchema: z.array(z.number().int().nonnegative()),
  init: (): number[] => [],
  apply(state: number[], event: { type: string; seq: number; data: unknown }): number[] {
    if (event.type !== 'agent/inbox/spliced') return state
    const splice = event.data as { target: string; start: number; removedCount?: number; inserted: readonly unknown[] }
    if (splice.target !== 'next-step') return state
    return state.toSpliced(splice.start, splice.removedCount ?? 0, ...splice.inserted.map(() => event.seq))
  },
}

export interface NoticeInsertions {
  stateOf(session: NonNullable<LiveAgent['session']>): readonly number[]
}

export interface LiveAgent {
  id: string
  status: string
  inbox: { nextTurn: readonly unknown[]; nextStep: readonly unknown[] }
  session?: { header?: { parentSession?: string; origin?: string } }
}

export interface QueuedDetail {
  id: string
  nextTurnCount: number
  nextStepCount: number
  nextStepSources: { kind: string; form?: string; summary?: string; messageId?: string; insertionSeq?: number }[]
}

/** 只投影已加载会话的收件箱；历史投影里的旧通知不是当前退出阻碍。 */
export function collectQuitBlockers(live: readonly LiveAgent[], insertions?: NoticeInsertions) {
  // 闲着的子代理也要记：它名下的后台任务被停时，宿主不收发给子代理的通知，说明只能送给上级。
  const parents: Record<string, string> = {}
  for (const a of live) {
    const parent = a.session?.header?.parentSession
    if (a.session?.header?.origin === 'subagent' && typeof parent === 'string') parents[a.id] = parent
  }
  return {
    parents,
    running: live.filter((a) => a.status === 'running').map((a) => a.id),
    queued: live.filter((a) => a.status !== 'running' && (a.inbox.nextTurn.length > 0 || a.inbox.nextStep.length > 0)).map((a) => a.id),
    queuedDetails: live.map((a): QueuedDetail => {
      let insertionSeqs: readonly number[] | undefined
      if (a.session !== undefined && a.inbox.nextStep.length > 0 && insertions !== undefined) {
        try { insertionSeqs = insertions.stateOf(a.session) } catch { /* 无法核对版本时保留原队列保护。 */ }
      }
      return {
        id: a.id,
        nextTurnCount: a.inbox.nextTurn.length,
        nextStepCount: a.inbox.nextStep.length,
        nextStepSources: a.inbox.nextStep.map((message, index) => {
          const item = message as { source?: unknown; role?: unknown; id?: unknown } | null | undefined
          const source = item?.source
          const fields = typeof source === 'object' && source !== null ? source as Record<string, unknown> : {}
          const summary = typeof fields.summary === 'string' ? fields.summary.replace(/\s+/g, ' ').trim() : undefined
          const seq = insertionSeqs?.length === a.inbox.nextStep.length ? insertionSeqs[index] : undefined
          return {
            kind: typeof fields.kind === 'string' ? fields.kind : 'unknown',
            ...(typeof fields.form === 'string' ? { form: fields.form } : {}),
            ...(fields.kind === 'dsh-use' && fields.form === 'notice' && item?.role === 'user' && typeof item.id === 'string' &&
              seq !== undefined ? { messageId: item.id, insertionSeq: seq } : {}),
            ...(summary === undefined ? {} : { summary: summary.length > 120 ? summary.slice(0, 119) + '…' : summary }),
          }
        }),
      }
    }),
  }
}
