/**
 * Prime's namespace snapshot, the parts that do not depend on a live session:
 * timings, where the files live, what a restore brought back, and how the
 * model is told. Scheduling and the kernel requests stay in the session.
 */

import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, open, readFile, readlink, stat, type FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { AutoSaveIssue, PanelSnapshot } from './panel-types.ts'
import type { CellOutcome, SnapshotTarget } from './kernel.ts'

const PANEL_BUDGET_MS = 250

/** Read persisted metadata only; never deserialize a dill payload or start a kernel. */
export async function readPanelSnapshot(dir?: string): Promise<PanelSnapshot> {
  return withinBudget(readPanelSnapshotFiles(dir), { status: 'error', savedAt: null, bytes: null, saved: [], skipped: [], trimmed: [],
    error: `snapshot metadata read timed out after ${PANEL_BUDGET_MS} ms` })
}

async function withinBudget<T>(work: Promise<T>, timedOut: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([work, new Promise<T>(resolve => { timer = setTimeout(() => resolve(timedOut), PANEL_BUDGET_MS) })])
  } finally { clearTimeout(timer) }
}

async function readPanelSnapshotFiles(dir?: string): Promise<PanelSnapshot> {
  const empty = { savedAt: null, bytes: null, saved: [], skipped: [], trimmed: [] }
  if (dir === undefined) return { ...empty, status: 'disabled' }
  const logical = snapshotFiles(dir)
  try {
    const pair = await openPanelPair(logical)
    if (!pair) return { ...empty, status: 'missing' }
    try {
      return await describePanelPair(pair, logical.path)
    } finally {
      await Promise.all([pair.payload.close(), pair.manifest?.close()])
    }
  } catch (error) {
    return { ...empty, status: 'error', error: String(error) }
  }
}

interface PanelPair { payload: FileHandle; manifest?: FileHandle; published: boolean }

function absent(error: unknown): boolean { return (error as NodeJS.ErrnoException).code === 'ENOENT' }

async function optionalStat(path: string) {
  try { return await lstat(path) } catch (error) { if (!absent(error)) throw error }
}

function storePath(target: SnapshotTarget): string {
  const hash = createHash('sha256').update(basename(target.path)).digest('hex')
  return join(dirname(target.path), `.snapshot-${hash}`)
}

async function currentGeneration(store: string): Promise<string | null> {
  try {
    const value = await readlink(join(store, 'current'))
    if (value !== 'empty' && value !== 'legacy' && !/^[a-f0-9]{32}$/.test(value)) throw new Error('invalid snapshot generation')
    return value
  } catch (error) { if (!absent(error)) throw error; return null }
}

async function publicKind(path: string, store: string): Promise<'absent' | 'file' | 'alias'> {
  const info = await optionalStat(path)
  if (!info) return 'absent'
  if (info.isFile()) return 'file'
  if (info.isSymbolicLink() && await readlink(path) === join(basename(store), 'current', basename(path))) return 'alias'
  throw new Error(`invalid public snapshot file: ${basename(path)}`)
}

async function checkMigratingFile(path: string, saved: string, kind: 'absent' | 'file' | 'alias'): Promise<void> {
  if (kind === 'alias') return
  const copy = await optionalStat(saved)
  if (kind === 'absent' && !copy) return
  if (kind === 'file' && copy) {
    const original = await stat(path)
    if (original.dev === copy.dev && original.ino === copy.ino) return
  }
  throw new Error('legacy public file conflicts with the migrating snapshot')
}

async function locateSnapshot(target: SnapshotTarget, store: string, generation: string | null): Promise<SnapshotTarget | undefined> {
  const [payload, manifest] = await Promise.all([publicKind(target.path, store), publicKind(target.manifestPath, store)])
  if (generation === null) {
    if (payload === 'absent' && manifest === 'absent') return undefined
    if (payload !== 'file' || manifest === 'alias') throw new Error('incomplete snapshot or missing current generation')
    return target
  }
  const path = join(store, generation)
  if (!(await optionalStat(path))?.isDirectory()) throw new Error('snapshot generation directory is missing or invalid')
  if (generation === 'empty') {
    if (payload === 'file' || manifest === 'file') throw new Error('empty snapshot has conflicting public files')
    return undefined
  }
  const physical = { path: join(path, basename(target.path)), manifestPath: join(path, basename(target.manifestPath)) }
  if (generation === 'legacy') {
    await Promise.all([checkMigratingFile(target.path, physical.path, payload), checkMigratingFile(target.manifestPath, physical.manifestPath, manifest)])
  } else if (payload !== 'alias' || manifest !== 'alias') throw new Error('published snapshot has missing or replaced public links')
  return physical
}

