import { live } from '../../tooling/runtime/live.mjs'
import { createRouteRegistry } from '../../tooling/runtime/routes.mjs'
/**
 * dsh-control：把正在运行的 DSH 通过本机通信口开放给外部 agent（Hermes / Claude Code / Codex）。
 *
 * ## 为什么要这个插件
 *
 * DSH 没有给外部程序控制「正在运行的这一个」的入口：网页端口只认浏览器登录（一次性令牌只在 App 启动时
 * 塞进打开的网址），`dsh` 命令行是另起一个新进程，SDK 服务也是新进程。插件在 DSH 进程里，可以直接调
 * 界面自己用的内部接口（`ctx.typertGateway`），所以由它开一个只有本账户能连的通信口，把能力递出去。
 *
 * ## 三块
 *
 * - 本插件：通信口 + 命令实现（`src/service.ts`）。
 * - `dsh-control`（`src/cli/dsh-control.ts`）：薄命令行，只转发，不懂任何命令。
 * - `skills/dsh-control/SKILL.md`：教外部 agent 怎么用 dsh-control。
 *
 * 额度读 模型额度服务 已注册在本机网页端口上的 `/模型额度服务/usage/report`（同一份两分钟缓存），两个插件不互相导入。
 * 两档模型优先读 模型额度服务 的 `modelTiers` 服务；未安装时使用本插件明确配置的档位。
 *
 * @module
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { type ContextFormed } from '@deepseek-ai/dsh-llm'
import { deliverNotice, type SessionControllerLike } from './notice.ts'
import { DoneWatcher } from './done-watch.ts'
import { DesktopNotifications, sendDesktopNotification, showSystemNotification } from './desktop-notifications.ts'
import { ownerGateway, type ConnectionLike, type HostGatewayLike } from '../../tooling/runtime/gateway.mjs'
import { CommandFailure, type TypertLocalLike } from './gateway.ts'
import { COMMANDS, runCommand } from './commands.ts'
import { resolveModelTiers, type ConfiguredTiers, type SharedTiersLike, type ModelTiersLike, type TierTable, type UsageReportLike } from './models.ts'
import { PendingQuestions, type AnswerBatch } from './questions.ts'
import { startServer } from './server.ts'
import { MachinePage, machineRoutes, realMachineDeps, type FetchRoute, type Layout } from './machines.ts'
import { collectQuitBlockers, type LiveAgent } from './quit-blockers.ts'
import { RemoteService, type CommandResult, type AutomaticSelectLike, type RestartRecoveryResult, type MonitorStartRequest, type RuntimeConfig, type SessionQueryLike } from './service.ts'

export const name = 'dsh-control'
export const inject = ['typertGateway', 'typert', 'sessionQuery', 'connection']

/**
 * 本插件送进会话的通知的 source kind。`MessageSourceMap` 靠声明合并扩展，各家声明自己的；
 * 带 `form: 'notice'` 的消息界面折叠成一行通知，dsh-message-tidy 会给它加上「不是用户说的」标记。
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-control': { kind: 'dsh-control' } & ContextFormed
  }
}

/**
 * 和 dsh-monitor 约定的重启事件（两个插件不互相导入，只认名字）：
 * survivors 问哪些任务重启后能接回；prepare 要退出了，记下并暂停它们；abort 重启没成，马上接回。
 */
const RESTART_SURVIVORS_EVENT = 'dsh/restart-survivors'
const RESTART_PREPARE_EVENT = 'dsh/restart-prepare'
const RESTART_ABORT_EVENT = 'dsh/restart-abort'

/** 宿主 agents / jobs 里本插件用到的部分（退出前检查用）。 */
interface AgentsLike { list(): LiveAgent[] }
/** 宿主 goals 服务里本插件用到的部分：只收回自动续跑授权，不改目标状态、不发 goal/changed。 */
interface GoalsLike { disarm(agent: LiveAgent): unknown }
interface JobsLike {
  list(caller?: string): { id: string; kind: string; label: string; owner?: string; status: string }[]
  get(id: string, caller?: string): { owner?: string }
  kill(id: string, caller?: string, reason?: string): 'requested' | 'already-finished'
  wait(id: string, timeoutMs: number, caller?: string): Promise<unknown>
}

/** 宿主 `workingDirectory` 服务（0.2.1 起）里本插件用到的方法。 */
interface WorkingDirectoryLike {
  set(agent: unknown, path: string, signal?: AbortSignal): Promise<string>
}

