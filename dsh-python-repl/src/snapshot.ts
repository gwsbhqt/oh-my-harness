/**
 * Prime's namespace snapshot, the parts that do not depend on a live session:
 * timings, where the files live, what a restore brought back, and how the
 * model is told. Scheduling and the kernel requests stay in the session.
 */

import { open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CellOutcome, SnapshotTarget } from './kernel.ts'

/** Read persisted metadata only; never deserialize a dill payload or start a kernel. */
export async function readPanelSnapshot(dir?: string): Promise<import('./panel-types.ts').PanelSnapshot> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([readPanelSnapshotFiles(dir), new Promise<import('./panel-types.ts').PanelSnapshot>((resolve) => {
      timer = setTimeout(() => resolve({ status: 'error', savedAt: null, bytes: null, saved: [], skipped: [], trimmed: [],
        error: 'snapshot metadata read timed out after 250 ms' }), 250)
    })])
  } finally { clearTimeout(timer) }
}

async function readPanelSnapshotFiles(dir?: string): Promise<import('./panel-types.ts').PanelSnapshot> {
  const empty = { savedAt: null, bytes: null, saved: [], skipped: [], trimmed: [] }
  if (dir === undefined) return { ...empty, status: 'disabled' }
  const target = snapshotFiles(dir)
  const [manifest, payload] = await Promise.allSettled([
    readFile(target.manifestPath, 'utf8'), stat(target.path),
  ])
  const missing = (result: PromiseSettledResult<unknown>): boolean => result.status === 'rejected'
    && (result.reason as NodeJS.ErrnoException)?.code === 'ENOENT'
  if (missing(manifest) && missing(payload)) return { ...empty, status: 'missing' }
  const errors: string[] = []
  let bytes: number | null = null
  if (payload.status === 'fulfilled') {
    if (!payload.value.isFile()) errors.push('snapshot payload is not a regular file')
    else bytes = payload.value.size
  } else errors.push(`snapshot payload: ${String(payload.reason)}`)
  let savedAt: string | null = null
  let saved: string[] = []
  let skipped: Array<{ name: string; reason: string }> = []
  let trimmed: string[] = []
  if (manifest.status === 'rejected') errors.push(`snapshot manifest: ${String(manifest.reason)}`)
  else {
    try {
      const data = JSON.parse(manifest.value) as Record<string, unknown>
      const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((x) => typeof x === 'string')
      if (data === null || data['version'] !== 1 || typeof data['timestamp'] !== 'string'
        || !Number.isFinite(Date.parse(data['timestamp'])) || !strings(data['savedNames'])
        || !strings(data['pruned']) || !Array.isArray(data['skipped'])
        || !data['skipped'].every((x: unknown) => x !== null && typeof x === 'object'
          && typeof (x as Record<string, unknown>)['name'] === 'string'
          && typeof (x as Record<string, unknown>)['reason'] === 'string')) {
        throw new Error('invalid snapshot manifest')
      }
      savedAt = data['timestamp']
      saved = data['savedNames']
      skipped = data['skipped'] as Array<{ name: string; reason: string }>
      trimmed = data['pruned']
    } catch (error) { errors.push(`snapshot manifest: ${String(error)}`) }
  }
  const sized = bytes === null ? null : await readSnapshotSizes(target.path)
  return { status: errors.length === 0 ? 'available' : 'error', savedAt, bytes, saved, skipped, trimmed,
    ...(sized === null ? {} : { sizes: sized.sizes, sizesComplete: sized.complete }),
    ...(errors.length === 0 ? {} : { error: errors.join('; ') }) }
}


const SNAPSHOT_MAGIC = Buffer.from('PRIME-AGENT-KERNEL-SNAPSHOT-V2\n')
const SIZE_BUDGET_MS = 150
const MAX_RECORDS = 50_000
const MAX_NAME_BYTES = 4096
const sizeCache = new Map<string, { mtimeMs: number; size: number; value: { sizes: Record<string, number>; complete: boolean } }>()

/**
 * Bytes each name takes in the snapshot, read from Prime's record headers
 * (name length, name, blob length) while skipping every blob: no value is
 * loaded or unpickled. Re-read only when the file changed; a legacy or damaged
 * file, or the time budget running out, gives what was read so far.
 */
