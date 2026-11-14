/**
 * 宿主这一半：把「像路径」的片段对到本机真实存在的文件或目录上。
 *
 * 顺序（找到就停）：
 *   1. 原样：绝对路径、`~/…`、相对会话工作目录的路径，直接 stat。
 *   2. 带省略段（`~/Library/Containers/…/msg/file/2026-10/`）：省略号前面那段必须是真实目录，
 *      在它下面用 fd 搜「以后面那段结尾」的路径。
 *   3. 相对路径或裸文件名在工作目录下不存在：在工作目录下用 fd 搜以它结尾的路径。
 * 2、3 只认唯一结果：搜到两个以上就不转，免得点开的不是模型说的那个。
 *
 * fd 每次最多跑 SEARCH_TIMEOUT_MS；本机没装 fd 时只做第 1 步。
 *
 * @module dsh-path-mention/resolve
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve as resolvePath } from 'node:path'
import { isEllipsisSegment, parsePathToken, type Resolved } from '../../shared/path-mention/token.ts'

export const SEARCH_TIMEOUT_MS = 2000
const CACHE_TTL_MS = 30_000
const MAX_PARALLEL = 4
const EXCLUDES = ['.git', 'node_modules']

/** 找 fd：先看 PATH，再看 Homebrew 的两个默认位置。 */
export function findFd(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean)
  for (const dir of [...dirs, '/opt/homebrew/bin', '/usr/local/bin']) {
    for (const name of ['fd', 'fdfind']) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

async function kindOf(path: string): Promise<Resolved['kind'] | undefined> {
  try {
    const info = await stat(path)
    if (info.isDirectory()) return 'directory'
    if (info.isFile()) return 'file'
  } catch {
    // 不存在或没权限都当作不存在。
  }
  return undefined
}

function expandHome(path: string, home: string): string {
  if (path === '~') return home
  if (path.startsWith('~/')) return join(home, path.slice(2))
  return path
}

/** fd 的 glob 里特殊字符都已被 parsePathToken 拦掉，只剩反斜杠要转义。 */
function globEscape(text: string): string {
  return text.replaceAll('\\', '\\\\')
}

export interface Resolver {
  resolve(cwd: string | undefined, tokens: readonly string[]): Promise<Record<string, Resolved>>
}

export interface ResolverOptions {
  fd?: string | undefined
  home?: string
  now?: () => number
  timeoutMs?: number
}

export function createResolver(options: ResolverOptions = {}): Resolver {
  const fd = options.fd
  const home = options.home ?? homedir()
  const now = options.now ?? Date.now
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS
  const cache = new Map<string, { at: number; value: Promise<Resolved | undefined> }>()

  /** 在 root 下搜以 suffix 结尾的路径；恰好一个才返回。 */
  const searchUnique = (root: string, suffix: string, wantDir: boolean): Promise<string | undefined> => {
    if (fd === undefined) return Promise.resolve(undefined)
    // 不用 --absolute-path：它会展开软链（/var → /private/var），和用户写的前缀对不上。
    const args = ['--hidden', '--no-ignore', '--full-path', '--color', 'never', '--max-results', '2', '--type', wantDir ? 'd' : 'f']
    for (const name of EXCLUDES) args.push('--exclude', name)
    args.push('--glob', `**/${globEscape(suffix)}`, '.')
    return new Promise((done) => {
      execFile(fd, args, { cwd: root, timeout: timeoutMs, maxBuffer: 1 << 16 }, (error, stdout) => {
        if (error !== null && (error as { killed?: boolean }).killed === true) {
          done(undefined)
          return
        }
        const lines = String(stdout).split('\n').map((line) => line.replace(/\/+$/u, '').replace(/^\.\//u, '')).filter(Boolean)
        done(lines.length === 1 && lines[0] !== undefined ? join(root, lines[0]) : undefined)
      })
    })
  }

  const resolveOne = async (cwd: string | undefined, token: string): Promise<Resolved | undefined> => {
    const parsed = parsePathToken(token)
    if (parsed === undefined) return undefined
    const raw = parsed.path
    const wantDir = /[/\\]$/u.test(raw)
    const trimmed = raw.replace(/[/\\]+$/u, '')
    const expanded = expandHome(trimmed, home)
    const segments = expanded.split('/')
    const ellipsis = segments.findIndex(isEllipsisSegment)
    const accept = async (path: string | undefined): Promise<Resolved | undefined> => {
      if (path === undefined) return undefined
      const kind = await kindOf(path)
      if (kind === undefined || (wantDir && kind !== 'directory')) return undefined
      return { path, kind }
    }

    if (ellipsis >= 0) {
      const prefix = segments.slice(0, ellipsis).join('/')
      const suffix = segments.slice(ellipsis + 1)
      if (suffix.length === 0 || suffix.some(isEllipsisSegment) || suffix.some((s) => s === '')) return undefined
      const root = isAbsolute(prefix) ? prefix : cwd === undefined ? undefined : resolvePath(cwd, prefix)
      if (root === undefined || await kindOf(root) !== 'directory') return undefined
      return accept(await searchUnique(root, suffix.join('/'), wantDir))
    }

    const direct = isAbsolute(expanded) ? expanded : cwd === undefined ? undefined : resolvePath(cwd, expanded)
    const hit = await accept(direct)
    if (hit !== undefined) return hit
    // 只有相对路径才去工作目录下搜；工作目录就是根目录或家目录时范围太大，不搜。
    if (isAbsolute(expanded) || raw.startsWith('~') || cwd === undefined) return undefined
    const root = resolvePath(cwd)
    if (root === '/' || root === resolvePath(home)) return undefined
    const relative = expanded.replace(/^(?:\.\/)+/u, '')
    if (relative.startsWith('../') || relative === '') return undefined
    return accept(await searchUnique(root, relative, wantDir))
  }

  return {
    async resolve(cwd, tokens) {
      const results: Record<string, Resolved> = {}
      const queue = [...new Set(tokens)]
      const worker = async () => {
        for (let token = queue.shift(); token !== undefined; token = queue.shift()) {
          const key = `${cwd ?? ''}\u0000${token}`
          let entry = cache.get(key)
          if (entry === undefined || now() - entry.at > CACHE_TTL_MS) {
            entry = { at: now(), value: resolveOne(cwd, token).catch(() => undefined) }
            cache.set(key, entry)
          }
          const value = await entry.value
          if (value !== undefined) results[token] = value
        }
      }
      await Promise.all(Array.from({ length: MAX_PARALLEL }, worker))
      if (cache.size > 5000) for (const [key, entry] of cache) if (now() - entry.at > CACHE_TTL_MS) cache.delete(key)
      return results
    },
  }
}
