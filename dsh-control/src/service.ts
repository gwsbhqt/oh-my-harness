/**
 * 命令的实现：全部基于 DSH 自己的接口（`typertGateway`）和会话查询（`sessionQuery`），
 * 另外读 模型额度服务 的额度报告。每个命令返回 `{ text, data }`：text 给模型读，data 给脚本用。
 *
 * @module
 */
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { pendingRestart, type PendingRestart } from '../../tooling/runtime/restart-state.mjs'
import { CommandFailure, errorPayload, UsageError, splitEndpoint, describeEndpoint, parameterSchemas, collectStream, type GatewayLike, type TypertLocalLike } from './gateway.ts'
import { buildTranscript, clock, oneLine, renderTurn, turnLine, type RawEvent, type Transcript } from './transcript.ts'
import { pick, routeKey, tierOf, verdictLine, clock as shortClock, type Tier, type TierTable, type UsageReportLike } from './models.ts'
import { findInterruptedUser, scanLostMessages } from './lost-messages.ts'
import type { PendingQuestions } from './questions.ts'
import type { QueuedDetail } from './quit-blockers.ts'
import type { DesktopNotification } from './desktop-notifications.ts'

export interface CommandResult {
  text: string
  data?: unknown
  /** 命令行退出码提示：ok 0、failed/aborted 1、waiting-input 10、idle 11（等待时没有新内容）、running/timeout 124。 */
  status?: 'ok' | 'waiting-input' | 'idle' | 'timeout' | 'running' | 'failed' | 'aborted'
  ok?: boolean
  error?: { code: string; message: string; details?: unknown }
  /** 给脚本看的附加信息（例如列表省略了多少条），不改 data 的形状。 */
  meta?: Record<string, unknown>
}

export interface SessionSummaryWire {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  agentAvailable: boolean
  parentSessionId?: string
  origin?: string
  cwd?: string
  projections?: { values?: Record<string, unknown> }
}

export interface WorkspaceWire {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
}

export interface SessionQueryLike {
  readSession(sessionId: string): Promise<{ session: { id: string; cwd?: string }; events: readonly RawEvent[] }>
}

export interface RestartRecoveryResult {
  revived: string[]
  failed: { id: string; owner: string; error: string }[]
}

export interface MonitorStartRequest {
  owner: string
  command: string
  cwd: string
  label: string
  /** 进程自己退出后要不要重拉；缺省 on-failure。 */
  restart?: 'never' | 'on-failure'
  /** 输出不推进会话，只在主人用 monitor_output / job_output 查看时给。 */
  quiet?: boolean
  result?: { id: string; owner: string; label: string; command: string; cwd: string }
}

export interface Deps {
  gateway: GatewayLike
  typert: TypertLocalLike
  query: SessionQueryLike
  /** 读 模型额度服务 的额度报告；没装 模型额度服务 时返回 undefined。 */
  usage: (force?: boolean) => Promise<UsageReportLike | undefined>
  /** 订阅 agent 状态变化（会话从在跑变空闲时唤醒等待）。返回取消函数。 */
  onStatus: (listener: (sessionId: string, running: boolean) => void) => () => void
  config: () => RuntimeConfig
  log: (line: string) => void
  now?: () => number
  /** 阻塞式提问（legacy ask_user_question）的待答表；不给就只认会话投影里的提问。 */
  pending?: PendingQuestions
  /**
   * 以插件通知（不是用户消息）的身份给会话送一段话并唤醒它；会话没加载就先加载。
   * 不给就没有通知能力，`notice` 命令会报错，调用方退回 `send`。
   */
  notice?: (sessionId: string, text: string, summary: string, quiet?: boolean) => Promise<import('./notice.ts').NoticeReceipt>
  desktopNotify?: (notification: DesktopNotification) => Promise<void>
  /** 把宿主排队消息原样放回会话的下一轮排队区并唤醒它；会话没加载就先加载。 */
  requeue?: (sessionId: string, messages: Record<string, unknown>[]) => Promise<void>
  /**
   * 宿主退出前判断「还有没有活」的同一套条件（会话在跑、收件箱有排队、后台任务在跑）。
   * App 退出时只要有一项为真就弹确认框，远程没人能点，所以重启前要先清干净。
   */
  quitBlockers?: () => QuitBlockers
  pendingRestart?: () => PendingRestart | undefined
  /** 给网址加上这次启动的网页登录口令（宿主 `connection.authenticatedUrl`）；不给 base 用本机网页端口。网页服务没起来返回 undefined。 */
  webUrl?: (base?: string) => string | undefined
  /** 设置「远程机器」一页的同一套隧道：命令行的 open、tunnel close 用。 */
  machines?: {
    open(payload: unknown): Promise<{ localPort: number }>
    close(payload: unknown): Promise<{ closed: boolean; localPort: number }>
  }
  /**
   * 已加载会话里还挂着的定时提醒（宿主 `workspace/session-activity` 里的 schedule 项）。
   * 0.2.1 起 App 退出时只要有，就弹「应用关闭期间，定时任务不会运行」确认框；提醒没有暂停接口，等也等不掉。
   */
  scheduledReminders?: () => Promise<ScheduledHold[]>
  /** 停掉一个后台任务（不管属于哪个会话）。返回宿主的受理结果。 */
  killJob?: (jobId: string, reason: string) => 'requested' | 'already-finished'
  /** 要退出重启了：让能接回的任务（持久监听）记下自己再停掉。返回暂停了哪些。 */
  restartPrepare?: () => { id: string; label: string; owner: string }[]
  /** 重启没成：等待恢复完成，分别返回确认接回的旧编号和失败原因。 */
  restartAbort?: () => Promise<RestartRecoveryResult>
  startMonitor?: (request: MonitorStartRequest) => Promise<void>
  /**
   * 模型额度服务 的自动换模型入口（`modelSelectAutomatic` 服务）：和 `session/selectModel` 一样换，
   * 但不算用户「上一次选的」。没装 模型额度服务 时返回 undefined，退回 `session/selectModel`。
   */
  automaticSelect?: () => AutomaticSelectLike | undefined
  /** 换会话的工作目录（宿主 `workingDirectory` 服务，0.2.1 起）；返回实际生效的绝对目录。没有这个服务时不给。 */
  setWorkingDirectory?: (sessionId: string, directory: string) => Promise<string>
  /**
   * 收回会话目标的自动续跑授权（宿主 `goals` 服务的 disarm）：目标仍是进行中，这一轮跑完不再自动开下一轮。
   * 宿主的 `goals/pause` 遇到在跑的会话会以「用户中止」打断当前这一轮（goal-round-driver，2026-10-18 核对 0.2.1-rc.2），disarm 不会。
   * 会话没加载时返回 false：没加载的会话本来就不会自动续跑。不给就不支持 `goal hold`。
   */
  holdGoal?: (sessionId: string) => boolean
  /** 插件这次启动的时刻：判断最后一轮是不是上次退出时被重启中止的。不给就按服务创建时刻。 */
  startedAt?: number
  /** `wait --settled` 判定前要连续保持「真做完」多久（毫秒），默认 3000；测试用。 */
  settleMs?: number
  /** 登记派单做完通知（`--notify`）；不给就不支持。 */
  watchDone?: (request: { target: string; notify: string; since: number; targetTitle?: string }) => Promise<{ id: string; path: string; reused?: boolean }>
}

/** `wait` 在几次检查之间保留的状态：空闲观察起点、真做完的稳定起点、最近一次没做完的原因。 */
export interface WaitMemo {
  at?: number
  clearAt?: number
  blockers?: string[]
}

/** `schedule/catalog` 里的一条提醒。 */
export interface ScheduleWire {
  id: string
  sessionId: string
  kind: string
  title: string
  prompt?: string
  scheduledAt?: string
  status?: string
}

/** 模型额度服务 `modelSelectAutomatic` 服务里用到的部分。 */
export interface AutomaticSelectLike {
  selectModel(request: { sessionId: string; provider: string; model: string; reasoningEffort?: string }): Promise<{ selected: unknown }>
}

export interface QuitBlockers {
  /** 在跑的子代理 → 派它的会话。 */
  parents?: Record<string, string>
  running: string[]
  queued: string[]
  queuedDetails?: QueuedDetail[]
  /** survivable：重启时由所属插件暂停、新进程起来后自动接回，不算阻碍。 */
  jobs: { id: string; kind: string; label: string; owner?: string; survivable?: boolean }[]
}

export interface ScheduledHold {
  sessionId: string
  items: { id: string; label: string }[]
}

export interface RuntimeConfig {
  readOnly: boolean
  denyNamespaces: string[]
  /** 两档候选，来自 模型额度服务 的共用档位文件（normal = 主力档，fast = 轻量档）。 */
  tiers: TierTable
  reservePercent: number
  waitSliceMs: number
  /** 档位读不到时的原因（模型额度服务 没装、档位文件写错）。 */
  tiersError?: string
  /** 这台机器上最近调用失败、正在暂停的模型 → 原因。 */
  paused?: ReadonlyMap<string, string>
}

/** 调用会改东西的接口名（`api call` 在只读模式下拒绝）。只读的在这里列出，其余都算写。 */
const READ_METHODS = /^(list|get|read|describe|catalog|page|search|stat|projections|modelCatalog|listBundles|listPlugins|listProviders|listConfigurableProviders|listVersionExemptions|registries|inventory|history|candidates|environment|shells|canOpenWorkspacePath|workspacePathApplications|follow|control|changes|watch|watchExpiry|watchPolicy|getState|getProfile|getBalance|generation|enabled|fastest|inspect|hasRunningAccountTasks|getUnnotifiedBonuses|readBytes)$/

export function isReadOnlyEndpoint(method: string): boolean {
  return READ_METHODS.test(method)
}

type Json = Record<string, unknown>
function obj(v: unknown): Json { return typeof v === 'object' && v !== null ? v as Json : {} }

/** 起点之后有新记录却没有一轮结束、会话又空闲时，再观察这么久确认它不会接着开跑。 */
const IDLE_SETTLE_MS = 3000
/** 插件刚启动这么久之内，上次退出时被中止的那一轮不算终态：重启会送「继续」把它接上。 */
const RESTART_GRACE_MS = 120_000

interface Route { provider: string; model: string; reason: string }

/** 命令行档位名对应的档位（模型额度服务 设置页里的叫法）。 */
const TIER_LABEL: Record<Tier, string> = { normal: '主力档', fast: '轻量档' }

/** 远程机器页把「不认识的机器或服务」报成 invalid-request：命令行按调用方写错算，退出 2。 */
function asUsage(error: unknown): never {
  if ((error as { code?: unknown } | null)?.code === 'invalid-request') throw new UsageError((error as Error).message)
  throw error
}

export class RemoteService {
  private readonly deps: Deps
  private readonly waiters = new Set<(sessionId: string, running: boolean) => void>()
  private readonly unsubscribe: () => void
  private readonly created = Date.now()

  constructor(deps: Deps) {
    this.deps = deps
    this.unsubscribe = deps.onStatus((sessionId, running) => {
      for (const w of this.waiters) w(sessionId, running)
    })
  }

  dispose(): void {
    this.unsubscribe()
    this.waiters.clear()
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }

  private async call(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const { namespace, method } = splitEndpoint(endpoint)
    return this.deps.gateway.invoke({ namespace, method, args, ...(signal === undefined ? {} : { signal }) })
  }

  // ---- 基础数据 ----

  async sessions(): Promise<SessionSummaryWire[]> {
    const result = obj(await this.call('session/list', { _request: {} }))
    if (!Array.isArray(result.items) || !result.items.every((s) => typeof obj(s).sessionId === 'string')) throw new CommandFailure('宿主未返回完整会话列表', 'sessions-unavailable')
    const items = result.items as SessionSummaryWire[]
    const pending = this.deps.pending?.list() ?? []
    if (pending.length === 0) return items
    // 阻塞式提问不进会话投影，这里并进摘要，状态、列表、wait 的判断就都能看到它。
    return items.map((s) => {
      const mine = pending.filter((p) => p.sessionId === s.sessionId)
      if (mine.length === 0) return s
      const values = obj(s.projections?.values)
      const uq = obj(values.userQuestions)
      const active = [...(Array.isArray(uq.active) ? uq.active : []), ...mine.map((p) => ({ callId: p.callId ?? p.key, questions: p.questions, state: 'open', blocking: p.key }))]
      return { ...s, projections: { ...s.projections, values: { ...values, userQuestions: { ...uq, active } } } }
    })
  }

  async workspaces(): Promise<{ items: WorkspaceWire[]; archived: Set<string>; pinned: Set<string> }> {
    const stream = await this.deps.gateway.stream({ namespace: 'workspace', method: 'follow', args: {} })
    const { items } = await collectStream(stream, { maxItems: 1, timeoutMs: 5000 })
    const first = obj(items[0])
    if (first.type !== 'baseline') throw new Error('workspace/follow 没有给出基线')
    const value = obj(first.value)
    const stringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((id) => typeof id === 'string')
    if (!Array.isArray(value.items) || !value.items.every((entry) => {
      const w = obj(entry)
      return typeof w.workspaceId === 'string' && typeof w.path === 'string' && typeof w.title === 'string' && stringList(w.sessionIds)
    }) || !stringList(value.archivedSessionIds) || !stringList(value.pinnedSessionIds)) throw new CommandFailure('宿主工作区基线不完整，不能判断会话归属与存档状态', 'workspaces-unavailable')
    return {
      items: value.items as WorkspaceWire[],
      archived: new Set(value.archivedSessionIds),
      pinned: new Set(value.pinnedSessionIds),
    }
  }

  async transcript(sessionId: string): Promise<Transcript> {
    const log = await this.deps.query.readSession(sessionId)
    const t = buildTranscript(log.events)
    return { ...t, ...(t.cwd === undefined && log.session.cwd !== undefined ? { cwd: log.session.cwd } : {}) }
  }

