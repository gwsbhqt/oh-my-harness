/**
 * dsh-control mcp：给 Raycast 里的 Gemini 使用的 stdio MCP 薄入口。
 *
 * 这里只做「派活/读结果」这一层：参数校验、任务账本、防重复和把现有 dsh-control 命令行的
 * JSON 回执整理成小结果。真正的会话创建、消息发送、等待、回答和取消全部复用 src/cli/core.ts，
 * 不复制通信协议、执行器或模型选择逻辑。
 *
 * stdout 只留给 MCP 协议；日志和错误一律写 stderr。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { createCli, type AppControl } from './core.ts'
import { hashInput, StoreError, TaskStore, type RequestRecord, type TaskRecord, type TaskStatus } from './mcp-store.ts'

type Json = Record<string, unknown>

interface CliRun {
  code: number
  stdout: string
  stderr: string
  json?: Json
}

interface QuestionGroup {
  callId: string
  questions: {
    id: string
    question: string
    header?: string
    detail?: string
    options?: { label: string; description?: string }[]
    multiSelect?: boolean
  }[]
}

interface TaskRead {
  status: string
  questions: QuestionGroup[]
  turns: Json[]
  lastSeq?: number
  error?: { code: string; message: string }
}

interface ToolResult {
  [key: string]: unknown
  content: { type: 'text'; text: string }[]
  structuredContent?: Json
  isError?: boolean
}

class BridgeError extends Error {
  readonly code: string
  readonly details?: unknown
  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

function log(message: string): void {
  process.stderr.write(`${new Date().toISOString()} dsh-control mcp: ${message}\n`)
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asRecord(value: unknown): Json {
  return isRecord(value) ? value : {}
}

function modelOf(value: unknown): { provider: string; model: string } | undefined {
  const v = asRecord(value)
  if (typeof v.provider !== 'string' || typeof v.model !== 'string' || v.provider === '' || v.model === '') return undefined
  return { provider: v.provider, model: v.model }
}

function statusFromTurn(ended: unknown): 'completed' | 'failed' | 'aborted' {
  if (ended === 'completed') return 'completed'
  if (ended === 'aborted') return 'aborted'
  return 'failed'
}

function questionsOf(value: unknown): QuestionGroup[] {
  if (!Array.isArray(value)) return []
  const out: QuestionGroup[] = []
  for (const raw of value) {
    const group = asRecord(raw)
    if (typeof group.callId !== 'string' || !Array.isArray(group.questions)) continue
    out.push({ callId: group.callId, questions: group.questions.filter(isRecord) as QuestionGroup['questions'] })
  }
  return out
}

function replyOf(turns: unknown, offset: number, maxChars: number): Json | undefined {
  if (!Array.isArray(turns)) return undefined
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = asRecord(turns[i])
    const text = typeof turn.reply === 'string' ? turn.reply : ''
    if (text === '') continue
    const start = Math.min(offset, text.length)
    const end = Math.min(start + maxChars, text.length)
    return {
      text: text.slice(start, end),
      turn: typeof turn.turn === 'number' ? turn.turn : null,
      ended: typeof turn.ended === 'string' ? turn.ended : null,
      detail: typeof turn.detail === 'string' ? turn.detail : null,
      offset: start,
      next_offset: end < text.length ? end : null,
      total_chars: text.length,
      truncated: end < text.length,
    }
  }
  return undefined
}

function errorOfRun(run: CliRun): { code: string; message: string } {
  const payload = asRecord(run.json)
  const error = asRecord(payload['error'])
  if (run.code === 69 || error.code === 'unavailable' || error.code === 'transport-failed') {
    return { code: 'dsh_unavailable', message: (typeof error.message === 'string' ? error.message : run.stderr.trim()) || 'DSH 没在运行，通信口连不上；先确认 DSH 已启动' }
  }
  if (typeof error.code === 'string' && typeof error.message === 'string') return { code: error.code, message: error.message }
  return { code: run.code === 2 ? 'invalid_argument' : 'dsh_command_failed', message: run.stderr.trim() || `dsh-control 退出码 ${run.code}` }
}

function okResult(payload: Json): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  }
}

function errorResult(error: unknown): ToolResult {
  const code = error instanceof BridgeError ? error.code : error instanceof StoreError ? error.code : 'internal_error'
  const message = error instanceof Error ? error.message : String(error)
  const details = error instanceof BridgeError && error.details !== undefined ? { details: error.details } : {}
  const payload: Json = { ok: false, error: { code, message, ...details } }
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], structuredContent: payload }
}

/** MCP 永远不碰应用的退出、启动或强杀；即使误调用也只会得到错误。 */
const noApp: AppControl = {
  running: () => false,
  backendRunning: () => false,
  quit: () => { throw new Error('MCP 桥不提供应用退出') },
  confirmScheduledQuit: () => { throw new Error('MCP 桥不提供退出框操作') },
  screenLocked: () => false,
  open: () => { throw new Error('MCP 桥不提供应用启动') },
  kill: () => { throw new Error('MCP 桥不提供应用强杀') },
}

async function runCli(argv: string[], env: NodeJS.ProcessEnv): Promise<CliRun> {
  let stdout = ''
  let stderr = ''
  const code = await createCli(env, (text) => { stdout += text }, (text) => { stderr += text }, undefined, noApp)(argv)
  let json: Json | undefined
  const trimmed = stdout.trim()
  if (trimmed !== '') {
    try { json = asRecord(JSON.parse(trimmed)) } catch { /* 不是 JSON 的错误会在调用处按退出码处理 */ }
  }
  return { code, stdout, stderr, ...(json === undefined ? {} : { json }) }
}

function workerRules(): string {
  return '回答要求：只回复四项——结论、产物文件的绝对路径（必须写完整绝对路径，不能只写相对链接或文件名）、核验结果、未完成项（含必须由用户决定的事）。不要复述过程，不要输出思考过程或工具日志。'
}

function createPrompt(text: string): string {
  return `${text.trim()}\n\n${workerRules()}`
}

function continuePrompt(text: string): string {
  return `${text.trim()}\n\n（${workerRules()}）`
}

function preview(text: string, limit = 160): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}

function taskStatusFromSession(data: Json): TaskStatus {
  if (data['running'] === true) return 'running'
  if (Array.isArray(data['questions']) && data['questions'].length > 0) return 'waiting_input'
  return typeof data['state'] === 'string' && data['state'] === 'asking' ? 'waiting_input' : 'idle'
}

const TASK_ID_DESCRIPTION = 'dsh_create_task 或 dsh_attach_session 返回的任务编号，例如 task-…；不接受 DSH 会话编号。'

class Bridge {
  readonly store: TaskStore
  private readonly env: NodeJS.ProcessEnv
  private readonly inflight = new Map<string, { inputHash: string; promise: Promise<Json> }>()
  private readonly activeRequests = new Set<string>()

  constructor(env: NodeJS.ProcessEnv) {
    this.env = env
    const home = typeof env['DSH_HOME'] === 'string' && env['DSH_HOME'] !== '' ? env['DSH_HOME'] : join(homedir(), '.dsh')
    this.store = new TaskStore(home)
    this.store.ensure()
  }

