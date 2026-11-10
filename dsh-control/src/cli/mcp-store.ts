/**
 * MCP 桥的任务账本。
 *
 * 只存桥自建或通过 dsh_attach_session 接入的映射：任务编号、对应 DSH 会话、等待起点、真实模型、每次派活的
 * request_key 回执和最后一次已知状态。目的有三个：
 * - 进程重开后还能按任务编号查旧任务；
 * - 同一个 request_key 重复调用不再发第二次消息；
 * - 发送中进程断了留下 dispatching 记录，之后标成 unknown，绝不自动重放。
 *
 * 建任务和 request_key 索引的读改写走 `withLock`：同一进程排队，跨进程用
 * $DSH_HOME/dsh-control/mcp/.lock 独占；单个任务文件用临时文件原子替换。
 */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type TaskStatus =
  | 'dispatching'
  | 'created'
  | 'running'
  | 'waiting_input'
  | 'completed'
  | 'failed'
  | 'aborted'
  | 'cancelled'
  | 'unknown'
  | 'failed_before_send'
  | 'idle'

export interface RequestRecord {
  key: string
  kind: 'start' | 'continue'
  inputHash: string
  phase: 'dispatching' | 'sent' | 'failed' | 'unknown'
  startedAt: number
  finishedAt?: number
  receipt?: Record<string, unknown>
  error?: { code: string; message: string }
}

export interface TaskRecord {
  version: 1
  taskId: string
  sessionId?: string
  workspace: string
  cwd?: string
  /** 新建任务时的档位；接入已有会话时未知，允许省略。 */
  tier?: 'fast' | 'normal'
  model?: { provider: string; model: string }
  promptPreview?: string
  createdAt: number
  updatedAt: number
  status: TaskStatus
  /** true 表示这是通过 dsh_attach_session 接入的已有会话，不是 dsh_create_task 新建的。 */
  attached?: boolean
  since?: number
  lastSeq?: number
  lastTurn?: { turn: number; ended?: string; detail?: string | null }
  requests: Record<string, RequestRecord>
  pendingRequest?: { id: string; key: string; kind: 'start' | 'continue'; startedAt: number; pid?: number }
  lastError?: { code: string; message: string; at: number }
}

export class StoreError extends Error {
  readonly code: string
  readonly details?: unknown
  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'StoreError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export function hashInput(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function writeAtomic(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  const data = `${JSON.stringify(value, null, 2)}\n`
  const fd = openSync(tmp, 'wx', 0o600)
  try {
    writeFileSync(fd, data, 'utf8')
    // 先让文件内容真正落盘，再原子改名；只 rename 不 fsync 不能承诺断电后还在。
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
  // 目录项也要刷盘，否则断电后可能看不到刚改名的文件。
  const dirFd = openSync(dirname(file), 'r')
  try { fsyncSync(dirFd) } finally { closeSync(dirFd) }
}

export class TaskStore {
  readonly root: string
  readonly tasksDir: string
  readonly requestsDir: string
  private readonly lockPath: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(dshHome = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')) {
    this.root = join(dshHome, 'dsh-control', 'mcp')
    this.tasksDir = join(this.root, 'tasks')
    this.requestsDir = join(this.root, 'requests')
    this.lockPath = join(this.root, '.lock')
  }

  /** 目录只给当前用户：和 dsh-control 的 socket 同一权限口径。 */
  ensure(): void {
    mkdirSync(this.tasksDir, { recursive: true, mode: 0o700 })
    mkdirSync(this.requestsDir, { recursive: true, mode: 0o700 })
  }

  private taskPath(taskId: string): string {
    if (!/^task-[A-Za-z0-9._-]+$/.test(taskId)) throw new StoreError('task_not_found', `没有任务 ${taskId}。只能操作 dsh_create_task 或 dsh_attach_session 返回的任务编号；直接读取已有会话请用 dsh_read_session。`)
    return join(this.tasksDir, `${taskId}.json`)
  }

  private requestPath(scope: string, key: string): string {
    const digest = createHash('sha256').update(`${scope}\0${key}`).digest('hex')
    return join(this.requestsDir, `${digest}.json`)
  }

  private readJson<T>(file: string): T | undefined {
    if (!existsSync(file)) return undefined
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as T
    } catch (error) {
      throw new StoreError('store_corrupt', `任务记录读不出来：${file}（${error instanceof Error ? error.message : String(error)}）`)
    }
  }

