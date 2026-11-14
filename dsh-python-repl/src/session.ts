/**
 * One session's kernel + lease table: the object that actually runs a cell.
 *
 * Ownership split (technical design §3): DSH owns identity, permissions and
 * logging; this class owns the Python process, the per-cell lease, and the
 * mapping between them. It deliberately knows nothing about cordis services —
 * that keeps it unit-testable without booting a host.
 *
 * @module
 */

import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileSource } from './panel-source.ts'
import type { PanelState, PanelName, PanelPreview, PanelCell, PanelControlAction, PanelControlResult, PanelNameAction, PanelNameResult } from './panel-types.ts'
import { CellLog } from './cell-log.ts'
import { callsReport, newCall, traceNotes, withWaitCap, type CellTrace } from './cell-trace.ts'
import { withJobBash, type HostJobs } from './bash-jobs.ts'
import { waitCapFor } from './subagent.ts'
import { estimateTokens, SOFT_NOTE_EVERY, SOFT_OUTPUT_TOKENS, softOutputNote, wasCut } from './output-budget.ts'

export type PanelObservation = Omit<PanelState, 'session' | 'now' | 'snapshot' | 'recordedSince' | 'cells' | 'cellsDropped' | 'generations' | 'lifecycle'>
import { join } from 'node:path'
import { PythonKernel, type CellOutcome, type SnapshotTarget } from './kernel.ts'
import type { SkillSummary } from './skill-discovery.ts'
import { withPythonSkillDocument } from './skill-document-binding.ts'
import { asAgentRequest, asBackgroundRequest, asToolRequest, type AgentRequest, type BackgroundRequest, type HostReplyData } from './protocol.ts'
import { AgentRuns, type SubagentsLike } from './agent-runs.ts'
import { describeDenial, LeaseRegistry, type BoundTool } from './lease.ts'
import { BackgroundGrant, ToolLane, type PipelineLike } from './background-tools.ts'
import { argumentFix, catalogBindings, isCatalogBinding, TOP_LEVEL_TOOLS, type ToolSchemaLike } from './catalog.ts'
import { failedTasksNotice, foreignLanguageHint, missingModuleHint, usageHint } from './hints.ts'
import { RESTORE_TIMEOUT_MS, SNAPSHOT_DEBOUNCE_MS, SNAPSHOT_SUPPORT_TIMEOUT_MS, SNAPSHOT_TIMEOUT_MS, readRestoreReport, restoreNotice, snapshotFiles, type RestoreSummary, type RestoreReport } from './snapshot.ts'

export interface SessionOptions {
  python: string
  /** Holds the untouched upstream `rlm/` package. */
  vendorRoot: string
  /** Holds our runtime modules, and `compat/` with our half of `rlm`. */
  pythonRoot: string
  cwd?: string
  /** Skills the host found under the trusted roots; the kernel imports these and never rescans. */
  skills?: readonly SkillSummary[]
  /** Old import names used only to suggest a currently available skill. */
  skillRenames?: Readonly<Record<string, string>>
  /** Skills under those roots the user switched off (skill settings provider); never imported. */
  disabledSkills?: readonly string[]
  /**
   * Directory holding this session's namespace snapshot (`kernel-state.dill`
   * plus its `kernel-state.json` manifest, Prime's layout). Absent disables it.
   */
  statePath?: string
  /** User cells a name may go unused before it is archived / deleted (python/lifecycle.py); 0 turns that step off. Needs statePath. */
  archiveAfterCells?: number
  deleteAfterCells?: number
  /** Longest one cell waits on a bash command or a job before handing it to the background (ms); 0 = no cap. */
  cellWaitMs?: number
  /** The session is a delegated subagent (src/subagent.ts): its jobs die with its turn, so it waits in cells and is told so. */
  subagent?: boolean
  /** A subagent's raised wait cap; defaults to SUBAGENT_WAIT_MS. */
  subagentWaitMs?: number
  /**
   * The session this kernel belongs to. Passed to the kernel as
   * DSH_SESSION_ID so subprocesses (for example, dsh-use restart)
   * detach and notify the originating session exactly like a bash tool call.
   */
  sessionId?: string
  /** Total host-side ceiling for handshake and initialization. */
  startupTimeoutMs?: number
  /** Incoming frame memory ceiling; defaults to 64 MiB, not a total-output limit. */
  maxFrameBytes?: number
  /**
   * Host-side ceiling on end-of-cell cleanup. Independent of the kernel's own
   * timeout, which cannot fire while a cell blocks the event loop.
   */
  teardownGraceMs?: number
  /**
   * Optional reply-wait backstop in milliseconds; 0 (the default) disables it.
   * Human waits are owned by DSH. Expiry does not cancel the bound tool or
   * prove its outcome, and never triggers an automatic retry.
   */
  toolCallTimeoutMs?: number
  /** Bounds one cell's own output (see output-budget.ts); absent leaves it whole. */
  boundOutput?: (logs: readonly string[], runId: string) => Promise<string[]>
  /**
   * Host-side ceiling on a cancelled cell that will not stop. Counted from the
   * NEXT cell's arrival, not from the cancel: the cancel itself returns after
   * a short wait and leaves the kernel and its variables alone, as Prime does.
   * The next cell interrupts again and kills the kernel once this runs out —
   * the only bound that holds against an uninterruptible loop.
   */
  interruptGraceMs?: number
  /** DSH's public tool pipeline, for `repl.background` work calling tools after its cell (src/background-tools.ts); absent or undefined refuses those calls. */
  backgroundPipeline?: () => Promise<PipelineLike | undefined>
  /** DSH's subagent service, for `repl.agent` (src/agent-runs.ts); absent refuses those calls. */
  subagents?: () => SubagentsLike | undefined
}

/** What a cell granted, kept so `repl.background` work it starts can call the same tools once it ends. */
interface BackgroundRecipe {
  names: ReadonlySet<string>
  byName: ReadonlyMap<string, ToolSchemaLike>
  catalog: ReadonlyMap<string, BoundTool>
  /** The live agent the cell runs for; `repl.agent` children belong to it. */
  agent?: unknown
}

/** What the kernel reported about skill loading at startup. */
export interface SkillReport {
  loaded: string[]
  skills: Array<{ skill: string; status: string; reason?: string; import_name?: string | null; description?: string }>
  failed: Array<{ skill: string; reason: string }>
}

/** Prime's cap on output no cell owns, carried to the next user cell. */
const BACKGROUND_OUTPUT_CHARS = 64 * 1024

/** What the kernel reported at the end of a cell. */
interface CellTeardown {
  /** Tasks, from any cell, that ended with an error nobody retrieved. */
  failed?: string[]
  shadowed: string[]
  /** False when the kernel could not answer the end-of-cell request. */
  clean: boolean
  reason?: string
  /** Notes about this cell's code (e.g. repetition worth a function). */
  advice?: string[]
  /** Set when the cell called `repl.restart()`: why the kernel should be replaced. */
  restart?: string
}

/** What one cell produced, after mapping to the host's result shape. */
export interface CellResult {
  logs: string[]
  error?: { kind: 'exception' | 'abort' | 'worker-exit'; message: string }
}

/**
 * A session-scoped Python REPL.
 *
 * Cells run strictly serially: the kernel has one namespace and one loop, so
 * overlapping cells would interleave state. Concurrency inside a cell (via
 * `asyncio.gather`) is unaffected.
 */
export class ReplSession {
  #queuedCells = 0
  #panelCounter = 0
  /** Kernel-tab history; never read back by the kernel or the model. */
  readonly cellLog: CellLog
  #cellsByRun = new Map<string, PanelCell>()
  readonly #recipes = new Map<string, BackgroundRecipe>()
  /** Background tool calls DSH marks exclusive run one at a time in this session. */
  readonly #toolLane = new ToolLane()
  #panelRead: Promise<PanelObservation> | undefined
  #panelCache: PanelObservation | undefined
  #previewPending: Promise<Omit<PanelPreview, 'session'>> | undefined