  /** 锁内读最新任务；遗留 dispatching 且原进程已经不在了才标 unknown。 */
  private async load(taskId: string): Promise<TaskRecord> {
    return this.store.mutate(taskId, (task) => {
      this.recoverLocked(task)
      return task
    })
  }

  /** 调用方必须已经在锁内。只处理 pid 已经不在或无主的 pendingRequest。 */
  private recoverLocked(task: TaskRecord): void {
    const pending = task.pendingRequest
    if (pending !== undefined && this.activeRequests.has(pending.id)) return
    if (pending !== undefined && pending.pid !== undefined && pending.pid !== process.pid && pidAlive(pending.pid)) return
    const stalePending = pending !== undefined
    const staleCreate = task.status === 'dispatching' && pending === undefined
    if (!stalePending && !staleCreate) return
    const at = Date.now()
    const message = '上次发送过程中进程中断，结果未知；没有自动重放。请读任务状态，或重新创建任务。'
    task.status = 'unknown'
    task.lastError = { code: 'outcome_unknown', message, at }
    if (pending !== undefined) {
      const record = task.requests[pending.key]
      if (record !== undefined && record.phase === 'dispatching') {
        record.phase = 'unknown'
        record.finishedAt = at
        record.error = { code: 'outcome_unknown', message }
      }
      delete task.pendingRequest
    }
  }

  private otherProcessPending(task: TaskRecord): boolean {
    const pending = task.pendingRequest
    return pending !== undefined && pending.pid !== undefined && pending.pid !== process.pid && pidAlive(pending.pid)
  }

  private thisProcessPending(task: TaskRecord): boolean {
    const pending = task.pendingRequest
    return pending !== undefined && this.activeRequests.has(pending.id)
  }

  private taskView(task: TaskRecord): Json {
    return {
      task_id: task.taskId,
      session_id: task.sessionId ?? null,
      attached: task.attached === true,
      since: task.since ?? null,
      model: task.model ?? null,
      selected_model: task.model === undefined ? null : `${task.model.provider}/${task.model.model}`,
      tier: task.tier ?? null,
      workspace: task.workspace,
      status: task.status,
      created_at: new Date(task.createdAt).toISOString(),
      updated_at: new Date(task.updatedAt).toISOString(),
      last_error: task.lastError ?? null,
    }
  }

  private async guarded(fn: () => Promise<Json>): Promise<ToolResult> {
    try { return okResult(await fn()) } catch (error) {
      log(`tool failed: ${error instanceof Error ? error.message : String(error)}`)
      return errorResult(error)
    }
  }

  async listWorkspaces(): Promise<ToolResult> {
    return this.guarded(async () => {
      const run = await runCli(['workspaces', '--json'], this.env)
      if (run.code !== 0 || asRecord(run.json)['ok'] !== true) {
        const error = errorOfRun(run)
        throw new BridgeError(error.code, error.message)
      }
      const data = asRecord(run.json)['data']
      if (!Array.isArray(data)) throw new BridgeError('invalid_response', 'dsh-control 没有返回工作区列表')
      return {
        ok: true,
        workspaces: data.map((raw) => {
          const w = asRecord(raw)
          const sessionIds = Array.isArray(w.sessionIds) ? w.sessionIds : []
          const archived = typeof w.archivedCount === 'number' ? w.archivedCount : 0
          return {
            workspace_id: typeof w.workspaceId === 'string' ? w.workspaceId : null,
            title: typeof w.title === 'string' ? w.title : null,
            path: typeof w.path === 'string' ? w.path : null,
            session_count: Math.max(0, sessionIds.length - archived),
          }
        }),
      }
    })
  }

  async listSessions(args: {
    query?: string | undefined
    workspace?: string | undefined
    cwd?: string | undefined
    running?: boolean | undefined
    ungrouped?: boolean | undefined
    include_blank?: boolean | undefined
    all?: boolean | undefined
    limit: number
  }): Promise<ToolResult> {
    return this.guarded(async () => {
      const argv = ['sessions', '--json']
      if (args.query !== undefined && args.query !== '') argv.push('--query', args.query)
      if (args.workspace !== undefined && args.workspace !== '') argv.push('--workspace', args.workspace)
      if (args.cwd !== undefined && args.cwd !== '') argv.push('--cwd', args.cwd)
      if (args.running === true) argv.push('--running')
      if (args.ungrouped === true) argv.push('--ungrouped')
      if (args.include_blank === true) argv.push('--include-blank')
      if (args.all === true) argv.push('--all')
      argv.push('--limit', String(args.limit))
      const run = await runCli(argv, this.env)
      const payload = asRecord(run.json)
      if (run.code !== 0 || payload['ok'] !== true) {
        const error = errorOfRun(run)
        throw new BridgeError(error.code, error.message)
      }
      const data = Array.isArray(payload['data']) ? payload['data'].filter(isRecord) : []
      const meta = asRecord(payload['meta'])
      return {
        ok: true,
        sessions: data.map((s) => ({
          session_id: typeof s['sessionId'] === 'string' ? s['sessionId'] : null,
          title: typeof s['title'] === 'string' ? s['title'] : null,
          state: typeof s['state'] === 'string' ? s['state'] : null,
          running: s['running'] === true,
          updated_at: typeof s['updatedAt'] === 'number' ? s['updatedAt'] : null,
          cwd: typeof s['cwd'] === 'string' ? s['cwd'] : null,
          archived: s['archived'] === true,
          blank: s['blank'] === true,
        })),
        matched: typeof meta['matched'] === 'number' ? meta['matched'] : null,
        shown: typeof meta['shown'] === 'number' ? meta['shown'] : data.length,
        archived_hidden: typeof meta['archivedHidden'] === 'number' ? meta['archivedHidden'] : null,
        blank_hidden: typeof meta['blankHidden'] === 'number' ? meta['blankHidden'] : null,
      }
    })
  }