  /** 同一进程先排队，跨进程再抢文件锁；锁只覆盖很短的读改写，不包住真正的 CLI 调用。 */
  async withLock<T>(fn: () => Promise<T> | T, timeoutMs = 10_000): Promise<T> {
    const run = this.queue.then(async () => {
      const release = await this.acquireFileLock(timeoutMs)
      try {
        return await fn()
      } finally {
        release()
      }
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  private async acquireFileLock(timeoutMs: number): Promise<() => void> {
    this.ensure()
    const started = Date.now()
    for (;;) {
      const token = randomUUID()
      try {
        const fd = openSync(this.lockPath, 'wx', 0o600)
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), token }))
        } finally {
          closeSync(fd)
        }
        // 只释放自己创建的锁：文件被别的进程换掉时不能误删别人的锁。
        return () => {
          try {
            const raw = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { token?: unknown }
            if (raw.token === token) rmSync(this.lockPath, { force: true })
          } catch { /* 锁已经不在了或不是自己的 */ }
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        let ownerPid: number | undefined
        let readable = false
        try {
          const raw = JSON.parse(readFileSync(this.lockPath, 'utf8')) as { pid?: unknown }
          if (typeof raw.pid === 'number' && Number.isSafeInteger(raw.pid)) ownerPid = raw.pid
          readable = true
        } catch {
          // 内容还没写完或损坏：不能判断所有者，先按别人正在建锁等待。
        }
        const hasOwner = readable && ownerPid !== undefined
        if (readable && ownerPid !== undefined) {
          let alive = false
          try { process.kill(ownerPid, 0); alive = true } catch { alive = false }
          if (!alive) {
            // 两个进程同时看到同一份残留锁时，谁先删都可能删掉对方刚建的新锁；
            // 单纯复查 mtime 只能缩小窗口，不能证明所有权，所以这里安全拒绝，不自动恢复。
            throw new StoreError(
              'store_lock_stale',
              `任务库锁文件属于已退出进程（pid ${ownerPid}）。为避免两个 MCP 进程同时清理时误删刚建好的活锁，本实现不自动删除；请确认没有 MCP 进程在运行后手动删除 ${this.lockPath}。`,
            )
          }
        }
        if (Date.now() - started >= timeoutMs) {
          throw new StoreError(
            hasOwner ? 'store_locked' : 'store_lock_unresolved',
            hasOwner
              ? '任务库正在被另一个进程写入，请稍后重试；没有发送新消息'
              : `任务库锁文件存在但读不出所有者，无法安全恢复，未自动删除；请确认没有 MCP 进程后手动检查 ${this.lockPath}`,
          )
        }
        await sleep(25)
      }
    }
  }

  load(taskId: string): TaskRecord | undefined {
    return this.readJson<TaskRecord>(this.taskPath(taskId))
  }

  require(taskId: string): TaskRecord {
    const task = this.load(taskId)
    if (task === undefined) throw new StoreError('task_not_found', `没有任务 ${taskId}。只能操作 dsh_create_task 或 dsh_attach_session 返回的任务编号；直接读取已有会话请用 dsh_read_session。`)
    return task
  }

  save(task: TaskRecord): void {
    task.updatedAt = Date.now()
    writeAtomic(this.taskPath(task.taskId), task)
  }

  /** 建任务和 request_key 索引一起做；已存在时返回原任务，绝不另建孤儿任务。 */
  async createOrGet(task: TaskRecord, scope: string, key: string, inputHash: string): Promise<{ created: boolean; task: TaskRecord }> {
    return this.withLock(() => {
      const existing = this.readJson<{ taskId?: unknown; inputHash?: unknown }>(this.requestPath(scope, key))
      if (existing !== undefined) {
        if (typeof existing.taskId !== 'string' || typeof existing.inputHash !== 'string') throw new StoreError('store_corrupt', 'request_key 索引内容不完整')
        if (existing.inputHash !== inputHash) throw new StoreError('request_key_conflict', '同一个 request_key 已经用于另一份输入；没有发送新消息')
        const found = this.load(existing.taskId)
        if (found === undefined) throw new StoreError('store_corrupt', `request_key 索引指向的任务 ${existing.taskId} 不存在`)
        return { created: false, task: found }
      }
      if (existsSync(this.taskPath(task.taskId))) throw new StoreError('store_corrupt', `任务编号重复：${task.taskId}`)
      this.save(task)
      writeAtomic(this.requestPath(scope, key), { scope, key, taskId: task.taskId, inputHash, createdAt: Date.now() })
      return { created: true, task }
    })
  }

  /** 锁内读最新任务、修改、原子保存；调用方不要把 CLI 调用放进来。 */
  async mutate<T>(taskId: string, fn: (task: TaskRecord) => T): Promise<T> {
    return this.withLock(() => {
      const task = this.require(taskId)
      const result = fn(task)
      this.save(task)
      return result
    })
  }

  /** 查找已经映射到某个 DSH 会话的桥任务；attach 复用已有 create 任务。 */
  findBySession(sessionId: string): TaskRecord | undefined {
    this.ensure()
    let found: TaskRecord | undefined
    for (const name of readdirSync(this.tasksDir)) {
      if (!name.endsWith('.json')) continue
      const task = this.readJson<TaskRecord>(join(this.tasksDir, name))
      if (task !== undefined && task.sessionId === sessionId && (found === undefined || task.updatedAt > found.updatedAt)) found = task
    }
    return found
  }
}
