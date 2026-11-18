import { finished, type Readable, type Writable } from 'node:stream'
import { lastAssistantStreamChunk } from '@deepseek-ai/dsh-llm/assistant-stream'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { JsonRpcLineTransport, type InitializeResult, type SessionEventNotification, type SessionPromptResult } from '@deepseek-ai/dsh-sdk-protocol'
import type {} from '@deepseek-ai/dsh-agent'

interface DialogOptions {
  cwd: string
  provider: string
  model: string
  sessionId: string
  prompts: readonly string[]
  onTurn: (index: number, events: string, elapsedMs: number) => Promise<boolean>
}

type SessionEvent = SessionEventNotification['event']
const observed = new Set<SessionEvent['type']>([
  'turn/start', 'turn/end', 'step/start', 'step/end', 'agent/inbox/spliced', 'user/message',
  'assistant/attempt', 'assistant/message', 'tool/call', 'tool/result',
])

/** A receipt can follow the turn. A rejected pre-step can claim it without appending user/message. */
function promptInterval(events: readonly SessionEvent[], messageId: string) {
  let open: { index: number; turn: number } | undefined
  let start = events.length
  let end = events.length
  let admitted = false
  let queueIndex: number | undefined
  for (const [index, event] of events.entries()) {
    if (event.type === 'turn/start') open = { index, turn: event.data.turn }
    if (event.type === 'turn/end' && event.data.turn === open?.turn) open = undefined
    if (event.type === 'user/message' && event.surfaceOp === 'append' && open) {
      if (event.data.id === messageId) {
        start = open.index
        admitted = true
      } else if (open.index > start && event.data.source.kind === 'user') {
        // wait includes descendant-triggered root turns, but a different human input owns its own run.
        end = open.index
        break
      }
    }
    if (event.type !== 'agent/inbox/spliced' || event.data.target !== 'next-turn') continue
    const { start: position, removedCount = 0, inserted, outcome } = event.data
    const offset = inserted.findIndex(message => message.id === messageId)
    if (offset !== -1) queueIndex = position + offset
    else if (queueIndex !== undefined && position <= queueIndex) {
      if (queueIndex < position + removedCount) {
        if (outcome !== 'canceled' && open) start = open.index
        queueIndex = undefined
      } else queueIndex += inserted.length - removedCount
    }
  }
  return { start, end, admitted }
}

const usageFields = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const
function stepUsage(attempts: readonly (TokenUsage | undefined)[]) {
  if (!attempts.length || attempts.includes(undefined)) return null
  return Object.fromEntries(usageFields.map(field => {
    let total = 0
    for (const attempt of attempts) {
      const value = attempt?.[field]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return [field, null]
      total += value
    }
    return [field, total]
  }))
}

function toolInput(raw: string): unknown {
  try {
    return raw === '' ? {} : JSON.parse(raw, (_key, value: unknown) => {
      if (typeof value === 'number' && !Number.isFinite(value)) throw new RangeError()
      return value
    })
  } catch { return raw }
}

