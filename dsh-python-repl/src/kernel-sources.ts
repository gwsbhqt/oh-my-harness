/**
 * The kernel's Python sources, copied out of the checkout when the host starts.
 *
 * The host's `lib/` is loaded into memory once. Loading Python sources from
 * a mutable checkout could pair it with different code or make later kernel
 * starts fail after the checkout is moved or removed. Kernels load a
 * content-keyed copy taken at host start so their sources match the running
 * `lib/`.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The directories a kernel reads; everything else in the package stays in the checkout. */
export const KERNEL_SOURCE_DIRS = ['python', 'vendor'] as const
/** Copies kept besides the current one, newest first; older ones are removed. */
const KEEP_OTHERS = 2
/** Staging directories left by a crashed copy are removed after this long. */
const STALE_STAGING_MS = 60 * 60 * 1000
const COMPLETE = '.complete'

function listFiles(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (entry.name === '__pycache__') continue
    const rel = join(dir, entry.name)
    if (entry.isDirectory()) listFiles(root, rel, out)
    else if (entry.isFile()) out.push(rel)
  }
}

/** Shared Python code in a fixed kernel copy, source checkout, or published package. */
export function sharedCoreRoot(root: string): string {
  return [
    join(root, 'python', 'python_repl_core'),
    join(root, '..', 'python-repl-core', 'src', 'python_repl_core'),
  ].find((dir) => existsSync(dir)) ?? join(root, 'lib', 'python_repl_core')
}

function listSharedCoreFiles(packageRoot: string): { rel: string; abs: string }[] {
  const corePkg = sharedCoreRoot(packageRoot)
  if (!existsSync(corePkg)) return []
  const out: { rel: string; abs: string }[] = []
  const walk = (dir: string, relBase: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__pycache__') continue
      const abs = join(dir, entry.name)
      const rel = join(relBase, entry.name)
      if (entry.isDirectory()) walk(abs, rel)
      else if (entry.isFile()) out.push({ rel, abs })
    }
  }
  walk(corePkg, join('python', 'python_repl_core'))
  return out
}

/**
 * Copy `python/` and `vendor/` from `packageRoot` into `copiesDir/<content hash>`
 * unless that copy already exists, and return the copy's root. Throws when the
 * sources cannot be read or copied.
 */
export function copyKernelSources(packageRoot: string, copiesDir: string): string {
  const files: string[] = []
  for (const dir of KERNEL_SOURCE_DIRS) listFiles(packageRoot, dir, files)
  files.sort()
  const shared = listSharedCoreFiles(packageRoot).sort((a, b) => a.rel.localeCompare(b.rel))
  const entries = [
    ...files.map((rel) => ({ rel, content: readFileSync(join(packageRoot, rel)) })),
    ...shared.map((item) => ({ rel: item.rel, content: readFileSync(item.abs) })),
  ]
  const hash = createHash('sha256')
  entries.forEach(({ rel, content }) => hash.update(rel).update('\0').update(content).update('\0'))
  const id = hash.digest('hex').slice(0, 16)
  const target = join(copiesDir, id)
  if (!existsSync(join(target, COMPLETE))) {
    mkdirSync(copiesDir, { recursive: true })
    const staging = join(copiesDir, `.staging-${id}-${process.pid}-${Date.now()}`)
    try {
      entries.forEach(({ rel, content }) => {
        mkdirSync(dirname(join(staging, rel)), { recursive: true })
        writeFileSync(join(staging, rel), content)
      })
      writeFileSync(join(staging, COMPLETE), '')
      rmSync(target, { recursive: true, force: true })
      try {
        renameSync(staging, target)
      } catch (error) {
        // Another host finished the same copy first; theirs is identical.
        if (!existsSync(join(target, COMPLETE))) throw error
      }
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }
  const now = new Date()
  utimesSync(target, now, now)
  prune(copiesDir, id)
  return target
}

function prune(copiesDir: string, current: string): void {
  const now = Date.now()
  const copies: { name: string; mtime: number }[] = []
  for (const entry of readdirSync(copiesDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === current) continue
    const path = join(copiesDir, entry.name)
    const mtime = statSync(path).mtimeMs
    if (entry.name.startsWith('.staging-')) {
      if (now - mtime > STALE_STAGING_MS) rmSync(path, { recursive: true, force: true })
    } else {
      copies.push({ name: entry.name, mtime })
    }
  }
  copies.sort((a, b) => b.mtime - a.mtime)
  for (const old of copies.slice(KEEP_OTHERS)) rmSync(join(copiesDir, old.name), { recursive: true, force: true })
}
