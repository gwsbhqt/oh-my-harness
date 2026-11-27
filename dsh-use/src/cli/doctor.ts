import { constants as bufferLimits } from 'node:buffer'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Check { id: string; ok: boolean; message: string; fix?: string }
export interface Report { ok: boolean; checks: Check[]; [key: string]: unknown }
export interface OfflineOptions {
  home: string; app: string; profile?: string; full?: boolean; repairCredentials?: boolean
  timeoutMs?: number; processTimeoutMs?: number; entry?: string
}

const PREVIEW_BYTES = 16 * 1024

/** 仅属于单个内核的变量不得传入新宿主；过期的 owner PID 会触发内核看门狗退出。 */
const KERNEL_ONLY_VARS = ['PRIME_AGENT_KERNEL_OWNER_PID'] as const

export function launchEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env['ELECTRON_RUN_AS_NODE']
  for (const key of KERNEL_ONLY_VARS) delete env[key]
  return env
}

/** 从 SSH 里起的 DSH 会认定操作的人看不到屏幕，把选目录窗口换成网页版。宿主只看继承的非空 SSH_CONNECTION / SSH_TTY。 */
export function fromSsh(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env['SSH_CONNECTION']) || Boolean(env['SSH_TTY'])
}

/** 读 `launchctl print gui/<uid>` 里 environment 那一段：`\t\tKEY => VALUE`。 */
export function parseLaunchdEnvironment(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  let inside = false
  for (const line of text.split('\n')) {
    if (!inside) { if (/^\tenvironment = \{\s*$/.test(line)) inside = true; continue }
    if (/^\t\}\s*$/.test(line)) break
    const m = /^\t\t([^\s=]+) => (.*)$/.exec(line)
    if (m) out[m[1]!] = m[2]!
  }
  return out
}

/**
 * 打开 App 用的环境。不在 SSH 里就是当前环境去掉 ELECTRON_RUN_AS_NODE。
 * 在 SSH 里改用这台机器图形会话的环境，再补上账户身份那几项，SSH 的变量一个都不带进去。
 */
export function appLaunchEnv(env: NodeJS.ProcessEnv = process.env, readGui: () => string = readGuiDomain): NodeJS.ProcessEnv {
  if (!fromSsh(env)) { const out = { ...env }; delete out['ELECTRON_RUN_AS_NODE']; for (const key of KERNEL_ONLY_VARS) delete out[key]; return out }
  const gui = parseLaunchdEnvironment(readGui())
  if (gui['PATH'] === undefined) throw new Error('读不到这台电脑图形会话的环境（launchctl print gui/<uid> 里没有 PATH）。可能没人登录桌面；登录后再试。')
  const out: NodeJS.ProcessEnv = { ...gui }
  for (const key of ['HOME', 'USER', 'LOGNAME', 'TMPDIR', 'SHELL', 'LANG'] as const) if (env[key] !== undefined) out[key] = env[key]
  for (const key of Object.keys(out)) if (key.startsWith('SSH_') && key !== 'SSH_AUTH_SOCK') delete out[key]
  delete out['ELECTRON_RUN_AS_NODE']
  for (const key of KERNEL_ONLY_VARS) delete out[key]
  return out
}

function readGuiDomain(): string {
  const uid = process.getuid?.()
  const r = spawnSync('launchctl', ['print', `gui/${uid}`], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`读不到图形会话（launchctl print gui/${uid} 退出 ${r.status}）：${(r.stderr || r.error?.message || '').trim()}。可能没人登录桌面。`)
  return r.stdout
}

function matches(pattern: string): boolean {
  const processes = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' })
  if (processes.error || (processes.status !== 0 && processes.status !== 1)) throw new Error(`不能确认 DSH 进程状态：${processes.error?.message ?? processes.stderr}`)
  return processes.status === 0 && processes.stdout.trim() !== ''
}

function recordedHostAlive(home: string): boolean {
  try {
    const pid = Number(readFileSync(join(home, 'dsh-use/dsh.pid'), 'utf8').trim())
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return true }
    }
  } catch { /* 没有通信进程记录 */ }
  return false
}

export function hostRunning(app: string, home: string): boolean {
  return matches(join(app, 'Contents/MacOS/DeepSeek Harness')) || recordedHostAlive(home)
}