async function openRegular(path: string): Promise<FileHandle> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!(await file.stat()).isFile()) throw new Error(`not a regular snapshot file: ${basename(path)}`)
    return file
  } catch (error) { await file.close(); throw error }
}

/** Pin both files before inspecting either. An unlinked generation stays readable through its descriptors. */
async function openPanelPair(target: SnapshotTarget): Promise<PanelPair | undefined> {
  const store = storePath(target)
  const directory = await optionalStat(store)
  if (directory && !directory.isDirectory()) throw new Error('snapshot store is not a directory')
  const deadline = performance.now() + PANEL_BUDGET_MS
  do {
    const generation = await currentGeneration(store)
    let payload: FileHandle | undefined
    let manifest: FileHandle | undefined
    let ready = false
    try {
      const selection = await locateSnapshot(target, store, generation)
      if (!selection) return undefined
      payload = await openRegular(selection.path)
      try { manifest = await openRegular(selection.manifestPath) } catch (error) {
        if (!absent(error) || (generation !== null && generation !== 'legacy')) throw error
      }
      // Historical names can become aliases during the opens. Published generation paths never change identity.
      ready = generation !== null || await currentGeneration(store) === null
      if (ready) return { payload, ...(manifest ? { manifest } : {}), published: generation !== null && generation !== 'legacy' }
    } catch (error) {
      if (await currentGeneration(store) === generation) throw error
    } finally {
      if (!ready) await Promise.all([payload?.close(), manifest?.close()])
    }
  } while (performance.now() < deadline)
  throw new Error('snapshot generation changed repeatedly during the read')
}

type SnapshotPresence = 'missing' | 'available' | 'error'

export function snapshotPresence(target: SnapshotTarget): Promise<SnapshotPresence> {
  return withinBudget(inspectPresence(target), 'error')
}

async function inspectPresence(target: SnapshotTarget): Promise<SnapshotPresence> {
  try {
    const pair = await openPanelPair(target)
    if (!pair) return 'missing'
    try {
      if (pair.published) await readManifest(pair, (await pair.payload.stat()).size)
      return 'available'
    } finally { await Promise.all([pair.payload.close(), pair.manifest?.close()]) }
  } catch { return 'error' }
}

type ManifestFields = Pick<PanelSnapshot, 'savedAt' | 'saved' | 'skipped' | 'trimmed'>
let lastManifest: { info: Stats; bytes: number; fields: ManifestFields } | undefined

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.ctimeMs === b.ctimeMs && a.mtimeMs === b.mtimeMs
}

async function readManifest(pair: PanelPair, bytes: number): Promise<ManifestFields> {
  if (!pair.manifest) throw new Error('snapshot manifest is missing')
  const info = await pair.manifest.stat()
  if (pair.published && lastManifest?.bytes === bytes && sameFile(lastManifest.info, info)) return lastManifest.fields
  const data = JSON.parse(await pair.manifest.readFile('utf8')) as Record<string, unknown>
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((x) => typeof x === 'string')
  if (data === null || data['version'] !== 1 || (pair.published && data['bytes'] !== bytes) || typeof data['timestamp'] !== 'string'
    || !Number.isFinite(Date.parse(data['timestamp'])) || !strings(data['savedNames']) || !strings(data['pruned']) || !Array.isArray(data['skipped'])
    || !data['skipped'].every((item: unknown) => item !== null && typeof item === 'object'
      && typeof (item as Record<string, unknown>)['name'] === 'string' && typeof (item as Record<string, unknown>)['reason'] === 'string')) {
    throw new Error('invalid snapshot manifest')
  }
  const fields = { savedAt: data['timestamp'], saved: data['savedNames'], skipped: data['skipped'] as PanelSnapshot['skipped'], trimmed: data['pruned'] }
  if (pair.published) lastManifest = { info, bytes, fields }
  return fields
}

