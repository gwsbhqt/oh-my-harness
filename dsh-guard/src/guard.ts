import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { BlankRunDetector, RepetitionDetector, type LoopMatch, type LoopRules } from './detector.ts'

export const OUTPUT_LOOP_CODE = 'OUTPUT_LOOP_DETECTED'
export const REASONING_ONLY_CODE = 'REASONING_ONLY_RESPONSE'
export const TOOL_ARGS_TOO_LONG_CODE = 'TOOL_ARGS_TOO_LONG'

export interface OutputGuardOptions {
  readonly rules: LoopRules
  readonly maxBlankRun: number
  readonly maxToolArgsChars: number
  readonly reasoningOnlyGuard: boolean
  readonly provider: string
  readonly model: string
}

function failureChunk(code: string, message: string): StreamChunk {
  return { type: 'finish', reason: { kind: 'error', failure: { code, message } } }
}

export function loopFailure(provider: string, model: string, match: LoopMatch): StreamChunk {
  return failureChunk(
    OUTPUT_LOOP_CODE,
    `model "${model}" on "${provider}" repeated one output suffix ${match.repeats} times; the request was stopped`,
  )
}

export function blankFailure(provider: string, model: string, run: number): StreamChunk {
  return failureChunk(
    OUTPUT_LOOP_CODE,
    `model "${model}" on "${provider}" emitted ${run} consecutive blank characters; the request was stopped`,
  )
}

export function toolArgsFailure(provider: string, model: string, chars: number): StreamChunk {
  return failureChunk(
    TOOL_ARGS_TOO_LONG_CODE,
    `model "${model}" on "${provider}" wrote ${chars} characters into one tool call; the request was stopped`,
  )
}

export function guardOutputStream(source: AsyncIterable<StreamChunk>, options: OutputGuardOptions): AsyncIterable<StreamChunk> {
  return (async function* () {
    const detectors = new Map<number, RepetitionDetector>()
    const blanks = new Map<number, BlankRunDetector>()
    const toolArgs = new Map<number, number>()
    let hasContent = false
    let hasToolCall = false
    for await (const chunk of source) {
      if (chunk.type === 'block-start' && chunk.blockType === 'tool-call') hasToolCall = true
      if (chunk.type === 'tool-call-delta') hasToolCall = true
      if (chunk.type === 'text-delta' && chunk.text.trim().length > 0) hasContent = true
      if (chunk.type === 'block-end') {
        const block = chunk.block
        if (block.type === 'text' && block.text.trim().length > 0) hasContent = true
        if (block.type === 'tool-call') hasToolCall = true
        if (block.type === 'image' || block.type === 'file') hasContent = true
        detectors.delete(chunk.index)
        blanks.delete(chunk.index)
        toolArgs.delete(chunk.index)
      }
      if (chunk.type === 'tool-call-delta') {
        const chars = (toolArgs.get(chunk.index) ?? 0) + chunk.argumentsDelta.length
        toolArgs.set(chunk.index, chars)
        if (chars > options.maxToolArgsChars) {
          yield toolArgsFailure(options.provider, options.model, chars)
          return
        }
      }
      const raw = chunk.type === 'text-delta' || chunk.type === 'reasoning-delta'
        ? { index: chunk.index, text: chunk.text }
        : chunk.type === 'tool-call-delta' ? { index: chunk.index, text: chunk.argumentsDelta } : undefined
      if (raw !== undefined && raw.text.length > 0) {
        let blank = blanks.get(raw.index)
        if (blank === undefined) {
          blank = new BlankRunDetector(options.maxBlankRun, chunk.type === 'tool-call-delta')
          blanks.set(raw.index, blank)
        }
        const run = blank.push(raw.text)
        if (run !== undefined) {
          yield blankFailure(options.provider, options.model, run)
          return
        }
      }
      if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
        let detector = detectors.get(chunk.index)
        if (detector === undefined) {
          detector = new RepetitionDetector(options.rules)
          detectors.set(chunk.index, detector)
        }
        const match = detector.push(chunk.text)
        if (match !== undefined) {
          yield loopFailure(options.provider, options.model, match)
          return
        }
      }
      if (chunk.type === 'finish' && options.reasoningOnlyGuard && !hasContent && (chunk.reason.kind === 'max-tokens' || (chunk.reason.kind === 'stop' && !hasToolCall))) {
        yield {
          ...chunk,
          reason: {
            kind: 'error',
            failure: {
              code: REASONING_ONLY_CODE,
              message: `model "${options.model}" on "${options.provider}" stopped with reasoning but no answer or tool call`,
            },
          },
        }
        return
      }
      yield chunk
    }
  })()
}
