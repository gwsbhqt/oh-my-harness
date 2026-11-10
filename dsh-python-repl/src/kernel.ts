/**
 * One Python kernel process: spawn, framing, correlation, cancellation.
 *
 * Deadlock rule (technical design §6.4): the reader NEVER blocks on a cell.
 * `host_request` frames are dispatched from the read loop while the cell's
 * `execute` is still outstanding, so a cell that awaits a tool can be served.
 * Futures are registered BEFORE the request is written, so a reply that
 * arrives in the same tick cannot be lost.
 *
 * @module
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { delimiter } from 'node:path'
import {
  encodeRequest,
  parseEvent,
  PROTOCOL_VERSION,
  type HostReplyData,
  type KernelEvent,
} from './protocol.ts'

/** How a cell finished. Mirrors the kernel's `done.status` plus our own transport failures. */
export type CellStatus = 'ok' | 'error' | 'kernel-exit'

/** Everything one cell emitted, in arrival order per channel. */
export interface CellOutcome {
  status: CellStatus
  /** stdout/stderr text and the trailing-expression repr, in arrival order. */
  logs: string[]
  /** Present iff the cell raised. */
  error?: { ename: string; evalue: string; traceback?: string[] }
  /** The `done` frame's own fields beyond id/status (snapshot and restore reports). */
  fields?: Record<string, unknown>
}

/** Where a namespace snapshot and its manifest live. */
export interface SnapshotTarget {
  path: string
  manifestPath: string
}

/** Called when the kernel asks the host to do something (a tool call). */
export type HostRequestHandler = (id: string, data: unknown) => void

/**
 * Called the INSTANT a cell's `done` frame is parsed, before its promise
 * continuation runs.
 *
 * The dispatch loop drains a whole pipe chunk synchronously, so a late
 * `host_request` sitting behind `done` in the same chunk would otherwise be
 * served while the finished cell's lease is still alive — the promise
 * continuation that revokes it is only a microtask, scheduled after this loop.
 */
export type CellSettledHandler = (runId: string) => void

export interface KernelOptions {
  /** Python interpreter path. */
  python: string
  /**
   * Directories placed on PYTHONPATH, in order. Must contain our vendored
   * `rlm` package and our own `python/` modules. This REPLACES any inherited
   * PYTHONPATH rather than extending it: an inherited entry could otherwise
   * resolve `rlm` to a real Prime install and hand the program a native bash
   * (technical design §8.4).
   */
  pythonPath: readonly string[]
  /** Working directory for the kernel process. */
  cwd?: string
  /** Extra environment. PYTHONPATH is owned by {@link pythonPath} and cannot be set here. */
  env?: Record<string, string>
  /**
   * Interpreter arguments that select the kernel entry point.
   *
   * Defaults to the vendored REPL. Tests override it with a protocol fixture
   * to make frame batching deterministic — a real kernel's chunk boundaries
   * are a scheduling accident, so ordering regressions cannot be pinned
   * against it (see test/protocol-ordering.test.ts).
   */
  moduleArgs?: readonly string[]
  /**
   * Maximum UTF-8 bytes in one incoming frame (including an unfinished line).
   * Defaults to 64 MiB: JSON parsing retains both wire text and decoded data,
   * so a single frame must have a memory ceiling. Raise explicitly for larger
   * legitimate payloads; accumulated output and batches of frames are not capped.
   */
  maxFrameBytes?: number
  /** Invoked for every `host_request` frame. */
  onHostRequest: HostRequestHandler
  /** Invoked synchronously when a cell's `done` frame is parsed. */
  onCellSettled?: CellSettledHandler
  /**
   * Invoked for output no pending cell owns: raw fd writes (no owner) and
   * prints from a finished cell's tasks. The session hands it to the next
   * user cell, as Prime's background output.
   */
  onUnattributedOutput?: (text: string) => void
  /**
   * Invoked when a non-empty stdout line could not be parsed as a frame.
   *
   * Protocol corruption, not a warning to ignore: a lost `host_request`
   * leaves the kernel awaiting a reply forever.
   */
  onCorruptFrame?: (line: string) => void
  /** Invoked when the kernel exits unexpectedly. */
  onExit?: (code: number | null, signal: string | null) => void
  /** Reports a failed termination synchronously, so the owner can revoke authority and retain the child. */
  onTerminationFailure?: (error: Error) => void
}

