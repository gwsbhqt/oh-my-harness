/**
 * 升级 DeepSeek Harness App：读更新源、下载、校验、解包，以及在旧 App 退出后替换 /Applications 里的那一份、失败时换回。
 * 只管文件；什么时候退出、什么时候拉起由 core.ts 的重启流程决定（替换必须发生在旧进程退出之后）。
 * @module
 */
import { spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { constants, copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

export const DEFAULT_FEED = 'https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml'
const APP_NAME = 'DeepSeek Harness.app'

export interface ExecResult { status: number | null; stdout: string; stderr: string; error?: Error }
export type Exec = (command: string, args: string[], timeoutMs?: number) => ExecResult

export const realExec: Exec = (command, args, timeoutMs = 120_000) => {
  const r = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...(r.error ? { error: r.error } : {}) }
}

function must(exec: Exec, what: string, command: string, args: string[], timeoutMs?: number): string {
  const r = exec(command, args, timeoutMs)
  if (r.status !== 0 || r.error) throw new Error(`${what}失败（${command} 退出 ${r.status ?? r.error?.message}）：${(r.stderr || r.stdout).trim().slice(0, 600)}`)
  return r.stdout
}

export interface FeedEntry { version: string; url: string; sha512: string; size?: number; releaseDate?: string }

/** 解析 electron-builder 的更新清单（只取第一个文件），缺字段直接报错，不猜。 */
export function parseFeed(text: string, feedUrl: string): FeedEntry {
  const lines = text.split(/\r?\n/)
  const pairs: { indent: number; item: boolean; key: string; value: string }[] = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(-\s+)?([A-Za-z0-9_]+):\s*(.*)$/.exec(lines[i]!)
    if (m === null) continue
    let value = m[4]!.trim()
    if (/^[>|][-+]?$/.test(value)) {
      const parts: string[] = []
      const own = m[1]!.length + (m[2]?.length ?? 0)
      while (i + 1 < lines.length && (lines[i + 1]!.trim() === '' || /^\s*/.exec(lines[i + 1]!)![0].length > own)) parts.push(lines[++i]!.trim())
      value = parts.filter(Boolean).join(' ')
    }
    value = value.replace(/^'(.*)'$/, '$1').replace(/^"(.*)"$/, '$1')
    pairs.push({ indent: m[1]!.length, item: m[2] !== undefined, key: m[3]!, value })
  }
  const top = (key: string) => pairs.find((p) => p.indent === 0 && !p.item && p.key === key)?.value
  const filesAt = pairs.findIndex((p) => p.indent === 0 && p.key === 'files')
  const first: Record<string, string> = {}
  if (filesAt >= 0) {
    let seenItem = false
    for (const p of pairs.slice(filesAt + 1)) {
      if (p.indent === 0 && !p.item) break
      if (p.item) { if (seenItem) break; seenItem = true }
      if (seenItem) first[p.key] = p.value
    }
  }
  const version = top('version')
  const rawUrl = first['url'] ?? top('path')
  const sha512 = first['sha512'] ?? top('sha512')
  if (!version || !rawUrl || !sha512) throw new Error(`更新源 ${feedUrl} 缺少 version、下载地址或 sha512，没有继续`)
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(sha512)) throw new Error(`更新源里的 sha512 不是 base64：${sha512}`)
  const size = first['size'] === undefined ? undefined : Number(first['size'])
  return { version, url: new URL(rawUrl, feedUrl).toString(), sha512, ...(size !== undefined && Number.isSafeInteger(size) ? { size } : {}), ...(top('releaseDate') ? { releaseDate: top('releaseDate')! } : {}) }
}

export function fetchFeed(feedUrl: string, exec: Exec = realExec): FeedEntry {
  return parseFeed(must(exec, '读取更新源', 'curl', ['-fsSL', '--retry', '3', '--max-time', '60', feedUrl], 90_000), feedUrl)
}

/** App 的版本号（Info.plist 的 CFBundleShortVersionString）。 */
export function appVersion(app: string, exec: Exec = realExec): string {
  return must(exec, `读取 ${app} 的版本`, 'plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', join(app, 'Contents/Info.plist')]).trim()
}

function teamId(app: string, exec: Exec): string {
  const r = exec('codesign', ['-dv', '--verbose=2', app])
  return /TeamIdentifier=(\S+)/.exec(`${r.stderr}\n${r.stdout}`)?.[1] ?? ''
}

export function sha512File(path: string): Promise<string> {
  return new Promise((done, failed) => {
    const hash = createHash('sha512')
    createReadStream(path).on('data', (c) => hash.update(c)).on('error', failed).on('end', () => done(hash.digest('base64')))
  })
}