  /** Never starts a kernel, runs a cell, grants tools, or interrupts user work. */
  async panelPreview(name: string, epoch: number): Promise<Omit<PanelPreview, 'session'>> {
    const base = { name, epoch }
    const kernel = this.#kernel
    if (epoch !== this.#epoch) return { ...base, status: 'stale', reason: '内核已更换，请刷新变量列表' }
    if (!name || name.length > 256 || !Number.isSafeInteger(epoch)) return { ...base, status: 'error', reason: '预览参数无效' }
    if (kernel === undefined || !kernel.ready || this.#disposed) return { ...base, status: 'not-started', reason: '内核尚未启动' }
    if (this.#queuedCells > 0 || this.#starting !== undefined || this.#previewPending !== undefined || this.#controlPending !== undefined) {
      return { ...base, status: 'busy', reason: '内核忙碌，稍后可重试' }
    }
    const pending = (async (): Promise<Omit<PanelPreview, 'session'>> => {
      try {
        const outcome = await kernel.previewName(`preview-${epoch}-${++this.#panelCounter}`, name, epoch)
        if (kernel !== this.#kernel || !kernel.ready) return { ...base, status: 'kernel-exit', reason: '内核已结束' }
        if (epoch !== this.#epoch) return { ...base, status: 'stale', reason: '内核已更换，请刷新变量列表' }
        const preview = outcome.fields?.['preview'] as Omit<PanelPreview, 'session' | 'name' | 'epoch'> | undefined
        if (outcome.status !== 'ok' || preview === undefined || !['ok', 'missing', 'stale', 'error', 'timeout'].includes(preview.status)
          || Buffer.byteLength(JSON.stringify(preview), 'utf8') > 40 * 1024) {
          return { ...base, status: 'error', reason: '内核未返回有效预览' }
        }
        const result = await withFileSource(preview)
        if (kernel !== this.#kernel || epoch !== this.#epoch || !kernel.ready) return { ...base, status: 'stale', reason: '内核已更换，请刷新变量列表' }
        return { ...result, ...base }
      } catch { return { ...base, status: 'error', reason: '读取预览失败' } }
    })()
    this.#previewPending = pending
    // Keep the slot through the real Python reply and fd.close, even after the
    // HTTP deadline or client cancellation. Neither may interrupt the kernel.
    void pending.then(() => { if (this.#previewPending === pending) this.#previewPending = undefined })
    let timer: NodeJS.Timeout | undefined
    try {
      return await Promise.race([pending, new Promise<Omit<PanelPreview, 'session'>>((resolve) => {
        timer = setTimeout(() => resolve({ ...base, status: 'timeout', reason: '读取预览超时，稍后可重试' }), 500)
      })])
    } finally { clearTimeout(timer) }
  }


  /** Does not enqueue behind user code, start a kernel, execute, or interrupt it. */
  async panelObservation(): Promise<PanelObservation> {
    const kernel = this.#kernel
    const epoch = this.#epoch
    const current = (): PanelObservation => ({
      epoch, alive: kernel?.alive === true, started: kernel?.ready === true,
      busy: this.#queuedCells > 0 || this.#starting !== undefined || this.#controlPending !== undefined,
      python: kernel?.pythonVersion || null, executable: null, cwd: null,
      skillReport: this.#skillReport ?? null, observedAt: null,
      namespaceStatus: 'unavailable', namespaceReason: 'not-started',
      names: [], total: null, complete: false, scope: 'top-level-excluding-dunder',
    })
    const stale = (reason: PanelObservation['namespaceReason'], error?: string): PanelObservation => {
      const base = current()
      const cache = this.#panelCache?.epoch === epoch ? this.#panelCache : undefined
      return { ...(cache ?? base), ...base,
        executable: cache?.executable ?? null, cwd: cache?.cwd ?? null,
        observedAt: cache?.observedAt ?? null, names: cache?.names ?? [],
        total: cache?.total ?? null, complete: cache?.complete ?? false,
        namespaceStatus: cache === undefined ? 'unavailable' : 'cached', namespaceReason: reason,
        ...(error === undefined ? {} : { error }),
      }
    }
    if (kernel === undefined || !kernel.ready || this.#disposed) return stale('not-started')
    if (current().busy) return stale('busy')
    if (this.#panelRead !== undefined) return this.#panelRead
    const work = (async (): Promise<PanelObservation> => {
      const outcome = await kernel.listNames(`panel-${epoch}-${++this.#panelCounter}`, 250)
      if (kernel !== this.#kernel || !kernel.ready) return stale('kernel-exit')
      if (outcome.fields?.['timeout'] === true) return stale('timeout')
      if (outcome.status !== 'ok') return stale('error', outcome.error?.evalue ?? outcome.status)
      const fields = outcome.fields
      const info = fields?.['info'] as Record<string, unknown> | undefined
      const names = fields?.['metadata'] as PanelName[] | undefined
      if (info === undefined || !Array.isArray(names) || fields?.['complete'] !== true
        || fields?.['total'] !== names.length || fields?.['scope'] !== 'top-level-excluding-dunder'
        || typeof info['python'] !== 'string' || typeof info['executable'] !== 'string'
        || typeof info['cwd'] !== 'string' || info['epoch'] !== epoch) {
        return stale('error', 'kernel did not return complete panel metadata')
      }
      const result: PanelObservation = { ...current(), python: info['python'],
        executable: info['executable'], cwd: info['cwd'], observedAt: Date.now(),
        namespaceStatus: 'live', namespaceReason: null, names, total: names.length, complete: true }
      this.#panelCache = result
      return result
    })()
    this.#panelRead = work
    try { return await work } finally { if (this.#panelRead === work) this.#panelRead = undefined }
  }

  #controlPending: Promise<unknown> | undefined

  /**
   * Start, stop, restart or reset on an explicit click in the kernel tab.
   * Refused while a cell, a start or another action is in flight: a click
   * must never cut a model's cell short. Queued behind cells like a snapshot,
   * so a cell that arrives meanwhile runs after it on whatever kernel it left.
   */
  /** When the last cell, panel action or preview ended; an idle kernel is stopped after `idleMinutes` (see reclaimIfIdle). */
  #lastActivity = Date.now()

  /**
   * Stop the kernel after it has been idle `idleMs` to free its memory; the
   * next cell starts a new one that restores the snapshot. Only when nothing
   * would be lost: no cell queued or starting, no repl.background job, a
   * snapshot that saved every name, and nothing still running inside the
   * kernel (tasks, threads, child processes). Returns why it was kept, or
   * undefined once stopped.
   */
  async reclaimIfIdle(idleMs: number): Promise<string | undefined> {
    const kernel = this.#kernel
    if (kernel?.ready !== true || this.#disposed) return 'no kernel running'
    if (Date.now() - this.#lastActivity < idleMs) return 'not idle long enough'
    if (this.#queuedCells > 0 || this.#starting !== undefined || this.#controlPending !== undefined || this.#previewPending !== undefined) return 'busy'
    if (this.#backgroundJobs.size > 0) return 'repl.background work still running'
    if (this.#agentRuns.size > 0) return 'repl.agent children still running'
    if (!this.#snapshotsOn || this.#restoreIncomplete) return 'its variables could not all be restored afterwards'
    const work = this.#queue.then(async (): Promise<string | undefined> => {
      if (kernel !== this.#kernel || !kernel.ready) return 'kernel changed'
      const outcome = await this.#withDeadline(kernel.execute(`idle-${this.#epoch}-${++this.#panelCounter}`,
        'print(__import__("json").dumps({"blockers": __import__("idle").blockers()}))'), SNAPSHOT_TIMEOUT_MS)
      if (outcome === TIMED_OUT) { kernel.interrupt(`idle-${this.#epoch}-${this.#panelCounter}`); return 'the kernel did not answer' }
      const found = (parseJsonLine(outcome.logs) as { blockers?: unknown } | undefined)?.blockers
      // No readable answer is a reason to keep the kernel, never to stop it.
      const reasons = outcome.status === 'ok' && Array.isArray(found) ? found : ['the idle check did not answer']
      if (reasons.length > 0) return reasons.join('; ')
      clearTimeout(this.#snapshotTimer)
      this.#snapshotTimer = undefined
      this.#dirty = true
      await this.#captureSnapshot(kernel)
      if (this.#dirty) return 'the snapshot could not be saved'
      const target = this.#snapshotTarget()
      const skipped = target === undefined ? [] : await readSkipped(target.manifestPath)
      if (skipped.length > 0) return `the snapshot could not hold ${skipped.slice(0, 5).join(', ')}`
      const minutes = Math.round((Date.now() - this.#lastActivity) / 60_000)
      this.cellLog.kernelEnded(`闲置 ${minutes} 分钟后自动关闭`)
      await this.#retireKernel(`The Python kernel was stopped after ${minutes} minutes idle to free memory; this cell runs on a new kernel `
        + 'with the variables saved when it stopped. Files and packages installed with repl.install stay.')
      return undefined
    })
    this.#queue = work.catch(() => undefined)
    this.#controlPending = work
    try {
      return await work
    } catch (error) {
      return errorMessage(error)
    } finally {
      if (this.#controlPending === work) this.#controlPending = undefined
    }
  }

  async panelControl(action: PanelControlAction): Promise<PanelControlResult> {
    const refuse = (reason: string): PanelControlResult => ({ action, ok: false, epoch: this.#epoch, reason })
    if (this.#disposed) return refuse('这个会话已经关闭')
    if (this.#controlPending !== undefined) return refuse('上一个操作还没完成')
    if (this.#queuedCells > 0 || this.#starting !== undefined) return refuse('内核正在执行代码，等这一格结束再操作')
    const work = this.#queue.then(() => this.#control(action))
    this.#queue = work.catch(() => undefined)
    this.#controlPending = work
    try {
      return await work
    } catch (error) {
      return refuse(errorMessage(error))
    } finally {
      if (this.#controlPending === work) this.#controlPending = undefined
    }
  }

  /** Pin, unpin, bring back or archive one name from the kernel tab; same rules as panelControl. */
  async panelNameAction(action: PanelNameAction, name: string): Promise<PanelNameResult> {
    const refuse = (reason: string): PanelNameResult => ({ action, name, ok: false, reason })
    if (this.#disposed) return refuse('这个会话已经关闭')
    if (this.#controlPending !== undefined) return refuse('上一个操作还没完成')
    if (this.#queuedCells > 0 || this.#starting !== undefined) return refuse('内核正在执行代码，等这一格结束再操作')
    if (this.#kernel?.ready !== true) return refuse('内核没有在运行，先启动内核')
    const work = this.#queue.then(async (): Promise<PanelControlResult> => {
      const kernel = this.#kernel
      if (kernel?.ready !== true) return { action: 'start', ok: false, epoch: this.#epoch, reason: '内核没有在运行，先启动内核' }
      const outcome = await this.#withDeadline(kernel.execute(`lifecycle-${this.#epoch}-${++this.#panelCounter}`,
        `print(__import__("json").dumps(__import__("lifecycle").op(${JSON.stringify(action)}, ${JSON.stringify(name)})))`), SNAPSHOT_TIMEOUT_MS)
      if (outcome === TIMED_OUT) return { action: 'start', ok: false, epoch: this.#epoch, reason: '内核没有及时回应' }
      const reply = parseJsonLine(outcome.logs) as { ok?: unknown; reason?: unknown } | undefined
      if (outcome.status !== 'ok' || reply === undefined) {
        return { action: 'start', ok: false, epoch: this.#epoch, reason: outcome.error === undefined ? '内核没有给出结果' : `${outcome.error.ename}: ${outcome.error.evalue}` }
      }
      // An archive changes what the next snapshot holds; save it like after a cell.
      if (this.#snapshotsOn) { this.#dirty = true; this.#scheduleSnapshot() }
      return { action: 'start', ok: reply.ok === true, epoch: this.#epoch, ...(typeof reply.reason === 'string' ? { reason: reply.reason } : {}) }
    })
    this.#queue = work.catch(() => undefined)
    this.#controlPending = work
    try {
      const result = await work
      return { action, name, ok: result.ok, ...(result.reason === undefined ? {} : { reason: result.reason }) }
    } catch (error) {
      return refuse(errorMessage(error))
    } finally {
      if (this.#controlPending === work) this.#controlPending = undefined
    }
  }

  /** Ask the restored kernel for the short restore summary; undefined keeps the plain name list. */
  async #restoreSummary(kernel: PythonKernel, restored: readonly string[]): Promise<RestoreSummary | undefined> {
    if (restored.length === 0) return undefined
    const names = JSON.stringify(JSON.stringify(restored))
    const outcome = await this.#withDeadline(kernel.execute(`lifecycle-restore-${this.#epoch}`,
      `print(__import__("json").dumps(__import__("lifecycle").after_restore(__import__("json").loads(${names}))))`), SNAPSHOT_SUPPORT_TIMEOUT_MS)
    if (outcome === TIMED_OUT || outcome.status !== 'ok') return undefined
    const summary = parseJsonLine(outcome.logs) as RestoreSummary | undefined
    return typeof summary?.total === 'number' && Array.isArray(summary.functions) ? summary : undefined
  }

  async #control(action: PanelControlAction): Promise<PanelControlResult> {
    const done = (reason?: string): PanelControlResult => ({ action, ok: true, epoch: this.#epoch, ...(reason === undefined ? {} : { reason }) })
    if (this.#disposed) return { action, ok: false, epoch: this.#epoch, reason: '这个会话已经关闭' }
    const kernel = this.#kernel
    if (action === 'start') {
      if (kernel?.ready === true) return done('内核已经在运行')
      await this.#ensureStarted(new Map())
      return done()
    }
    if (action === 'stop') {
      if (kernel === undefined) return done('内核没有在运行')
      await this.#stopFromPanel(kernel, '在内核页手动关闭',
        `The user stopped the Python kernel from the kernel tab. ${this.#lossTail()}`)
      return done()
    }
    if (action === 'restart') {
      if (kernel !== undefined) {
        await this.#stopFromPanel(kernel, '在内核页手动重启',
          'The user restarted the Python kernel from the kernel tab; this cell runs on the new kernel.')
      }
      await this.#ensureStarted(new Map())
      return done()
    }
    // reset: nothing of the old namespace may come back, so no save and no snapshot left behind.
    clearTimeout(this.#snapshotTimer)
    this.#snapshotTimer = undefined
    this.#dirty = false
    if (kernel !== undefined) {
      await this.#stopFromPanel(kernel, '在内核页手动重置',
        'The user reset the Python kernel from the kernel tab: all variables and functions are gone and the saved '
        + 'snapshot was deleted. Files already written and DSH jobs already started are unaffected.', false)
    }
    const target = this.#snapshotTarget()
    if (target !== undefined) {
      const dir = dirname(target.path)
      await Promise.all([rm(target.path, { force: true }), rm(target.manifestPath, { force: true }),
        rm(join(dir, 'lifecycle.json'), { force: true }), rm(join(dir, 'archive'), { recursive: true, force: true })])
    }
    this.#restoreIncomplete = false
    await this.#ensureStarted(new Map())
    return done()
  }

  /** Save first unless resetting (and never over a fuller file), then retire with a note the next cell reads. */
  async #stopFromPanel(kernel: PythonKernel, label: string, notice: string, save = true): Promise<void> {
    if (save && kernel.ready && !this.#restoreIncomplete) {
      clearTimeout(this.#snapshotTimer)
      this.#snapshotTimer = undefined
      await this.#captureSnapshot(kernel)
    }
    this.cellLog.kernelEnded(label)
    await this.#retireKernel(notice)
  }

  #kernel: PythonKernel | undefined
  #starting: Promise<void> | undefined
  /**
   * The kernel between spawn and publication. It is owned by the session from
   * the moment it exists, so a close during the handshake or bootstrap can
   * stop it (it used to live only in a local variable, out of dispose()'s reach).
   */
  #startingKernel: PythonKernel | undefined
  /** The one shutdown every dispose() call awaits, so a second close is never a no-op on a live process. */
  #disposing: Promise<void> | undefined
  #epoch = 0
  #cellCounter = 0
  #queue: Promise<unknown> = Promise.resolve()
  #disposed = false
  readonly #leases = new LeaseRegistry()
  readonly #options: SessionOptions
  /** Set once the kernel dies with state the model was relying on. */
  #stateLossNotice: string | undefined
  /** Output no cell owns, shown after the next user cell's own output (Prime's background output). */
  #backgroundOutput = ''
  #backgroundTruncated = false
  /** Skill load result from the most recent bootstrap. */
  #skillReport: SkillReport | undefined
  /** What the newest kernel restored at boot, told once to the first cell on it. */
  #restoreNotice: string | undefined
  /** Why the newest kernel cannot snapshot (no `dill`), or undefined when it can. */
  #snapshotUnavailable: string | undefined
  /** A successful cell settled since the last committed snapshot. */
  #dirty = false
  #snapshotTimer: NodeJS.Timeout | undefined
  #snapshotCounter = 0
  /**
   * The restore failed or left names out: the file on disk is the fuller copy,
   * so closing the session must not overwrite it (Prime's restore_incomplete).
   */
  #restoreIncomplete = false
  /** The user cell currently executing, so a closing session can interrupt it before its final snapshot. */
  #activeRunId: string | undefined
  /**
   * Why the last kernel was retired, delivered ONCE to the next cell.
   *
   * Retirement means "that kernel is gone and your variables with it" — the
   * same class of event as a crash, which already recovers by lazily starting
   * a fresh kernel. It must not mean "this session is over": under PTC
   * `run_code` is the agent's only tool, so refusing every later cell ends the
   * session outright. A real session hit exactly that on 2026-09-22: six
   * cells over several minutes all came back with the same message.
   */
  #retirementNotice: string | undefined
  readonly #teardownGraceMs: number
  readonly #interruptGraceMs: number
  readonly #toolCallTimeoutMs: number
  /**
   * In-flight retirement, so every path can AWAIT the same shutdown instead of
   * racing it. Without this, `runCell` could return while the kernel process
   * was still dying.
   */
  #retiring: Promise<void> | undefined
  /** The kernel `#retiring` is stopping. */
  #retiringKernel: PythonKernel | undefined
  /**
   * A cancelled cell that had not stopped when its caller got the cancellation
   * back. The kernel may still be running it; the next cell reclaims it.
   */
  #abandoned: Promise<CellResult> | undefined
  /** The kernel's names when the context was last compacted, and on which kernel. */
  #compactionNames: Promise<{ epoch: number; names: string[] } | undefined> | undefined
  /** The replaced system names last reported, so the notice is not repeated every cell. */
  #reportedShadowed = ''
  /**
   * Kernels whose termination could not be confirmed. Held so dispose() can
   * retry them; never handed another cell. Removed once they really exit.
   */
  readonly #unterminated = new Set<PythonKernel>()
  /** One-shot notes for the next cell: a previous process may still be running. */
  #terminationNotes: string[] = []
  /** Tool names currently installed as Python proxies. */
  readonly #installedTools = new Set<string>()
  /** The session's working directory as DSH last reported it; the session can cd after the kernel starts. */
  #cwd: string | undefined
  /** Where the current kernel was last moved to by the host, so a cell's own os.chdir survives until DSH's directory changes. */
  #kernelCwd: string | undefined
  /** Pending bridge replies, not a registry of running DSH effects. */
  /** Bridge calls of each running cell, for the failure report and the cell-end notes. */
  readonly #traces = new Map<string, CellTrace>()
  /** Cells since the last soft note on a large output. */
  #sinceSoftNote = SOFT_NOTE_EVERY
  readonly #pendingToolCalls = new Map<string, {
    runId: string
    /** Set when the call went through a background job's grant: it outlives its cell and ends with the job. */
    jobId?: string
    timer: NodeJS.Timeout | undefined
  }>()

  #clearToolReplies(runId?: string): void {
    for (const [id, pending] of this.#pendingToolCalls) {
      if (runId !== undefined && (pending.runId !== runId || pending.jobId !== undefined)) continue
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      this.#pendingToolCalls.delete(id)
    }
  }

  #revoke(runId: string): void {
    this.#leases.revoke(runId)
    this.#clearToolReplies(runId)
    void this.#agentRuns.stopOwner(`cell:${runId}`)
  }

  constructor(options: SessionOptions) {
    this.#options = options
    this.cellLog = new CellLog(options.statePath === undefined ? undefined : join(options.statePath, 'cell-log.json'))
    this.#teardownGraceMs = options.teardownGraceMs ?? 5_000
    this.#interruptGraceMs = options.interruptGraceMs ?? 5_000
    this.#toolCallTimeoutMs = options.toolCallTimeoutMs ?? 0
  }

  get epoch(): number {
    return this.#epoch
  }

  get started(): boolean {
    return this.#kernel?.ready === true
  }

  get pythonVersion(): string | undefined {
    return this.#kernel?.pythonVersion
  }

  /** Whether this session currently owns a live kernel process. */
  get kernelAlive(): boolean {
    return this.#kernel?.alive === true
  }

  /**
   * Ask the kernel which names it holds, right after a context compaction.
   * The summary drops the cells that made them, and a model that cannot see a
   * variable reads or fetches its data again (Prime tells the model the same).
   */
  noteCompaction(): void {
    const kernel = this.#kernel
    if (kernel === undefined || !kernel.ready || this.#disposed) return
    const epoch = this.#epoch
    const task = this.#queue.then(async () => {
      if (kernel !== this.#kernel || !kernel.ready) return undefined
      const id = `names-${epoch}-${++this.#snapshotCounter}`
      const outcome = await this.#withDeadline(kernel.listNames(id), SNAPSHOT_TIMEOUT_MS)
      if (outcome === TIMED_OUT) kernel.interrupt(id)
      if (outcome === TIMED_OUT || outcome.status !== 'ok') return undefined
      const names = outcome.fields?.['names']
      return Array.isArray(names) ? { epoch, names: names.filter((n): n is string => typeof n === 'string') } : undefined
    })
    this.#queue = task.catch(() => undefined)
    this.#compactionNames = task.catch(() => undefined)
  }

  /** Subagents this session's cells started (newest last, bounded), for the unfinished-work list at compaction. */
  readonly subagentsStarted: Array<{ id: string; label: string }> = []
  /** Background jobs and subagents still running at the last compaction (src/index.ts records it). */
  unfinishedAtCompaction: { jobs: Array<{ id: string; label: string }>; subagents: Array<{ id: string; label: string }> } | undefined
  /** The agent that owns this session's jobs, as of the latest cell. */
  get jobOwner(): string | undefined {
    return this.#lastHost?.owner
  }

  /** Names recorded at the last compaction, if they arrive within `waitMs`. */
  async compactionNames(waitMs: number): Promise<{ epoch: number; names: string[] } | undefined> {
    const pending = this.#compactionNames
    if (pending === undefined) return undefined
    const got = await this.#withDeadline(pending, waitMs)
    return got === TIMED_OUT ? undefined : got
  }

  /** What loaded, what did not, and why. Undefined until the kernel starts. */
  get skillReport(): SkillReport | undefined {
    return this.#skillReport
  }

  /**
   * A pending one-shot notice that the namespace was lost. Consumed when read.
   *
   * Covers both ways a kernel can go: it exited on its own, or the host
   * retired it because teardown could not finish. Either way the next cell
   * runs on a fresh kernel and must be told what it lost — once,
   * not on every cell from then on.
   */
  takeStateLossNotice(): string | undefined {
    const parts = [this.#retirementNotice ?? this.#stateLossNotice, ...this.#terminationNotes]
      .filter((part): part is string => part !== undefined)
    this.#retirementNotice = undefined
    this.#stateLossNotice = undefined
    this.#terminationNotes = []
    return parts.length === 0 ? undefined : parts.join(' ')
  }

  /** Pids of earlier kernels whose exit is still unconfirmed. They are never reused. */
  get unterminatedPids(): number[] {
    return [...this.#unterminated].map((kernel) => kernel.pidSnapshot).filter((pid): pid is number => pid !== undefined)
  }

  /**
   * A kernel could not be confirmed stopped: keep it for a later retry, never
   * reuse it, and tell the next cell the truth — the process may be alive.
   */
  #recordTerminationFailure(kernel: PythonKernel, error: unknown): void {
    if (kernel.exitInfo !== undefined || this.#unterminated.has(kernel)) return
    this.#unterminated.add(kernel)
    void kernel.exited.then(() => { this.#unterminated.delete(kernel) })
    const pid = kernel.pidSnapshot
    this.#terminationNotes.push(
      `The previous Python kernel${pid === undefined ? '' : ` (pid ${pid})`} could not be confirmed stopped `
      + `(${errorMessage(error)}). It may still be running and using memory or CPU; it will not be used again. `
      + 'Closing this session retries stopping it'
      + (pid === undefined ? '.' : `; if it persists, end it with: kill -9 ${pid}.`),
    )
  }

  /** Terminate one kernel; a failure is recorded, never thrown, so no caller can hang or leak a rejection. */
  async #stopKernel(kernel: PythonKernel, reason: string): Promise<void> {
    try {
      await kernel.terminate(reason)
    } catch (error) {
      this.#recordTerminationFailure(kernel, error)
    }
  }

  /** Retire without awaiting: the outcome is recorded, never an unhandled rejection. */
  #retireInBackground(reason: string): void {
    this.#retireKernel(reason).catch((error: unknown) => {
      this.#terminationNotes.push(`Retiring the previous Python kernel failed unexpectedly (${errorMessage(error)}); it will not be used again.`)
    })
  }

  /** How long one cell waits on a command or job: cellWaitMs, raised in a subagent. */
  #waitCap(): number {
    return waitCapFor(this.#options.cellWaitMs ?? DEFAULT_CELL_WAIT_MS, this.#options.subagent === true, this.#options.subagentWaitMs)
  }

  /**
   * Run one cell. Serialized against other cells on this session.
   * @param code - the cell source, as the model wrote it.
   * @param tools - the exact bound tool functions PTC supplied for THIS call.
   * @param signal - the host's cancellation for this call.
   */
  async runCell(
    code: string,
    tools: Map<string, BoundTool>,
    signal?: AbortSignal,
    schemas: readonly ToolSchemaLike[] = [],
    cwd?: string,
    host?: HostJobs,
  ): Promise<CellResult> {
    const byName = new Map(schemas.map((schema) => [schema.name, schema]))
    if (host !== undefined) this.#lastHost = host
    const bound = new Map<string, BoundTool>()
    // Argument rejections name only what is missing; add the rename the
    // model actually needs, from this cell's own schema.
    for (const [name, fn] of tools) {
      if (!isCatalogBinding(name)) {
        const cap = this.#waitCap()
        const fixed = withArgumentFix(name, withPythonSkillDocument(name, fn, this.#options.skills ?? []), byName.get(name)?.parameters)
        const capped = withWaitCap(name, fixed, byName.get(name), cap)
        bound.set(name, name === 'bash' ? withJobBash(fixed, byName.get(name), cap, host, signal, capped)
          : host === undefined ? capped : withCollected(name, capped, host))
      }
    }
    // Meta lookups run against the SAME per-cell grant as business calls, so
    // the catalog can never describe something this call may not invoke.
    const catalog = new Map(catalogBindings(tools.keys(), schemas))
    for (const [name, fn] of catalog) bound.set(name, fn)
    const background: BackgroundRecipe = { names: new Set([...tools.keys()].filter((name) => !isCatalogBinding(name))), byName, catalog, ...(host?.agent === undefined ? {} : { agent: host.agent }) }
    return this.#enqueue(code, bound, signal, cwd, background)
  }

  #enqueue(
    code: string,
    tools: Map<string, BoundTool>,
    signal?: AbortSignal,
    cwd?: string,
    background?: BackgroundRecipe,
  ): Promise<CellResult> {
    this.#reclaimAbandoned()
    this.#queuedCells += 1
    const cell = this.cellLog.queued(code)
    const task = this.#queue.then(() => this.#runCellExclusive(code, tools, signal, cwd, cell, background))
      .then((result) => { this.cellLog.settled(cell, result); return result }, (error: unknown) => { this.cellLog.settled(cell, undefined, error); throw error })
      .finally(() => { this.#queuedCells -= 1; this.#lastActivity = Date.now() })
    // Keep the chain alive even when a cell rejects.
    this.#queue = task.catch(() => undefined)
    return this.#returnOnCancel(task, signal)
  }

  /**
   * Prime's cancel: give the interrupted cell ABORT_RETURN_MS to stop, then
   * answer the caller while the kernel keeps running it with its state intact.
   */
  #returnOnCancel(task: Promise<CellResult>, signal?: AbortSignal): Promise<CellResult> {
    if (signal === undefined) return task
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined
      const onAbort = (): void => {
        timer = setTimeout(() => {
          this.#abandoned = task
          void task.catch(() => undefined).finally(() => { if (this.#abandoned === task) this.#abandoned = undefined })
          resolve({ logs: [], error: { kind: 'abort', message: 'cell was cancelled; it had not stopped yet and keeps running until the next cell' } })
        }, ABORT_RETURN_MS)
        timer.unref?.()
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
      task.then(resolve, reject).finally(() => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      })
    })
  }

  /**
   * The next cell is here while a cancelled one still holds the kernel:
   * interrupt it again every INTERRUPT_REPEAT_MS (a cell can swallow one
   * KeyboardInterrupt), and kill the kernel if it has not stopped within
   * interruptGraceMs. The new kernel restores the last snapshot.
   */
  #reclaimAbandoned(): void {
    const abandoned = this.#abandoned
    if (abandoned === undefined) return
    this.#abandoned = undefined
    const kernel = this.#kernel
    const interrupt = (): void => { if (this.#activeRunId !== undefined) kernel?.interrupt(this.#activeRunId) }
    interrupt()
    const repeat = setInterval(interrupt, INTERRUPT_REPEAT_MS)
    const kill = setTimeout(() => {
      void this.#retireKernel(
        'The Python kernel was terminated because a cancelled cell was still running '
        + `${this.#interruptGraceMs}ms after the next cell arrived. ${this.#lossTail()}`,
      )
    }, this.#interruptGraceMs)
    repeat.unref?.()
    kill.unref?.()
    void abandoned.catch(() => undefined).finally(() => {
      clearInterval(repeat)
      clearTimeout(kill)
    })
  }

  async #runCellExclusive(
    code: string,
    tools: Map<string, BoundTool>,
    signal?: AbortSignal,
    cwd?: string,
    cell?: PanelCell,
    background?: BackgroundRecipe,
  ): Promise<CellResult> {
    if (cwd !== undefined) this.#cwd = cwd
    if (this.#disposed) {
      return { logs: [], error: { kind: 'worker-exit', message: 'session disposed' } }
    }
    // Cancellation is checked at EVERY gate, not just via the abort listener:
    // a signal aborted while this cell was queued has already fired its event,
    // so a listener registered later never hears it.
    if (signal?.aborted) return abortedResult()
    // Listen BEFORE starting: a handshake, a slow skill import or a state
    // restore can each take seconds, and a cancel must stop the process
    // now rather than after it finishes (a slow skill import alone was measured at 2.4 s).
    const onStartAbort = (): void => {
      this.#leases.revokeAll()
      this.#clearToolReplies()
      // No user cell exists yet, so there is no cooperative cell to preserve.
      const starting = this.#startingKernel
      if (starting !== undefined) void this.#stopKernel(starting, 'cell cancelled while the kernel was starting')
    }
    signal?.addEventListener('abort', onStartAbort, { once: true })
    try {
      await this.#ensureStarted(tools, signal)
    } catch (error) {
      if (signal?.aborted) return abortedResult()
      if (this.#disposed) return disposedResult()
      // A kernel that cannot start is a FAILED CELL, not a thrown host error:
      // CodeRuntime.run promises that program and substrate failures resolve
      // as `result.error`, and only contract misuse rejects.
      return {
        logs: [],
        error: {
          kind: 'worker-exit',
          message: error instanceof Error ? error.message : String(error),
        },
      }
    } finally {
      signal?.removeEventListener('abort', onStartAbort)
    }
    // Starting a kernel can take seconds; the session may have closed and the
    // caller may have given up. Neither may still be granted execution.
    if (this.#disposed) return disposedResult()
    if (signal?.aborted) return abortedResult()
    const kernel = this.#kernel
    if (kernel === undefined || !kernel.ready) {
      return { logs: [], error: { kind: 'worker-exit', message: 'kernel is not running' } }
    }
    this.#cellCounter += 1
    const runId = `cell-${this.#epoch}-${this.#cellCounter}`
    this.#leases.grant(runId, this.#epoch, tools)
    if (background !== undefined) this.#recipes.set(runId, background)

    // On abort: revoke authority FIRST (a cell that catches the interrupt must
    // not still reach its tools), then ask Python to stop. A cell that does
    // not stop is reclaimed by the next one (#reclaimAbandoned).
    const onAbort = (): void => {
      this.#revoke(runId)
      kernel.interrupt(runId)
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    try {
      // Tool visibility is per call: refresh the Python surface to match the
      // bindings THIS cell received before running user code.
      await this.#syncTools(kernel, runId, tools)
      const moveFailure = await this.#syncCwd(kernel, runId)
      if (moveFailure !== undefined) return { logs: [], error: { kind: 'exception', message: moveFailure } }
      if (this.#disposed) return disposedResult()
      if (signal?.aborted) return abortedResult()
      this.#activeRunId = runId
      if (cell !== undefined) {
        this.cellLog.running(cell, runId, this.#epoch)
        this.#cellsByRun.set(runId, cell)
      }
      const trace: CellTrace = { calls: [], startedAt: Date.now() }
      this.#traces.set(runId, trace)
      const executed = await kernel.execute(runId, code)
      trace.endedAt = Date.now()
      this.#activeRunId = undefined
      const outcome = this.#options.boundOutput === undefined
        ? executed
        : { ...executed, logs: await this.#options.boundOutput(executed.logs, runId) }
      // Revoke BEFORE teardown runs: teardown is itself a kernel request, and
      // a task still running during it must not hold this cell's authority.
      this.#revoke(runId)
      if (outcome.status === 'kernel-exit' && kernel.exitInfo !== undefined) {
        // There is nothing left to clean up, and the teardown path would blame
        // "work that could not be stopped" for what was really a dead process.
        return this.#kernelDied(kernel, outcome)
      }
      // Only a successful cell's code is analysed: a retry after a failure
      // is not repetition.
      const ok = outcome.status === 'ok' && !(signal?.aborted ?? false)
      const cut = wasCut(outcome.logs)
      const teardown = await this.#endCell(kernel, runId, ok ? code : undefined, cut)
      if (!teardown.clean) {
        const reason = `The Python kernel was retired because it stopped responding after this cell: `
          + `${teardown.reason ?? 'cleanup did not complete'}. ${this.#lossTail()}`
        // This cell's error says why; #retireKernel also leaves the reason
        // for the next cell, which runs on the new kernel.
        await this.#retireKernel(reason)
        return this.#toResult(outcome, teardown, signal?.aborted ?? false, reason, code, this.#traces.get(runId))
      }
      const result = this.#toResult(outcome, teardown, signal?.aborted ?? false, undefined, code, this.#traces.get(runId))
      this.#sinceSoftNote += 1
      if (!cut && this.#sinceSoftNote >= SOFT_NOTE_EVERY) {
        const tokens = estimateTokens(executed.logs.join('\n'))
        if (tokens >= SOFT_OUTPUT_TOKENS) {
          result.logs.push(softOutputNote(tokens))
          this.#sinceSoftNote = 0
        }
      }
      // Why the previous kernel ended goes right before what the new one
      // restored, so the last word is what exists now. A loss with nothing
      // restored waits for a cell without its own error to explain.
      if (this.#restoreNotice !== undefined || result.error === undefined) {
        const loss = this.takeStateLossNotice()
        if (loss !== undefined) result.logs.push(`[dsh-python-repl] ${loss}`)
      }
      if (this.#restoreNotice !== undefined) {
        result.logs.push(this.#restoreNotice)
        this.#restoreNotice = undefined
      }
      // Any user cell may have changed the namespace (Prime counts failed ones
      // too for the final snapshot); only a successful one schedules a save.
      if (this.#snapshotsOn) this.#dirty = true
      if (ok && result.error === undefined) this.#scheduleSnapshot()
      if (teardown.restart !== undefined) {
        // Asked for, so no state-loss notice for the next cell: this cell's
        // own output already says what happens. Save first, so the new
        // kernel restores this cell's end state, not the last debounce.
        clearTimeout(this.#snapshotTimer)
        await this.#captureSnapshot(kernel)
        await this.#retireKernel()
        result.logs.push(
          `[dsh-python-repl] Kernel restarted as requested (${teardown.restart}). The next cell runs on a fresh kernel`
          + (this.#snapshotsOn ? ' with the variables saved at the end of this cell' : '; variables are gone')
          + '; files and packages installed with repl.install stay.',
        )
      }
      return result
    } finally {
      this.#revoke(runId)
      this.#cellsByRun.delete(runId)
      this.#traces.delete(runId)
      this.#recipes.delete(runId)
      signal?.removeEventListener('abort', onAbort)
      // Corrupt frames, failed reply delivery and a reclaimed cancelled cell
      // retire asynchronously: "the cell finished" must not outrun "its kernel
      // actually died", or the next cell would start on the dying one.
      if (this.#retiring !== undefined) await this.#retiring
    }
  }

  /** Bring the kernel's tool proxies in line with this cell's grant. */
  async #syncTools(kernel: PythonKernel, runId: string, tools: Map<string, BoundTool>): Promise<void> {
    const names = [...tools.keys()].filter((name) => !isCatalogBinding(name))
    const wanted = names.join(',')
    const current = [...this.#installedTools].join(',')
    if (wanted === current) return
    const payload = JSON.stringify(names)
    const top = JSON.stringify([...TOP_LEVEL_TOOLS])
    const outcome = await kernel.execute(`${runId}:sync`, `__import__("bootstrap")._sync_tools(${payload}, ${top})`)
    // Recorded only once the kernel really has these proxies, so a failed sync is retried by the next cell.
    if (outcome.status !== 'ok') return
    this.#installedTools.clear()
    for (const name of names) this.#installedTools.add(name)
  }

  /**
   * Follow the session's working directory into the kernel. Only a change on
   * DSH's side moves it; failing to move fails the cell rather than letting
   * relative paths land somewhere the file tools are not.
   */
  async #syncCwd(kernel: PythonKernel, runId: string): Promise<string | undefined> {
    const cwd = this.#cwd
    if (cwd === undefined || cwd === this.#kernelCwd) return undefined
    const path = JSON.stringify(cwd)
    const outcome = await kernel.execute(`${runId}:cwd`, `__import__('os').chdir(${path}); __import__('os').environ['DSH_PYTHON_REPL_WORKSPACE'] = ${path}`)
    if (outcome.status !== 'ok') return `The session's working directory is now ${cwd}, but the Python kernel could not change into it (${outcome.error?.ename ?? outcome.status}: ${outcome.error?.evalue ?? ''}). The kernel stays in ${this.#kernelCwd ?? 'its previous directory'}; use absolute paths or fix the directory.`
    this.#kernelCwd = cwd
    return undefined
  }

  /** Prime's background buffer: the first 64 Ki characters, then a truncation marker. */
  #appendBackgroundOutput(text: string): void {
    const room = BACKGROUND_OUTPUT_CHARS - this.#backgroundOutput.length
    if (text.length > room) this.#backgroundTruncated = true
    if (room > 0) this.#backgroundOutput += text.slice(0, room)
  }

  #takeBackgroundOutput(): string | undefined {
    if (this.#backgroundOutput === '' && !this.#backgroundTruncated) return undefined
    const text = `[background output (unattributed)]\n${this.#backgroundOutput}`
      + (this.#backgroundTruncated ? `\n[... background output truncated at ${BACKGROUND_OUTPUT_CHARS} chars ...]` : '')
    this.#backgroundOutput = ''
    this.#backgroundTruncated = false
    return text
  }

  #snapshotTarget(): SnapshotTarget | undefined {
    const dir = this.#options.statePath
    return dir === undefined ? undefined : snapshotFiles(dir)
  }

  /** Whether the next kernel restores this one's variables, which decides what loss notices may claim. */
  get #snapshotsOn(): boolean {
    return this.#snapshotTarget() !== undefined && this.#snapshotUnavailable === undefined
  }

  /** What a replaced kernel takes with it. */
  #lossTail(): string {
    return this.#snapshotsOn
      ? 'The next cell starts a new kernel, which restores the variables saved after the last successful cell; '
        + 'anything changed after that is lost. Files already written and DSH jobs already started are unaffected.'
      : 'All variables and functions are gone; files already written and DSH jobs already started are unaffected.'
  }

  /** Prime's debounced auto-snapshot after a successful cell, run between cells. */
  #scheduleSnapshot(): void {
    if (!this.#dirty) return
    clearTimeout(this.#snapshotTimer)
    this.#snapshotTimer = setTimeout(() => {
      this.#snapshotTimer = undefined
      const task = this.#queue.then(() => {
        const kernel = this.#kernel
        return kernel === undefined || this.#disposed ? undefined : this.#captureSnapshot(kernel)
      })
      this.#queue = task.catch(() => undefined)
    }, SNAPSHOT_DEBOUNCE_MS)
    this.#snapshotTimer.unref?.()
  }

  /** Write the namespace now; a failure leaves it dirty for the next attempt. */
  async #captureSnapshot(kernel: PythonKernel): Promise<void> {
    const target = this.#snapshotTarget()
    if (target === undefined || !this.#dirty || !kernel.ready) return
    this.#dirty = false
    const id = `snapshot-${this.#epoch}-${++this.#snapshotCounter}`
    const outcome = await this.#withDeadline(kernel.snapshot(id, target), SNAPSHOT_TIMEOUT_MS)
    if (outcome === TIMED_OUT) kernel.interrupt(id)
    if (outcome === TIMED_OUT || outcome.status !== 'ok') this.#dirty = true
  }

  /** Revive the saved namespace into a kernel that just finished its bootstrap. */
  async #restoreInto(kernel: PythonKernel, target: SnapshotTarget): Promise<RestoreReport> {
    const id = `restore-${this.#epoch}`
    const pending = kernel.restore(id, target)
    let outcome = await this.#withDeadline(pending, RESTORE_TIMEOUT_MS)
    if (outcome === TIMED_OUT) {
      kernel.interrupt(id)
      outcome = await this.#withDeadline(pending, SNAPSHOT_TIMEOUT_MS)
      if (outcome === TIMED_OUT) {
        throw new Error(`dsh-python-repl: restoring the saved Python state (${target.path}) did not finish within `
          + `${RESTORE_TIMEOUT_MS}ms and did not stop when interrupted; the kernel was stopped.`)
      }
    }
    const { report, complete } = await readRestoreReport(outcome, target.manifestPath)
    this.#restoreIncomplete = !complete
    return report
  }

  /**
   * Race a kernel request against a host-owned deadline.
   *
   * The losing promise is abandoned deliberately: after the deadline the
   * kernel is killed, which settles it.
   */
  async #withDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), ms)
      timer.unref?.()
    })
    try {
      return await Promise.race([work, deadline])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Take the kernel out of service: revoke everything, KILL the process, and
   * remember why so later cells fail with an explanation instead of silently
   * starting a fresh namespace.
   */
  async #retireKernel(reason?: string): Promise<void> {
    // Authority goes first and synchronously, before any await or early return.
    this.#leases.revokeAll()
    this.#failBackgroundJobs('the Python kernel ended before this work finished')
    void this.#agentRuns.stopAll()
    this.#clearToolReplies()
    const kernel = this.#kernel ?? this.#startingKernel
    // Concurrent callers (the abort timer and the teardown path can both fire)
    // must join the SAME shutdown rather than each start one — but only for
    // the same kernel: a newer one must not hide behind an older shutdown.
    if (this.#retiring !== undefined && (kernel === undefined || kernel === this.#retiringKernel)) return this.#retiring
    this.#kernel = undefined
    this.#installedTools.clear()
    if (reason !== undefined) {
      // One-shot: consumed by the next cell, which runs on a NEW kernel.
      this.#retirementNotice = reason
    }
    if (kernel === undefined) return
    this.cellLog.kernelEnded(reason)
    const retiring = this.#stopKernel(kernel, reason ?? 'kernel retired').finally(() => {
      if (this.#retiring === retiring) {
        this.#retiring = undefined
        this.#retiringKernel = undefined
      }
    })
    this.#retiring = retiring
    this.#retiringKernel = kernel
    return retiring
  }

  /** The kernel process ended during the cell: say how, and let the next cell start a fresh one. */
  async #kernelDied(kernel: PythonKernel, outcome: CellOutcome): Promise<CellResult> {
    const { code: exitCode, signal } = kernel.exitInfo ?? { code: null, signal: null }
    const how = signal !== null ? `was killed by ${signal}` : `exited with code ${exitCode}`
    const message =
      `The Python kernel ${how} while this cell was running. ${this.#lossTail()}`
      + (signal === 'SIGKILL' ? ' SIGKILL usually means the process was killed from outside or ran out of memory.' : '')
    await this.#retireKernel(message)
    return { logs: [...outcome.logs], error: { kind: 'worker-exit', message } }
  }

  #toResult(
    outcome: CellOutcome,
    teardown: CellTeardown,
    aborted: boolean,
    fatal?: string,
    code?: string,
    trace?: CellTrace,
  ): CellResult {
    const base: CellResult = { logs: [...outcome.logs] }
    const background = this.#takeBackgroundOutput()
    if (background !== undefined) base.logs.push(background)
    if (fatal !== undefined) {
      base.logs.push(`[dsh-python-repl] ${fatal}`)
      return { ...base, error: { kind: 'worker-exit', message: fatal } }
    }
    if ((teardown.failed ?? []).length > 0) base.logs.push(failedTasksNotice(teardown.failed ?? []))
    for (const note of teardown.advice ?? []) base.logs.push(`[dsh-python-repl] ${note}`)
    for (const note of trace === undefined ? [] : traceNotes(trace, this.#options.subagent === true)) base.logs.push(`[dsh-python-repl] ${note}`)
    const report = trace === undefined ? '' : callsReport(trace.calls)
    const usage = code === undefined ? '' : usageHint(code)
    if (usage.length > 0 && !base.logs.some((line) => line.includes('Hand-rolled file edit'))) {
      base.logs.push(`[dsh-python-repl] ${usage}`)
    }
    // Told once per change, not every cell: a session that kept `import glob`
    // got the same notice 41 times and never acted on it.
    const shadowed = teardown.shadowed.join(',')
    const shadowedChanged = shadowed !== this.#reportedShadowed
    this.#reportedShadowed = shadowed
    if (teardown.shadowed.length > 0 && shadowedChanged) {
      // Worth interrupting for: a shadowed bridge name silently breaks later
      // cells, and the fix (restore_binding) is not guessable.
      // `repl` needs its own advice: telling someone to call
      // `await repl.restore_binding("repl")` when `repl` is now a string is a
      // recipe that cannot work (found 2026-09-22). Recover it by importing
      // the bootstrap module, which no rebinding can hide.
      const first = teardown.shadowed[0] ?? ''
      const replIsGone = teardown.shadowed.includes('repl')
      const howToFix = replIsGone
        ? 'Because `repl` itself is one of them, restore it first with: '
          + 'repl = __import__("bootstrap")._ORIGINAL_BINDINGS["repl"]  '
          + '— then use await repl.restore_binding("<name>") for the rest.'
        : `Calls through those names will fail until you rebind them or call `
          + `await repl.restore_binding("${first}")`
          + (teardown.shadowed.includes('tools') ? '. ' : '; a tool stays reachable as tools.<name> either way. ')
          + (teardown.shadowed.includes('glob') ? 'For the standard-library module use `import glob as globlib`. ' : '')
          + 'This is said once; it repeats only if the set of replaced names changes.'
      base.logs.push(
        `[dsh-python-repl] system binding(s) replaced by your own value: `
          + `${teardown.shadowed.join(', ')}. ${howToFix}`,
      )
    }
    // Cancellation outranks a successful-looking outcome: a cell interrupted
    // just before its `done` frame must never be reported as success.
    if (aborted) return { ...base, error: { kind: 'abort', message: report === '' ? 'cell was cancelled' : `cell was cancelled\n${report}` } }
    if (outcome.status === 'ok') return base
    if (outcome.status === 'kernel-exit') {
      this.#stateLossNotice = `The Python kernel exited. ${this.#lossTail()}`
      return { ...base, error: { kind: 'worker-exit', message: 'kernel exited during the cell' } }
    }
    const error = outcome.error
    const message =
      error === undefined
        ? 'cell raised'
        : `${error.ename}: ${error.evalue}${
            error.traceback === undefined ? '' : `\n${error.traceback.join('')}`
          }${error?.ename === 'SyntaxError' && code !== undefined ? foreignLanguageHint(code, error.evalue) : ''}${
            error === undefined ? '' : missingModuleHint(error.ename, error.evalue)}`
    return { ...base, error: { kind: 'exception', message: report === '' ? message : `${message.trimEnd()}\n\n${report}` } }
  }

  async #endCell(kernel: PythonKernel, runId: string, code?: string, cut = false): Promise<CellTeardown> {
    if (!kernel.ready) {
      return { shadowed: [], clean: false, reason: 'the kernel exited before cleanup ran' }
    }
    // A task can block the event loop synchronously, so the host keeps its
    // own deadline and replaces a kernel that cannot answer.
    // JSON string literals are valid Python string literals.
    const source = code === undefined ? 'None' : JSON.stringify(code)
    const request = `print(__import__("json").dumps(await __import__("bootstrap")._end_cell(${source}, ${cut ? 'True' : 'False'})))`
    const outcome = await this.#withDeadline(
      kernel.execute(`${runId}:end`, request),
      this.#teardownGraceMs,
    )
    if (outcome === TIMED_OUT) {
      return {
        shadowed: [],
        clean: false,
        reason: `the kernel did not answer within ${this.#teardownGraceMs}ms (something is blocking its event loop)`,
      }
    }
    if (outcome.status !== 'ok') {
      return { shadowed: [], clean: false, reason: `cleanup itself failed (${outcome.error?.ename ?? outcome.status})` }
    }
    const teardown = parseJsonLine(outcome.logs) as Partial<CellTeardown> | undefined
    if (teardown === undefined || !Array.isArray(teardown.shadowed)) {
      return { shadowed: [], clean: false, reason: 'cleanup produced no report' }
    }
    const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v) => typeof v === 'string') : [])
    return {
      failed: strings(teardown.failed),
      shadowed: strings(teardown.shadowed),
      clean: true,
      advice: strings(teardown.advice),
      ...(typeof teardown.restart === 'string' ? { restart: teardown.restart } : {}),
    }
  }

  /** Start the kernel on first use and install the capability surface. */
  async #ensureStarted(tools: Map<string, BoundTool>, signal?: AbortSignal): Promise<void> {
    if (this.#kernel?.ready === true) return
    if (this.#starting !== undefined) return this.#starting
    // A published kernel that is no longer ready is never reused; stop it
    // before replacing it so it cannot be orphaned while still running.
    if (this.#kernel !== undefined) await this.#retireKernel()
    this.#starting = this.#startKernel(tools, signal).finally(() => {
      this.#starting = undefined
    })
    return this.#starting
  }

  async #startKernel(tools: Map<string, BoundTool>, signal?: AbortSignal): Promise<void> {
    if (this.#disposed) throw new Error('session disposed')
    this.#epoch += 1
    this.cellLog.kernelStarted(this.#epoch)
    const cwd = this.#cwd ?? this.#options.cwd
    this.#kernelCwd = cwd
    const kernel = new PythonKernel(
      {
        python: this.#options.python,
        ...(this.#options.maxFrameBytes === undefined ? {} : { maxFrameBytes: this.#options.maxFrameBytes }),
        // `rlm` is a PEP 420 namespace package split across two roots:
        // upstream files in vendorRoot, our shims in pythonRoot/compat.
        // vendorRoot comes FIRST so a shim can never shadow an upstream module.
        pythonPath: [
          this.#options.vendorRoot,
          join(this.#options.pythonRoot, 'compat'),
          this.#options.pythonRoot,
        ],
        ...(cwd === undefined ? {} : { cwd }),
        // Let the kernel state plainly whether its cwd is the workspace, so a
        // cell never has to guess where a relative path lands.
        env: {
          // bash 工具的子进程由宿主带上 DSH_SESSION_ID；内核子进程此前没有，
          // 从 Python 里跑 dsh-use restart 不会自动转后台，也不知道
          // 该通知谁（dsh-use 只认这个标记，全仓库无其他读者）。
          ...(this.#options.sessionId === undefined ? {} : { DSH_SESSION_ID: this.#options.sessionId }),
          ...(cwd === undefined ? {} : { DSH_PYTHON_REPL_WORKSPACE: cwd }),
          // python/lifecycle.py keeps its records and archive next to the snapshot; without it the lifecycle is off.
          ...(this.#options.statePath === undefined ? {} : {
            DSH_PYTHON_REPL_STATE_DIR: this.#options.statePath,
            DSH_PYTHON_REPL_ARCHIVE_AFTER: String(this.#options.archiveAfterCells ?? 100),
            DSH_PYTHON_REPL_DELETE_AFTER: String(this.#options.deleteAfterCells ?? 200),
          }),
          DSH_PYTHON_REPL_WAIT_MS: String(this.#waitCap()),
          ...(this.#options.subagent === true ? { DSH_PYTHON_REPL_SUBAGENT: '1' } : {}),
        },
        onHostRequest: (id, data) => this.#onHostRequest(id, data, kernel),
        onUnattributedOutput: (text) => this.#appendBackgroundOutput(text),
        // Synchronous revocation at the protocol boundary.
        onCellSettled: (runId) => this.#revoke(runId),
        onCorruptFrame: (line) => {
          // A frame we could not parse may have been a tool call. Retire the
          // kernel rather than let the cell wait on a reply that cannot come.
          // The kernel's own terminate() joins this one, so the process gets one SIGKILL.
          this.#retireInBackground(
            'The Python kernel was retired because it emitted a line the host could not parse, '
            + `so the protocol is no longer trustworthy. ${this.#lossTail()} First 200 chars: ${JSON.stringify(line.slice(0, 200))}`,
          )
        },
        onExit: () => {
          this.#leases.revokeAll()
          this.#clearToolReplies()
          void this.#agentRuns.stopAll()
        },
        onTerminationFailure: (error) => this.#recordTerminationFailure(kernel, error),
      },
      this.#epoch,
    )
    this.#startingKernel = kernel
    try {
      await this.#bootKernel(kernel, tools, signal)
    } catch (error) {
      // A failure already recorded means the start path tried once; another
      // automatic SIGKILL would not help. dispose() retries it explicitly.
      if (kernel.terminationFailure !== undefined) this.#recordTerminationFailure(kernel, kernel.terminationFailure)
      else await this.#stopKernel(kernel, 'kernel start did not complete')
      throw this.#disposed ? new Error('session disposed') : error
    } finally {
      if (this.#startingKernel === kernel) this.#startingKernel = undefined
    }
  }

  /** Handshake and bootstrap one kernel, publishing it only once both succeeded and the session is still open. */
  async #bootKernel(kernel: PythonKernel, tools: Map<string, BoundTool>, signal?: AbortSignal): Promise<void> {
    const timeoutMs = this.#options.startupTimeoutMs ?? 30_000
    const deadline = performance.now() + timeoutMs
    await kernel.start(this.#options.startupTimeoutMs)
    if (this.#disposed) throw new Error('session disposed')
    if (signal?.aborted) throw new Error('cell cancelled before initialization')
    const names = JSON.stringify([...tools.keys()].filter((name) => !isCatalogBinding(name)))
    const top = JSON.stringify([...TOP_LEVEL_TOOLS])
    // A JSON string literal is a valid Python string literal; the kernel parses it.
    const skills = JSON.stringify(JSON.stringify(this.#options.skills ?? []))
    const disabled = JSON.stringify([...(this.#options.disabledSkills ?? [])])
    const renames = JSON.stringify(JSON.stringify(this.#options.skillRenames ?? {}))
    // Skill imports run arbitrary module code, so the
    // bootstrap gets a host-owned deadline: a Python-side timeout cannot fire
    // while that code blocks the event loop.
    const bootstrapTimeoutMs = Math.max(0, deadline - performance.now())
    const outcome = await this.#withDeadline(kernel.execute(
      `boot-${this.#epoch}`,
      'print(__import__("json").dumps(__import__("bootstrap")._bootstrap(' 
        + `${names}, ${top}, ${this.#epoch}, __import__("json").loads(${skills}), ${disabled}, __import__("json").loads(${renames}))))`,
    ), bootstrapTimeoutMs)
    if (this.#disposed) throw new Error('session disposed')
    if (signal?.aborted) throw new Error('cell cancelled during initialization')
    if (outcome === TIMED_OUT) {
      throw new Error(
        `dsh-python-repl: kernel startup timed out after ${timeoutMs}ms during initialization `
        + '(skill imports); the kernel was stopped. Check the configured skillRoots for a module '
        + 'that blocks at import time.',
      )
    }
    if (outcome.status !== 'ok') {
      const detail = outcome.error === undefined ? outcome.status : `${outcome.error.ename}: ${outcome.error.evalue}`
      throw new Error(`dsh-python-repl: kernel bootstrap failed — ${detail}`)
    }
    const notices = await this.#prepareState(kernel)
    if (this.#disposed) throw new Error('session disposed')
    if (signal?.aborted) throw new Error('cell cancelled during initialization')
    // Hand over in one step: from here a cancel no longer targets this kernel
    // as "starting", it goes through the cell's own interrupt path.
    this.#startingKernel = undefined
    this.#kernel = kernel
    const report = parseJsonLine(outcome.logs)
    this.#skillReport = Array.isArray(report?.['loaded']) ? report as unknown as SkillReport : undefined
    this.#restoreNotice = notices.length === 0 ? undefined : notices.join('\n')
    this.#installedTools.clear()
    this.#reportedShadowed = ''
    for (const name of tools.keys()) {
      if (!isCatalogBinding(name)) this.#installedTools.add(name)
    }
  }

  /**
   * Make snapshots possible on a bootstrapped kernel and, as Prime does on
   * resume, revive the saved namespace when a snapshot exists. Returns the
   * one-shot notes for the first cell.
   */
  async #prepareState(kernel: PythonKernel): Promise<string[]> {
    this.#snapshotUnavailable = undefined
    this.#restoreIncomplete = false
    const target = this.#snapshotTarget()
    if (target === undefined) return []
    const support = await this.#withDeadline(kernel.execute(
      `support-${this.#epoch}`,
      'print(__import__("json").dumps(await __import__("bootstrap")._ensure_snapshot_support()))',
    ), SNAPSHOT_SUPPORT_TIMEOUT_MS)
    if (support === TIMED_OUT) {
      throw new Error(`dsh-python-repl: preparing variable snapshots did not finish within `
        + `${SNAPSHOT_SUPPORT_TIMEOUT_MS}ms; the kernel was stopped.`)
    }
    const state = parseJsonLine(support.logs) as { dill?: unknown; error?: unknown } | undefined
    if (typeof state?.dill !== 'string') {
      this.#snapshotUnavailable = typeof state?.error === 'string' ? state.error
        : `the snapshot support check failed (${support.error === undefined ? support.status : `${support.error.ename}: ${support.error.evalue}`})`
    }
    const saved = existsSync(target.path)
    const notices: string[] = []
    if (saved && this.#snapshotUnavailable === undefined) {
      const report = await this.#restoreInto(kernel, target)
      notices.push(restoreNotice(report, await this.#restoreSummary(kernel, report.restored)))
    }
    if (saved && this.#snapshotUnavailable !== undefined) {
      this.#restoreIncomplete = true
      notices.push(restoreNotice({ restored: [], failed: [], unsaved: [] }))
    }
    if (this.#snapshotUnavailable !== undefined) {
      notices.push(`[dsh-python-repl] Variables are not saved across kernel restarts in this kernel: ${this.#snapshotUnavailable}.`)
    }
    return notices
  }

  /**
   * Serve one `host_request`. Resolution goes through the lease table, so a
   * stale task's call fails no matter which cell is currently running.
   */
  /** `repl.background` jobs of the current kernel: settle on the kernel's report, or fail when the kernel ends. */
  readonly #backgroundJobs = new Map<string, {
    settle(outcome: { status: string; detail?: string }): void
    append(text: string): void
    progress(text: string): void
    owner: string
    jobs: HostJobs['jobs']
    /** Tool access once the starting cell has ended; absent when this DSH cannot give it. */
    grant?: BackgroundGrant
    tools?: Map<string, BoundTool>
    cell?: PanelCell | undefined
    notices: HostJobs['notices']
    /** The live agent the job belongs to; its `repl.agent` children are started for it. */
    agent?: unknown
    /** The cell that started the job, and whether that cell had the `subagent` tool (`repl.agent` after the cell). */
    runId: string
    subagent: boolean
    /** Set by job_kill: no new `repl.agent` child starts while the kernel winds the work down. */
    stopped?: boolean
  }>()
  /** Children `repl.agent` started, each owned by a cell or a job (src/agent-runs.ts). */
  readonly #agentRuns = new AgentRuns(() => this.#options.subagents?.())
  /** The job service and agent of the latest cell, for `repl.background` (python/background.py). */
  #lastHost: HostJobs | undefined

  #onBackgroundRequest(id: string, request: BackgroundRequest, kernel: PythonKernel): void {
    if (request.epoch !== this.#epoch) {
      kernel.reply(id, { status: 'error', error: 'this kernel has been replaced' })
      return
    }
    if (request.op === 'progress') {
      kernel.reply(id, { status: 'ok', result: null })
      this.#backgroundJobs.get(request.jobId)?.progress(request.text.slice(0, 500))
      return
    }
    if (request.op === 'end') {
      const job = this.#backgroundJobs.get(request.jobId)
      kernel.reply(id, { status: 'ok', result: null })
      if (job === undefined) return
      this.#backgroundJobs.delete(request.jobId)
      job.grant?.revoke('has finished')
      void this.#agentRuns.stopOwner(`job:${request.jobId}`)
      this.#handImages(request.jobId, job)
      if (request.text !== '') job.append(request.text.endsWith('\n') ? request.text : `${request.text}\n`)
      job.settle({ status: request.status, ...(request.detail === '' ? {} : { detail: request.detail }) })
      return
    }
    const host = this.#lastHost
    if (!this.#leases.isActive(request.runId) || host === undefined) {
      kernel.reply(id, { status: 'error', error: host === undefined
        ? 'DSH background jobs are not available in this session'
        : 'repl.background() must be called while its cell runs' })
      return
    }
    try {
      let settle!: (outcome: { status: string; detail?: string }) => void
      let append!: (text: string) => void
      let progress!: (text: string) => void
      const done = new Promise<{ status: string; detail?: string }>((resolve) => { settle = resolve })
      const jobId = host.jobs.start({
        kind: 'python',
        label: request.label,
        owner: host.owner,
        run: (handle) => {
          append = (text) => handle.append(text)
          // DSH keeps only the latest progress line (the job's status while it runs);
          // the output keeps every step, so job_output and the finished job show the history.
          progress = (text) => {
            handle.updateProgress(text)
            handle.append(`[progress] ${text}\n`)
          }
          return {
            done,
            cancel: () => {
              const stopping = this.#backgroundJobs.get(jobId)
              stopping?.grant?.revoke('was stopped')
              if (stopping !== undefined) stopping.stopped = true
              void this.#agentRuns.stopOwner(`job:${jobId}`)
              // job_kill: cancel the task in the kernel; its own report then settles the job.
              const current = this.#kernel
              if (current?.ready !== true) { settle({ status: 'killed', detail: 'the kernel is gone' }); return }
              void current.execute(`bg-cancel-${++this.#panelCounter}`, `__import__("background").cancel(${JSON.stringify(jobId)})`)
                .catch(() => undefined)
            },
          }
        },
      })
      const access = this.#backgroundAccess(jobId, request.runId, host)
      this.#backgroundJobs.set(jobId, { settle, append: (text) => append(text), progress: (text) => progress(text), owner: host.owner, jobs: host.jobs, ...access, cell: this.#cellsByRun.get(request.runId), notices: host.notices, ...(host.agent === undefined ? {} : { agent: host.agent }),
        runId: request.runId, subagent: this.#recipes.get(request.runId)?.names.has('subagent') ?? false })
      host.notices.watch(jobId, host.owner, request.label)
      kernel.reply(id, { status: 'ok', result: { jobId } })
    } catch (error) {
      kernel.reply(id, { status: 'error', error: errorMessage(error) })
    }
  }

  /**
   * The tools a `repl.background` job may call once its cell ends: the cell's
   * own names, dispatched through DSH's public pipeline in the job owner's
   * scope, behind the same argument and skill-document wrappers as the cell.
   */
  #backgroundAccess(jobId: string, runId: string, host: HostJobs): { grant?: BackgroundGrant; tools?: Map<string, BoundTool> } {
    const recipe = this.#recipes.get(runId)
    const pipeline = this.#options.backgroundPipeline
    if (recipe === undefined || host.agent === undefined || pipeline === undefined) return {}
    const grant = new BackgroundGrant({ jobId, runId, epoch: this.#epoch, agent: host.agent, names: recipe.names, pipeline: pipeline(), lane: this.#toolLane })
    const tools = new Map(recipe.catalog)
    for (const name of recipe.names) {
      const fixed = withArgumentFix(name, withPythonSkillDocument(name, grant.bind(name), this.#options.skills ?? []), recipe.byName.get(name)?.parameters)
      tools.set(name, withCollected(name, fixed, host))
    }
    return { grant, tools }
  }

  /** Before a job settles: its tool calls' images go with its end notice (src/bash-jobs.ts JobNotices.attach). */
  #handImages(jobId: string, job: { grant?: BackgroundGrant; notices: HostJobs['notices'] }): void {
    const taken = job.grant?.takeImages()
    const contexts = job.grant?.takeContexts() ?? []
    if (taken !== undefined || contexts.length > 0) job.notices.attach(jobId, taken?.images ?? [], taken?.dropped ?? 0, contexts)
  }

  /**
   * `repl.agent`: authorise against the cell's lease (it must have the
   * `subagent` tool) or, once the cell has ended, the job's grant; then start
   * the child for the owning cell or job and reply with its result.
   */
  #onAgentRequest(id: string, request: AgentRequest, kernel: PythonKernel): void {
    const reply = (data: HostReplyData): void => {
      try { kernel.reply(id, data) } catch { /* the kernel is gone; nobody is left to answer */ }
    }
    if (request.epoch !== this.#epoch) {
      reply({ status: 'error', error: 'this kernel has been replaced' })
      return
    }
    if (request.op === 'cancel') {
      reply({ status: 'ok', result: null })
      this.#agentRuns.cancel(request.callId)
      return
    }
    const lookup = this.#leases.resolve(request.runId, request.epoch, 'subagent')
    const job = request.jobId === undefined ? undefined : this.#backgroundJobs.get(request.jobId)
    let owner: string
    let agent: unknown
    let cell: PanelCell | undefined
    if (lookup.ok) {
      agent = this.#recipes.get(request.runId)?.agent
      owner = job === undefined ? `cell:${request.runId}` : `job:${request.jobId!}`
      cell = this.#cellsByRun.get(request.runId)
    } else if (lookup.denial.reason === 'unknown-run' && job !== undefined && job.stopped !== true
      && job.runId === request.runId && job.subagent) {
      agent = job.agent
      owner = `job:${request.jobId!}`
      cell = job.cell
    } else {
      reply({ status: 'error', error: !lookup.ok && lookup.denial.reason === 'unknown-tool'
        ? 'repl.agent needs the subagent tool, and this cell does not have it'
        : request.jobId !== undefined && job === undefined
          ? `background job ${request.jobId} is no longer running; its children ended with it`
          : lookup.ok ? 'unreachable' : describeDenial(lookup.denial) })
      return
    }
    if (agent === undefined) {
      reply({ status: 'error', error: 'repl.agent needs the live DSH agent of this session, and none was recorded for this cell' })
      return
    }
    const trace = this.#traces.get(request.runId)
    const traced = trace === undefined ? undefined : newCall(trace.calls.length + 1, 'repl.agent', { description: request.label })
    if (traced !== undefined) trace!.calls.push(traced)
    const recordTool = cell === undefined ? undefined : this.cellLog.tool(cell, 'repl.agent')
    const finish = (failed: boolean): void => {
      recordTool?.(failed)
      if (traced !== undefined) { traced.status = failed ? 'error' : 'ok'; traced.endedAt = Date.now() }
    }
    void this.#agentRuns.run(request.callId, owner, {
      parent: agent,
      prompt: request.prompt,
      label: request.label,
      ...(request.schema === undefined ? {} : { schema: request.schema }),
      ...(request.provider === undefined ? {} : { provider: request.provider }),
      ...(request.model === undefined ? {} : { model: request.model }),
    }).then((outcome) => {
      finish(outcome.stopReason !== 'completed')
      job?.append(`[agent] ${request.label.replace(/\s+/g, ' ').slice(0, 80)}: ${outcome.stopReason}\n`)
      reply({ status: 'ok', result: outcome })
    }, (error: unknown) => {
      finish(true)
      reply({ status: 'error', error: errorMessage(error), ...(isCancellation(error) ? { cancelled: true as const } : {}) })
    })
  }

  #noteSubagent(result: unknown, args: unknown): void {
    const id = (result as { subagentId?: unknown } | null)?.subagentId
    if (typeof id !== 'string') return
    const description = (args as { description?: unknown } | null)?.description
    this.subagentsStarted.push({ id, label: typeof description === 'string' ? description.slice(0, 80) : 'subagent' })
    if (this.subagentsStarted.length > SUBAGENTS_KEPT) this.subagentsStarted.splice(0, this.subagentsStarted.length - SUBAGENTS_KEPT)
  }

  /** The kernel ended: no `repl.background` work survives it. */
  #failBackgroundJobs(reason: string): void {
    for (const [jobId, job] of this.#backgroundJobs) {
      job.grant?.revoke('ended with its kernel or session')
      void this.#agentRuns.stopOwner(`job:${jobId}`)
      this.#handImages(jobId, job)
      job.settle({ status: 'failed', detail: reason })
    }
    this.#backgroundJobs.clear()
  }

  #onHostRequest(id: string, data: unknown, kernel: PythonKernel): void {
    if (kernel !== this.#kernel && kernel !== this.#startingKernel) return
    const agentRequest = asAgentRequest(data)
    if (agentRequest !== undefined) {
      this.#onAgentRequest(id, agentRequest, kernel)
      return
    }
    const background = asBackgroundRequest(data)
    if (background !== undefined) {
      this.#onBackgroundRequest(id, background, kernel)
      return
    }
    const request = asToolRequest(data)
    if (request === undefined) {
      kernel.reply(id, { status: 'error', error: 'unrecognized host request' })
      return
    }
    const lookup = this.#leases.resolve(request.runId, request.epoch, request.tool)
    // `repl.background` work calls through its job's own grant (src/background-tools.ts), even while its cell
    // still runs: a call sent through the cell's lease loses its reply when the cell settles (evolve I-074).
    const job = request.jobId === undefined ? undefined : this.#backgroundJobs.get(request.jobId)
    const grant = job?.grant
    const bound = grant !== undefined && grant.runId === request.runId && grant.epoch === request.epoch ? job?.tools?.get(request.tool) : undefined
    let call: BoundTool
    if (bound !== undefined) {
      call = bound
    } else if (lookup.ok) {
      call = lookup.call
    } else if (request.jobId !== undefined && lookup.denial.reason === 'unknown-run') {
      kernel.reply(id, { status: 'error', error: job === undefined
        ? `background job ${request.jobId} is no longer running; its tool access ended with it`
        : grant === undefined
          ? `${describeDenial(lookup.denial)}. This DSH gives background work no tool access after its cell ends; fetch what it needs inside the cell`
          : `tool ${JSON.stringify(request.tool)} was not available to the cell that started background job ${request.jobId}` })
      return
    } else {
      kernel.reply(id, { status: 'error', error: describeDenial(lookup.denial) })
      return
    }
    const trace = isCatalogBinding(request.tool) ? undefined : this.#traces.get(request.runId)
    const traced = trace === undefined ? undefined : newCall(trace.calls.length + 1, request.tool, request.args)
    if (traced !== undefined) trace!.calls.push(traced)
    const pending = { runId: request.runId, ...(bound === undefined ? {} : { jobId: request.jobId }), timer: undefined as NodeJS.Timeout | undefined }
    this.#pendingToolCalls.set(id, pending)
    const logged = this.#cellsByRun.get(request.runId) ?? job?.cell
    const recordTool = logged === undefined || isCatalogBinding(request.tool) ? undefined : this.cellLog.tool(logged, request.tool)
    const settle = (reply: HostReplyData): void => {
      // Timeout, revocation, and settlement all consume the same slot. Late
      // success/rejection cannot reply to this cell or a subsequent one.
      if (this.#pendingToolCalls.get(id) !== pending) return
      this.#pendingToolCalls.delete(id)
      recordTool?.(reply.status !== 'ok')
      if (job !== undefined && !isCatalogBinding(request.tool)) job.append(`[tool] ${request.tool} ${reply.status === 'ok' ? 'ok' : 'failed'}\n`)
      if (traced !== undefined) { traced.status = reply.status === 'ok' ? 'ok' : 'error'; traced.endedAt = Date.now() }
      if (request.tool === 'subagent' && reply.status === 'ok') this.#noteSubagent(reply.result, request.args)
      if (pending.timer !== undefined) clearTimeout(pending.timer)
      try {
        kernel.reply(id, reply)
      } catch (error) {
        // JSON encoding happens before the write. A cyclic value, bigint, or
        // throwing toJSON must become a tool error, not an unhandled rejection.
        try {
          kernel.reply(id, {
            status: 'error',
            error: `tool "${request.tool}" reply could not be delivered: ${errorMessage(error)}. `
              + 'Its outcome is unknown; effects may already have occurred. No automatic retry was attempted.',
          })
        } catch {
          this.#retireInBackground('The Python kernel was retired because a tool reply could not be delivered. '
            + `${this.#lossTail()} Tool effects may still run; their outcome is unknown. `
            + 'No automatic retry was attempted.')
        }
      }
    }
    if (this.#toolCallTimeoutMs > 0) {
      pending.timer = setTimeout(() => settle({
        status: 'error',
        error: `tool "${request.tool}" did not respond within ${this.#toolCallTimeoutMs}ms. `
          + 'Its outcome is unknown; the bound tool may still run and produce effects. '
          + 'This timeout does not cancel it. No automatic retry was attempted; verify its outcome before retrying.',
      }), this.#toolCallTimeoutMs)
      pending.timer.unref?.()
    }

    // Invoking inside try also handles bindings that throw synchronously.
    const invoke = async (): Promise<void> => {
      try {
        settle({ status: 'ok', result: await call(request.args) })
      } catch (error) {
        // Keep cancellation distinct from ToolCallError in Python.
        settle({ status: 'error', error: errorMessage(error), ...(isCancellation(error) ? { cancelled: true as const } : {}) })
      }
    }
    void invoke()
  }

  /**
   * Stop the kernel — including one still starting — and revoke every lease.
   * Always safe to call twice: every call resolves only once the processes
   * this session spawned are gone.
   */
  dispose(): Promise<void> {
    if (this.#disposing !== undefined) return this.#disposing
    this.#disposed = true
    this.#leases.revokeAll()
    void this.#agentRuns.stopAll()
    this.#failBackgroundJobs('the session closed before this work finished')
    this.#clearToolReplies()
    const kernel = this.#kernel
    this.#kernel = undefined
    const starting = this.#startingKernel
    const work = (async () => {
      if (kernel !== undefined) await this.#flushSnapshotForDispose(kernel)
      // A kernel that failed to stop during this close stays held for the next call.
      const settled = await Promise.allSettled([
        kernel?.dispose(this.#teardownGraceMs).catch((error: unknown) => {
          this.#recordTerminationFailure(kernel, error)
          throw error
        }),
        starting?.terminate('session closed while the kernel was starting').catch((error: unknown) => {
          this.#recordTerminationFailure(starting, error)
          throw error
        }),
        this.#retiring,
        // Earlier failures get one more explicit attempt on every close.
        ...[...this.#unterminated].map((held) => held.dispose(0)),
      ])
      // The start itself unwinds on its own once its process is gone; wait so
      // nothing it does can outlive the close.
      await this.#starting?.catch(() => undefined)
      await this.cellLog.flush()
      const failures = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected').map((s) => s.reason as unknown)
      const pids = this.unterminatedPids
      if (failures.length > 0 || pids.length > 0) {
        throw new AggregateError(failures, `dsh-python-repl: could not confirm every kernel stopped`
          + `${pids.length === 0 ? '' : ` (pids still running: ${pids.join(', ')})`}; call dispose() again to retry.`)
      }
    })()
    this.#disposing = work
    // Only a successful close is final; after a failure the next call retries.
    void work.then(() => undefined, () => { if (this.#disposing === work) this.#disposing = undefined })
    return work
  }

  /**
   * Prime's final snapshot on close: stop a running cell, then save, so a
   * later session restores what this one ended with. Skipped while the saved
   * file is fuller than this kernel (an incomplete restore).
   */
  async #flushSnapshotForDispose(kernel: PythonKernel): Promise<void> {
    clearTimeout(this.#snapshotTimer)
    if (!this.#dirty || this.#restoreIncomplete || !kernel.ready) return
    if (this.#activeRunId !== undefined) kernel.interrupt(this.#activeRunId)
    await this.#captureSnapshot(kernel)
  }
}

/**
 * Wrap one bound tool so an argument rejection carries the fix.
 *
 * The error is re-thrown with the same `name` and `code`, so cancellation
 * detection and the host's own classification are unchanged.
 */
const SUBAGENTS_KEPT = 50

/** Names the last snapshot's manifest says it could not save; unreadable counts as none known. */
async function readSkipped(manifestPath: string): Promise<string[]> {
  try {
    const data = JSON.parse(await readFile(manifestPath, 'utf8')) as { skipped?: Array<{ name?: unknown }> }
    return (data.skipped ?? []).map((item) => String(item.name ?? '?'))
  } catch {
    return []
  }
}

/** A finished job_output or a job_kill means the model has that job's end: no completion notice for it. */
function withCollected(tool: string, fn: BoundTool, host: HostJobs): BoundTool {
  if (tool !== 'job_output' && tool !== 'job_kill') return fn
  return async (args) => {
    const result = await fn(args)
    const id = (args as { job_id?: unknown } | null)?.job_id
    const status = (result as { job?: { status?: unknown } } | null)?.job?.status
    if (typeof id === 'string' && (tool === 'job_kill' || (status !== 'running' && status !== 'stopping'))) host.notices.collected(id)
    return result
  }
}

/** 95% of bash calls in kernels in real sessions finished within 5 s (2026-11-03, 36k calls); 1 s would send one in six to the background. */
export const DEFAULT_CELL_WAIT_MS = 5_000

function withArgumentFix(tool: string, fn: BoundTool, parameters: unknown): BoundTool {
  return async (args) => {
    try {
      return await fn(args)
    } catch (error) {
      const message = errorMessage(error)
      const fix = argumentFix(tool, message, args, parameters)
      if (fix === '') throw error
      const enriched = new Error(`${message} — ${fix}`)
      const { name, code } = error as { name?: unknown; code?: unknown }
      if (typeof name === 'string') enriched.name = name
      if (code !== undefined) (enriched as { code?: unknown }).code = code
      throw enriched
    }
  }
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return 'unprintable tool error'
  }
}

/** The last line of a helper's output that is a JSON object: its report, printed after anything user code printed. */
function parseJsonLine(logs: readonly string[]): Record<string, unknown> | undefined {
  for (const line of [...logs].reverse()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      return JSON.parse(trimmed) as Record<string, unknown>
    } catch {
      // Not the report line.
    }
  }
  return undefined
}

/** Sentinel for a kernel request that blew its host-side deadline. */
const TIMED_OUT = Symbol('dsh-python-repl.timed-out')

/** How long a cancelled cell gets to stop before the caller is answered (Prime's KERNEL_ABORT_GRACE_MS). */
const ABORT_RETURN_MS = 1_000
/** How often the next cell re-interrupts a cancelled one that is still running (Prime's interval). */
const INTERRUPT_REPEAT_MS = 500

/** The result for a cell that reached a session closed under it. */
function disposedResult(): CellResult {
  return { logs: [], error: { kind: 'worker-exit', message: 'session disposed' } }
}

/** The result for a cell that never ran because it was already cancelled. */
function abortedResult(): CellResult {
  return { logs: [], error: { kind: 'abort', message: 'cell was cancelled before it started' } }
}

/**
 * Whether a rejected tool call represents cancellation rather than failure.
 *
 * Recognises the host's real signals — `AbortError` (the DOM/undici name a
 * fetch or an AbortSignal raises) and DSH's documented `ABORTED` tool code —
 * rather than sniffing message text, which would misclassify a tool whose
 * output merely mentions the word.
 */
export function isCancellation(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  try {
    const candidate = error as { name?: unknown; code?: unknown }
    return candidate.name === 'AbortError' || candidate.code === 'ABORTED' || candidate.code === 'ABORT_ERR'
  } catch {
    return false
  }
}