  async readSession(args: {
    session: string
    turn?: number | undefined
    through_turn?: number | undefined
    last: number
    offset: number
    max_chars: number
  }): Promise<ToolResult> {
    return this.guarded(async () => {
      // 先解析 canonical sessionId；后续读取只用这个 ID，避免原始标题在两次调用间
      // 解析到不同会话，出现元信息 A、正文 B。
      const statusRun = await runCli(['status', args.session, '--json'], this.env)
      const statusPayload = asRecord(statusRun.json)
      const statusOk = (statusRun.code === 0 || statusRun.code === 10) && statusPayload['ok'] === true
      if (!statusOk) {
        const error = errorOfRun(statusRun)
        throw new BridgeError(error.code, error.message)
      }
      const statusData = asRecord(statusPayload['data'])
      const sessionId = typeof statusData['sessionId'] === 'string' ? statusData['sessionId'] : undefined
      if (sessionId === undefined) throw new BridgeError('invalid_response', 'status 没有返回 sessionId')
      const readRun = await runCli(['read', sessionId, '--last', '0', '--json'], this.env)
      const readPayload = asRecord(readRun.json)
      if (readRun.code !== 0 || readPayload['ok'] !== true) {
        const error = errorOfRun(readRun)
        throw new BridgeError(error.code, error.message)
      }
      const readData = asRecord(readPayload['data'])
      const all = Array.isArray(readData['turns']) ? readData['turns'].filter(isRecord) : []
      const requested = args.turn
      const last = Math.max(1, Math.min(args.last, 10))
      let selected: Json[]
      let throughTurn: number | null
      if (requested !== undefined) {
        const found = all.find((t) => t['turn'] === requested)
        if (found === undefined) {
          const available = all.map((t) => (typeof t['turn'] === 'number' ? t['turn'] : null)).filter((x): x is number => x !== null)
          throw new BridgeError('turn_not_found', `会话里没有第 ${requested} 轮；现有轮次：${available.length === 0 ? '无' : `${available[0]}–${available.at(-1)}`}`, { available })
        }
        selected = [found]
        throughTurn = requested
      } else {
        if (args.through_turn !== undefined) {
          const before = all.filter((t) => typeof t['turn'] === 'number' && t['turn'] <= args.through_turn!)
          if (before.length === 0) throw new BridgeError('turn_not_found', `第 ${args.through_turn} 轮之前没有可读轮次`, { through_turn: args.through_turn })
          selected = before.slice(-last)
        } else {
          selected = all.slice(-last)
        }
        throughTurn = selected.at(-1) === undefined ? null : (typeof selected.at(-1)!['turn'] === 'number' ? selected.at(-1)!['turn'] as number : null)
      }
      const turns = selected.map((t) => {
        const turn = typeof t['turn'] === 'number' ? t['turn'] : 0
        const user = typeof t['user'] === 'string' ? t['user'] : ''
        const reply = typeof t['reply'] === 'string' ? t['reply'] : ''
        return {
          turn,
          ended: typeof t['ended'] === 'string' ? t['ended'] : null,
          user_chars: user.length,
          reply_chars: reply.length,
          user_preview: preview(user),
          reply_preview: preview(reply),
          user,
          reply,
        }
      })
      const segments: { turn: number; start: number; end: number }[] = []
      const pieces: string[] = []
      let cursor = 0
      for (let i = 0; i < turns.length; i++) {
        if (i > 0) cursor += 2 // join('\n\n') 的分隔符
        const item = turns[i]!
        const piece = `第 ${item.turn} 轮\n用户：${item.user === '' ? '（没有用户文字）' : item.user}\n助手：${item.reply === '' ? '（这一轮还没有助手回复）' : item.reply}`
        const start = cursor
        pieces.push(piece)
        segments.push({ turn: item.turn, start, end: start + piece.length })
        cursor = start + piece.length
      }
      const full = pieces.join('\n\n')
      const offset = Math.min(args.offset, full.length)
      const end = Math.min(offset + args.max_chars, full.length)
      const pageTurns = segments.filter((s) => s.end > offset && s.start < end).map((s) => s.turn)
      const nextPage = end < full.length
        ? {
          session: sessionId,
          ...(requested !== undefined ? { turn: requested } : { through_turn: throughTurn, last }),
          offset: end,
          max_chars: args.max_chars,
        }
        : null
      return {
        ok: true,
        session_id: sessionId,
        title: typeof statusData['title'] === 'string' ? statusData['title'] : null,
        state: typeof statusData['state'] === 'string' ? statusData['state'] : null,
        running: statusData['running'] === true,
        cwd: typeof statusData['cwd'] === 'string' ? statusData['cwd'] : null,
        model: modelOf(statusData['model']) ?? null,
        turns: turns.map(({ user, reply, ...rest }) => rest),
        overview: all.filter((t) => throughTurn === null || (typeof t['turn'] === 'number' && t['turn'] <= throughTurn)).slice(-5).map((t) => ({
          turn: typeof t['turn'] === 'number' ? t['turn'] : null,
          ended: typeof t['ended'] === 'string' ? t['ended'] : null,
          user_preview: preview(typeof t['user'] === 'string' ? t['user'] : ''),
          reply_preview: preview(typeof t['reply'] === 'string' ? t['reply'] : ''),
        })),
        text: full.slice(offset, end),
        offset,
        next_offset: end < full.length ? end : null,
        total_chars: full.length,
        truncated: end < full.length,
        turn: requested ?? (turns.at(-1)?.turn ?? null),
        through_turn: requested ?? throughTurn,
        turn_start: pageTurns[0] ?? null,
        turn_end: pageTurns.at(-1) ?? null,
        page_turns: pageTurns,
        next_page: nextPage,
      }
    })
  }

  async attachSession(args: { session: string }): Promise<ToolResult> {
    return this.guarded(async () => {
      const run = await runCli(['status', args.session, '--json'], this.env)
      const payload = asRecord(run.json)
      if (run.code !== 0 && run.code !== 10) {
        const error = errorOfRun(run)
        throw new BridgeError(error.code, error.message)
      }
      if (payload['ok'] !== true) {
        const error = errorOfRun(run)
        throw new BridgeError(error.code, error.message)
      }
      const data = asRecord(payload['data'])
      const sessionId = typeof data['sessionId'] === 'string' ? data['sessionId'] : undefined
      if (sessionId === undefined) throw new BridgeError('invalid_response', 'status 没有返回 sessionId')
      const existing = this.store.findBySession(sessionId)
      if (existing !== undefined) {
        const latest = await this.load(existing.taskId)
        return {
          ok: true,
          ...this.taskView(latest),
          status: taskStatusFromSession(data),
          session_id: sessionId,
          title: typeof data['title'] === 'string' ? data['title'] : null,
          state: typeof data['state'] === 'string' ? data['state'] : null,
          running: data['running'] === true,
          cwd: typeof data['cwd'] === 'string' ? data['cwd'] : null,
          model: modelOf(data['model']) ?? latest.model ?? null,
          attached: latest.attached === true,
          reused: true,
          note: '复用已有桥任务；没有新建会话、没有发送消息、没有换模型',
        }
      }
      const cwd = typeof data['cwd'] === 'string' ? data['cwd'] : undefined
      const status = taskStatusFromSession(data)
      const attachModel = modelOf(data['model'])
      const now = Date.now()
      const task: TaskRecord = {
        version: 1,
        taskId: `task-${randomUUID()}`,
        sessionId,
        workspace: cwd ?? '',
        ...(cwd === undefined ? {} : { cwd }),
        ...(attachModel === undefined ? {} : { model: attachModel }),
        createdAt: now,
        updatedAt: now,
        status,
        attached: true,
        ...(typeof data['lastSeq'] === 'number' && Number.isSafeInteger(data['lastSeq']) ? { lastSeq: data['lastSeq'] } : {}),
        ...(typeof data['title'] === 'string' ? { promptPreview: data['title'] } : {}),
        requests: {},
      }
      const result = await this.store.createOrGet(task, 'attach', sessionId, hashInput({ sessionId }))
      const latest = result.task
      return {
        ok: true,
        ...this.taskView(latest),
        session_id: sessionId,
        title: typeof data['title'] === 'string' ? data['title'] : null,
        state: typeof data['state'] === 'string' ? data['state'] : null,
        running: data['running'] === true,
        cwd: cwd ?? null,
        model: modelOf(data['model']) ?? latest.model ?? null,
        attached: latest.attached === true,
        reused: !result.created,
        note: '已接入已有会话；没有新建会话、没有发送消息、没有换模型',
      }
    })
  }

