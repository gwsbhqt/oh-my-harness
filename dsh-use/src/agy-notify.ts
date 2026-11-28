/**
 * Antigravity App 跨宿主完成通知适配器：复用本机已安装的 `agy-use` 入口（通过 Sidecar Unix 套接字
 * `bridge.sock` 连接 Antigravity App），不直接读取 CSRF 密钥，也不轮询无关用户会话。
 *
 * 投递失败时严格区分「确定未发送（`sent === false`，如 Sidecar 暂不可达）」与
 * 「结果未确认（`sent === null` / `uncertain === true` / 超时 / 响应异常）」；
 * 未确认投递绝不报告成功，也不得自动重发。
 *
 * @module
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { CommandFailure, UsageError } from './gateway.ts'

const AGY_NOTIFY_PREFIX = 'agy:'
const DEFAULT_TIMEOUT_MS = 20_000
const MAX_BUFFER_BYTES = 2 * 1024 * 1024

export class AgyDeliveryError extends Error {
  readonly unconfirmed: boolean
  readonly permanent: boolean
  readonly code?: string

  constructor(message: string, options: { unconfirmed?: boolean; permanent?: boolean; code?: string } = {}) {
    super(message)
    this.name = 'AgyDeliveryError'
    this.unconfirmed = options.unconfirmed === true
    this.permanent = options.permanent === true
    if (options.code !== undefined) this.code = options.code
  }
}

export function parseAgyNotifyTarget(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed.toLowerCase().startsWith(AGY_NOTIFY_PREFIX)) return undefined
  return trimmed.slice(AGY_NOTIFY_PREFIX.length).trim()
}

export function formatNotifyTarget(id: string): string {
  const agyId = parseAgyNotifyTarget(id)
  if (agyId !== undefined) return `Antigravity 会话 ${agyId.slice(0, 8)}`
  return `会话 ${id.replace(/^session-/, '').slice(0, 8)}`
}

function resolveAgyUseCommand(env: NodeJS.ProcessEnv = process.env): string {
  const installed = join(env['HOME'] ?? homedir(), '.local/bin/agy-use')
  if (existsSync(installed)) return installed
  return 'agy-use'
}

function validateAgyTarget(target: string): string {
  const trimmed = target.trim()
  if (!trimmed || trimmed.startsWith('-') || /[\s\0]/.test(trimmed)) {
    throw new UsageError('Antigravity 会话编号格式无效；请提供完整 UUID 或至少 4 位的唯一前缀', 'invalid-argument')
  }
  return trimmed
}

interface AgyExecResult {
  code: number | null
  stdout: string
  stderr: string
  timedOut?: boolean
  spawnError?: string
  notStarted?: boolean
}

type AgyRunner = (command: string, args: readonly string[], timeoutMs: number, env: NodeJS.ProcessEnv) => Promise<AgyExecResult>

function defaultRunner(command: string, args: readonly string[], timeoutMs: number, env: NodeJS.ProcessEnv): Promise<AgyExecResult> {
  return new Promise((resolve) => {
    let started = false
    const child = execFile(command, [...args], {
      env,
      timeout: timeoutMs,
      maxBuffer: MAX_BUFFER_BYTES,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ code: 0, stdout, stderr })
      } else if (typeof error.code === 'number') {
        resolve({ code: error.code, stdout, stderr })
      } else {
        resolve({
          code: null,
          stdout,
          stderr,
          notStarted: !started,
          timedOut: error.killed === true || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT',
          spawnError: error.message,
        })
      }
    })
    child.once('spawn', () => { started = true })
  })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStepIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return isObject(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

export interface AgyNotifier {
  resolve(target: string): Promise<string>
  deliver(conversationId: string, text: string, summary: string): Promise<{ conversationId: string }>
}

export function createAgyNotifier(options: {
  command?: string
  socketPath?: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  run?: AgyRunner
  log?: (line: string) => void
} = {}): AgyNotifier {
  const env = options.env ?? process.env
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const run = options.run ?? defaultRunner
  const command = () => options.command ?? resolveAgyUseCommand(env)
  const socketArgs = () => (options.socketPath ? ['--socket', options.socketPath] : [])

  return {
    async resolve(rawTarget: string): Promise<string> {
      const target = validateAgyTarget(rawTarget)
      const args = ['get', target, '--active-only', '--no-metadata', ...socketArgs()]
      const res = await run(command(), args, timeoutMs, env)
      const payload = parseJsonObject(res.stdout)
      if (payload === undefined) {
        const detail = res.stderr.trim() || res.spawnError || `exit ${String(res.code)}`
        throw new CommandFailure(`核对 Antigravity 会话失败（${detail}）；没有发送消息`, 'agy-unavailable')
      }
      if (payload['ok'] !== true || typeof payload['conversation_id'] !== 'string' || payload['conversation_id'].trim() === '') {
        const errorCode = typeof payload['error_code'] === 'string' ? payload['error_code'] : 'agy-unavailable'
        const message = typeof payload['error'] === 'string' && payload['error'].trim() !== ''
          ? payload['error']
          : `找不到 Antigravity 会话 ${target}`
        if (errorCode === 'target-not-found' || errorCode === 'ambiguous-target' || errorCode === 'incomplete-prefix-scan' || errorCode === 'invalid-argument') {
          throw new UsageError(`${message}；没有发送消息`, errorCode)
        }
        throw new CommandFailure(`${message}；没有发送消息`, errorCode)
      }
      const conv = payload['conversation']
      if (isObject(conv) && conv['archived'] === true) {
        throw new UsageError(`Antigravity 会话 ${payload['conversation_id'].slice(0, 8)} 已归档，不能作为通知目标；没有发送消息`, 'archived')
      }
      const transcript = payload['transcript']
      if (isObject(transcript) && (transcript['exists'] === false || transcript['total_steps'] === 0)) {
        throw new UsageError(`Antigravity 空白会话 ${payload['conversation_id'].slice(0, 8)} 尚未开始首轮对话，无法接收唤醒通知；请先发首条消息或选择已开始的会话`, 'blank-target')
      }
      if (!isObject(transcript) || transcript['exists'] !== true || !isStepIndex(transcript['total_steps']) || !isStepIndex(transcript['last_step_index'])) {
        throw new CommandFailure('无法核实 Antigravity 会话是否已开始首轮对话；没有发送消息', 'agy-unavailable')
      }
      return `${AGY_NOTIFY_PREFIX}${payload['conversation_id']}`
    },

    async deliver(rawConversationId: string, text: string, _summary: string): Promise<{ conversationId: string }> {
      let conversationId: string
      try {
        conversationId = validateAgyTarget(rawConversationId)
      } catch (error) {
        throw new AgyDeliveryError(error instanceof Error ? error.message : String(error), { permanent: true, code: 'invalid-argument' })
      }
      const waitTimeoutSec = Math.max(1, Math.ceil(timeoutMs / 1000))
      const execTimeoutMs = Math.max(timeoutMs, waitTimeoutSec * 1000 + 5_000)
      const args = ['send', '--wait-receipt', `--timeout=${waitTimeoutSec}`, ...socketArgs(), '--', conversationId, text]
      const res = await run(command(), args, execTimeoutMs, env)
      const payload = parseJsonObject(res.stdout)
      if (res.timedOut) {
        throw new AgyDeliveryError(`收件未确认：通过 agy-use 通知 Antigravity 会话 ${conversationId.slice(0, 8)} 等待超时；不再重发`, { unconfirmed: true, code: 'agy-send-timeout' })
      }
      if (payload === undefined) {
        const detail = res.stderr.trim() || res.spawnError || `exit ${String(res.code)}`
        if (res.notStarted === true) {
          throw new AgyDeliveryError(`agy-use 未启动，Antigravity 通知未发出（${detail}）`, { code: 'agy-not-started' })
        }
        throw new AgyDeliveryError(`收件未确认（${detail}）；不再重发`, { unconfirmed: true, code: 'invalid-agy-output' })
      }
      const baseline = payload['baseline']
      const previous = isObject(baseline) ? baseline['last_step_index'] : undefined
      const since = payload['since_step'] === undefined ? previous : payload['since_step']
      const receiptStep = payload['receipt_step_index']
      if (
        res.code === 0 && res.notStarted !== true &&
        payload['ok'] === true && payload['status'] === 'received' && payload['sent'] === true &&
        (payload['uncertain'] === undefined || payload['uncertain'] === false) &&
        (payload['timed_out'] === undefined || payload['timed_out'] === false) &&
        (payload['cancelled'] === undefined || payload['cancelled'] === false) &&
        payload['error'] == null && payload['error_code'] == null &&
        payload['receipt_confirmed'] === true && payload['conversation_id'] === conversationId &&
        typeof since === 'number' && Number.isSafeInteger(since) && since >= -1 &&
        (baseline === undefined || since === previous) &&
        isStepIndex(receiptStep) && receiptStep > since &&
        isStepIndex(payload['last_step_index']) && payload['last_step_index'] >= receiptStep
      ) {
        options.log?.(`agy-notify delivered target=${conversationId} receipt_step=${receiptStep}`)
        return { conversationId }
      }
      const errorCode = typeof payload['error_code'] === 'string' ? payload['error_code'] : undefined
      const detail = typeof payload['error'] === 'string' && payload['error'].trim() !== ''
        ? payload['error']
        : `agy-use send 返回未确认收件状态（code=${String(errorCode ?? res.code)}）`
      if (payload['sent'] !== false || payload['uncertain'] === true || payload['ok'] === true || payload['receipt_confirmed'] === true) {
        throw new AgyDeliveryError(`收件未确认（${detail}）；不再重发`, { unconfirmed: true, ...(errorCode === undefined ? {} : { code: errorCode }) })
      }
      const permanent = errorCode === 'target-not-found' || errorCode === 'target-mismatch' || errorCode === 'invalid-argument' || errorCode === 'ambiguous-target' || errorCode === 'incomplete-prefix-scan' || errorCode === 'archived' || errorCode === 'blank-target'
      throw new AgyDeliveryError(`Antigravity 通知未发出（${detail}）`, { permanent, ...(errorCode === undefined ? {} : { code: errorCode }) })
    },
  }
}
