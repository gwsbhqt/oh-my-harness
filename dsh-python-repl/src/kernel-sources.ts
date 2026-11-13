/**
 * The kernel's Python sources, copied out of the checkout when the host starts.
 *
 * The host's `lib/` is loaded into memory once, but every new kernel used to
 * read `python/` and `vendor/` straight from the checkout. Moving, deleting or
 * editing the checkout under a running DSH then broke every later kernel start,
 * and with it `run_code` — the only way the model could restart DSH to recover
 * (2026-11-13: moving the plugin repository left a session unable to run any
 * cell until a manual restart). Kernels now load a copy taken at host start,
 * keyed by content, so they always match the `lib/` that is running.
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

/**
 * Copy `python/` and `vendor/` from `packageRoot` into `copiesDir/<content hash>`
 * unless that copy already exists, and return the copy's root. Throws when the
 * sources cannot be read or copied.
 */
export function copyKernelSources(packageRoot: string, copiesDir: string): string {
  const files: string[] = []
  for (const dir of KERNEL_SOURCE_DIRS) listFiles(packageRoot, dir, files)
  files.sort()
  const hash = createHash('sha256')
  const contents = files.map((rel) => readFileSync(join(packageRoot, rel)))
  files.forEach((rel, index) => hash.update(rel).update('\0').update(contents[index]!).update('\0'))
  const id = hash.digest('hex').slice(0, 16)
  const target = join(copiesDir, id)
  if (!existsSync(join(target, COMPLETE))) {
    mkdirSync(copiesDir, { recursive: true })
    const staging = join(copiesDir, `.staging-${id}-${process.pid}-${Date.now()}`)
    try {
      files.forEach((rel, index) => {
        mkdirSync(dirname(join(staging, rel)), { recursive: true })
        writeFileSync(join(staging, rel), contents[index]!)
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
