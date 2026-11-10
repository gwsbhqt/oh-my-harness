/**
 * bash in a cell runs as a DSH background job that the cell waits on.
 *
 * DSH runs a tool that is not declared concurrency-safe alone, and bash is
 * not, so `asyncio.gather(bash(a), bash(b))` used to run a and b one after
 * the other. A background job is not held to that: starting one is a quick
 * exclusive step, then the commands run side by side. So a foreground bash
 * here starts a job and waits on it through DSH's own job service, exactly
 * as DSH's foreground bash does internally (register, wait, remove): the
 * model gets the same result shape, `await bash; await bash` stays serial,
 * and gathering several runs them at once (real sessions 2026-11-03: three 1 s
 * commands took 1.0 s instead of 3.1 s).
 *
 * A job still running at the cap is handed to the model as DSH's own
 * `promoted` receipt. Its end is announced by {@link JobNotices}, which
 * waits on the job so DSH's tool-jobs plugin skips its per-job notice (it
 * does for any settlement someone was waiting on) and folds jobs that end
 * close together into one message.
 */

import type { BoundTool } from './lease.ts'
import type { ToolSchemaLike } from './catalog.ts'

/** The slice of DSH's `jobs` service this file uses (dsh-jobs). */
export interface JobView {
  id: string
  label?: string
  status: string
  detail?: string
  output?: { spillPaths?: string[] }
}
export interface JobsService {
  wait(id: string, timeoutMs: number, caller: string, signal?: AbortSignal): Promise<JobView>
  read(id: string, caller: string): { chunks: Array<{ channel?: string; text: string }>; lossy: boolean; job: JobView }
  remove(id: string, caller: string): unknown
  kill(id: string, caller: string, reason?: string): unknown
  start(spec: {
    kind: string
    label: string
    owner?: string
    run: (handle: { id: string; append(text: string): void; updateProgress(line: string): void }) => { done: Promise<{ status: string; detail?: string }>; cancel(reason?: string): void }
  }): string
}
/** What a session needs from the host to run bash as jobs: the service and the agent that owns them. */
export interface HostJobs {
  jobs: JobsService
  owner: string
  notices: JobNotices
  /** The live agent behind `owner`; `repl.background` work calls tools in its scope (src/background-tools.ts). */
  agent?: unknown
}

const LIVE = new Set(['running', 'stopping'])

function split(chunks: ReadonlyArray<{ channel?: string; text: string }>): { out: string; err: string } {
  return {
    out: chunks.filter((c) => c.channel !== 'stderr').map((c) => c.text).join(''),
    err: chunks.filter((c) => c.channel === 'stderr').map((c) => c.text).join(''),
  }
}

/** DSH's foreground bash result, rebuilt from a settled job (dsh-tool-bash canonicalBashResult). */
export function foregroundResult(view: JobView, read: ReturnType<JobsService['read']>, cwd: unknown, timeoutMs: number): Record<string, unknown> {
  const { out, err } = split(read.chunks)
  const detail = view.detail ?? ''
  const exit = /exit code: (-?\d+)/.exec(detail)
  const signal = /signal: (\w+)/.exec(detail)
  // Notes DSH appends after "; " (sandbox denials and the like) would otherwise be lost.
  const notes = detail.includes('; ') ? detail.slice(detail.indexOf('; ') + 2) : ''
  const spill = view.output?.spillPaths?.[0]
  const stream = (text: string) => ({ text, truncated: read.lossy, ...(read.lossy && spill !== undefined ? { spillPath: spill } : {}) })
  return {
    kind: 'foreground',
    cwd,
    exitCode: exit !== null ? Number(exit[1]) : null,
    signal: signal !== null ? signal[1] : null,
    timedOut: false,
    aborted: view.status === 'killed' && signal === null,
    timeoutMs,
    stdout: stream(out),
    stderr: stream(notes === '' ? err : `${err}${err === '' || err.endsWith('\n') ? '' : '\n'}[${notes}]\n`),
  }
}

