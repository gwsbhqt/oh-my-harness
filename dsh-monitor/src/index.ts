/**
 * dsh-monitor —— 把 Claude Code 的 Monitor 工具搬到 DSH。
 *
 * ## 它解决什么
 *
 * DSH 已有的 `bash run_in_background` 是「**先跑完，再去看**」：进程的输出攒在
 * 缓冲区里，等模型调 `job_output` 才被读走。这对编译、跑测试够用，但对
 * **长驻的事件流**（IM 监听、日志跟随、CI 状态、文件变化）完全不够——
 * 事件是**现在**发生的，等模型想起来去 poll 就已经晚了；而让模型自己轮询，
 * 就是拿 token 买延迟。
 *
 * Claude Code 的 `Monitor` 补的正是这一块：起一条长驻命令，**stdout 的每一行
 * 在产生的当下就被送进会话**，模型不需要轮询；日志、构建状态等事件流都可使用。
 *
 * ## 三个机制拼出来的
 *
 * | 要的东西 | DSH 里现成的 |
 * |---|---|
 * | 进程生命周期、并发上限、会话销毁时自动收尸、GUI 任务面板 | `ctx.jobs`（`kind: 'monitor'`） |
 * | 把内容送进会话 | `agent.steer()`（闲时开一轮、忙时在下一步边界收） |
 * | 分离的 stdout / stderr、进程组终止 | `ctx.subprocess.spawn`（`stdout: 'pipe'`） |
 *
 * 于是本插件不重造任何一件：它只是**把 stdout 的行读出来，按批 steer 给会话**，
 * 同时把这条运行登记成普通后台任务。`job_list` / `job_kill` 对它照样管用。
 *
 * ## 两条容易踩空的地方（都已处理）
 *
 * ① **stdout / stderr 必须分开**。`ctx.shell`（bash 执行器）的 `readOutput()`
 *    会把 stderr 拼进同一个 delta（`[stderr]` 分段），对「stdout 是事件流、
 *    stderr 是诊断」这种用法是致命的：一句报错会被当成一条事件送进会话。
 *    所以这里直接走 `ctx.subprocess`，拿两个独立的 `Readable`。
 *
 * ② **多字节字符会跨 chunk 断开**。包含中文的事件流中，一个 UTF-8 汉字被
 *    切成两半是常态；用 `chunk.toString()` 拼行会拼出乱码。这里用
 *    `StringDecoder` 兜住半个字符。
 *
 * ## 和 Claude Code 的差异（有意为之）
 *
 * - 工具名是 `monitor`（DSH 工具名一律小写下划线），参数名保持一致：
 *   `command` / `description` / `persistent` / `timeout_ms`。
 * - 子进程的 stdin 是**一根不写的管道**（不关闭），而不是 Claude Code 那样的
 *   立即 EOF。Claude Code 的 Monitor 起的 shell 没有 tty、stdin 秒 EOF，
 *   依赖 stdin 保持打开的事件消费者可能立即退出。这里保留写端，直到监听被停止。
 * - stderr 落 `$DSH_HOME/monitor-logs/<id>-<uuid>.log`；进程退出时若 stderr 有内容、
 *   或退出码非 0、或进程自己退出却**一行都没产出**，会补一条结束通知把 stderr 末尾带上——
 *   命令写错时 Monitor 的表现是「起了就结束」，这条通知就是那个判据。
 *
 * @module dsh-monitor
 */

import { randomUUID } from 'node:crypto'
import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, type WriteStream } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import { JobId } from '@deepseek-ai/dsh-jobs'
import type { JobOutcome, JobView } from '@deepseek-ai/dsh-jobs'
import { isVolatile } from '@deepseek-ai/cosmokit'
import { boundContextSummary, createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { reminderSummary, reminderText } from '../../tooling/runtime/notice.mjs'
import { LineReader } from '../../tooling/runtime/line-reader.mjs'
import { dshHomePath, expandHomePath } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-shell-env'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'

/** 本插件登记的 job kind，也是 job id 的前缀（`monitor-1`、`monitor-2`…）。 */
declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    monitor: 'monitor'
  }
}

/**
 * 本插件进会话的消息的 source kind。
 *
 * 0.1.7 起 `MessageSourceMap` 是声明合并扩展的：没有 `plugin` 这种兜底 kind，
 * 各家在自己的模块里声明自己的。`ContextFormed` 让消息能带 `form: 'notice'`
 * 和一行 summary（前端按它折叠成通知）。
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-monitor': { kind: 'dsh-monitor' } & ContextFormed
  }
}

/** 进程自己退出之后要不要重拉。 */
export type MonitorRestartPolicy = 'never' | 'on-failure' | 'always'
export type MonitorDelivery = 'steer' | 'inject' | 'followup'

export const Config = z.object({
  /**
   * 事件到达时怎么送进会话。
   *
   * `steer`（默认）忙时在下一步边界收、闲时直接开一轮——监听类场景要的就是
   * 「没人跟它说话时，来了消息也能自己动起来」。`inject` 不唤醒，只在模型
   * 下次干活时顺带带上，适合纯日志。`followup` 每条单独开一轮，一般不用。
   */
  delivery: z.union(['steer', 'inject', 'followup']).default('steer').volatile(),
  /** 攒多少毫秒合成一条消息再送。0 = 每读到一批就送。 */
  coalesceMs: z.number().min(0).default(200).volatile(),
  /** 一条通知最多带多少行；超出的留在队列里下一批继续送。 */
  maxLinesPerNotice: z.number().min(1).default(50).volatile(),
  /** 一条通知最多多少字节，同上。 */
  maxBytesPerNotice: z.number().min(1).default(32 * 1024).volatile(),
  /** 单行超过这么多字节就截断，并显式标注截掉多少——不静默砍。 */
  maxLineBytes: z.number().min(1).default(8 * 1024).volatile(),
  /** 内存里保留最近多少行，供 monitor_output / job_output 回看。 */
  historyLines: z.number().min(0).default(2000).volatile(),
  /** 进程退出时把 stderr 末尾多少行附在结束通知里。 */
  stderrTailLines: z.number().min(0).default(20).volatile(),
  /** `timeout_ms` 缺省值；0 = 默认不设上限（监听要一直活着）。 */
  defaultTimeoutMs: z.number().min(0).default(0).volatile(),
  /** `timeout_ms` 上限，防止写出一个「一小时后自己死掉」的监听。 */
  maxTimeoutMs: z.number().min(1).default(24 * 60 * 60 * 1000).volatile(),
  /** 终止进程时给它的宽限期（毫秒）。 */
  graceMs: z.number().min(1).default(3000).volatile(),
  /**
   * 进程**自己退出**之后要不要重拉。
   *
   * - `never`（默认）：退出即结束。一次性命令（`echo`、跑个脚本）要的就是这个。
   * - `on-failure`：非 0 退出 / 起不来才重拉，正常退出（exit 0）不重拉。
   * - `always`：只要不是被人叫停的，一律重拉。
   *
   * 要挂几个星期的监听用 `on-failure`。**被人叫停永远不重拉**——kill、超时、
   * 会话销毁、插件卸载，这四种是「有人决定了」，重拉等于抗命。
   */
  restart: z.union(['never', 'on-failure', 'always']).default('never').volatile(),
  /** 第一次重拉前等多久；连续失败按 2 倍退避。 */
  restartDelayMs: z.number().min(0).default(1000).volatile(),
  /** 退避延迟的上限。 */
  restartMaxDelayMs: z.number().min(1).default(60_000).volatile(),
  /** 连续重拉次数上限；0 = 不限。跑到上限就按失败结算并报一次。 */
  restartLimit: z.number().min(0).default(0).volatile(),
  /** 一轮活过这么久就算「健康」，把退避计数清零（崩溃循环与「跑了一周崩一次」要分开对待）。 */
  restartResetMs: z.number().min(0).default(60_000).volatile(),
  /** stderr 日志目录；空串用 `$DSH_HOME/monitor-logs`。 */
  logDir: z.string().default('').volatile(),
})

export type MonitorConfig = ReturnType<typeof Config>