/** 会话所在的后台还在不在。App 进程在、它不在，就是后台崩了、App 停在崩溃窗口上：通信口没了，也不可能有会话在跑。 */
export function backendRunning(app: string, home: string): boolean {
  return matches(join(app, 'Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/')) || recordedHostAlive(home)
}

/** 诊断命令可能先退出，留下已经关闭管道的子进程。POSIX 的独占进程组一直使用创建时的编号。 */
async function stopDoctor(child: ChildProcess, group: number | undefined): Promise<string | undefined> {
  if (group === undefined && child.pid === undefined) return
  const signal = (value: NodeJS.Signals | 0): boolean => {
    try {
      if (group !== undefined) return process.kill(-group, value)
      if (child.exitCode !== null || child.signalCode !== null) return false
      return child.kill(value)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
      throw error
    }
  }
  const target = group === undefined ? '诊断进程' : `诊断进程组 ${group}`
  try {
    for (const [name, graceMs] of [['SIGTERM', 2000], ['SIGKILL', 1000]] as const) {
      if (!signal(name)) return
      const end = performance.now() + graceMs
      do {
        if (!signal(0)) return
        await delay(25)
      } while (performance.now() < end)
    }
    if (!signal(0)) return
    return `${target}在终止等待时限内仍存在`
  } catch (error) {
    return `无法确认${target}已退出（${String(error)}）`
  }
}

async function within<T>(event: Promise<T>, ms: number): Promise<T | undefined> {
  const deadline = new AbortController()
  try { return await Promise.race([event, delay(ms, undefined, { signal: deadline.signal })]) }
  finally { deadline.abort() }
}

function preview(tail: Buffer, total: number): string {
  let start = 0
  if (total > tail.length) while (start < tail.length && (tail[start]! & 0xc0) === 0x80) start++
  const text = tail.toString('utf8', start)
  return total > tail.length ? `（共 ${total} 字节，仅显示末尾 ${tail.length - start} 字节）\n${text}` : text
}

function stdoutPreview(fd: number, size: number): string {
  const tail = Buffer.alloc(Math.min(PREVIEW_BYTES, size))
  const read = readSync(fd, tail, 0, tail.length, size - tail.length)
  return preview(tail.subarray(0, read), size)
}

function doctorFailure(message: string): Report {
  return { ok: false, checks: [{ id: 'doctor-cli', ok: false, message, fix: '先用系统 node 直接运行 tooling/doctor-cli.mjs 排查。' }] }
}

async function runDoctor(args: string[], timeoutMs: number, path: string, fd: number): Promise<Report> {
  // stdout 是完整 JSON；交给临时文件，直到退出后确实需要解析才占用相应内存。stderr 只保留报错预览。
  const detached = process.platform !== 'win32'
  const child = spawn(process.execPath, args, { env: launchEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached })
  const group = detached ? child.pid : undefined
  let stderr: Buffer = Buffer.alloc(0), stderrBytes = 0
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length
    // 整段预览只解码一次，保留跨管道分片的 UTF-8 字符和实际字节数。
    stderr = chunk.length >= PREVIEW_BYTES ? chunk.subarray(-PREVIEW_BYTES)
      : Buffer.concat([stderr.subarray(chunk.length - PREVIEW_BYTES), chunk])
  })
  let readError: Error | undefined
  const exited = new Promise<true>((resolve) => {
    const fail = (error: Error) => { readError ??= error; resolve(true) }
    child.once('error', fail)
    child.once('exit', () => resolve(true))
    child.stdout.once('error', fail)
    child.stderr.once('error', fail)
    child.stdout.on('data', (chunk: Buffer) => {
      if (readError) return
      try { writeFileSync(fd, chunk) }
      catch (error) { fail(new Error(`无法写入完整诊断报告：${String(error)}`)) }
    })
  })
  const closed = new Promise<true>((resolve) => child.once('close', () => resolve(true)))
  const outcome = await within(exited, timeoutMs)
  const cleanup = await stopDoctor(child, group)
  // 即使进程组已退出，组外继承的管道仍可能保持打开。
  const drained = await within(closed, 1000)
  if (!drained) { child.stdout.destroy(); child.stderr.destroy(); child.unref() }
  const size = fstatSync(fd).size
  const stderrText = preview(stderr, stderrBytes)
  const diagnostics = () => [stderrText, stdoutPreview(fd, size)].filter(Boolean).join('\n')
  const exit = child.signalCode ? `信号 ${child.signalCode}` : child.exitCode === null ? '未收到退出码' : `退出码 ${child.exitCode}`
  const issues = [outcome === undefined && `离线检查超时（${exit}）`, readError?.message, cleanup,
    !drained && '等待诊断进程或其输出流关闭超时，无法确认输出完整']
  if (issues.some(Boolean)) return doctorFailure([...issues, diagnostics()].filter(Boolean).join('\n'))
  try {
    if (size > bufferLimits.MAX_STRING_LENGTH) throw new Error(`完整报告共 ${size} 字节，超过本进程单次 JSON 读取上限 ${bufferLimits.MAX_STRING_LENGTH} 字节`)
    const report = JSON.parse(readFileSync(path, 'utf8')) as Report
    if (typeof report?.ok !== 'boolean' || !Array.isArray(report.checks) || report.checks.some((c) => typeof c?.ok !== 'boolean' || typeof c.id !== 'string' || typeof c.message !== 'string')) throw new Error('结果格式不正确')
    if (report.ok && report.checks.some((c) => !c.ok)) throw new Error('检查总结果与失败项矛盾')
    if (child.exitCode !== 0 && report.ok) return { ...report, ok: false, checks: [...report.checks, { id: 'doctor-cli', ok: false, message: `检查进程异常退出（${exit}）${stderrText ? `\n${stderrText}` : ''}`, fix: '修复检查入口异常，再重新检查。' }] }
    return report
  } catch (error) {
    return doctorFailure(`离线检查未正常完成（${exit}）：${String(error)}\n${diagnostics()}`)
  }
}

