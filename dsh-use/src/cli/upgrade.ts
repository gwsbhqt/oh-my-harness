/**
 * 升级 DeepSeek Harness App：读更新源、下载、校验、解包，以及在旧 App 退出后替换 /Applications 里的那一份、失败时换回。
 * 只管文件；什么时候退出、什么时候拉起由 core.ts 的重启流程决定（替换必须发生在旧进程退出之后）。
 * @module
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

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

/** 下载、校验大小和 sha512、解包，再核对签名、公证、开发者和版本号；全部对上才返回解出来的 App。 */
export async function stageRelease(entry: FeedEntry, options: { dir: string; installed: string; print: (text: string) => void; exec?: Exec }): Promise<string> {
  const exec = options.exec ?? realExec
  const work = join(options.dir, entry.version)
  mkdirSync(work, { recursive: true })
  const zip = join(work, basename(new URL(entry.url).pathname) || 'app.zip')
  if (existsSync(zip) && (await sha512File(zip)) === entry.sha512) options.print(`已下载过，校验一致：${zip}`)
  else {
    rmSync(zip, { force: true })
    options.print(`下载 ${entry.url}`)
    must(exec, '下载安装包', 'curl', ['-fL', '--retry', '3', '--connect-timeout', '20', '-sS', '-o', `${zip}.part`, entry.url], 60 * 60_000)
    renameSync(`${zip}.part`, zip)
  }
  const size = statSync(zip).size
  if (entry.size !== undefined && size !== entry.size) { rmSync(zip, { force: true }); throw new Error(`安装包大小 ${size} 与更新源的 ${entry.size} 不符，已删除`) }
  const digest = await sha512File(zip)
  if (digest !== entry.sha512) { rmSync(zip, { force: true }); throw new Error(`安装包 sha512 与更新源不符，已删除（算出 ${digest}）`) }
  options.print('大小和 sha512 与更新源一致')
  const extract = join(work, 'extract')
  rmSync(extract, { recursive: true, force: true })
  mkdirSync(extract, { recursive: true })
  must(exec, '解包', 'ditto', ['-x', '-k', zip, extract], 10 * 60_000)
  const app = join(extract, APP_NAME)
  if (!existsSync(join(app, 'Contents/Info.plist'))) throw new Error(`安装包里没有 ${APP_NAME}`)
  must(exec, '核对签名', 'codesign', ['--verify', '--deep', '--strict', app], 10 * 60_000)
  must(exec, '核对公证', 'spctl', ['-a', '-t', 'exec', app], 5 * 60_000)
  const version = appVersion(app, exec)
  if (version !== entry.version) throw new Error(`安装包里的版本是 ${version}，更新源写的是 ${entry.version}`)
  if (existsSync(options.installed)) {
    const want = teamId(options.installed, exec)
    const got = teamId(app, exec)
    if (want !== '' && got !== want) throw new Error(`新版的开发者 ${got || '未知'} 和现装的 ${want} 不同，没有继续`)
  }
  options.print(`签名、公证和开发者核对通过：${app}（${version}）`)
  return app
}

function move(from: string, to: string, exec: Exec): void {
  try { renameSync(from, to) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    must(exec, `复制 ${from}`, 'ditto', [from, to], 10 * 60_000)
    rmSync(from, { recursive: true, force: true })
  }
}

export interface Swap { target: string; backup: string; from: string; to: string }

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
  try {
    move(staged, target, exec)
    const now = appVersion(target, exec)
    if (now !== to) throw new Error(`替换后读到的版本是 ${now}，不是 ${to}`)
  } catch (error) {
    if (hadTarget) {
      rmSync(target, { recursive: true, force: true })
      move(backup, target, exec)
    }
    throw error
  }
  return { target, backup, from, to }
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

/** 新版就绪后删掉换下来的旧版、下载和解包目录：不留备份（用户 2026-11-13 定，旧版每份约 1 GB，用不着）。 */
export function pruneUpgrade(dir: string): void {
  for (const name of existsSync(dir) ? readdirSync(dir) : []) rmSync(join(dir, name), { recursive: true, force: true })
}

