/**
 * dsh-runtime：DSH 启动即生效的宿主钩子，做两件互不耦合的事。
 *
 * ## 一、把登录 shell 的完整环境补进宿主进程
 *
 * DSH 的环境原先取决于「谁启动了它」：从 Dock 打开拿 launchd 里的那份，被脚本或 agent 用
 * `open` 拉起就拿启动方自己的那份，给得少就只有 `/usr/bin:/bin:/usr/sbin:/sbin`。
 * 命令工具、插件调用的外部命令（claude、node、pnpm…）于是时有时无，2026-09-28
 * Claude 订阅因为找不到 claude 整轮失败，排查时两种启动方式各是一个样子。
 *
 * 做法：插件加载时，用系统账户里登记的登录 shell（`os.userInfo().shell`，不看启动方给的
 * `SHELL`）跑一次 `-l -c 'env -0'`，只给它 HOME、USER、LOGNAME、SHELL、TMPDIR 和系统默认
 * PATH，让 shell 自己的配置从零算出环境，结果和启动方给了什么无关。读到的值写进
 * `process.env`：缺的补上，不同的以登录 shell 为准；每次调用都有变化的会话变量和
 * `DSH_*` / `ELECTRON_*` 不动。命令工具和插件的子进程都在创建那一刻读 `process.env`，
 * 所以之后启动的子进程都拿到同一份。宿主启动时拍下的环境快照（`launchEnvironment`，
 * 读 API 密钥、找外部应用用）也改成先看这份。
 *
 * 宿主自己的网络代理原本在插件加载前按启动环境定好；本插件按登录 shell 的代理变量
 * （以及 DSH 本来就认的 `~/.dsh/.env`）重新装一次：登录 shell 有代理就走，没有就直连，
 * 启动方给的代理不算数。终端里的登录 shell 会继承 launchd 用户会话的环境（`launchctl
 * setenv` 设的 GUI 代理就在那里），所以探测时也把 launchd 里的代理变量交给 shell，再由
 * 它的配置覆盖；少了这一步，代理只登记在 launchd 的机器上宿主会直连，国内直连
 * chatgpt.com 超时、api.anthropic.com 回 403（2026-09-30）。用的是宿主那一份
 * `@deepseek-ai/dsh-http-proxy`（经插件加载器解析，和宿主自带插件同一个实例），这样宿主
 * 发请求、给子进程配代理变量都按新策略走。Magpie 网关的远端出口由 Magpie 管理；DSH 自己
 * 发出的请求跟着这里的代理策略。
 *
 * ## 二、保存文件时顺着链接写，并把 cordis.patch.*.yml 的写法归一
 *
 * dotfiles 用链接管理 `~/.dsh` 里按机器不同的文件（凭据、profile 补丁层）：
 * `.credentials.yaml -> .credentials.main.yaml`。DSH 每保存一次，链接就变成一份真文件，
 * 之后的改动都落在这份真文件里，入库的那份再也收不到。
 *
 * 原因：DSH 的保存都是「旁边写一个临时文件，再改名顶替目标」——
 * `@deepseek-ai/dsh-atomic-write` 的 `writeFileAtomic`（凭据、设置页）写
 * `<目标>.<随机串>.tmp`，插件加载器保存 profile 写 `<目标>.tmp`。改名顶替的是路径上的
 * 东西，目标是链接时被换掉的就是链接本身。
 *
 * 做法：这些写入最后都调用 `node:fs/promises` 的 `rename`。插件加载时把它换成一层包装，
 * 并用 `syncBuiltinESMExports()` 让已经 `import { rename }` 的模块也拿到这层。只有「同
 * 目录、名字是 `<目标名>.…tmp` 的临时文件顶替一个链接」才改道：改名到链接最终指向的文件，
 * 链接不动。临时文件和目标在不同磁盘时，先复制到目标旁边再改名，仍是一步顶替。其余改名
 * 一律原样转发。落盘前，命中 `cordis.patch.*.yml` 的内容先做行级归一化（见下）。
 * 插件加载前发生的保存拦不到；漏掉时链接会变成真文件，dotfiles 的链接工具下次运行会报出来。
 *
 * ## 删除条件
 *
 * DSH 自己在启动时加载登录 shell 的环境、且 `writeFileAtomic` 与插件加载器的保存都改成先
 * 解析链接再写（DSH 原生支持写进链接）时，删掉本插件。
 *
 * @module
 */