function abortError(): Error {
  const error = new Error('bash call cancelled with its cell; the command was stopped')
  error.name = 'AbortError'
  return error
}

function startsBackground(schema: ToolSchemaLike | undefined): boolean {
  const properties = (schema?.parameters as { properties?: Record<string, unknown> } | undefined)?.properties
  return properties !== undefined && 'run_in_background' in properties
}

/**
 * The cell's `bash`: foreground calls become a job plus a wait of at most
 * `capMs`; explicit `run_in_background` calls pass through and are watched.
 * Without the job service, or where bash cannot start jobs, `fallback` runs.
 */
export function withJobBash(fn: BoundTool, schema: ToolSchemaLike | undefined, capMs: number, host: HostJobs | undefined,
  signal: AbortSignal | undefined, fallback: BoundTool): BoundTool {
  if (host === undefined || !(capMs > 0) || !startsBackground(schema)) return fallback
  const { jobs, owner, notices } = host
  return async (args) => {
    if (args === null || typeof args !== 'object' || Array.isArray(args)) return fallback(args)
    const request = args as Record<string, unknown>
    const label = typeof request['command'] === 'string' ? request['command'] : 'bash'
    if (request['run_in_background'] === true) {
      const receipt = await fn(args) as Record<string, unknown>
      if (receipt?.['kind'] === 'background' && typeof receipt['jobId'] === 'string') notices.watch(receipt['jobId'], owner, label)
      return receipt
    }
    const wanted = typeof request['timeoutMs'] === 'number' && request['timeoutMs'] > 0 ? Math.min(request['timeoutMs'], capMs) : capMs
    const { timeoutMs: _drop, ...rest } = request
    const receipt = await fn({ ...rest, run_in_background: true }) as Record<string, unknown>
    const id = receipt?.['jobId']
    if (receipt?.['kind'] !== 'background' || typeof id !== 'string') return receipt
    let view: JobView
    try {
      view = await jobs.wait(id, wanted, owner, signal)
    } catch (error) {
      // Only an aborted wait is the cell being cancelled; any other failure (the job was dropped) stays an error.
      if (signal?.aborted !== true) throw error
      // Stop the command, as DSH's foreground bash does, and keep the record off the panel.
      try {
        jobs.kill(id, owner, 'cell cancelled')
        const settled = await jobs.wait(id, 5_000, owner)
        if (!LIVE.has(settled.status)) jobs.remove(id, owner)
      } catch { /* the job is gone already */ }
      throw abortError()
    }
    const read = jobs.read(id, owner)
    if (LIVE.has(view.status)) {
      notices.watch(id, owner, label)
      const { out, err } = split(read.chunks)
      return { kind: 'promoted', cwd: receipt['cwd'], jobId: id, timeoutMs: wanted, output: out + (err === '' ? '' : `${out === '' || out.endsWith('\n') ? '' : '\n'}[stderr]\n${err}`) }
    }
    jobs.remove(id, owner)
    return foregroundResult(view, read, receipt['cwd'], wanted)
  }
}

/** What a notice carries besides its text. */
export interface NoticeExtras {
  /** Image blocks, as tool results hold them, to show the model with the text. */
  images?: readonly unknown[]
  /** Additional contexts returned by background tool calls (messages or content blocks). */
  contexts?: readonly unknown[]
  /** Queue for the agent's next step without waking it. */
  quiet?: boolean
}

export interface NoticeSink {
  /** Send one message to an agent: wake it when idle, else queue it for its next step (`quiet` never wakes). */
  deliver(owner: string, text: string, summary: string, extras?: NoticeExtras): void
}

const NOTICE_SHOWN = 20
/** Jobs ending this close together share one notice. */
export const NOTICE_WINDOW_MS = 2_000
/** Re-arm the wait well inside any host cap on one wait. */
const WATCH_SLICE_MS = 6 * 60 * 60 * 1000