/**
 * `current()` 返回的快照形状：volatile ref 全部解成当前值。
 *
 * 0.1.7 的设置模型：标了 `.volatile()` 的字段由宿主 SettingsForms 端给浏览器半
 * （值活在 profile patch；用户改完 loader 把新值原地写回运行中的 ref，不重启
 * 插件），所以配置必须每次现读，不能存下来。GUI 表单不是自动生成的——
 * 内置插件页里那张配置卡片在 src/client/，按官方 agent-loop 的模式注册。
 */
export type MonitorSnapshot = {
  [K in keyof MonitorConfig]: MonitorConfig[K] extends { get(): infer V } ? V : MonitorConfig[K]
}

/** 把配置（volatile 字段是活 ref；单测直接传裸值也兼容）解成纯值快照。 */
function unwrapMonitorConfig(config: MonitorConfig): MonitorSnapshot {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    out[key] = isVolatile(value) ? value.get() : value
  }
  return out as MonitorSnapshot
}

export const name = 'dsh-monitor'

/**
 * 依赖的服务。
 *
 * 这个声明不是装饰：cordis 的 context 是 Proxy，**没在 inject 里声明过的服务名
 * 一律取不到**（`cannot get property "jobs" without inject`）。漏了它插件在真宿主
 * 里根本 apply 不起来——本仓的集成测试就是靠真注册表把这条抓出来的。
 */
export const inject = ['tools', 'jobs', 'subprocess', 'systemPrompt']

/** 结束通知里最多带多少字节的 stderr，避免一条报错刷屏。 */
const STDERR_NOTICE_BYTES = 2 * 1024

/** 已结束的监听最多在内存里留几条，供事后回看。 */
const KEEP_FINISHED = 10

/** 非持久监听随回合结束被停时记下的叫停理由；结算时靠它认出这种情况。 */
const TURN_END_REASON = 'non-persistent monitor stopped at turn end'

/** 重启前暂停监听时记下的叫停理由。 */
const SUSPEND_REASON = 'suspended for DSH restart'

/**
 * 重启命令（dsh-use 的 dsh-use restart）和本插件之间的约定事件。两边不互相导入，只认这三个名字：
 * - `dsh/restart-survivors`：传进一个 Set，本插件把「重启后能接回来」的任务 id 放进去；
 * - `dsh/restart-prepare`：要退出了，把能接回的监听记进文件、先停掉（不停的话 App 退出会弹确认框）；
 * - `dsh/restart-abort`：重启没成，按文件马上接回来。
 */
export const RESTART_SURVIVORS_EVENT = 'dsh/restart-survivors'
export const RESTART_PREPARE_EVENT = 'dsh/restart-prepare'
export const RESTART_ABORT_EVENT = 'dsh/restart-abort'

export const MONITOR_START_EVENT = 'dsh/monitor-start'

export interface MonitorStartRequest {
  owner: string
  command: string
  cwd: string
  label: string
  /** 进程自己退出后要不要重拉；缺省 on-failure。 */
  restart?: 'never' | 'on-failure'
  /** 输出只进历史和任务输出，不推进会话；主人要看时用 monitor_output / job_output。 */
  quiet?: boolean
  result?: { id: string; owner: string; label: string; command: string; cwd: string }
}

/** 暂停记录超过这么久就不再接回：那是很久以前的一次关机，不是这次重启。 */
const REVIVE_WINDOW_MS = 30 * 60_000

/** 启动后等会话服务就绪、接回监听，最多等这么久。 */
const REVIVE_WAIT_MS = 60_000

/** 重启前暂停、重启后接回的一条监听。只存重拉需要的事实，不存环境变量（可能带密钥），接回时现算。 */
export interface SuspendedMonitor {
  id: string
  label: string
  command: string
  cwd: string
  /** 所属会话 id。 */
  owner: string
  delivery?: MonitorDelivery
  ignoreStdoutLines: string[]
  quiet?: boolean
  restartPolicy: MonitorRestartPolicy
  /** 还剩多少寿命（毫秒）；0 = 不设上限。 */
  timeoutMs: number
  suspendedAt: number
}

export interface RestartRecoveryResult {
  revived: string[]
  failed: { id: string; owner: string; error: string }[]
}

/** 会话服务里本插件用到的那一个方法：找到会话的 Agent，没加载就先加载。 */
interface SessionControllerLike {
  resolveAgent(sessionId: string): Promise<{ agent: Agent } | { error: unknown }>
}

export { LineReader }

/** 一条被监控的运行。生命周期由 `ctx.jobs` 拥有，这里只放执行期的事实。 */
interface MonitorRecord {
  /** 注册表发的 id；`jobs.start()` 返回后才填上，之前的闭包都指向这个对象。 */
  id: string
  label: string
  command: string
  cwd: string
  owner: Agent | undefined
  persistent: boolean
  delivery: MonitorDelivery | undefined
  ignoreStdoutLines: readonly string[]
  /** 输出不推进会话，只留在历史和任务输出里。 */
  quiet: boolean
  received: number
  startedAt: number
  /** 这一条的重拉策略（`monitor` 调用时给的，或配置默认值）。 */
  restartPolicy: MonitorRestartPolicy
  /** 第一次 spawn 时定下来的环境与宽限期——重拉要跟第一轮完全一致。 */
  env: Record<string, string>
  graceMs: number
  /** 当前这一轮（每次 spawn 加一）。回调靠它认领自己那一轮，避免迟到的 done 结算新进程。 */
  generation: number
  /** 当前这一轮是什么时候起的——用来判「这轮活得够久 = 健康」。 */
  generationStartedAt: number
  /** 连续重拉了几次（健康一轮就清零）。 */
  restarts: number
  restartTimer: NodeJS.Timeout | undefined
  /** 当前活着的进程；重拉后会换成新的。 */
  handle: SubprocessHandle
  /** 任务输出环的写口（`jobs.start` 的 run 回调给）；每行 stdout 顺手推一份进去。 */
  jobAppend: ((text: string) => void) | undefined
  /** stderr 日志路径；空串表示这次运行没写过 stderr。 */
  logPath: string
  log: WriteStream | undefined
  /** 日志文件是否已经开过——第一次开要截断（id 会在进程重启后重号）。 */
  logOpened: boolean
  /** 日志写失败过（目录不可写、磁盘满）：这条监听不再写日志，免得每行 stderr 都重试、都报一次。 */
  logBroken: boolean
  stdout: LineReader
  stderr: LineReader
  /** 还没送进会话的行。 */
  pending: string[]
  /** 最近 historyLines 行，供回看。 */
  history: string[]
  /** 已经送进会话多少行——「一行都没有」是判断命令起错的关键判据。 */
  delivered: number
  /** 最后一行 stdout 到达的时刻；被排除的心跳行也算——有心跳恰恰证明进程还活着。 */
  lastLineAt: number | undefined
  stderrTail: string[]
  flushTimer: NodeJS.Timeout | undefined
  timeoutTimer: NodeJS.Timeout | undefined
  /** 寿命到期的时刻；不设上限时为 undefined。重启接回时据此算剩余寿命。 */
  timeoutAt: number | undefined
  /** 谁让它停的（`timeout` / 调用方给的理由 / `plugin unloaded`）。 */
  cancelReason: string | undefined
  finished: boolean
  /** 交给 jobs 注册表的 done promise 的 resolve。 */
  settle: (outcome: JobOutcome) => void
}

/** 建一条记录时需要调用方给的字段；其余由 `newRecord` 补默认值。 */
type NewRecordInit = Pick<
  MonitorRecord,
  'id' | 'label' | 'command' | 'cwd' | 'owner' | 'persistent' | 'delivery' | 'ignoreStdoutLines' | 'quiet' | 'startedAt' | 'restartPolicy' | 'env' | 'graceMs' | 'handle'
>

