/**
 * dsh-control：控制正在运行的 DSH。只做三件事：把命令送进本机通信口、打印结果、按结果给退出码。
 * 参数解释都在插件里；命令行只带一份命令表副本，DSH 没运行时 `dsh-control help` 也能列全。
 *
 * 另外几件必须在 DSH 外面做的事也在这里：wait / chat 的分段等待、start / doctor / restart / version。
 *
 * 退出码（没做成用户要的事一律非 0）：
 *   0   成功，或最后一轮成功完成
 *   1   任务失败或中止；其他错误，包括 DSH 执行了但报告失败（例如装插件失败）、拿不到额度报告
 *   2   用法错误、找不到会话、对上多个、被规则拦下（只读、禁用、拒绝换模型、整档没有可用模型、回答没被接收）
 *   10  会话停下来在等你回答（wait、chat、status）
 *   11  wait / chat：会话空闲，起点之后没有新内容，不会再有结果
 *   69  DSH 没在运行（或插件没加载）
 *   124 等待超时，会话还在跑或还有排队消息
 *
 * @module
 */
import { randomUUID } from 'node:crypto'
import { FailureReasonCollector } from './failure.ts'
import { spawn, spawnSync } from 'node:child_process'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMANDS, validateCommand } from '../commands.ts'
import { UsageError } from '../gateway.ts'
import { appLaunchEnv, backendRunning, fromSsh, hostRunning, offlineDoctor, layeredDoctor, reportText, type Report } from './doctor.ts'
import { DEFAULT_FEED, appVersion, fetchFeed, pruneUpgrade, stageRelease, swapBack, swapIn, type Swap } from './upgrade.ts'

/** argv → 位置参数 + 选项。`--key value`、`--key=value`、`--flag`；重复的选项收成数组；`--` 之后全算位置参数。 */
export function parseArgv(argv: string[], booleans: Set<string>, takesValue: (key: string, next: string) => boolean = () => false): { positional: string[]; options: Record<string, unknown> } {
  const positional: string[] = []
  const options: Record<string, unknown> = {}
  const put = (key: string, value: unknown) => {
    const prev = options[key]
    options[key] = prev === undefined ? value : Array.isArray(prev) ? [...prev, value] : [prev, value]
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--') { positional.push(...argv.slice(i + 1)); break }
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=')
      if (eq > 0) { put(a.slice(2, eq), a.slice(eq + 1)); continue }
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || (booleans.has(key) && !takesValue(key, next)) || (next.startsWith('--') && next.length > 2)) { put(key, true); continue }
      put(key, next)
      i++
      continue
    }
    positional.push(a)
  }
  return { positional, options }
}

const BOOLEAN_OPTIONS = new Set(['running', 'all', 'ungrouped', 'include-blank', 'tools', 'steer', 'now', 'interrupt', 'force', 'refresh', 'json', 'help', 'full', 'kill', 'when-idle', 'if-idle', 'detach', 'quiet', 'check', 'settled', 'sound', 'no-title', 'no-body', 'no-sound'])

