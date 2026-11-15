import { createHash } from 'node:crypto'
import * as nodeFs from 'node:fs'
import { homedir } from 'node:os'
import { join, posix, resolve, sep } from 'node:path'

// Electron patches node:fs so an .asar file looks like a directory; original-fs sees the real file.
const fs = (process.getBuiltinModule?.('original-fs') as typeof nodeFs | undefined) ?? nodeFs

type Entry = { files?: Record<string, Entry>; size?: number; offset?: string; unpacked?: boolean; link?: string; executable?: boolean }
export type AsarCopy = { copy: string; built: boolean }
export type AsarSearch = { archive: string; copy: string; unpacked: string; roots: string[] }

/** The archive file and its inner path when `root` names an `.asar` file or a path inside one, else undefined. */
export function asarParts(root: string, workdir: string): { archive: string; inner: string } | undefined {
  const hit = /^(.*?\.asar)(?:[\\/](.*))?$/s.exec(root)
  if (hit === null) return undefined
  const inner = posix.normalize((hit[2] ?? '').replaceAll('\\', '/')).replace(/^\/+|\/+$/g, '')
  if (inner === '..' || inner.startsWith('../')) return undefined
  return { archive: resolve(workdir, hit[1]!), inner: inner === '.' ? '' : inner }
}

export function asarCacheRoot(): string {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugins', 'grep-scope', 'asar')
}

/** The parsed header and the absolute offset where file contents start, or undefined when `archive` is not an asar file. */
async function readHeader(archive: string): Promise<{ root: Entry; dataOffset: number } | undefined> {
  const handle = await fs.promises.open(archive, 'r')
  try {
    const head = Buffer.alloc(16)
    if ((await handle.read(head, 0, 16, 0)).bytesRead !== 16 || head.readUInt32LE(0) !== 4) return undefined
    const headerSize = head.readUInt32LE(4)
    const jsonSize = head.readUInt32LE(12)
    if (jsonSize + 8 > headerSize || 8 + headerSize > (await handle.stat()).size) return undefined
    const json = Buffer.alloc(jsonSize)
    if ((await handle.read(json, 0, jsonSize, 16)).bytesRead !== jsonSize) return undefined
    let root: unknown
    try { root = JSON.parse(json.toString('utf8')) } catch { return undefined }
    if (typeof root !== 'object' || root === null || typeof (root as Entry).files !== 'object') return undefined
    return { root: root as Entry, dataOffset: 8 + headerSize }
  } finally { await handle.close() }
}

function childPath(dir: string, name: string): string {
  if (name === '' || name === '.' || name === '..' || /[\\/]/.test(name)) throw new Error(`asar 里有不安全的条目名：${JSON.stringify(name)}`)
  return join(dir, name)
}

async function extract(archive: string, header: { root: Entry; dataOffset: number }, into: string): Promise<void> {
  const files: Array<{ path: string; offset: number; size: number; executable: boolean }> = []
  const walk = async (entry: Entry, dir: string) => {
    for (const [name, child] of Object.entries(entry.files ?? {})) {
      const path = childPath(dir, name)
      if (child.files !== undefined) {
        await fs.promises.mkdir(path)
        await walk(child, path)
      } else if (child.link === undefined && child.unpacked !== true) {
        const size = Number(child.size), offset = Number(child.offset)
        if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(offset) || offset < 0) throw new Error(`asar 条目大小或位置无效：${path}`)
        files.push({ path, offset: header.dataOffset + offset, size, executable: child.executable === true })
      }
    }
  }
  await walk(header.root, into)
  const handle = await fs.promises.open(archive, 'r')
  try {
    let next = 0
    const worker = async () => {
      while (next < files.length) {
        const file = files[next++]!
        const bytes = Buffer.allocUnsafe(file.size)
        if (file.size > 0 && (await handle.read(bytes, 0, file.size, file.offset)).bytesRead !== file.size) throw new Error(`asar 内容被截断：${file.path}`)
        // Read-only so an edit of the copy fails loudly instead of silently changing nothing in the app.
        await fs.promises.writeFile(file.path, bytes, { flag: 'wx', mode: file.executable ? 0o555 : 0o444 })
      }
    }
    await Promise.all(Array.from({ length: 16 }, worker))
  } finally { await handle.close() }
}

const building = new Map<string, Promise<AsarCopy | undefined>>()

/**
 * The extracted copy of `archive`, keyed by its size and mtime; builds it on first use and drops copies of
 * older versions of the same archive. Undefined when the file is not an asar archive.
 */
export function asarCopy(archive: string, cacheRoot = asarCacheRoot()): Promise<AsarCopy | undefined> {
  const id = createHash('sha256').update(archive).digest('hex').slice(0, 16)
  return (async () => {
    const stat = await fs.promises.stat(archive)
    const key = `${id}-${stat.size}-${Math.trunc(stat.mtimeMs)}`
    const copy = join(cacheRoot, key)
    if (await fs.promises.stat(copy).then(s => s.isDirectory(), () => false)) return { copy, built: false }
    const pending = building.get(copy)
    if (pending !== undefined) return pending
    const job = build(archive, cacheRoot, id, key).finally(() => building.delete(copy))
    building.set(copy, job)
    return job
  })()
}

