/**
 * What the `run_code` row shows, derived from the call — the same derivation
 * as the host's generic row (dsh-client-ui-tool `toolRowModel`), for the one
 * tool this view owns. Pure, so it is tested without React.
 */

/** The two lifecycle forms a tool call arrives in (only what this row reads). */
export interface RunningCall {
  readonly callId: string
  readonly argsRaw?: string | undefined
}
export interface FinishedCall {
  readonly kind: string
  readonly callId: string
  readonly call?: { readonly argsRaw?: string | undefined } | undefined
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>
  readonly isError?: boolean | undefined
  readonly error?: { readonly name?: string; readonly code?: string } | undefined
}
export type CallBlock = RunningCall | FinishedCall

export type RowState = 'running' | 'ok' | 'error' | 'stopped'

/**
 * A stopped run_code is not an `interrupted` result. DSH 0.2.2 reports a
 * caller-cancelled run_code as ABORTED / AbortError; 0.2.1 threw
 * CodeRunFailedError and carried the abort only in the text prefix. The old
 * form stays for sessions recorded under 0.2.1: their history still renders
 * through this, though no running host produces it any more.
 */
function stoppedRun(block: FinishedCall): boolean {
  const code = block.error?.code
  if (code === 'ABORTED' || code === 'ABORTED_BEFORE_DISPATCH' || block.error?.name === 'AbortError') return true
  if (code !== 'CODE_RUN_FAILED') return false
  const first = block.content[0]
  return first?.type === 'text' && (first.text ?? '').startsWith('Error: code run failed (abort):')
}

export interface CodeRowModel {
  state: RowState
  code: string | null
  summary: string
  output: string | null
  errorSummary: string | null
}

/** The host's generic-row derivation, plus recognising a run the user stopped (see stoppedRun). */
export function codeRowModel(block: CallBlock): CodeRowModel {
  const done = 'kind' in block
  const argsRaw = (done ? block.call?.argsRaw : block.argsRaw) ?? ''
  const state: RowState = !done
    ? 'running'
    : block.error?.code === 'interrupted' || stoppedRun(block) ? 'stopped' : block.isError === true ? 'error' : 'ok'
  let args: { code?: unknown; description?: unknown } | undefined
  try {
    const parsed: unknown = JSON.parse(argsRaw)
    if (parsed !== null && typeof parsed === 'object') args = parsed as typeof args
  } catch {
    // Still streaming: the arguments are not complete JSON yet.
  }
  const code = typeof args?.code === 'string' && args.code !== '' ? args.code : argsRaw === '' ? null : argsRaw
  const description = typeof args?.description === 'string' && args.description !== '' ? args.description : null
  let output: string | null = null
  if (done) {
    const parts = block.content.map((c) => (c.type === 'text' ? c.text ?? '' : JSON.stringify(c, null, 2)))
    if (parts.length === 0 && block.error !== undefined) parts.push(`${block.error.name}: ${block.error.code}`)
    output = parts.join('\n') || null
  }
  const errorSummary = state === 'error' && output !== null ? output.split('\n', 1)[0] ?? null : null
  return { state, code, summary: description ?? block.callId, output, errorSummary }
}