export const Config = z.object({
  /** 只读模式：会改东西的命令（发消息、换模型、装插件、改配置……）一律拒绝。 */
  readOnly: z.boolean().default(false).volatile(),
  /** 远程控制里禁止调用的接口命名空间。默认禁凭据、终端输入和动态执行代码。 */
  denyNamespaces: z.array(z.string()).default(['credentials', 'terminal', 'dynamicCordisRunner', 'account']).volatile(),
  /** `wait` 一次请求最多挂多久（毫秒）；命令行会接着问。 */
  waitSliceMs: z.natural().min(1000).max(120000).default(30000).volatile(),
  /** 网页和桌面窗口全关时，AI 的提问再等多久（毫秒）让 `dsh-control answer` 回答；0 = 照 DSH 原样当场失败。 */
  questionGraceMs: z.natural().max(86_400_000).default(600_000).volatile(),
  tiers: z.object({ normal: z.array(z.string()).default([]), fast: z.array(z.string()).default([]) })
    .default({ normal: [], fast: [] }).volatile().description('Model routes in priority order when optional model/quota provider is not installed; each entry is provider/model.'),
  quotaFromModelPrefix: z.array(z.string()).default([]).volatile()
    .description('Providers whose model id prefix identifies the underlying quota source.'),
  /** 设置「远程机器」一页列的机器；本机按 hostname 认出来不列。 */
  machines: z.array(z.object({
    id: z.string().required(),
    label: z.string().required(),
    hostname: z.string().required(),
    slot: z.natural().max(9).required(),
    secondary: z.boolean().default(false),
  })).default([]).volatile(),
  /** 每台机器上可以开隧道打开的服务；每个服务不一样的地方都写成在对面跑的命令。 */
  services: z.array(z.object({
    id: z.string().required(),
    label: z.string().required(),
    port: z.natural().min(1).max(55526).required(),
    on: z.array(z.string()).default([]),
    check: z.array(z.string()).default([]),
    open: z.array(z.string()).default([]),
    actions: z.array(z.object({
      label: z.string().required(),
      run: z.array(z.string()).required(),
      confirm: z.boolean().default(false),
    })).default([]),
  })).default([]).volatile(),
})

type ConfigCells = ReturnType<typeof Config>

function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

export function dshHome(): string {
  return process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
}

export function socketPath(): string {
  return join(dshHome(), 'dsh-control', 'dsh.sock')
}

const registerMachineRoutes = createRouteRegistry()

interface AgentStatusEvent {
  agent?: { id?: string }
  status?: string
}

