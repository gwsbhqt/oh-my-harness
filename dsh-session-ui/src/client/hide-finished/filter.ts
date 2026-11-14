/**
 * 纯计算部分，不碰 React 和宿主，方便单测。
 */

/** 宿主后台任务的状态集合（dsh-client-ui-jobs 的 JobView.status）。 */
export type JobStatus = 'running' | 'stopping' | 'completed' | 'killed' | 'failed'

export interface JobLike {
  readonly status: JobStatus
}

/** 宿主 jobs 状态里本插件用到的部分：每个会话一份任务行。 */
export interface JobsStateLike {
  readonly rows: Readonly<Record<string, readonly JobLike[] | undefined>>
}

/** 和宿主同一口径：正在停止的也还算在跑。 */
export function isLiveJob(job: JobLike): boolean {
  return job.status === 'running' || job.status === 'stopping'
}

const liveOnlyCache = new WeakMap<object, object>()

/**
 * 同一份状态返回同一个过滤结果：宿主组件拿行数组做 useMemo 依赖，
 * 每次渲染都给新数组会让它白算，也会让展开的面板反复重开。
 */
export function liveOnlyJobs<S extends JobsStateLike>(state: S): S {
  const cached = liveOnlyCache.get(state)
  if (cached !== undefined) return cached as S
  const rows: Record<string, readonly JobLike[] | undefined> = {}
  for (const [sessionId, list] of Object.entries(state.rows)) {
    rows[sessionId] = list === undefined ? undefined : list.filter(isLiveJob)
  }
  const filtered = { ...state, rows } as S
  liveOnlyCache.set(state, filtered)
  return filtered
}

export interface CatalogEntryLike {
  readonly id: string
}

/** 宿主会话状态里本插件用到的部分。 */
export interface SessionsStateLike {
  readonly byId: Readonly<Record<string, { readonly running?: boolean } | undefined>>
  readonly projectionsBySession: Readonly<Record<string, {
    readonly state?: string
    readonly values: { readonly subagentCatalog?: readonly CatalogEntryLike[] }
  } | undefined>>
}

export type SessionStatusLike = ReadonlyMap<string, { readonly running?: boolean } | undefined>

const liveCatalogCache = new WeakMap<object, WeakMap<object, Map<string, object>>>()
const NOTHING_KEPT: ReadonlySet<string> = new Set()

/**
 * 每个会话的子代理目录只留在跑的。宿主按钮上的数字和展开的列表都从这份目录来，
 * 滤掉以后两处都只剩在跑的。同一份输入返回同一个对象，理由同 liveOnlyJobs。
 *
 * `keep` 里的会话即使跑完也留着：标题旁的切换框靠目录找「当前子代理的父会话」，
 * 当前看的子代理或它的上级被滤掉，标题会跟着消失。
 */
export function liveOnlySubagents<S extends SessionsStateLike>(
  state: S,
  statuses: SessionStatusLike,
  keep: ReadonlySet<string> = NOTHING_KEPT,
): S {
  let byStatuses = liveCatalogCache.get(state)
  if (byStatuses === undefined) {
    byStatuses = new WeakMap()
    liveCatalogCache.set(state, byStatuses)
  }
  let byKeep = byStatuses.get(statuses)
  if (byKeep === undefined) {
    byKeep = new Map()
    byStatuses.set(statuses, byKeep)
  }
  const keepKey = [...keep].sort().join('\n')
  const cached = byKeep.get(keepKey)
  if (cached !== undefined) return cached as S
  const running = (id: string) => keep.has(id) || (statuses.get(id)?.running ?? state.byId[id]?.running) === true
  const projectionsBySession: Record<string, unknown> = {}
  for (const [sessionId, snapshot] of Object.entries(state.projectionsBySession)) {
    const catalog = snapshot?.values.subagentCatalog
    projectionsBySession[sessionId] = snapshot === undefined || catalog === undefined
      ? snapshot
      : { ...snapshot, values: { ...snapshot.values, subagentCatalog: catalog.filter((entry) => running(entry.id)) } }
  }
  const filtered = { ...state, projectionsBySession } as S
  byKeep.set(keepKey, filtered)
  return filtered
}

/** 从某个会话往上，沿各级子代理目录找到的全部上级会话 id（近的在前）。 */
export function ancestorsOf(state: SessionsStateLike, sessionId: string): string[] {
  const found: string[] = []
  let current = sessionId
  for (;;) {
    const parent = Object.entries(state.projectionsBySession)
      .find(([, snapshot]) => snapshot?.values.subagentCatalog?.some((entry) => entry.id === current))?.[0]
    if (parent === undefined || parent === sessionId || found.includes(parent)) return found
    found.push(parent)
    current = parent
  }
}

/**
 * 直接子代理里有没有在跑的。判断方式照抄宿主目录按钮：
 * 先看实时状态，没有再看会话摘要。
 */
export function hasRunningChild(
  entries: readonly CatalogEntryLike[] | undefined,
  statusOf: (id: string) => boolean | undefined,
  summaryRunning: (id: string) => boolean | undefined,
): boolean {
  if (entries === undefined) return false
  return entries.some((entry) => (statusOf(entry.id) ?? summaryRunning(entry.id)) === true)
}

/** 宿主团队任务投影 `agentTeam` 里本插件用到的部分。 */
export interface AgentTeamLike {
  readonly enabled?: boolean
  readonly tasks?: readonly { readonly status?: string }[]
  readonly failure?: unknown
}

/**
 * 团队任务板有没有内容。DSH 0.2.2-rc.2 起子代理按钮兼做任务板入口，任务板有内容时宿主即使没有子代理也显示按钮；
 * 口径照抄宿主 RootCatalogAction（开着团队，且有没删的任务或有失败说明）。
 */
export function hasTeamBoard(team: AgentTeamLike | null | undefined): boolean {
  if (team?.enabled !== true) return false
  return (team.tasks ?? []).some((task) => task.status !== 'deleted') || team.failure !== undefined
}

/**
 * 子代理按钮要不要显示：有在跑的子代理、目录加载出错（要让重试入口可见），或任务板有内容（按钮是它唯一的入口）。
 */
export function shouldShowCatalog(snapshotState: string | undefined, running: boolean, board: boolean): boolean {
  return board || running || snapshotState === 'error'
}