async function describePanelPair(pair: PanelPair, path: string): Promise<PanelSnapshot> {
  const info = await pair.payload.stat()
  const empty = { savedAt: null, saved: [], skipped: [], trimmed: [] }
  const result = await readManifest(pair, info.size).then(fields => ({ status: 'available' as const, ...fields }),
    error => ({ status: 'error' as const, ...empty, error: `snapshot manifest: ${String(error)}` }))
  const sized = await snapshotSizes(pair.payload, info, path).catch(() => null)
  return { ...result, bytes: info.size, ...(sized === null ? {} : { sizes: sized.sizes, sizesComplete: sized.complete }) }
}

const SNAPSHOT_MAGIC = Buffer.from('PRIME-AGENT-KERNEL-SNAPSHOT-V2\n')
const SIZE_BUDGET_MS = 150
const MAX_RECORDS = 50_000
const MAX_NAME_BYTES = 4096
interface SnapshotSizes { sizes: Record<string, number>; complete: boolean }
const sizeCache = new Map<string, { stat: Stats; value: SnapshotSizes }>()

/** Read only the framing and name bytes, skipping the serialized values by offset. */
async function snapshotSizes(file: FileHandle, info: Stats, path: string): Promise<SnapshotSizes | null> {
  const prior = sizeCache.get(path)
  if (prior && sameFile(prior.stat, info)) return prior.value
  const head = Buffer.alloc(MAX_NAME_BYTES + 8)
  const magic = Buffer.alloc(SNAPSHOT_MAGIC.length)
  await file.read(magic, 0, magic.length, 0)
  if (!magic.equals(SNAPSHOT_MAGIC)) return null
  const sizes: Record<string, number> = Object.create(null)
  const deadline = performance.now() + SIZE_BUDGET_MS
  let at = SNAPSHOT_MAGIC.length
  let count = 0
  while (at < info.size && count++ < MAX_RECORDS && performance.now() < deadline) {
    if ((await file.read(head, 0, 4, at)).bytesRead !== 4) break
    const length = head.readUInt32LE(0)
    if (length > MAX_NAME_BYTES || (await file.read(head, 0, length + 8, at + 4)).bytesRead !== length + 8) break
    const stored = head.toString('utf8', 0, length)
    const blob = Number(head.readBigUInt64LE(length))
    const next = at + 12 + length + blob
    if (!Number.isSafeInteger(next) || next > info.size) break
    sizes[stored.startsWith('__dsh_user_') ? stored.slice(2) : stored] = blob
    at = next
  }
  const value = { sizes: { ...sizes }, complete: at === info.size }
  if (value.complete) sizeCache.set(path, { stat: info, value })
  return value
}

export async function readSnapshotSizes(path: string): Promise<SnapshotSizes | null> {
  let file: FileHandle | undefined
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK)
    const info = await file.stat()
    return info.isFile() ? await snapshotSizes(file, info, path) : null
  } catch { return null } finally { await file?.close() }
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
  error?: string
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

export const INCOMPLETE_RESTORE_NOTICE = 'Saving is paused after an incomplete restore. New or changed values, including pinned names, are in memory only. Before closing or restarting the host, use await repl.save_copy("name") for values you need. After restarting, use await repl.list_copies() and await repl.read_copy(copy_id).'
const LIST_LIMIT = 10
const MODULE_LIMIT = 5
const LOST_LIMIT = 50
const NAME_CHARS = 60

function shortName(name: string): string {
  return name.length > NAME_CHARS ? `${name.slice(0, NAME_CHARS - 1)}…` : name
}

function nameList(names: readonly string[], limit: number): string {
  const shown = names.slice(0, limit).map(shortName).join(', ')
  return names.length > limit ? `${shown} (+${names.length - limit} more)` : shown
}

/** The kernel acknowledges a snapshot only after writing the payload and manifest. */
export type SnapshotResult =
  | { status: 'saved'; skipped: string; skippedNames: string[] }
  | { status: 'disabled' }
  | { status: 'failed'; reason: string; panelReason?: string }

