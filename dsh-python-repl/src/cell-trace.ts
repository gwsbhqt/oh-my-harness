/**
 * The bridge calls one cell made, kept by the host while the cell runs.
 *
 * Used for three things the kernel cannot see on its own: the list of calls a
 * failed or cancelled cell already made (so the model continues instead of
 * re-running effects), bash calls that queued behind each other, and how long
 * the cell spent in Python itself rather than waiting on tools.
 */

import type { BoundTool } from './lease.ts'
import type { ToolSchemaLike } from './catalog.ts'

export interface TracedCall {
  n: number
  tool: string
  preview: string
  /** `running` stays when the cell ended first; DSH then cancels the call. */
  status: 'running' | 'ok' | 'error'
  startedAt: number
  endedAt?: number
  /** A bash call started as a background job: it does not hold the bash slot. */
  background: boolean
}

export interface CellTrace {
  calls: TracedCall[]
  startedAt?: number
  endedAt?: number
}

const SHOWN = 10
const PREVIEW = 70
/** Python time (tool waits excluded) after which a cell gets a note; Prime's single-cell reminder is 60 s. */
export const PYTHON_NOTE_MS = 60_000

const clip = (text: string, keepEnd = false): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= PREVIEW) return flat
  // A path's file name is at its end.
  return keepEnd ? `…${flat.slice(flat.length - PREVIEW + 1)}` : `${flat.slice(0, PREVIEW - 1)}…`
}

/** The argument that names what a call acted on: a path, a command, else the first short string. */
export function argPreview(tool: string, args: unknown): string {
  if (args === null || typeof args !== 'object') return ''
  const record = args as Record<string, unknown>
  for (const key of ['file_path', 'command', 'pattern', 'job_id', 'path', 'url', 'description']) {
    if (typeof record[key] === 'string') return clip(record[key] as string, key === 'file_path' || key === 'path')
  }
  const first = Object.values(record).find((value) => typeof value === 'string')
  return typeof first === 'string' ? clip(first) : tool
}

export function newCall(n: number, tool: string, args: unknown): TracedCall {
  const background = tool === 'bash' && args !== null && typeof args === 'object'
    && (args as Record<string, unknown>)['run_in_background'] === true
  return { n, tool, preview: argPreview(tool, args), status: 'running', startedAt: Date.now(), background }
}

const STATUS: Record<TracedCall['status'], string> = { ok: 'ok', error: 'failed', running: 'still running when the cell stopped; DSH cancels it' }

/**
 * What a failed or cancelled cell already did. Codex #49908 / Pydantic: without
 * it the model re-runs the whole cell and repeats writes. Empty when no calls.
 */
export function callsReport(calls: readonly TracedCall[]): string {
  if (calls.length === 0) return ''
  const shown = calls.slice(-SHOWN)
  const earlier = calls.slice(0, calls.length - shown.length)
  const lines = [`Tool calls this cell made before it stopped (${calls.length}):`]
  if (earlier.length > 0) {
    const failed = earlier.filter((call) => call.status !== 'ok').length
    lines.push(`  #1-#${earlier.length}: ${earlier.length - failed} ok${failed > 0 ? `, ${failed} not ok` : ''} (not listed)`)
  }
  for (const call of shown) lines.push(`  #${call.n} ${call.tool}${call.preview === '' || call.preview === call.tool ? '' : ` ${call.preview}`}: ${STATUS[call.status]}`)
  const lastOk = [...calls].reverse().find((call) => call.status === 'ok')
  lines.push(`${lastOk === undefined ? 'None of them succeeded.' : `Last call that succeeded: #${lastOk.n} ${lastOk.tool}.`} `
    + 'Completed calls are not undone: continue from the first one that did not succeed instead of re-running the whole cell.')
  return lines.join('\n')
}

/** Cell time not covered by any bridge call: Python running, sleeping, or blocked. */
export function pythonMs(trace: CellTrace): number {
  if (trace.startedAt === undefined || trace.endedAt === undefined) return 0
  const end = trace.endedAt
  const spans = trace.calls.map((call) => [Math.max(call.startedAt, trace.startedAt!), Math.min(call.endedAt ?? end, end)] as const)
    .filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  let covered = 0
  let reach = trace.startedAt
  for (const [a, b] of spans) {
    if (b <= reach) continue
    covered += b - Math.max(a, reach)
    reach = b
  }
  return Math.max(0, end - trace.startedAt - covered)
}

/** Notes for the end of a cell that finished or failed; `subagent`: the session is a delegated subagent (src/subagent.ts). */
export function traceNotes(trace: CellTrace, subagent = false): string[] {
  const notes: string[] = []
  const python = pythonMs(trace)
  if (python >= PYTHON_NOTE_MS) {
    notes.push(subagent
      ? `This cell spent ${Math.round(python / 1000)}s in Python itself (tool waits not counted). `
        + 'For long computation, `await repl.background(work)` frees the kernel for other cells. You are a subagent: ending your turn stops that work with no notice, so `await` it in a later cell before you finish.'
      : `This cell spent ${Math.round(python / 1000)}s in Python itself (tool waits not counted). The user cannot reach you while a cell runs. `
        + 'To wait for something, end the turn: background jobs and subagents wake you when they finish. For long computation, `await repl.background(work)` runs it after the cell ends and DSH wakes you when it is done.')
  }
  return notes
}

function promotesOnTimeout(schema: ToolSchemaLike | undefined): boolean {
  const properties = (schema?.parameters as { properties?: Record<string, { description?: unknown }> } | undefined)?.properties
  const description = properties?.['timeoutMs']?.description
  return typeof description === 'string' && description.includes('moves to the background')
}

/**
 * Keep a cell from waiting long on one command or job (setting cellWaitMs).
 * bash: only where DSH moves a timed-out command to a background job, never
 * where the timeout kills it. job_output: caps `wait: true`. A cell that waits
 * blocks the user; DSH's job notice wakes a root agent when the work ends. A
 * subagent gets no notice, so its cap is raised instead (src/subagent.ts).
 */
export function withWaitCap(tool: string, fn: BoundTool, schema: ToolSchemaLike | undefined, capMs: number): BoundTool {
  if (!(capMs > 0)) return fn
  const object = (args: unknown): args is Record<string, unknown> => args !== null && typeof args === 'object' && !Array.isArray(args)
  if (tool === 'bash' && promotesOnTimeout(schema)) {
    return (args) => fn(object(args) && args['run_in_background'] !== true
      ? { ...args, timeoutMs: Math.min(typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : Infinity, capMs) }
      : args)
  }
  if (tool === 'job_output') {
    return (args) => fn(object(args) && args['wait'] === true
      ? { ...args, timeout_ms: Math.min(typeof args['timeout_ms'] === 'number' ? args['timeout_ms'] : 30_000, capMs) }
      : args)
  }
  return fn
}
