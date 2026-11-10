/**
 * Wire protocol for the vendored Prime REPL kernel (protocol 3).
 *
 * Newline-delimited JSON over stdin/stdout, one object per line, UTF-8.
 * The shapes here mirror `vendor/prime/rlm/repl.md`; they are NOT invented.
 * Anything this file cannot prove from that document is absent on purpose.
 *
 * @module
 */

/** The protocol version this bridge speaks. The kernel announces it in `ready`. */
export const PROTOCOL_VERSION = 3

/** Requests the bridge sends to the kernel. */
export type KernelRequest =
  | { type: 'execute'; id: string; code: string }
  | { type: 'interrupt'; id?: string }
  | { type: 'host_reply'; id: string; data: HostReplyData }
  | { type: 'snapshot'; id: string; path: string; manifest_path: string }
  | { type: 'restore'; id: string; path: string }
  | { type: 'list_names'; id: string; preview?: { name: string; epoch: number } }
  | { type: 'shutdown'; id?: string }

/**
 * Reply to a `host_request`. The kernel distinguishes success from failure by
 * the `status` field, not by the transport.
 */
export type HostReplyData =
  | { status: 'ok'; result: unknown }
  | { status: 'error'; error: string; cancelled?: true }

/** Events the kernel sends back. */
export type KernelEvent =
  | { event: 'ready'; protocol: number; python: string }
  | { event: 'stdout' | 'stderr'; id: string | null; text: string }
  | { event: 'result'; id: string; text: string }
  | { event: 'display'; id: string | null; data: Record<string, unknown> }
  | { event: 'host_request'; id: string; data: unknown }
  | { event: 'error'; id: string | null; ename: string; evalue: string; traceback?: string[] }
  | { event: 'done'; id: string; status: 'ok' | 'error'; [k: string]: unknown }

/** A `host_request` payload as this bridge issues it: one tool call from Python. */
export interface HostToolRequest {
  /** Discriminator so a future second request kind stays distinguishable. */
  kind: 'tool_call'
  /** The cell that owns this call — the kernel does NOT supply it, our Python shim does. */
  runId: string
  /** Kernel generation, so a reply from a dead kernel can never be honoured. */
  epoch: number
  /** Registered DSH tool name as exposed to the program. */
  tool: string
  /** Losslessly JSON-serializable arguments. */
  args: unknown
  /** Set when the call comes from `repl.background` work (python/background.py); used only once its cell has ended. */
  jobId?: string
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isCellId = (value: unknown): value is string | null => value === null || typeof value === 'string'
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Whether a decoded object carries every field its event type needs, with the
 * right types. A frame that is valid JSON but misses one (`{"event":"stdout",
 * "id":null}` with no `text`) would otherwise reach the dispatcher and throw
 * inside the pipe listener, where an exception ends the whole host process.
 * Unknown event names are rejected too: guessing at them is how a
 * half-understood frame gets acted on.
 */
function isKernelEvent(frame: Record<string, unknown>): boolean {
  switch (frame['event']) {
    case 'ready':
      return Number.isSafeInteger(frame['protocol']) && isString(frame['python'])
    case 'stdout':
    case 'stderr':
      return isCellId(frame['id']) && isString(frame['text'])
    case 'result':
      return isString(frame['id']) && isString(frame['text'])
    case 'display':
      return isCellId(frame['id']) && isRecord(frame['data'])
    case 'host_request':
      return isString(frame['id']) && 'data' in frame
    case 'error': {
      const traceback = frame['traceback']
      return isCellId(frame['id']) && isString(frame['ename']) && isString(frame['evalue'])
        && (traceback === undefined || (Array.isArray(traceback) && traceback.every(isString)))
    }
    case 'done':
      return isString(frame['id']) && ['ok', 'error'].includes(frame['status'] as string)
    default:
      return false
  }
}

/**
 * Parse one protocol line. Returns `undefined` for a line that is not a
 * well-formed frame — not JSON, not an object, an unknown event, or missing a
 * field its event requires. The caller decides whether that is fatal. We never
 * guess at a partially-understood frame.
 */
export function parseEvent(line: string): KernelEvent | undefined {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !isKernelEvent(parsed)) return undefined
  return parsed as unknown as KernelEvent
}

