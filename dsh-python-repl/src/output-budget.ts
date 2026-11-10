/**
 * Keep one cell's own output within a token budget.
 *
 * DSH caps every tool result at the profile's shared budget (about 12.5K
 * tokens here), which is right for a fetched page but far too much for one
 * cell that ended on a 200 000-item list by mistake: the model pays for
 * twelve thousand tokens of digits it never wanted. Prime truncates per
 * execution on its host for the same reason. The full text goes to DSH's own
 * spill store, so nothing is lost and no second storage scheme exists.
 */

/** What the spill store gave back for the saved text. */
export interface SavedOutput {
  locator: string
  retrievalHint?: string | undefined
}

/** Persists the full text; undefined or a rejection leaves the output whole. */
export type SaveOutput = (text: string) => Promise<SavedOutput | undefined>

/** Rough cost of one character: ASCII runs about 4 to a token, other scripts about 1. */
function charCost(code: number): number {
  return code < 0x80 ? 0.25 : 1
}

/** Estimated tokens in `text`, by the same per-character rule the cut uses. */
export function estimateTokens(text: string): number {
  let total = 0
  for (const ch of text) total += charCost(ch.codePointAt(0)!)
  return Math.ceil(total)
}

/** Longest prefix (or suffix) of `text` whose estimate fits `budget`, never splitting a code point. */
function fit(text: string, budget: number, fromEnd: boolean): string {
  const chars = Array.from(text)
  let used = 0
  let count = 0
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[fromEnd ? chars.length - 1 - i : i]!
    used += charCost(ch.codePointAt(0)!)
    if (used > budget) break
    count++
  }
  return fromEnd ? chars.slice(chars.length - count).join('') : chars.slice(0, count).join('')
}

/**
 * Return `logs` unchanged when they fit, otherwise the start, the end and a
 * notice naming where the whole text was saved. Without a place to save it the
 * output stays whole: hiding text the model cannot get back would be worse.
 */
export async function boundCellOutput(
  logs: readonly string[],
  maxTokens: number,
  save: SaveOutput | undefined,
): Promise<string[]> {
  if (maxTokens <= 0 || save === undefined || logs.length === 0) return [...logs]
  // DSH joins a cell's log entries with newlines; measure what the model would see.
  const joined = logs.join('\n')
  const tokens = estimateTokens(joined)
  if (tokens <= maxTokens) return [...logs]
  let saved: SavedOutput | undefined
  try {
    saved = await save(joined)
  } catch {
    saved = undefined
  }
  if (saved === undefined) return [...logs]
  const head = fit(joined, Math.floor((maxTokens * 2) / 3), false)
  const tail = fit(joined, Math.floor(maxTokens / 3), true)
  const omitted = joined.length - head.length - tail.length
  return [
    head,
    `[... ${omitted} characters omitted ...]`,
    tail,
    `[dsh-python-repl] This cell's output was about ${tokens} tokens (${joined.length} characters), over the `
      + `${maxTokens}-token budget for one cell, so only its start and end are shown. The whole output is saved at `
      + `${saved.locator}${saved.retrievalHint ? ` (${saved.retrievalHint})` : ''}. Do not run the cell again to see the rest: `
      + 'read the saved file, or slice, filter or count the value in Python.',
  ]
}

/** Whether {@link boundCellOutput} cut these logs. */
export function wasCut(logs: readonly string[]): boolean {
  const last = logs.at(-1) ?? ''
  return last.startsWith("[dsh-python-repl] This cell's output was about") && last.includes('budget for one cell')
}

/** A cell's own output this large gets one soft note; half of the default 8,000-token budget. */
export const SOFT_OUTPUT_TOKENS = 4_000
/** Cells between two soft notes, so a session that reads files on purpose is not nagged every cell. */
export const SOFT_NOTE_EVERY = 10

export function softOutputNote(tokens: number): string {
  return `[dsh-python-repl] This cell displayed about ${tokens} tokens; every token stays in the context. `
    + 'Keep large values in variables and show a slice, a count or the fields you need.'
}