export function apply(ctx: Context, config: ConfigCells): void {
  const logger = ctx.logger(name)
  const current = (): RuntimeConfig => {
    // Shared tiers take precedence; standalone lists are read only when that service is absent.
    const shared = ctx.get('modelTiers') as { document(): SharedTiersLike; health(): { provider: string; model: string; label: string; until: number }[] } | undefined
    let tiers: TierTable = { normal: [], fast: [] }
    let reservePercent = 10
    let tiersError: string | undefined
    const paused = new Map<string, string>()
    try {
      const doc = shared === undefined ? undefined : plain(shared.document())
      ;({ tiers, reservePercent, tiersError } = resolveModelTiers(doc, live(config.tiers) as ConfiguredTiers, live(config.quotaFromModelPrefix) as string[]))
      if (shared !== undefined) for (const h of shared.health()) paused.set(`${h.provider}/${h.model}`, `这台机器上最近调用失败：${h.label}，暂时跳过`)
    } catch (error) {
      tiers = { normal: [], fast: [] }
      tiersError = error instanceof Error ? error.message : String(error)
    }
    return {
      readOnly: live(config.readOnly) as boolean,
      denyNamespaces: [...(live(config.denyNamespaces) as string[])],
      reservePercent,
      waitSliceMs: live(config.waitSliceMs) as number,
      tiers,
      paused,
      ...(tiersError === undefined ? {} : { tiersError }),
    }
  }

  const dir = join(dshHome(), 'dsh-control')
  const auditPath = join(dir, 'audit.log')
  const audit = (line: string) => {
    void mkdir(dir, { recursive: true, mode: 0o700 })
      .then(() => appendFile(auditPath, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }))
      .catch(() => {})
  }

  const usage = async (force?: boolean): Promise<UsageReportLike | undefined> => {
    const web = ctx.get('webServer') as { port?: number } | undefined
    const port = web?.port
    if (port === undefined) return undefined
    try {
      const res = await fetch(`http://127.0.0.1:${port}/dsh-models/usage/report${force === true ? '?force=1' : ''}`, { signal: AbortSignal.timeout(60_000) })
      if (!res.ok) return undefined
      const body = await res.json() as UsageReportLike
      return Array.isArray(body.providers) ? body : undefined
    } catch (error) {
      logger.warn(`读额度失败：${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** 发一个插件间约定事件；监听方是同步填 out 的，这里不等异步。 */
  const emit = (name: string, out: unknown): void => {
    try {
      (ctx as unknown as { emit(name: string, ...args: unknown[]): void }).emit(name, out)
    } catch (error) {
      logger.warn(`${name} 有监听方出错：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const statusListeners = new Set<(id: string, running: boolean) => void>()
  ctx.on('agent/status' as never, ((event: AgentStatusEvent) => {
    const id = event?.agent?.id
    if (typeof id !== 'string') return
    for (const l of statusListeners) l(id, event.status === 'running')
  }) as never)

  // 阻塞式提问（legacy ask_user_question）只沿事件链转给浏览器，挂在链上才能看到、才能远程回答。
  // prepend：排在浏览器转发那一环前面，这样我们总能拿到请求、再把它交给下一环。
  const pending = new PendingQuestions((sessionId) => {
    for (const l of statusListeners) l(sessionId, false)
  }, {
    graceMs: () => live(config.questionGraceMs) as number,
    onUnattended: ({ sessionId, questions, graceMs }) => {
      const minutes = Math.max(1, Math.round(graceMs / 60_000))
      logger.info(`没有窗口能回答 ${sessionId} 的提问，再等 ${minutes} 分钟远程回答`)
      // 没有窗口也就没有桌面通知的接收方，只能不经窗口直接弹。
      const first = (questions[0]?.question ?? '').replace(/\s+/g, ' ').slice(0, 80)
      showSystemNotification('DSH 在等你回答', `${first}（${minutes} 分钟内用 dsh-control answer 回答）`)
        .catch((error: unknown) => logger.warn(`提问提醒没弹出来：${error instanceof Error ? error.message : String(error)}`))
    },
  })
  ctx.on('user-questions/request' as never, (function (this: unknown, request: Parameters<PendingQuestions['listener']>[0], next: () => Promise<AnswerBatch>) {
    return pending.listener(request, next)
  }) as never, { prepend: true } as never)

  const started = Date.now()
  const desktopNotifications = new DesktopNotifications()
  ctx.effect(() => () => desktopNotifications.dispose(), 'dsh-control: desktop notifications')
  const page = new MachinePage(realMachineDeps(dshHome()), () => plain({ machines: live(config.machines) as Layout['machines'], services: live(config.services) as Layout['services'] }))
  const service: RemoteService = new RemoteService({
    machines: page,
    gateway: ownerGateway((ctx as unknown as { typertGateway: HostGatewayLike }).typertGateway, (ctx as unknown as { connection: ConnectionLike }).connection),
    typert: (ctx as unknown as { typert: { local: TypertLocalLike } }).typert.local,
    query: (ctx as unknown as { sessionQuery: SessionQueryLike }).sessionQuery,
    usage,
    modelTiers: () => ctx.get('modelTiers') as ModelTiersLike | undefined,
    onStatus: (listener) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
    config: current,
    log: audit,
    pending,
    startedAt: started,
    watchDone: async (request): Promise<{ id: string; path: string; reused?: boolean }> => {
      const record = await watcher.add(request)
      return { id: record.id, path: watcher.path(record.id), ...(record.reused === true ? { reused: true } : {}) }
    },
    automaticSelect: () => ctx.get('modelSelectAutomatic') as AutomaticSelectLike | undefined,
    webUrl: (base) => {
      const web = ctx.get('webServer') as { protocol?: string; port?: number } | undefined
      if (web?.port === undefined) return undefined
      const connection = (ctx as unknown as { connection: { authenticatedUrl(baseUrl: string): string } }).connection
      return connection.authenticatedUrl(base ?? `${web.protocol ?? 'http:'}//127.0.0.1:${String(web.port)}`)
    },
    setWorkingDirectory: async (sessionId: string, directory: string) => {
        const service = ctx.get('workingDirectory') as WorkingDirectoryLike | undefined
        const controller = ctx.get('sessionController') as SessionControllerLike | undefined
        if (service === undefined) throw new CommandFailure('这个 DSH 没有工作目录服务（0.2.1 起才有），换不了目录', 'unsupported')
        if (controller === undefined || typeof controller.resolveAgent !== 'function') throw new Error('会话控制器不可用')
        const found = await controller.resolveAgent(sessionId)
        if ('error' in found) throw found.error instanceof Error ? found.error : new Error(String(found.error))
        return service.set(found.agent, directory)
    },
    desktopNotify: (notification) => sendDesktopNotification(desktopNotifications, notification),
    notice: async (sessionId, text, summary, quiet) => {
      const controller = ctx.get('sessionController') as SessionControllerLike | undefined
      if (controller === undefined || typeof controller.resolveAgent !== 'function') throw new Error('会话控制器不可用')
      return deliverNotice(controller, sessionId, text, summary, quiet)
    },
    requeue: async (sessionId, messages) => {
      const controller = ctx.get('sessionController') as SessionControllerLike | undefined
      if (controller === undefined || typeof controller.resolveAgent !== 'function') throw new Error('会话控制器不可用')
      const found = await controller.resolveAgent(sessionId)
      if ('error' in found) throw found.error instanceof Error ? found.error : new Error(String(found.error))
      for (const message of messages) found.agent.followup(message)
    },
    // 与 dsh-desktop-host 的 hasDesktopActiveTasks 同一套条件（2026-10-08 核对 0.2.0-rc.2）：
    // 会话在跑、收件箱 nextTurn/nextStep 非空、任一后台任务 running/stopping。
    // 另问一声各插件哪些任务重启后能接回（目前是 dsh-monitor 的持久监听），标成 survivable。
    quitBlockers: () => {
      const agents = ctx.get('agents') as AgentsLike | undefined
      const jobs = ctx.get('jobs') as JobsLike | undefined
      if (agents === undefined || jobs === undefined) throw new Error('会话或后台任务服务不可用')
      const live = agents.list()
      const seen = new Set<string>()
      const busy = [undefined, ...live.map((a) => a.id)].flatMap((owner) => jobs.list(owner))
        .filter((j) => (j.status === 'running' || j.status === 'stopping') && !seen.has(j.id) && seen.add(j.id))
      const survivors = new Set<string>()
      emit(RESTART_SURVIVORS_EVENT, survivors)
      return {
        ...collectQuitBlockers(live),
        jobs: busy.map((j) => ({
          id: j.id, kind: j.kind, label: j.label,
          ...(j.owner === undefined ? {} : { owner: j.owner }),
          ...(survivors.has(j.id) && j.status === 'running' ? { survivable: true } : {}),
        })),
      }
    },
    // 与 dsh-desktop-host 退出检查的定时任务一项同一条件（2026-10-17 核对 0.2.1-rc.2）：已加载会话的 schedule 活动。
    scheduledReminders: async () => {
      const agents = ctx.get('agents') as AgentsLike | undefined
      if (agents === undefined) throw new Error('会话服务不可用')
      const waterfall = (ctx as unknown as { waterfall(name: string, input: unknown, fallback: () => Promise<unknown[]>): Promise<unknown[]> }).waterfall
      const out: { sessionId: string; items: { id: string; label: string }[] }[] = []
      for (const a of agents.list()) {
        const activity = await waterfall.call(ctx, 'workspace/session-activity', { sessionId: a.id }, () => Promise.resolve([]))
        const items = activity.flatMap((entry) => {
          const e = entry as { kind?: unknown; items?: unknown }
          if (e.kind !== 'schedule' || !Array.isArray(e.items)) return []
          return e.items.flatMap((i: { id?: unknown; label?: unknown }) => typeof i?.id === 'string' ? [{ id: i.id, label: typeof i.label === 'string' ? i.label : i.id }] : [])
        })
        if (items.length > 0) out.push({ sessionId: a.id, items })
      }
      return out
    },
    restartPrepare: () => {
      const out: { id: string; label: string; owner: string }[] = []
      emit(RESTART_PREPARE_EVENT, out)
      return out.map((s) => ({ id: s.id, label: s.label, owner: s.owner }))
    },
    restartAbort: async () => {
      const out: RestartRecoveryResult = { revived: [], failed: [] }
      await (ctx as unknown as { parallel(name: string, out: unknown): Promise<void> }).parallel(RESTART_ABORT_EVENT, out)
      return out
    },
    startMonitor: async (request: MonitorStartRequest) => {
      await (ctx as unknown as { parallel(name: string, request: MonitorStartRequest): Promise<void> }).parallel('dsh/monitor-start', request)
    },
    holdGoal: (sessionId) => {
      const goals = ctx.get('goals') as GoalsLike | undefined
      const agents = ctx.get('agents') as AgentsLike | undefined
      if (goals === undefined || typeof goals.disarm !== 'function' || agents === undefined) throw new CommandFailure('目标服务不可用', 'unsupported')
      const agent = agents.list().find((a) => a.id === sessionId)
      if (agent === undefined) return false
      goals.disarm(agent)
      return true
    },
    killJob: (jobId, reason) => {
      const jobs = ctx.get('jobs') as JobsLike | undefined
      if (jobs === undefined) throw new Error('后台任务服务不可用')
      const owner = (jobs.list().find((j) => j.id === jobId) ?? (ctx.get('agents') as AgentsLike | undefined)?.list()
        .flatMap((a) => jobs.list(a.id)).find((j) => j.id === jobId))?.owner
      // 有人在等，宿主就不给主人发「任务结束」：闲着的会话收到它会开一轮，当成要接着干（dsh-monitor 暂停监听也是这么做的）。
      void jobs.wait(jobId, 30_000, owner).catch(() => {})
      return jobs.kill(jobId, owner, reason)
    },
  })

  // 设置里「远程机器」一页的端点
  const register = (ctx as unknown as { connection: { fetch?: { register?: (route: FetchRoute) => () => void } } }).connection.fetch?.register
  if (register !== undefined) {
    registerMachineRoutes(
      (install, label) => ctx.effect(install, label),
      register,
      () => [
        ...machineRoutes(page),
        { path: '/api/dsh-control.desktop-notification-stream', methods: ['GET'], requestBody: 'buffered' as const, fetch: async (request) => desktopNotifications.stream(request) },
        { path: '/api/dsh-control.desktop-notification-ack', methods: ['POST'], requestBody: 'buffered' as const, fetch: async (request) => desktopNotifications.acknowledge(request) },
      ],
      (route) => `dsh-control: ${route.path} route`,
    )
  }

  // 派单做完通知：记录落盘，插件每次启动读回来接着盯，所以 DSH 重启后照样送到。
  const watcher: DoneWatcher = new DoneWatcher({
    dir: join(dir, 'done-watches'),
    check: (target, since, memo): Promise<CommandResult | undefined> => service.checkSettled(target, since, memo),
    title: async (target): Promise<string | undefined> => (await service.resolve(target)).title,
    deliver: async (sessionId, text, summary) => {
      const controller = ctx.get('sessionController') as SessionControllerLike | undefined
      if (controller === undefined || typeof controller.resolveAgent !== 'function') throw new Error('会话控制器不可用')
      return deliverNotice(controller, sessionId, text, summary)
    },
    onStatus: (listener) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    },
    log: (line) => {
      audit(line)
      logger.info(line)
    },
  })
  ctx.effect(() => {
    void watcher.start().catch((error: unknown) => logger.error(`做完通知监听启动失败：${error instanceof Error ? error.message : String(error)}`))
    return () => watcher.stop()
  }, 'dsh-control: done-watch')

  ctx.effect(() => {
    let handle: { close(): Promise<void> } | undefined
    let disposed = false
    const path = socketPath()
    void startServer({
      socketPath: path,
      commands: () => COMMANDS,
      run: (command, args, options, signal) => runCommand(service, command, args, options, signal),
      info: () => ({ name, pid: process.pid, startedAt: started, readOnly: current().readOnly, commands: COMMANDS.length }),
      log: audit,
    }).then((h) => {
      if (disposed) { void h.close(); return }
      handle = h
      logger.info(`通信口已打开：${path}`)
    }, (error: unknown) => {
      logger.error(`通信口打开失败：${error instanceof Error ? error.message : String(error)}`)
    })
    return () => {
      disposed = true
      service.dispose()
      void handle?.close()
    }
  }, 'dsh-control: socket')
}