async function build(archive: string, cacheRoot: string, id: string, key: string): Promise<AsarCopy | undefined> {
  const header = await readHeader(archive)
  if (header === undefined) return undefined
  const copy = join(cacheRoot, key)
  await fs.promises.mkdir(cacheRoot, { recursive: true })
  const partial = await fs.promises.mkdtemp(join(cacheRoot, `${id}.partial-`))
  try {
    await extract(archive, header, partial)
    // Publishing by rename means a copy directory either exists complete or not at all.
    await fs.promises.rename(partial, copy)
  } catch (error) {
    await fs.promises.rm(partial, { recursive: true, force: true })
    if (await fs.promises.stat(copy).then(s => s.isDirectory(), () => false)) return { copy, built: false }
    throw error
  }
  for (const name of await fs.promises.readdir(cacheRoot)) {
    const stale = name.startsWith(`${id}-`) && name !== key
    const abandoned = name.startsWith(`${id}.partial-`) &&
      Date.now() - (await fs.promises.stat(join(cacheRoot, name)).then(s => s.mtimeMs, () => Date.now())) > 3_600_000
    if (stale || abandoned) await fs.promises.rm(join(cacheRoot, name), { recursive: true, force: true })
  }
  return { copy, built: true }
}

async function exists(path: string): Promise<boolean> {
  return fs.promises.lstat(path).then(() => true, () => false)
}

/**
 * Search roots for a grep path that reaches into a real `.asar` file: the extracted copy and the
 * `.asar.unpacked` sibling, each only where the inner path exists. Undefined for any other path.
 */
export async function prepareAsarSearch(root: string, workdir: string, cacheRoot = asarCacheRoot(), tool = 'grep'): Promise<AsarSearch | undefined> {
  const parts = asarParts(root, workdir)
  if (parts === undefined) return undefined
  if (!(await fs.promises.stat(parts.archive).then(s => s.isFile(), () => false))) return undefined
  const made = await asarCopy(parts.archive, cacheRoot)
  if (made === undefined) return undefined
  const unpacked = parts.archive + '.unpacked'
  const roots: string[] = []
  for (const base of [made.copy, unpacked]) {
    const path = parts.inner === '' ? base : join(base, ...parts.inner.split('/'))
    if (await exists(path)) roots.push(path)
  }
  if (roots.length === 0) throw new Error(`${tool} 路径不存在：${parts.archive} 里没有 ${parts.inner}。`)
  return { archive: parts.archive, copy: made.copy, unpacked, roots }
}

/**
 * Where to read or list `path` instead when it reaches into a real `.asar` file: the matching path in the
 * extracted copy or in `.asar.unpacked`, without `readable` when neither has it. Undefined for any other path.
 */
export async function asarReadablePath(path: string, workdir: string, cacheRoot = asarCacheRoot()): Promise<{ archive: string; inner: string; readable?: string } | undefined> {
  const parts = asarParts(path, workdir)
  if (parts === undefined || parts.inner === '') return undefined
  if (!(await fs.promises.stat(parts.archive).then(s => s.isFile(), () => false))) return undefined
  const made = await asarCopy(parts.archive, cacheRoot)
  if (made === undefined) return undefined
  for (const base of [made.copy, parts.archive + '.unpacked']) {
    const candidate = join(base, ...parts.inner.split('/'))
    if (await exists(candidate)) return { ...parts, readable: candidate }
  }
  return parts
}

const COPY_NAME = /^([0-9a-f]{16})-\d+-\d+$/

/** The archive copy directories a search may have built, so a path written through the `~/.dsh` link is recognised too. */
async function cacheRoots(cacheRoot: string): Promise<string[]> {
  const real = await fs.promises.realpath(cacheRoot).catch(() => cacheRoot)
  return real === cacheRoot ? [cacheRoot] : [cacheRoot, real]
}

/**
 * `path` moved into the current copy when it points into a copy that was replaced after an App update, else
 * undefined. Models keep copy paths from earlier answers; the old directory is deleted when the new copy is built
 * (evolve I-003: a grep aimed at a copy directory that no longer existed).
 */
export async function currentCopyPath(path: string, workdir: string, cacheRoot = asarCacheRoot()): Promise<string | undefined> {
  const absolute = resolve(workdir, path)
  for (const root of await cacheRoots(cacheRoot)) {
    if (!absolute.startsWith(root + sep)) continue
    const [name, ...inner] = absolute.slice(root.length + 1).split(sep)
    const hit = COPY_NAME.exec(name ?? '')
    if (hit === null || await exists(join(root, name!))) return undefined
    const id = hit[1]!
    let current = (await fs.promises.readdir(root).catch(() => [] as string[]))
      .find(other => other !== name && other.startsWith(`${id}-`) && COPY_NAME.test(other))
    if (current === undefined) {
      // The cache was wiped: rebuild from the running App's own archive when the old copy came from it.
      const resources = (process as { resourcesPath?: unknown }).resourcesPath
      const own = typeof resources === 'string' ? join(resources, 'app.asar') : undefined
      if (own === undefined || createHash('sha256').update(own).digest('hex').slice(0, 16) !== id) return undefined
      const made = await asarCopy(own, cacheRoot).catch(() => undefined)
      if (made === undefined) return undefined
      current = made.copy.slice(made.copy.lastIndexOf(sep) + 1)
    }
    return join(root, current, ...inner)
  }
  return undefined
}

/** `path` with the extracted copy's prefix replaced by the archive path; other paths unchanged. */
export function toArchivePath(path: string, search: AsarSearch): string {
  if (path === search.copy) return search.archive
  return path.startsWith(search.copy + sep) ? search.archive + path.slice(search.copy.length) : path
}