export async function readSnapshotSizes(path: string): Promise<{ sizes: Record<string, number>; complete: boolean } | null> {
  let file: Awaited<ReturnType<typeof open>> | undefined
  try {
    file = await open(path, 'r')
    const info = await file.stat()
    const cached = sizeCache.get(path)
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.value
    const head = Buffer.alloc(MAX_NAME_BYTES + 12)
    const magic = Buffer.alloc(SNAPSHOT_MAGIC.length)
    await file.read(magic, 0, magic.length, 0)
    if (!magic.equals(SNAPSHOT_MAGIC)) return null
    const sizes: Record<string, number> = {}
    const deadline = performance.now() + SIZE_BUDGET_MS
    let at = SNAPSHOT_MAGIC.length
    let complete = true
    for (let n = 0; at < info.size; n++) {
      if (n >= MAX_RECORDS || performance.now() > deadline) { complete = false; break }
      const { bytesRead } = await file.read(head, 0, head.length, at)
      if (bytesRead < 4) { complete = false; break }
      const nameLength = head.readUInt32LE(0)
      if (nameLength > MAX_NAME_BYTES || 4 + nameLength + 8 > bytesRead) { complete = false; break }
      const name = head.toString('utf8', 4, 4 + nameLength)
      const blob = Number(head.readBigUInt64LE(4 + nameLength))
      const next = at + 4 + nameLength + 8 + blob
      if (!Number.isSafeInteger(next) || next > info.size) { complete = false; break }
      sizes[name] = blob
      at = next
    }
    const value = { sizes, complete }
    if (complete) sizeCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, value })
    return value
  } catch {
    return null
  } finally { await file?.close() }
}

/** Prime's snapshot timings: debounce after a successful cell, and per-request ceilings. */
export const SNAPSHOT_DEBOUNCE_MS = 1_500
export const SNAPSHOT_TIMEOUT_MS = 5_000
export const RESTORE_TIMEOUT_MS = 30_000
/** Importing `dill`, which the kernel venv build installed. */
export const SNAPSHOT_SUPPORT_TIMEOUT_MS = 10_000

/** The snapshot files under a session's state directory. */
export function snapshotFiles(dir: string): SnapshotTarget {
  return { path: join(dir, 'kernel-state.dill'), manifestPath: join(dir, 'kernel-state.json') }
}

/** What a new kernel got back from the session's snapshot. */
export interface RestoreReport {
  restored: string[]
  failed: string[]
  /** Names the last snapshot skipped, so they never reached the file. */
  unsaved: string[]
}

/** Prime's restore notice, plus the names the snapshot itself could not save. */
/** What python/lifecycle.py `after_restore` says about the revived namespace. */
export interface RestoreSummary {
  total: number
  /** False when no use record existed, so the lists are alphabetical, not by recency. */
  ordered: boolean
  pinned: string[]
  functions: string[]
  variables: string[]
  modules: string[]
  archived: number
  archiveAfter: number
}

const LIST_LIMIT = 10
const MODULE_LIMIT = 5
const LOST_LIMIT = 50
const NAME_CHARS = 60

function nameList(names: readonly string[], limit: number): string {
  const shown = names.slice(0, limit).map((name) => name.length > NAME_CHARS ? `${name.slice(0, NAME_CHARS - 1)}…` : name).join(', ')
  return names.length > limit ? `${shown} (+${names.length - limit} more)` : shown
}

/**
 * The first cell's restore note. Long sessions bring back hundreds of names,
 * so with a summary only pins are listed in full, and functions and variables
 * up to ten each, most recently used first; archived names are only counted.
 * Failures are always listed: those are names the model thinks it still has.
 */
export function restoreNotice(report: RestoreReport, summary?: RestoreSummary): string {
  const lines = ['[python-state-restored]', '']
  if (report.restored.length === 0) {
    lines.push('Your previous Python kernel state could not be revived; the kernel is starting fresh, so re-create any variables, imports, or loaded data you need.')
  } else if (summary === undefined) {
    lines.push(`Your Python kernel state was revived from your previous session. These names are available again: ${report.restored.join(', ')}.`)
  } else {
    const order = summary.ordered ? ' (most recently used first)' : ''
    lines.push(`Your Python kernel state was revived from your previous session: ${summary.total} name${summary.total === 1 ? ' is' : 's are'} back.`)
    if (summary.pinned.length > 0) lines.push(`Pinned with repl.keep: ${summary.pinned.join(', ')}.`)
    if (summary.functions.length > 0) lines.push(`Functions and classes${order}: ${nameList(summary.functions, LIST_LIMIT)}.`)
    if (summary.variables.length > 0) lines.push(`Variables${order}: ${nameList(summary.variables, LIST_LIMIT)}.`)
    if (summary.modules.length > 0) lines.push(`Modules: ${nameList(summary.modules, MODULE_LIMIT)}.`)
    const listed = summary.pinned.length + Math.min(summary.functions.length, LIST_LIMIT) + Math.min(summary.variables.length, LIST_LIMIT) + Math.min(summary.modules.length, MODULE_LIMIT)
    if (listed < summary.total) lines.push('await repl.list() shows every name.')
  }
  if (summary !== undefined && summary.archived > 0) {
    lines.push(`${summary.archived} more name${summary.archived === 1 ? ' was' : 's were'} archived after ${summary.archiveAfter}+ cells unused and not loaded; a cell that uses one gets it back automatically.`)
  }
  // Listed by name (the model believes it still has them), but bounded: one huge namespace must not flood the first cell.
  if (report.failed.length > 0) lines.push(`These could not be restored and must be recreated if needed: ${nameList(report.failed, LOST_LIMIT)}.`)
  if (report.unsaved.length > 0) lines.push(`These were never saved and must be recreated if needed: ${nameList(report.unsaved, LOST_LIMIT)}.`)
  lines.push('Changes to the working directory and environment variables were not saved; reapply them if needed. Restored file handles are closed placeholders; explicitly reopen files before reading or writing.')
  return lines.join('\n')
}