import fsp from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-runtime'

// ===========================================================================
// 一、登录环境
// ===========================================================================

const MARKER = '__DSH_LOGIN_ENV__'

/** The login shell only gets what login(1) would give it, so its result does not depend on the launcher. */
const BASE_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

/** Values that describe the probing shell itself, not the user's environment. */
const SKIP_NAMES = new Set(['PWD', 'OLDPWD', 'SHLVL', '_'])
/** Names the harness and Electron own for this process. */
const SKIP_PREFIXES = ['DSH_', 'ELECTRON_']

/** 1.4 s cold on this machine, 0.08 s warm; a hung shell config must not hold the host forever. */
const TIMEOUT_MS = 15_000

export type Runner = (file: string, args: readonly string[], options: { env: NodeJS.ProcessEnv, timeout: number }) => Buffer

const defaultRunner: Runner = (file, args, options) =>
  execFileSync(file, [...args], { ...options, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 })

/** The account's login shell from the user database, or undefined when there is none. */
export function accountShell(): string | undefined {
  try {
    const shell = userInfo().shell
    return shell !== null && shell.length > 0 ? shell : undefined
  } catch {
    return undefined
  }
}

/** Parse `printf '%s\0' MARKER; env -0` output; anything the shell printed before the marker is ignored. */
export function parseLoginEnv(output: Buffer): Record<string, string> {
  const marker = Buffer.from(`${MARKER}\0`)
  const start = output.indexOf(marker)
  if (start < 0) throw new Error('login shell output has no environment marker')
  const env: Record<string, string> = {}
  for (const entry of output.subarray(start + marker.length).toString('utf8').split('\0')) {
    const eq = entry.indexOf('=')
    if (eq <= 0) continue
    env[entry.slice(0, eq)] = entry.slice(eq + 1)
  }
  return env
}

export type LaunchdGetenv = (name: string) => string | undefined

const defaultLaunchdGetenv: LaunchdGetenv = (name) => {
  if (process.platform !== 'darwin') return undefined
  try {
    const value = execFileSync('/bin/launchctl', ['getenv', name], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 2_000 }).toString('utf8').trim()
    return value === '' ? undefined : value
  } catch {
    return undefined
  }
}

/** Proxy names the launchd user session holds: what a terminal's login shell inherits before its own config runs. */
export function launchdProxies(getenv: LaunchdGetenv = defaultLaunchdGetenv): Record<string, string> {
  const found: Record<string, string> = {}
  for (const name of PROXY_NAMES) {
    const value = getenv(name)
    if (value !== undefined) found[name] = value
  }
  return found
}

/** Run the login shell from a clean base (plus the launchd session's proxy names) and return its exported environment. */
export function readLoginEnv(
  shell: string,
  current: NodeJS.ProcessEnv = process.env,
  run: Runner = defaultRunner,
  session: Record<string, string> = launchdProxies(),
): Record<string, string> {
  const home = current.HOME ?? userInfo().homedir
  const user = current.USER ?? userInfo().username
  const env: NodeJS.ProcessEnv = { ...session, HOME: home, USER: user, LOGNAME: user, SHELL: shell, PATH: BASE_PATH }
  if (current.TMPDIR !== undefined) env.TMPDIR = current.TMPDIR
  const output = run(shell, ['-l', '-c', `printf '%s\\0' ${MARKER}; env -0`], { env, timeout: TIMEOUT_MS })
  return parseLoginEnv(output)
}

function skipped(key: string): boolean {
  return SKIP_NAMES.has(key) || SKIP_PREFIXES.some(prefix => key.startsWith(prefix))
}

/** Write the login values into `target`; returns the ones that were missing or different. */
export function applyLoginEnv(login: Record<string, string>, target: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const changed: Record<string, string> = {}
  for (const [key, value] of Object.entries(login)) {
    if (skipped(key) || target[key] === value) continue
    target[key] = value
    changed[key] = value
  }
  return changed
}

/** Every name dsh-http-proxy reads; kept exactly as the login shell has them, never the launcher's. */
export const PROXY_NAMES = ['http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY', 'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY'] as const

