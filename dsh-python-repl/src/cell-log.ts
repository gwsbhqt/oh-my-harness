import { readFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { PanelCell, PanelGeneration } from './panel-types.ts'

const MAX_CELLS = 200
const FILE_VERSION = 1
const SAVE_DEBOUNCE_MS = 1_000
const MAX_GENERATIONS = 20
const MAX_LINE = 120
const MAX_ERROR = 240

export type CellLogView = { recordedSince: number; cells: PanelCell[]; cellsDropped: number; generations: PanelGeneration[] }

const clip = (text: string, max: number): string => text.length > max ? `${text.slice(0, max - 1)}…` : text

/**
 * What the kernel tab draws as history: cell timing, status and bridge tool
 * calls, plus kernel generations. Host memory only and bounded; it records
 * what the host itself did, never values read from the namespace.
 */
export class CellLog {
  recordedSince = Date.now()
  /** This DSH process; records kept from an earlier one carry its value, so the page can mark the restart. */
  readonly host = Date.now()
  #cells: PanelCell[] = []
  #dropped = 0
  #seq = 0
  #generations: PanelGeneration[] = []
  #tools = new WeakMap<PanelCell, Map<string, { name: string; calls: number; errors: number }>>()
  readonly #file: string | undefined
  #saveTimer: NodeJS.Timeout | undefined
  #writing: Promise<void> = Promise.resolve()
  #writes = 0

  /**
   * @param file - where the record survives a DSH restart (next to the
   *   session's snapshot); absent keeps it in memory only. A cell or kernel
   *   still open in the file was cut off by that restart.
   */
  constructor(file?: string) {
    this.#file = file
    if (file === undefined) return
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<CellLogView> & { version?: unknown; seq?: unknown }
      if (data.version !== FILE_VERSION || !Array.isArray(data.cells) || !Array.isArray(data.generations)) return
      this.#cells = data.cells.slice(-MAX_CELLS).map((cell) => cell.status === 'queued' || cell.status === 'running'
        ? { ...cell, status: 'aborted', endedAt: cell.endedAt ?? cell.startedAt ?? cell.queuedAt, error: 'DSH 重启时这一格还没结束' }
        : cell)
      this.#generations = data.generations.slice(-MAX_GENERATIONS).map((generation) => generation.endedAt === null
        ? { ...generation, endedAt: generation.startedAt, reason: 'DSH 重启' }
        : generation)
      this.#dropped = typeof data.cellsDropped === 'number' ? data.cellsDropped : 0
      this.#seq = typeof data.seq === 'number' ? data.seq : this.#cells.at(-1)?.seq ?? 0
      if (typeof data.recordedSince === 'number') this.recordedSince = data.recordedSince
    } catch {
      // No file yet, or unreadable: start empty; the next save replaces it.
    }
  }

  /** Write the record a second after the last change; best effort, never blocks a cell. */
  #changed(): void {
    if (this.#file === undefined) return
    clearTimeout(this.#saveTimer)
    this.#saveTimer = setTimeout(() => { void this.flush() }, SAVE_DEBOUNCE_MS)
    this.#saveTimer.unref?.()
  }

  /**
   * Write the record now, after any write still in flight; never rejects.
   * The session's close awaits it: the debounce timer is unref'd, so a change
   * in the last second before DSH exits would otherwise be read back as cut off.
   */
  flush(): Promise<void> {
    const file = this.#file
    if (file === undefined) return Promise.resolve()
    clearTimeout(this.#saveTimer)
    this.#saveTimer = undefined
    const body = JSON.stringify({ version: FILE_VERSION, seq: this.#seq, ...this.view() })
    const tmp = `${file}.${process.pid}.${++this.#writes}.tmp`
    this.#writing = this.#writing.then(() => mkdir(dirname(file), { recursive: true }))
      .then(() => writeFile(tmp, body)).then(() => rename(tmp, file))
      .catch(() => rm(tmp, { force: true }).catch(() => undefined))
    return this.#writing
  }

  queued(code: string): PanelCell {
    const seq = ++this.#seq
    const lines = code.split('\n')
    const first = lines.find((line) => line.trim() !== '')?.trim() ?? ''
    const cell: PanelCell = {
      id: `queued-${seq}`, seq, epoch: null, queuedAt: Date.now(), startedAt: null, endedAt: null,
      status: 'queued', firstLine: clip(first, MAX_LINE), lines: lines.length, tools: [], outputChars: null, error: null, host: this.host,
    }
    this.#cells.push(cell)
    if (this.#cells.length > MAX_CELLS) {
      this.#dropped += this.#cells.length - MAX_CELLS
      this.#cells.splice(0, this.#cells.length - MAX_CELLS)
    }
    this.#changed()
    return cell
  }

  /** The cell's code is now with the kernel. */
  running(cell: PanelCell, runId: string, epoch: number): void {
    cell.id = runId
    cell.epoch = epoch
    cell.startedAt = Date.now()
    cell.status = 'running'
    this.#changed()
  }

  /** Count one bridge call; the returned function records whether it failed. */
  tool(cell: PanelCell, name: string): (failed: boolean) => void {
    let tools = this.#tools.get(cell)
    if (tools === undefined) this.#tools.set(cell, tools = new Map())
    let entry = tools.get(name)
    if (entry === undefined) {
      tools.set(name, entry = { name, calls: 0, errors: 0 })
      cell.tools.push(entry)
    }
    entry.calls += 1
    let settled = false
    return (failed) => {
      if (settled) return
      settled = true
      if (failed) entry.errors += 1
    }
  }

  settled(cell: PanelCell, result: { logs: string[]; error?: { kind: string; message: string } } | undefined, thrown?: unknown): void {
    cell.endedAt = Date.now()
    if (result === undefined) {
      cell.status = 'error'
      cell.error = clip(String(thrown instanceof Error ? thrown.message : thrown).split('\n', 1)[0] ?? '', MAX_ERROR)
      this.#changed()
      return
    }
    cell.outputChars = result.logs.reduce((total, log) => total + log.length, 0)
    const kind = result.error?.kind
    cell.status = kind === undefined ? 'ok' : kind === 'abort' ? 'aborted' : kind === 'worker-exit' ? 'kernel-exit' : 'error'
    cell.error = result.error === undefined ? null : clip(result.error.message.split('\n', 1)[0] ?? '', MAX_ERROR)
    this.#changed()
  }

  kernelStarted(epoch: number): void {
    this.#generations.push({ epoch, startedAt: Date.now(), endedAt: null, reason: null, host: this.host })
    if (this.#generations.length > MAX_GENERATIONS) this.#generations.shift()
    this.#changed()
  }

  /** Close the newest open generation; later retire calls for the same kernel keep the first reason. */
  kernelEnded(reason: string | undefined): void {
    const current = this.#generations.at(-1)
    if (current === undefined || current.endedAt !== null) return
    current.endedAt = Date.now()
    current.reason = reason === undefined ? null : clip(reason.split('\n', 1)[0] ?? '', MAX_ERROR)
    this.#changed()
  }

  /** A copy, so a response being serialized never sees a cell change underneath it. */
  view(): CellLogView {
    return {
      recordedSince: this.recordedSince,
      cells: this.#cells.map((cell) => ({ ...cell, tools: cell.tools.map((tool) => ({ ...tool })) })),
      cellsDropped: this.#dropped,
      generations: this.#generations.map((generation) => ({ ...generation })),
    }
  }
}