/** Narrow a `host_request` payload to our tool-call shape, or `undefined`. */
export function asToolRequest(data: unknown): HostToolRequest | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const d = data as Record<string, unknown>
  if (d['kind'] !== 'tool_call') return undefined
  if (typeof d['runId'] !== 'string') return undefined
  if (typeof d['epoch'] !== 'number') return undefined
  if (typeof d['tool'] !== 'string') return undefined
  return {
    kind: 'tool_call',
    runId: d['runId'],
    epoch: d['epoch'],
    tool: d['tool'],
    args: d['args'],
    ...(typeof d['jobId'] === 'string' ? { jobId: d['jobId'] } : {}),
  }
}

/** `repl.background` bookkeeping from the kernel (python/background.py): register a job, or report how it ended. */
export type BackgroundRequest =
  | { kind: 'background'; op: 'start'; epoch: number; runId: string; label: string }
  | { kind: 'background'; op: 'end'; epoch: number; jobId: string; status: 'completed' | 'failed' | 'killed'; detail: string; text: string }
  | { kind: 'background'; op: 'progress'; epoch: number; jobId: string; text: string }

export function asBackgroundRequest(data: unknown): BackgroundRequest | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const d = data as Record<string, unknown>
  if (d['kind'] !== 'background' || typeof d['epoch'] !== 'number') return undefined
  if (d['op'] === 'start' && typeof d['runId'] === 'string' && typeof d['label'] === 'string') {
    return { kind: 'background', op: 'start', epoch: d['epoch'], runId: d['runId'], label: d['label'] || 'python work' }
  }
  if (d['op'] === 'progress' && typeof d['jobId'] === 'string' && typeof d['text'] === 'string') {
    return { kind: 'background', op: 'progress', epoch: d['epoch'], jobId: d['jobId'], text: d['text'] }
  }
  const status = d['status']
  if (d['op'] === 'end' && typeof d['jobId'] === 'string' && (status === 'completed' || status === 'failed' || status === 'killed')) {
    return { kind: 'background', op: 'end', epoch: d['epoch'], jobId: d['jobId'], status,
      detail: typeof d['detail'] === 'string' ? d['detail'] : '', text: typeof d['text'] === 'string' ? d['text'] : '' }
  }
  return undefined
}

/** `repl.agent` from the kernel (python/agents.py): start a child and wait for its result, or stop one whose Python side was cancelled. */
export type AgentRequest =
  | { kind: 'agent'; op: 'run'; epoch: number; runId: string; jobId?: string; callId: string; prompt: string; label: string; schema?: Record<string, unknown>; provider?: string; model?: string }
  | { kind: 'agent'; op: 'cancel'; epoch: number; callId: string }

export function asAgentRequest(data: unknown): AgentRequest | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const d = data as Record<string, unknown>
  if (d['kind'] !== 'agent' || typeof d['epoch'] !== 'number' || typeof d['callId'] !== 'string') return undefined
  if (d['op'] === 'cancel') return { kind: 'agent', op: 'cancel', epoch: d['epoch'], callId: d['callId'] }
  if (d['op'] !== 'run' || typeof d['runId'] !== 'string' || typeof d['prompt'] !== 'string' || d['prompt'].trim() === '') return undefined
  const schema = d['schema']
  if (schema !== undefined && (typeof schema !== 'object' || schema === null || Array.isArray(schema))) return undefined
  const optional = (key: string) => typeof d[key] === 'string' && d[key] !== '' ? { [key]: d[key] as string } : {}
  return {
    kind: 'agent', op: 'run', epoch: d['epoch'], runId: d['runId'], callId: d['callId'], prompt: d['prompt'],
    label: typeof d['label'] === 'string' && d['label'] !== '' ? d['label'].slice(0, 200) : 'repl.agent',
    ...optional('jobId'), ...optional('provider'), ...optional('model'),
    ...(schema === undefined ? {} : { schema: schema as Record<string, unknown> }),
  }
}

/** Serialize one request as a protocol line (including the trailing newline). */
export function encodeRequest(request: KernelRequest): string {
  return `${JSON.stringify(request)}\n`
}