export function apply(ctx: Context, config: MonitorConfig): void {
  const logger = ctx.logger(name)

  // 当前生效的配置。三层叠加（右边盖左边）：
  //   schema 默认值 < cordis.patch.yml 的条目 config < profile patch（设置界面改写的就是这层）
  // volatile 字段的值是活 ref：用户在设置里改完立刻生效（loader 原地写回），
  // 所以下面每处都必须现读（`current().xxx`），不能把值存下来。
  const current = (): MonitorSnapshot => unwrapMonitorConfig(config)

  const records = new Map<string, MonitorRecord>()
  const jobs = ctx.jobs
  const subprocess = ctx.subprocess

  // 自带一个 job controller：这样即使某个 composition 没装 dsh-tool-jobs，
  // monitor 也能起来（只是没有 job_* 那几个通用工具）。装了也只是多一个
  // token，注册表对 controller 是叠加的。
  ctx.effect(() => jobs.attachController('dsh-monitor'))

  // 插件卸载（含 HMR 热重载）时把自己起的进程收干净：新实例接不了旧实例的
  // 进程，留着就是孤儿。
  ctx.effect(() => () => {
    for (const record of records.values()) {
      if (!record.finished) cancelMonitor(record, 'plugin unloaded')
    }
  })

  // 非持久监听：主人这一轮干完（转 idle）就停。
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return
    for (const record of records.values()) {
      if (!record.finished && !record.persistent && record.owner === agent) {
        cancelMonitor(record, TURN_END_REASON)
      }
    }
  })

  // ── 跟着 DSH 重启续上 ────────────────────────────────────────────────
  //
  // App 退出时还开着的后台任务会弹「任务将中断」确认框，远程重启没人能点；常驻监听又永远不会自己结束，
  // 持久监听需要由重启命令在退出前通知本插件：
  // 把能接回的监听记进文件再停掉，新进程起来后按文件重新拉起，并告诉所属会话新编号。

  /** 重启后能原样接回的监听：持久、有主人、还没结束。非持久监听本来就随回合结束，不接。 */
  function revivable(record: MonitorRecord): boolean {
    return !record.finished && record.persistent && record.owner !== undefined && record.cancelReason === undefined
  }

  ctx.on(RESTART_SURVIVORS_EVENT as never, ((ids: Set<string>) => {
    for (const record of records.values()) if (revivable(record)) ids.add(record.id)
  }) as never)

  ctx.on(RESTART_PREPARE_EVENT as never, ((out: SuspendedMonitor[]) => {
    const now = Date.now()
    const suspended: SuspendedMonitor[] = []
    for (const record of records.values()) {
      if (!revivable(record)) continue
      suspended.push({
        id: record.id,
        label: record.label,
        command: record.command,
        cwd: record.cwd,
        owner: (record.owner as Agent).session.id,
        ...(record.delivery === undefined ? {} : { delivery: record.delivery }),
        ignoreStdoutLines: [...record.ignoreStdoutLines],
        ...(record.quiet ? { quiet: true } : {}),
        restartPolicy: record.restartPolicy,
        timeoutMs: record.timeoutAt === undefined ? 0 : Math.max(1, record.timeoutAt - now),
        suspendedAt: now,
      })
    }
    if (suspended.length === 0) return
    // 先落盘再停：停到一半进程被杀，至少记录还在。
    const pending = takeSuspended().filter(item => !recovered.has(recoveryKey(item)))
    writeSuspended([...pending, ...suspended])
    for (const item of suspended) {
      const record = records.get(item.id)
      if (record === undefined) continue
      // 有人在等这条任务时，宿主不发通用的「任务结束」通知：不然闲着的主人会被叫醒开一轮，App 又退不出去了。
      try {
        void jobs.wait(JobId(record.id), 30_000, (record.owner as Agent).session.id).catch(() => {})
      } catch (error) {
        logger.warn(`monitor ${record.id}: 挂不上等待，暂停时主人可能收到一条任务结束通知：${String(error)}`)
      }
      cancelMonitor(record, SUSPEND_REASON)
    }
    out.push(...suspended)
    logger.info(`为 DSH 重启暂停了 ${suspended.length} 条监听：${suspended.map(s => s.id).join(', ')}`)
  }) as never)

  ctx.on(RESTART_ABORT_EVENT as never, (async (out: RestartRecoveryResult) => {
    const result = await recoverSuspended('The DSH restart did not succeed')
    out.revived.push(...result.revived)
    out.failed.push(...result.failed)
  }) as never)

  ctx.on(MONITOR_START_EVENT as never, (async (request: MonitorStartRequest) => {
    delete request.result
    if (typeof request.command !== 'string' || request.command.trim() === '') throw new Error('monitor: command 不能为空')
    if (typeof request.owner !== 'string' || request.owner.trim() === '') throw new Error('monitor: owner 不能为空')
    if (typeof request.label !== 'string') throw new Error('monitor: label 必须是字符串')
    if (request.restart !== undefined && request.restart !== 'never' && request.restart !== 'on-failure') throw new Error('monitor: restart 只能是 never 或 on-failure')
    if (request.quiet !== undefined && typeof request.quiet !== 'boolean') throw new Error('monitor: quiet 只能是布尔值')
    if (typeof request.cwd !== 'string' || !isAbsolute(request.cwd)) throw new Error('monitor: cwd 必须是绝对目录')
    if (!statSync(request.cwd).isDirectory()) throw new Error('monitor: cwd 必须是已存在的目录')
    const agent = await ownerAgent(request.owner.trim(), Date.now() + REVIVE_WAIT_MS)
    const record = startMonitor({
      command: request.command,
      label: request.label,
      cwd: request.cwd,
      owner: agent,
      persistent: true,
      restartPolicy: request.restart ?? 'on-failure',
      delivery: 'inject',
      ignoreStdoutLines: [],
      quiet: request.quiet === true,
      timeoutMs: 0,
      exec: { agent } as unknown as ToolRunContext,
    })
    request.result = { id: record.id, owner: agent.session.id, label: record.label, command: record.command, cwd: record.cwd }
  }) as never)

  function suspendedPath(): string {
    return dshHomePath('monitor', 'suspended.json')
  }

  function writeSuspended(items: SuspendedMonitor[]): void {
    const path = suspendedPath()
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, `${JSON.stringify(items, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, path)
  }

  /** 先读不删；只有确认接回成功后才移除对应记录。 */
  function takeSuspended(): SuspendedMonitor[] {
    const path = suspendedPath()
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || !parsed.every((item): item is SuspendedMonitor =>
      typeof item === 'object' && item !== null
      && typeof item.id === 'string' && typeof item.label === 'string'
      && typeof item.command === 'string' && typeof item.cwd === 'string'
      && typeof item.owner === 'string'
      && Array.isArray(item.ignoreStdoutLines) && item.ignoreStdoutLines.every((line: unknown) => typeof line === 'string')
      && (item.quiet === undefined || typeof item.quiet === 'boolean')
      && ['never', 'on-failure', 'always'].includes(item.restartPolicy)
      && (item.delivery === undefined || ['steer', 'inject', 'followup'].includes(item.delivery))
      && Number.isFinite(item.timeoutMs) && item.timeoutMs >= 0
      && Number.isFinite(item.suspendedAt))) {
      throw new Error('暂停记录格式不正确，原文件已保留')
    }
    return parsed
  }

  /** 找到会话的 Agent（没加载就先加载）。刚启动时会话服务可能还没好，等一会儿再试。 */
  async function ownerAgent(sessionId: string, deadline: number): Promise<Agent> {
    for (;;) {
      const controller = ctx.get('sessionController' as never) as SessionControllerLike | undefined
      if (controller !== undefined && typeof controller.resolveAgent === 'function') {
        const found = await controller.resolveAgent(sessionId)
        if ('agent' in found) return found.agent
        // 会话被删、被归档这类是确定的失败，重试没用。
        throw found.error instanceof Error ? found.error : new Error(String((found.error as { message?: unknown })?.message ?? found.error))
      }
      if (Date.now() >= deadline) throw new Error('会话服务一直没就绪')
      await new Promise(resolve => setTimeout(resolve, 500))
    }
  }

  const recovered = new Set<string>()
  const recoveryKey = (item: SuspendedMonitor): string => JSON.stringify([item.owner, item.id, item.suspendedAt])
  let recoveryQueue: Promise<unknown> = Promise.resolve()

  function recoverSuspended(why: string): Promise<RestartRecoveryResult> {
    // 启动恢复和 rollback 可能同时到达，必须排队，避免同一条命令拉起两次。
    const result = recoveryQueue.then(() => reviveAll(takeSuspended(), why))
    recoveryQueue = result.catch(() => {})
    return result
  }

  /** 逐条确认拉起；失败项保留，成功项立即从磁盘移除。 */
  async function reviveAll(items: SuspendedMonitor[], why: string): Promise<RestartRecoveryResult> {
    const deadline = Date.now() + REVIVE_WAIT_MS
    const result: RestartRecoveryResult = { revived: [], failed: [] }
    for (const item of items) {
      const previousOwner = records.get(item.id)?.owner
      let agent: Agent | undefined = previousOwner?.session.id === item.owner ? previousOwner : undefined
      try {
        if (recovered.has(recoveryKey(item))) {
          removeRecovered(item)
          result.revived.push(item.id)
          continue
        }
        if (Date.now() - item.suspendedAt > REVIVE_WINDOW_MS) throw new Error('暂停记录太旧，不再自动接回')
        agent = await ownerAgent(item.owner, deadline)
        const record = startMonitor({
          command: item.command,
          label: item.label,
          cwd: item.cwd,
          owner: agent,
          persistent: true,
          delivery: item.delivery,
          ignoreStdoutLines: item.ignoreStdoutLines,
          quiet: item.quiet === true,
          timeoutMs: item.timeoutMs,
          restartPolicy: item.restartPolicy,
          // 环境变量不落盘（可能带密钥），按主人会话现算，和第一次起的时候同一套来源。
          exec: { agent } as unknown as ToolRunContext,
        })
        recovered.add(recoveryKey(item))
        removeRecovered(item)
        result.revived.push(item.id)
        const gap = formatDuration(Date.now() - item.suspendedAt)
        const name = item.label.length > 0 ? `${item.id} (${item.label})` : item.id
        // The new process starts numbering from the beginning; the id may match the old one.
        const idLine = record.id === item.id
          ? `the id is still ${record.id}`
          : `the new id is ${record.id}; the old id ${item.id} no longer exists`
        try { deliver(
          record,
          `${why}. The monitor ${name} you had running was relaunched automatically, ${idLine}, with the same command in the same directory. `
          + `It was stopped for about ${gap}; output produced during that gap was not delivered. If that matters (for example group messages), check that period yourself. `
          + (record.quiet ? `Its output is not pushed to you; use monitor_output or job_output with ${record.id} when you want it. ` : '')
          + `Use ${record.id} to inspect or stop it.`,
          `${item.id} relaunched as ${record.id}`,
          'inject',
        ) } catch (noticeError) { logger.warn(`monitor ${item.id} was recovered, but building its notice failed: ${String(noticeError)}`) }
        logger.info(`监听 ${item.id} 已在重启后接回为 ${record.id}（会话 ${item.owner}）`)
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        result.failed.push({ id: item.id, owner: item.owner, error: reason })
        logger.warn(`监听 ${item.id} 没能接回（会话 ${item.owner}）：${reason}`)
        if (agent !== undefined) {
          try {
            const title = `${item.id} (${item.label}) recovery failed`
            agent.steer(createUserMessage({
              content: [{ type: 'text', text: reminderText('dsh-monitor', title, `${why}. Recovery failed: ${reason}. The suspended record was kept and can be retried; do not treat this monitor as running.`) }],
              source: { kind: 'dsh-monitor', form: 'notice', summary: boundContextSummary(reminderSummary('dsh-monitor', title)) },
            }))
          } catch (noticeError) {
            logger.warn(`监听 ${item.id} 恢复失败通知送不进去：${String(noticeError)}`)
          }
        }
      }
    }
    return result

    function removeRecovered(item: SuspendedMonitor): void {
      // 恢复等待期间可能又有 prepare 写入，不能用旧快照覆盖新记录。
      const pending = takeSuspended().filter(candidate => recoveryKey(candidate) !== recoveryKey(item))
      if (pending.length === 0) rmSync(suspendedPath(), { force: true })
      else writeSuspended(pending)
    }
  }

  // 新进程起来：上一个进程为重启暂停过的监听，按记录接回来。不阻塞插件加载。
  void recoverSuspended('DSH just restarted').catch(error => {
    logger.warn(`监听恢复未完成，暂停记录已保留：${String(error)}`)
  })

  // ── 进程与输出的搬运 ────────────────────────────────────────────────

  /**
   * 起一个被监控的进程，并把它登记进 `ctx.jobs`。
   *
   * 登记放在外面、spawn 放在 `run()` 里，是注册表的契约：`run()` 抛异常时
   * 不会留下半条记录。
   */
  function startMonitor(input: {
    command: string
    label: string
    cwd: string
    owner: Agent | undefined
    persistent: boolean
    delivery: MonitorDelivery | undefined
    ignoreStdoutLines: readonly string[]
    quiet?: boolean
    timeoutMs: number
    restartPolicy: MonitorRestartPolicy
    exec: ToolRunContext
  }): MonitorRecord {
    let record: MonitorRecord | undefined
    let settleDone: ((outcome: JobOutcome) => void) | undefined
    const done = new Promise<JobOutcome>(resolve => {
      settleDone = resolve
    })

    const id = jobs.start({
      kind: 'monitor',
      label: input.label,
      outputLimitBytes: current().maxBytesPerNotice,
      // 0.1.7 起 owner 是会话 id（注册表按它做访问围栏和随会话销毁收尸），
      // 不再收 Agent 本体。
      ...(input.owner !== undefined ? { owner: input.owner.session.id } : {}),
      run: (job) => {
        const spawned = spawnMonitor(input)
        // 0.1.7 的任务输出环是推式的：stdout 每来一行就 append 进去，
        // job_output 由注册表按游标读走（0.1.5 的 readOutput 拉式钩子已删）。
        spawned.jobAppend = text => job.append(text)
        spawned.settle = settleDone as (outcome: JobOutcome) => void
        record = spawned
        return {
          cancel: reason => cancelMonitor(spawned, reason ?? 'cancelled'),
          done,
        }
      },
    })

    if (record === undefined) throw new Error('monitor: producer did not start')
    const started = record as MonitorRecord
    started.id = id
    // 日志路径在拿到 id 之后立刻定下来：stderr 的第一个字节最早也要等下一个事件
    // 循环，所以 pushStderr 打开文件时路径一定已经是对的。启动结果里就能给出
    // 一个真实路径，而不是「还没写过所以是空」。
    try {
      const dir = resolveLogDir(current())
      mkdirSync(dir, { recursive: true })
      started.logPath = join(dir, `${id}-${randomUUID()}.log`)
    } catch (error) {
      logger.warn(`monitor ${id}: 日志目录建不出来：${String(error)}`)
    }
    records.set(id, started)
    armTimeout(started, input.timeoutMs)
    logger.info(`monitor ${id} 启动：${input.label}（cwd=${input.cwd}）`)
    return started
  }

  /** 起一个子进程。argv / stdio / 环境的形状只在这里定义一次，重拉也走它。 */
  function spawnHandle(
    command: string,
    cwd: string,
    env: Record<string, string>,
    graceMs: number,
  ): SubprocessHandle {
    return subprocess.spawn({
      argv: shellArgv(command),
      cwd,
      // stdin 是一根**不写也不关**的管道：写端握在我们手里，子进程永远等不到
      // EOF，避免依赖 stdin 的事件消费者提前退出。
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      graceMs,
      env,
    })
  }

  /** spawn 子进程、接上两条流，返回还没拿到 id 的记录。 */
  function spawnMonitor(input: {
    command: string
    label: string
    cwd: string
    owner: Agent | undefined
    persistent: boolean
    delivery: MonitorDelivery | undefined
    ignoreStdoutLines: readonly string[]
    quiet?: boolean
    timeoutMs: number
    restartPolicy: MonitorRestartPolicy
    exec: ToolRunContext
  }): MonitorRecord {
    const cfg = current()
    const env = monitorEnv(ctx, input.exec)
    const handle = spawnHandle(input.command, input.cwd, env, cfg.graceMs)
    const record = newRecord({
      id: 'monitor-?',
      label: input.label,
      command: input.command,
      cwd: input.cwd,
      owner: input.owner,
      persistent: input.persistent,
      delivery: input.delivery,
      ignoreStdoutLines: input.ignoreStdoutLines,
      quiet: input.quiet === true,
      startedAt: Date.now(),
      restartPolicy: input.restartPolicy,
      env,
      graceMs: cfg.graceMs,
      handle,
    })
    attachGeneration(record, handle)
    return record
  }

  /**
   * 建壳并给这一轮配上两条流的读手。
   *
   * 读手的回调要指回 `record` 自己（行要进它的队列），而 record 正在被建——
   * 于是顺序倒过来：**先建读手、再建壳**。回调最早也要等进程真的吐出字节才会跑，
   * 那时 `record` 早就赋完了；`attach` 由 {@link attachGeneration} 负责，
   * 这一步只接线、不接流。
   */
  function newRecord(init: NewRecordInit): MonitorRecord {
    let record: MonitorRecord
    const stdout = new LineReader(
      line => enqueueLine(record, line),
      error => logger.warn(`monitor ${record.id} 输出流出错：${String(error)}`),
    )
    const stderr = new LineReader(
      line => pushStderr(record, line),
      error => logger.warn(`monitor ${record.id} stderr 流出错：${String(error)}`),
    )
    record = {
      ...init,
      stdout,
      stderr,
      generation: 0,
      generationStartedAt: Date.now(),
      restarts: 0,
      restartTimer: undefined,
      logPath: '',
      log: undefined,
      logOpened: false,
      logBroken: false,
      pending: [],
      history: [],
      received: 0,
      delivered: 0,
      lastLineAt: undefined,
      stderrTail: [],
      flushTimer: undefined,
      timeoutTimer: undefined,
      timeoutAt: undefined,
      cancelReason: undefined,
      finished: false,
      jobAppend: undefined,
      settle: () => {},
    }
    return record
  }

  /**
   * 接上这一轮的两条流。
   *
   * `generation` 是给回调用的「轮次」：进程的 `done` 是异步来的，重拉之后上一轮
   * 迟到的回调不能来结算新进程。
   */
  function attachGeneration(record: MonitorRecord, handle: SubprocessHandle): void {
    record.generation += 1
    const generation = record.generation
    record.generationStartedAt = Date.now()
    record.stdout.attach(handle.stdout)
    record.stderr.attach(handle.stderr)
    handle.done.then(
      outcome => {
        if (record.generation === generation) finishMonitor(record, outcome.exitCode, outcome.signal)
      },
      error => {
        if (record.generation === generation) finishMonitor(record, null, null, String(error))
      },
    )
  }

  /**
   * 重拉：同一条命令、同一个 cwd、同一份环境，id / 历史 / 日志都不变。
   *
   * 两条流必须**重建**：`LineReader` 自带解码器与半行残留，跨进程复用会把上一轮
   * 没凑完整的那半行接到新进程的第一行前面。历史、待送队列、stderr 尾巴这些属于
   * 「这条监听」而不是「这一轮」，所以留在 record 上不动。
   */
  function respawn(record: MonitorRecord): void {
    const handle = spawnHandle(record.command, record.cwd, record.env, record.graceMs)
    record.handle = handle
    record.stdout = makeStdoutReader(record)
    record.stderr = makeStderrReader(record)
    attachGeneration(record, handle)
    logger.info(`monitor ${record.id} 已重拉（第 ${record.restarts} 次）`)
  }

  function makeStdoutReader(record: MonitorRecord): LineReader {
    return new LineReader(
      line => enqueueLine(record, line),
      error => logger.warn(`monitor ${record.id} 输出流出错：${String(error)}`),
    )
  }

  function makeStderrReader(record: MonitorRecord): LineReader {
    return new LineReader(
      line => pushStderr(record, line),
      error => logger.warn(`monitor ${record.id} stderr 流出错：${String(error)}`),
    )
  }

  /** 一行进队列：入历史、入待送队列，并按 coalesceMs 排一次 flush。 */
  function enqueueLine(record: MonitorRecord, line: string): void {
    record.lastLineAt = Date.now()
    const text = truncateLine(line, current().maxLineBytes)
    record.history.push(text)
    const max = current().historyLines
    while (record.history.length > max) record.history.shift()
    record.received += 1
    // 宿主 job_output 把追加的片段原样 join('') 拼接，行尾换行要自己带上，否则多行粘成一行、空行丢失。
    record.jobAppend?.(`${text}\n`)
    if (record.quiet || record.ignoreStdoutLines.includes(line)) return
    record.pending.push(text)
    scheduleFlush(record)
  }

  function scheduleFlush(record: MonitorRecord): void {
    if (record.finished) return
    if (record.flushTimer !== undefined) return
    const wait = current().coalesceMs
    if (wait <= 0) {
      flush(record)
      return
    }
    record.flushTimer = setTimeout(() => {
      record.flushTimer = undefined
      flush(record)
    }, wait)
    record.flushTimer.unref?.()
  }

  /** 把待送队列按行数 / 字节数上限切成一条消息送进会话。 */
  function flush(record: MonitorRecord): void {
    if (record.pending.length === 0) return
    const cfg = current()
    const lines: string[] = []
    let bytes = 0
    while (record.pending.length > 0 && lines.length < cfg.maxLinesPerNotice) {
      const line = record.pending[0] as string
      const size = Buffer.byteLength(line, 'utf8') + 1
      if (lines.length > 0 && bytes + size > cfg.maxBytesPerNotice) break
      lines.push(line)
      bytes += size
      record.pending.shift()
    }
    record.delivered += lines.length
    const more = record.pending.length > 0 ? `\n[+${record.pending.length} more lines queued]` : ''
    deliver(record, `${lines.join('\n')}${more}`, `${recordName(record)} · ${lines.length} output lines`)
    if (record.pending.length > 0) scheduleFlush(record)
  }

  /** stderr 落日志文件，同时在内存里留个尾巴供结束通知用。 */
  function pushStderr(record: MonitorRecord, line: string): void {
    const keep = current().stderrTailLines
    if (keep > 0) {
      record.stderrTail.push(line)
      while (record.stderrTail.length > keep) record.stderrTail.shift()
    }
    if (record.logBroken) return
    if (record.log === undefined) {
      try {
        mkdirSync(resolveLogDir(current()), { recursive: true })
        // job 序号会随宿主重建而重置；独立日志首次只新建，重拉才追加同一记录。
        const log = createWriteStream(record.logPath, { flags: record.logOpened ? 'a' : 'wx' })
        // 打开失败（EACCES）和写入失败（ENOSPC）都是之后异步发的 error 事件，上面的
        // try 抓不到；没人监听就成了未捕获异常，桌面版后端会因此整个退出。
        log.on('error', (error) => {
          if (record.log === log) record.log = undefined
          if (record.logBroken) return
          record.logBroken = true
          logger.warn(`monitor ${record.id}: stderr 日志写不进去，这条监听不再写日志：${String(error)}`)
        })
        record.log = log
        record.logOpened = true
      } catch (error) {
        record.logBroken = true
        logger.warn(`monitor ${record.id}: stderr 日志写不进去，这条监听不再写日志：${String(error)}`)
        return
      }
    }
    record.log.write(`${line}\n`)
  }

  // ── 结束与取消 ──────────────────────────────────────────────────────

  function armTimeout(record: MonitorRecord, timeoutMs: number): void {
    if (timeoutMs <= 0) return
    record.timeoutAt = Date.now() + timeoutMs
    record.timeoutTimer = setTimeout(() => {
      cancelMonitor(record, 'timeout')
    }, timeoutMs)
    record.timeoutTimer.unref?.()
  }

  function cancelMonitor(record: MonitorRecord, reason: string): void {
    if (record.finished) return
    record.cancelReason ??= reason
    // 落在重拉等待窗口里时，当前**没有活着的进程**：不会有 done 回调来收尾，
    // 得自己把它结算掉，否则这条 job 会永远挂在 running 上（kill 不掉、也读不到终态）。
    if (record.restartTimer !== undefined) {
      clearTimeout(record.restartTimer)
      record.restartTimer = undefined
      finishMonitor(record, null, null)
      return
    }
    try {
      record.handle.terminate()
    } catch (error) {
      logger.warn(`monitor ${record.id}: 终止失败：${String(error)}`)
    }
  }

  /**
   * 进程收尾。
   *
   * 这里分成两条路：**该重拉就重拉**（结算推迟到真的不拉了），否则才结算 job。
   * 判断顺序是刻意的——先看「是不是有人叫停」，再看策略，最后才看次数上限；
   * 被人叫停（kill / 超时 / 会话销毁 / 插件卸载）永远不重拉。
   */
  function finishMonitor(
    record: MonitorRecord,
    exitCode: number | null,
    signal: NodeJS.Signals | null,
    failure?: string,
  ): void {
    if (record.finished) return
    if (record.flushTimer !== undefined) {
      clearTimeout(record.flushTimer)
      record.flushTimer = undefined
    }
    // 这一轮的最后半行先交出去，再决定是重拉还是收尾。
    record.stdout.takeCarry()
    record.stderr.takeCarry()

    const cancelled = record.cancelReason !== undefined
    const failed = failure !== undefined || exitCode !== 0
    const detail = failure
      ?? record.cancelReason
      ?? `exit code: ${exitCode ?? signal ?? 'unknown'}`

    if (!cancelled && shouldRestart(record, failed)) {
      // 还要重拉：flush 会给队列里剩的排下一次定时续送。
      flush(record)
      scheduleRestart(record, detail)
      return
    }

    record.finished = true
    // 不再有下一轮定时器来续送了：剩下的行现在就分批送完，否则超出两批的部分会
    // 永远卡在队列里，而模型最后看到的是「还有 N 行在排队」，会一直等下去。
    while (record.pending.length > 0) flush(record)
    if (record.timeoutTimer !== undefined) {
      clearTimeout(record.timeoutTimer)
      record.timeoutTimer = undefined
    }
    record.log?.end()
    record.log = undefined

    const status: JobOutcome['status'] = cancelled ? 'killed' : failed ? 'failed' : 'completed'
    record.settle({ status, detail })
    if (shouldAnnounceEnd(record, status)) announceEnd(record, status, detail)
    else if (record.cancelReason === TURN_END_REASON) announceTurnEndStop(record)
    pruneFinished()
    logger.info(`monitor ${record.id} 结束：${status}（${detail}）`)
  }

  /** 策略 + 次数上限，两个条件都过了才重拉。 */
  function shouldRestart(record: MonitorRecord, failed: boolean): boolean {
    if (record.restartPolicy === 'never') return false
    if (record.restartPolicy === 'on-failure' && !failed) return false
    const limit = current().restartLimit
    return limit === 0 || record.restarts < limit
  }

  /** 排一次重拉：按连续失败次数做 2 倍退避，并按需报一声。 */
  function scheduleRestart(record: MonitorRecord, detail: string): void {
    const cfg = current()
    // 上一轮活得够久 = 那不是崩溃循环，是「跑了一阵子才出事」：退避清零，
    // 下次仍从最小延迟开始。少了这一条，一个每周崩一次的监听会被当成
    // 连续失败，退避一路涨到上限。
    //
    // `restartResetMs: 0` 的语义是**从不判定健康**（于是所有失败都算连续），
    // 而不是「每一轮都健康」——后者会让退避永远涨不起来、次数上限永远够不到，
    // 退化成 20ms 一次的紧密崩溃循环。
    if (cfg.restartResetMs > 0 && Date.now() - record.generationStartedAt >= cfg.restartResetMs) {
      record.restarts = 0
    }
    record.restarts += 1
    const delay = Math.min(cfg.restartDelayMs * 2 ** (record.restarts - 1), cfg.restartMaxDelayMs)

    if (shouldAnnounceRestart(record)) {
      const parts = [`Process exited; restarting: ${detail}; attempt ${record.restarts}, retrying in ${formatDuration(delay)}`]
      if (record.stderrTail.length > 0) {
        parts.push(`stderr tail:\n${truncateBytes(record.stderrTail.join('\n'), STDERR_NOTICE_BYTES)}`)
      }
      deliver(record, parts.join('\n'), `${recordName(record)} · process exited, restarting (attempt ${record.restarts})`)
    }
    logger.warn(`monitor ${record.id} 第 ${record.restarts} 次重拉（${delay}ms 后）：${detail}`)

    record.restartTimer = setTimeout(() => {
      record.restartTimer = undefined
      if (record.finished || record.cancelReason !== undefined) return
      try {
        respawn(record)
      } catch (error) {
        // spawn 自己就抛（cwd 没了、可执行文件不见了）：算这一轮失败，继续按策略退避重试。
        finishMonitor(record, null, null, `respawn failed: ${String(error)}`)
      }
    }, delay)
    record.restartTimer.unref?.()
  }

  /**
   * 崩溃循环不能刷屏。
   *
   * 前三次每次都报（那是「刚挂，要人看一眼」的信号），之后每 10 次报一次——
   * 退避封顶 60s 时，最坏也就是 10 分钟一条，而不会变成一分钟一条。
   */
  function shouldAnnounceRestart(record: MonitorRecord): boolean {
    return record.restarts <= 3 || record.restarts % 10 === 0
  }

  /**
   * 结束通知只在「模型需要知道」时补一条。
   *
   * 正常退出不补：`dsh-tool-jobs` 已经会发一条通用的任务结束通知，模型想看细节
   * 用 `monitor_output` / `job_output` 就够了，每条监听结束都刷一条是噪音。
   * 要补的是三种「不说就不知道」：异常退出、超时、以及进程自己退出却**一行都没产出**——
   * 最后那种正是「命令写错了，Monitor 起了就结束」的形状。
   */
  function shouldAnnounceEnd(record: MonitorRecord, status: JobOutcome['status']): boolean {
    if (status === 'failed') return true
    // 被叫停（kill、回合结束停掉非持久监听、会话销毁、插件卸载）是有人决定的，
    // 没出过行也不说明命令起错了；默认 steer 投递下补一条还会把闲着的会话叫醒。
    if (status === 'killed') return record.cancelReason === 'timeout'
    return record.received === 0
  }

  function announceEnd(record: MonitorRecord, status: JobOutcome['status'], detail: string): void {
    const parts = [`Monitor ended: ${status} (${detail}), ran for ${formatDuration(Date.now() - record.startedAt)}`]
    if (record.restarts > 0) {
      parts.push(`Restarted ${record.restarts} time(s) in total${current().restartLimit > 0 && record.restarts >= current().restartLimit ? ' (limit reached)' : ''}.`)
    }
    // A timeout with no output only means the event never came; that does not prove the command was wrong.
    if (record.received === 0 && status !== 'killed') {
      parts.push('The whole run produced no stdout - the command is likely wrong (unknown flag, scope not enabled, expired auth); stderr has the original error.')
    }
    if (record.stderrTail.length > 0) {
      parts.push(`stderr tail:\n${truncateBytes(record.stderrTail.join('\n'), STDERR_NOTICE_BYTES)}`)
    }
    if (record.logBroken) parts.push(`The stderr log could not be written (${record.logPath} is not writable); only the tail above is available.`)
    else if (record.logPath !== '') parts.push(`Full stderr log: ${record.logPath}`)
    deliver(record, parts.join('\n'), `${recordName(record)} · monitor ended: ${status}`)
  }

  /**
   * 非持久监听被回合结束停掉时，命令其实还没跑完；不说的话模型以为结果稍后会自己送来。
   * 这时会话刚转空闲，所以固定走不唤醒的 inject，不看这条监听或插件的投递设置：
   * 下一轮开始时模型能看到，但不会为此单独开一轮。
   */
  function announceTurnEndStop(record: MonitorRecord): void {
    deliver(
      record,
      'The command did not finish before this turn ended. To wait for its result, do not set persistent:false, or collect the result with monitor_output before ending the turn.',
      `${recordName(record)} · stopped at turn end`,
      'inject',
    )
  }

  function pruneFinished(): void {
    const finished = [...records.values()]
      .filter(record => record.finished)
      .sort((a, b) => a.startedAt - b.startedAt)
    while (finished.length > KEEP_FINISHED) {
      const oldest = finished.shift()
      if (oldest !== undefined) records.delete(oldest.id)
    }
  }

  // ── 送进会话 ────────────────────────────────────────────────────────

  /**
   * 把一段文本作为通知送进主人的会话。
   *
   * `steer` 是关键：闲着的 agent 收到它会**直接开一轮**——监听类场景里
   * 「群里 @ 了机器人」必须能自己动起来，`inject` 做不到这件事。
   */
  function recordName(record: MonitorRecord): string {
    return `${record.id}${record.label.length > 0 ? ` · ${record.label}` : ''}`
  }

  function deliver(record: MonitorRecord, text: string, summary: string, force?: MonitorDelivery): void {
    const owner = record.owner
    if (owner === undefined) return
    const message = createUserMessage({
      content: [{ type: 'text', text: reminderText('dsh-monitor', summary, text) }],
      source: {
        kind: 'dsh-monitor',
        form: 'notice',
        summary: boundContextSummary(reminderSummary('dsh-monitor', summary)),
      },
    })
    try {
      const mode = force ?? record.delivery ?? current().delivery
      if (mode === 'inject') owner.inject(message)
      else if (mode === 'followup') owner.followup(message)
      else owner.steer(message)
    } catch (error) {
      // 主人已经被销毁时这里会抛：不值得让一条通知带崩收尾流程。
      logger.warn(`monitor ${record.id}: 通知送不进去：${String(error)}`)
    }
  }

  // ── 回看 ────────────────────────────────────────────────────────────

  /** 非消费式回看（`monitor_output` 用的那个）：最近 N 行。 */
  function tailHistory(record: MonitorRecord, tail: number): string {
    return record.history.slice(Math.max(0, record.history.length - tail)).join('\n')
  }

  // ── 工具 ────────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'monitor',
    description: [
      'Start a long-lived command and have every stdout line delivered to you as a message the moment it is produced — no polling, no job_output needed.',
      'Use it for event streams (an IM listener, a log tail, a CI watcher, a file watcher); use bash run_in_background instead when you only need the result after it finishes.',
      'The process is registered as a background job (kind "monitor"), so job_list and job_kill also work on it.',
      'stderr never reaches you as events: it goes to a log file whose path is returned here, and its tail is attached to the end-of-stream notice.',
      'The child keeps an open stdin, so commands that exit on stdin EOF (event consumers) stay alive without a keep-alive hack.',
      'By default a monitor keeps running across turns with no idle or lifetime timeout unless you pass timeout_ms. persistent:false stops it as soon as this agent goes idle, even if the command has not finished; you then only get a non-waking notice at the start of your next turn, so collect results with monitor_output before ending the turn.',
      'delivery selects how this monitor sends notices: steer wakes an idle agent; inject queues context without waking it; followup opens a separate turn. Omit delivery to follow the live plugin setting.',
      'ignore_stdout_lines skips automatic delivery only for exact complete stdout lines you explicitly name (for known heartbeats). All lines stay in monitor_output and job_output; no lines are ignored by default.',
      'Pass restart:"on-failure" for a stream that must survive for weeks: a crashed process is relaunched with exponential backoff while the id, the history and the log stay the same.',
      'A persistent monitor also survives a DSH restart: it is paused before the app quits and relaunched afterwards under a NEW id; you get a non-waking notice with the new id and the gap during which output was missed.',
      'Stop it with monitor_kill when the stream is no longer needed; a monitor left running keeps waking you with every line.',
    ].join(' '),
    parameters: {
      command: {
        type: 'string',
        required: true,
        description: 'Shell command to run (bash -c on POSIX). Its stdout is the event stream.',
      },
      description: {
        type: 'string',
        description: 'One-line label for this monitor; shown on every delivered line and in the jobs panel.',
      },
      persistent: {
        type: 'boolean',
        description: 'Default true: keeps running across turns until it exits or is killed. false: stopped as soon as this agent next goes idle.',
      },
      timeout_ms: {
        type: 'number',
        description: 'Lifetime cap in milliseconds; the monitor is stopped when it expires. Omit it for an unbounded monitor (the default).',
      },
      restart: {
        type: 'string',
        enum: ['never', 'on-failure', 'always'],
        description: 'What to do when the process exits on its own. never (default): the monitor ends. on-failure: relaunch on a non-zero exit or spawn failure — use this for a long-lived listener. always: relaunch unless you killed it. A kill, a timeout or session disposal never restarts.',
      },
      delivery: {
        type: 'string',
        enum: ['steer', 'inject', 'followup'],
        description: 'Override delivery for this monitor only. inject does not wake an idle agent; steer wakes it; followup starts a separate turn. Omit to follow the live plugin setting. Generic job completion notices are controlled separately by tool-jobs.',
      },
      ignore_stdout_lines: {
        type: 'array',
        items: { type: 'string' },
        description: 'Exact complete stdout lines to keep only for later review, not automatically deliver. Use only for explicitly known heartbeats; default empty. Matching happens before truncation; history and job_output still retain the lines.',
      },
      workdir: {
        type: 'string',
        description: 'Working directory; defaults to the session workspace.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          label: { type: 'string', required: true },
          command: { type: 'string', required: true },
          cwd: { type: 'string', required: true },
          log_path: { type: 'string', required: true },
          restart: { type: 'string', required: true },
          delivery: { type: 'string', required: true },
          persistent: { type: 'boolean', required: true },
          ignore_stdout_lines: { type: 'array', items: { type: 'string' }, required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `monitoring ${value.id} · ${value.label}\n`
          + (value.delivery === 'plugin-default'
            ? 'delivery follows the live plugin setting, including later changes; inject queues without waking, steer/followup can wake; do not poll.\n'
            : value.delivery === 'inject'
              ? 'stdout notices queue without waking an idle agent; do not poll.\n'
              : `stdout notices use ${value.delivery} and can wake an idle agent; do not poll.\n`)
          + (value.persistent ? 'keeps running across turns until it exits or is killed.\n' : 'persistent:false — stopped when this agent next goes idle or the turn ends, even if the command is unfinished; results will not arrive later, so collect them with monitor_output before ending the turn.\n')
          + `exact stdout lines excluded from automatic delivery: ${JSON.stringify(value.ignore_stdout_lines)}; retained for review.\n`
          + `stderr → ${value.log_path}（第一行 stderr 到来时才创建，之前文件不存在）\n`
          + `restart: ${value.restart}${value.restart === 'never' ? '（进程退出即结束）' : '（非人为退出会按退避重拉，id 与历史不变）'}\n`
          + `stop it with monitor_kill ${value.id}`,
      }],
    },
    isConcurrencySafe: () => true,
    presentCall: args => ({
      card: 'terminal',
      title: args.command,
      ...(args.description !== undefined ? { description: args.description } : {}),
      ...(args.workdir !== undefined ? { cwd: args.workdir } : {}),
    }),
    async execute(args, exec) {
      const command = args.command.trim()
      if (command.length === 0) throw new Error('monitor: command must not be empty')
      const cfg = current()
      const cwd = resolveCwd(args.workdir, exec.agent)
      const timeoutMs = resolveTimeout(args.timeout_ms, cfg)
      const restartPolicy = args.restart ?? cfg.restart
      const record = startMonitor({
        command,
        label: args.description?.trim() || firstLine(command),
        cwd,
        owner: exec.agent,
        persistent: args.persistent !== false,
        delivery: args.delivery,
        ignoreStdoutLines: [...(args.ignore_stdout_lines ?? [])],
        timeoutMs,
        restartPolicy,
        exec,
      })
      return {
        id: record.id,
        label: record.label,
        command: record.command,
        cwd: record.cwd,
        log_path: record.logPath,
        restart: record.restartPolicy,
        delivery: record.delivery ?? 'plugin-default',
        persistent: record.persistent,
        ignore_stdout_lines: [...record.ignoreStdoutLines],
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'monitor_output',
    description: [
      'Show the most recent output of a monitor without consuming it.',
      'You normally do not need this: every stdout line was already delivered to you as a message.',
      'It is for re-reading after the fact — a line you scrolled past, or output that arrived while you were busy.',
      'For a consuming read of any background job, including monitors, use job_output.',
    ].join(' '),
    parameters: {
      monitor_id: { type: 'string', required: true, description: 'Monitor id returned by the monitor tool.' },
      tail: { type: 'integer', description: 'How many trailing lines to show. Defaults to 100.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          status: { type: 'string', required: true },
          detail: { type: 'string' },
          lines: { type: 'integer', required: true },
          restarts: { type: 'integer', required: true },
          text: { type: 'string', required: true },
          log_path: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.text.length > 0 ? value.text : '(no output retained)'}\n`
          + `[${value.id}: ${value.status}${value.detail !== undefined ? `, ${value.detail}` : ''}, `
          + `${value.lines} line(s) retained, ${value.restarts} restart(s), `
          + `stderr → ${value.log_path.length > 0 ? value.log_path : '(none)'}]`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const snapshot = jobs.get(JobId(args.monitor_id), exec.agent?.session.id)
      const record = records.get(args.monitor_id)
      return {
        id: snapshot.id,
        status: snapshot.status,
        ...(snapshot.detail !== undefined ? { detail: snapshot.detail } : {}),
        lines: record?.history.length ?? 0,
        restarts: record?.restarts ?? 0,
        text: record !== undefined ? tailHistory(record, Math.max(1, args.tail ?? 100)) : '',
        log_path: record?.logPath ?? '',
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'monitor_kill',
    description: 'Stop a monitor started with the monitor tool. Equivalent to job_kill for that monitor.',
    parameters: {
      monitor_id: { type: 'string', required: true, description: 'Monitor id returned by the monitor tool.' },
      reason: { type: 'string', description: 'Short reason, recorded in the log and forwarded to the process teardown.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          outcome: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.outcome === 'requested'
          ? `stopping ${value.id}`
          : `${value.id} had already finished`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const outcome = jobs.kill(JobId(args.monitor_id), exec.agent?.session.id, args.reason)
      return { id: args.monitor_id, outcome }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'monitor_list',
    description: 'List the monitors you started, running first. Use it to find ids for monitor_output or monitor_kill.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          monitors: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                label: { type: 'string', required: true },
                status: { type: 'string', required: true },
                lines: { type: 'integer', required: true },
                restarts: { type: 'integer', required: true },
                log_path: { type: 'string', required: true },
                last_line_at: { type: 'number' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.monitors.length === 0
          ? 'no monitors'
          : value.monitors
            .map(row => `${row.id}  ${row.status}  ${row.lines} line(s)${row.restarts > 0 ? `  ${row.restarts} restart(s)` : ''}${row.last_line_at === undefined ? '' : `  last output ${ageText(row.last_line_at)}`}  ${row.label}`)
            .join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      return {
        monitors: jobs.list(exec.agent?.session.id)
          .filter(snapshot => snapshot.kind === 'monitor')
          .sort((a, b) => statusRank(a) - statusRank(b) || b.startedAt - a.startedAt)
          .map(snapshot => {
            const rec = records.get(snapshot.id)
            return {
              id: snapshot.id,
              label: snapshot.label,
              status: snapshot.status,
              lines: rec?.history.length ?? 0,
              restarts: rec?.restarts ?? 0,
              log_path: rec?.logPath ?? '',
              ...(rec?.lastLineAt === undefined ? {} : { last_line_at: rec.lastLineAt }),
            }
          }),
      }
    },
  }))

  // 系统提示里那段「别去 poll」的约定，挂在 job 那段后面。
  ctx.systemPrompt.section({
    name: 'tool:monitor',
    order: ctx.systemPrompt.getSectionOrder('TOOL_JOBS'),
    text: [
      'Use monitor to start a long-lived command whose stdout lines are delivered to you automatically as messages;',
      'never poll a monitor and never start a second one for a stream that is already monitored.',
      'monitor defaults to persistent:true with no idle or lifetime timeout unless you pass timeout_ms; persistent:false stops it when this agent goes idle, even before the command finishes; for a stream that must survive for weeks, pass restart:"on-failure" so a crashed process is relaunched with backoff under the same id.',
      'A persistent monitor is relaunched automatically after a DSH restart under a new id (a notice tells you the new id); an open monitor does not block a restart.',
      'monitor_list / monitor_output / monitor_kill inspect and stop them; they are also background jobs (job_list / job_kill).',
      'Use delivery:inject on one monitor to queue notices without waking; omit delivery to follow the live plugin setting. Only explicitly named ignore_stdout_lines are excluded from automatic delivery; review still retains them.',
      'Leave a monitor running only when you mean to keep receiving its events.',
    ].join(' '),
  })

  logger.info(
    `长驻命令的 stdout 会逐行送进会话（monitor 工具已就绪；投递方式 ${current().delivery}）`,
  )
}