/** A cell awaiting completion. */
interface PendingCell {
  resolve: (outcome: CellOutcome) => void
  logs: string[]
  /**
   * Which kind of output produced the last entry in `logs`.
   *
   * CPython's `print` calls `write()` once per argument and once per
   * separator, so `print("x:", 42)` arrives as four frames. Appending each as
   * its own entry turned every labelled print into a cluster of fragments.
   * Tracking the source lets consecutive frames of the SAME stream merge,
   * while a `result` — or a switch between stdout and stderr — still starts a
   * new entry.
   */
  lastSource?: 'stdout' | 'stderr' | undefined
  error?: { ename: string; evalue: string; traceback?: string[] }
}

/**
 * Append kernel output, merging it with the previous entry when it continues
 * the same stream.
 *
 * @param cell - the pending cell receiving output.
 * @param source - which stream this frame came from.
 * @param text - the frame's text, appended verbatim (never reformatted).
 */
function appendStreamText(cell: PendingCell, source: 'stdout' | 'stderr', text: string): void {
  if (cell.lastSource === source && cell.logs.length > 0) {
    cell.logs[cell.logs.length - 1] += text
    return
  }
  cell.logs.push(text)
  cell.lastSource = source
}

/**
 * 父进程环境，去掉 Prime Agent 与 RLM 的内部变量：它们是启动 DSH 的那个 agent 进程的
 * 身份（工作进程 token、会话租约、看门狗主人），不属于这个内核，漏进去只会让内核
 * 把别人当主人，或把凭据带进用户代码能读到的 os.environ。
 */
function inheritedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('PRIME_AGENT_') || key.startsWith('RLM_')) continue
    env[key] = value
  }
  return env
}

/**
 * undici accepts the bracketed IPv6 token added by the host proxy helper, but
 * HTTPX rejects it before sending a request. Translate only this exact token
 * for the Python child; proxy URLs, other exclusions, spacing, and order stay
 * untouched so normal proxy routing is not weakened.
 */
function pythonProxyEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const key of ['NO_PROXY', 'no_proxy']) {
    const value = env[key]
    if (value === undefined) continue
    env[key] = value.split(',').map((token) => token.trim() === '[::1]' ? token.replace('[::1]', '::1') : token).join(',')
  }
  return env
}

const OWN_GROUP = process.platform !== 'win32'
const GROUP_GRACE_MS = 1_000

/** Signal a whole process group; false once no member is left (or none can be signalled). */
function signalGroup(group: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-group, signal)
    return true
  } catch {
    return false
  }
}

function failureMessage(error: unknown): string {
  try { return error instanceof Error ? error.message : String(error) } catch { return 'unprintable failure' }
}

/**
 * A live kernel process. One per session; `epoch` increments per restart so
 * authority from a previous generation can be rejected.
 */
export class PythonKernel {
  #proc: ChildProcessWithoutNullStreams | undefined
  #stdoutParts: string[] = []
  #stdoutBytes = 0
  #failed = false
  readonly #maxFrameBytes: number
  #pending = new Map<string, PendingCell>()
  #ready = false
  #disposed = false
  #pythonVersion = ''
  #exitInfo: { code: number | null; signal: string | null } | undefined
  #pidSnapshot: number | undefined
  /** Tail of the kernel's raw stderr before the handshake; the only trace of why a start failed. */
  #startupStderr = ''
  #terminationReason: string | undefined
  #terminationFailure: Error | undefined
  #terminating: Promise<void> | undefined
  #rejectTermination: ((cause: unknown) => void) | undefined
  #disposing: Promise<void> | undefined
  #ownsGroup = false
  #reaped: Promise<void> = Promise.resolve()
  #exitPromise: Promise<void>
  #markExited: () => void = () => {}
  readonly #options: KernelOptions
  readonly epoch: number