  /** 把用户给的标识换成会话 id：完整 id、去掉 session- 的前缀（≥4 位）、id 末尾（≥4 位）、标题里的词。 */
  async resolve(raw: string): Promise<{ id: string; summary: SessionSummaryWire; title?: string }> {
    const wanted = raw.trim()
    if (wanted === '') throw new UsageError('没给会话；用 dsh-control sessions 找一个')
    const list = await this.sessions()
    const byId = list.find((s) => s.sessionId === wanted || s.sessionId === `session-${wanted}`)
    if (byId !== undefined) return { id: byId.sessionId, summary: byId, ...titleOf(byId) }
    const bare = wanted.replace(/^session-/, '').toLowerCase()
    let matches = bare.length >= 4 ? list.filter((s) => {
      const id = s.sessionId.replace(/^session-/, '').toLowerCase()
      return id.startsWith(bare) || id.endsWith(bare)
    }) : []
    if (matches.length === 0) {
      const needle = wanted.toLowerCase()
      matches = list.filter((s) => (titleOf(s).title ?? '').toLowerCase().includes(needle) && s.origin !== 'subagent')
    }
    if (matches.length === 1) return { id: matches[0]!.sessionId, summary: matches[0]!, ...titleOf(matches[0]!) }
    if (matches.length === 0) throw new UsageError(`找不到会话 "${raw}"；用 dsh-control sessions 看全部`, 'not-found')
    throw new UsageError(`"${raw}" 对上了 ${matches.length} 个会话，说得更具体些：\n${matches.slice(0, 10).map((s) => `  ${short(s.sessionId)}  ${titleOf(s).title ?? '(无标题)'}`).join('\n')}`, 'ambiguous', matches.slice(0, 10).map((s) => s.sessionId))
  }

  // ---- 命令 ----

  async health(): Promise<CommandResult> {
    const list = await this.sessions()
    const roots = list.filter((s) => s.origin !== 'subagent')
    const running = roots.filter((s) => s.running)
    const asking = roots.filter((s) => openQuestions(s).length > 0)
    const config = this.deps.config()
    const archived = await this.archivedIds()
    const blank = roots.filter((s) => s.blank && !archived.has(s.sessionId))
    const archivedCount = roots.filter((s) => archived.has(s.sessionId)).length
    const visible = roots.length - archivedCount - blank.length
    const lines = [
      `DSH 在线。会话 ${visible} 个（和 dsh-control sessions 默认口径一致：不含已归档 ${archivedCount} 个、空白 ${blank.length} 个、子代理），在跑 ${running.length} 个，等你回答 ${asking.length} 个。`,
      ...(running.length > 0 ? ['在跑：', ...running.slice(0, 8).map((s) => `  ${sessionLine(s)}`)] : []),
      ...(asking.length > 0 ? ['等你回答：', ...asking.slice(0, 8).map((s) => `  ${sessionLine(s)}`)] : []),
      ...(config.readOnly ? ['注意：远程控制处于只读模式，会改东西的命令都会被拒绝。'] : []),
    ]
    return { text: lines.join('\n'), data: { sessions: visible, archived: archivedCount, blank: blank.length, running: running.map((s) => s.sessionId), asking: asking.map((s) => s.sessionId), readOnly: config.readOnly } }
  }

  /**
   * 宿主让存档会话的每一轮在第一步前就以 blocked 结束，不调模型（`archived-session-gate`，2026-10-19 核对 0.2.1-rc.2），
   * 消息照收、却没人看。所以明说送不到；dsh-control restart 据此知道「请再排一次」没人接手（复盘 I-018）。
   * 读不到存档名单时照旧送，不让通知因为这一步查询失败。
   */
  private async assertNotArchived(id: string): Promise<void> {
    if ((await this.archivedIds()).has(id)) throw new UsageError(`会话 ${short(id)} 已存档：宿主不会让存档的会话开新一轮，送进去也没人处理。要用它先 dsh-control unarchive ${short(id)}`, 'session-archived')
  }

  /** 已归档的会话 id；工作区读不到时当作没有归档（只影响计数口径，不影响在跑、等回答的判断）。 */
  private async archivedIds(): Promise<Set<string>> {
    try {
      return (await this.workspaces()).archived
    } catch {
      return new Set()
    }
  }

  async listWorkspaces(): Promise<CommandResult> {
    const ws = await this.workspaces()
    const lines = ws.items.map((w) => `${w.title}  ${w.path}  （${w.sessionIds.filter((id) => !ws.archived.has(id)).length} 个会话）`)
    return { text: lines.length === 0 ? '没有工作区' : lines.join('\n'), data: ws.items.map((w) => ({ ...w, archivedCount: w.sessionIds.filter((id) => ws.archived.has(id)).length })) }
  }