  async createTask(args: {
    request_key: string
    prompt: string
    workspace?: string | undefined
    cwd?: string | undefined
    tier: 'fast' | 'normal'
  }): Promise<ToolResult> {
    return this.guarded(async () => {
      const key = args.request_key.trim()
      if (key === '') throw new BridgeError('invalid_argument', 'request_key 不能为空')
      if (key.length > 200) throw new BridgeError('invalid_argument', 'request_key 太长（最多 200 字符）')
      const workspace = args.workspace?.trim()
      const cwd = args.cwd?.trim()
      if ((workspace === undefined || workspace === '') === (cwd === undefined || cwd === '')) {
        throw new BridgeError('invalid_argument', 'workspace 和 cwd 必须正好给一个：workspace 用已登记的名字，cwd 用明确的绝对路径')
      }
      const prompt = args.prompt.trim()
      if (prompt === '') throw new BridgeError('invalid_argument', 'prompt 不能为空')
      if (prompt.length > 20_000) throw new BridgeError('invalid_argument', 'prompt 太长（最多 20000 字符）')
      if (cwd !== undefined && cwd !== '') {
        if (!isAbsolute(cwd)) throw new BridgeError('invalid_argument', 'cwd 必须是绝对路径')
        if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new BridgeError('invalid_argument', `cwd 不存在或不是目录：${cwd}`)
      }
      const input = { prompt, workspace: workspace ?? null, cwd: cwd ?? null, tier: args.tier }
      const inputHash = hashInput(input)
      const flightKey = `create:${key}`
      const current = this.inflight.get(flightKey)
      if (current !== undefined) {
        if (current.inputHash !== inputHash) throw new BridgeError('request_key_conflict', '同一个 request_key 正在发送另一份输入；没有发送新消息')
        return current.promise
      }
      const taskId = `task-${randomUUID()}`
      const now = Date.now()
      const record: RequestRecord = { key, kind: 'start', inputHash, phase: 'dispatching', startedAt: now }
      const task: TaskRecord = {
        version: 1,
        taskId,
        workspace: workspace ?? cwd ?? '',
        ...(cwd === undefined ? {} : { cwd }),
        tier: args.tier,
        promptPreview: prompt.slice(0, 200),
        createdAt: now,
        updatedAt: now,
        status: 'dispatching',
        requests: { [key]: record },
        pendingRequest: { id: flightKey, key, kind: 'start', startedAt: now, pid: process.pid },
      }
      const holder = { inputHash, promise: undefined as unknown as Promise<Json> }
      this.inflight.set(flightKey, holder)
      this.activeRequests.add(flightKey)
      holder.promise = (async () => {
        const outcome = await this.store.createOrGet(task, 'create', key, inputHash)
        if (!outcome.created) return this.replayCreate(outcome.task.taskId, key, inputHash)
        return this.executeCreate(taskId, key, input)
      })().finally(() => {
        this.activeRequests.delete(flightKey)
        if (this.inflight.get(flightKey) === holder) this.inflight.delete(flightKey)
      })
      return holder.promise
    })
  }

  private async replayCreate(taskId: string, key: string, inputHash: string): Promise<Json> {
    const task = await this.load(taskId)
    const record = task.requests[key]
    if (record === undefined) throw new BridgeError('store_corrupt', '任务里找不到这个 request_key 的记录')
    if (record.inputHash !== inputHash) throw new BridgeError('request_key_conflict', '同一个 request_key 已经用于另一份输入；没有发送新消息')
    if (record.phase === 'sent') {
      const receipt = asRecord(record.receipt)
      return {
        ok: true,
        ...this.taskView(task),
        since: typeof receipt['since'] === 'number' ? receipt['since'] : task.since ?? null,
        request_key: key,
        replayed: true,
      }
    }
    if (record.phase === 'dispatching') {
      if (task.pendingRequest?.key === key && (this.otherProcessPending(task) || this.thisProcessPending(task))) {
        return {
          ok: true,
          ...this.taskView(task),
          status: 'dispatching',
          request_key: key,
          replayed: true,
          in_progress: true,
          note: '同一个 request_key 正在另一个 MCP 进程创建这个任务；不要重建，稍后用同一个 task_id 读取',
        }
      }
      await this.store.mutate(taskId, (latest) => {
        const current = latest.requests[key]
        if (current !== undefined && current.phase === 'dispatching') {
          current.phase = 'unknown'
          current.finishedAt = Date.now()
          current.error = { code: 'outcome_unknown', message: '同一个 request_key 的上次发送结果未知，不自动重放；请重新创建任务' }
        }
        latest.status = 'unknown'
        latest.lastError = { code: 'outcome_unknown', message: '同一个 request_key 的上次发送结果未知，不自动重放；请重新创建任务', at: Date.now() }
        delete latest.pendingRequest
      })
      throw new BridgeError('outcome_unknown', '同一个 request_key 的上次发送结果未知，不自动重放；请重新创建任务', { task: this.taskView(await this.load(taskId)) })
    }
    throw new BridgeError(record.error?.code ?? 'request_failed', record.error?.message ?? '这个 request_key 的上次发送没有成功；没有重发', { task: this.taskView(task) })
  }

  private async executeCreate(taskId: string, key: string, input: { prompt: string; workspace: string | null; cwd: string | null; tier: 'fast' | 'normal' }): Promise<Json> {
    const flightId = `create:${key}`
    this.activeRequests.add(flightId)
    try {
      const target = input.workspace ?? input.cwd!
      const run = await runCli(['new', target, createPrompt(input.prompt), '--tier', input.tier, '--json'], this.env)
      const payload = asRecord(run.json)
      const data = asRecord(payload['data'])
      if (run.code === 0 && payload['ok'] === true && typeof data['sessionId'] === 'string' && Number.isSafeInteger(data['since'])) {
        return await this.store.mutate(taskId, (latest) => this.finishCreateLocked(latest, key, data))
      }
      const failure = await this.store.mutate(taskId, (latest) => this.failCreateLocked(latest, key, run))
      const errorPayload = asRecord(failure['__bridgeError'])
      throw new BridgeError(String(errorPayload['code']), String(errorPayload['message']), failure['__bridgeError'] === undefined ? failure : { task: failure['task'] })
    } catch (error) {
      if (error instanceof BridgeError) throw error
      const message = error instanceof Error ? error.message : String(error)
      await this.store.mutate(taskId, (latest) => {
        const record = latest.requests[key]
        if (record !== undefined && record.phase === 'dispatching') {
          record.phase = 'unknown'
          record.finishedAt = Date.now()
          record.error = { code: 'outcome_unknown', message: `创建任务时发生异常，结果未知：${message}` }
        }
        latest.status = 'unknown'
        latest.lastError = { code: 'outcome_unknown', message: `创建任务时发生异常，结果未知：${message}`, at: Date.now() }
        delete latest.pendingRequest
      })
      throw new BridgeError('outcome_unknown', `创建任务时发生异常，结果未知，不自动重放：${message}`, { task: this.taskView(await this.load(taskId)) })
    } finally {
      this.activeRequests.delete(flightId)
    }
  }