/**
 * What a restore brought back, from the kernel's reply and the manifest the
 * last snapshot wrote. `complete` is false when the restore failed or left
 * names out: the file on disk is then the fuller copy (Prime's restore_incomplete).
 */
export async function readRestoreReport(outcome: CellOutcome, manifestPath: string): Promise<{ report: RestoreReport; complete: boolean }> {
  const fields = outcome.fields ?? {}
  const restoredOk = outcome.status === 'ok'
  const names = (value: unknown): string[] => (Array.isArray(value) ? value : [])
    .map((entry) => (typeof entry === 'string' ? entry : (entry as { name?: unknown })?.name))
    .filter((name): name is string => typeof name === 'string')
  let unsaved: string[] = []
  try {
    unsaved = names((JSON.parse(await readFile(manifestPath, 'utf8')) as { skipped?: unknown }).skipped)
  } catch {
    // No manifest: nothing to say about what was never saved.
  }
  const report = { restored: restoredOk ? names(fields['restored']) : [], failed: names(fields['failed']), unsaved }
  return { report, complete: restoredOk && report.failed.length === 0 }
}


const DELETED_SHOWN = 300
const lifecycleCache = new Map<string, { mtimeMs: number; size: number; value: import('./panel-types.ts').PanelLifecycle | null }>()

/** The kernel's lifecycle.json for the kernel tab, re-parsed only when the file changed. Never throws. */
export async function readPanelLifecycle(dir?: string): Promise<import('./panel-types.ts').PanelLifecycle | null> {
  if (dir === undefined) return null
  const path = join(dir, 'lifecycle.json')
  try {
    const info = await stat(path)
    const cached = lifecycleCache.get(path)
    if (cached !== undefined && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.value
    const raw = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0
    const entries = (value: unknown) => Object.entries(value !== null && typeof value === 'object' ? value as Record<string, Record<string, unknown>> : {})
      .filter(([, entry]) => entry !== null && typeof entry === 'object')
    const deleted = entries(raw['deleted']).map(([name, e]) => ({ name, at: num(e['at']), t: num(e['t']), b: num(e['b']), k: String(e['k'] ?? 'data') }))
      .sort((a, b) => b.at - a.at || a.name.localeCompare(b.name))
    const value = raw['version'] !== 1 ? null : {
      cell: num(raw['cell']), archiveAfter: num(raw['archiveAfter']), deleteAfter: num(raw['deleteAfter']),
      pins: Array.isArray(raw['pins']) ? raw['pins'].filter((p): p is string => typeof p === 'string') : [],
      names: Object.fromEntries(entries(raw['names']).map(([name, e]) => [name, {
        t: num(e['t']), b: num(e['b']), ...(typeof e['k'] === 'string' ? { k: e['k'] } : {}), ...(typeof e['stuck'] === 'string' ? { stuck: e['stuck'] } : {}),
      }])),
      archived: entries(raw['archived']).map(([name, e]) => ({ name, at: num(e['at']), t: num(e['t']), b: num(e['b']), k: String(e['k'] ?? 'data'), bytes: num(e['bytes']) }))
        .sort((a, b) => b.at - a.at || a.name.localeCompare(b.name)),
      deleted: deleted.slice(0, DELETED_SHOWN),
      deletedTotal: deleted.length,
    }
    lifecycleCache.set(path, { mtimeMs: info.mtimeMs, size: info.size, value })
    return value
  } catch {
    return null
  }
}
