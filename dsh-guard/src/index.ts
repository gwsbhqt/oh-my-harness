import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, isAgentLoopRequest, type UserMessage } from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'
import { live } from '../../tooling/runtime/live.mjs'
import { reminderSummary, reminderText } from '../../tooling/runtime/notice.mjs'
import type { LoopRules } from './detector.ts'
import { guardOutputStream, OUTPUT_LOOP_CODE, REASONING_ONLY_CODE, TOOL_ARGS_TOO_LONG_CODE } from './guard.ts'

export const name = 'dsh-guard'
export const inject = ['llm', 'agents']

export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  reasoningOnlyGuard: z.boolean().default(true).volatile(),
  autoRetry: z.boolean().default(true).volatile(),
  repeatCount: z.number().step(1).min(4).max(20).default(8).volatile(),
  minCycleChars: z.number().step(1).min(4).max(128).default(4).volatile(),
  maxCycleChars: z.number().step(1).min(16).max(512).default(160).volatile(),
  minRepeatedChars: z.number().step(1).min(32).max(1024).default(64).volatile(),
  windowChars: z.number().step(1).min(256).max(8192).default(1000).volatile(),
  maxBlankRun: z.number().step(1).min(500).max(100000).default(2000).volatile(),
  maxToolArgsChars: z.number().step(1000).min(5000).max(1000000).default(50000).volatile(),
})

type ConfigCells = ReturnType<typeof Config>

export interface OutputGuardConfig extends LoopRules {
  readonly enabled: boolean
  readonly reasoningOnlyGuard: boolean
  readonly autoRetry: boolean
  readonly maxBlankRun: number
  readonly maxToolArgsChars: number
}

export function resolveConfig(config: ConfigCells): OutputGuardConfig {
  return {
    enabled: live(config.enabled),
    reasoningOnlyGuard: live(config.reasoningOnlyGuard),
    autoRetry: live(config.autoRetry),
    repeatCount: live(config.repeatCount),
    minCycleChars: live(config.minCycleChars),
    maxCycleChars: live(config.maxCycleChars),
    minRepeatedChars: live(config.minRepeatedChars),
    windowChars: live(config.windowChars),
    maxBlankRun: live(config.maxBlankRun),
    maxToolArgsChars: live(config.maxToolArgsChars),
  }
}

const LOOP_NOTICE = 'The previous output was stopped because it repeated itself or emitted a long blank run, so it never produced a useful answer. Do not continue or repeat that text. Return to the user\'s latest request, try a different approach, take the next verifiable step, and finish with an answer. If you cannot make progress, say why.'
const TOO_LONG_NOTICE = 'The previous tool call was stopped before execution because its arguments exceeded the limit. Do not write one equally long block. Split the work into steps: write a long file as a skeleton and append in parts, put large data in a file and read it back, and do one thing per call.'
const REASONING_NOTICE = 'The previous reply stopped after reasoning with no answer or tool call; the task is not complete. Return to the user\'s latest request, take a concrete action or give a clear answer. If you cannot make progress, say why.'
const LOOP_TITLE = 'Output stopped: repeated text or a long blank run'
const TOO_LONG_TITLE = 'Tool call stopped: arguments too long'
const REASONING_TITLE = 'Reply stopped: reasoning only, no answer or tool call'

function noticeFor(code: string): { title: string, text: string } {
  if (code === TOOL_ARGS_TOO_LONG_CODE) return { title: TOO_LONG_TITLE, text: TOO_LONG_NOTICE }
  if (code === REASONING_ONLY_CODE) return { title: REASONING_TITLE, text: REASONING_NOTICE }
  return { title: LOOP_TITLE, text: LOOP_NOTICE }
}

function appendRetryNotice(agent: Agent, code: string): void {
  const notice = noticeFor(code)
  const source = { kind: 'output-guard', form: 'notice', summary: reminderSummary('dsh-guard', notice.title) } as unknown as UserMessage['source']
  const message = createUserMessage({
    source,
    content: [{ type: 'text', text: reminderText('dsh-guard', notice.title, notice.text) }],
  })
  agent.session.append('user/message', message, { surfaceOp: 'append' })
}

export function apply(ctx: Context, config: ConfigCells): void {
  const retries = new WeakMap<Agent, Map<string, number>>()
  ctx.on('llm/stream', (options, next) => {
    const current = resolveConfig(config)
    if (!current.enabled || !isAgentLoopRequest(options)) return next()
    return guardOutputStream(next(), {
      rules: current,
      maxBlankRun: current.maxBlankRun,
      maxToolArgsChars: current.maxToolArgsChars,
      reasoningOnlyGuard: current.reasoningOnlyGuard,
      provider: options.provider,
      model: options.model,
    })
  })
  ctx.on('agent/pre-step', ({ agent }, next) => {
    retries.get(agent)?.clear()
    return next()
  })
  ctx.on('agent/request-error', async ({ agent, turn, step, failure }, next) => {
    const current = resolveConfig(config)
    if (!current.enabled || !current.autoRetry || ![OUTPUT_LOOP_CODE, REASONING_ONLY_CODE, TOOL_ARGS_TOO_LONG_CODE].includes(failure.code)) return next()
    const key = `${turn}:${step}`
    let counts = retries.get(agent)
    if (counts === undefined) {
      counts = new Map()
      retries.set(agent, counts)
    }
    if ((counts.get(key) ?? 0) >= 1) return next()
    counts.set(key, 1)
    appendRetryNotice(agent, failure.code)
    return { kind: 'retry' }
  })
  ctx.on('agent/disposed', ({ agent }) => {
    retries.delete(agent)
    return undefined
  })
}