  private finishCreateLocked(task: TaskRecord, key: string, data: Json): Json {
    const record = task.requests[key]
    if (record === undefined) throw new BridgeError('store_corrupt', '任务里找不到这个 request_key 的记录')
    task.sessionId = String(data['sessionId'])
    task.since = Number(data['since'])
    const model = modelOf(data['model'])
    if (model !== undefined) task.model = model
    task.status = data['sent'] === false ? 'created' : 'running'
    delete task.lastError
    delete task.pendingRequest
    record.phase = 'sent'
    record.finishedAt = Date.now()
    record.receipt = { sessionId: task.sessionId, since: task.since, model: task.model ?? null }
    return { ok: true, ...this.taskView(task), request_key: key, replayed: false }
  }

  private failCreateLocked(task: TaskRecord, key: string, run: CliRun): Json {
    const error = errorOfRun(run)
    const payload = asRecord(run.json)
    const data = asRecord(payload['data'])
    const record = task.requests[key]
    if (record === undefined) throw new BridgeError('store_corrupt', '任务里找不到这个 request_key 的记录')
    const created = data['created'] === true && typeof data['sessionId'] === 'string'
    if (created) {
      task.sessionId = String(data['sessionId'])
      if (Number.isSafeInteger(data['since'])) task.since = Number(data['since'])
      const model = modelOf(data['model'])
      if (model !== undefined) task.model = model
      task.status = 'failed'
    } else if (run.code === 2 || run.code === 69) {
      task.status = 'failed_before_send'
    } else {
      task.status = 'unknown'
      record.phase = 'unknown'
    }
    const message = created
      ? `${error.message}（会话已建好，但第一条消息没发出；不要重放 new，任务编号是 ${task.taskId}）`
      : error.message
    task.lastError = { code: error.code, message, at: Date.now() }
    delete task.pendingRequest
    if (record.phase !== 'unknown') {
      record.phase = 'failed'
      record.finishedAt = Date.now()
      if (created) record.receipt = { sessionId: task.sessionId, since: task.since ?? null, model: task.model ?? null }
    }
    record.error = { code: error.code, message }
    // 回调不能在这里抛：mutate 只有正常返回才会保存状态；返回错误对象，由 executeCreate 在保存后抛出。
    return { __bridgeError: { code: error.code, message }, task: this.taskView(task) }
  }

  async continueTask(args: { task_id: string; request_key: string; message: string }): Promise<ToolResult> {
    return this.guarded(async () => {
      const key = args.request_key.trim()
      if (key === '') throw new BridgeError('invalid_argument', 'request_key 不能为空')
      const message = args.message.trim()
      if (message === '') throw new BridgeError('invalid_argument', 'message 不能为空')
      const flightKey = `continue:${args.task_id}:${key}`
      const current = this.inflight.get(flightKey)
      if (current !== undefined) {
        if (current.inputHash !== hashInput({ message })) throw new BridgeError('request_key_conflict', '同一个 request_key 正在发送另一份输入；没有发送新消息')
        return current.promise
      }
      const inputHash = hashInput({ message })
      const holder = { inputHash, promise: undefined as unknown as Promise<Json> }
      this.inflight.set(flightKey, holder)
      this.activeRequests.add(flightKey)
      holder.promise = (async () => {
        const task = await this.load(args.task_id)
        if (task.sessionId === undefined) throw new BridgeError('task_not_sendable', `任务 ${task.taskId} 还没有可用的会话（状态 ${task.status}），不能继续派活`, { task: this.taskView(task) })
        const begin = await this.store.mutate(task.taskId, (latest) => {
          this.recoverLocked(latest)
          if (latest.sessionId === undefined) throw new BridgeError('task_not_sendable', `任务 ${latest.taskId} 还没有可用的会话（状态 ${latest.status}），不能继续派活`)
          const existing = latest.requests[key]
          if (existing !== undefined) {
            if (existing.inputHash !== inputHash) throw new BridgeError('request_key_conflict', '同一个 request_key 已经用于另一份输入；没有发送新消息')
            if (existing.phase === 'sent') return { kind: 'replay' as const, task: latest, record: existing }
            if (existing.phase === 'dispatching') {
              if (latest.pendingRequest?.key === key && (this.thisProcessPending(latest) || this.otherProcessPending(latest))) {
                return { kind: 'in_progress' as const, task: latest, record: existing }
              }
              existing.phase = 'unknown'
              existing.finishedAt = Date.now()
              existing.error = { code: 'outcome_unknown', message: '同一个 request_key 的上次发送结果未知，不自动重放；请读任务状态' }
              latest.status = 'unknown'
              latest.lastError = { code: 'outcome_unknown', message: '同一个 request_key 的上次发送结果未知，不自动重放；请读任务状态', at: Date.now() }
              delete latest.pendingRequest
              return { kind: 'unknown' as const, task: latest }
            }
            return { kind: 'failed' as const, task: latest, record: existing }
          }
          if (latest.pendingRequest !== undefined) throw new BridgeError('task_busy', '任务正在发送另一条消息，等它返回后再继续；没有发送新消息')
          const record: RequestRecord = { key, kind: 'continue', inputHash, phase: 'dispatching', startedAt: Date.now() }
          latest.requests[key] = record
          latest.pendingRequest = { id: flightKey, key, kind: 'continue', startedAt: Date.now(), pid: process.pid }
          return { kind: 'created' as const, task: latest }
        })
        if (begin.kind === 'replay') {
          const receipt = asRecord(begin.record.receipt)
          return {
            ok: true,
            ...this.taskView(begin.task),
            since: typeof receipt['since'] === 'number' ? receipt['since'] : begin.task.since ?? null,
            request_id: typeof receipt['requestId'] === 'string' ? receipt['requestId'] : null,
            request_key: key,
            replayed: true,
          }
        }
        if (begin.kind === 'in_progress') {
          return {
            ok: true,
            ...this.taskView(begin.task),
            status: 'dispatching',
            request_key: key,
            replayed: true,
            in_progress: true,
            note: '同一个 request_key 正在另一个 MCP 进程发送；不要重发，稍后读任务状态',
          }
        }
        if (begin.kind === 'unknown') throw new BridgeError('outcome_unknown', '同一个 request_key 的上次发送结果未知，不自动重放；请读任务状态', { task: this.taskView(begin.task) })
        if (begin.kind === 'failed') throw new BridgeError(begin.record.error?.code ?? 'request_failed', begin.record.error?.message ?? '这个 request_key 的上次发送没有成功；没有重发', { task: this.taskView(begin.task) })
        return this.executeContinue(task.taskId, key, message, flightKey)
      })().finally(() => {
        this.activeRequests.delete(flightKey)
        if (this.inflight.get(flightKey) === holder) this.inflight.delete(flightKey)
      })
      return holder.promise
    })
  }