function verifyApp(app: string, version: string, expectedTeam: string, exec: Exec): void {
  if (!existsSync(join(app, 'Contents/Info.plist'))) throw new Error(`安装包里没有 ${APP_NAME}`)
  must(exec, '核对签名', 'codesign', ['--verify', '--deep', '--strict', app], 10 * 60_000)
  must(exec, '核对公证', 'spctl', ['-a', '-t', 'exec', app], 5 * 60_000)
  const gotVersion = appVersion(app, exec)
  if (gotVersion !== version) throw new Error(`安装包里的版本是 ${gotVersion}，更新源写的是 ${version}`)
  const gotTeam = teamId(app, exec)
  if (expectedTeam !== '' && gotTeam !== expectedTeam) throw new Error(`新版的开发者 ${gotTeam || '未知'} 和现装的 ${expectedTeam} 不同，没有继续`)
}

async function archiveMismatch(path: string, entry: FeedEntry): Promise<string | undefined> {
  const size = statSync(path).size
  if (entry.size !== undefined && size !== entry.size) return `安装包大小 ${size} 与更新源的 ${entry.size} 不符`
  const digest = await sha512File(path)
  if (digest !== entry.sha512) return `安装包 sha512 与更新源不符（算出 ${digest}）`
}

/** 读取缓存期间，另一个已完成的安装可以移除缓存名。私有副本一直可用；APFS 上尽可能使用写时复制。 */
function copyCachedArchive(source: string, destination: string): boolean {
  try { copyFileSync(source, destination, constants.COPYFILE_FICLONE) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  return true
}

const checkedBuild = /^build-[0-9a-f-]{36}$/

function managedRelease(dir: string, app: string) {
  const [name = '', ...inside] = relative(resolve(dir), resolve(app)).split(sep)
  const match = /^release-([a-f0-9]{64})(-[A-Za-z0-9]{6,})?$/.exec(name)
  if (!match || inside.at(-2) !== 'extract' || inside.at(-1) !== APP_NAME) return undefined
  const parents = inside.slice(0, -2)
  const privateStage = match[2] !== undefined
  if (privateStage ? parents.length !== 0 : parents.some((part) => part !== 'replacement' && !checkedBuild.test(part))) return undefined
  return { work: join(dir, name), shared: join(dir, `release-${match[1]}`), archive: join(dir, `package-${match[1]}.zip`), private: privateStage }
}

function discardDirectory(work: string): void {
  try { rmSync(work, { recursive: true, force: true }) } catch (error) {
    process.stderr.write(`未能清理升级临时目录 ${work}：${error instanceof Error ? error.message : String(error)}\n`)
  }
}

/** 下载、校验、解包到本次请求独占的路径；离线检查和后台安装都可以直接使用返回的 App。 */
export async function stageRelease(entry: FeedEntry, options: { dir: string; installed: string; print: (text: string) => void; exec?: Exec }): Promise<string> {
  const exec = options.exec ?? realExec
  const installedTeam = () => existsSync(options.installed) ? teamId(options.installed, exec) : ''
  const expectedTeam = installedTeam()
  const dir = resolve(options.dir)
  mkdirSync(dir, { recursive: true })
  const key = createHash('sha256').update(entry.version).update('\0').update(entry.sha512).digest('hex')
  const archive = join(dir, `package-${key}.zip`)
  const sources = [archive]
  const filename = basename(new URL(entry.url).pathname) || 'app.zip'
  if ([entry.version, filename].every((part) => part !== '' && part !== '.' && part !== '..' && basename(part) === part)) {
    sources.push(join(dir, entry.version, filename))
  }
  const work = mkdtempSync(join(dir, `release-${key}-`))
  const zip = join(work, 'download.part')
  const extract = join(work, 'extract')
  try {
    let source: string | undefined
    for (const candidate of sources) {
      if (copyCachedArchive(candidate, zip) && await archiveMismatch(zip, entry) === undefined) { source = candidate; break }
    }
    if (source !== undefined) options.print(`已下载过，校验一致：${source}`)
    else {
      options.print(`下载 ${entry.url}`)
      must(exec, '下载安装包', 'curl', ['-fL', '--retry', '3', '--connect-timeout', '20', '-sS', '-o', zip, entry.url], 60 * 60_000)
      const mismatch = await archiveMismatch(zip, entry)
      if (mismatch !== undefined) throw new Error(`${mismatch}，已删除本次下载`)
    }
    options.print('大小和 sha512 与更新源一致')
    mkdirSync(extract)
    must(exec, '解包', 'ditto', ['-x', '-k', zip, extract], 10 * 60_000)
    const app = join(extract, APP_NAME)
    verifyApp(app, entry.version, expectedTeam || installedTeam(), exec)
    renameSync(zip, archive)
    options.print(`签名、公证和开发者核对通过：${app}（${entry.version}）`)
    return app
  } catch (error) {
    discardDirectory(work)
    throw error
  }
}

/** --check 完成后发布。返回的 App 位于不可复用的目录名下，修复损坏缓存时也不会移走别的请求手里的完好 App。 */
export function keepCheckedRelease(dir: string, staged: string, exec: Exec = realExec): string {
  const release = managedRelease(dir, staged)
  if (!release?.private) return staged
  const version = appVersion(staged, exec)
  const team = teamId(staged, exec)
  const name = `build-${randomUUID()}`
  const candidate = join(release.work, name)
  mkdirSync(candidate)
  renameSync(dirname(staged), join(candidate, 'extract'))
  let slot = release.shared
  try {
    for (;;) {
      try {
        renameSync(release.work, slot)
        return join(slot, name, 'extract', APP_NAME)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === 'ENOENT' && slot !== release.shared) { slot = release.shared; continue }
        if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error
      }
      let existing: string | undefined
      try { existing = readdirSync(slot, { withFileTypes: true }).find((item) => item.isDirectory() && checkedBuild.test(item.name))?.name } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        slot = release.shared
        continue
      }
      if (!existing) { slot = join(slot, 'replacement'); continue }
      const previous = join(slot, existing)
      const next = join(previous, 'replacement')
      if (existsSync(next)) { slot = next; continue }
      const app = join(previous, 'extract', APP_NAME)
      try { verifyApp(app, version, team, exec); return app } catch {
        // 同一校验工具能验证私有副本，才回收已确认损坏的那份。其唯一目录承载下一次原子发布。
        verifyApp(join(candidate, 'extract', APP_NAME), version, team, exec)
        discardDirectory(join(previous, 'extract'))
        slot = next
      }
    }
  } finally { discardDirectory(release.work) }
}