export async function offlineDoctor(options: OfflineOptions): Promise<Report> {
  const profile = options.profile ?? 'desktop'
  const linked = join(options.home, 'profiles', profile, 'node_modules/dsh-use')
  const packageRoot = existsSync(linked) ? realpathSync(linked) : join(dirname(fileURLToPath(import.meta.url)), '..')
  const entry = options.entry ?? join(packageRoot, '../tooling/doctor-cli.mjs')
  if (!existsSync(entry)) return { ok: false, checks: [{ id: 'doctor-cli', ok: false, message: `找不到离线检查入口：${entry}`, fix: '确认共享 tooling/doctor-cli.mjs 已安装。' }] }
  const args = [entry, '--home', options.home, '--profile', profile, '--app', options.app, '--json', '--sanitize-env']
  if (options.repairCredentials) args.push('--repair-credentials')
  if (options.full) args.push('--full')
  if (options.timeoutMs !== undefined) args.push('--timeout-ms', String(options.timeoutMs))
  try {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-use-doctor-'))
    try {
      const path = join(dir, 'report.json')
      const fd = openSync(path, 'wx+', 0o600)
      try { return await runDoctor(args, options.processTimeoutMs ?? (options.timeoutMs ?? 120_000) + 30_000, path, fd) }
      finally { closeSync(fd) }
    } finally { rmSync(dir, { recursive: true, force: true }) }
  } catch (error) {
    return doctorFailure(`离线检查未正常完成：${String(error)}`)
  }
}

export function reportText(label: string, report: Report): string {
  return [label, ...report.checks.map((c) => `${c.ok ? '通过' : '失败'} [${c.id}] ${c.message}${!c.ok && c.fix ? `\n  修复：${c.fix}` : ''}`), ...(Array.isArray(report['unverified']) ? report['unverified'].map((item) => `未验证：${typeof item === 'string' ? item : JSON.stringify(item)}`) : [])].join('\n')
}

export async function layeredDoctor(offline: Report, running: boolean, online: () => Promise<Report>): Promise<{ ok: boolean; offline: Report; online: Report | null; running: boolean }> {
  let live: Report | null = null
  if (running) {
    try { live = await online() } catch (error) { live = { ok: false, checks: [{ id: 'online', ok: false, message: String(error), fix: '检查通信口和 doctor 插件是否加载；修好后重新运行 dsh-use doctor。' }] } }
  }
  return { ok: offline.ok && (!running || live?.ok === true), offline, online: live, running }
}