function projectTurn(events: readonly SessionEvent[], messageId: string, { sessionId, cwd }: DialogOptions): string {
  const { start, end, admitted } = promptInterval(events, messageId)
  const lines: string[] = []
  const emit = (event: object) => lines.push(JSON.stringify(event))
  const incomplete = () => emit({ type: 'error', message: '本次输入缺少完整的轮次或步骤结束记录' })
  emit({ type: 'session', sessionId, cwd })
  let turn: number | undefined
  let step: number | undefined
  let reason: Extract<SessionEvent, { type: 'turn/end' }>['data']['reason'] | null = null
  let answer: string | undefined
  const calls = new Map<string, number>()
  const attempts: (TokenUsage | undefined)[] = []
  for (const event of events.slice(start, end)) {
    if (event.type === 'turn/start') {
      if (turn !== undefined && !reason) incomplete()
      turn = event.data.turn
      step = undefined
      reason = null
      answer = undefined
      emit({ type: 'status', phase: 'turn_start', turn })
    } else if (!('turn' in event.data) || event.data.turn !== turn || reason) {
      continue
    } else if (event.type === 'turn/end') {
      reason = event.data.reason
      if (step !== undefined) incomplete()
      if (reason.kind === 'completed' && (!admitted || answer === undefined)) {
        emit({ type: 'error', message: '本次输入缺少已提交的最终回复' })
      }
      emit({ type: 'status', phase: 'turn_end', turn, reason })
    } else if (event.type === 'step/start') {
      if (step !== undefined) incomplete()
      step = event.data.step
      answer = undefined
      attempts.length = 0
      calls.clear()
      emit({ type: 'status', phase: 'step_start', turn, step })
    } else if ('step' in event.data && event.data.step === step) {
      switch (event.type) {
        case 'assistant/attempt':
          attempts.push(lastAssistantStreamChunk(event.data.stream ?? [], 'usage')?.usage)
          break
        case 'assistant/message': {
          if (event.surfaceOp !== 'append') break
          attempts.push(event.data.usage ?? lastAssistantStreamChunk(event.data.stream ?? [], 'usage')?.usage)
          const { content } = event.data.message
          for (const block of content) {
            if (block.type === 'text' || block.type === 'reasoning') {
              emit({ type: block.type === 'text' ? 'text' : 'thinking', text: block.text })
            }
          }
          // A tool may itself conclude the turn. Its preamble is never the final answer.
          if (event.data.interrupted) answer = undefined
          else if (content.some(block => block.type === 'tool-call')) answer = ''
          else answer = content.filter(block => block.type === 'text').map(block => block.text).join('')
          break
        }
        case 'tool/call': {
          const { callId, name, arguments: raw } = event.data
          calls.set(callId, event.seq)
          emit({ type: 'tool_call', callId, tool: name, input: toolInput(raw) })
          break
        }
        case 'tool/result': {
          const { message, error } = event.data
          const callId = message.toolCallId
          const seq = calls.get(callId)
          if (event.surfaceOp !== 'append' || seq === undefined || (event.sourceEventSeqs && !event.sourceEventSeqs.some(source => source === seq))) break
          calls.delete(callId)
          const result = message.content.filter(block => block.type === 'text').map(block => block.text).join('')
          emit({ type: 'tool_result', callId, status: message.isError ? 'error' : 'completed', result, error })
          break
        }
        case 'step/end':
          emit({ type: 'status', phase: 'step_end', turn, step, usage: stepUsage(attempts) })
          if (calls.size) emit({ type: 'error', message: '本步有工具调用缺少对应的结果' })
          step = undefined
          break
      }
    }
  }
  if (!reason) incomplete()
  emit({ type: 'final', sessionId, reason, text: reason && step === undefined ? answer ?? '' : '' })
  return `${lines.join('\n')}\n`
}

/** Drive one caller-owned SDK process. Elapsed time covers prompt admission through the wait response. */
export async function driveBenchmarkDialog(input: Readable, output: Writable, options: DialogOptions): Promise<void> {
  const { cwd, provider, model, sessionId, prompts, onTurn } = options
  const rpc = new JsonRpcLineTransport(input, output)
  const connection = new AbortController()
  const disconnect = (error?: Error | null) => connection.abort(error ?? new Error('SDK 连接已结束'))
  const detachInput = finished(input, { writable: false }, disconnect)
  const detachOutput = finished(output, { readable: false }, disconnect)
  let events: SessionEvent[] | undefined
  rpc.onNotification((method, params) => {
    if (!events || method !== 'session.event' || params.sessionId !== sessionId) return
    const event = params.event as SessionEvent | undefined
    if (event && observed.has(event.type)) events.push(event)
  })
  const errors: unknown[] = []
  try {
    rpc.start()
    if (!input.readable || !output.writable) throw new Error('SDK 连接不可用')
    const initialized = await rpc.request('initialize', { cwd, provider, model }, connection.signal) as InitializeResult | null
    if (initialized?.serverInfo?.name !== 'deepseek-harness-sdk-runtime' || typeof initialized.serverInfo.version !== 'string' || !initialized.serverInfo.version) {
      throw new Error('SDK 握手未返回官方运行时身份')
    }
    for (const [index, prompt] of prompts.entries()) {
      events = []
      const started = performance.now()
      const receipt = await rpc.request('session/prompt', { sessionId, contentBlocks: [{ type: 'text', text: prompt }] }, connection.signal) as SessionPromptResult | null
      if (typeof receipt?.messageId !== 'string' || !receipt.messageId) throw new Error('SDK 未返回本次输入的消息编号')
      await rpc.request('session/wait', { sessionId }, connection.signal)
      const elapsed = performance.now() - started
      const captured = events
      events = undefined
      const jsonl = projectTurn(captured, receipt.messageId, options)
      if (!await onTurn(index, jsonl, elapsed)) break
    }
  } catch (error) {
    errors.push(error)
  }
  try {
    if (input.readable && output.writable && !connection.signal.aborted) await rpc.request('shutdown', {}, connection.signal)
    else if (!errors.length) throw connection.signal.reason ?? new Error('SDK 在关闭前断开了连接')
  } catch (error) {
    errors.push(error)
  } finally {
    rpc.close()
    detachInput()
    detachOutput()
  }
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) throw new AggregateError(errors, `SDK 对话和关闭均失败：${errors.join(' / ')}`, { cause: errors[0] })
}