  private async executeContinue(taskId: string, key: string, message: string, flightId: string): Promise<Json> {
    this.activeRequests.add(flightId)
    try {
      const task = await this.load(taskId)
      if (task.sessionId === undefined) throw new BridgeError('task_not_sendable', '任务没有可用会话，不能继续派活')
      const run = await runCli(['send', task.sessionId, continuePrompt(message), '--json'], this.env)
      const payload = asRecord(run.json)
      const data = asRecord(payload['data'])
      if (run.code === 0 && payload['ok'] === true && Number.isSafeInteger(data['since'])) {
        return await this.store.mutate(taskId, (latest) => {
          const record = latest.requests[key]
          if (record === undefined) throw new BridgeError('store_corrupt', '任务里找不到这个 request_key 的记录')
          const nextSince = Number(data['since'])
          if (latest.since === undefined || nextSince > latest.since) latest.since = nextSince
          latest.status = 'running'
          delete latest.lastError
          if (latest.pendingRequest?.id === flightId) delete latest.pendingRequest
          record.phase = 'sent'
          record.finishedAt = Date.now()
          record.receipt = {
            sessionId: latest.sessionId,
            since: nextSince,
            requestId: typeof data['requestId'] === 'string' ? data['requestId'] : null,
            model: latest.model ?? null,
          }
          return {
            ok: true,
            ...this.taskView(latest),
            since: nextSince,
            request_id: typeof data['requestId'] === 'string' ? data['requestId'] : null,
            request_key: key,
            replayed: false,
          }
        })
      }
      const error = errorOfRun(run)
      return await this.store.mutate(taskId, (latest) => {
        const record = latest.requests[key]
        if (record !== undefined) {
          record.phase = run.code === 2 || run.code === 69 ? 'failed' : 'unknown'
          record.error = error
          record.finishedAt = Date.now()
        }
        if (run.code === 2 || run.code === 69) {
          latest.lastError = { code: error.code, message: error.message, at: Date.now() }
        } else {
          latest.lastError = { code: 'outcome_unknown', message: `继续派活的结果未知：${error.message}`, at: Date.now() }
          if (latest.pendingRequest?.id === flightId) latest.status = 'unknown'
        }
        if (latest.pendingRequest?.id === flightId) delete latest.pendingRequest
        const failure = new BridgeError(error.code, error.message, { task: this.taskView(latest), request_key: key })
        return { __bridgeError: { code: failure.code, message: failure.message, details: failure.details }, task: this.taskView(latest) }
      }).then((value) => {
        const errorValue = asRecord(value['__bridgeError'])
        throw new BridgeError(String(errorValue['code']), String(errorValue['message']), value['task'])
      })
    } catch (error) {
      if (error instanceof BridgeError) throw error
      const messageText = error instanceof Error ? error.message : String(error)
      await this.store.mutate(taskId, (latest) => {
        const record = latest.requests[key]
        if (record !== undefined && record.phase === 'dispatching') {
          record.phase = 'unknown'
          record.finishedAt = Date.now()
          record.error = { code: 'outcome_unknown', message: `继续派活时发生异常，结果未知：${messageText}` }
        }
        latest.status = 'unknown'
        latest.lastError = { code: 'outcome_unknown', message: `继续派活时发生异常，结果未知：${messageText}`, at: Date.now() }
        if (latest.pendingRequest?.id === flightId) delete latest.pendingRequest
      })
      throw new BridgeError('outcome_unknown', `继续派活时发生异常，结果未知，不自动重放：${messageText}`, { task: this.taskView(await this.load(taskId)) })
    } finally {
      this.activeRequests.delete(flightId)
    }
  }

  private applyTurns(task: TaskRecord, turns: Json[], lastSeq: unknown): void {
    if (Number.isSafeInteger(lastSeq)) task.lastSeq = Number(lastSeq)
    const last = turns.at(-1)
    if (last !== undefined && typeof last['ended'] === 'string') {
      task.lastTurn = {
        turn: typeof last['turn'] === 'number' ? last['turn'] : 0,
        ended: last['ended'],
        detail: typeof last['detail'] === 'string' ? last['detail'] : null,
      }
    }
  }

  /** 只读结果，不写任务账本；写账本由 applyRead 在锁内针对最新记录做。 */
  private async waitOnce(task: TaskRecord, waitSeconds: number): Promise<TaskRead> {
    const since = task.since ?? -1
    const run = await runCli(['wait', task.sessionId!, '--since', String(since), '--settled', '--timeout', String(waitSeconds), '--json'], this.env)
    if (run.code === 69) throw new BridgeError('dsh_unavailable', errorOfRun(run).message)
    const payload = asRecord(run.json)
    if (payload['ok'] === true) {
      const data = asRecord(payload['data'])
      const turns = Array.isArray(data['turns']) ? data['turns'].filter(isRecord) : []
      const status = typeof payload['status'] === 'string' ? payload['status'] : 'running'
      if (status === 'waiting-input') return { status: 'waiting_input', questions: questionsOf(data['questions']), turns }
      if (status === 'ok') return { status: 'completed', questions: [], turns, ...(Number.isSafeInteger(data['lastSeq']) ? { lastSeq: Number(data['lastSeq']) } : {}) }
      if (status === 'timeout' || status === 'running') return { status: 'running', questions: [], turns, ...(Number.isSafeInteger(data['lastSeq']) ? { lastSeq: Number(data['lastSeq']) } : {}) }
      if (status === 'idle') return { status: 'running', questions: [], turns, ...(Number.isSafeInteger(data['lastSeq']) ? { lastSeq: Number(data['lastSeq']) } : {}) }
      return { status: 'running', questions: [], turns }
    }
    const status = typeof payload['status'] === 'string' ? payload['status'] : ''
    if (status === 'failed' || status === 'aborted') {
      const data = asRecord(payload['data'])
      const turns = Array.isArray(data['turns']) ? data['turns'].filter(isRecord) : []
      return {
        status,
        questions: [],
        turns,
        ...(Number.isSafeInteger(data['lastSeq']) ? { lastSeq: Number(data['lastSeq']) } : {}),
        error: errorOfRun(run),
      }
    }
    throw new BridgeError(errorOfRun(run).code, errorOfRun(run).message)
  }