  constructor(options: KernelOptions, epoch: number) {
    this.#options = options
    this.#maxFrameBytes = options.maxFrameBytes ?? 64 * 1024 * 1024
    if (!Number.isSafeInteger(this.#maxFrameBytes) || this.#maxFrameBytes <= 0) {
      throw new Error('dsh-python-repl: maxFrameBytes must be a positive safe integer')
    }
    this.epoch = epoch
    this.#exitPromise = new Promise<void>((resolve) => {
      this.#markExited = resolve
    })
  }

  get ready(): boolean {
    return this.#ready && !this.#disposed && !this.#failed
  }

  get pythonVersion(): string {
    return this.#pythonVersion
  }

  /** Spawn the kernel and await the protocol handshake. */
  async start(timeoutMs: number = 30_000): Promise<void> {
    if (this.#disposed || this.#failed) throw new Error('dsh-python-repl: kernel is no longer available')
    if (this.#proc !== undefined) throw new Error('dsh-python-repl: kernel already started')
    // Order matters: our PYTHONPATH is written LAST so a caller-supplied `env`
    // cannot weaken the isolation it provides.
    const env: NodeJS.ProcessEnv = {
      ...inheritedEnv(),
      ...this.#options.env,
      // 内核的看门狗按它判断「主人还在不在」，主人没了就立刻退出。必须是本进程：
      // DSH 从 Prime Agent 里启动时会继承 pa 工作进程的这个值，pa 一重启，之后每个
      // 新内核都在启动时自杀。
      PRIME_AGENT_KERNEL_OWNER_PID: String(process.pid),
      PYTHONPATH: this.#options.pythonPath.join(delimiter),
      PYTHONUNBUFFERED: '1',
      // Never write .pyc next to the source: the vendored package must stay
      // byte-for-byte upstream, and CPython would otherwise drop a
      // `__pycache__/` directory inside it just by importing the kernel.
      PYTHONDONTWRITEBYTECODE: '1',
      ...(OWN_GROUP ? { DSH_PYTHON_REPL_OWNS_GROUP: '1' } : {}),
    }
    const proc = spawn(this.#options.python, [...(this.#options.moduleArgs ?? ['-m', 'rlm.repl'])], {
      // 内核自成一个进程组，它开的程序默认留在组里，内核结束时整组带走（见 #reapGroup）。
      // 2026-10-13 一个测试用的 headless Chrome 在内核没了以后又跑了 22 小时。
      detached: OWN_GROUP,
      // Defaulting to `pythonPath[0]` put the kernel INSIDE the vendored tree,
      // so a cell writing any relative path corrupted files this project
      // guarantees are untouched upstream. Callers should always pass a cwd;
      // the fallback is the process cwd, never the vendor root.
      cwd: this.#options.cwd ?? process.cwd(),
      env: pythonProxyEnv(env),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#proc = proc
    this.#pidSnapshot = proc.pid
    this.#ownsGroup = OWN_GROUP && proc.pid !== undefined
    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => this.#onStdout(chunk))
    proc.stderr.setEncoding('utf8')
    // 握手之后内核的 stderr 走协议帧；握手之前（解释器或导入失败）只有这里能留下原因。
    // 一直要读走，否则管道写满会把内核卡住。
    proc.stderr.on('data', (chunk: string) => {
      if (!this.#ready) this.#startupStderr = (this.#startupStderr + chunk).slice(-4000)
    })
    proc.on('exit', (code, signal) => this.#onExit(code, signal))
    // EPIPE on a kernel whose end of the pipe is gone arrives as an async
    // 'error' event; unhandled, it is an uncaught exception, and the desktop
    // backend exits on those — taking every session down with one kernel.
    proc.stdin.on('error', () => this.#settleAll())
    // A spawn failure (bad interpreter path, EACCES) surfaces as an async
    // 'error' event, never as a throw from spawn(). Without this listener Node
    // treats it as an unhandled error and tears the host down.
    proc.on('error', (error: Error) => {
      // A process that never spawned emits no 'exit', so record the end here;
      // otherwise terminate() would wait for an exit that cannot come.
      if (proc.pid === undefined && this.#exitInfo === undefined) {
        this.#exitInfo = { code: null, signal: null }
        this.#markExited()
      }
      this.#failed = true
      this.#settleAll()
      this.#rejectTermination?.(error)
      this.#readyReject?.(
        new Error(`dsh-python-repl: cannot start the Python kernel: ${error.message}`),
      )
    })

    let timer: NodeJS.Timeout | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`dsh-python-repl: kernel handshake timed out after ${timeoutMs}ms`)),
        timeoutMs,
      )
      timer.unref?.()
    })
    try {
      await Promise.race([this.#awaitReady(), deadline])
    } catch (error) {
      // The caller only keeps a kernel that started, so a child left running
      // here is unreachable: every retrying cell would leak one more process.
      try {
        if (this.#terminationFailure !== undefined) throw this.#terminationFailure
        await this.terminate('kernel handshake failed')
      } catch (terminationError) {
        throw new AggregateError([error, terminationError],
          `${failureMessage(error)}; ${failureMessage(terminationError)}`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  #readyResolve: (() => void) | undefined
  #readyReject: ((error: Error) => void) | undefined

  #awaitReady(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.#readyResolve = resolve
      this.#readyReject = reject
    })
  }

  /** Execute one cell. Resolves when the kernel reports `done` for this id. */
  execute(runId: string, code: string): Promise<CellOutcome> {
    return this.#request(runId, { type: 'execute', id: runId, code })
  }

  /** Stop accepting work and answer every waiting cell: the kernel can no longer be reached. */
  #settleAll(): void {
    this.#ready = false
    for (const [, cell] of this.#pending) cell.resolve({ status: 'kernel-exit', logs: cell.logs })
    this.#pending.clear()
  }

  /** Ask the kernel to interrupt a cell (cooperative; may be ignored by tight C loops). */
  interrupt(runId?: string): void {
    if (!this.ready) return
    this.#write(runId === undefined ? { type: 'interrupt' } : { type: 'interrupt', id: runId })
  }

  /** Answer a `host_request`. */
  reply(id: string, data: HostReplyData): void {
    if (!this.ready) return
    this.#write({ type: 'host_reply', id, data })
  }

  /** Serialize the user namespace to `target` (best effort, per variable). */
  snapshot(id: string, target: SnapshotTarget): Promise<CellOutcome> {
    return this.#request(id, { type: 'snapshot', id, path: target.path, manifest_path: target.manifestPath })
  }

  /** Revive a snapshot written by {@link snapshot} into this kernel's namespace. */
  restore(id: string, target: SnapshotTarget): Promise<CellOutcome> {
    return this.#request(id, { type: 'restore', id, path: target.path })
  }

  /** The user's top-level names, filtered like the snapshot; they arrive in the `done` frame's `names`. */
  listNames(id: string, timeoutMs?: number): Promise<CellOutcome> {
    const request = this.#request(id, { type: 'list_names', id })
    if (timeoutMs === undefined) return request
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        resolve({ status: 'error', logs: [], fields: { timeout: true } })
      }, timeoutMs)
      void request.then((outcome) => { clearTimeout(timer); resolve(outcome) })
    })
  }

  /** Preview uses the existing list_names adapter and retains its pending slot until the real reply. */
  previewName(id: string, name: string, epoch: number): Promise<CellOutcome> {
    return this.#request(id, { type: 'list_names', id, preview: { name, epoch } })
  }

  #request(id: string, request: Parameters<typeof encodeRequest>[0]): Promise<CellOutcome> {
    if (!this.ready) return Promise.resolve({ status: 'kernel-exit', logs: [] })
    return new Promise<CellOutcome>((resolve) => {
      // Register BEFORE writing: a same-tick reply must find its slot.
      this.#pending.set(id, { resolve, logs: [] })
      this.#write(request)
    })
  }

  /** Request a clean stop, then force-kill with a bounded wait. Failure retains the child for an explicit retry. */
  dispose(graceMs = 5_000): Promise<void> {
    if (this.#disposing !== undefined) return this.#disposing
    const firstClose = !this.#disposed
    this.#disposed = true
    this.#readyReject?.(new Error('dsh-python-repl: kernel disposed during startup'))
    this.#settleAll()
    const proc = this.#proc
    if (proc === undefined || this.#exitInfo !== undefined) return Promise.resolve()
    try {
      if (firstClose && proc.stdin.writable) {
        proc.stdin.write(encodeRequest({ type: 'shutdown' }))
        proc.stdin.end()
      }
    } catch {
      // A broken pipe is not proof of exit; the force-kill path must still run.
    }
    const work = (async () => {
      if (await this.#waitForExit(firstClose ? graceMs : 0)) return await this.#reaped
      await this.terminate('kernel disposal deadline exceeded')
    })()
    this.#disposing = work
    void work.then(
      () => { if (this.#disposing === work) this.#disposing = undefined },
      () => { if (this.#disposing === work) this.#disposing = undefined },
    )
    return work
  }

  /** Wait only for a real exit event; a deadline never marks a live child exited. */
  #waitForExit(ms: number): Promise<boolean> {
    if (this.#exitInfo !== undefined) return Promise.resolve(true)
    const proc = this.#proc
    if (proc === undefined) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let timer: NodeJS.Timeout | undefined
      const finish = (exited: boolean): void => {
        clearTimeout(timer)
        proc.removeListener('exit', onExit)
        resolve(exited)
      }
      const onExit = (): void => finish(true)
      proc.once('exit', onExit)
      timer = setTimeout(() => finish(false), ms)
    })
  }

  #write(request: Parameters<typeof encodeRequest>[0]): void {
    const proc = this.#proc
    if (proc === undefined || !proc.stdin.writable) return
    proc.stdin.write(encodeRequest(request))
  }

  #onStdout(chunk: string): void {
    if (this.#disposed || this.#failed) return
    let offset = 0
    while (offset < chunk.length) {
      const index = chunk.indexOf('\n', offset)
      const part = chunk.slice(offset, index === -1 ? chunk.length : index)
      this.#stdoutBytes += Buffer.byteLength(part, 'utf8')
      if (this.#stdoutBytes > this.#maxFrameBytes) {
        this.#reportCorrupt(`protocol frame exceeds ${this.#maxFrameBytes} UTF-8 bytes`)
        return
      }
      this.#stdoutParts.push(part)
      if (index === -1) return
      const line = this.#stdoutParts.join('')
      this.#stdoutParts = []
      this.#stdoutBytes = 0
      const event = parseEvent(line)
      if (event !== undefined) {
        try { this.#dispatch(event) } catch (error) { this.#reportCorrupt(line, error) }
      } else if (line.trim() !== '') {
        this.#reportCorrupt(line)
      }
      if (this.#disposed || this.#failed) return
      offset = index + 1
    }
  }

  #reportCorrupt(line: string, cause?: unknown): void {
    if (this.#failed) return
    this.#failed = true
    this.#stdoutParts = []
    this.#stdoutBytes = 0
    const reason = `malformed protocol frame: ${line.slice(0, 200)}${cause instanceof Error ? ` (${cause.message})` : ''}`
    this.#readyReject?.(new Error(`dsh-python-repl: ${reason}`))
    try {
      // The owner revokes authority synchronously; notification is not permission
      // to keep serving a broken protocol, even when the callback only logs it.
      this.#options.onCorruptFrame?.(line)
    } catch {
      // A notification failure must not escape the pipe listener.
    }
    // terminate records the failure and notifies the owner before rejecting.
    if (this.#terminationReason === undefined) void this.terminate(reason).catch(() => {})
  }

  #dispatch(event: KernelEvent): void {
    switch (event.event) {
      case 'ready': {
        if (event.protocol !== PROTOCOL_VERSION) {
          this.#readyReject?.(
            new Error(
              `dsh-python-repl: kernel speaks protocol ${event.protocol}, this bridge speaks ${PROTOCOL_VERSION}`,
            ),
          )
          return
        }
        this.#ready = true
        this.#pythonVersion = event.python
        this.#readyResolve?.()
        return
      }
      case 'stdout':
      case 'stderr': {
        const cell = event.id === null ? undefined : this.#pending.get(event.id)
        if (cell !== undefined) {
          appendStreamText(cell, event.event, event.text)
          return
        }
        // Raw fd output (null id) has no provable owner, and a finished
        // cell's tasks still print under its id. Neither may be mixed into the
        // pending cell's own output or an internal JSON report.
        this.#options.onUnattributedOutput?.(event.text)
        return
      }
      case 'result': {
        const cell = this.#pending.get(event.id)
        if (cell !== undefined) {
          // A displayed value is not stream text: keep it as its own entry so
          // it stays distinguishable from whatever the cell printed first.
          cell.logs.push(event.text)
          cell.lastSource = undefined
        }
        return
      }
      case 'error': {
        if (event.id === null) return
        const cell = this.#pending.get(event.id)
        if (cell !== undefined) {
          cell.error = {
            ename: event.ename,
            evalue: event.evalue,
            ...(event.traceback === undefined ? {} : { traceback: event.traceback }),
          }
        }
        return
      }
      case 'host_request': {
        this.#options.onHostRequest(event.id, event.data)
        return
      }
      case 'done': {
        const cell = this.#pending.get(event.id)
        if (cell === undefined) return
        // Keep the cell registered until the callback succeeds: if it throws,
        // retirement still owes this cell a kernel-exit result.
        this.#options.onCellSettled?.(event.id)
        this.#pending.delete(event.id)
        const status: CellStatus = event.status === 'ok' ? 'ok' : 'error'
        const { event: _event, id: _id, status: _status, ...fields } = event
        cell.resolve({
          status,
          logs: cell.logs,
          ...(cell.error === undefined ? {} : { error: cell.error }),
          ...(Object.keys(fields).length === 0 ? {} : { fields }),
        })
        return
      }
      case 'display':
        return
    }
  }

  #onExit(code: number | null, signal: string | null): void {
    this.#ready = false
    this.#exitInfo = { code, signal }
    this.#reaped = this.#reapGroup()
    this.#markExited()
    for (const [, cell] of this.#pending) {
      cell.resolve({ status: 'kernel-exit', logs: cell.logs })
    }
    this.#pending.clear()
    this.#readyReject?.(
      new Error(
        `dsh-python-repl: kernel exited during startup (code=${code}, signal=${signal})`
          + (this.#startupStderr.trim() === '' ? '' : `\n${this.#startupStderr.trim()}`),
      ),
    )
    if (!this.#disposed) {
      try { this.#options.onExit?.(code, signal) } catch {
        this.#terminationReason ??= 'kernel exit callback failed'
      }
    }
  }

  /** Exit code/signal once the process has exited. */
  get exitInfo(): { code: number | null; signal: string | null } | undefined {
    return this.#exitInfo
  }

  /**
   * Whether a spawned OS process has no confirmed exit yet.
   *
   * NOTE for tests: `killed` only means a signal was DELIVERED, not that the
   * process is gone. Use {@link exited} when the assertion is "the process
   * really terminated".
   */
  get alive(): boolean {
    const proc = this.#proc
    return proc?.pid !== undefined && this.#exitInfo === undefined
  }

  /** Resolves once the OS process has actually exited. */
  get exited(): Promise<void> {
    return this.#exitPromise
  }

  /**
   * End what the kernel started and did not detach: SIGTERM to the group, up to
   * 1s to leave, then SIGKILL. Members that called setsid (Python
   * `start_new_session=True`) are outside the group by their own request.
   */
  #reapGroup(): Promise<void> {
    const group = this.#pidSnapshot
    if (!this.#ownsGroup || group === undefined || !signalGroup(group, 'SIGTERM')) return Promise.resolve()
    return (async () => {
      const deadline = Date.now() + GROUP_GRACE_MS
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        if (!signalGroup(group, 0)) return
      }
      signalGroup(group, 'SIGKILL')
    })()
  }

  /** The kernel's process id, retained after exit so its process group can still be reaped. */
  get pidSnapshot(): number | undefined {
    return this.#pidSnapshot
  }

  /** Stop serving immediately, signal once, and await real exit only up to the host deadline. */
  terminate(reason: string, timeoutMs = 1_000): Promise<void> {
    this.#terminationReason ??= reason
    this.#failed = true
    this.#readyReject?.(new Error(`dsh-python-repl: ${reason}`))
    this.#settleAll()
    const proc = this.#proc
    if (proc === undefined || this.#exitInfo !== undefined) return Promise.resolve()
    if (this.#terminating !== undefined) return this.#terminating
    let resolve!: () => void
    let reject!: (error: Error) => void
    const work = new Promise<void>((ok, fail) => { resolve = ok; reject = fail })
    this.#terminating = work
    let timer: NodeJS.Timeout | undefined
    let settled = false
    const onExit = (): void => finish()
    const finish = (cause?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      proc.removeListener('exit', onExit)
      this.#rejectTermination = undefined
      if (this.#terminating === work) this.#terminating = undefined
      if (cause === undefined) { void this.#reaped.then(resolve); return }
      const error = new Error(`dsh-python-repl: termination failed (pid=${proc.pid ?? 'unknown'}): `
        + `${failureMessage(cause)}. Process exit is unconfirmed; the child is retained for disposal retry.`,
      { cause })
      this.#terminationFailure = error
      try { this.#options.onTerminationFailure?.(error) } catch (notificationError) {
        this.#terminationFailure = new AggregateError([error, notificationError],
          `${error.message} Owner notification failed: ${failureMessage(notificationError)}`)
      }
      reject(this.#terminationFailure)
    }
    this.#rejectTermination = (cause) => finish(cause)
    // Both observers are registered before kill, which can synchronously emit an error.
    proc.once('exit', onExit)
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
      finish(new Error('termination timeoutMs must be a safe integer from 0 to 2147483647'))
      return work
    }
    timer = setTimeout(() => finish(new Error(`no exit event within ${timeoutMs}ms after SIGKILL`)), timeoutMs)
    try {
      if (!proc.kill('SIGKILL')) finish(new Error('SIGKILL was not delivered (kill returned false)'))
    } catch (error) { finish(error) }
    return work
  }

  /** Last termination failure, retained even if a later explicit disposal succeeds. */
  get terminationFailure(): Error | undefined {
    return this.#terminationFailure
  }
}