// ── 纯函数 ──────────────────────────────────────────────────────────────

/** 平台 shell：POSIX 走 `bash -c`，Windows 走 pwsh。 */
function shellArgv(command: string): string[] {
  if (process.platform === 'win32') return ['pwsh', '-NoProfile', '-NonInteractive', '-Command', command]
  // 故意**不用 `-l`**：登录 shell 会去读 ~/.profile / ~/.bash_profile，用户 profile
  // 里任何一句报错都会落进 stderr，被当成「这个命令有问题」——实测本机 `.profile`
  // 就有一句 `env: No such file or directory`，会让每条监听在结束时都收到一条假警报。
  // 环境不需要靠 `-l` 找：PATH 等变量是显式传下去的（见 monitorEnv）。
  return ['/bin/bash', '-c', command]
}

/**
 * 子进程环境：托管环境变量 + 洗过的父环境。
 *
 * `scrubbedParentEnv()` 会摘掉凭证形状的变量和所有 `DSH_*`（harness 身份不隐式
 * 外泄），PATH / HOME / 代理照常保留，保证子进程能找到命令和所需配置。
 * 当前会话的 `DSH_*` 事实再经 `shellEnv` 显式合回来，和 bash 工具看到的一致。
 */
function monitorEnv(ctx: Context, exec: ToolRunContext): Record<string, string> {
  const env: Record<string, string> = { ...scrubbedParentEnv() }
  const shellEnv = ctx.get('shellEnv')
  if (shellEnv === undefined) return env
  try {
    Object.assign(env, shellEnv.collect(exec))
  } catch {
    // 托管环境是加分项，拿不到就算了，不影响命令本身。
  }
  return env
}

