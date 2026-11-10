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
  nextStepSources: { kind: string; form?: string; summary?: string }[]
}

/** 只投影已加载会话的收件箱；历史投影里的旧通知不是当前退出阻碍。 */
export function collectQuitBlockers(live: readonly LiveAgent[]) {
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
    queuedDetails: live.map((a): QueuedDetail => ({
      id: a.id,
      nextTurnCount: a.inbox.nextTurn.length,
      nextStepCount: a.inbox.nextStep.length,
      nextStepSources: a.inbox.nextStep.map((message) => {
        const source = typeof message === 'object' && message !== null && 'source' in message ? message.source : undefined
        const fields = typeof source === 'object' && source !== null ? source as Record<string, unknown> : {}
        const summary = typeof fields.summary === 'string' ? fields.summary.replace(/\s+/g, ' ').trim() : undefined
        return {
          kind: typeof fields.kind === 'string' ? fields.kind : 'unknown',
          ...(typeof fields.form === 'string' ? { form: fields.form } : {}),
          ...(summary === undefined ? {} : { summary: summary.length > 120 ? summary.slice(0, 119) + '…' : summary }),
        }
      }),
    })),
  }
}