/** Drop proxy names the login shell does not export, so children and the host policy agree with it. */
export function dropLauncherProxies(login: Record<string, string>, target: NodeJS.ProcessEnv = process.env): string[] {
  const dropped: string[] = []
  for (const key of PROXY_NAMES) {
    if (Object.hasOwn(login, key) || target[key] === undefined) continue
    Reflect.deleteProperty(target, key)
    dropped.push(key)
  }
  return dropped
}

type Source = 'process' | 'project-env' | 'user-env'
type Resolved = { value: string, source: Source, path?: string } | undefined
interface Snapshot {
  get(name: string): Resolved
  getFrom(name: string, sources: readonly Source[]): Resolved
}

const ALL_SOURCES: readonly Source[] = ['process', 'project-env', 'user-env']

/**
 * Let the launch snapshot's inherited layer answer with the login values.
 * @returns a restorer, or undefined when the host provides no snapshot of the known shape.
 */
export function patchSnapshot(snapshot: unknown, login: Record<string, string>): (() => void) | undefined {
  if (typeof snapshot !== 'object' || snapshot === null) return undefined
  const target = snapshot as Snapshot
  if (typeof target.get !== 'function' || typeof target.getFrom !== 'function') return undefined
  const { get, getFrom } = target
  let active = true
  const patchedGetFrom: Snapshot['getFrom'] = (key, sources) =>
    active && sources.includes('process') && !skipped(key) && Object.hasOwn(login, key)
      ? { value: login[key]!, source: 'process' }
      : getFrom.call(target, key, sources)
  const patchedGet: Snapshot['get'] = key => active ? target.getFrom(key, ALL_SOURCES) : get.call(target, key)
  target.getFrom = patchedGetFrom
  target.get = patchedGet
  return () => {
    active = false
    // Someone wrapped us since: leave their layer in place, ours now only forwards.
    if (target.get === patchedGet) target.get = get
    if (target.getFrom === patchedGetFrom) target.getFrom = getFrom
  }
}

/** The environment dsh-http-proxy resolves a policy from: login values, then the files DSH already honours. */
export function proxyEnvironment(login: Record<string, string>, files?: Pick<Snapshot, 'getFrom'>): Pick<Snapshot, 'get'> {
  return {
    get: key => Object.hasOwn(login, key)
      ? { value: login[key]!, source: 'process' }
      : files?.getFrom(key, ['project-env', 'user-env']),
  }
}

/**
 * Hand cordis an awaited disposer whose failure is reported, not left unhandled:
 * the host exits on any unhandled rejection, so a failing `agent.close()` would take DSH down on unload.
 */
export function reportingDisposer(dispose: () => Promise<void>, report: (error: unknown) => void): () => Promise<void> {
  return () => dispose().catch(report)
}

interface HttpProxyModule {
  installProxyFromEnvironment(env: Pick<Snapshot, 'get'>, report: (message: string) => void): Promise<() => Promise<void>>
}

/** Import a package the way the loader imports host plugins, so module state is shared with the host. */
async function hostImport<T>(ctx: Context, specifier: string): Promise<T> {
  const loader = (ctx as unknown as { loader?: { internal?: { import(name: string, base: string, attributes: object): Promise<unknown> } } }).loader
  const base = (ctx as unknown as { baseUrl?: string }).baseUrl
  if (loader?.internal === undefined || base === undefined) throw new Error('the plugin loader cannot resolve host packages here')
  return await loader.internal.import(specifier, base, {}) as T
}

/** 装登录环境：读一次登录 shell，补进 process.env 与启动快照，并按它重装宿主代理。 */
export async function applyLoginEnvironment(ctx: Context): Promise<void> {
  if (process.platform === 'win32') return
  const shell = accountShell()
  if (shell === undefined) {
    ctx.logger.warn('no login shell in the user database; environment left as launched')
    return
  }
  let login: Record<string, string>
  try {
    login = readLoginEnv(shell)
  } catch (error) {
    ctx.logger.warn('reading the login shell environment failed (%s); environment left as launched: %o', shell, error)
    return
  }
  const changed = applyLoginEnv(login)
  const dropped = dropLauncherProxies(login)
  ctx.logger.info('loaded %d variables from %s, %d missing or different, %d launcher proxy names dropped',
    Object.keys(login).length, shell, Object.keys(changed).length, dropped.length)
  const snapshot = ctx.get('launchEnvironment') as Snapshot | undefined
  const files = snapshot === undefined ? undefined : { getFrom: snapshot.getFrom.bind(snapshot) }
  const restore = patchSnapshot(snapshot, login)
  if (restore !== undefined) ctx.effect(() => restore, 'runtime: launch snapshot')
  try {
    const proxy = await hostImport<HttpProxyModule>(ctx, '@deepseek-ai/dsh-http-proxy')
    const dispose = await proxy.installProxyFromEnvironment(proxyEnvironment(login, files), message => ctx.logger.warn(message))
    ctx.effect(() => reportingDisposer(dispose, error => ctx.logger.warn('restoring the host proxy failed: %o', error)), 'runtime: host proxy')
  } catch (error) {
    ctx.logger.warn('re-installing the host proxy from the login environment failed; it stays as launched: %o', error)
  }
}