/**
 * One notice for background jobs that end close together. Waiting on a job
 * makes its settlement "awaited", so DSH's tool-jobs skips its own per-job
 * notice; a job the model already collected (job_output saw it finished, or
 * the model killed it) gets no notice at all.
 */
export class JobNotices {
  readonly #jobs: () => JobsService | undefined
  readonly #sink: NoticeSink
  readonly #watched = new Set<string>()
  readonly #collected = new Set<string>()
  readonly #pending = new Map<string, JobView[]>()
  readonly #timers = new Map<string, NodeJS.Timeout>()
  /** Images a `repl.background` job's tool calls returned after its cell, delivered with its end. */
  readonly #images = new Map<string, { images: readonly unknown[]; dropped: number }>()
  /** Non-image contexts from background tool calls, delivered with the same end notice. */
  readonly #contexts = new Map<string, readonly unknown[]>()
  #disposed = false

  constructor(jobs: () => JobsService | undefined, sink: NoticeSink) {
    this.#jobs = jobs
    this.#sink = sink
  }

  watch(id: string, owner: string, label: string): void {
    if (this.#disposed || this.#watched.has(id)) return
    this.#watched.add(id)
    void this.#follow(id, owner, label)
  }

  /** The model already has this job's end (a finished job_output, a job_kill). */
  collected(id: string): void {
    this.#collected.add(id)
  }

  /** Images/contexts to show with this job's end; sent even when its end needs no notice. */
  attach(id: string, images: readonly unknown[], dropped: number, contexts: readonly unknown[] = []): void {
    if (images.length > 0 || dropped > 0) this.#images.set(id, { images, dropped })
    if (contexts.length > 0) this.#contexts.set(id, contexts)
  }

  async #follow(id: string, owner: string, label: string): Promise<void> {
    try {
      for (;;) {
        const jobs = this.#jobs()
        if (jobs === undefined || this.#disposed) return
        const view = await jobs.wait(id, WATCH_SLICE_MS, owner)
        if (LIVE.has(view.status)) continue
        this.#queue(owner, { ...view, label: view.label ?? label })
        return
      }
    } catch {
      // Removed, or its owner went away: nobody is left to tell.
    } finally {
      this.#watched.delete(id)
    }
  }

  #queue(owner: string, view: JobView): void {
    const list = this.#pending.get(owner) ?? []
    list.push(view)
    this.#pending.set(owner, list)
    if (!this.#timers.has(owner)) {
      const timer = setTimeout(() => this.#flush(owner), NOTICE_WINDOW_MS)
      timer.unref?.()
      this.#timers.set(owner, timer)
    }
  }

  #flush(owner: string): void {
    this.#timers.delete(owner)
    const all = this.#pending.get(owner) ?? []
    const ended = all.filter((view) => !this.#collected.has(view.id))
    this.#pending.delete(owner)
    const pictures = all.flatMap((view) => {
      const found = this.#images.get(view.id)
      this.#images.delete(view.id)
      return found === undefined ? [] : [{ id: view.id, notified: !this.#collected.has(view.id), ...found }]
    })
    const contexts = all.flatMap((view) => {
      const found = this.#contexts.get(view.id)
      this.#contexts.delete(view.id)
      return found === undefined ? [] : [{ id: view.id, notified: !this.#collected.has(view.id), contexts: found }]
    })
    for (const view of all) this.#collected.delete(view.id)
    if (this.#disposed) return
    const imageLine = (list: typeof pictures) => list.map((p) => `Images from ${p.id}'s tool calls after its cell ended: ${p.images.length}`
      + (p.dropped > 0 ? ` shown, ${p.dropped} more not kept` : '')).join('\n')
    // A job the model already collected gets no notice, but its images still have to reach it.
    const quietPictures = pictures.filter((p) => !p.notified)
    const quietContexts = contexts.filter((p) => !p.notified)
    if (quietPictures.length > 0 || quietContexts.length > 0) {
      try {
        this.#sink.deliver(owner, imageLine(quietPictures), 'contexts from background jobs', {
          ...(quietPictures.length > 0 ? { images: quietPictures.flatMap((p) => p.images) } : {}),
          ...(quietContexts.length > 0 ? { contexts: quietContexts.flatMap((p) => p.contexts) } : {}),
          quiet: true,
        })
      } catch { /* the owner is gone */ }
    }
    if (ended.length === 0) return
    const noticed = pictures.filter((p) => p.notified)
    const noticedContexts = contexts.filter((p) => p.notified)
    const line = (view: JobView) => `- ${view.id} (${(view.label ?? '').replace(/\s+/g, ' ').slice(0, 80)}): ${view.status}${view.detail ? `, ${view.detail}` : ''}`
    const shown = ended.slice(0, NOTICE_SHOWN).map(line)
    if (ended.length > NOTICE_SHOWN) shown.push(`- … and ${ended.length - NOTICE_SHOWN} more`)
    const head = ended.length === 1 ? 'A background job finished:' : `${ended.length} background jobs finished:`
    const text = `${head}\n${shown.join('\n')}\nIn a cell, \`await\` the job's handle, or read new output with tools.job_output({"job_id": ...}).`
      + (noticed.length > 0 ? `\n${imageLine(noticed)}` : '')
    try {
      const extras = {
        ...(noticed.length > 0 ? { images: noticed.flatMap((p) => p.images) } : {}),
        ...(noticedContexts.length > 0 ? { contexts: noticedContexts.flatMap((p) => p.contexts) } : {}),
      }
      this.#sink.deliver(owner, text, ended.length === 1 ? `job ${ended[0]!.id} finished` : `${ended.length} jobs finished`,
        Object.keys(extras).length > 0 ? extras : undefined)
    } catch { /* the owner is gone */ }
  }

  dispose(): void {
    this.#disposed = true
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
  }
}

export interface Unfinished {
  jobs: Array<{ id: string; label: string }>
  subagents: Array<{ id: string; label: string }>
}

/**
 * Background jobs and subagents still running, recorded at a compaction:
 * DSH's summary keeps only a generic "pending jobs" line, so the model loses
 * the ids it would await or message. Goals are not listed: DSH repeats the
 * objective every goal round. Undefined when nothing is running.
 */
export function listUnfinished(
  jobs: { list?(caller: string): Array<{ id: string; label?: string; status: string }> } | undefined,
  agents: { get?(id: string): { status?: string } | undefined } | undefined,
  owner: string | undefined,
  subagents: ReadonlyArray<{ id: string; label: string }>,
  shown: number,
): Unfinished | undefined {
  const live = owner === undefined ? [] : (jobs?.list?.(owner) ?? [])
    .filter((job) => LIVE.has(job.status))
    .map((job) => ({ id: job.id, label: (job.label ?? '').replace(/\s+/g, ' ').slice(0, 80) }))
  const running = subagents.filter((s) => {
    const status = agents?.get?.(s.id)?.status
    return status !== undefined && status !== 'idle'
  })
  return live.length === 0 && running.length === 0 ? undefined : { jobs: live.slice(0, shown), subagents: running.slice(-shown) }
}

export function unfinishedNotice(unfinished: Unfinished): string {
  const list = (items: Array<{ id: string; label: string }>) => items.map((i) => `${i.id} (${i.label})`).join(', ')
  return 'At the last context compaction this work was still running; its completion arrives as a notice, so do not start it again'
    + (unfinished.jobs.length ? `. Background jobs: ${list(unfinished.jobs)}` : '')
    + (unfinished.subagents.length ? `. Subagents: ${list(unfinished.subagents)}` : '') + '.'
}
