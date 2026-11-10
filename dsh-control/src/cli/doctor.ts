import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Check { id: string; ok: boolean; message: string; fix?: string }
export interface Report { ok: boolean; checks: Check[]; [key: string]: unknown }
export interface OfflineOptions {
  home: string; app: string; profile?: string; full?: boolean; repairCredentials?: boolean
  timeoutMs?: number; entry?: string
}

/** 只该由 dsh-python-repl 给单个内核设的变量。从内核子进程里重启/试启动 App 会把它带进新宿主：旧值指向已死的进程，内核看门狗读到就自杀（2026-10-09 实测：宿主环境里的死值让所有会话里跑的 vendor 协议测试失败）。 */
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
    const pid = Number(readFileSync(join(home, 'dsh-control/dsh.pid'), 'utf8').trim())
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

export async function offlineDoctor(options: OfflineOptions): Promise<Report> {
  const profile = options.profile ?? 'desktop'
  const linked = join(options.home, 'profiles', profile, 'node_modules/dsh-control')
  const packageRoot = existsSync(linked) ? realpathSync(linked) : join(dirname(fileURLToPath(import.meta.url)), '..')
  const entry = options.entry ?? join(packageRoot, '../tooling/doctor-cli.mjs')
  if (!existsSync(entry)) return { ok: false, checks: [{ id: 'doctor-cli', ok: false, message: `找不到离线检查入口：${entry}`, fix: '确认共享 tooling/doctor-cli.mjs 已安装。' }] }
  const args = [entry, '--home', options.home, '--profile', profile, '--app', options.app, '--json', '--sanitize-env']
  if (options.repairCredentials) args.push('--repair-credentials')
  if (options.full) args.push('--full')
  if (options.timeoutMs !== undefined) args.push('--timeout-ms', String(options.timeoutMs))
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: launchEnv(), stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout += chunk })
    child.stderr.on('data', (chunk: string) => { stderr += chunk })
    const timeout = setTimeout(() => child.kill('SIGTERM'), (options.timeoutMs ?? 120_000) + 30_000)
    child.on('error', (error) => { clearTimeout(timeout); resolve({ ok: false, checks: [{ id: 'doctor-cli', ok: false, message: error.message, fix: '检查系统 node 和公共检查入口的文件权限。' }] }) })
    child.on('close', (code) => {
      clearTimeout(timeout)
      try {
        const report = JSON.parse(stdout) as Report
        if (typeof report.ok !== 'boolean' || !Array.isArray(report.checks) || report.checks.some((c) => typeof c?.ok !== 'boolean' || typeof c.id !== 'string' || typeof c.message !== 'string')) throw new Error('结果格式不正确')
        if (report.ok && report.checks.some((c) => !c.ok)) throw new Error('检查总结果与失败项矛盾')
        resolve({ ...report, ok: code === 0 && report.ok, ...(code !== 0 && report.ok ? { checks: [...report.checks, { id: 'doctor-cli', ok: false, message: `检查进程异常退出：${code} ${stderr}`, fix: '修复检查入口异常，再重新检查。' }] } : {}) })
      } catch (error) {
        resolve({ ok: false, checks: [{ id: 'doctor-cli', ok: false, message: `离线检查未正常完成（退出码 ${code}）：${stderr || stdout || String(error)}`, fix: '先用系统 node 直接运行 tooling/doctor-cli.mjs 排查。' }] })
      }
    })
  })
}

export function reportText(label: string, report: Report): string {
  return [label, ...report.checks.map((c) => `${c.ok ? '通过' : '失败'} [${c.id}] ${c.message}${!c.ok && c.fix ? `\n  修复：${c.fix}` : ''}`), ...(Array.isArray(report['unverified']) ? report['unverified'].map((item) => `未验证：${typeof item === 'string' ? item : JSON.stringify(item)}`) : [])].join('\n')
}

export async function layeredDoctor(offline: Report, running: boolean, online: () => Promise<Report>): Promise<{ ok: boolean; offline: Report; online: Report | null; running: boolean }> {
  let live: Report | null = null
  if (running) {
    try { live = await online() } catch (error) { live = { ok: false, checks: [{ id: 'online', ok: false, message: String(error), fix: '检查通信口和 doctor 插件是否加载；修好后重新运行 dsh-control doctor。' }] } }
  }
  return { ok: offline.ok && (!running || live?.ok === true), offline, online: live, running }
}