  /** 在锁内把读结果写到最新任务；若读期间任务被续办，保留新记录，不回退 since/requests。 */
  private async applyRead(taskId: string, snapshotSince: number, result: TaskRead): Promise<TaskRecord> {
    return this.store.mutate(taskId, (task) => {
      if (task.since !== snapshotSince) return task
      if (task.pendingRequest !== undefined) return task
      if (result.status === 'completed') {
        this.applyTurns(task, result.turns, result.lastSeq)
        task.status = 'completed'
        delete task.lastError
      } else if (result.status === 'failed' || result.status === 'aborted') {
        this.applyTurns(task, result.turns, result.lastSeq)
        task.status = result.status
        task.lastError = { code: result.error?.code ?? 'task-failed', message: result.error?.message ?? '任务没有成功完成', at: Date.now() }
      } else if (result.status === 'waiting_input') {
        task.status = 'waiting_input'
      } else {
        if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'aborted') task.status = 'running'
        if (result.lastSeq !== undefined) task.lastSeq = result.lastSeq
      }
      return task
    })
  }

  async readTask(args: { task_id: string; wait_seconds: number; offset: number; max_chars: number }): Promise<ToolResult> {
    return this.guarded(async () => {
      const task = await this.load(args.task_id)
      if (task.sessionId === undefined) {
        return {
          ok: true,
          ...this.taskView(task),
          questions: [],
          reply: null,
          note: task.status === 'dispatching' ? '任务还在创建中，稍后再读' : '任务没有可用的会话',
        }
      }
      if (task.attached === true && task.since === undefined) {
        const run = await runCli(['status', task.sessionId, '--json'], this.env)
        const payload = asRecord(run.json)
        if (run.code !== 0 && run.code !== 10) throw new BridgeError(errorOfRun(run).code, errorOfRun(run).message)
        if (payload['ok'] !== true) throw new BridgeError(errorOfRun(run).code, errorOfRun(run).message)
        const data = asRecord(payload['data'])
        const questions = questionsOf(data['questions'])
        const status = questions.length > 0 ? 'waiting_input' : data['running'] === true ? 'running' : 'idle'
        return {
          ok: true,
          ...this.taskView(task),
          status,
          state: typeof data['state'] === 'string' ? data['state'] : null,
          questions,
          reply: null,
          note: '这是接入的已有会话，且还没有通过桥发过消息；读对话正文请用 dsh_read_session。继续派活请用 dsh_continue_task。',
        }
      }
      const snapshotSince = task.since ?? -1
      // 0 秒不是走 status 捷径：也走 wait --settled；最少给 3.2 秒让它能完成稳定判据。
      const waitSeconds = args.wait_seconds === 0 ? 3.2 : args.wait_seconds
      const result = await this.waitOnce(task, waitSeconds)
      const latest = await this.applyRead(task.taskId, snapshotSince, result)
      const superseded = latest.since !== snapshotSince || latest.pendingRequest !== undefined
      const reply = superseded ? undefined : replyOf(result.turns, args.offset, args.max_chars)
      const payload: Json = {
        ok: true,
        ...this.taskView(latest),
        status: superseded ? latest.status : result.status,
        questions: superseded ? [] : result.questions,
        reply: reply ?? null,
        waited_seconds: waitSeconds,
        ...(superseded ? { superseded: true, note: '读取期间任务被继续派活，结果已过期；请重新调用 dsh_read_task' } : {}),
      }
      if (!superseded && result.error !== undefined) payload['error'] = result.error
      return payload
    })
  }

  async answerTask(args: {
    task_id: string
    call_id?: string | undefined
    answers?: { id: string; selected: string[]; custom?: string | undefined }[] | undefined
    text?: string | undefined
    select?: string[] | undefined
  }): Promise<ToolResult> {
    return this.guarded(async () => {
      const task = await this.load(args.task_id)
      if (task.sessionId === undefined) throw new BridgeError('task_not_sendable', `任务 ${task.taskId} 没有可用会话，不能回答问题`)
      const current = await this.waitOnce(task, 0.2)
      if (current.questions.length === 0) throw new BridgeError('no_question', '这个任务现在没有在等回答的问题；先读任务状态确认', { task: this.taskView(task) })
      let group: QuestionGroup | undefined
      if (args.call_id !== undefined) group = current.questions.find((item) => item.callId === args.call_id)
      else if (current.questions.length === 1) group = current.questions[0]
      else throw new BridgeError('multiple_question_groups', '这次有两组以上提问，请用 call_id 指定回答哪一组', { questions: current.questions })
      if (group === undefined) throw new BridgeError('no_question', `没有 call_id 为 ${args.call_id ?? ''} 的提问`, { questions: current.questions })
      let answers: { id: string; selected: string[]; custom?: string | undefined }[]
      if (args.answers !== undefined) {
        if (args.text !== undefined || args.select !== undefined) throw new BridgeError('invalid_argument', 'answers 和 text/select 不能同时使用')
        answers = args.answers
      } else {
        if (args.select === undefined && args.text === undefined) throw new BridgeError('invalid_argument', '要么给 answers，要么给 select 或 text')
        if (group.questions.length !== 1) throw new BridgeError('multiple_questions', '这一组有多个问题，请用 answers 一次答完', { questions: group.questions })
        answers = [{ id: group.questions[0]!.id, selected: args.select ?? [], ...(args.text === undefined ? {} : { custom: args.text }) }]
      }
      const known = new Set(group.questions.map((q) => q.id))
      for (const answer of answers) {
        if (!known.has(answer.id)) throw new BridgeError('unknown_question', `问题编号 ${answer.id} 不在这一组提问里`, { questions: group.questions })
      }
      const argv = ['answer', task.sessionId, '--json', JSON.stringify({ answers }), '--call-id', group.callId, '--json']
      const run = await runCli(argv, this.env)
      const payload = asRecord(run.json)
      if (run.code !== 0 || payload['ok'] !== true) throw new BridgeError(errorOfRun(run).code, errorOfRun(run).message)
      const latest = await this.store.mutate(task.taskId, (record) => {
        record.status = 'running'
        delete record.lastError
        return record
      })
      return { ok: true, ...this.taskView(latest), accepted: true, answered: answers }
    })
  }

  async cancelTask(args: { task_id: string }): Promise<ToolResult> {
    return this.guarded(async () => {
      const task = await this.load(args.task_id)
      if (task.sessionId === undefined) throw new BridgeError('task_not_sendable', `任务 ${task.taskId} 没有可用会话，不能取消`)
      const run = await runCli(['cancel', task.sessionId, '--json'], this.env)
      const payload = asRecord(run.json)
      if (run.code !== 0 || payload['ok'] !== true) throw new BridgeError(errorOfRun(run).code, errorOfRun(run).message)
      const data = asRecord(payload['data'])
      const cancelled = data['cancelled'] === true
      const latest = await this.store.mutate(task.taskId, (current) => {
        if (cancelled) current.status = 'cancelled'
        return current
      })
      return { ok: true, ...this.taskView(latest), cancelled }
    })
  }
}