  async listSessions(options: { running?: boolean; workspace?: string; ungrouped?: boolean; includeBlank?: boolean; cwd?: string; query?: string; limit?: number; all?: boolean }): Promise<CommandResult> {
    if (options.workspace !== undefined && options.ungrouped === true) throw new UsageError('--workspace 和 --ungrouped 不能同时使用')
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0)) throw new UsageError('--limit 要是非负安全整数；0 表示全部')
    const roots = (await this.sessions()).filter((s) => s.origin !== 'subagent')
    const ws = await this.workspaces()
    const archived = ws.archived
    let list = roots
    if (options.workspace !== undefined) {
      const needle = options.workspace.toLowerCase()
      const exact = ws.items.filter((w) => w.workspaceId === options.workspace || w.title.toLowerCase() === needle || w.path.toLowerCase() === needle)
      const matched = exact.length > 0 ? exact : ws.items.filter((w) => w.title.toLowerCase().includes(needle) || w.path.toLowerCase().includes(needle))
      if (matched.length === 0) throw new UsageError(`找不到工作区 "${options.workspace}"；用 dsh-control workspaces 看全部`, 'not-found')
      const ids = new Set(matched.flatMap((w) => w.sessionIds))
      list = list.filter((s) => ids.has(s.sessionId))
    }
    if (options.ungrouped === true) {
      const grouped = new Set(ws.items.flatMap((w) => w.sessionIds))
      list = list.filter((s) => !grouped.has(s.sessionId))
    }
    if (options.cwd !== undefined) {
      const dir = options.cwd.startsWith('~/') ? `${process.env['HOME'] ?? ''}${options.cwd.slice(1)}` : options.cwd
      const under = (d: string | undefined) => d !== undefined && (d === dir || d.startsWith(`${dir.replace(/\/$/, '')}/`))
      list = list.filter((s) => under(s.cwd) || under(currentDir(s)))
    }
    if (options.running === true) list = list.filter((s) => s.running || openQuestions(s).length > 0)
    if (options.query !== undefined) {
      const needle = options.query.toLowerCase()
      list = list.filter((s) => (titleOf(s).title ?? '').toLowerCase().includes(needle) || (s.cwd ?? '').toLowerCase().includes(needle))
    }
    const archivedHidden = options.all === true ? 0 : list.filter((s) => archived.has(s.sessionId)).length
    if (options.all !== true) list = list.filter((s) => !archived.has(s.sessionId))
    const blankHidden = options.includeBlank === true ? 0 : list.filter((s) => s.blank).length
    if (options.includeBlank !== true) list = list.filter((s) => !s.blank)
    list.sort((a, b) => b.updatedAt - a.updatedAt)
    const limit = options.limit ?? 20
    const shown = limit === 0 ? list : list.slice(0, limit)
    const omitted = [
      ...(list.length > shown.length ? [`……还有 ${list.length - shown.length} 个，加 --limit ${list.length} 看全部`] : []),
      ...(archivedHidden > 0 ? [`另有 ${archivedHidden} 个已归档的没列出，加 --all 一起看`] : []),
      ...(blankHidden > 0 ? [`另有 ${blankHidden} 个空白会话（开了但没发过消息）不列出，加 --include-blank 一起看`] : []),
    ]
    const text = [...(shown.length === 0 ? ['没有符合条件的会话'] : shown.map(sessionLine)), ...omitted].join('\n')
    return {
      text,
      data: shown.map((s) => ({ sessionId: s.sessionId, title: titleOf(s).title ?? null, running: s.running, updatedAt: s.updatedAt, cwd: currentDir(s) ?? null, archived: archived.has(s.sessionId), blank: s.blank, state: stateOf(s) })),
      meta: { shown: shown.length, matched: list.length, archivedHidden, blankHidden },
    }
  }

  async archive(raw: string): Promise<CommandResult> {
    this.assertWritable()
    const { id } = await this.resolve(raw)
    let result: Json
    try {
      result = obj(await this.call('workspace/archiveSession', { request: { sessionId: id } }))
    } catch (error) {
      if (errorPayload(error).code === 'workspace/session-active') throw new UsageError('会话还有活动任务，不能存档；等它完成后再试，不会自动中止任务', 'session-active')
      throw error
    }
    if (!Array.isArray(result.archivedSessionIds) || !result.archivedSessionIds.includes(id)) throw new CommandFailure('宿主未确认会话已存档', 'archive-unconfirmed')
    this.deps.log(`archive ${id}`)
    return { text: `已存档会话 ${short(id)}；取消存档：dsh-control unarchive ${short(id)}`, data: { sessionId: id, archived: true } }
  }

  async unarchive(raw: string): Promise<CommandResult> {
    this.assertWritable()
    const { id } = await this.resolve(raw)
    const result = obj(await this.call('workspace/unarchiveSession', { request: { sessionId: id } }))
    if (!Array.isArray(result.archivedSessionIds) || result.archivedSessionIds.includes(id)) throw new CommandFailure('宿主未确认会话已取消存档', 'unarchive-unconfirmed')
    this.deps.log(`unarchive ${id}`)
    return { text: `已取消会话 ${short(id)} 的存档`, data: { sessionId: id, archived: false } }
  }

  async rename(raw: string, title: string): Promise<CommandResult> {
    this.assertWritable()
    if (title.trim() === '') throw new UsageError('新标题不能是空白')
    const { id } = await this.resolve(raw)
    const result = obj(await this.call('session/rename', { request: { sessionId: id, title } }))
    if (typeof result.title !== 'string' || !Number.isSafeInteger(result.seq)) throw new CommandFailure('宿主未确认重命名结果', 'rename-unconfirmed')
    this.deps.log(`rename ${id}`)
    return { text: `会话 ${short(id)} 已重命名为：${result.title}`, data: { sessionId: id, title: result.title, seq: result.seq } }
  }

  async fork(raw: string, atSeq?: number): Promise<CommandResult> {
    this.assertWritable()
    if (atSeq !== undefined && (!Number.isSafeInteger(atSeq) || atSeq < 0)) throw new UsageError('--at-seq 要是非负安全整数')
    const { id } = await this.resolve(raw)
    let result: Json
    try {
      result = obj(await this.call('session/fork', { request: { sessionId: id, ...(atSeq === undefined ? {} : { atSeq }) } }))
    } catch (error) {
      if (errorPayload(error).code === 'session/fork-unavailable') throw new UsageError(errorPayload(error).message, 'fork-unavailable')
      throw error
    }
    if (typeof result.sessionId !== 'string' || result.sessionId === '' || result.sessionId === id) throw new CommandFailure('宿主未返回分叉后的新会话', 'fork-unconfirmed')
    this.deps.log(`fork ${id} -> ${result.sessionId}`)
    return { text: `已分叉会话 ${short(id)}，新会话 ${result.sessionId}；没有自动发消息。继续：dsh-control send ${result.sessionId} "<消息>"`, data: { sessionId: result.sessionId, sourceSessionId: id, ...(atSeq === undefined ? {} : { atSeq }) } }
  }

  async status(raw: string): Promise<CommandResult> {
    const { id, summary } = await this.resolve(raw)
    const t = await this.transcript(id)
    const values = obj(summary.projections?.values)
    const todos = Array.isArray(values.todos) ? values.todos as { content: string; status: string }[] : []
    const queued = queuedItems(summary)
    const questions = openQuestions(summary)
    const selection = obj(values.modelSelection)
    const next = obj(selection.next)
    const lastUsed = obj(selection.lastUsed)
    const route = typeof next.provider === 'string' ? next : typeof lastUsed.provider === 'string' ? lastUsed : t.model
    const lastTurn = t.turns.at(-1)
    const goal = obj(obj(values.goal).goal)
    const lines = [
      `${titleOf(summary).title ?? '(无标题)'}  ${id}`,
      `目录：${currentDir(summary) ?? t.cwd ?? '未知'}${summary.cwd !== undefined && currentDir(summary) !== summary.cwd ? `（起始目录 ${summary.cwd}）` : ''}`,
      `状态：${stateText(summary)}（更新于 ${clock(summary.updatedAt)}）`,
      `模型：${route === undefined ? '未知' : `${String((route as Json).provider)}/${String((route as Json).model)}`}`,
      `轮次：${t.turns.length}，最后一条 seq ${t.lastSeq}`,
      ...(lastTurn === undefined ? [] : [`最后一轮：${turnLine(lastTurn, 160)}`]),
      ...(todos.length > 0 ? [`待办：${todos.filter((x) => x.status === 'completed').length}/${todos.length} 完成`, ...todos.map((x) => `  ${x.status === 'completed' ? '✓' : x.status === 'in_progress' ? '▶' : '·'} ${x.content}`)] : []),
      ...(typeof goal.objective === 'string' ? [`目标（${String(goal.phase)}）：${oneLine(goal.objective, 200)}`] : []),
      ...(queued.length > 0 ? [`排队消息：${queued.length} 条`] : []),
      ...questions.flatMap(questionLines),
    ]
    return {
      text: lines.join('\n'),
      data: { sessionId: id, title: titleOf(summary).title ?? null, state: stateOf(summary), running: summary.running, cwd: currentDir(summary) ?? t.cwd ?? null, originalCwd: summary.cwd ?? null, model: route ?? null, turns: t.turns.length, lastSeq: t.lastSeq, todos, queued: queued.length, questions },
      status: questions.length > 0 ? 'waiting-input' : 'ok',
    }
  }

  /** 会话的工作目录：不给目录就显示；给了就换过去，走宿主工作目录服务，和模型调 `working_directory` 同一条路。 */
  async cwd(raw: string, target: string | undefined): Promise<CommandResult> {
    const { id, summary } = await this.resolve(raw)
    const current = currentDir(summary) ?? null
    const original = summary.cwd ?? null
    if (target === undefined) {
      const lines = [`当前目录：${current ?? '未知'}`, ...(original !== null && original !== current ? [`起始目录：${original}`] : [])]
      return { text: lines.join('\n'), data: { sessionId: id, cwd: current, originalCwd: original } }
    }
    this.assertWritable()
    const set = this.deps.setWorkingDirectory
    if (set === undefined) throw new CommandFailure('这个 DSH 没有工作目录服务（0.2.1 起才有），换不了目录', 'unsupported')
    const dir = target === '~' || target.startsWith('~/') ? `${homedir()}${target.slice(1)}` : target
    // 命令行和 DSH 不一定在同一个目录，相对路径说不清是相对谁。
    if (!isAbsolute(dir)) throw new UsageError('目录要写绝对路径或 ~/ 开头', 'usage')
    let changed: string
    try {
      changed = await set(id, dir)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.includes('directory does not exist')) throw new UsageError(`目录不存在：${dir}`, 'not-found')
      throw error
    }
    const text = changed === current
      ? `会话 ${short(id)} 已经在 ${changed}，没有变化`
      : `已把会话 ${short(id)} 的目录从 ${current ?? '未知'} 换到 ${changed}。模型下一步会收到目录变更说明；已经开着的终端和后台命令还在原目录。`
    return { text, data: { sessionId: id, cwd: changed, previous: current, originalCwd: original } }
  }

  /** 定时提醒（界面「自动化任务」）：列出、看发送记录、删除。宿主没开放外部新建，只能在会话里让模型建。 */
  async schedule(action: string | undefined, args: string[], options: { limit?: number }): Promise<CommandResult> {
    const catalog = async (): Promise<ScheduleWire[]> => {
      const value = await this.call('schedule/catalog', {})
      return Array.isArray(value) ? value as ScheduleWire[] : []
    }
    const find = async (ref: string | undefined): Promise<ScheduleWire> => {
      if (ref === undefined || ref === '') throw new UsageError('要给提醒编号（schedule 列表里每行开头那段）')
      const all = await catalog()
      const bare = (s: string) => s.replace(/^schedule-/, '')
      const hits = all.filter((s) => s.id === ref || (bare(ref).length >= 4 && bare(s.id).startsWith(bare(ref))))
      if (hits.length === 0) throw new UsageError(`没有提醒 ${ref}；dsh-control schedule 看全部`, 'not-found')
      if (hits.length > 1) throw new UsageError(`${ref} 对上多条提醒，写长一点：\n${hits.map(scheduleLine).join('\n')}`, 'ambiguous')
      return hits[0]!
    }
    if (action === 'history') {
      const item = await find(args[0])
      const limit = options.limit ?? 20
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new UsageError('--limit 要写 1 到 100 的整数')
      const result = obj(await this.call('schedule/history', { request: { sessionId: item.sessionId, id: item.id, limit } }))
      const records = Array.isArray(result.records) ? result.records.map(obj) : []
      const lines = [
        scheduleLine(item),
        records.length === 0 ? '还没发过' : `最近 ${records.length} 次发送：`,
        ...records.map((r) => `  ${dateTime(r.scheduledAt)} 到点，${dateTime(r.deliveredAt)} 送进会话`),
        ...(result.earlierRecordsUnavailable === true || result.earlierRecordsPruned === true ? ['更早的记录已经不在了'] : []),
      ]
      return { text: lines.join('\n'), data: { ...item, ...result } }
    }
    if (action === 'delete') {
      const item = await find(args[0])
      this.assertWritable()
      const result = obj(await this.call('schedule/delete', { request: { sessionId: item.sessionId, id: item.id } }))
      if (result.deleted === false) throw new UsageError(`提醒 ${item.id} 已经不在了`, 'not-found')
      return { text: `已删除提醒「${item.title}」，之后不会再发。已经送进会话的消息不受影响。`, data: { ...item, deleted: true } }
    }
    const sessionRef = action === 'list' ? args[0] : action
    let all = await catalog()
    let scope = ''
    if (sessionRef !== undefined) {
      const { id } = await this.resolve(sessionRef)
      all = all.filter((s) => s.sessionId === id)
      scope = `会话 ${short(id)} `
    }
    const text = all.length === 0 ? `${scope}没有定时提醒` : [`${scope}共 ${all.length} 条定时提醒：`, ...all.map(scheduleLine)].join('\n')
    return { text, data: all }
  }

  /** 会话的持续目标：看，或暂停、恢复、清掉（等同用户在界面目标面板上点；模型自己恢复不了被暂停的目标），或只停自动续跑。 */
  async goal(raw: string, action: string | undefined): Promise<CommandResult> {
    const { id } = await this.resolve(raw)
    const get = async () => {
      const g = obj(await this.call('goals/get', { agentId: id }))
      return typeof g.id === 'string' && typeof g.revision === 'number' ? g : undefined
    }
    const current = await get()
    const describe = (g: Json) => `目标（${phaseText(g.phase)}${g.phase === 'active' && g.activation === 'disarmed' ? '，不自动续跑' : ''}）：${oneLine(String(g.objective ?? ''), 300)}`
    if (action === undefined) {
      return { text: current === undefined ? `会话 ${short(id)} 没有目标` : describe(current), data: current ?? null }
    }
    if (!['pause', 'resume', 'clear', 'hold'].includes(action)) throw new UsageError('动作只能是 pause、resume、clear、hold')
    this.assertWritable()
    if (current === undefined) throw new UsageError(`会话 ${short(id)} 没有目标`, 'not-found')
    if (action === 'hold') {
      if (this.deps.holdGoal === undefined) throw new UsageError('这个 DSH 不支持只停自动续跑（hold）', 'unsupported')
      if (current.phase !== 'active') throw new UsageError(`目标现在是${phaseText(current.phase)}，没有自动续跑可停`, 'goal-not-active')
      this.deps.holdGoal(id)
      const after = await get()
      return { text: `已停掉会话 ${short(id)} 的目标自动续跑，手上这一轮照常跑完；恢复用 goal ${short(id)} resume\n${after === undefined ? '' : describe(after)}`, data: after ?? null }
    }
    try {
      await this.call(`goals/${action}`, { agentId: id, ref: { id: current.id, revision: current.revision } })
    } catch (error) {
      const payload = errorPayload(error)
      throw new UsageError(`${{ pause: '暂停', resume: '恢复', clear: '清掉' }[action]}目标没成：${payload.message}（目标现在是${phaseText(current.phase)}）`, payload.code)
    }
    const after = await get()
    return { text: after === undefined ? `已清掉会话 ${short(id)} 的目标` : describe(after), data: after ?? null }
  }

  async last(raw: string, options: { chars?: number }): Promise<CommandResult> {
    const { id, summary } = await this.resolve(raw)
    const t = await this.transcript(id)
    const turn = [...t.turns].reverse().find((x) => x.reply !== undefined)
    if (turn === undefined) return { text: '这个会话还没有助手回复', data: { sessionId: id, reply: null } }
    const chars = options.chars ?? 6000
    const reply = turn.reply!
    const cut = reply.length > chars ? `${reply.slice(0, chars)}\n…（还有 ${reply.length - chars} 字，加 --chars ${reply.length} 看全文）` : reply
    const head = `第 ${turn.turn} 轮${turn.ended === undefined ? '（还在跑，这是目前最新的一段）' : `（${turn.ended}）`} · ${clock(turn.end ?? turn.start)} · ${stateText(summary)}`
    return { text: `${head}\n\n${cut}`, data: { sessionId: id, turn: turn.turn, ended: turn.ended ?? null, seq: turn.replySeq, reply } }
  }

  async read(raw: string, options: { turn?: number; tools?: boolean; chars?: number; max?: number; last?: number }): Promise<CommandResult> {
    const { id } = await this.resolve(raw)
    const t = await this.transcript(id)
    if (options.turn === undefined) {
      const lastN = options.last ?? 20
      const shown = t.turns.slice(-lastN)
      const text = [`${t.title ?? '(无标题)'} · 共 ${t.turns.length} 轮${t.turns.length > shown.length ? `，显示最后 ${shown.length} 轮（--last 调整）` : ''}`, ...shown.map((x) => turnLine(x))].join('\n')
      return { text, data: { sessionId: id, turns: shown } }
    }
    const turn = options.turn < 0 ? (t.turns.at(options.turn)?.turn ?? 0) : options.turn
    const text = renderTurn(t, turn, { itemChars: options.chars ?? 2000, tools: options.tools ?? false, maxChars: options.max ?? 16000 })
    return { text, data: { sessionId: id, turn, text } }
  }

  /**
   * 发消息。三种送法（2026-10-08 按宿主 0.2.0-rc.2 源码核对）：
   * - 默认排队：进下一轮的收件箱，当前这一轮跑完才看到。
   * - `now`（旧名 steer）：会话在跑就插进当前这一轮的下一步（宿主 `mode: 'steer'`，和界面「插话发送」同一条路），
   *   模型做完手上这一步就看到；会话没在跑就和排队一样立即开跑。
   * - `interrupt`：先中止当前这一步（保留排队，和界面停止按钮一样），再把这条作为下一轮的开头。
   *   中止后插话会被宿主改投到下一轮（`wakingAfterAbort`），所以这里直接排队，不再插话。
   */
  async send(raw: string, text: string, options: { steer?: boolean; now?: boolean; interrupt?: boolean; tier?: Tier; model?: string; effort?: string; notify?: string }): Promise<CommandResult> {
    this.assertWritable()
    if (text.trim() === '') throw new UsageError('消息是空的')
    if (options.interrupt === true && (options.now === true || options.steer === true)) throw new UsageError('--interrupt 和 --now 只能选一个：--now 插进当前这一轮，--interrupt 先停下当前这一步再发')
    const { id, summary, title } = await this.resolve(raw)
    await this.assertNotArchived(id)
    const notifyTo = options.notify === undefined ? undefined : await this.resolveNotify(options.notify, id)
    const notes: string[] = []
    if (options.tier !== undefined || options.model !== undefined || options.effort !== undefined) {
      const switched = await this.model(id, options)
      notes.push(switched.text)
    } else {
      const warning = await this.quotaWarning(id, summary)
      if (warning !== undefined) notes.push(warning)
    }
    const t = await this.transcript(id)
    const since = t.lastSeq
    const running = summary.running
    const queuedBefore = queuedItems(summary).length
    let interrupted = false
    if (options.interrupt === true && running) {
      await this.call('session/cancel', { request: { sessionId: id } })
      interrupted = true
    }
    const wantsNow = options.now === true || options.steer === true
    // 宿主只在会话在跑时接受插话；没在跑时插话和排队效果一样（立即开跑），统一走排队，免得撞上刚停下的空档。
    const mode = wantsNow && running && !interrupted ? 'steer' : 'queue'
    const requestId = randomUUID()
    const code = requestId.replace(/-/g, '').slice(0, 8)
    const admitted = obj(await this.call('session/prompt', { request: { requestId, sessionId: id, mode, content: [{ type: 'text', text }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } }))
    if (admitted.accepted !== true) throw new CommandFailure('宿主没有确认消息已接收；不要自动重发，请先查询会话', 'send-unconfirmed', { requestId, sessionId: id, since, sent: null })
    this.deps.log(`send ${id} mode=${mode}${interrupted ? ' interrupt' : ''} chars=${text.length}`)
    const notify = notifyTo === undefined ? undefined : await this.registerNotify({ target: id, notify: notifyTo, since, ...(title === undefined ? {} : { targetTitle: title }) })
    if (notify !== undefined) notes.push(notify.line)
    const how = interrupted
      ? `已中止当前这一步，这条作为下一轮的开头发出${queuedBefore > 0 ? `（前面还有 ${queuedBefore} 条排队消息，会一起进下一轮；不要的用 dsh-control queue ${short(id)} remove <编号> 删掉）` : ''}`
      : mode === 'steer'
        ? '已插进当前这一轮：模型做完手上这一步就会看到，不用等这一轮结束'
        : running
          ? `排到下一轮（会话正在跑，前面还有 ${queuedBefore} 条排队），这条的编号是 ${code}。之后要它马上看到：dsh-control queue ${short(id)} steer ${code}`
          : '已发出，会话开始处理'
    return {
      text: [`${how}。会话 ${short(id)}，起点 seq ${since}。`, `等它跑完：dsh-control wait ${short(id)} --since ${since}`, ...notes].join('\n'),
      data: { sent: true, requestId, sessionId: id, since, mode, interrupted, queuedBefore, ...(mode === 'queue' && running ? { queueCode: code } : {}), ...(notify === undefined ? {} : { notify: notify.data }), notes },
    }
  }

  /**
   * 看和改排队消息，对应界面排队条上的三个按钮（编辑、删除、插话发送）；宿主接口是 `session/updateQueue`，
   * 按单条消息生效，所以排在中间的也能单独提前，提前几条、留下几条随意。
   * 只管下一轮的排队（`next-turn`）：插话进当前轮的那一档（`next-step`）宿主马上就领走，界面也不列。
   *
   * 每条消息用**编号**点名（`send` 发出时就给了），不随队列变动；也认序号，但序号会在会话领走前面的消息时整体前移，
   * 列表和动作之间隔得久就可能点错，所以文案里优先给编号。
   */
  async queue(raw: string, action: string | undefined, args: string[]): Promise<CommandResult> {
    const { id, summary } = await this.resolve(raw)
    const items = queuedItems(summary)
    const list = () => items.length === 0
      ? `会话 ${short(id)} 没有下一轮排队消息（此列表不包括下一步待领的插话或通知）`
      : [`会话 ${short(id)} 有 ${items.length} 条排队消息（${summary.running ? '在跑，可以插话提前' : '没在跑，它们会马上被处理'}）。点名用编号，序号会随队列前移：`, ...items.map((m, i) => `  ${i + 1}. [${queueCode(m)}] ${oneLine(messageText(m), 160)}`)].join('\n')
    if (action === undefined || action === 'list') {
      return { text: list(), data: { sessionId: id, running: summary.running, items: items.map((m, i) => ({ index: i + 1, code: queueCode(m), id: m.id, text: messageText(m) })) } }
    }
    this.assertWritable()
    /** 编号、消息 id、序号都认；一个都对不上就整条命令不做，免得做了一半。 */
    const pickMany = (refs: string[]): QueueItem[] => {
      if (refs.length === 0) throw new UsageError(`要给编号或序号。${list()}`)
      const picked: QueueItem[] = []
      const missing: string[] = []
      for (const ref of refs) {
        const r = ref.replace(/^\[|\]$/g, '').toLowerCase()
        const byCode = items.filter((m) => queueCode(m) === r || m.id.toLowerCase() === r || (r.length >= 4 && (m.id.toLowerCase().startsWith(r) || rpcIdOf(m)?.toLowerCase().startsWith(r) === true)))
        const n = Number(r)
        const item = byCode.length === 1 ? byCode[0] : byCode.length === 0 && Number.isInteger(n) && n >= 1 ? items[n - 1] : undefined
        if (byCode.length > 1) throw new UsageError(`"${ref}" 对上了 ${byCode.length} 条排队消息，写完整编号。${list()}`, 'ambiguous')
        if (item === undefined) missing.push(ref)
        else if (!picked.includes(item)) picked.push(item)
      }
      if (missing.length > 0) throw new UsageError(`排队里没有 ${missing.join('、')}（可能已经被会话领走了）。${list()}`, 'not-found')
      // 按队列里原来的先后提前，模型看到的顺序和发出的顺序一致。
      return items.filter((m) => picked.includes(m))
    }
    const update = (itemId: string, act: Record<string, unknown>) => this.call('session/updateQueue', { request: { sessionId: id, itemId, action: act } })
    if (action === 'steer') {
      if (!summary.running) throw new UsageError('会话没在跑，排队消息本来就会马上被处理，不用插话', 'steer-unavailable')
      const targets = args.length === 0 || (args.length === 1 && args[0] === 'all') ? items : pickMany(args)
      if (targets.length === 0) throw new UsageError(list(), 'not-found')
      const steered: QueueItem[] = []
      for (const item of targets) {
        try {
          await update(item.id, { kind: 'steer' })
          steered.push(item)
        } catch (error) {
          const code = errorPayload(error).code
          // 和界面一样：这一轮刚好结束、或这条已被领走，就不算失败，停在这里。
          if (code === 'session/steer-unavailable' || code === 'session/queue-item-not-found') break
          throw error
        }
      }
      this.deps.log(`queue ${id} steer ${steered.length}/${targets.length}`)
      const rest = targets.filter((m) => !steered.includes(m))
      const left = items.length - steered.length
      return {
        text: [
          rest.length === 0
            ? `已把 ${steered.length} 条插进当前这一轮，模型做完手上这一步就会看到：${steered.map(queueCode).join('、')}`
            : `插进了 ${steered.length} 条；${rest.map(queueCode).join('、')} 没插成（这一轮刚好结束或已被领走），会作为下一轮照常处理`,
          ...(left > 0 && rest.length === 0 ? [`还剩 ${left} 条照常排队`] : []),
        ].join('。'),
        data: { sessionId: id, steered: steered.map(queueCode), skipped: rest.map(queueCode) },
      }
    }
    if (action === 'remove') {
      const targets = pickMany(args)
      for (const item of targets) await update(item.id, { kind: 'remove' })
      this.deps.log(`queue ${id} remove ${targets.length}`)
      return { text: `已删掉 ${targets.length} 条排队消息：${targets.map((m) => `[${queueCode(m)}] ${oneLine(messageText(m), 60)}`).join('；')}`, data: { sessionId: id, removed: targets.map(queueCode) } }
    }
    if (action === 'edit') {
      const [item] = pickMany(args.slice(0, 1))
      const text = args.slice(1).join(' ')
      if (text.trim() === '') throw new UsageError('新内容是空的。用法：dsh-control queue <会话> edit <编号> "新内容"')
      await update(item!.id, { kind: 'edit', content: [{ type: 'text', text }] })
      this.deps.log(`queue ${id} edit`)
      return { text: `已改写排队消息 [${queueCode(item!)}]`, data: { sessionId: id, edited: queueCode(item!) } }
    }
    throw new UsageError(`queue 的动作只有 list / steer / remove / edit，收到 "${action}"`)
  }

  /**
   * 等会话跑完。一次请求最多挂 `waitSliceMs`（命令行会自己接着问），返回：
   * - status ok：有比 since 更新的一轮结束了，且会话空闲；
   * - status waiting-input：会话停下来在等你回答；
   * - status running：到时间了还在跑。
   */
  async wait(raw: string, options: { since?: number; sliceMs?: number; signal?: AbortSignal; settled?: boolean }): Promise<CommandResult> {
    if (options.since !== undefined && (!Number.isSafeInteger(options.since) || options.since < -1)) throw new UsageError('--since 要是大于等于 -1 的安全整数')
    if (options.sliceMs !== undefined && (!Number.isSafeInteger(options.sliceMs) || options.sliceMs <= 0)) throw new UsageError('--slice 要是正整数（毫秒）')
    const settled = options.settled === true
    if (settled && this.deps.quitBlockers === undefined) throw new CommandFailure('这个 DSH 拿不到后台任务和子代理，判断不了是否真做完', 'settled-unsupported')
    const { id } = await this.resolve(raw)
    const since = options.since ?? -1
    const slice = Math.min(options.sliceMs ?? this.deps.config().waitSliceMs, 120_000)
    const deadline = Date.now() + slice
    const idle: WaitMemo = {}
    for (;;) {
      const outcome = await this.checkDone(id, since, idle, settled)
      if (outcome !== undefined) return outcome
      const left = deadline - Date.now()
      if (left <= 0 || options.signal?.aborted === true) break
      await this.nextStatus(id, Math.min(left, idle.at === undefined && idle.clearAt === undefined ? 5000 : 1000), options.signal)
    }
    const s = await this.status(id)
    const data = obj(s.data)
    const queued = typeof data.queued === 'number' ? data.queued : 0
    const blockers = data.running !== true && queued === 0 ? idle.blockers ?? [] : []
    const reason = data.running === true ? '会话在跑' : queued > 0 ? `会话空闲，但还有 ${queued} 条排队消息没开始处理`
      : blockers.length > 0 ? `这一轮已结束，但还没真做完：${blockers.join('；')}`
        : settled && idle.clearAt !== undefined ? '会话看起来已经做完，还在确认这个状态稳定' : '会话空闲，还在确认它会不会接着跑'
    return { text: `还没有结果：${reason}。\n${s.text}`, data: { sessionId: id, since, waitingFor: reason, ...(settled ? { settled: false, blockers } : {}), ...data }, status: 'running' }
  }

  /** 做完通知用：按 `wait --settled` 的口径查一次，没做完返回 undefined；memo 由调用方跨次保留。 */
  async checkSettled(id: string, since: number, memo: WaitMemo): Promise<CommandResult | undefined> {
    return this.checkDone(id, since, memo, true)
  }

  /**
   * 「这一轮结束」之外还会让会话再被叫醒的事：名下和子代理名下在跑的后台任务、还在干活的子代理、
   * 待领的通知、会自动续跑的目标、正在进行的重启，以及刚重启时上次退出被中止、还等「继续」接上的那一轮。
   * 只看宿主的实时状态，不看回复内容。
   */
  async settledBlockers(id: string, summary: SessionSummaryWire, t: Transcript): Promise<string[]> {
    if (this.deps.quitBlockers === undefined) throw new CommandFailure('这个 DSH 拿不到后台任务和子代理，判断不了是否真做完', 'settled-unsupported')
    const out: string[] = []
    try {
      const restart = (this.deps.pendingRestart ?? (() => pendingRestart(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'))))()
      if (restart !== undefined) out.push(`DSH 正在重启（${restart.phase}），重启后会话会被叫回来接着做`)
    } catch (error) {
      out.push(errorPayload(error).message)
    }
    const live = this.deps.quitBlockers()
    const parents = live.parents ?? {}
    const family = new Set([id])
    for (let grew = true; grew;) {
      grew = false
      for (const [child, parent] of Object.entries(parents)) {
        if (family.has(parent) && !family.has(child)) { family.add(child); grew = true }
      }
    }
    const jobs = live.jobs.filter((j) => j.owner !== undefined && family.has(j.owner))
    if (jobs.length > 0) out.push(`还有 ${jobs.length} 个后台任务在跑：${jobs.map((j) => `${j.id}（${oneLine(j.label, 60)}${j.owner === id ? '' : `，属于子代理 ${short(j.owner!)}`}）`).join('，')}`)
    const subs = [...family].filter((x) => x !== id && (live.running.includes(x) || live.queued.includes(x)))
    if (subs.length > 0) out.push(`派出的子代理还在干活：${subs.map(short).join('，')}`)
    if (live.running.includes(id)) out.push('会话在跑')
    else if (live.queued.includes(id)) out.push('还有待处理的消息或通知')
    const goal = obj(obj(obj(summary.projections?.values).goal).goal)
    if (goal.phase === 'active') {
      try {
        const g = obj(await this.call('goals/get', { agentId: id }))
        if (g.phase === 'active' && g.activation === 'armed') out.push('持续目标还在进行，会自动开下一轮')
      } catch (error) {
        out.push(`持续目标在进行，查不到它会不会自动续跑：${errorPayload(error).message}`)
      }
    }
    const last = t.turns.at(-1)
    const started = this.deps.startedAt ?? this.created
    if (last?.ended === 'aborted' && last.end !== undefined && last.end < started && Date.now() - started < RESTART_GRACE_MS) {
      out.push('最后一轮是在 DSH 上次退出时被中止的，等重启后的「继续」把它接上')
    }
    return out
  }

  private async checkDone(id: string, since: number, idle: WaitMemo, settled = false): Promise<CommandResult | undefined> {
    const summary = (await this.sessions()).find((s) => s.sessionId === id)
    if (summary === undefined) throw new UsageError(`会话 ${id} 不见了`, 'not-found')
    const questions = openQuestions(summary)
    if (questions.length > 0) {
      return {
        text: [`会话 ${short(id)} 停下来在等你回答：`, ...questions.flatMap(questionLines), `回答：dsh-control answer ${short(id)} "<你的回答>"（多个问题用 --json 传完整答案）`].join('\n'),
        data: { sessionId: id, questions },
        status: 'waiting-input',
      }
    }
    const inbox = obj(obj(summary.projections?.values).inbox)
    const pending = (Array.isArray(inbox['next-turn']) ? inbox['next-turn'].length : 0) + (Array.isArray(inbox['next-step']) ? inbox['next-step'].length : 0)
    if (summary.running || (summary.agentAvailable && pending > 0)) {
      delete idle.at
      delete idle.clearAt
      idle.blockers = []
      return undefined
    }
    const t = await this.transcript(id)
    if (settled) {
      const blockers = await this.settledBlockers(id, summary, t)
      idle.blockers = blockers
      if (blockers.length > 0) {
        delete idle.at
        delete idle.clearAt
        return undefined
      }
      // 后台任务刚结束到宿主把「任务结束」通知排进会话之间可能有空档，连续保持一阵才算数。
      idle.clearAt ??= Date.now()
      if (Date.now() - idle.clearAt < (this.deps.settleMs ?? IDLE_SETTLE_MS)) return undefined
    }
    const settledNote = settled ? ['已按真做完核对：没在跑、没有排队，名下没有在跑的后台任务和子代理，目标不会自动续跑。'] : []
    const finished = t.turns.filter((x) => x.ended !== undefined && (t.items.find((i) => i.kind === 'turn-end' && i.turn === x.turn)?.seq ?? -1) > since)
    if (finished.length === 0) {
      // 宿主收下消息时同步入队并开跑，所以「空闲、无排队、起点之后没有新记录」就是真没活，不用等。
      // 起点之后有新记录却没有一轮结束（比如只改了标题或模型），多看几秒确认它不会接着开跑。
      if (since < t.lastSeq) {
        idle.at ??= Date.now()
        if (Date.now() - idle.at < IDLE_SETTLE_MS) return undefined
      }
      const hints = [
        ...(since > t.lastSeq ? [`起点 seq ${since} 比最新的还大，多半抄错了；新消息用 send 输出里的起点。`] : []),
        `看最后的回复：dsh-control last ${short(id)}；要它接着干活：dsh-control send ${short(id)} "<消息>"`,
      ]
      return {
        text: [`会话 ${short(id)}：没有新内容，会话空闲，最新 seq ${t.lastSeq}。起点 seq ${since} 之后没有新的一轮结束。`, ...settledNote, ...hints].join('\n'),
        data: { sessionId: id, since, lastSeq: t.lastSeq, state: 'idle', turns: [], ...(settled ? { settled: true } : {}) },
        status: 'idle',
      }
    }
    const replies = finished.filter((x) => x.reply !== undefined).map((x) => `第 ${x.turn} 轮（${x.ended}${x.endDetail === undefined ? '' : `：${oneLine(x.endDetail, 120)}`}）：\n${x.reply}`)
    const lastTurn = finished.at(-1)!
    const failed = lastTurn.ended !== 'completed'
    return {
      text: [`会话 ${short(id)} 跑完了${failed ? `，但最后一轮结束状态是 ${lastTurn.ended}${lastTurn.endDetail === undefined ? '' : `（${lastTurn.endDetail}）`}` : ''}。最新 seq ${t.lastSeq}。`, ...settledNote, '', ...(replies.length > 0 ? replies : ['（这期间没有文字回复）'])].join('\n'),
      data: { sessionId: id, since, lastSeq: t.lastSeq, turns: finished.map((x) => ({ turn: x.turn, ended: x.ended, detail: x.endDetail ?? null, reply: x.reply ?? null })), ...(settled ? { settled: true } : {}) },
      status: failed ? (lastTurn.ended === 'aborted' ? 'aborted' : 'failed') : 'ok',
      ...(failed ? { ok: false, error: { code: lastTurn.ended === 'aborted' ? 'task-aborted' : 'task-failed', message: `最后一轮没有成功完成：${lastTurn.ended}${lastTurn.endDetail === undefined ? '' : `：${lastTurn.endDetail}`}` } } : {}),
    }
  }

  private nextStatus(id: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.waiters.delete(listener)
        signal?.removeEventListener('abort', finish)
        resolve()
      }
      const listener = (sessionId: string) => { if (sessionId === id) setTimeout(finish, 300) }
      const timer = setTimeout(finish, timeoutMs)
      this.waiters.add(listener)
      signal?.addEventListener('abort', finish, { once: true })
    })
  }

  private assertMaintenanceIdle(): void {
    const restart = (this.deps.pendingRestart ?? (() => pendingRestart(process.env['DSH_HOME'] ?? join(homedir(), '.dsh'))))()
    if (restart !== undefined) throw new UsageError('已有重启正在排队或执行，本次维护让路；没有发送消息', 'restart-pending', restart)
    if (this.deps.quitBlockers === undefined) throw new CommandFailure('无法核实正在运行的会话与真实队列，本次不开始维护', 'idle-check-unavailable')
    const { running, queued, jobs: allJobs } = this.deps.quitBlockers()
    const jobs = allJobs.filter((job) => job.survivable !== true)
    if (running.length > 0 || queued.length > 0 || jobs.length > 0) throw new UsageError('已有会话在跑、有消息排队或普通后台任务未结束，本次维护让路；没有发送消息', 'idle-required', { running, queued, jobs })
  }

  async newSession(workspace: string, text: string | undefined, options: { tier?: Tier; model?: string; effort?: string; preset?: string; ifIdle?: boolean; notify?: string }): Promise<CommandResult> {
    this.assertWritable()
    if (options.notify !== undefined && (text === undefined || text.trim() === '')) throw new UsageError('--notify 要和第一条消息一起用：没发消息就没有要等的任务')
    if (options.ifIdle) this.assertMaintenanceIdle()
    const notifyTo = options.notify === undefined ? undefined : await this.resolveNotify(options.notify)
    const ws = await this.workspaces()
    const needle = workspace.trim()
    const expanded = needle.startsWith('~/') ? `${process.env['HOME'] ?? ''}${needle.slice(1)}` : needle
    const match = ws.items.find((w) => w.path === expanded)
      ?? ws.items.find((w) => w.title.toLowerCase() === needle.toLowerCase())
      ?? (() => {
        const hits = ws.items.filter((w) => w.title.toLowerCase().includes(needle.toLowerCase()) || w.path.toLowerCase().endsWith(needle.toLowerCase()))
        if (hits.length > 1) throw new UsageError(`"${workspace}" 对上了 ${hits.length} 个工作区：${hits.map((w) => w.path).join('、')}`, 'ambiguous')
        return hits[0]
      })()
    const request: Json = match !== undefined ? { workspaceId: match.workspaceId } : { cwd: expanded }
    if (match === undefined && !expanded.startsWith('/')) throw new UsageError(`找不到工作区 "${workspace}"；给一个已有工作区的名字，或一个绝对路径（直接在这个目录开会话，不会加进工作区列表）`, 'not-found')
    if (options.preset !== undefined) request.agentPreset = options.preset
    const tier = options.tier ?? (options.model === undefined ? 'normal' : undefined)
    // 先挑好模型再建会话：档位里没有可用模型时直接失败，不留下一个用错模型的空会话。
    const route = await this.chooseRoute({ ...(tier === undefined ? {} : { tier }), ...(options.model === undefined ? {} : { model: options.model }) })
    if (options.effort !== undefined) await this.validateEffort(route, options.effort)
    if (options.ifIdle) this.assertMaintenanceIdle()
    const created = obj(await this.call('session/create', { request }))
    const id = String(created.sessionId)
    this.deps.log(`new ${id} in ${match?.path ?? expanded}`)
    // 新会话的模型选择是空的，要等第一轮才按全局默认（含等级）落地。目标正是默认模型时，
    // 不带等级去选会把等级清成模型自带默认（Sol 是 low），所以把默认里的等级一起带上。
    const fallback = obj((await this.catalog()).default)
    const keep = fallback.provider === route.provider && fallback.model === route.model && typeof fallback.reasoningEffort === 'string'
      ? fallback.reasoningEffort : undefined
    const switched = await this.applyRoute(id, route, options.effort ?? keep, options.effort !== undefined)
    const lines = [`新会话 ${id}（${match?.title ?? expanded}）。`, switched.text]
    const since = (await this.transcript(id)).lastSeq
    const sent = text !== undefined && text.trim() !== ''
    let notify: { line: string; data: Json } | undefined
    if (sent) {
      if (options.ifIdle) {
        try { this.assertMaintenanceIdle() }
        catch (error) {
          const payload = errorPayload(error)
          const message = `${payload.message}。会话 ${id} 已建成但未发送，请保留此编号，不要重放 new。`
          return { ok: false, status: 'failed', error: { ...payload, message }, text: message, data: { created: true, sessionId: id, workspace: match?.path ?? expanded, since, sent: false, model: switched.data } }
        }
      }
      await this.call('session/prompt', { request: { requestId: randomUUID(), sessionId: id, mode: 'queue', content: [{ type: 'text', text }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } })
      this.deps.log(`send ${id} mode=queue chars=${text.length}`)
      lines.push(`第一条消息已发出，起点 seq ${since}。`, `等它跑完：dsh-control wait ${short(id)} --since ${since}`)
      if (notifyTo !== undefined) {
        notify = await this.registerNotify({ target: id, notify: notifyTo, since })
        lines.push(notify.line)
      }
    } else {
      lines.push(`还没发消息，最新 seq ${since}。发消息：dsh-control send ${short(id)} "<消息>"（send 会给出等待用的起点）`)
    }
    return { text: lines.join('\n'), data: { sessionId: id, workspace: match?.path ?? expanded, since, sent, model: switched.data, ...(notify === undefined ? {} : { notify: notify.data }) } }
  }

  /** 发送前核对「做完通知谁」：找得到、没存档、不是目标自己，宿主也支持登记。 */
  private async resolveNotify(raw: string, target?: string): Promise<string> {
    if (this.deps.watchDone === undefined) throw new CommandFailure('这个 DSH 的远程控制插件不支持做完通知；没有发送消息', 'notify-unsupported')
    if (raw.trim() === 'self') throw new UsageError('--notify self 要经 dsh-control 命令行在 DSH 会话里用，由命令行换成发起的会话；没有发送消息')
    const { id } = await this.resolve(raw)
    if (id === target) throw new UsageError('--notify 不能是目标会话自己')
    await this.assertNotArchived(id)
    return id
  }

  /** 消息已经发出后登记监听；登记失败不能让调用方以为没发，只在回执里写明，改用 wait --settled。 */
  private async registerNotify(request: { target: string; notify: string; since: number; targetTitle?: string }): Promise<{ line: string; data: Json }> {
    try {
      const watch = await this.deps.watchDone!(request)
      if (watch.reused === true) {
        return {
          line: `做完通知沿用已登记的那条（${watch.id.slice(0, 8)}）：会话 ${short(request.target)} 真做完后只给会话 ${short(request.notify)} 送一次。`,
          data: { watchId: watch.id, session: request.notify, record: watch.path, reused: true },
        }
      }
      return {
        line: `做完通知已登记（${watch.id.slice(0, 8)}）：会话 ${short(request.target)} 真做完后给会话 ${short(request.notify)} 送一次结果，失败或中止也会送；DSH 重启不丢。`,
        data: { watchId: watch.id, session: request.notify, record: watch.path },
      }
    } catch (error) {
      const message = errorPayload(error).message
      return {
        line: `消息已发出，但做完通知没登记上：${message}。不要重发消息，改用 dsh-control wait ${short(request.target)} --since ${request.since} --settled 等。`,
        data: { error: message, session: request.notify },
      }
    }
  }

  async notifyDesktop(notification: DesktopNotification): Promise<CommandResult> {
    this.assertWritable()
    if (notification.title === undefined && notification.body === undefined && !notification.sound) throw new UsageError('标题、正文、声音至少选一项')
    if (this.deps.desktopNotify === undefined) throw new CommandFailure('这个 DSH 不支持系统通知', 'desktop-notification-unavailable')
    await this.deps.desktopNotify(notification)
    const visual = notification.title !== undefined || notification.body !== undefined
    return { text: visual ? '通知已交给 macOS；是否显示取决于系统通知设置。' : '提示音已播放。', data: { notificationSubmitted: visual, soundPlayed: notification.sound } }
  }

  /**
   * 以插件通知的身份给会话送一段话：界面显示成一行通知，模型也知道它不是用户说的。会话闲着会被唤醒开一轮。
   * 宿主没给通知能力时报 `notice-unsupported`，调用方（dsh-control restart）退回 send。
   */
  async notice(raw: string, text: string, summary?: string, quiet = false): Promise<CommandResult> {
    this.assertWritable()
    if (text.trim() === '') throw new UsageError('消息是空的')
    if (this.deps.notice === undefined) throw new CommandFailure('这个 DSH 不支持插件通知，改用 send', 'notice-unsupported')
    const { id } = await this.resolve(raw)
    await this.assertNotArchived(id)
    const t = await this.transcript(id)
    const receipt = await this.deps.notice(id, text, summary ?? oneLine(text, 80), quiet)
    this.deps.log(`notice ${id} scheduled=${receipt.scheduled} quiet=${quiet} chars=${text.length}`)
    if (quiet) return { text: `通知已放进会话 ${short(id)} 的上下文，没有唤醒它，它下一轮开始时会看到。`, data: { sessionId: id, since: t.lastSeq, ...receipt } }
    if (!receipt.scheduled) throw new CommandFailure('通知已记录，但未确认安排会话执行；不要重复发送，请查询会话状态', 'notice-wakeup-unconfirmed', { sessionId: id, since: t.lastSeq, ...receipt })
    return { text: `通知已记录并安排会话 ${short(id)} 执行，起点 seq ${t.lastSeq}；尚未确认模型回复。`, data: { sessionId: id, since: t.lastSeq, ...receipt } }
  }

  /**
   * 找出 `since` 之后被中止的轮次里「取走了、没写进记录」的用户消息，原样放回下一轮排队区。
   * 重启清场时中止会话会吞掉这种消息（见 lost-messages.ts）；dsh-control restart 在发「继续」前调它。
   * 放回过的、用户已经自己重发的不会再放，重复调用安全。
   * 另外返回 `interruptedUser`：被中止的那一轮里用户最后说的、还没回应完的话，重启通知据此让模型先回应。
   */
  async requeueLost(raw: string, since: number | undefined): Promise<CommandResult> {
    this.assertWritable()
    if (since === undefined) throw new UsageError('要写 --since <毫秒时间戳>：只找这之后被中止的轮次里吞掉的消息')
    if (this.deps.requeue === undefined) throw new CommandFailure('这个 DSH 不支持把消息放回排队区', 'requeue-unsupported')
    const { id } = await this.resolve(raw)
    const { events } = await this.deps.query.readSession(id)
    const { lost, otherAborted } = scanLostMessages(events, since)
    const interruptedUser = findInterruptedUser(events, since)
    const restored = lost.map((m) => ({ id: String(m.message['id']), target: m.target, claimedAt: m.claimedAt, chars: m.text.length, preview: oneLine(m.text, 40) }))
    if (lost.length === 0) return { text: `会话 ${short(id)} 没有被吞掉的消息`, data: { sessionId: id, restored, otherAborted, interruptedUser } }
    await this.deps.requeue(id, lost.map((m) => m.message))
    this.deps.log(`requeue-lost ${id} restored=${restored.map((m) => m.id).join(',')}`)
    return {
      text: [`放回了 ${lost.length} 条被中止吞掉的消息到会话 ${short(id)} 的排队区：`, ...restored.map((m) => `  ${clock(m.claimedAt)} ${m.preview}`)].join('\n'),
      data: { sessionId: id, restored, otherAborted, interruptedUser },
    }
  }

  /**
   * 等指定会话或所有会话停下，最多挂 `sliceMs`；指定会话有待答问题时返回问题。
   * 状态事件触发复查；每 5 秒还会复核未伴随状态变化的队列。
   */
  async waitIdle(options: { session?: string; sliceMs?: number; signal?: AbortSignal }): Promise<CommandResult> {
    if (options.sliceMs !== undefined && (!Number.isSafeInteger(options.sliceMs) || options.sliceMs <= 0)) throw new UsageError('--slice 要是正整数（毫秒）')
    const id = options.session === undefined ? undefined : (await this.resolve(options.session)).id
    const slice = Math.min(options.sliceMs ?? this.deps.config().waitSliceMs, 120_000)
    const deadline = Date.now() + slice
    for (;;) {
      const sessions = await this.sessions()
      const target = id === undefined ? undefined : sessions.find((s) => s.sessionId === id)
      if (id !== undefined && target === undefined) throw new UsageError(`会话 ${id} 不见了`, 'not-found')
      if (target !== undefined) {
        const questions = openQuestions(target)
        if (questions.length > 0) return {
          text: [`会话 ${short(id!)} 在等你回答：`, ...questions.flatMap(questionLines)].join('\n'),
          data: { sessionId: id, idle: false, questions }, status: 'waiting-input',
        }
      }
      const roots = target === undefined ? sessions.filter((s) => s.origin !== 'subagent') : [target]
      const live = this.deps.quitBlockers?.()
      const runningAll = live?.running ?? roots.filter((s) => s.running).map((s) => s.sessionId)
      // 未加载的会话投影会保留旧通知，不能把它当成本机正在等待处理的队列。
      const queuedAll = live?.queued ?? roots.filter((s) => {
        const inbox = obj(obj(s.projections?.values).inbox)
        const pending = (Array.isArray(inbox['next-turn']) ? inbox['next-turn'].length : 0) + (Array.isArray(inbox['next-step']) ? inbox['next-step'].length : 0)
        return s.agentAvailable && !s.running && pending > 0
      }).map((s) => s.sessionId)
      const running = id === undefined ? runningAll : runningAll.filter((value) => value === id)
      const queued = id === undefined ? queuedAll : queuedAll.filter((value) => value === id)
      const busy = [...new Set([...running, ...queued])]
      if (busy.length === 0) return { text: id === undefined ? '所有会话都停下了' : `会话 ${short(id)} 已停下`, data: { ...(id === undefined ? {} : { sessionId: id }), idle: true, running, queued }, status: 'ok' }
      const left = deadline - Date.now()
      if (left <= 0 || options.signal?.aborted === true) return {
        text: [
          ...(running.length > 0 ? [`还有 ${running.length} 个会话在跑：${running.map(short).join(', ')}`] : []),
          ...(queued.length > 0 ? [`还有 ${queued.length} 个空闲会话有排队消息：${queued.map(short).join(', ')}`] : []),
        ].join('；'),
        data: { ...(id === undefined ? {} : { sessionId: id }), idle: false, running, queued }, status: 'running',
      }
      await new Promise<void>((resolve) => {
        let done = false
        const finish = () => {
          if (done) return
          done = true
          clearTimeout(timer)
          this.waiters.delete(listener)
          options.signal?.removeEventListener('abort', finish)
          resolve()
        }
        const listener = (sessionId: string, running: boolean) => { if (!running && busy.includes(sessionId)) finish() }
        const timer = setTimeout(finish, Math.min(left, 5000))
        this.waiters.add(listener)
        options.signal?.addEventListener('abort', finish, { once: true })
      })
    }
  }

  async openService(machine: string, service: string): Promise<CommandResult> {
    if (this.deps.machines === undefined) throw new CommandFailure('这个 DSH 没有远程机器功能', 'machines-unsupported')
    const { localPort } = await this.deps.machines.open({ id: machine, service }).catch(asUsage)
    return { text: `已拉起隧道并在浏览器打开 ${machine} 的 ${service}（本机端口 ${String(localPort)}）`, data: { opened: true, localPort } }
  }

  async closeTunnel(machine: string, service: string): Promise<CommandResult> {
    if (this.deps.machines === undefined) throw new CommandFailure('这个 DSH 没有远程机器功能', 'machines-unsupported')
    const r = await this.deps.machines.close({ id: machine, service }).catch(asUsage)
    return { text: r.closed ? `已关掉 ${machine} 的 ${service} 隧道（本机端口 ${String(r.localPort)}）` : `${machine} 的 ${service} 隧道本来就没开`, data: r }
  }

  /**
   * 网页登录网址。口令只在 DSH 进程内存里，每次启动换一个，桌面端只交给自己的窗口，所以从别处打开网页只能经这里取。
   * 口令不绑地址，base 换成经 SSH 转发的地址照样能登录；登录后的 cookie 按浏览器实际访问的地址签发。
   */
  webUrl(base?: string): CommandResult {
    if (base !== undefined) {
      let parsed: URL
      try { parsed = new URL(base) } catch { throw new UsageError(`--base 不是网址：${base}`) }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new UsageError(`--base 只能是 http 或 https 网址：${base}`)
    }
    if (this.deps.webUrl === undefined) throw new CommandFailure('这个 DSH 拿不到网页登录口令', 'web-url-unsupported')
    const url = this.deps.webUrl(base)
    if (url === undefined) throw new CommandFailure('DSH 网页服务没在监听', 'web-unavailable')
    return { text: `${url}\n这个网址带着这次启动的登录口令，等同登录凭据，别外传；DSH 重启后失效。`, data: { url } }
  }

  /** 现在退出 App 会不会弹确认框（任务将中断、定时任务不会运行），以及卡在哪。 */
  async quitCheck(): Promise<CommandResult> {
    if (this.deps.quitBlockers === undefined) throw new CommandFailure('这个 DSH 拿不到退出前检查', 'quit-check-unsupported')
    const b = this.deps.quitBlockers()
    const scheduled = this.deps.scheduledReminders === undefined ? undefined : await this.deps.scheduledReminders()
    const clear = b.running.length === 0 && b.queued.length === 0 && b.jobs.length === 0
    // 只剩重启后能自动接回的任务（持久监听）：dsh-control restart 会先暂停它们，不算阻碍。
    const restartReady = b.running.length === 0 && b.queued.length === 0 && b.jobs.every((j) => j.survivable === true)
    const details = b.queuedDetails?.filter((d) => d.nextTurnCount > 0 || d.nextStepCount > 0)
    const unexplained = b.queued.filter((id) => !details?.some((d) => d.id === id))
    const lines = clear ? ['已核对的会话与后台任务没有退出阻碍：没有会话在跑、没有待处理收件、没有后台任务在跑。'] : [
      '现在退出会弹「任务将中断」确认框，卡在：',
      ...(b.running.length > 0 ? [`  在跑的会话 ${b.running.length} 个：${b.running.map(short).join(', ')}`] : []),
      ...(details ?? []).map((d) => {
        const sources = d.nextStepSources.map((s) => {
          const label = s.kind === 'tool-jobs' ? '后台任务通知' : s.kind === 'user' ? '用户消息'
            : s.kind === 'unknown' ? '未知来源' : s.form === 'notice' ? '插件通知' : s.form === 'relay' ? '代理消息' : '插件背景'
          return `${label}〔${s.kind}${s.form === undefined ? '' : `/${s.form}`}〕${s.summary ? `：${s.summary}` : ''}`
        })
        return `  会话 ${short(d.id)}：下一轮排队 ${d.nextTurnCount} 条；下一步待领 ${d.nextStepCount} 条${sources.length > 0 ? `（${sources.join('；')}）` : ''}`
      }),
      ...(unexplained.length > 0 ? [`  有排队消息的会话 ${unexplained.length} 个：${unexplained.map(short).join(', ')}`] : []),
      ...(b.jobs.length > 0 ? [`  在跑的后台任务 ${b.jobs.length} 个：${b.jobs.map((j) => `${j.id}（${j.label}）${j.survivable === true ? '〔重启后自动接回〕' : ''}`).join(', ')}`] : []),
      ...(restartReady ? ['  只剩重启后能自动接回的监听：dsh-control restart 会先暂停它们，不用等。'] : []),
    ]
    if (scheduled !== undefined && scheduled.length > 0) {
      lines.push('已打开的会话挂着定时提醒，退出时还会弹「应用关闭期间，定时任务不会运行」确认框；提醒不能暂停；dsh-control restart 会在确认没有会话在跑后替你点「退出」，提醒不会丢：',
        ...scheduled.map((s) => `  会话 ${short(s.sessionId)}：${s.items.map((i) => `「${i.label}」（${i.id.replace(/^schedule-/, '').slice(0, 8)}）`).join('，')}`))
    }
    return { text: lines.join('\n'), data: { ...b, clear, restartReady, ...(scheduled === undefined ? {} : { scheduled }) } }
  }

  /** 要退出重启了：暂停能接回的任务，返回暂停了哪些（每条带所属会话）。 */
  restartPrepare(): CommandResult {
    this.assertWritable()
    const items = this.deps.restartPrepare?.() ?? []
    this.deps.log(`restart-prepare ${items.map((i) => i.id).join(',')}`)
    return {
      text: items.length === 0 ? '没有需要暂停的任务' : `为重启暂停了 ${items.length} 个任务，新进程起来后自动接回：${items.map((i) => `${i.id}（${i.label}）`).join('，')}`,
      data: { suspended: items },
    }
  }

  /** 重启没成：把刚暂停的任务接回。 */
  async restartAbort(): Promise<CommandResult> {
    this.assertWritable()
    if (this.deps.restartAbort === undefined) throw new CommandFailure('这个 DSH 不支持确认监听恢复结果', 'restart-abort-unsupported')
    const result = await this.deps.restartAbort()
    this.deps.log(`restart-abort revived=${result.revived.join(',')} failed=${result.failed.map(item => item.id).join(',')}`)
    return {
      text: result.failed.length > 0
        ? `恢复未完成：${result.failed.map(item => `${item.id}：${item.error}`).join('；')}。暂停记录保留，可重试。`
        : result.revived.length === 0 ? '没有要接回的任务' : `已接回：${result.revived.join(', ')}`,
      data: result,
    }
  }

  async monitor(raw: string, options: { command?: string | undefined; cwd?: string | undefined; label?: string | undefined; restart?: string | undefined; quiet?: boolean }): Promise<CommandResult> {
    this.assertWritable()
    if (options.command === undefined || options.command.trim() === '') throw new UsageError('monitor 必须提供非空 --command')
    if (options.cwd === undefined || !isAbsolute(options.cwd)) throw new UsageError('monitor 必须提供绝对工作目录 --cwd')
    if (options.restart !== undefined && options.restart !== 'never' && options.restart !== 'on-failure') throw new UsageError('monitor 的 --restart 只能是 never 或 on-failure')
    if (this.deps.startMonitor === undefined) throw new CommandFailure('这个 DSH 没有直接启动持久服务的能力', 'monitor-unsupported')
    const { id } = await this.resolve(raw)
    if ((await this.workspaces()).archived.has(id)) throw new UsageError('不能给已存档会话启动服务；先明确取消存档', 'session-archived')
    const request: MonitorStartRequest = {
      owner: id, command: options.command, cwd: options.cwd,
      label: options.label?.trim() || options.command.split('\n')[0]!,
      ...(options.restart === undefined ? {} : { restart: options.restart }),
      ...(options.quiet === true ? { quiet: true } : {}),
    }
    await this.deps.startMonitor(request)
    const result = request.result
    if (result === undefined) throw new CommandFailure('没有监听插件接收直接启动请求；请检查 dsh-monitor 是否已加载', 'monitor-unsupported')
    if (!result.id || result.owner !== id || result.command !== request.command || result.cwd !== request.cwd) {
      throw new CommandFailure('监听插件未确认服务及所属会话；请先核对任务列表，不要重复启动', 'monitor-unconfirmed')
    }
    this.deps.log(`monitor ${result.id} owner=${id}`)
    return { text: `已将服务 ${result.label} 挂到会话 ${short(id)}，任务 ${result.id}；重启时自动暂停并接回原会话，没有给模型发送消息${request.quiet === true ? '，输出也不推进会话' : ''}。服务是否可用仍需实际检查。`, data: result }
  }

  /**
   * 停掉后台任务。给了 id 就停那几个，`all` 停掉所有在跑的。
   * bash 任务顺带查出命令和启动时的目录，重启后 dsh-control restart 用它们在原会话里重新拉起。
   */
  async killJobs(ids: string[]): Promise<CommandResult> {
    this.assertWritable()
    if (this.deps.killJob === undefined || this.deps.quitBlockers === undefined) throw new CommandFailure('这个 DSH 拿不到后台任务', 'jobs-unsupported')
    const known = this.deps.quitBlockers().jobs
    const targets = ids.length === 1 && ids[0] === 'all' ? known.map((j) => j.id) : ids
    if (targets.length === 0) return { text: '没有在跑的后台任务', data: { killed: [] } }
    const results: { id: string; outcome: string; kind?: string; label?: string; owner?: string; cwd?: string }[] = []
    for (const id of targets) {
      const job = known.find((j) => j.id === id)
      const cwd = job?.kind === 'bash' && job.owner !== undefined ? await this.jobCwd(job.owner, id) : undefined
      let outcome: string
      try { outcome = this.deps.killJob(id, 'dsh-control restart') } catch (error) { outcome = `失败：${error instanceof Error ? error.message : String(error)}` }
      results.push({ id, outcome, ...(job === undefined ? {} : { kind: job.kind, label: job.label }), ...(job?.owner === undefined ? {} : { owner: job.owner }), ...(cwd === undefined ? {} : { cwd }) })
    }
    this.deps.log(`kill-jobs ${targets.join(',')}`)
    return { text: results.map((r) => `${r.id}：${r.outcome === 'requested' ? '已请求停止' : r.outcome === 'already-finished' ? '已经结束' : r.outcome}`).join('\n'), data: { killed: results } }
  }

  /** bash 后台任务启动时的目录：按主人会话记录里的任务登记找到那次调用，取调用结果记下的 cwd；找不到就是 undefined。 */
  private async jobCwd(owner: string, jobId: string): Promise<string | undefined> {
    try {
      const { events } = await this.deps.query.readSession(owner)
      const callId = obj(obj(events.find((e) => e.type === 'job/registered' && obj(e.data).jobId === jobId)?.data).toolCall).callId
      if (typeof callId !== 'string') return undefined
      for (const e of events) {
        const d = obj(e.data)
        const cwd = obj(d.meta).cwd
        if ((d.subCallId === callId || d.toolCallId === callId) && typeof cwd === 'string' && isAbsolute(cwd)) return cwd
      }
    } catch { /* 读不到记录就当不知道目录，调用方不会去拉起 */ }
    return undefined
  }

  async cancel(raw: string): Promise<CommandResult> {
    this.assertWritable()
    const { id, summary } = await this.resolve(raw)
    if (!summary.running) return { text: `会话 ${short(id)} 没在跑，不用中止`, data: { sessionId: id, cancelled: false } }
    await this.call('session/cancel', { request: { sessionId: id } })
    this.deps.log(`cancel ${id}`)
    return { text: `已请求中止会话 ${short(id)}`, data: { sessionId: id, cancelled: true } }
  }

  async answer(raw: string, options: { text?: string; select?: string[]; json?: unknown; callId?: string }): Promise<CommandResult> {
    this.assertWritable()
    const { id, summary } = await this.resolve(raw)
    const questions = openQuestions(summary)
    const target = options.callId === undefined ? questions[0] : questions.find((q) => q.callId === options.callId)
    if (target === undefined) throw new UsageError(`会话 ${short(id)} 现在没有在等你回答的问题`, 'no-question')
    let answer: unknown
    if (options.json !== undefined) {
      answer = options.json
    } else {
      if (target.questions.length !== 1) throw new UsageError(`这次有 ${target.questions.length} 个问题，用 --json '{"answers":[{"id":"...","selected":["..."]}]}' 一次答完`, 'usage', target.questions)
      const q = target.questions[0]!
      const labels = (q.options ?? []).map((o) => o.label)
      const selected = (options.select ?? []).map((s) => matchOption(s, labels))
      answer = { answers: [{ id: q.id, selected, ...(options.text === undefined ? {} : { custom: options.text }) }] }
    }
    let ok: boolean
    if (target.blocking !== undefined && this.deps.pending !== undefined) {
      try {
        ok = this.deps.pending.answer(id, answer as { answers: { id: string; selected: string[]; custom?: string }[] }, target.blocking)
      } catch (error) {
        throw new UsageError(error instanceof Error ? error.message : String(error), 'usage', target.questions)
      }
    } else {
      ok = (await this.call('userQuestions/answer', { agentId: id, callId: target.callId, answer })) === true
    }
    this.deps.log(`answer ${id} ${target.callId}`)
    if (!ok) throw new UsageError(`回答没被接收：问题可能已经失效（被界面答掉或超时）。dsh-control status ${short(id)} 看现在的状态`, 'answer-rejected', { sessionId: id, callId: target.callId })
    return { text: '已回答，会话会接着跑', data: { sessionId: id, accepted: true, answer } }
  }

  // ---- 模型与额度 ----

  async catalog(): Promise<{ default: Json; set: Set<string>; groups: { id: string; name: string; models: { id: string; name: string; reasoning?: { efforts?: { id: string }[] } }[] }[]; failures: unknown[] }> {
    const c = obj(await this.call('session/modelCatalog', {}))
    const groups = (Array.isArray(c.groups) ? c.groups : []) as { id: string; name: string; models: { id: string; name: string; reasoning?: { efforts?: { id: string }[] } }[] }[]
    const set = new Set(groups.flatMap((g) => g.models.map((m) => routeKey(g.id, m.id))))
    return { default: obj(c.default), set, groups, failures: Array.isArray(c.failures) ? c.failures : [] }
  }

  async quota(force: boolean): Promise<CommandResult> {
    const report = await this.deps.usage(force)
    if (report === undefined) throw new CommandFailure('拿不到额度报告：模型额度服务 没装或没加载。dsh-control plugins 看它在不在、有没有报错', 'quota-unavailable')
    const config = this.deps.config()
    const wanted = new Map<string, Set<string>>()
    for (const c of [...config.tiers.normal, ...config.tiers.fast]) {
      const set = wanted.get(c.quota) ?? new Set()
      for (const label of Object.keys(c.windows)) set.add(label)
      wanted.set(c.quota, set)
    }
    const lines: string[] = [`额度（${shortClock(report.fetchedAt)} 查询${report.stale === true ? '，可能过期' : ''}）：`]
    for (const [quota, labels] of wanted) {
      const p = report.providers.find((x) => x.id === quota)
      if (p === undefined) { lines.push(`  ${quota}：没有数据`); continue }
      if (!p.ok) { lines.push(`  ${p.name}：查不到（${p.error ?? '未知'}）`, `    ${fixHint(p)}`); continue }
      const parts = [...labels].map((label) => {
        const w = p.windows.find((x) => x.label === label && x.scope !== 'model')
        if (w === undefined) return `${label} 无`
        const margin = w.expectedLeft === undefined ? '' : w.left - w.expectedLeft >= 0 ? ` 省${Math.round(w.left - w.expectedLeft)}%` : ` 超${Math.round(w.expectedLeft - w.left)}%`
        const runs = w.runsOut !== undefined && (w.resetsAt === undefined || w.runsOut < w.resetsAt) ? ` 预计${shortClock(w.runsOut)}用光` : ''
        return `${label} 剩${Math.round(w.left)}%${margin}${w.resetsAt === undefined ? '' : ` ${shortClock(w.resetsAt)}重置`}${runs}`
      })
      lines.push(`  ${p.name}：${parts.join('，')}`)
    }
    return { text: lines.join('\n'), data: report }
  }

  async models(): Promise<CommandResult> {
    const config = this.deps.config()
    const [report, catalog] = await Promise.all([this.deps.usage(false), this.catalog()])
    const lines: string[] = []
    const data: Record<string, unknown> = {}
    for (const tier of ['normal', 'fast'] as const) {
      const result = pick(tier, config.tiers, report, { reservePercent: config.reservePercent, now: this.now(), catalog: catalog.set, ...(config.paused === undefined ? {} : { skip: config.paused }) })
      data[tier] = result
      lines.push(`${tier} 档（${TIER_LABEL[tier]}）${result.chosen === undefined ? '：没有可用模型' : `：现在选 ${routeKey(result.chosen.provider, result.chosen.model)}`}`)
      for (const v of result.candidates) lines.push(`  ${v === result.chosen ? '→' : v.usable ? '·' : '✗'} ${verdictLine(v)}`)
    }
    lines.push(...quotaFixLines(report, config.tiers))
    if (config.tiersError !== undefined) lines.push(`档位读不到：${config.tiersError}`)
    lines.push('两档在 DSH「设置 → 默认模型与档位」里改（存在 ~/.dsh/preferences.json）')
    lines.push(`默认模型：${String(catalog.default.provider)}/${String(catalog.default.model)}`)
    return { text: lines.join('\n'), data: { ...data, default: catalog.default, catalog: catalog.groups.map((g) => ({ provider: g.id, name: g.name, models: g.models.map((m) => m.id) })) } }
  }

  async pickModel(tier: Tier): Promise<CommandResult> {
    const config = this.deps.config()
    const [report, catalog] = await Promise.all([this.deps.usage(false), this.catalog()])
    const result = pick(tier, config.tiers, report, { reservePercent: config.reservePercent, now: this.now(), catalog: catalog.set, ...(config.paused === undefined ? {} : { skip: config.paused }) })
    const lines = result.chosen === undefined
      ? [`${tier} 档（${TIER_LABEL[tier]}）现在没有可用模型。`, ...(config.tiersError === undefined ? [] : [`档位读不到：${config.tiersError}`]), ...result.candidates.map((v) => `  ✗ ${verdictLine(v)}`), ...(result.earliestReset === undefined ? [] : [`最早 ${shortClock(result.earliestReset)} 有额度重置。`]), ...quotaFixLines(report, { ...config.tiers, [tier === 'normal' ? 'fast' : 'normal']: [] }), tier === 'fast' ? '可以改用 normal 档。' : '可以问用户要不要改用 fast 档，或等重置。']
      : [`选 ${routeKey(result.chosen.provider, result.chosen.model)}`, ...result.candidates.map((v) => `  ${v === result.chosen ? '→' : v.usable ? '·' : '✗'} ${verdictLine(v)}`), ...quotaFixLines(report, { ...config.tiers, [tier === 'normal' ? 'fast' : 'normal']: [] })]
    if (result.chosen === undefined) throw new UsageError(lines.join('\n'), 'no-model', result)
    return { text: lines.join('\n'), data: result }
  }

  /** 按档位挑或按指定核对模型目录，得出要用的模型；挑不出就抛 no-model / not-found，不改任何东西。 */
  private async chooseRoute(options: { tier?: Tier; model?: string }): Promise<Route> {
    if (options.model !== undefined) {
      const m = /^([^/]+)\/(.+)$/.exec(options.model.trim())
      if (m === null) throw new UsageError(`模型要写成 provider/model，例如 claude/claude-opus-5-5；收到 "${options.model}"`)
      const catalog = await this.catalog()
      if (!catalog.set.has(routeKey(m[1]!, m[2]!))) throw new UsageError(`模型目录里没有 ${options.model}；用 dsh-control models 看可用的`, 'not-found')
      return { provider: m[1]!, model: m[2]!, reason: '按指定' }
    }
    const tier = options.tier ?? 'normal'
    const chosen = ((await this.pickModel(tier)).data as { chosen: { provider: string; model: string } }).chosen
    return { provider: chosen.provider, model: chosen.model, reason: `${tier} 档当前最合适` }
  }

  private async validateEffort(route: Route, effort: string): Promise<void> {
    const catalog = await this.catalog()
    const model = catalog.groups.find((group) => group.id === route.provider)?.models.find((item) => item.id === route.model)
    const choices = model?.reasoning?.efforts?.map((item) => item.id) ?? []
    if (!choices.includes(effort)) throw new UsageError(`模型 ${route.provider}/${route.model} 不支持推理档位 "${effort}"；可选值：${choices.length ? choices.join('、') : '无'}`, 'invalid-effort')
  }

  private async applyRoute(id: string, route: Route, reasoningEffort?: string, explicit = false): Promise<CommandResult> {
    this.assertWritable()
    const { provider, model, reason } = route
    const current = await this.currentRoute(id)
    // 同模型再发一次不带等级的 selectModel，宿主会把等级清空、落回模型自带默认（Sol 是 low）。
    // 新会话一建好就挂着默认模型和默认等级，所以目标就是默认模型时这条判断必须先挡住。
    if (current !== undefined && current.provider === provider && current.model === model && (reasoningEffort === undefined || current.reasoningEffort === reasoningEffort)) {
      return { text: `模型不变：${provider}/${model}（${reason}${current.reasoningEffort === undefined ? '' : `，推理等级 ${current.reasoningEffort}`}）`, data: { provider, model, changed: false, selected: current } }
    }
    const automatic = this.deps.automaticSelect?.()
    const select = async (effort?: string): Promise<Json> => {
      const request = { sessionId: id, provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
      return obj(automatic === undefined ? await this.call('session/selectModel', { request }) : await automatic.selectModel(request))
    }
    const switching = current?.provider !== provider || current.model !== model
    // 模型额度服务 换模型时会用记忆档位覆盖显式档位，所以先换模型，再在同一模型上设档。
    if (explicit && switching) await select()
    const result = await select(reasoningEffort)
    if (explicit) {
      const actual = await this.currentRoute(id)
      if (actual?.provider !== provider || actual.model !== model || actual.reasoningEffort !== reasoningEffort) {
        throw new CommandFailure(`模型选择已执行，但会话未确认推理档位 ${reasoningEffort}；请先查看会话状态，不要直接重试`, 'effort-unconfirmed', { sessionId: id, requested: { provider, model, reasoningEffort }, actual: actual ?? null })
      }
    }
    const selected = obj(result.selected)
    this.deps.log(`model ${id} -> ${provider}/${model}`)
    return { text: `模型换成 ${provider}/${model}（${reason}${typeof selected.reasoningEffort === 'string' ? `，推理等级 ${selected.reasoningEffort}` : ''}）${current === undefined ? '' : `，原来是 ${current.provider}/${current.model}`}`, data: { provider, model, changed: true, from: current ?? null, selected } }
  }

  async model(raw: string, options: { tier?: Tier; model?: string; effort?: string; force?: boolean }): Promise<CommandResult> {
    this.assertWritable()
    const { id, summary } = await this.resolve(raw)
    const current = await this.currentRoute(id)
    if (options.tier === undefined && options.model === undefined && current === undefined) throw new UsageError('无法确定会话当前模型，请用 --model 指定', 'not-found')
    const route = options.tier === undefined && options.model === undefined && current !== undefined
      ? { provider: current.provider, model: current.model, reason: '保持当前模型' }
      : await this.chooseRoute(options)
    if (options.effort !== undefined) await this.validateEffort(route, options.effort)
    if (current?.provider === route.provider && current.model === route.model && (options.effort === undefined || options.effort === current.reasoningEffort)) return this.applyRoute(id, route, options.effort, options.effort !== undefined)
    const t = await this.transcript(id)
    if (options.force !== true && t.turns.length > 0) {
      const stalled = current === undefined ? false : await this.isExhausted(current)
      if (!stalled) {
        throw new UsageError(
          `会话 ${short(id)} 已经跑过 ${t.turns.length} 轮，换模型会丢掉提示缓存，下一轮可能增加开销；当前模型 ${current === undefined ? '未知' : `${current.provider}/${current.model}`} 未确认额度用光，所以没换。如果用户已明确要求切换，先用 wait-idle ${short(id)} 等会话停下，再给 model 加 --force；--force 也会跳过运行中保护。`,
          'model-change-refused',
          { sessionId: id, changed: false, current: current ?? null },
        )
      }
    }
    if (summary.running && options.force !== true) {
      throw new UsageError(`会话 ${short(id)} 正在跑，没换。等这一轮结束再换（或加 --force）`, 'session-running', { sessionId: id, changed: false })
    }
    return this.applyRoute(id, route, options.effort, options.effort !== undefined)
  }

  private async currentRoute(id: string): Promise<{ provider: string; model: string; reasoningEffort?: string } | undefined> {
    const summary = (await this.sessions()).find((s) => s.sessionId === id)
    const selection = obj(obj(summary?.projections?.values).modelSelection)
    for (const key of ['next', 'pending', 'lastUsed']) {
      const r = obj(selection[key])
      if (typeof r.provider === 'string' && typeof r.model === 'string') return { provider: r.provider, model: r.model, ...(typeof r.reasoningEffort === 'string' ? { reasoningEffort: r.reasoningEffort } : {}) }
    }
    const t = await this.transcript(id)
    return t.model === undefined ? undefined : { provider: t.model.provider, model: t.model.model }
  }

  /** 这个模型看的窗口里有没有已经用光的。 */
  private async isExhausted(route: { provider: string; model: string }): Promise<boolean> {
    const config = this.deps.config()
    const hit = tierOf(config.tiers, route.provider, route.model)
    if (hit === undefined) return false
    const report = await this.deps.usage(false)
    const p = report?.providers.find((x) => x.id === hit.candidate.quota)
    if (p === undefined || !p.ok) return false
    return Object.keys(hit.candidate.windows).some((label) => {
      const w = p.windows.find((x) => x.label === label && x.scope !== 'model')
      return w !== undefined && w.left <= 0 && (w.resetsAt === undefined || w.resetsAt > this.now())
    })
  }

  /** 发消息前看一眼当前模型的额度，快用完时提醒（不自动换）。 */
  private async quotaWarning(id: string, summary: SessionSummaryWire): Promise<string | undefined> {
    try {
      const values = obj(summary.projections?.values)
      const selection = obj(values.modelSelection)
      const r = obj(selection.next).provider !== undefined ? obj(selection.next) : obj(selection.lastUsed)
      if (typeof r.provider !== 'string' || typeof r.model !== 'string') return undefined
      const config = this.deps.config()
      const hit = tierOf(config.tiers, r.provider, r.model)
      if (hit === undefined) return undefined
      const report = await this.deps.usage(false)
      const result = pick(hit.tier, { ...config.tiers, [hit.tier]: [hit.candidate] }, report, { reservePercent: config.reservePercent, now: this.now() })
      const v = result.candidates[0]
      if (v === undefined) return undefined
      if (v.usable) return v.warnings.length === 0 ? undefined : `提醒：当前模型 ${r.provider}/${r.model} ${v.warnings.join('；')}。先照常发了。`
      if (await this.isExhausted({ provider: r.provider, model: r.model })) {
        return `提醒：当前模型 ${r.provider}/${r.model} 额度已用光（${v.reasons.join('；')}），会话可能停住。可以用 dsh-control model ${short(id)} --tier ${hit.tier} 换同档模型。`
      }
      return `提醒：当前模型 ${r.provider}/${r.model} ${v.reasons.join('；')}。先照常发了；真卡住再换模型。`
    } catch {
      return undefined
    }
  }

  // ---- 插件、配置、万能接口 ----

  async plugins(): Promise<CommandResult> {
    const bundles = (await this.call('pluginManager/listBundles', {})) as { name: string; version?: string; enabled: boolean; installed: boolean; removable: boolean; description?: string; error?: { code: string; diagnostic?: string } }[]
    let cut = false
    const clip = (text: string, max: number) => {
      const line = oneLine(text, max)
      if (line.endsWith('…')) cut = true
      return line
    }
    const lines = bundles.map((b) => `${b.enabled ? '●' : '○'} ${b.name}${b.version === undefined ? '' : `@${b.version}`}${b.error === undefined ? '' : `  ✗ ${b.error.code}${b.error.diagnostic === undefined ? '' : `：${clip(b.error.diagnostic, 120)}`}`}${b.description === undefined ? '' : `  — ${clip(b.description, 80)}`}`)
    if (cut) lines.push('', '以 … 结尾的描述或错误被截断了；看全文用 dsh-control plugins --json')
    return { text: lines.join('\n'), data: bundles.map((b) => ({ name: b.name, version: b.version ?? null, enabled: b.enabled, installed: b.installed, removable: b.removable, description: b.description ?? null, error: b.error ?? null })) }
  }

  async pluginAction(action: 'install' | 'remove' | 'enable' | 'disable', name: string, force = false): Promise<CommandResult> {
    this.assertWritable()
    if ((action === 'remove' || action === 'disable') && name === 'dsh-control' && !force) {
      throw new UsageError('这会关掉远程控制本身：通信口随之关闭，之后远程再也连不上，只能回电脑前在 DSH 里重新启用。确实要这样做加 --force', 'usage')
    }
    let result: unknown
    if (action === 'install') result = await this.call('pluginManager/installBundle', { spec: name, options: { requestId: randomUUID() } })
    else if (action === 'remove') result = await this.call('pluginManager/removeBundle', { name })
    else result = await this.call('pluginManager/setBundleEnabled', { name, enabled: action === 'enable' })
    this.deps.log(`plugin ${action} ${name}`)
    const r = obj(result)
    const application = typeof r.application === 'string' ? r.application : undefined
    const err = obj(r.error)
    if (err.code !== undefined || application === 'failed' || application === 'cancelled') {
      const why = err.code === undefined ? (application === 'cancelled' ? '操作被取消' : '宿主报告操作失败') : String(err.code)
      throw new CommandFailure(`plugin ${action} ${name} 没做成：${why}${typeof err.diagnostic === 'string' ? `\n${err.diagnostic}` : ''}`, 'plugin-action-failed', result)
    }
    const text = application === 'restart-required' ? '完成，要重启 DSH 才生效（dsh-control restart）'
      : application === 'applied' ? '完成，已经生效'
      : `完成（${application ?? 'ok'}）`
    return { text, data: result }
  }

  async settingsGet(ns?: string): Promise<CommandResult> {
    const d = obj(await this.call('settings/describe', {}))
    const namespaces = (Array.isArray(d.namespaces) ? d.namespaces : []) as { ns: string; value: unknown; revision: number; secrets: { path: string[] }[] }[]
    if (ns === undefined) {
      return { text: [`可改的设置（${d.writable === true ? '可写' : '只读'}）：`, ...namespaces.map((n) => `  ${n.ns}`)].join('\n'), data: namespaces.map((n) => n.ns) }
    }
    const n = namespaces.find((x) => x.ns === ns)
    if (n === undefined) throw new UsageError(`没有设置 "${ns}"；dsh-control config 看全部`, 'not-found')
    return { text: `${ns}（revision ${n.revision}）：\n${JSON.stringify(n.value, null, 2)}`, data: n }
  }

  async settingsSet(ns: string, patch: Record<string, unknown>): Promise<CommandResult> {
    this.assertWritable()
    const current = await this.settingsGet(ns)
    const revision = (current.data as { revision: number }).revision
    const result = obj(await this.call('settings/update', { ns, patch, expectedRevision: revision }))
    this.deps.log(`config ${ns} ${Object.keys(patch).join(',')}`)
    return { text: `${ns} 已更新（revision ${String(result.revision)}），立即生效：\n${JSON.stringify(result.value, null, 2)}`, data: result }
  }

  apiList(namespace?: string): CommandResult {
    const all = this.deps.typert.list().map(describeEndpoint).sort((a, b) => a.endpoint.localeCompare(b.endpoint))
    const config = this.deps.config()
    const shown = namespace === undefined ? all : all.filter((e) => e.endpoint.startsWith(`${namespace}/`))
    const denied = new Set(config.denyNamespaces)
    const lines = shown.map((e) => `${e.endpoint}${e.stream ? ' [流]' : ''}(${e.args.join(', ')})${denied.has(e.endpoint.split('/')[0]!) ? ' [已禁用]' : isReadOnlyEndpoint(e.endpoint.split('/')[1]!) ? '' : ' [写]'}`)
    return { text: lines.length === 0 ? `没有 ${namespace ?? ''} 开头的接口` : lines.join('\n'), data: shown }
  }

  apiDescribe(endpoint: string): CommandResult {
    const { namespace, method } = splitEndpoint(endpoint)
    const d = this.deps.typert.get(`${namespace}/${method}`)
    if (d === undefined) throw new UsageError(`没有接口 ${namespace}/${method}；dsh-control api list 看全部`, 'not-found')
    const info = describeEndpoint(d)
    const schemas = parameterSchemas(d)
    return { text: `${info.endpoint}${info.stream ? '（流式）' : ''}  来自 ${info.package}\nargs 字段：\n${JSON.stringify(schemas, null, 2)}`, data: { ...info, schemas } }
  }

  async apiCall(endpoint: string, args: Record<string, unknown>, options: { maxItems?: number; timeoutMs?: number; signal?: AbortSignal }): Promise<CommandResult> {
    const { namespace, method } = splitEndpoint(endpoint)
    const config = this.deps.config()
    if (config.denyNamespaces.includes(namespace)) throw new UsageError(`接口 ${namespace}/* 在远程控制里被禁用（配置 denyNamespaces）`, 'denied')
    if (config.readOnly && !isReadOnlyEndpoint(method)) throw new UsageError('远程控制处于只读模式，不能调用会改东西的接口', 'read-only')
    const d = this.deps.typert.get(`${namespace}/${method}`)
    if (d === undefined) throw new UsageError(`没有接口 ${namespace}/${method}；dsh-control api list 看全部`, 'not-found')
    this.deps.log(`api ${namespace}/${method}`)
    if (d.mode === 'stream') {
      const stream = await this.deps.gateway.stream({ namespace, method, args, ...(options.signal === undefined ? {} : { signal: options.signal }) })
      const collected = await collectStream(stream, { maxItems: options.maxItems ?? 1, timeoutMs: options.timeoutMs ?? 5000, ...(options.signal === undefined ? {} : { signal: options.signal }) })
      return { text: JSON.stringify(collected, null, 2), data: collected }
    }
    let value: unknown
    try {
      value = await this.deps.gateway.invoke({ namespace, method, args, ...(options.signal === undefined ? {} : { signal: options.signal }) })
    } catch (error) {
      const payload = errorPayload(error)
      if (payload.code === 'gateway/arguments-invalid' || payload.code === 'gateway/input-invalid') {
        throw new UsageError(`${payload.message}\n参数写法：dsh-control api describe ${namespace}/${method}`, 'usage', payload.details)
      }
      throw error
    }
    return { text: JSON.stringify(value ?? null, null, 2), data: value ?? null }
  }

  private assertWritable(): void {
    if (this.deps.config().readOnly) throw new UsageError('远程控制处于只读模式，不能执行会改东西的命令', 'read-only')
  }
}

// ---- 小工具 ----

export interface OpenQuestion {
  callId: string
  /** 阻塞式提问的待答表键；有它说明回答要走插件自己的待答表，不走 userQuestions/answer。 */
  blocking?: string
  questions: { id: string; question: string; header?: string; detail?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[]
}

export function openQuestions(s: SessionSummaryWire): OpenQuestion[] {
  const uq = obj(obj(s.projections?.values).userQuestions)
  const active = Array.isArray(uq.active) ? uq.active as (OpenQuestion & { state?: string })[] : []
  return active.filter((q) => q.state !== 'continued')
}

/** 把 --select 给的文字对上选项：完全匹配优先，否则唯一前缀、唯一包含；多个就报歧义，没有就列出选项。 */
export function matchOption(wanted: string, labels: string[]): string {
  if (labels.includes(wanted)) return wanted
  const needle = wanted.trim().toLowerCase()
  if (needle !== '') {
    const lower = labels.map((l) => l.toLowerCase())
    const exact = labels.filter((_, i) => lower[i] === needle)
    if (exact.length === 1) return exact[0]!
    for (const hits of [labels.filter((_, i) => lower[i]!.startsWith(needle)), labels.filter((_, i) => lower[i]!.includes(needle))]) {
      if (hits.length === 1) return hits[0]!
      if (hits.length > 1) throw new UsageError(`"${wanted}" 对上了 ${hits.length} 个选项：${hits.join('、')}；写完整的选项文字`, 'ambiguous', hits)
    }
  }
  throw new UsageError(`"${wanted}" 不是这个问题的选项；选项有：${labels.join('、')}`, 'invalid-option', labels)
}

/** 额度查不到的那家该去哪修：用 模型额度服务 给的提示，没有就给通用做法。 */
export function fixHint(p: { name: string; hint?: string }): string {
  const how = typeof p.hint === 'string' && p.hint.trim() !== '' ? p.hint.trim() : `在 DSH 界面左下角的额度卡片里看 ${p.name} 的修复办法`
  return `怎么修：${how}；修好后 dsh-control quota --refresh 重查`
}

/** 两档候选涉及的、额度查不到的每一家给一行修复提示。 */
function quotaFixLines(report: UsageReportLike | undefined, tiers: TierTable): string[] {
  if (report === undefined) return []
  const quotas = new Set([...tiers.normal, ...tiers.fast].map((c) => c.quota))
  return report.providers.filter((p) => quotas.has(p.id) && !p.ok).map((p) => `${p.name} 额度查不到（${p.error ?? '未知原因'}）。${fixHint(p)}`)
}

function questionLines(q: OpenQuestion): string[] {
  return q.questions.flatMap((x) => [
    `  问题：${x.header === undefined ? '' : `[${x.header}] `}${x.question}${x.multiSelect === true ? '（可多选）' : ''}`,
    ...(x.detail === undefined ? [] : [`    ${oneLine(x.detail, 300)}`]),
    ...(x.options ?? []).map((o) => `    - ${o.label}${o.description === undefined ? '' : `：${oneLine(o.description, 120)}`}`),
  ])
}

interface QueueItem { id: string; content?: unknown }

/** 下一轮的排队消息（界面排队条显示的就是这些）。 */
function queuedItems(s: SessionSummaryWire): QueueItem[] {
  const inbox = obj(obj(s.projections?.values).inbox)
  const rows = Array.isArray(inbox['next-turn']) ? inbox['next-turn'] : []
  return rows.filter((m): m is QueueItem => typeof obj(m).id === 'string')
}

function rpcIdOf(m: QueueItem): string | undefined {
  const source = obj((m as { source?: unknown }).source)
  return typeof source.rpcId === 'string' ? source.rpcId : undefined
}

/**
 * 排队消息的编号：发消息时的请求 id 前 8 位（`send` 发出时就能告诉调用方），没有就用消息 id 前 8 位。
 * 不随队列前移变化。
 */
export function queueCode(m: QueueItem): string {
  return (rpcIdOf(m) ?? m.id).replace(/-/g, '').slice(0, 8).toLowerCase()
}

function messageText(m: QueueItem): string {
  const blocks = Array.isArray(m.content) ? m.content : []
  const text = blocks.map((b) => {
    const x = obj(b)
    return x.type === 'text' && typeof x.text === 'string' ? x.text : x.type === 'image' ? '[图片]' : x.type === 'file' ? '[文件]' : ''
  }).join(' ').trim()
  return text === '' ? '（没有文字）' : text
}

function titleOf(s: SessionSummaryWire): { title?: string } {
  const title = obj(s.projections?.values).title
  return typeof title === 'string' && title !== '' ? { title } : {}
}

/** 会话现在的工作目录：0.2.1 起可以中途换，`cwd` 只是起始目录。 */
function currentDir(s: SessionSummaryWire): string | undefined {
  const value = obj(s.projections?.values).workingDirectory
  return typeof value === 'string' ? value : s.cwd
}

const KIND_TEXT: Record<string, string> = { after: '一次', at: '一次', every: '每隔一段', daily: '每天', weekly: '每周', cron: 'cron' }

function scheduleLine(s: ScheduleWire): string {
  const state = s.status === 'active' ? '' : '  已结束'
  return `${s.id.replace(/^schedule-/, '').slice(0, 8)}  「${s.title}」  ${KIND_TEXT[s.kind] ?? s.kind}，下次 ${dateTime(s.scheduledAt)}${state}  会话 ${short(s.sessionId)}`
}

function dateTime(value: unknown): string {
  const ms = typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : NaN
  if (Number.isNaN(ms)) return '未知'
  return new Date(ms).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function phaseText(phase: unknown): string {
  return ({ active: '进行中', paused: '已暂停', blocked: '卡住了', complete: '已完成' } as Record<string, string>)[String(phase)] ?? String(phase)
}

export function short(id: string): string {
  return id.replace(/^session-/, '').slice(0, 8)
}

function stateOf(s: SessionSummaryWire): 'asking' | 'running' | 'idle' {
  if (openQuestions(s).length > 0) return 'asking'
  return s.running ? 'running' : 'idle'
}

function stateText(s: SessionSummaryWire): string {
  return { asking: '在等你回答', running: '在跑', idle: '空闲' }[stateOf(s)]
}

function sessionLine(s: SessionSummaryWire): string {
  const values = obj(s.projections?.values)
  const todos = Array.isArray(values.todos) ? values.todos as { status: string }[] : []
  const progress = todos.length === 0 ? '' : ` 待办${todos.filter((x) => x.status === 'completed').length}/${todos.length}`
  const cwd = currentDir(s)
  const dir = cwd === undefined ? '' : `  ${cwd.replace(process.env['HOME'] ?? '\u0000', '~')}`
  return `${short(s.sessionId)}  ${stateText(s).padEnd(5, '　')}  ${clock(s.updatedAt)}  ${titleOf(s).title ?? '(无标题)'}${progress}${dir}`
}

export { errorPayload }