// ===========================================================================
// 二、顺链接写 + cordis.patch.*.yml 归一化
// ===========================================================================

type Rename = typeof fsp.rename

/**
 * Whether renaming `from` over `to` is a save: a `.tmp` sibling named after the target.
 * 0.2.2-rc.1 起加载器保存 profile 用隐藏名 `.<目标名>.<进程号>.<序号>.tmp`，之前是 `<目标名>.tmp`。
 */
export function isSave(from: string, to: string): boolean {
  const name = basenameOf(from)
  return dirname(from) === dirname(to) && from.endsWith('.tmp')
    && (name.startsWith(`${basenameOf(to)}.`) || name.startsWith(`.${basenameOf(to)}.`))
}

function basenameOf(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return path.slice(i + 1)
}

/** The file a symlink at `path` finally names, or undefined when `path` is not a symlink. */
export async function linkTarget(path: string): Promise<string | undefined> {
  try {
    if (!(await fsp.lstat(path)).isSymbolicLink()) return undefined
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  try {
    return await fsp.realpath(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    let current = resolve(path)
    const visited = new Set<string>()
    for (let count = 0; count < 40; count++) {
      if (visited.has(current)) throw Object.assign(new Error(`symbolic link cycle: ${current}`), { code: 'ELOOP' })
      visited.add(current)
      let info
      try {
        info = await fsp.lstat(current)
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return current
        throw cause
      }
      if (!info.isSymbolicLink()) return current
      current = resolve(dirname(current), await fsp.readlink(current))
    }
    throw Object.assign(new Error(`too many symbolic links: ${path}`), { code: 'ELOOP' })
  }
}

// ---------------------------------------------------------------------------
// 保存时归一化：把 DSH 回写 cordis.patch.*.yml 的格式差异抹平成仓库标准写法。
// 规则只由本插件维护（没有 git 过滤器再分担一份），逐行处理、保留注释与 !!js 标签、幂等。
// 插件加载前发生的保存拦不到，只有经过本插件的 DSH 保存才归一化；手动编辑后直接提交的
// 文件不处理（用户接受此取舍）。
// ---------------------------------------------------------------------------

const SAFE_SCALAR = /^(\s*)([A-Za-z0-9_-]+): "([A-Za-z0-9_./\[\]-]+)"$/
const FLOW_SEQUENCE = /^(\s*)([A-Za-z0-9_-]+):\s*\[\s*([^\[\]]*?)\s*\]\s*$/
const UNICODE_ESCAPE = /\\(?:U([0-9A-Fa-f]{8})|.)/g
const DOUBLE_QUOTED_SCALAR = /^\s*[A-Za-z0-9_-]+:\s*"(?:[^"\\]|\\.)*"\s*(?:#.*)?$/
const BLOCK_SCALAR = /^(\s*(?:-\s+)*)(?:[A-Za-z0-9_-]+:|-)\s*(?:![^\s]*\s+)?[|>][0-9+-]*\s*(?:#.*)?$/
const YAML_NUMBER = /^[-+]?(?:[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\.[0-9_]+(?:[eE][-+]?[0-9]+)?|0b[01_]+|0x[0-9a-fA-F_]+|0o[0-7_]+|\.(?:inf|nan))$/i
const YAML_NON_STRING = new Set(['null', 'true', 'false', 'yes', 'no', 'on', 'off', 'y', 'n'])

/** 只有 profile 补丁层这几份文件需要归一化。 */
const PATCH_FILE = /^cordis\.patch(\.[A-Za-z0-9_-]+)?\.yml$/

export function isDshPatchFile(path: string): boolean {
  return PATCH_FILE.test(basenameOf(path))
}

function unquoteScalar(line: string): string {
  const m = SAFE_SCALAR.exec(line)
  if (!m) return line
  const value = m[3]!
  if (
    !/[A-Za-z_./]/.test(value)
    || YAML_NON_STRING.has(value.toLowerCase())
    || YAML_NUMBER.test(value)
    || value.includes('[')
    || value.includes(']')
  ) return line
  return `${m[1]!}${m[2]!}: ${value}`
}

function normalizeFlowSequence(line: string): string {
  const m = FLOW_SEQUENCE.exec(line)
  if (!m || m[3]!.includes('"') || m[3]!.includes("'")) return line
  const items = m[3]!.split(',').map(item => item.trim())
  return `${m[1]!}${m[2]!}: [${items.join(', ')}]`
}

function expandUnicodeEscape(line: string): string {
  if (!DOUBLE_QUOTED_SCALAR.test(line)) return line
  return line.replace(UNICODE_ESCAPE, (whole, hex: string | undefined) =>
    hex ? String.fromCodePoint(parseInt(hex, 16)) : whole)
}

/** 把一段 YAML 文本按行级规则归一化；幂等，保留注释与块标量内容。 */
export function dshVolatile(text: string): string {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const out: string[] = []
  let blockIndent: number | null = null
  for (let line of lines) {
    const indent = /^ */.exec(line)![0].length
    if (blockIndent !== null) {
      if (line.trim() === '' || indent > blockIndent) { out.push(line); continue }
      blockIndent = null
    }
    line = expandUnicodeEscape(line)
    line = unquoteScalar(line)
    out.push(normalizeFlowSequence(line))
    const block = BLOCK_SCALAR.exec(line)
    if (block) blockIndent = block[1]!.length
  }
  return out.join('\n') + (text.endsWith('\n') ? '\n' : '')
}

/** 用归一化后的内容原子地替换临时文件（保留权限）；任何异常都保留原文件。 */
async function normalizeTempFile(from: string, rawRename: Rename): Promise<void> {
  let before: string
  try {
    before = await fsp.readFile(from, 'utf8')
  } catch {
    return
  }
  let after: string
  try {
    after = dshVolatile(before)
  } catch {
    return
  }
  if (after === before) return
  const tmp = `${from}.${randomBytes(6).toString('hex')}.tmp`
  try {
    const mode = (await fsp.stat(from)).mode & 0o7777
    await fsp.writeFile(tmp, after, { mode })
    await rawRename(tmp, from)
  } catch {
    await fsp.rm(tmp, { force: true }).catch(() => {})
  }
}

/** Wrap `original` so a save over a symlink lands in the linked file. */
export function writeThrough(original: Rename, active: () => boolean = () => true): Rename {
  return async (from, to) => {
    if (!active() || typeof from !== 'string' || typeof to !== 'string' || !isSave(from, to)) return original(from, to)
    const real = await linkTarget(to)
    const target = real ?? to
    if (isDshPatchFile(target)) await normalizeTempFile(from, original)
    if (real === undefined) return original(from, to)
    try {
      return await original(from, real)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    }
    const temp = `${real}.${randomBytes(6).toString('hex')}.tmp`
    try {
      await fsp.copyFile(from, temp)
      await fsp.chmod(temp, (await fsp.stat(from)).mode & 0o7777)
      await original(temp, real)
    } catch (error) {
      await fsp.rm(temp, { force: true })
      throw error
    }
    await fsp.rm(from, { force: true })
  }
}

/** 装顺链接写：包住 fsp.rename，保存顶替链接时改道到链接目标，并对补丁层做归一化。 */
export function applyConfigWrite(ctx: Context): void {
  ctx.effect(() => {
    const original = fsp.rename
    let active = true
    const patched = writeThrough(original, () => active)
    fsp.rename = patched
    syncBuiltinESMExports()
    return () => {
      active = false
      // Someone wrapped us since: leave their layer in place, ours now only forwards.
      if (fsp.rename !== patched) return
      fsp.rename = original
      syncBuiltinESMExports()
    }
  })
}

/** 插件入口：先装顺链接写（全平台），再装登录环境（win32 上跳过）。 */
export async function apply(ctx: Context): Promise<void> {
  applyConfigWrite(ctx)
  await applyLoginEnvironment(ctx)
}