/** 准备或交接失败时，仅释放本次操作的私有解包目录。 */
export function discardStagedRelease(dir: string, staged: string): void {
  const release = managedRelease(dir, staged)
  if (release?.private) discardDirectory(release.work)
}

function copyApp(from: string, to: string, exec: Exec): void {
  const work = mkdtempSync(join(dirname(to), '.dsh-upgrade-'))
  const copy = join(work, APP_NAME)
  try {
    must(exec, `复制 ${from}`, 'ditto', [from, copy], 10 * 60_000)
    renameSync(copy, to)
  } finally { discardDirectory(work) }
}

function move(from: string, to: string, exec: Exec): void {
  try { renameSync(from, to) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    copyApp(from, to, exec)
    rmSync(from, { recursive: true, force: true })
  }
}

export interface Swap { target: string; backup: string; from: string; to: string; staged: string }

/** 旧 App 挪进备份目录、新 App 挪到原位并核对版本；中途出错把旧版挪回原位再抛错。只能在旧进程退出后调用。 */
export function swapIn(staged: string, target: string, backups: string, exec: Exec = realExec): Swap {
  const to = appVersion(staged, exec)
  const from = existsSync(target) ? appVersion(target, exec) : ''
  mkdirSync(backups, { recursive: true })
  const backup = join(backups, `DeepSeek Harness ${from || 'unknown'}.app`)
  if (resolve(backup) === resolve(staged)) throw new Error(`要装的就是现在这一版 ${to}，不用替换`)
  rmSync(backup, { recursive: true, force: true })
  const hadTarget = existsSync(target)
  if (hadTarget) move(target, backup, exec)
  let placed = false
  try {
    const release = managedRelease(dirname(backups), staged)
    if (release && !release.private) copyApp(staged, target, exec)
    else move(staged, target, exec)
    placed = true
    const now = appVersion(target, exec)
    if (now !== to) throw new Error(`替换后读到的版本是 ${now}，不是 ${to}`)
  } catch (error) {
    if (placed) rmSync(target, { recursive: true, force: true })
    if (hadTarget) move(backup, target, exec)
    throw error
  }
  return { target, backup, from, to, staged }
}

/** 新版起不来时换回：新版挪进 failed 目录，备份挪回原位。 */
export function swapBack(swap: Swap, exec: Exec = realExec): void {
  const failed = join(dirname(dirname(swap.backup)), 'failed')
  mkdirSync(failed, { recursive: true })
  const parked = join(failed, `DeepSeek Harness ${swap.to}.app`)
  rmSync(parked, { recursive: true, force: true })
  if (existsSync(swap.target)) move(swap.target, parked, exec)
  move(swap.backup, swap.target, exec)
}

/** 仅在新版就绪后回收这次安装的备份、下载和检查结果。其他请求可能正在解包或等待后台接手。 */
export function pruneUpgrade(dir: string, swap: Swap): void {
  const backups = resolve(dir, 'backups')
  const failed = resolve(dir, 'failed')
  const replaced = [[backups, swap.backup], [failed, join(failed, `DeepSeek Harness ${swap.to}.app`)]] as const
  for (const [folder, app] of replaced) {
    if (dirname(resolve(app)) !== folder) continue
    rmSync(app, { recursive: true, force: true })
    try { rmdirSync(folder) } catch (error) {
      if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
  }
  const release = managedRelease(dir, swap.staged)
  if (!release) return
  if (release.private) rmSync(release.work, { recursive: true, force: true })
  rmSync(release.archive, { force: true })
  const retired = mkdtempSync(join(dir, 'retired-'))
  try {
    // 先挪走再递归删除，使同时完成的 --check 总能发布到一个完整或空缺的位置。
    try { renameSync(release.shared, join(retired, 'checked')) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  } finally { rmSync(retired, { recursive: true, force: true }) }
}