export function parseCommand(argv: string[]) {
  const [command, ...rest] = argv
  const { positional, options } = parseArgv(rest, BOOLEAN_OPTIONS, (key, next) =>
    command === 'answer' && key === 'json' && /^[\s]*[\[{]/.test(next))
  let asJson = options['json'] === true
  if (command === 'answer') {
    // 同名选项有两种用途：字符串交给服务端，裸开关只决定输出。
    const values = Array.isArray(options['json']) ? options['json'] : [options['json']]
    const payloads = values.filter((value) => typeof value === 'string')
    asJson = payloads.length > 0 ? values.includes(true) : asJson
    if (payloads.length > 0) options['json'] = payloads.length === 1 ? payloads[0] : payloads
    else delete options['json']
  } else {
    delete options['json']
  }
  return { command, positional, options, asJson }
}

/** 跟真实 App 打交道的四件事。测试换成假的，免得测试去退出、打开、强杀本机正在用的 DSH。 */

export type QuitStrategy = 'apple-event' | 'menu'
export interface QuitResult {
  status: number | null
  stderr: string
  stdout?: string
  signal?: NodeJS.Signals | null
  error?: Error
  stage?: string
}
export type QuitRunner = (command: string, args: string[], env: NodeJS.ProcessEnv) => QuitResult

/** 显式选择普通退出入口；菜单路线只读核名后投递一次，不自动换路线。 */
export function quitApp(strategy: QuitStrategy = 'apple-event', app = '/Applications/DeepSeek Harness.app', env: NodeJS.ProcessEnv = process.env, run: QuitRunner = (command, args, childEnv) => spawnSync(command, args, { env: childEnv, encoding: 'utf8', timeout: 20_000 })): QuitResult {
  if (strategy === 'apple-event') return { ...run('osascript', ['-e', 'tell application "DeepSeek Harness" to quit'], env), stage: 'apple-event' }
  const rejected = (stage: string, message: string, previous?: QuitResult): QuitResult => ({ ...previous, status: previous?.status && previous.status !== 0 ? previous.status : 1, stderr: `${message}${previous?.stderr ? `\n${previous.stderr}` : ''}`, stage })
  if (!app.startsWith('/') || !app.endsWith('/DeepSeek Harness.app')) return rejected('menu-target', '菜单退出要求 DSH_APP 为 DeepSeek Harness.app 的绝对路径，不能模糊匹配其他应用')
  const computerUse = join(env['HOME'] ?? homedir(), '.local/bin/computer-control')
  const childEnv = { ...env, COMPUTER_CONTROL_NO_AUTOLAUNCH: '1' }
  const query = (args: string[], stage: string): { result: QuitResult; data?: Record<string, unknown> } => {
    const result = { ...run(computerUse, ['--local', ...args, '--json'], childEnv), stage }
    if (result.status !== 0 || result.error) return { result }
    try {
      const data = JSON.parse(result.stdout ?? '') as Record<string, unknown>
      if (data?.ok !== true) return { result: rejected(stage, 'computer-control 没有确认这一步成功', result) }
      return { result, data }
    } catch { return { result: rejected(stage, 'computer-control 没有返回有效 JSON', result) } }
  }
  const capability = query(['--capabilities'], 'menu-capabilities')
  if (capability.data === undefined) return capability.result
  if (capability.data.tool !== 'computer-control' || capability.data.protocol !== 1 || !Array.isArray(capability.data.features) || !capability.data.features.includes('local-routing')) return rejected('menu-capabilities', 'computer-control 不支持本机路由协议；没有执行菜单退出', capability.result)
  const menu = query(['menu', app, 'DeepSeek Harness'], 'menu-inspect')
  if (menu.data === undefined) return menu.result
  if (menu.data.app !== 'DeepSeek Harness' || menu.data.menu !== 'DeepSeek Harness' || !Array.isArray(menu.data.items)) return rejected('menu-inspect', '菜单清单不能精确确认 DeepSeek Harness 应用菜单', menu.result)
  const labels = new Set(['退出 DeepSeek Harness', 'Quit DeepSeek Harness'])
  const matches = menu.data.items.filter((item) => typeof item === 'object' && item !== null && labels.has(String((item as Record<string, unknown>).label))) as Record<string, unknown>[]
  if (matches.length !== 1 || matches[0]?.enabled !== true || matches[0]?.hasSubmenu !== false) return rejected('menu-inspect', '普通退出菜单项必须精确唯一、已启用且没有子菜单；不支持其他本地化或 Quit and Keep Windows', menu.result)
  const action = query(['menu', app, 'DeepSeek Harness', String(matches[0].label)], 'menu-action')
  if (action.data !== undefined && (action.data.menu !== 'DeepSeek Harness' || action.data.item !== matches[0].label)) return rejected('menu-action', 'computer-control 动作回执与指定退出项不一致，结果未确认；不会重试或换路线', action.result)
  return action.result
}

// 文案和按钮照 dsh-desktop 的 DesktopQuitConfirmation（0.2.1-rc.2）。必须整句相等：「任务将中断，且……定时任务不会运行」那句包含提醒那句。
const QUIT_TITLES = ['退出 DeepSeek Harness？', 'Quit DeepSeek Harness?']
const SCHEDULED_ONLY = ['应用关闭期间，定时任务不会运行', 'Scheduled tasks will not run while the app is closed.']
const QUIT_BUTTONS = ['退出', 'Quit']
const CONFIRM_SCRIPT = `on run argv
  set procName to item 1 of argv
  set titles to {item 2 of argv, item 3 of argv}
  set details to {item 4 of argv, item 5 of argv}
  set quitLabels to {item 6 of argv, item 7 of argv}
  tell application "System Events"
    if not (exists process procName) then return "gone"
    repeat with w in (windows of process procName)
      set texts to {}
      try
        set texts to value of static texts of w
      end try
      set hasTitle to false
      set hasDetail to false
      repeat with t in texts
        if titles contains (t as text) then set hasTitle to true
        if details contains (t as text) then set hasDetail to true
      end repeat
      if hasTitle then
        if not hasDetail then
          set AppleScript's text item delimiters to " | "
          return "other:" & (texts as text)
        end if
        set targets to {}
        repeat with b in (buttons of w)
          if quitLabels contains (name of b as text) then set end of targets to b
        end repeat
        if (count of targets) is not 1 then return "other:quit buttons " & (count of targets)
        click item 1 of targets
        return "clicked"
      end if
    end repeat
  end tell
  return "none"
end run`

/** 经系统辅助功能找 DSH 的退出框；只有标题和说明都整句对上「只剩定时提醒」时，才点唯一的「退出」按钮。 */
export function confirmScheduledQuit(env: NodeJS.ProcessEnv = process.env): string {
  const r = spawnSync('osascript', ['-e', CONFIRM_SCRIPT, 'DeepSeek Harness', ...QUIT_TITLES, ...SCHEDULED_ONLY, ...QUIT_BUTTONS], { encoding: 'utf8', env, timeout: 10_000 })
  if (r.error || r.status !== 0) return `error:${(r.error?.message ?? r.stderr ?? '').trim() || `退出码 ${r.status}`}`
  return r.stdout.trim()
}

/** 屏幕锁着（显示器睡后要密码也算）。这时系统辅助功能看不到任何窗口，退出框点不到。读不到当没锁。 */
export function screenLocked(): boolean {
  const r = spawnSync('/usr/sbin/ioreg', ['-n', 'Root', '-d1', '-a'], { encoding: 'utf8', timeout: 5000 })
  if (r.error || r.status !== 0) return false
  const uid = process.getuid?.()
  return (r.stdout.match(/<dict>(?:(?!<\/?dict>)[\s\S])*<\/dict>/g) ?? []).some((session) =>
    /<key>CGSSessionScreenIsLocked<\/key>\s*<true\/>/.test(session) && (uid === undefined || session.includes(`<key>kCGSSessionUserIDKey</key>`) && new RegExp(`<key>kCGSSessionUserIDKey</key>\\s*<integer>${String(uid)}</integer>`).test(session)))
}

export interface AppControl {
  running(app: string, home: string): boolean
  backendRunning(app: string, home: string): boolean
  quit(strategy?: QuitStrategy, app?: string, env?: NodeJS.ProcessEnv): QuitResult
  /** 退出框只说定时提醒时点「退出」：clicked 点了，none 没看到框，other:<框里的字> 是别的框、没点，error:<原因>。 */
  confirmScheduledQuit(env?: NodeJS.ProcessEnv): string
  screenLocked(): boolean
  open(app: string, env: NodeJS.ProcessEnv): { status: number | null; stderr: string }
  kill(signal: 'TERM' | 'KILL'): void
}

export const realApp: AppControl = {
  running: hostRunning,
  backendRunning,
  quit: quitApp,
  confirmScheduledQuit,
  screenLocked,
  open: (app, env) => spawnSync('open', ['-g', '-a', app], { encoding: 'utf8', env }),
  kill: (signal) => { spawnSync('pkill', [`-${signal}`, '-f', 'DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness']) },
}

/** 把 dsh-control 自己放进独立的后台进程（新进程组、不跟终端和 DSH 一起退出），输出追加进日志。返回进程号。 */
export function spawnDetachedCli(args: string[], env: NodeJS.ProcessEnv, log: string): number {
  const entry = process.argv[1] ?? join(dirname(fileURLToPath(import.meta.url)), 'dsh-control.js')
  const fd = openSync(log, 'a')
  try {
    const child = spawn(process.execPath, [entry, ...args], { env, detached: true, stdio: ['ignore', fd, fd] })
    child.unref()
    return child.pid ?? -1
  } finally { closeSync(fd) }
}

export function createCli(
  env: NodeJS.ProcessEnv = process.env,
  stdout: (text: string) => unknown = (text) => process.stdout.write(text),
  stderr: (text: string) => unknown = (text) => process.stderr.write(text),
  spawnDetached: (args: string[], env: NodeJS.ProcessEnv, log: string) => number = spawnDetachedCli,
  app: AppControl = realApp,
): (argv: string[]) => Promise<number> {
  const HOME = env['DSH_HOME'] ?? join(homedir(), '.dsh')
  const SOCKET = env['DSH_CONTROL_SOCKET'] ?? join(HOME, 'dsh-control', 'dsh.sock')
  const APP = env['DSH_APP'] ?? '/Applications/DeepSeek Harness.app'
  // 下载和旧版备份有上 G，避免放进存储配置的 DSH_HOME。
  const UPGRADE_DIR = env['DSH_CONTROL_UPGRADE_DIR'] ?? join(env['XDG_STATE_HOME'] ?? join(env['HOME'] ?? homedir(), '.local/state'), 'dsh-control/app-upgrade')
  /** restart --install-app：旧 App 退出后、拉起前换成这一份。 */
  let installApp: string | undefined
  let installed: Swap | undefined
  let installError: string | undefined

  const EXIT = { ok: 0, error: 1, usage: 2, asking: 10, idle: 11, down: 69, timeout: 124 } as const
  const DEFAULT_WAIT_SEC = 1800

  class Down extends Error {}

  /** 只读等待可以安全重问：连不上，或 DSH 退出时正挂着的请求被对方断开。 */
  function reconnectable(error: unknown): boolean {
    return error instanceof Down || (error as NodeJS.ErrnoException | undefined)?.code === 'ECONNRESET'
  }

  interface RunResponse {
    ok: boolean
    text?: string
    data?: unknown
    status?: string
    meta?: Record<string, unknown>
    error?: { code: string; message: string; details?: unknown }
    /** 通信口回的 HTTP 状态：400 是调用方的问题或被规则拦下，其余失败是执行出错。 */
    httpStatus?: number
  }

  function http(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 180_000): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
      if (!existsSync(SOCKET)) {
        reject(new Down(`找不到通信口 ${SOCKET}`))
        return
      }
      const payload = body === undefined ? undefined : JSON.stringify(body)
      const req = request({
        socketPath: SOCKET,
        path,
        method,
        headers: payload === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
        timeout: timeoutMs,
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          try {
            resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) })
          } catch {
            reject(new Error(`通信口回了不是 JSON 的内容（HTTP ${res.statusCode ?? 0}）：${text.slice(0, 200)}`))
          }
        })
      })
      req.on('timeout', () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)))
      req.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') reject(new Down(`通信口连不上（${error.code}）：DSH 可能没在运行`))
        else reject(error)
      })
      if (payload !== undefined) req.write(payload)
      req.end()
    })
  }

  function print(text: string): void {
    stdout(text.endsWith('\n') ? text : `${text}\n`)
  }

  class CliExit extends Error {
    readonly code: number
    constructor(code: number, message: string) { super(message); this.code = code }
  }

  /** 最近一次 fail() 的原因，重启结束时转告发起的会话。 */
  let lastFailure = ''

  function fail(message: string, code: number): never {
    lastFailure = message
    stderr(message.endsWith('\n') ? message : `${message}\n`)
    throw new CliExit(code, message)
  }

  async function run(command: string, args: string[], options: Record<string, unknown>, timeoutMs?: number): Promise<RunResponse> {
    const { status, json } = await http('POST', '/v1/run', { command, args, options }, timeoutMs)
    return { ...(json as RunResponse), httpStatus: status }
  }

  function exitFor(res: RunResponse): number {
    if (res.status === 'failed' || res.status === 'aborted') return EXIT.error
    if (!res.ok) return res.httpStatus === 400 ? EXIT.usage : EXIT.error
    if (res.status === 'waiting-input') return EXIT.asking
    if (res.status === 'idle') return EXIT.idle
    if (res.status === 'timeout' || res.status === 'running') return EXIT.timeout
    return EXIT.ok
  }

  let receipt: Record<string, unknown> | undefined
  let invocationJson = false

  function output(res: RunResponse, asJson: boolean): void {
    if (asJson) {
      print(JSON.stringify(res.ok
        ? { ok: true, status: res.status ?? 'ok', data: res.data ?? null, ...(receipt === undefined ? {} : { receipt }), ...(res.meta === undefined ? {} : { meta: res.meta }) }
        : { ok: false, error: res.error ?? { code: 'internal', message: '通信口没给出错误信息' }, ...(res.status === undefined ? {} : { status: res.status }), ...(res.data === undefined ? {} : { data: res.data }), ...(receipt === undefined ? {} : { receipt }) }, null, 2))
      return
    }
    if (res.ok) print(res.text ?? '')
    else {
      if (res.text) print(res.text)
      stderr(`错误（${res.error?.code ?? '?'}）：${res.error?.message ?? '未知'}\n`)
    }
  }

  /** wait：一段一段地问，直到跑完、在等你回答、或总超时。DSH 中途重启会重新连上接着等。 */
  async function waitLoop(args: string[], options: Record<string, unknown>, asJson: boolean): Promise<number> {
    validateCommand('wait', args, options)
    if (!args[0]?.trim()) throw new UsageError('wait 要写会话')
    const totalSec = Number(options['timeout'] ?? DEFAULT_WAIT_SEC)
    if (!Number.isFinite(totalSec) || totalSec <= 0) fail('--timeout 要是正数（秒）', EXIT.usage)
    const deadline = Date.now() + totalSec * 1000
    const sliceOpt = { ...options }
    delete sliceOpt['timeout']
    let last: RunResponse | undefined
    let downSince: number | undefined
    while (Date.now() < deadline) {
      const left = deadline - Date.now()
      try {
        last = await run('wait', args, { ...sliceOpt, slice: String(Math.max(1, Math.min(Number(sliceOpt['slice'] ?? 30000), left))) }, 150_000)
        downSince = undefined
      } catch (error) {
        if (!reconnectable(error)) throw error
        downSince ??= Date.now()
        if (Date.now() - downSince > 300_000) fail(`${error instanceof Error ? error.message : String(error)}；已经等了 5 分钟还没恢复`, EXIT.down)
        await new Promise((r) => setTimeout(r, 3000))
        continue
      }
      if (!last.ok || last.status !== 'running') break
    }
    if (last === undefined) fail('等待期间 DSH 一直连不上', EXIT.down)
    if (last.ok && last.status === 'running') {
      output({ ...last, status: 'timeout', text: `等了 ${totalSec} 秒还没有结果：${waitingFor(last.data)}。稍后接着 wait（起点不变）。\n${(last.text ?? '').split('\n').slice(1).join('\n')}` }, asJson)
      return EXIT.timeout
    }
    output(last, asJson)
    return exitFor(last)
  }

  /** 指定总时长时持续等待，每次只占一个短连接。 */
  async function waitIdleLoop(args: string[], options: Record<string, unknown>, asJson: boolean): Promise<number> {
    validateCommand('wait-idle', args, options)
    const totalSec = Number(options['timeout'])
    const deadline = Date.now() + totalSec * 1000
    const sliceOpt = { ...options }
    delete sliceOpt['timeout']
    let last: RunResponse | undefined
    let downSince: number | undefined
    let target = [...args]
    do {
      const left = Math.max(1, deadline - Date.now())
      try {
        last = await run('wait-idle', target, { ...sliceOpt, slice: String(Math.max(1, Math.min(Number(sliceOpt['slice'] ?? 30000), left))) }, 150_000)
        downSince = undefined
      } catch (error) {
        if (!reconnectable(error)) throw error
        downSince ??= Date.now()
        if (Date.now() >= deadline || Date.now() - downSince > 300_000) fail(`${error instanceof Error ? error.message : String(error)}；等待期间未能恢复连接`, EXIT.down)
        await new Promise((r) => setTimeout(r, Math.min(3000, Math.max(1, deadline - Date.now()))))
        continue
      }
      const data = last.data as { sessionId?: unknown } | undefined
      if (target.length > 0 && typeof data?.sessionId === 'string') target = [data.sessionId]
      if (!last.ok || last.status !== 'running') break
    } while (Date.now() < deadline)
    if (downSince !== undefined || last === undefined) fail('等待期间 DSH 一直连不上', EXIT.down)
    if (last.ok && last.status === 'running') {
      output({ ...last, status: 'timeout', text: `等了 ${totalSec} 秒还没有空闲：${last.text ?? ''}` }, asJson)
      return EXIT.timeout
    }
    output(last, asJson)
    return exitFor(last)
  }

  /** 超时时会话的真实状态，用插件给的原因；没有就按状态字段说。 */
  function waitingFor(data: unknown): string {
    const d = (typeof data === 'object' && data !== null ? data : {}) as { waitingFor?: unknown; state?: unknown; running?: unknown; queued?: unknown }
    if (typeof d.waitingFor === 'string') return d.waitingFor
    if (d.running === true || d.state === 'running') return '会话在跑'
    if (typeof d.queued === 'number' && d.queued > 0) return `会话空闲，但还有 ${d.queued} 条排队消息没开始处理`
    if (d.state === 'asking') return '会话在等你回答'
    return '会话空闲'
  }

  function appRunning(): boolean {
    return app.running(APP, HOME)
  }

  /** 连不上时按 App 在不在跑给下一步：App 开着去跑 start 什么也不会改变。 */
  function downAdvice(reason: string): string {
    if (!appRunning()) return `${reason}\nDSH 没在运行：先跑 dsh-control start 打开它。`
    return `${reason}\nDSH 还开着，但通信口不在或不答话：多半是文件被删了，或 dsh-control 插件正在重新加载。插件发现文件没了会在几秒内自动重建，等半分钟再试；还连不上就跑 dsh-control doctor 看插件有没有加载，插件正常仍连不上再跑 dsh-control restart。`
  }

  /** 通信口连不上时，没有后台就没有会话：App 已退出，或停在后台崩溃的窗口上。 */
  function noBackend(): boolean {
    return !appRunning() || !app.backendRunning(APP, HOME)
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  /** 等通信口能答话；200 毫秒问一次，起来就返回。 */
  let previousInstance: string | undefined
  async function waitForSocket(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const { status, json } = await http('GET', '/v1/health', undefined, 5000)
        const identity = json as { ok?: boolean; pid?: number; startedAt?: number }
        if (status !== 200 || identity.ok !== true) continue
        if (previousInstance !== undefined && (!Number.isSafeInteger(identity.pid) || typeof identity.startedAt !== 'number' || `${identity.pid}:${identity.startedAt}` === previousInstance)) continue
        const services = await run('health', [], {}, 5000)
        const data = services.data as { running?: unknown } | undefined
        if (services.ok && Array.isArray(data?.running)) {
          recordRestart('starting', { readiness: { previousInstance: previousInstance ?? null, instance: `${identity.pid}:${identity.startedAt}`, sessionServiceReady: true } })
          return true
        }
      } catch { /* 还没起来 */ }
      await sleep(Math.min(200, Math.max(0, deadline - Date.now())))
    }
    return false
  }


  async function start(prechecked = false): Promise<number> {
    if (!prechecked && !(await preflight())) return EXIT.error
    if (previousInstance === undefined && await waitForSocket(1000)) { print('DSH 已经在运行'); return EXIT.ok }
    if (!appRunning()) {
      if (installApp !== undefined && installed === undefined && installError === undefined) {
        recordRestart('starting', { message: `旧程序已退出，正在把 App 换成 ${installApp}` })
        try {
          installed = swapIn(installApp, APP, join(UPGRADE_DIR, 'backups'))
          stamp(`已把 App 从 ${installed.from || '未安装'} 换成 ${installed.to}，旧版暂放在 ${installed.backup}，新版就绪后删掉`)
        } catch (error) {
          installError = error instanceof Error ? error.message : String(error)
          stamp(`没换成新版，原来的 App 留在原位：${installError}`)
        }
      }
      let launch: NodeJS.ProcessEnv
      try { launch = appLaunchEnv(env) } catch (error) { fail(error instanceof Error ? error.message : String(error), EXIT.error) }
      if (fromSsh(env)) print('在远程登录里：改用这台电脑桌面会话的环境打开 DSH，选目录窗口照常是本地的')
      for (const key of ['DSH_CONTROL_RESTART_REQUEST_ID', 'DSH_CONTROL_RESTART_LOG', 'DSH_CONTROL_DETACHED']) delete launch[key]
      const r = app.open(APP, launch)
      if (r.status !== 0) {
        if (installed !== undefined) return rollbackInstall(`打不开：${r.stderr}`)
        fail(`打不开 ${APP}：${r.stderr}`, EXIT.error)
      }
    }
    print('正在启动 DSH……')
    recordRestart('starting', { message: '旧程序已退出，正在等待新实例和会话服务就绪' })
    if (await waitForSocket(Number(env['DSH_CONTROL_START_TIMEOUT_MS'] ?? 120_000))) {
      if (installError !== undefined) fail(`DSH 已拉起，但没换成新版：${installError}`, EXIT.error)
      if (installed !== undefined) {
        print(`DSH 已就绪，App 现在是 ${installed.to}`)
        try { pruneUpgrade(UPGRADE_DIR); print(`已删掉旧版 ${installed.from || '（无）'} 和下载文件`) } catch (error) { stamp(`删旧版和下载目录没成功，不影响使用：${error instanceof Error ? error.message : String(error)}`) }
        return EXIT.ok
      }
      print('DSH 已就绪')
      return EXIT.ok
    }
    if (installed !== undefined) return rollbackInstall('两分钟内通信口没出现')
    fail('DSH 进程在，但两分钟内通信口没出现。跑 dsh-control doctor 看原因', EXIT.down)
  }

  /** 换上的新版起不来：结束它，把旧版挪回原位再拉起；最后仍按失败返回，说明已换回。 */
  async function rollbackInstall(reason: string): Promise<number> {
    const swap = installed!
    installed = undefined
    stamp(`新版 ${swap.to} 没起来（${reason}），换回 ${swap.from}`)
    await stopApp()
    try { swapBack(swap) } catch (error) {
      fail(`新版 ${swap.to} 没起来（${reason}），换回旧版也失败：${error instanceof Error ? error.message : String(error)}。旧版在 ${swap.backup}，要手动挪回 ${APP}`, EXIT.error)
    }
    installError = `新版 ${swap.to} 没起来（${reason}），已换回 ${swap.from}`
    return start(true)
  }

  const RESTART_LOGS = join(HOME, 'dsh-control', 'restart-logs')
  /** 这次重启的日志：转后台时由父进程定好路径传进来，好让通知里写的就是这一份。 */
  let localRestartLog = ''
  const restartLog = () => env['DSH_CONTROL_RESTART_LOG'] ?? localRestartLog
  let failureDetail: Record<string, unknown> | undefined
  let notificationState = 'failed'
  const RESTART_LOCK = join(HOME, 'dsh-control', 'restart.lock')
  /** 已有重启在排队时，后来要重启的会话记在这里，一行一个；排队的那次结束时一并通知。 */
  const waiterFile = (pid: number) => join(HOME, 'dsh-control', `restart.waiters.${pid}`)
  const RESTART_STATE = join(HOME, 'dsh-control', 'restart-state.json')
  const RESTART_REQUESTS = join(HOME, 'dsh-control', 'restart-requests')
  const requestId = env['DSH_CONTROL_RESTART_REQUEST_ID'] ?? randomUUID()
  const requestPath = (id: string) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new UsageError('重启 request-id 必须是 UUID')
    return join(RESTART_REQUESTS, `${id}.json`)
  }
  function writeRequest(id: string, state: Record<string, unknown>): void {
    const path = requestPath(id)
    mkdirSync(RESTART_REQUESTS, { recursive: true })
    const temp = `${path}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(state), { mode: 0o600 })
    renameSync(temp, path)
  }
  let restartState: Record<string, unknown> = {}
  let restartOwned = false
  function recordRestart(phase: string, detail: Record<string, unknown> = {}): void {
    if (!restartOwned) return
    restartState = { ...restartState, ...detail, schemaVersion: 2, requestId, phase, pid: process.pid, updatedAt: Date.now(), log: restartLog() }
    mkdirSync(dirname(RESTART_STATE), { recursive: true })
    const temp = `${RESTART_STATE}.${process.pid}.tmp`
    writeFileSync(temp, JSON.stringify(restartState), { mode: 0o600 })
    renameSync(temp, RESTART_STATE)
    writeRequest(requestId, restartState)
  }
  function restartStatus(asJson: boolean, requested?: string): number {
    if (requested !== undefined) requestPath(requested)
    let state: Record<string, unknown>
    try {
      state = JSON.parse(readFileSync(requested === undefined ? RESTART_STATE : requestPath(requested), 'utf8')) as Record<string, unknown>
      if (requested !== undefined && state.requestId !== requested) throw new Error('重启记录身份不匹配')
      if (typeof state.executionRequestId === 'string') {
        const execution = JSON.parse(readFileSync(requestPath(state.executionRequestId), 'utf8')) as Record<string, unknown>
        if (execution.requestId !== state.executionRequestId) throw new Error('重启执行记录身份不匹配')
        state = { ...execution, requestId: requested ?? state.requestId, executionRequestId: execution.requestId }
      }
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') fail(`重启状态无法读取：${String(error)}`, EXIT.error)
      if (requested !== undefined) throw new UsageError('找不到这次重启请求的记录；不能使用其他重启结果代替', 'not-found')
      state = { phase: 'none', message: '没有重启记录' }
    }
    if (state.phase === 'queued' && typeof state.requestId === 'string') {
      try { state.pid = Number(readFileSync(`${requestPath(state.requestId)}.pid`, 'utf8')) } catch {}
    }
    const readiness = state.readiness as { previousInstance?: unknown; instance?: unknown; sessionServiceReady?: unknown } | undefined
    const verified = readiness?.sessionServiceReady === true && typeof readiness.instance === 'string' && /^[1-9][0-9]*:[0-9]+$/.test(readiness.instance) && (readiness.previousInstance === null || typeof readiness.previousInstance === 'string' && readiness.previousInstance !== readiness.instance)
    if (state.phase === 'completed') {
      if (state.schemaVersion === 2 && !verified) fail('重启状态损坏：新版完成记录没有有效的实例与会话服务验收证据，不能确认完成', EXIT.error)
      state = { ...state, readinessConfirmed: verified, completionEvidence: verified ? 'confirmed' : 'legacy-unverified' }
    }
    if (state.notification === 'delivered') state = { ...state, recordedNotification: 'delivered', notification: 'recorded-unconfirmed', notificationMessage: '旧记录只证明通知接口返回成功，未确认安排会话执行' }
    const terminal = ['completed', 'failed', 'timed-out', 'interrupted'].includes(String(state.phase))
    let alive = false
    if (typeof state.pid === 'number') { try { process.kill(state.pid, 0); alive = true } catch {} }
    if (!terminal && state.phase !== 'none' && !alive) state = { ...state, lastKnownPhase: state.phase, phase: 'interrupted', exitCode: null, message: '重启执行进程已结束，未确认完成，不能当成成功；前置命令是否已生效须先核对，不能自动重放' }
    if (asJson) print(JSON.stringify({ ok: true, status: state.phase, data: state }, null, 2))
    else print(`重启状态：${String(state.phase)}
${String(state.message ?? '')}
${state.log ? `日志：${String(state.log)}` : ''}`)
    return EXIT.ok
  }
  async function withRestartGuard<T>(action: () => T): Promise<T> {
    mkdirSync(dirname(RESTART_LOCK), { recursive: true })
    const guardPath = `${RESTART_LOCK}.claim`
    let guard: number
    const deadline = Date.now() + 5000
    for (;;) {
      try { guard = openSync(guardPath, 'wx', 0o600); writeFileSync(guard, String(process.pid)); break }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (Date.now() >= deadline) {
          let owner = ''
          try { owner = readFileSync(guardPath, 'utf8').trim() } catch {}
          let alive = false
          if (/^[1-9][0-9]*$/.test(owner)) { try { process.kill(Number(owner), 0); alive = true } catch {} }
          fail(alive ? `重启登记锁由进程 ${owner} 持有，等待5秒仍未释放，本次未安排` : `重启登记锁残留或损坏：${guardPath}，记录的进程 ${owner || '未知'} 不可确认。请先确认没有重启执行者，再清除此登记锁；没有执行更新或退出`, EXIT.error)
        }
        await sleep(20)
      }
    }
    try { return action() } finally { closeSync(guard); rmSync(guardPath, { force: true }) }
  }
  async function acquireRestart(): Promise<number | undefined> {
    return withRestartGuard(() => {
    for (let n = 0; n < 3; n++) {
      try {
        const fd = openSync(RESTART_LOCK, 'wx', 0o600)
        try { writeFileSync(fd, String(process.pid)) } finally { closeSync(fd) }
        return undefined
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const holder = lockHolder(true)
        if (holder !== undefined) return holder
        // 空锁可能正由另一个进程写入，不能把它当作陈旧锁删除。
        const text = readFileSync(RESTART_LOCK, 'utf8').trim()
        if (text === '') fail('重启锁尚未写完或已损坏，不能确认执行者，本次未安排', EXIT.usage)
        rmSync(RESTART_LOCK, { force: true })
      }
    }
    throw new Error('无法取得重启执行锁')
    })
  }
  const QUIT_WAIT_MS = Number(env['DSH_CONTROL_QUIT_WAIT_MS'] ?? 30_000)
  /** 会话、排队消息和后台任务清场的最长等待；提前清干净会立即继续。 */
  const QUIT_CLEAR_MS = Number(env['DSH_CONTROL_QUIT_CLEAR_MS'] ?? 5_000)
  const KEEP_LOGS = 20
  // profile 改动（常见是 --before 写的）会让宿主热重载本插件，通信口要过一两秒才在原路径重建（2026-10-21 18:20 撞上过）。
  const RELOAD_GRACE_MS = Number(env['DSH_CONTROL_RELOAD_GRACE_MS'] ?? 30_000)
  /** 强制重启时，同一个会话中止后又跑起来，隔多久再中止一次。 */
  const RECANCEL_MS = 2_000
  /** --before 的命令最多跑多久（写 profile、装依赖）。 */
  const BEFORE_TIMEOUT_MS = 10 * 60_000
  /**
   * 送给被打断会话的话。读者是那个会话里的模型，它不关心 DSH 为什么重启，只需要知道：
   * 刚才那一轮停下不是用户叫停的、接着做、怎么接、不要把这件事当成新任务去汇报。
   * 宿主中止时只记一个「已中止」，不写是谁停的，模型容易当成用户叫停然后等指示，所以第一句就说清楚。
   */
  const RESUME_TEXT = [
    'This turn was interrupted by the system (to restart DSH), not stopped by the user. The task has not changed.',
    'Continue the original work: first see where it stopped. If an interrupted tool call would change something, verify whether it already took effect before deciding whether to redo it; rerun read-only calls directly.',
    'Do not explain this interruption to the user; continue as planned and report when done.',
  ].join(' ')
  const RESUME_SUMMARY = 'Previous turn interrupted by the system (not the user); continue'
  /** 用户原话最多带多少字进通知；全文在会话记录里。 */
  const QUOTE_LIMIT = 800
  /**
   * 被中止的那一轮里用户的话还没回应完时的版本。不能再说「任务没变、不用解释」：那会把用户刚问的事盖掉
   * （2026-11-04 会话 cac50301：用户问「你是不是不会主动停止目标」，重启后模型照旧干活）。
   */
  const resumeForUser = (said: string): string => [
    'This turn was interrupted by the system (to restart DSH), not stopped by the user.',
    `You had not finished answering this user message when the turn was interrupted: "${said.length > QUOTE_LIMIT ? `${said.slice(0, QUOTE_LIMIT)}… (truncated; the full text is in the session log)` : said}"`,
    'Answer it first: answer questions, follow instructions to change approach or stop, and close the goal if it is time. After that, decide whether to continue the original work; if an interrupted tool call would change something, verify whether it already took effect before deciding whether to redo it.',
  ].join(' ')
  const RESUME_USER_SUMMARY = 'Previous turn interrupted; the user message was not answered; answer it first'
  /** 每个会话独有的 DSH 变量，不带进后台进程，也就不会带进新拉起的 DSH。 */
  const SESSION_VARS = ['DSH_SESSION_ID', 'DSH_SHELL', 'DSH_WEB_URL', 'DSH_PROFILE_DIR']

  const shortId = (id: string) => id.replace(/^session-/, '').slice(0, 8)
  const sameSession = (a: string, b: string) => a === b || shortId(a) === shortId(b)
  const stamp = (text: string) => print(`${new Date().toLocaleString('zh-CN', { hour12: false })} ${text}`)

  /**
   * restart：一律强制重启（用户 2026-10-27 定：没有「等空闲」这一档，也不必再写 `--force`）。
   * - 在跑的会话先中止、后台任务停掉、子代理记下来，正常退出没走成就结束进程再拉起；被中止的会话重启后逐个发消息让它们继续。
   * - `--detach`：自己转到后台独立进程里做（DSH 会话里自动带上：前台命令是 DSH 的子进程，DSH 一退出就跟着没了）。
   * - `--kill`：直接结束进程再拉起，不先试正常退出。
   * - `--notify <会话>`：结束后（成功、失败）给这个会话发结果；`--detach` 在 DSH 会话里运行时默认通知发起的会话。
   */
  async function restart(options: Record<string, unknown>): Promise<number> {
    const flags = new Set(['detach', 'kill'])
    const REMOVED_FLAGS = new Set(['when-idle', 'force'])
    const values = new Set(['notify', 'before', 'quit-via', 'install-app'])
    for (const [key, value] of Object.entries(options)) {
      if (flags.has(key)) {
        if (value !== true) fail(`--${key} 只能是单个不带值的开关`, EXIT.usage)
      } else if (values.has(key)) {
        if (typeof value !== 'string' || value.trim() === '') fail(`--${key} 后面要写一个值`, EXIT.usage)
      } else if (REMOVED_FLAGS.has(key)) {
        fail(`restart 不再有 --${key}：现在一律强制重启，不写这个开关也是同样的效果。${key === 'when-idle' || key === 'if-idle' ? '等所有会话空闲这一档已经删掉。' : ''}`, EXIT.usage)
      } else {
        fail(`restart 不支持 --${key}；转后台请用 --detach`, EXIT.usage)
      }
    }
    const quitVia = (options['quit-via'] ?? 'apple-event') as QuitStrategy
    if (quitVia !== 'apple-event' && quitVia !== 'menu') throw new UsageError('--quit-via 只能是 apple-event 或 menu')
    if (options['quit-via'] !== undefined && options['kill'] === true) throw new UsageError('--quit-via 不能和 --kill 同用')
    if (options['notify'] === true) fail('--notify 后面要写会话', EXIT.usage)
    const notify = typeof options['notify'] === 'string' ? options['notify']
      : env['DSH_SESSION_ID']?.trim() || env['DSH_SHELL'] === '1' ? env['DSH_SESSION_ID']?.trim() : undefined
    const before = typeof options['before'] === 'string' ? options['before'] : undefined
    // 「重启前先做的事」多半是写 profile，写了会热加载、打断在跑的会话，所以只许排在中止完所有会话之后。
    if (before !== undefined && options['kill'] === true) fail('--before 不能和 --kill 同用：强杀不等会话停下，没法先做这些事', EXIT.usage)
    const install = typeof options['install-app'] === 'string' ? options['install-app'] : undefined
    if (install !== undefined && (!install.startsWith('/') || !install.endsWith('.app') || !existsSync(join(install, 'Contents/Info.plist')))) fail('--install-app 要写新版 App 的绝对路径（以 .app 结尾、里面有 Contents/Info.plist）', EXIT.usage)
    // 会话里（含 Python 内核起的子进程）的前台命令是 DSH 的子进程，DSH 一退出它就没了，所以一律转后台。
    if (env['DSH_SESSION_ID']?.trim() || env['DSH_SHELL'] === '1') options = { ...options, detach: true }
    if (options['detach'] === true) return detachRestart(options, notify)
    const holder = await acquireRestart()
    if (holder !== undefined) {
      if (install !== undefined) fail('已有重启在排队，这次换 App 没有执行。请等现有重启结束后再升级。', EXIT.usage)
      return joinQueue(holder, notify, before, quitVia)
    }
    restartOwned = true
    failureDetail = undefined
    restartState = {}
    installApp = install
    try {
      recordRestart('checking', { startedAt: Date.now(), notify, quitVia, message: '正在检查，尚未重启' })
      const outcome = await attempt(() => restartNow(options))
      if (outcome.code === EXIT.usage && notify === undefined) { recordRestart('failed', { message: outcome.reason || '被安全保护拒绝', finishedAt: Date.now() }); return outcome.code }
      return await finish(outcome, notify, 0)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return await finish({ code: error instanceof CliExit ? error.code : EXIT.error, interrupted: [], reason, ms: 0 }, notify, 0)
    } finally {
      // 不论重启成没成，为它暂停过的目标都要恢复，免得目标就此停住。
      try { await resumeGoals() } finally {
        const names = await withRestartGuard(() => {
          const names = takeWaiters()
          if (lockHolder(true) === process.pid) rmSync(RESTART_LOCK, { force: true })
          return names
        })
        await tellWaiters(notify, names)
        restartOwned = false
      }
    }
  }

  /**
   * 所有会话停下后、退出 DSH 前，跑一次 --before 的命令（多半是写 profile、装依赖）。
   * 这时没有会话在跑，写 profile 触发的热加载打断不了谁；之后离线检查发现 profile 变了会重跑。
   * 返回失败原因，成功返回 undefined。
   */
  async function runBefore(command: string): Promise<string | undefined> {
    const base = restartLog() || newRestartLog()
    localRestartLog = base
    const stdoutLog = `${base}.${requestId}.before.stdout.log`
    const stderrLog = `${base}.${requestId}.before.stderr.log`
    if (!existsSync(base)) writeFileSync(base, `前置命令完整输出：${stdoutLog}\n前置命令完整错误输出：${stderrLog}\n`, { mode: 0o600 })
    writeFileSync(stdoutLog, '', { mode: 0o600 })
    writeFileSync(stderrLog, '', { mode: 0o600 })
    recordRestart('updating', { message: '正在执行重启前更新，尚未重启', before: { stage: 'before', stdoutLog, stderrLog } })
    stamp('所有会话都停了，先做重启前的事（命令正文不写日志）')
    const childEnv: NodeJS.ProcessEnv = { ...env }
    for (const name of [...SESSION_VARS, 'DSH_CONTROL_RESTART_REQUEST_ID', 'DSH_CONTROL_RESTART_LOG', 'DSH_CONTROL_DETACHED']) delete childEnv[name]
    const collectors = [new FailureReasonCollector(), new FailureReasonCollector()]
    const r = await new Promise<{ status: number | null; signal: NodeJS.Signals | null; error?: NodeJS.ErrnoException }>((resolve) => {
      const child = spawn('/bin/sh', ['-c', command], { env: childEnv, timeout: BEFORE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] })
      recordRestart('updating', { before: { stage: 'before', pid: child.pid ?? null, stdoutLog, stderrLog } })
      let error: NodeJS.ErrnoException | undefined
      for (const [index, stream] of [child.stdout, child.stderr].entries()) {
        stream.setEncoding('utf8')
        stream.on('data', (text: string) => {
          appendFileSync(index === 0 ? stdoutLog : stderrLog, text)
          collectors[index]!.push(text)
          ;(index === 0 ? stdout : stderr)(text)
        })
      }
      child.on('error', (caught: NodeJS.ErrnoException) => { error = caught })
      child.on('close', (status, signal) => resolve({ status, signal, ...(error === undefined ? {} : { error }) }))
    })
    const results = collectors.map((collector) => collector.result())
    const priority = Math.min(...results.map((result) => result.priority))
    const reason = results.filter((result) => result.priority === priority).map((result) => result.reason).filter(Boolean).join('；')
    const commandStage = results.find((result) => result.stage !== undefined)?.stage
    const detail = { stage: 'before', commandStage, exitCode: r.status, signal: r.signal, errorCode: r.error?.code ?? null, error: r.error?.message ?? null, stdoutLog, stderrLog, reason }
    recordRestart('updating', { before: detail })
    if (r.status === 0 && r.signal === null && r.error === undefined) { stamp('重启前的事做完了'); return undefined }
    failureDetail = detail
    const why = r.error?.message ?? (r.signal !== null ? `被信号 ${r.signal} 停了` : `退出码 ${String(r.status)}`)
    return `重启前要做的事没做成（阶段 ${commandStage ? `before/${commandStage}` : 'before'}，${why}），所以没有重启：${reason || '命令没有提供错误说明'}。完整标准输出 ${stdoutLog}；完整错误输出 ${stderrLog}`
  }

  /** 为了重启暂停过、重启后要逐个恢复的目标。 */
  const pausedGoals: { session: string; goal: string }[] = []

  interface GoalWire { id: string; revision: number; phase: string; activation?: string }

  async function goalOf(session: string): Promise<GoalWire | undefined> {
    try {
      const res = await run('api', ['call', 'goals/get', JSON.stringify({ agentId: session })], {}, 20_000)
      const g = res.ok ? res.data as Partial<GoalWire> | null | undefined : undefined
      return g !== null && g !== undefined && typeof g.id === 'string' && typeof g.revision === 'number' && typeof g.phase === 'string' ? g as GoalWire : undefined
    } catch { return undefined }
  }

  /** 暂停这些目标，记进 pausedGoals，结束时由 resumeGoals 恢复。 */
  async function pauseGoals(goals: readonly { session: string; goal: GoalWire }[], done: (session: string) => string, failTail: string): Promise<void> {
    for (const { session, goal } of goals) {
      try {
        const res = await run('api', ['call', 'goals/pause', JSON.stringify({ agentId: session, ref: { id: goal.id, revision: goal.revision } })], {}, 20_000)
        if (res.ok) {
          pausedGoals.push({ session, goal: goal.id })
          stamp(done(session))
        } else stamp(`暂停会话 ${shortId(session)} 的目标没成：${res.error?.message ?? '未知'}${failTail}`)
      } catch (error) { stamp(`暂停会话 ${shortId(session)} 的目标没成：${error instanceof Error ? error.message : String(error)}${failTail}`) }
    }
  }

  /** 恢复为重启暂停过的目标；DSH 刚起来时服务可能还没好，最多试 30 秒。恢复不了就告诉那个会话。 */
  async function resumeGoals(): Promise<void> {
    for (const { session, goal } of pausedGoals.splice(0)) {
      const deadline = Date.now() + 30_000
      let why = ''
      for (;;) {
        try {
          const current = await goalOf(session)
          const idle = current?.phase === 'paused' || (current?.phase === 'active' && current.activation === 'disarmed')
          if (current !== undefined && current.id === goal && !idle) { why = ''; break }
          if (current !== undefined && current.id === goal) {
            const res = await run('api', ['call', 'goals/resume', JSON.stringify({ agentId: session, ref: { id: current.id, revision: current.revision } })], {}, 20_000)
            if (res.ok) { why = ''; break }
            why = res.error?.message ?? '未知'
          } else why = '读不到这个目标'
        } catch (error) { why = error instanceof Error ? error.message : String(error) }
        if (Date.now() >= deadline) break
        await sleep(500)
      }
      if (why === '') stamp(`会话 ${shortId(session)} 的目标已恢复`)
      else {
        stamp(`恢复会话 ${shortId(session)} 的目标没成：${why}`)
        await tell(session, `To stop sessions before restarting DSH, the system paused your goal. It could not be resumed automatically after the restart (${why}). You cannot resume it yourself; tell the user to resume it from the goal panel.`, 'Goal paused for restart could not be resumed')
      }
    }
  }

  /** 排队的这次结束时要告诉后来登记的会话的话；没走到结尾（例如异常）就用兜底说法。 */
  let waiterNote: { text: string; summary: string } | undefined
  /** 收尾时已经把结果并进别的消息发过的登记会话，tellWaiters 不再单发。 */
  const toldWaiters = new Set<string>()

  /**
   * 已有重启在进行：不再另起，把发起的会话记进名单，那次结束时一起通知它。
   * 以前直接拒绝，后来的会话收不到「重启完成」，只能请用户重启完回来说一声（2026-10-09 四个会话这样，复盘 I-008）。
   */
  async function joinQueue(holder: number, notify: string | undefined, before?: string, quitVia: QuitStrategy = 'apple-event'): Promise<number> {
    if (holder <= 0) fail('无法确认重启执行者，本次没有登记通知或安排重启', EXIT.usage)
    if (before !== undefined) fail('已有重启在排队，这次 --before 更新命令没有执行，也不能静默合并。请等现有重启结束后重新安排这次更新。', EXIT.usage)
    let attached: Record<string, unknown> | undefined
    await withRestartGuard(() => {
      if (lockHolder(true) !== holder) fail('原来的重启已结束，本次未登记；请查询 restart-status 后重新安排', EXIT.usage)
      try {
        const state = JSON.parse(readFileSync(RESTART_STATE, 'utf8')) as Record<string, unknown>
        if (state.pid === holder && typeof state.requestId === 'string') {
          const execution = JSON.parse(readFileSync(requestPath(state.requestId), 'utf8')) as Record<string, unknown>
          if (execution.requestId === state.requestId && execution.pid === holder) attached = execution
        }
      } catch {}
      if ((invocationJson || env['DSH_CONTROL_RESTART_REQUEST_ID']) && attached === undefined) throw new UsageError('已有重启尚未发布可关联的请求编号；本次未登记，请稍后重试', 'restart-not-ready')
      const existingVia = attached?.quitVia ?? 'apple-event'
      if (existingVia !== quitVia) throw new UsageError(`已有重启使用 ${String(existingVia)}，本次要求 ${quitVia}；没有替换或登记，请等原请求结束后重新安排`, 'restart-strategy-conflict')
      if (attached !== undefined) writeRequest(requestId, { requestId, executionRequestId: attached.requestId, phase: 'attached', pid: holder, startedAt: Date.now() })
      if (notify !== undefined) appendFileSync(waiterFile(holder), `${notify}\n`, { mode: 0o600 })
    })
    if (invocationJson) output({ ok: true, status: 'attached', data: { requestId, executionRequestId: attached?.requestId, pid: holder, startedAt: Date.now(), log: attached?.log, scheduled: false, attached: true } }, true)
    else print([
      `已经有一个重启在进行（进程 ${holder}），这次不另起，只登记结果通知。尚未重启，是否完成以结果通知和 restart-status 为准。`,
      notify === undefined ? '结束后不通知任何会话。' : `它结束后也会给会话 ${shortId(notify)} 发消息说明结果。`,
      `过程记在 ${RESTART_LOGS} 里进程号 ${holder} 那一份。`,
    ].join('\n'))
    return EXIT.ok
  }

  /** 登记名单，只读不删。 */
  function peekWaiters(): string[] {
    try { return readFileSync(waiterFile(process.pid), 'utf8').split('\n').map((s) => s.trim()).filter((s) => s !== '') } catch { return [] }
  }
  /** 取走登记名单并逐个通知（跳过已经单独通知过的发起会话）。 */
  function takeWaiters(): string[] {
    const names = peekWaiters()
    rmSync(waiterFile(process.pid), { force: true })
    return names
  }
  async function tellWaiters(notify: string | undefined, names: string[]): Promise<void> {
    const note = waiterNote ?? { text: `The queued restart ended unexpectedly; it is not confirmed whether DSH restarted. ${logHint()}Use dsh-control health to check, then tell the user.`, summary: 'Queued restart ended unexpectedly' }
    const seen = new Set<string>()
    for (const id of names) {
      if ((notify !== undefined && sameSession(id, notify)) || seen.has(shortId(id)) || toldWaiters.has(shortId(id))) continue
      seen.add(shortId(id))
      await tell(id, note.text, note.summary)
    }
  }

  interface BlockerJob { id: string; label: string; owner?: string; survivable?: boolean }
  interface ScheduledHold { sessionId: string; items: { id: string; label: string }[] }
  interface Blockers { running: string[]; queued: string[]; jobs: BlockerJob[]; clear: boolean; parents?: Record<string, string>; scheduled?: ScheduledHold[]; queuedDetails?: { id: string; nextTurnCount: number; nextStepCount: number; nextStepSources: { kind: string; form?: string }[] }[] }

  function scheduledText(holds: readonly ScheduledHold[]): string {
    const items = holds.flatMap((h) => h.items.map((i) => `「${i.label}」（${i.id.replace(/^schedule-/, '').slice(0, 8)}，会话 ${shortId(h.sessionId)}）`))
    return `已打开的会话挂着 ${items.length} 条定时提醒：${items.join('，')}`
  }

  function blockerText(b: Blockers): string {
    const hard = b.jobs.filter((j) => j.survivable !== true)
    return [
      b.running.length > 0 ? `${b.running.length} 个会话或子代理还在跑（${b.running.map(shortId).join(', ')}）` : '',
      b.queued.length > 0 ? `${b.queued.length} 个会话还有排队消息` : '',
      hard.length > 0 ? `${hard.length} 个后台任务还在跑（${hard.map((j) => `${j.id} ${j.label}${j.owner === undefined ? '' : `〔所属会话 ${shortId(j.owner)}〕`}`).join('，')}）` : '',
    ].filter((s) => s !== '').join('；')
  }

  /** 重启这一趟里被停掉的东西，重启后要告诉它们的主人。 */
  /** cwd：bash 任务启动时的目录，查到了重启后才在原会话里用原命令（label）重新拉起。 */
  interface Casualty { id: string; label: string; owner: string; kind: 'job' | 'subagent'; cwd?: string }
  /** 为重启暂停、新进程起来后由插件自己接回的监听（插件会通知主人，这里只记日志）。 */
  /** 退出那一刻查到的阻碍；失败记录用它覆盖排队时记下的旧阻碍，没查到就清掉。 */
  let quitTimeBlockers: Partial<Blockers> | undefined
  let suspended: { id: string; label: string; owner: string }[] = []
  let casualties: Casualty[] = []
  /** 退出检查里看到的子代理 → 上级。重启后给子代理的说明要改送上级：宿主不收直接发给子代理的通知。 */
  const subagentParents: Record<string, string> = {}
  /** 这次重启真的中止过的主会话（不含子代理），不论重启成没成都要让它们继续。 */
  let aborted: string[] = []
  /** 本来闲着、只因任务被停收到宿主的「任务结束」通知才开跑又被中止的会话：它们原来的活已经做完，不能叫它们「继续」。 */
  let woken: string[] = []
  /** 这次重启开始的时刻：只找这之后被中止的轮次里吞掉的消息。 */
  let restartBeganAt: number | undefined

  /** 问宿主「现在退出会不会弹确认框」。旧版插件没有这个命令时返回 undefined（只能按在跑会话判断）。 */
  async function quitBlockers(): Promise<Blockers | undefined> {
    try {
      const res = await run('quit-check', [], {}, 20_000)
      const b = res.data as Partial<Blockers> | undefined
      if (!res.ok || b === undefined || !Array.isArray(b.running) || !Array.isArray(b.queued) || !Array.isArray(b.jobs) || !b.running.every((x) => typeof x === 'string') || !b.queued.every((x) => typeof x === 'string') || !b.jobs.every((x) => typeof x?.id === 'string')) throw new Error(`无法确认退出状态：${res.error?.message ?? '结果格式无效'}。没有获准退出或执行更新`)
      return { ...b, clear: b.running.length === 0 && b.queued.length === 0 && b.jobs.length === 0 } as Blockers
    } catch (error) {
      if (error instanceof Down && noBackend()) return undefined
      throw error
    }
  }

  /**
   * 清掉会让 App 弹退出确认框的东西，返回 undefined 表示清干净了，否则返回卡在哪。
   * 重启一律强制：在跑的会话中止（宿主保留排队消息），后台任务停掉（重启后在原会话重新拉起），
   * 有排队消息但没在跑的会话等它自己开跑或清空，最多 5 秒。
   */
  async function clearQuitBlockers(running: string[], allowQuietNotices = false): Promise<string | undefined> {
    // 退出前那一刻还在跑的子代理：它们会被中止，重启后不会自己接着跑，要告诉派它们的会话。
    const before = await quitBlockers()
    const roots = new Set(running)
    const busyAtStart = new Set([...running, ...(before?.running ?? [])])
    for (const id of before?.running ?? []) {
      const parent = before?.parents?.[id]
      if (!roots.has(id) && parent !== undefined) casualties.push({ id, label: '', owner: parent, kind: 'subagent' })
    }
    // 能接回的监听先让插件记下并暂停：它们一停，App 退出就不会因为它们弹确认框。
    if ((before?.jobs ?? []).some((j) => j.survivable === true)) {
      try {
        const res = await run('restart-prepare', [], {}, 20_000)
        const items = ((res.data as { suspended?: { id: string; label: string; owner: string }[] } | undefined)?.suspended) ?? []
        if (res.ok && items.length > 0) {
          suspended = items
          stamp(`暂停了 ${items.length} 条监听，重启后自动接回：${items.map((i) => `${i.id} ${i.label}`).join('，')}`)
        }
      } catch (error) { stamp(`暂停监听失败：${error instanceof Error ? error.message : String(error)}`) }
    }
    // 自动续跑的目标会在中止后马上开下一轮，先暂停它们，重启后（成没成都算）恢复。
    {
      const active: { session: string; goal: GoalWire }[] = []
      for (const session of running) {
        if (pausedGoals.some((p) => sameSession(p.session, session))) continue
        const goal = await goalOf(session)
        if (goal?.phase === 'active') active.push({ session, goal })
      }
      await pauseGoals(active, (session) => `强制重启：先暂停会话 ${shortId(session)} 的目标，免得中止后它又自动续跑；重启后自动恢复`, '')
    }
    // 中止后又跑起来的会话、没随上级停下的子代理，在等待里接着中止，同一个最多每 2 秒一次。
    const cancelledAt = new Map<string, number>()
    const parents = Object.assign(subagentParents, before?.parents ?? {})
    const cancel = async (ids: readonly string[]): Promise<void> => {
      for (const id of ids) {
        const last = cancelledAt.get(id)
        if (last !== undefined && Date.now() - last < RECANCEL_MS) continue
        cancelledAt.set(id, Date.now())
        try {
          const parent = parents[id]
          const res = parent === undefined
            ? await run('cancel', [id], {}, 20_000)
            : await run('api', ['call', 'subagents/interruptByParent', JSON.stringify({ childSessionId: id, parentSessionId: parent, mode: 'continuable' })], {}, 20_000)
          if (!res.ok) stamp(`中止会话 ${shortId(id)} 被拒：${res.error?.message ?? '未知'}`)
          // 等待途中才看到在跑的子代理，也要告诉派它的会话（开头那批已经记过）。
          // 同主会话：只因名下任务被停、被「任务结束」通知叫醒的子代理不算被打断，名下任务的说明照样送上级。
          else if (parent !== undefined) {
            const wokenByKill = !busyAtStart.has(id) && casualties.some((c) => c.kind === 'job' && sameSession(c.owner, id))
            if (!roots.has(id) && !wokenByKill && !casualties.some((c) => c.kind === 'subagent' && sameSession(c.id, id))) casualties.push({ id, label: '', owner: parent, kind: 'subagent' })
          }
          // 清场途中才开跑的会话也被中止了，同样要让它继续；子代理接不回来，由 casualties 告诉上级。
          // 例外：停任务后宿主会给闲着的主人发「任务结束」并开一轮（tool-jobs 默认唤醒），那不是它在干活，记进 woken 不叫它继续。
          else if (parents[id] === undefined && !busyAtStart.has(id) && !aborted.includes(id) && casualties.some((c) => sameSession(c.owner, id))) {
            if (!woken.includes(id)) { woken.push(id); stamp(`会话 ${shortId(id)} 本来闲着，被停任务的通知叫醒，已中止；重启后不让它继续`) }
          }
          else if (parents[id] === undefined && !aborted.includes(id)) aborted.push(id)
        } catch (error) { stamp(`中止会话 ${shortId(id)} 失败：${error instanceof Error ? error.message : String(error)}`) }
      }
    }
    await cancel([...new Set([...running, ...(before?.running ?? [])])])
    const deadline = Date.now() + QUIT_CLEAR_MS
    let killedJobs = false
    for (;;) {
      const b = await quitBlockers()
      if (b === undefined) return appRunning() ? '无法确认退出状态，' : undefined
      if (b.clear) return undefined
      const quietOnly = allowQuietNotices && b.running.length === 0 && b.jobs.length === 0 && b.queued.length > 0 && b.queued.every((id) => {
        const detail = b.queuedDetails?.find((item) => item.id === id)
        return detail !== undefined && detail.nextTurnCount === 0 && detail.nextStepCount > 0 && detail.nextStepCount === detail.nextStepSources.length && detail.nextStepSources.every((source) => source.form === 'notice' && (source.kind === 'dsh-monitor' || source.kind === 'python-repl-jobs'))
      })
      if (quietOnly) return undefined
      Object.assign(parents, b.parents ?? {})
      await cancel(b.running)
      // 刚暂停的监听正在停（stopping），等它停完就行，不算要强停的任务。
      const paused = new Set(suspended.map((s) => s.id))
      const hard = b.jobs.filter((j) => !paused.has(j.id) && j.survivable !== true)
      if (hard.length > 0 && !killedJobs) {
        let killed: { id: string; cwd?: string }[] = []
        try { killed = ((await run('kill-jobs', hard.map((j) => j.id), {}, 20_000)).data as { killed?: { id: string; cwd?: string }[] } | undefined)?.killed ?? [] } catch { /* 下一轮复查会报出来 */ }
        stamp(`停掉了 ${hard.length} 个后台任务：${hard.map((j) => j.id).join(', ')}`)
        for (const j of hard) {
          const cwd = killed.find((k) => k.id === j.id)?.cwd
          if (j.owner !== undefined) casualties.push({ id: j.id, label: j.label, owner: j.owner, kind: 'job', ...(cwd === undefined ? {} : { cwd }) })
        }
        killedJobs = true
      }
      if (Date.now() >= deadline) {
        return [
          `等了 ${Math.max(1, Math.round(QUIT_CLEAR_MS / 1000))} 秒，退出仍会弹确认框：`,
          b.running.length > 0 ? `${b.running.length} 个会话还在跑；` : '',
          b.queued.length > 0 ? `${b.queued.length} 个会话还有排队消息；` : '',
          b.jobs.length > 0 ? `${b.jobs.length} 个后台任务还在跑；` : '',
        ].join('')
      }
      await sleep(200)
    }
  }

  /** 正在排队的重启进程号；没有、或进程已不在（includeSelf 时连自己也算）就是 undefined。 */
  function lockHolder(includeSelf = false): number | undefined {
    try {
      const pid = Number(readFileSync(RESTART_LOCK, 'utf8').trim())
      if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
      if (pid === process.pid) return includeSelf ? pid : undefined
      process.kill(pid, 0)
      return pid
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM' ? -1 : undefined
    }
  }

  async function detachRestart(options: Record<string, unknown>, notify: string | undefined): Promise<number> {
    const holder = lockHolder()
    if (holder !== undefined) {
      if (options['install-app'] !== undefined) fail('已有重启在排队，这次换 App 没有执行。请等现有重启结束后再升级。', EXIT.usage)
      return joinQueue(holder, notify, typeof options['before'] === 'string' ? options['before'] : undefined, (options['quit-via'] ?? 'apple-event') as QuitStrategy)
    }
    const args = ['restart']
    for (const [key, value] of Object.entries(options)) {
      if (key === 'detach' || key === 'notify') continue
      args.push(value === true ? `--${key}` : `--${key}=${String(value)}`)
    }
    if (notify !== undefined) args.push(`--notify=${notify}`)
    const log = newRestartLog()
    const startedAt = Date.now()
    writeRequest(requestId, { requestId, phase: 'queued', quitVia: options['quit-via'] ?? 'apple-event', startedAt, updatedAt: startedAt, log, message: '已创建后台请求，尚未确认取得执行锁' })
    const childEnv: NodeJS.ProcessEnv = { ...env, DSH_CONTROL_DETACHED: '1', DSH_CONTROL_RESTART_LOG: log, DSH_CONTROL_RESTART_REQUEST_ID: requestId }
    for (const name of SESSION_VARS) delete childEnv[name]
    let pid: number
    try { pid = spawnDetached(args, childEnv, log) } catch (error) {
      writeRequest(requestId, { requestId, phase: 'failed', startedAt, finishedAt: Date.now(), message: String(error) })
      throw error
    }
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      writeRequest(requestId, { requestId, phase: 'failed', startedAt, finishedAt: Date.now(), message: '后台进程未成功启动' })
      fail('后台进程未成功启动，重启没有安排成功', EXIT.error)
    }
    writeFileSync(`${requestPath(requestId)}.pid`, String(pid), { mode: 0o600 })
    if (invocationJson) output({ ok: true, status: 'queued', data: { requestId, pid, startedAt, log, quitVia: options['quit-via'] ?? 'apple-event', scheduled: true } }, true)
    else print([
      `已安排后台重启请求（进程 ${pid}），尚未重启。后台会先检查、取得执行锁，再中止在跑的会话重启；用 dsh-control restart-status 查看阶段。`,
      notify === undefined ? '结束后不通知任何会话。' : `结束后会给会话 ${shortId(notify)} 发消息说明结果。`,
      `过程记在 ${log}。`,
    ].join('\n'))
    return EXIT.ok
  }

  /** 每次重启一份日志，文件名带开始时间；只留最近 KEEP_LOGS 份。 */
  function newRestartLog(): string {
    mkdirSync(RESTART_LOGS, { recursive: true })
    const d = new Date()
    const p = (n: number, w = 2) => String(n).padStart(w, '0')
    const name = `restart-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${process.pid}.log`
    try {
      const old = readdirSync(RESTART_LOGS).filter((f) => /^restart-\d{8}-\d{6}-\d+\.log$/.test(f)).sort()
      for (const f of old.slice(0, Math.max(0, old.length - (KEEP_LOGS - 1)))) {
        rmSync(join(RESTART_LOGS, f), { force: true })
        for (const sidecar of readdirSync(RESTART_LOGS).filter((name) => name.startsWith(`${f}.`) && /^[0-9a-f-]{36}\.before\.(stdout|stderr)\.log$/.test(name.slice(f.length + 1)))) rmSync(join(RESTART_LOGS, sidecar), { force: true })
      }
    } catch { /* 清不掉旧日志不影响重启 */ }
    return join(RESTART_LOGS, name)
  }


  interface Outcome { code: number; interrupted: string[]; reason: string; ms: number }

  /** 跑一次重启，把 fail() 抛出的退出码和原因收回来，不让它直接结束整个命令。 */
  async function attempt(go: () => Promise<{ code: number; interrupted: string[] }>): Promise<Outcome> {
    const began = Date.now()
    lastFailure = ''
    suspended = []
    casualties = []
    aborted = []
    woken = []
    restartBeganAt = began
    let outcome: Outcome
    try {
      const r = await go()
      outcome = { ...r, reason: lastFailure, ms: Date.now() - began }
    } catch (error) {
      const reason = error instanceof CliExit ? lastFailure : error instanceof Error ? error.message : String(error)
      outcome = { code: error instanceof CliExit ? error.code : EXIT.error, interrupted: [], reason, ms: Date.now() - began }
    }
    // 暂停了监听、却没退出成：DSH 还是原来那个进程，不会有新进程去接回，现在就接回来。
    if (outcome.code !== EXIT.ok && suspended.length > 0) {
      try {
        const res = await run('restart-abort', [], {}, 90_000)
        const restored = res.data as { revived?: string[]; failed?: { id: string; error: string }[] } | undefined
        const failed = restored?.failed ?? []
        stamp(res.ok && failed.length === 0 && restored?.revived?.length === suspended.length ? `这次没重启，已把暂停的 ${suspended.length} 条监听接回` : `这次没重启，监听恢复未全部确认：${failed.map((x) => `${x.id} ${x.error}`).join('；') || res.error?.message || '返回结果不完整'}。暂停记录保留，可重试`)
      } catch (error) { stamp(`这次没重启，接回暂停的监听失败：${error instanceof Error ? error.message : String(error)}`) }
      suspended = []
    }
    return outcome
  }

  /** App 在、后台不在。刚打开的 App 也有一两秒还没起后台，隔一会儿再看一次，免得把正在启动的 App 当成崩了。 */
  async function backendCrashed(): Promise<boolean> {
    if (!appRunning() || app.backendRunning(APP, HOME)) return false
    await sleep(2000)
    return appRunning() && !app.backendRunning(APP, HOME)
  }

  async function restartNow(options: Record<string, unknown>): Promise<{ code: number; interrupted: string[] }> {
    // 带 --before：命令在会话都中止之后、退出之前跑。它常常就是来修检查问题的，所以这里不过先不放弃，跑完再查。
    const pendingBefore = typeof options['before'] === 'string' ? options['before'] : undefined
    if (!(await preflightOnce())) {
      if (pendingBefore === undefined) { lastFailure ||= '启动前离线检查没通过'; return { code: EXIT.error, interrupted: [] } }
      stamp('离线检查现在没通过；中止会话、跑完重启前的命令后再查，仍不通过就不重启')
    }
    const runningNow = async (): Promise<string[]> => {
      const res = await run('health', [], {}, 20_000)
      const data = res.data as { running?: unknown } | undefined
      if (!res.ok || !Array.isArray(data?.running) || !data.running.every((x) => typeof x === 'string')) throw new Error('运行状态查询失败或结果格式无效')
      return data.running as string[]
    }
    let running: string[] = []
    try {
      running = await runningNow()
    } catch {
      // health 走宿主会话接口，旧插件在新宿主上可能答不了（2026-10-17 升 0.2.1：缺调用身份）；退出状态另一条路，能答就用它。
      // 两条都不通而后台还在，多半是插件正在热重载，等通信口回来再下结论。
      let blockers: Blockers | undefined
      let recovered: string[] | undefined
      const until = Date.now() + RELOAD_GRACE_MS
      for (;;) {
        try { blockers = await quitBlockers() } catch { blockers = undefined }
        if (blockers !== undefined || Date.now() >= until || !appRunning() || !app.backendRunning(APP, HOME)) break
        await sleep(500)
        try { recovered = await runningNow(); break } catch { /* 还在重载 */ }
      }
      if (recovered !== undefined) running = recovered
      else if (blockers !== undefined) running = blockers.running
      else if (await backendCrashed()) {
        if (pendingBefore !== undefined) {
          lastFailure = 'DSH 后台已停止，无法按要求执行重启前更新；更新命令未执行，本次没有重启'
          stamp(lastFailure)
          failureDetail = { stage: 'before', executed: false, reason: lastFailure }
          return { code: EXIT.error, interrupted: [] }
        }
        // 崩溃窗口挡住普通退出（AppleEvent 返回「用户已取消」，SIGTERM 也不理），只能结束进程；后台已经没了，没有会话会被打断。
        stamp('DSH 后台已经停了（多半停在崩溃窗口上），不会有会话在跑；直接结束 App 再拉起')
        return { code: await kill(), interrupted: [] }
      }
      else if (appRunning()) fail(`DSH 在运行，但通信口 ${Math.round(RELOAD_GRACE_MS / 1000)} 秒都没答话，无法确认有没有会话在跑，所以没有重启：硬重启会让在跑的会话收不到「继续」。先跑 dsh-control doctor 看 dsh-control 插件有没有加载；插件正常而通信口一直不回来，只能在 DSH 菜单里手动退出再打开。`, EXIT.error)
    }
    if (running.length > 0) print(`重启会打断 ${running.length} 个在跑的会话，已记下，重启后让它们继续：${running.map(shortId).join(', ')}`)
    // 正常退出走不通（清不干净、退出命令失败、30 秒没退）就结束进程再拉起，不报失败（用户 2026-10-27 同意）。
    const forceKill = async (why: string): Promise<{ code: number; interrupted: string[] }> => {
      stamp(`${why}；这是强制重启，改为结束 DSH 进程再拉起`)
      try {
        const identity = (await http('GET', '/v1/health', undefined, 5000)).json as { pid?: number; startedAt?: number }
        if (Number.isSafeInteger(identity.pid) && typeof identity.startedAt === 'number') previousInstance = `${identity.pid}:${identity.startedAt}`
      } catch { /* 通信口不答话也照样结束进程 */ }
      recordRestart('quitting', { message: `${why}，正在结束旧进程，尚未完成`, previousInstance })
      return { code: await kill(), interrupted: running }
    }
    if (options['kill'] === true) {
      const identity = (await http('GET', '/v1/health', undefined, 5000)).json as { pid?: number; startedAt?: number }
      previousInstance = `${identity.pid}:${identity.startedAt}`
      return { code: await kill(), interrupted: running }
    }
    // App 退出前会问宿主「还有没有活」（会话在跑、有排队消息、后台任务在跑），有就弹确认框，远程没人能点。
    // 所以先清：中止在跑的会话、停掉后台任务，再确认宿主说「没活了」才退出；清不干净就不退出，不留一个没人点的框。
    if (appRunning()) {
      const blocked = await clearQuitBlockers(running, pendingBefore !== undefined)
      if (blocked !== undefined) {
        if (pendingBefore !== undefined) {
          lastFailure = `${blocked}重启前更新命令未执行，本次没有重启`
          stamp(lastFailure)
          failureDetail = { stage: 'before', executed: false, reason: lastFailure }
          return { code: EXIT.error, interrupted: running }
        }
        return forceKill(blocked.replace(/[，；。]$/, ''))
      }
    }
    if (pendingBefore !== undefined) {
      const failed = await runBefore(pendingBefore)
      if (failed !== undefined) { lastFailure = failed; return { code: EXIT.error, interrupted: running } }
      if (!(await preflightOnce())) { lastFailure ||= '启动前离线检查没通过'; return { code: EXIT.error, interrupted: running } }
      if (appRunning()) {
        // 写 profile 会热重载插件，通信口要过一两秒才回来；回来后把这期间又开跑的也中止掉。
        await reloadSettled()
        const again = await clearQuitBlockers([])
        if (again !== undefined) return forceKill(again.replace(/[，；。]$/, ''))
      }
    }
    if (appRunning()) {
      // 0.2.1 起挂着定时提醒也会弹框（「应用关闭期间，定时任务不会运行」）。提醒没有暂停接口、等不掉，但关机期间到点的开机后补发，点「退出」没有损失。
      const now = await quitBlockers()
      const holds = now?.scheduled ?? []
      // 屏幕锁着就点不到提醒框，普通退出只会干等 30 秒。只剩提醒挡着时用户同意改为结束进程（2026-10-22）：提醒存在磁盘上，关着时到点的开机后补发。
      if (holds.length > 0 && app.screenLocked()) {
        if (now === undefined || !now.clear) return forceKill(`屏幕锁着，退出框点不到，此刻${now === undefined ? '查不到退出状态' : `还有${blockerText(now)}`}`)
        stamp(`${scheduledText(holds)}。屏幕锁着，退出时弹的「应用关闭期间，定时任务不会运行」点不到；此刻没有会话在跑，改为结束进程再拉起，提醒不会丢`)
        const identity = (await http('GET', '/v1/health', undefined, 5000)).json as { pid?: number; startedAt?: number }
        previousInstance = `${identity.pid}:${identity.startedAt}`
        recordRestart('quitting', { message: '屏幕锁着、只剩定时提醒挡着，正在结束旧进程，尚未完成', previousInstance })
        return { code: await kill(), interrupted: running }
      }
      if (holds.length > 0) stamp(`${scheduledText(holds)}。退出时会弹「应用关闭期间，定时任务不会运行」，确认此刻没有会话在跑后替你点「退出」；提醒不会丢，关着的时候到点的开机后补发`)
    }
    if (appRunning()) {
      const identity = (await http('GET', '/v1/health', undefined, 5000)).json as { pid?: number; startedAt?: number }
      previousInstance = `${identity.pid}:${identity.startedAt}`
      recordRestart('quitting', { message: '正在退出旧实例，尚未完成', previousInstance })
      print('正在退出 DSH……')
      const quitVia = (options['quit-via'] ?? 'apple-event') as QuitStrategy
      const quit = app.quit(quitVia, APP, env)
      if (quit.status !== 0 || quit.error) {
        const details = { via: quitVia, stage: quit.stage ?? quitVia, status: quit.status, signal: quit.signal ?? null, code: (quit.error as NodeJS.ErrnoException | undefined)?.code ?? null, error: quit.error?.message ?? null, stderr: quit.stderr, stdout: quit.stdout ?? '' }
        stamp(`退出命令未确认成功 ${JSON.stringify(details)}`)
        return forceKill('正常退出没走通')
      }
      const deadline = Date.now() + QUIT_WAIT_MS
      const settledAt = Date.now() + 1000
      let dialog: string | undefined
      let nextTry = 0
      while (appRunning() && Date.now() < deadline) {
        // 退出框只说定时提醒时替用户点「退出」。框里的字在弹出那一刻定死，之后有会话开跑也不会变，所以点之前再问一次宿主。
        if (dialog === undefined && Date.now() >= settledAt && Date.now() >= nextTry) {
          nextTry = Date.now() + 1000
          let now: Blockers | undefined
          try { now = await quitBlockers() } catch { now = undefined }
          if (now?.clear === true) {
            const result = app.confirmScheduledQuit(env)
            if (result === 'clicked') { dialog = result; stamp('退出框只说定时提醒，已替你点「退出」') }
            else if (result.startsWith('other:') || result.startsWith('error:')) { dialog = result; stamp(`没有替你点退出框：${result}`) }
          }
        }
        await sleep(200)
      }
      if (appRunning()) {
        // 记下这一刻的真实阻碍，失败记录不能沿用排队时的旧状态。
        let now: Blockers | undefined
        try { now = await quitBlockers() } catch { now = undefined }
        quitTimeBlockers = now ?? {}
        const seen = now === undefined ? '' : [blockerText(now), (now.scheduled ?? []).length > 0 ? scheduledText(now.scheduled!) : ''].filter((s) => s !== '').join('；')
        return forceKill(`DSH ${Math.round(QUIT_WAIT_MS / 1000)} 秒内没退出${app.screenLocked() ? '（屏幕锁着，退出框点不到）' : ''}${seen === '' ? '' : `，退出时的状态：${seen}`}${dialog === undefined ? '' : `，退出框处理结果：${dialog}`}`)
      }
    }
    return { code: await start(true), interrupted: running }
  }

  /** 重启结束后：成功就让被打断的会话继续；不论成败都通知 notify 指定的会话。 */
  async function finish(outcome: Outcome, notify: string | undefined, waitedMs: number): Promise<number> {
    const seconds = (ms: number) => Math.round(ms / 1000)
    if (outcome.code !== EXIT.ok) {
      const reason = outcome.reason || `退出码 ${outcome.code}`
      recordRestart('failed', { message: reason, exitCode: outcome.code, failedStage: failureDetail?.stage ?? restartState.phase, failure: failureDetail, finishedAt: Date.now(), blockers: quitTimeBlockers })
      waiterNote = { text: `DSH did not restart: ${reason}. ${logHint()}Tell the user why.`, summary: 'DSH restart failed' }
      // 强制重启可能已经中止了会话、停了任务才失败：同样让它们继续，不能因为没重启成就把它们晾在那。
      const affected = await resumeAffected([], notify)
      const delivered = await tell(notify, [
        `DSH did not restart: ${reason}. ${logHint()}`,
        affected.self ? 'This turn was interrupted before the restart (not by the user); first see where it stopped. If an operation would change something, verify whether it already took effect, then continue.' : '',
        affected.resumed.length > 0 ? `${affected.resumed.length} session(s) had been interrupted before the restart and were told to continue: ${affected.resumed.map(shortId).join(', ')}.` : '',
        affected.failed.length > 0 ? `${affected.failed.length} other interrupted session(s) could not be told to continue: ${affected.failed.map(shortId).join(', ')}; tell the user.` : '',
        affected.selfLost,
        'Tell the user why.',
      ].join(' '), 'DSH restart failed')
      recordRestart('failed', { notification: notify === undefined ? 'not-requested' : delivered ? 'scheduled' : notificationState })
      return outcome.code
    }
    recordRestart('completed', { message: '旧实例已退出，新实例及会话服务已就绪；功能是否生效仍需验收', finishedAt: Date.now() })
    waiterNote = {
      text: `DSH restarted successfully (your restart request was folded into the restart that was already queued). ${logHint()}Confirm that the change you wanted is in effect, then report to the user.`,
      summary: 'DSH restarted successfully',
    }
    const { resumed, failed, self, selfLost } = await resumeAffected(outcome.interrupted, notify)
    stamp(`DSH 已重启完成${resumed.length + failed.length > 0 ? `；让 ${resumed.length} 个被打断的会话继续${failed.length > 0 ? `，${failed.length} 个没发出去：${failed.map(shortId).join(', ')}` : ''}` : ''}`)
    if (suspended.length > 0) stamp(`暂停的 ${suspended.length} 条监听由 dsh-monitor 在新进程里接回，并各自通知所属会话`)
    const delivered = await tell(notify, [
      `DSH restarted successfully (${waitedMs > 0 ? `${seconds(waitedMs)}s waiting for idle, ` : ''}restart took ${seconds(outcome.ms)}s). ${logHint()}`,
      self ? 'This turn was also interrupted by the restart (not by the user); first see where it stopped. If an operation would change something, verify whether it already took effect, then continue.' : '',
      resumed.length > 0 ? `${resumed.length} running session(s) were interrupted during the restart and were told to continue: ${resumed.map(shortId).join(', ')}.` : '',
      failed.length > 0 ? `${failed.length} other interrupted session(s) could not be told to continue: ${failed.map(shortId).join(', ')}; tell the user.` : '',
      suspended.length > 0 ? `${suspended.length} open monitor(s) (${suspended.map((s) => s.label || s.id).join(', ')}) were paused before the restart; they will be relaunched automatically in the new process and their sessions will receive the new ids.` : '',
      selfLost,
      'Confirm that the change you wanted is in effect, then report to the user.',
    ].join(' '), 'DSH restarted successfully')
    recordRestart('completed', { notification: notify === undefined ? 'not-requested' : delivered ? 'scheduled' : notificationState })
    return EXIT.ok
  }

  /**
   * 重启后收尾。会话和后台任务分开处理：
   * - 被中止的会话（重启时在跑的，加上清场途中才开跑又被中止的）逐个发「继续」。只因任务被停才被叫醒的闲会话不算。
   * - 被停的 bash 后台任务，查到了启动目录就在原会话里用原命令重新拉起；主人闲着时只放一条不唤醒的说明。
   * - 被中止的子代理算上级会话没做完的活：上级闲着（在等它的结果）也唤醒，让它决定接着派还是自己做。
   * 发起的会话不单独发，返回给调用方并进它那一条结果里。
   */
  async function resumeAffected(interrupted: string[], notify: string | undefined): Promise<{ resumed: string[]; failed: string[]; self: boolean; selfLost: string }> {
    const relaunched = new Map<string, string>()
    const unlaunched = new Map<string, string>()
    for (const c of casualties) {
      if (c.kind !== 'job') continue
      if (c.cwd === undefined) { unlaunched.set(c.id, '查不到它启动时的目录'); continue }
      try {
        const res = await run('monitor', [c.owner], { command: c.label, cwd: c.cwd, label: c.label, restart: 'never', quiet: true }, 90_000)
        const id = (res.data as { id?: unknown } | undefined)?.id
        if (res.ok && typeof id === 'string') relaunched.set(c.id, id)
        else unlaunched.set(c.id, res.error?.message ?? '没确认拉起')
      } catch (error) { unlaunched.set(c.id, error instanceof Error ? error.message : String(error)) }
    }
    if (relaunched.size > 0) stamp(`在原会话里重新拉起了 ${relaunched.size} 个后台任务：${[...relaunched].map(([from, to]) => `${from} → ${to}`).join('，')}`)
    if (unlaunched.size > 0) stamp(`${unlaunched.size} 个后台任务没拉起：${[...unlaunched].map(([id, why]) => `${id}（${why}）`).join('，')}`)
    const all = [...new Set([...interrupted, ...aborted])]
    const isNotify = (id: string) => notify !== undefined && sameSession(id, notify)
    const others = all.filter((id) => !isNotify(id))
    // 中止会吞掉「宿主刚从排队区取走、还没写进记录」的用户消息，先原样放回去。
    // 被中止的只有被吞消息开启的那一轮时，放回去它自己会重跑这一轮，不再另发「继续」；还有别的轮次被中止就照发。
    const requeued: string[] = []
    const openers = new Set<string>()
    const unanswered = new Map<string, string>()
    for (const id of restartBeganAt === undefined ? [] : all) {
      try {
        const res = await run('requeue-lost', [id], { since: String(restartBeganAt) }, 30_000)
        if (!res.ok) { stamp(`查会话 ${shortId(id)} 有没有被吞掉的消息失败：${res.error?.message ?? '未知'}`); continue }
        const data = res.data as { restored?: { target?: string; preview?: string }[]; otherAborted?: boolean; interruptedUser?: { text?: string } } | undefined
        const said = data?.interruptedUser?.text
        if (typeof said === 'string' && said !== '') unanswered.set(shortId(id), said)
        const items = data?.restored ?? []
        if (items.length === 0) continue
        stamp(`会话 ${shortId(id)} 有 ${items.length} 条刚发出的消息被中止吞掉，已原样放回排队区：${items.map((i) => i.preview ?? '').join(' / ')}`)
        requeued.push(`${shortId(id)} (${items.length} message(s))`)
        if (data?.otherAborted !== true && items.some((i) => i.target === 'next-turn')) openers.add(shortId(id))
      } catch (error) { stamp(`查会话 ${shortId(id)} 有没有被吞掉的消息失败：${error instanceof Error ? error.message : String(error)}`) }
    }
    // 同一个会话只发一条：「接着做」、它的任务说明、它登记过的重启结果并成一段，不连发几条。
    const waiting = new Set(peekWaiters().filter((id) => !isNotify(id)).map(shortId))
    const messages = new Map<string, { id: string; texts: string[]; summary: string }>()
    const add = (id: string, text: string, summary: string) => {
      const m = messages.get(shortId(id))
      if (m === undefined) messages.set(shortId(id), { id, texts: [text], summary })
      else m.texts.push(text)
    }
    for (const id of others) {
      if (openers.has(shortId(id))) continue
      const said = unanswered.get(shortId(id))
      if (said === undefined) add(id, RESUME_TEXT, RESUME_SUMMARY)
      else add(id, resumeForUser(said), RESUME_USER_SUMMARY)
    }
    const byOwner = new Map<string, Casualty[]>()
    const parentOf = (id: string): string | undefined => Object.entries(subagentParents).find(([child]) => sameSession(child, id))?.[1]
    for (const c of casualties) {
      const owner = c.kind === 'job' ? parentOf(c.owner) ?? c.owner : c.owner
      byOwner.set(owner, [...(byOwner.get(owner) ?? []), c])
    }
    let selfLost = ''
    const quiet: string[] = []
    for (const [owner, lost] of byOwner) {
      const text = lostText(lost, relaunched, unlaunched, owner)
      if (isNotify(owner)) { selfLost = text; continue }
      if (all.some((id) => sameSession(id, owner)) || lost.some((c) => c.kind === 'subagent') || waiting.has(shortId(owner))) {
        add(owner, text, `Restart stopped ${lost.length} of your background jobs or subagents`)
        continue
      }
      // 只留着后台任务的闲会话（比如做完活开着预览服务）：不唤醒，唤醒了它会当成要接着干。
      let why = ''
      try {
        const r = await run('notice', [owner, text], { summary: `Restart stopped and relaunched ${lost.length} of your background jobs`, quiet: true }, 30_000)
        if (!r.ok) why = r.error?.message ?? '未知原因'
      } catch (error) { why = error instanceof Error ? error.message : String(error) }
      if (why !== '') stamp(`给 ${shortId(owner)} 放说明失败：${why}`)
      quiet.push(`${shortId(owner)}: ${lost.map((c) => relaunched.has(c.id) ? `${c.label} (new id ${relaunched.get(c.id)})` : `${c.label} (not relaunched: ${unlaunched.get(c.id) ?? 'unknown'})`).join(', ')}${why === '' ? '' : ` [notice not delivered: ${why}]`}`)
    }
    const resumed: string[] = []
    for (const [key, m] of messages) {
      const waiter = waiting.has(key) && waiterNote !== undefined
      if (waiter) toldWaiters.add(key)
      const ok = await tell(m.id, [...(waiter ? [waiterNote!.text] : []), ...m.texts].join(''), m.summary)
      if (ok && others.some((id) => shortId(id) === key)) resumed.push(m.id)
    }
    for (const id of others) if (openers.has(shortId(id)) && !resumed.some((r) => sameSession(r, id))) resumed.push(id)
    const failed = others.filter((id) => !resumed.some((r) => sameSession(r, id)))
    const requeuedText = requeued.length > 0 ? `User messages that were swallowed when the turn was interrupted have been put back in the original session's queue: ${requeued.join(', ')}. ` : ''
    const quietText = quiet.length > 0 ? `Background jobs left by idle sessions before the restart were handled in their original sessions without waking them: ${quiet.join('; ')}. Tell the user about any that were not relaunched or whose notices could not be delivered. ` : ''
    return { resumed, failed, self: notify !== undefined && all.some((id) => sameSession(id, notify)), selfLost: `${selfLost}${quietText}${requeuedText}` }
  }

  /** 给派出后台任务或子代理的会话的说明：哪些已经重新拉起、哪些停了不会再来。 */
  function lostText(lost: Casualty[], relaunched: ReadonlyMap<string, string>, unlaunched: ReadonlyMap<string, string>, owner: string): string {
    const via = (j: Casualty) => j.kind === 'job' && !sameSession(j.owner, owner) ? ` (owned by subagent ${shortId(j.owner)})` : ''
    const back = lost.filter((c) => c.kind === 'job' && relaunched.has(c.id))
    const gone = lost.filter((c) => c.kind === 'job' && !relaunched.has(c.id))
    const subs = lost.filter((c) => c.kind === 'subagent')
    return [
      'To restart DSH, the system stopped some work just now (not stopped by the user). ',
      back.length > 0 ? `Your background job(s) ${back.map((j) => `${j.id}${via(j)} (${j.label})`).join(', ')} were relaunched in the original directory with the original command; new ids: ${back.map((j) => relaunched.get(j.id)).join(', ')}. The old ids are invalid. Output between the stop and the relaunch was not received. New job output is not pushed to you; use monitor_output or job_output with the new ids when you need it. Do not relaunch them yourself. ` : '',
      gone.length > 0 ? `Your background job(s) ${gone.map((j) => `${j.id}${via(j)} (${j.label}, ${unlaunched.get(j.id) ?? 'not relaunched'})`).join(', ')} were stopped and could not be relaunched; their results and completion notices will not arrive. ` : '',
      subs.length > 0 ? `Your subagent(s) ${subs.map((s) => shortId(s.id)).join(', ')} were interrupted during the restart; their results will not arrive. Use send_message to let them continue, or start them again. ` : '',
      gone.length > 0 || subs.length > 0 ? 'If you still need their results, first check how far they got (verify operations that change things before redoing them), then decide whether to redo them; if you do not need them, ignore this.' : '',
    ].join('')
  }

  function logHint(): string {
    return restartLog() !== '' ? `Log: ${restartLog()}. ` : ''
  }

  /**
   * 给会话送一段话：先用插件通知（界面一行通知，模型知道不是用户说的），宿主不支持通知时退回普通消息。
   * DSH 刚起来时会话服务可能还没好，没送进去就隔 300 毫秒再试，最多试 30 秒。返回送没送进去。
   */
  async function tell(session: string | undefined, text: string, summary: string): Promise<boolean> {
    if (session === undefined) return false
    let viaSend = false
    notificationState = 'failed'
    const deadline = Date.now() + 30_000
    for (;;) {
      try {
        const res = viaSend
          ? await run('send', [session, text], {}, 30_000)
          : await run('notice', [session, text], { summary }, 30_000)
        if (res.ok) {
          const receipt = res.data as { scheduled?: boolean } | undefined
          let scheduled = receipt?.scheduled === true
          if (!scheduled) {
            // 旧通知回执只证明已记录；只读查询，不重发可能已经接收的消息。
            try {
              const state = await run('status', [session], {}, 5000)
              scheduled = state.ok && (state.data as { running?: boolean } | undefined)?.running === true
            } catch { /* 无法确认调度，保留未确认状态。 */ }
          }
          notificationState = scheduled ? 'scheduled' : 'recorded-unconfirmed'
          stamp(scheduled ? `已给会话 ${shortId(session)} 送${viaSend ? '消息' : '通知'}并确认已安排执行；尚未确认模型回复` : `会话 ${shortId(session)} 的消息已记录，但未确认安排执行；不会重复发送`)
          return scheduled
        }
        const code = res.error?.code ?? ''
        if (code === 'notice-wakeup-unconfirmed') {
          notificationState = 'recorded-unconfirmed'
          stamp(`会话 ${shortId(session)} 的通知已记录，但未确认安排执行；不会重复发送`)
          return false
        }
        // 旧版插件没有 notice 命令（报「没有命令」），或宿主拿不到会话控制器：都退回普通消息。
        if (!viaSend && (code === 'notice-unsupported' || /没有命令 "notice"/.test(res.error?.message ?? ''))) { viaSend = true; continue }
        // 刚起来时会话服务还没注册，接口报 service-unavailable：这是暂时的，接着试。
        if (res.httpStatus === 400 && !/unavailable/.test(`${code} ${res.error?.message ?? ''}`)) {
          stamp(`给会话 ${shortId(session)} 送消息被拒：${res.error?.message ?? '未知'}`)
          return false
        }
        if (Date.now() >= deadline) { stamp(`给会话 ${shortId(session)} 送消息一直不成：${res.error?.message ?? '未知'}`); return false }
      } catch (error) {
        if (Date.now() >= deadline) { stamp(`给会话 ${shortId(session)} 送消息失败：${error instanceof Error ? error.message : String(error)}`); return false }
      }
      await sleep(300)
    }
  }



  async function kill(): Promise<number> {
    await stopApp()
    return start(true)
  }

  async function stopApp(): Promise<void> {
    app.kill('TERM')
    const deadline = Date.now() + Number(env['DSH_CONTROL_EXIT_TIMEOUT_MS'] ?? 20_000)
    while (appRunning() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000))
    if (appRunning()) app.kill('KILL')
    const killedDeadline = Date.now() + Number(env['DSH_CONTROL_EXIT_TIMEOUT_MS'] ?? 20_000)
    while (appRunning() && Date.now() < killedDeadline) await sleep(200)
    if (appRunning()) fail('旧 DSH 进程仍在，未确认退出，不会把旧通信口当作重启成功', EXIT.error)
  }

  /** 前置命令写了 profile 会热重载插件，通信口要过一两秒才回来；等它答话，最多 RELOAD_GRACE_MS。 */
  async function reloadSettled(): Promise<void> {
    const until = Date.now() + RELOAD_GRACE_MS
    for (;;) {
      try { await quitBlockers(); return } catch { /* 还在重载 */ }
      if (Date.now() >= until || !appRunning()) return
      await sleep(500)
    }
  }

  /** 全局配置、凭据和 link 产物都参与检查，退出前必须重查，不缓存顶层时间。 */
  async function preflightOnce(): Promise<boolean> {
    recordRestart('checking', { message: '重新检查实际配置和插件产物，尚未退出' })
    return preflight()
  }

  async function preflight(): Promise<boolean> {
    const report = await offlineDoctor({ home: HOME, app: installApp ?? APP, repairCredentials: true })
    print(reportText(installApp === undefined ? '启动前离线检查：' : `启动前离线检查（用要换上的 ${installApp}）：`, report))
    if (!report.ok) {
      const collector = new FailureReasonCollector()
      collector.push(JSON.stringify(report))
      const reason = collector.reason() || '启动前离线检查没通过'
      lastFailure = `启动前离线检查没通过：${reason}`
      failureDetail = { stage: 'preflight', reason, checks: report.checks.filter((check) => !check.ok) }
      print('拒绝启动：请按上面的修复方法处理，全部通过后再运行。')
    } else if (failureDetail?.stage === 'preflight') {
      failureDetail = undefined
      lastFailure = ''
    }
    return report.ok
  }

  async function doctor(options: Record<string, unknown>, asJson: boolean): Promise<number> {
    const timeoutMs = options['timeout-ms'] === undefined ? undefined : Number(options['timeout-ms'])
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) fail('--timeout-ms 必须是正数', EXIT.usage)
    const profile = typeof options['profile'] === 'string' ? options['profile'] : 'desktop'
    const offline = await offlineDoctor({ home: HOME, app: APP, profile, full: options['full'] === true, ...(timeoutMs === undefined ? {} : { timeoutMs }) })
    let running = appRunning()
    try {
      const res = await http('GET', '/v1/health', undefined, 5000)
      if ((res.json as { ok?: boolean }).ok === true) running = true
    } catch { /* 在线时以下检查会报通信错误；离线时不要求通信口 */ }
    const result = await layeredDoctor(offline, running, async () => {
      const checks: Report['checks'] = []
      let unverified: unknown[] = []
      try {
        const health = await http('GET', '/v1/health', undefined, 5000)
        const ok = health.status === 200 && (health.json as { ok?: boolean }).ok === true
        checks.push({ id: 'socket', ok, message: ok ? `通信口正常：${SOCKET}` : `通信口返回异常：HTTP ${health.status}`, fix: '检查 dsh-control 插件是否加载，是否进入了恢复模式。' })
        if (ok) {
          const res = await run('api', ['call', 'doctor/getReport', JSON.stringify({ options: { profile, full: false, ...(timeoutMs === undefined ? {} : { timeoutMs }) } })], {}, (timeoutMs ?? 120_000) + 30_000)
          const report = res.data as Report | undefined
          const toolOk = res.ok && report?.ok === true && Array.isArray(report.checks)
          checks.push({ id: 'doctor-tool', ok: toolOk, message: toolOk ? '已通过 DSH 调用已注册的 doctor 工具，检查全部通过。' : `doctor 工具未通过：${res.error?.message ?? res.text ?? '没有有效检查结果'}`, fix: '确认 doctor 工具已注册且启用；按工具结果修复后重查。' })
          if (report && Array.isArray(report.checks)) checks.push(...report.checks)
          if (Array.isArray(report?.['unverified'])) unverified = report['unverified']
        }
      } catch (error) { checks.push({ id: 'online', ok: false, message: error instanceof Error ? error.message : String(error), fix: '检查通信口和 doctor 插件的加载错误，修好再检查。' }) }
      return { ok: checks.length > 0 && checks.every((c) => c.ok), checks, unverified }
    })
    if (asJson) print(JSON.stringify(result, null, 2))
    else {
      print(reportText('离线检查：', result.offline))
      print(result.online ? reportText('在线检查：', result.online) : '在线检查：DSH 未运行，不需要检查。')
      print(result.ok ? 'ok：全部检查通过。' : '未放行：仍有失败项，修好后必须重新检查。')
    }
    return result.ok ? EXIT.ok : EXIT.error
  }

  /**
   * upgrade：按更新源升级 App。先下载、校验、用新版 App 对实际配置跑离线检查，全过才交给 restart --install-app，
   * 由重启流程在旧 App 退出后替换、拉起；新版拉不起来就换回旧版；新版就绪后旧版和下载文件一并删掉。
   */
  async function upgrade(options: Record<string, unknown>): Promise<number> {
    const feed = typeof options['feed'] === 'string' ? options['feed'] : DEFAULT_FEED
    const entry = fetchFeed(feed)
    const current = existsSync(APP) ? appVersion(APP) : ''
    print(`本机 ${current || '未安装'}，更新源最新 ${entry.version}${entry.releaseDate ? `（${entry.releaseDate} 发布）` : ''}`)
    if (entry.version === current && options['force'] !== true) { print('已是最新，不用升级'); return EXIT.ok }
    const staged = await stageRelease(entry, { dir: UPGRADE_DIR, installed: APP, print })
    installApp = staged
    let ok: boolean
    try { ok = await preflight() } finally { installApp = undefined }
    if (!ok) return EXIT.error
    if (options['check'] === true) { print(`新版已备好，用它对实际配置的离线检查通过；按 --check 没有替换：${staged}`); return EXIT.ok }
    const pass: Record<string, unknown> = { 'install-app': staged }
    for (const key of ['detach', 'notify', 'quit-via', 'before']) if (options[key] !== undefined) pass[key] = options[key]
    return restart(pass)
  }

  interface HelpEntry { name: string; summary: string; usage: string; writes: boolean }

  /** 命令行自己实现、不经过插件命令表的命令。 */
  const LOCAL: HelpEntry[] = [
    { name: 'chat', summary: '发消息并等它跑完（send + wait 一步做完），退出码同 wait；--settled 等到真做完（同 wait --settled），--notify 同 send', usage: 'chat <会话> <消息> [--now|--interrupt] [--tier normal|fast] [--model provider/model] [--effort 档位] [--settled] [--notify <会话>|self] [--timeout 秒，默认 1800]', writes: true },
    { name: 'start', summary: '确保 DSH 在运行：已在运行直接返回；没在运行就先做离线检查再拉起来，等通信口就绪。在远程登录里运行也会用桌面会话的环境打开', usage: 'start', writes: true },
    { name: 'restart', summary: '强制重启：先离线检查，再中止在跑的会话、停掉后台任务和子代理、退出再拉起；正常退出没走成就结束进程再拉起，不会因为「退不出」失败。不论重启成没成，都给被中止的会话发消息让它们接着做，给任务的主人说明停掉了什么，被停的任务在原会话重新拉起。一律强制，没有等空闲、也不需要 --force。--detach 转到后台独立进程（DSH 会话里自动带上，否则 DSH 一退出命令就没了）；--notify 结束后给这个会话发结果（带 --detach 时默认通知发起的会话）；--before <命令> 在会话都中止后、退出前跑（写 profile、装依赖用），失败就不重启；--kill 直接结束进程再拉起，不先试正常退出；--quit-via apple-event|menu 显式选择普通退出入口，默认 apple-event；menu 要求本机 computer-control 协议并只点普通退出项，绝不换路线或点确认；--install-app <App 路径> 在旧 App 退出后、拉起前换成这一份（upgrade 用），新版拉不起来自动换回旧版；--background 不受支持', usage: 'restart [--before <命令>] [--detach] [--notify <会话>] [--kill] [--quit-via apple-event|menu] [--install-app <App 路径>]', writes: true },
    { name: 'upgrade', summary: `升级 DSH App：读更新源（默认 ${DEFAULT_FEED}），下载、校验大小和 sha512、核对签名公证和开发者，用新版 App 对实际配置跑离线检查，全过才走 restart：旧 App 退出后才替换，新版拉不起来自动换回旧版，新版就绪后删掉旧版。已是最新直接退出 0。--check 只备好并检查、不替换；--force 同版本也重装；--before、--detach、--notify、--quit-via 同 restart（--before 在换 App 之前、会话都中止后跑）。下载和换下来的旧版暂放在 ~/.local/state/dsh-control/app-upgrade`, usage: 'upgrade [--feed <清单网址>] [--check] [--force] [--before <命令>] [--detach] [--notify <会话>] [--quit-via apple-event|menu]', writes: true },
    { name: 'restart-watch', summary: '读取本机跨机器重启通知记录，显示远端执行结果和是否送回发起会话；由共享目标入口处理，不连接默认机器', usage: 'restart-watch WATCHID [--json]', writes: false },
    { name: 'restart-status', summary: '读取最近一次重启的真实阶段、阻碍、结果和日志；进程消失但无完成记录不算成功', usage: 'restart-status [--request-id UUID] [--json]', writes: false },
    { name: 'doctor', summary: '离线检查并隔离试启动；运行时还会调用在线 doctor 工具；全部通过才退出 0', usage: 'doctor [--full] [--profile 名字] [--timeout-ms MS]', writes: false },
    { name: 'version', summary: '命令行版本', usage: 'version', writes: false },
    { name: 'help', summary: '列出全部命令，或看一条命令的用法', usage: 'help [命令]', writes: false },
  ]

  const EXIT_HELP = [
    '退出码（没做成你要的事一律非 0）：',
    '  0   成功，或最后一轮成功完成',
    '  1   任务失败或中止；其他错误；DSH 执行了但报告失败（例如装插件失败、拿不到额度报告）',
    '  2   用法错误、找不到会话、对上多个、被规则拦下（只读、禁用、拒绝换模型、整档没有可用模型、回答没被接收）',
    '  10  会话停下来在等你回答（wait、chat、status）',
    '  11  wait/chat：会话空闲，起点之后没有新内容，再等也不会有结果',
    '  69  DSH 没在运行（或远程控制插件没加载）',
    '  124 wait/chat 等到 --timeout 还没有结果（会话在跑或还有排队消息），输出里写着真实状态',
  ]

  function entryLines(c: HelpEntry): string {
    return `  ${c.usage}\n      ${c.summary}${c.writes ? '（会改东西）' : ''}`
  }

  async function help(topic?: string): Promise<number> {
    let remote: HelpEntry[] | undefined
    try {
      const { json } = await http('GET', '/v1/commands', undefined, 5000)
      const list = (json as { commands?: HelpEntry[] }).commands
      if (Array.isArray(list)) remote = list
    } catch { /* DSH 没在运行：用命令行自带的命令表 */ }
    const commands = remote ?? COMMANDS
    if (topic !== undefined) {
      const c = [...commands, ...LOCAL].find((x) => x.name === topic)
      if (c === undefined) fail(`没有命令 "${topic}"。dsh-control help 看全部`, EXIT.usage)
      print(`dsh-control ${c.usage}\n  ${c.summary}${c.writes ? '（会改东西）' : ''}${remote === undefined && !LOCAL.includes(c) ? '\n  （DSH 没在运行，这是命令行自带的说明）' : ''}`)
      return EXIT.ok
    }
    print([
      '用法：dsh-control [-H 昵称] <命令> [参数] [--json]',
      '机器选择：-H / --host 只这次；use / pin <昵称|local> 记住默认；use --clear 恢复本机；hosts 列昵称。',
      '默认本机；与 remote-host、computer-control 的默认机器各自独立。远程执行与 remote-host、computer-control、browser-control 共用同一份 SSH 代码。',
      '',
      remote === undefined ? 'DSH 里执行的命令（DSH 没在运行，下面是命令行自带的命令表；DSH 升级后新增的命令要等它运行时才列得出）：' : 'DSH 里执行的命令（来自正在运行的 DSH）：',
      ...commands.map(entryLines),
      '',
      '命令行自己执行的命令：',
      ...LOCAL.map(entryLines),
      '',
      '所有命令都能加 --json 输出结构化结果：成功是 {ok:true,status,data}，没做成是 {ok:false,error:{code,message}}，code 是稳定的英文。',
      '会话可以写完整 id、id 开头或末尾至少 4 位、或标题里的词。',
      '',
      ...EXIT_HELP,
    ].join('\n'))
    return EXIT.ok
  }

  async function requireTaskProtocol(extra: string[] = []): Promise<void> {
    const health = await http('GET', '/v1/health', undefined, 5000)
    const value = health.json as { tool?: unknown; protocol?: unknown; features?: unknown }
    if (health.status !== 200 || value.tool !== 'dsh-control' || value.protocol !== 1 || !Array.isArray(value.features) || !value.features.includes('task-outcomes') || !value.features.includes('send-receipts')) {
      throw new UsageError('运行中的远程控制插件不支持任务终态和消息回执。先部署并重启 DSH，再重试；本次没有发送消息', 'protocol-mismatch')
    }
    const missing = extra.filter((f) => !(value.features as unknown[]).includes(f))
    if (missing.length > 0) throw new UsageError(`运行中的远程控制插件还不支持 ${missing.join('、')}（--settled / --notify）。先部署并重启 DSH，再重试；本次没有发送消息`, 'protocol-mismatch')
  }

  /** `--notify self`：换成发起命令的 DSH 会话（读 DSH_SESSION_ID）；子代理的编号是裸 UUID，没有可通知的会话。 */
  function resolveNotifySelf(options: Record<string, unknown>): void {
    if (options['notify'] !== 'self') return
    const self = env['DSH_SESSION_ID']
    if (typeof self !== 'string' || !self.startsWith('session-')) throw new UsageError('--notify self 只能在 DSH 会话（bash 工具或 Python 内核）里用；这里没有可通知的会话编号，请写明会话。本次没有发送消息', 'notify-self-unavailable')
    options['notify'] = self
  }

  async function main(argv: string[]): Promise<number> {
    const { command, positional, options, asJson } = parseCommand(argv)
    invocationJson = asJson
    receipt = undefined
    if (command !== 'answer') {
      const rawJson = parseArgv(argv.slice(1), BOOLEAN_OPTIONS).options['json']
      if (rawJson !== undefined && rawJson !== true) {
        invocationJson = Array.isArray(rawJson) && rawJson.includes(true)
        throw new UsageError('--json 只能是单个不带值的开关')
      }
    }
    if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
      validateCommand('help', positional, options)
      return help(positional[0])
    }
    validateCommand(command === '--version' ? 'version' : command, positional, options)
    if (options['help'] === true) return help(command)
    if (command === 'version' || command === '--version') { print('dsh-control 0.1.0'); return EXIT.ok }
    if (command === 'restart-status') return restartStatus(asJson, typeof options['request-id'] === 'string' ? options['request-id'] : undefined)
    if (command === 'start') return start()
    if (command === 'doctor') return doctor(options, asJson)
    if (command === 'upgrade') return upgrade(options)
    if (command === 'restart') {
      if (positional.length > 0) fail('restart 不接受位置参数；dsh-control help restart 查看用法', EXIT.usage)
      return restart(options)
    }
    try {
      if (command === 'send' || command === 'new' || command === 'chat') resolveNotifySelf(options)
      const extra = [...(options['settled'] === true ? ['settled-wait'] : []), ...(options['notify'] !== undefined ? ['done-notify'] : [])]
      if (command === 'wait' || command === 'chat' || command === 'send' || extra.length > 0) await requireTaskProtocol(extra)
      if (command === 'wait') return await waitLoop(positional, options, asJson)
      if (command === 'wait-idle' && options['timeout'] !== undefined) return await waitIdleLoop(positional, options, asJson)
      if (command === 'chat') {
        const sendOptions = { ...options }
        delete sendOptions['timeout']
        delete sendOptions['since']
        delete sendOptions['slice']
        delete sendOptions['settled']
        const sent = await run('send', positional, sendOptions)
        if (!sent.ok) { output(sent, asJson); return exitFor(sent) }
        receipt = { ...(sent.data as Record<string, unknown>), sent: true }
        if (!asJson) print(sent.text ?? '')
        if (typeof receipt.sessionId !== 'string' || !Number.isSafeInteger(receipt.since) || typeof receipt.requestId !== 'string') throw new Error('消息已发送，但回执不完整；不要自动重发，请查询会话状态')
        return await waitLoop([receipt.sessionId], { since: String(receipt.since), ...(options['timeout'] === undefined ? {} : { timeout: options['timeout'] }), ...(options['slice'] === undefined ? {} : { slice: options['slice'] }), ...(options['settled'] === true ? { settled: true } : {}) }, asJson)
      }
      const res = await run(command, positional, options)
      output(res, asJson)
      return exitFor(res)
    } catch (error) {
      if (error instanceof CliExit || error instanceof UsageError) throw error
      if (error instanceof Down) fail(downAdvice(error.message), EXIT.down)
      fail(error instanceof Error ? error.message : String(error), EXIT.error)
    }
  }

  return async (argv) => {
    try { return await main(argv) }
    catch (error) {
      const code = error instanceof CliExit ? error.code : error instanceof UsageError ? EXIT.usage : EXIT.error
      const message = error instanceof Error ? error.message : String(error)
      if (argv[0] === 'restart' && env['DSH_CONTROL_RESTART_REQUEST_ID'] && !restartOwned) writeRequest(requestId, { requestId, phase: 'failed', finishedAt: Date.now(), message })
      if (invocationJson) output({ ok: false, error: { code: error instanceof UsageError ? error.code : code === EXIT.down ? 'unavailable' : code === EXIT.usage ? 'usage' : 'internal', message } }, true)
      else if (!(error instanceof CliExit)) stderr(`${message}\n`)
      return code
    }
  }
}