/** 工作目录：显式给的优先，相对路径按会话工作区展开，都没给就用会话工作区。 */
function resolveCwd(workdir: string | undefined, agent: Agent | undefined): string {
  const sessionCwd = agent?.session.header.cwd
  if (workdir === undefined || workdir.trim() === '') return sessionCwd ?? process.cwd()
  const trimmed = workdir.trim()
  if (trimmed.startsWith('/') || /^[A-Za-z]:[\\/]/.test(trimmed)) return trimmed
  return sessionCwd !== undefined ? join(sessionCwd, trimmed) : trimmed
}

/** timeout_ms：缺省取配置默认值，非零值夹到上限内。 */
function resolveTimeout(requested: number | undefined, cfg: MonitorSnapshot): number {
  const value = requested ?? cfg.defaultTimeoutMs
  if (!Number.isFinite(value) || value <= 0) return 0
  return Math.min(value, cfg.maxTimeoutMs)
}

function resolveLogDir(cfg: MonitorSnapshot): string {
  const configured = cfg.logDir.trim()
  if (configured === '') return dshHomePath('monitor-logs')
  return expandHomePath(configured)
}

/** 单行超限就截断，并显式标注截掉多少——不静默砍掉判据。 */
export function truncateLine(line: string, maxBytes: number): string {
  if (Buffer.byteLength(line, 'utf8') <= maxBytes) return line
  const kept = truncateBytes(line, maxBytes)
  const dropped = Buffer.byteLength(line, 'utf8') - Buffer.byteLength(kept, 'utf8')
  return `${kept}…[+${dropped} bytes truncated]`
}

/** 按字节截断，但不在多字节字符中间下刀。 */
export function truncateBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.byteLength <= maxBytes) return text
  return new StringDecoder('utf8').write(buffer.subarray(0, maxBytes))
}

/** 命令的第一行，用作没给 description 时的标签；太长就截断——它会出现在每条通知的抬头。 */
function firstLine(command: string): string {
  const index = command.indexOf('\n')
  const head = index < 0 ? command : command.slice(0, index)
  return head.length > 60 ? `${head.slice(0, 59)}…` : head
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
}

/** 运行中的排前面。 */
function statusRank(snapshot: JobView): number {
  return snapshot.status === 'running' || snapshot.status === 'stopping' ? 0 : 1
}

/** 「45 秒前 / 3 分钟前 / 2 小时前 / 5 天前」——给 monitor_list 的渲染用。 */
function ageText(at: number, now: number = Date.now()): string {
  const s = Math.max(0, Math.floor((now - at) / 1000))
  if (s < 60) return `${s} 秒前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}