export function snapshotResult(outcome: CellOutcome): SnapshotResult {
  if (outcome.status !== 'ok') {
    const reason = outcome.fields?.['reason']
    return { status: 'failed', reason: typeof reason === 'string' ? reason : outcome.error?.evalue ?? outcome.status }
  }
  const skipped = outcome.fields?.['skipped']
  if (!Array.isArray(outcome.fields?.['saved']) || !Array.isArray(skipped)
    || !skipped.every((item: unknown) => typeof (item as { name?: unknown } | null)?.name === 'string')) {
    return { status: 'failed', reason: 'the kernel did not confirm which names were saved' }
  }
  const skippedNames = skipped.map((item: { name: string }) => item.name)
  return { status: 'saved', skipped: nameList(skippedNames, LOST_LIMIT), skippedNames }
}

/** One debounced write can finish after the cell that changed the namespace returned. */
export class AutoSaveFeedback {
  issue: AutoSaveIssue | undefined
  #key: string | undefined
  #reported: string | undefined
  #reportedFailure = false

  record(result: SnapshotResult): void {
    if (result.status === 'disabled') return
    let issue: AutoSaveIssue | undefined
    let key: string | undefined
    if (result.status === 'failed') {
      // Python stages each write in a uniquely named temp. That suffix is not a different failure.
      const reason = result.reason.replace(/(kernel-state\.(?:dill|json))\.[\w-]+\.tmp/g, '$1.tmp')
        .replace(/(\.snapshot-[a-f0-9]{64}\/\.writing)-[\w-]+/g, '$1')
        .replace(/\s+/g, ' ').trim()
      key = `failed:${createHash('sha256').update(reason).digest('hex')}`
      issue = { kind: 'failed', reason: reason.length > 240 ? `${reason.slice(0, 239)}…` : reason }
    } else if (result.skippedNames.length) {
      const names = result.skippedNames.toSorted()
      key = `skipped:${createHash('sha256').update(JSON.stringify(names)).digest('hex')}`
      issue = { kind: 'skipped', count: names.length, names: names.slice(0, 3).map(name => shortName(name.replace(/\s+/g, ' '))) }
    }
    this.issue = issue
    this.#key = key
  }

  takeNotice(): string | undefined {
    const recovered = this.#reportedFailure && this.issue?.kind !== 'failed'
    const changed = this.#key !== this.#reported
    this.#reported = this.#key
    this.#reportedFailure = this.issue?.kind === 'failed'
    const messages = []
    if (recovered) messages.push('Automatic saving has resumed.')
    if (changed && this.issue) messages.push(autoSaveMessage(this.issue))
    return messages.length ? messages.join(' ') : undefined
  }
}

export function autoSaveMessage(issue: AutoSaveIssue): string {
  if (issue.kind === 'failed') return `Automatic save failed. The latest changes have not been confirmed on disk. ${issue.reason}`
  return `Automatic save skipped ${issue.count} ${issue.count === 1 ? 'name' : 'names'} in this snapshot (${issue.names.join(', ')}${issue.count > issue.names.length ? ', …' : ''}).`
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
  if (report.error) lines.push(`Restore failed: ${report.error}`)
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
export function readRestoreReport(outcome: CellOutcome): { report: RestoreReport; complete: boolean } {
  const fields = outcome.fields ?? {}
  const restoredOk = outcome.status === 'ok'
  const names = (value: unknown): string[] => (Array.isArray(value) ? value : [])
    .map((entry) => (typeof entry === 'string' ? entry : (entry as { name?: unknown })?.name))
    .filter((name): name is string => typeof name === 'string')
  const unsaved = names(fields['snapshot_skipped'])
  const error = !restoredOk || fields['reason'] === 'snapshot not found' ? String(fields['reason'] ?? outcome.status).slice(0, 240) : undefined
  const report = { restored: restoredOk ? names(fields['restored']) : [], failed: names(fields['failed']), unsaved, ...(error ? { error } : {}) }
  return { report, complete: !error && Array.isArray(fields['snapshot_skipped']) && report.failed.length === 0 }
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