export function createMcpServer(env: NodeJS.ProcessEnv = process.env): McpServer {
  const bridge = new Bridge(env)
  const server = new McpServer(
    { name: 'dsh-control', version: '0.1.0' },
    { instructions: '这是本机 DSH 的会话与任务桥。用户给出已有 DSH session 时，先用 dsh_read_session 直接读取，不需要建任务；要续办、回答或取消，先用 dsh_attach_session 接入，再用对应任务工具。dsh_list_sessions 可以按名字、目录或工作区发现会话。dsh_create_task 只用于新建任务。只用这里提供的工具，不要用它操作任意 DSH 接口、插件或配置。' },
  )

  server.registerTool('dsh_list_workspaces', {
    title: '列出 DSH 工作区',
    description: '列出本机 DSH 已登记的工作区（编号、名字、路径、会话数）。创建任务时可把工作区名字或路径传给 dsh_create_task。',
    inputSchema: {},
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async () => bridge.listWorkspaces())

  server.registerTool('dsh_list_sessions', {
    title: '列出 DSH 会话',
    description: '按名字、目录或工作区查找本机 DSH 已有会话；返回数量受限，`matched` 是符合筛选的总数，`shown` 是本页数量。支持现有 sessions 命令的筛选语义。',
    inputSchema: {
      query: z.string().optional().describe('标题或目录关键词'),
      workspace: z.string().optional().describe('工作区编号、名字或路径'),
      cwd: z.string().optional().describe('按现在或起始目录筛选，支持绝对路径或 ~/ 开头'),
      running: z.boolean().optional().describe('只看正在运行或等待回答的会话'),
      ungrouped: z.boolean().optional().describe('只看未归入工作区的会话；不能与 workspace 同时用'),
      include_blank: z.boolean().optional().describe('包含空白会话'),
      all: z.boolean().optional().describe('包含已归档会话'),
      limit: z.number().int().min(1).max(100).default(20).describe('最多返回多少个，默认 20'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async (args) => bridge.listSessions(args))

  server.registerTool('dsh_read_session', {
    title: '直接读取已有 DSH 会话',
    description: '直接读取用户给出的 DSH session（也接受现有 resolver 的名字/编号标识），不需要桥任务编号、不等待会话跑完、不新建任何东西。返回状态/模型/目录、最近几轮概览和指定轮或固定窗口的必要用户与助手正文；不含思考、系统提示或工具日志。长文本按 offset/max_chars 分页，结果带 next_page（可直接原样传回）和实际轮号。',
    inputSchema: {
      session: z.string().min(1).describe('DSH 会话编号，或现有 resolver 接受的名字/前缀'),
      turn: z.number().int().min(1).optional().describe('指定单轮的实际轮号；优先于 through_turn/last'),
      through_turn: z.number().int().min(1).optional().describe('固定多轮窗口的结束轮号；翻页时带上它可避免新轮次把窗口往后推'),
      last: z.number().int().min(1).max(10).default(3).describe('不指定 turn 时从 through_turn 往前取多少轮，默认 3'),
      offset: z.number().int().min(0).default(0).describe('正文起始字符位置'),
      max_chars: z.number().int().min(200).max(12_000).default(4_000).describe('本次最多返回多少字符，默认 4000'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async (args) => bridge.readSession(args))

  server.registerTool('dsh_attach_session', {
    title: '接入已有 DSH 会话',
    description: '按真实 status 把一个已有 DSH 会话接入桥，返回可给 dsh_read_task / dsh_continue_task / dsh_answer_task / dsh_cancel_task 使用的 task_id。只建立持久映射，不调用 new、不发送消息、不换模型、不丢上下文；同一会话重复或并发接入复用同一映射。接入成功不等于执行完成。',
    inputSchema: {
      session: z.string().min(1).describe('DSH 会话编号，或现有 resolver 接受的名字/前缀'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async (args) => bridge.attachSession(args))

  server.registerTool('dsh_create_task', {
    title: '新建 DSH 委派任务',
    description: '在本机 DSH 新建一个任务并立即派给 fast 档模型执行（tier 可选 normal）。必须提供唯一 request_key 防重复；同一个 key 同输入只创建一次。workspace 和 cwd 必须正好给一个。返回 task_id、session_id、since 和真实选择的模型。',
    inputSchema: {
      request_key: z.string().min(1).max(200).describe('幂等键，由主控生成；同一个 key 重试不会重复创建'),
      prompt: z.string().min(1).max(20_000).describe('要执行的具体任务，写清目标、限制和验收标准'),
      workspace: z.string().min(1).optional().describe('已登记工作区的编号、名字或路径；与 cwd 二选一'),
      cwd: z.string().min(1).optional().describe('明确的绝对目录；与 workspace 二选一，目录必须存在'),
      tier: z.enum(['fast', 'normal']).default('fast').describe('执行档位，默认 fast；只有特别复杂的任务才用 normal'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async (args) => bridge.createTask(args))

  server.registerTool('dsh_read_task', {
    title: '读取任务状态与结果',
    description: '读取任务状态和最后一段必要回复。长任务需要反复调用；Raycast 不会收到主动推送。长回复用 offset/max_chars 续读，需要用户回答时返回 questions。对 dsh_attach_session 接入且尚未通过桥发过消息的空闲会话返回 idle 状态，不伪报 running；读对话正文请用 dsh_read_session。',
    inputSchema: {
      task_id: z.string().min(1).describe(TASK_ID_DESCRIPTION),
      wait_seconds: z.number().int().min(0).max(20).default(10).describe('本次最多等待秒数（0–20，默认 10）。0 仍执行一次 wait --settled 真做完检查，内部至少 3.2 秒稳定期，不是立即返回；超时返回 running 和原任务号，不重发。'),
      offset: z.number().int().min(0).default(0).describe('回复文本的起始字符位置，用于分页续读'),
      max_chars: z.number().int().min(200).max(12_000).default(4_000).describe('本次最多返回多少字符，默认 4000'),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  }, async (args) => bridge.readTask(args))

  server.registerTool('dsh_continue_task', {
    title: '给任务继续派活',
    description: '给 dsh_create_task 创建或 dsh_attach_session 接入的任务继续发一条消息。必须提供唯一 request_key；同 key 同输入返回原回执，不重复发送。',
    inputSchema: {
      task_id: z.string().min(1).describe(TASK_ID_DESCRIPTION),
      request_key: z.string().min(1).max(200).describe('幂等键，同一个任务内唯一；重试不会重复发送'),
      message: z.string().min(1).max(20_000).describe('继续要做的事，写清目标和验收标准'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async (args) => bridge.continueTask(args))

  server.registerTool('dsh_answer_task', {
    title: '回答任务的提问',
    description: '回答该任务通过 ask_user_question 明确提出的问题。先读任务状态拿到 questions 和 call_id；用 answers 传 [{id, selected:[选项原文], custom?}]。只回答本桥创建或接入任务的问题，不代答系统审批。',
    inputSchema: {
      task_id: z.string().min(1).describe(TASK_ID_DESCRIPTION),
      call_id: z.string().min(1).optional().describe('有多组提问时，指定回答哪一组；单组可省略'),
      answers: z.array(z.object({
        id: z.string().min(1),
        selected: z.array(z.string()).default([]),
        custom: z.string().optional(),
      })).optional().describe('按问题编号给出的完整回答；多问题或多组时使用'),
      text: z.string().optional().describe('单个问题时的自由回答文字'),
      select: z.array(z.string()).optional().describe('单个问题时要选的选项原文'),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  }, async (args) => bridge.answerTask(args))

  server.registerTool('dsh_cancel_task', {
    title: '取消任务当前这一轮',
    description: '请求中止该任务正在跑的这一轮。只能取消本桥创建或接入的任务；没在跑时返回 cancelled false。',
    inputSchema: {
      task_id: z.string().min(1).describe(TASK_ID_DESCRIPTION),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async (args) => bridge.cancelTask(args))

  return server
}

async function main(): Promise<void> {
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  transport.onerror = (error) => log(`transport error: ${error.message}`)
  await server.connect(transport)
  log(`ready pid=${process.pid}`)
}

main().catch((error: unknown) => {
  log(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exitCode = 1
})
