/**
 * Tool calls from `repl.background` work after its cell has ended.
 *
 * A cell's tools are the bindings DSH's PTC executor hands it, and the
 * executor voids them the moment `run_code` settles. Work that outlives the
 * cell instead dispatches through DSH's public invocation pipeline
 * (`@deepseek-ai/dsh-tools/pipeline`): the same pre-execute
 * policy, approval, guards, tool body (with its own sandbox), post-execute and
 * result observers as any call. A grant holds exactly the tool names of the
 * cell that started the job, never more, and ends when the job ends, is
 * killed, or its kernel or session goes away.
 *
 * @module
 */
import type { BoundTool } from './lease.ts'

/** The slice of `ToolExecutionPipeline` this module uses. */
export interface PipelineLike {
  executionMode(exec: unknown): { kind: string }
  prepare(input: unknown): Promise<{ kind: string; exec: unknown; result?: unknown }>
  dispatch(exec: unknown): Promise<{ kind: string; result: unknown }>
  complete(exec: unknown, outcome: unknown): Promise<PipelineResult>
}

interface PipelineResult {
  isError: boolean
  value?: unknown
  content?: ReadonlyArray<{ type: string; text?: string; [key: string]: unknown }>
  additionalContexts?: ReadonlyArray<unknown>
  error?: { message?: string; info?: { name?: string; code?: string } }
}

/** Construct DSH's public pipeline; any failure to load it rejects with the reason. */
export async function loadPipeline(
  ctx: unknown,
  load: () => Promise<unknown> = () => import('@deepseek-ai/dsh-tools/pipeline' as string),
): Promise<PipelineLike> {
  try {
    const mod = await load() as { ToolExecutionPipeline?: new (ctx: unknown) => PipelineLike }
    if (typeof mod.ToolExecutionPipeline !== 'function') {
      throw new Error('@deepseek-ai/dsh-tools/pipeline loaded but does not export ToolExecutionPipeline')
    }
    return new mod.ToolExecutionPipeline(ctx)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`dsh-python-repl: could not load @deepseek-ai/dsh-tools/pipeline: ${detail}`)
  }
}

/**
 * The pipeline load a runtime keeps and hands to every grant. It is cached and
 * may never be awaited (no background job calls a tool), so a failure is
 * reported through `onError` here instead of surfacing as an unhandled
 * rejection; grants that do await it still get the error.
 */
export function sharedPipeline(ctx: unknown, onError: (error: unknown) => void, load?: () => Promise<unknown>): Promise<PipelineLike> {
  const pending = load === undefined ? loadPipeline(ctx) : loadPipeline(ctx, load)
  pending.catch(onError)
  return pending
}

/** Calls DSH marks exclusive run one at a time per session, as they would in a model step; parallel-safe ones overlap. */
export class ToolLane {
  #exclusive: Promise<void> = Promise.resolve()
  readonly #parallel = new Set<Promise<unknown>>()

  async run<T>(exclusive: boolean, work: () => Promise<T>): Promise<T> {
    if (!exclusive) {
      await this.#exclusive
      const task = work()
      const held = task.catch(() => undefined)
      this.#parallel.add(held)
      try { return await task } finally { this.#parallel.delete(held) }
    }
    const before = this.#exclusive
    let release!: () => void
    this.#exclusive = new Promise((resolve) => { release = resolve })
    try {
      await before
      await Promise.allSettled([...this.#parallel])
      return await work()
    } finally {
      release()
    }
  }
}

export type GrantReply =
  | { status: 'ok'; result: unknown }
  | { status: 'error'; error: string; cancelled?: true }

export interface GrantOptions {
  jobId: string
  runId: string
  epoch: number
  /** The live agent the job belongs to; calls run in its scope and route approvals to it. */
  agent: unknown
  /** Tool names the originating cell was granted (catalog bindings excluded). */
  names: ReadonlySet<string>
  pipeline: Promise<PipelineLike | undefined>
  lane: ToolLane
}

/** Images one job keeps for its end notice; the rest are counted. Each costs model input, and a request has its own image cap. */
export const JOB_IMAGES_KEPT = 8

/** One `repl.background` job's tool access. */
export class BackgroundGrant {
  readonly jobId: string
  readonly runId: string
  readonly epoch: number
  readonly #agent: unknown
  readonly #names: ReadonlySet<string>
  readonly #pipeline: Promise<PipelineLike | undefined>
  readonly #lane: ToolLane
  readonly #controller = new AbortController()
  #ended: string | undefined
  #calls = 0
  /** Images from successful results: in a cell PTC attaches them to the next step; after the cell, the end notice carries them. */
  readonly #images: unknown[] = []
  #imagesDropped = 0
  /** Non-image contexts attached by post-execute hooks; the end notice carries them too. */
  readonly #contexts: unknown[] = []

  constructor(options: GrantOptions) {
    this.jobId = options.jobId
    this.runId = options.runId
    this.epoch = options.epoch
    this.#agent = options.agent
    this.#names = options.names
    this.#pipeline = options.pipeline
    this.#lane = options.lane
  }

  get ended(): string | undefined { return this.#ended }

  allows(name: string): boolean { return this.#names.has(name) }

  /** The images collected so far, handed over once; `dropped` counts those past {@link JOB_IMAGES_KEPT}. */
  takeImages(): { images: unknown[]; dropped: number } {
    const taken = { images: this.#images.splice(0), dropped: this.#imagesDropped }
    this.#imagesDropped = 0
    return taken
  }

  /** Additional contexts collected so far, handed over once for the job notice. */
  takeContexts(): unknown[] {
    return this.#contexts.splice(0)
  }

  /** End the grant: later calls are refused and calls in flight are cancelled. Idempotent. */
  revoke(reason: string): void {
    if (this.#ended !== undefined) return
    this.#ended = reason
    this.#controller.abort(new Error(`background job ${this.jobId} ${reason}`))
  }

  /** A bound function for one tool name. */
  bind(name: string): BoundTool {
    return async (args) => {
      const reply = await this.dispatch(name, args)
      if (reply.status === 'ok') return reply.result
      const error = new Error(reply.error)
      if (reply.cancelled) error.name = 'AbortError'
      throw error
    }
  }

  async dispatch(name: string, args: unknown): Promise<GrantReply> {
    if (this.#ended !== undefined) return { status: 'error', error: `background job ${this.jobId} ${this.#ended}; its tool access ended with it` }
    if (!this.#names.has(name)) return { status: 'error', error: `tool ${JSON.stringify(name)} was not available to the cell that started background job ${this.jobId}` }
    const pipeline = await this.#pipeline
    if (pipeline === undefined) {
      return { status: 'error', error: 'this DSH has no tool registry loaded, so background work cannot call DSH tools after its cell ends; fetch what it needs inside the cell' }
    }
    const signal = this.#controller.signal
    const input = { callId: `python-repl:${this.jobId}:${++this.#calls}`, name, arguments: args ?? {}, agent: this.#agent, signal }
    let exclusive = true
    try { exclusive = pipeline.executionMode(input).kind !== 'parallel' } catch { /* unknown: exclusive */ }
    const result = await this.#lane.run(exclusive, async () => {
      const prepared = await pipeline.prepare(input)
      const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared
      return pipeline.complete(prepared.exec, { kind: outcome.kind, result: outcome.result })
    })
    for (const context of result.additionalContexts ?? []) this.#contexts.push(context)
    if (!result.isError) {
      for (const block of result.content ?? []) {
        if (block.type !== 'image') continue
        if (this.#images.length < JOB_IMAGES_KEPT) this.#images.push(block)
        else this.#imagesDropped += 1
      }
      return { status: 'ok', result: result.value }
    }
    const message = result.error?.message ?? result.content?.map((c) => c.text ?? '').join('') ?? 'tool call failed'
    return signal.aborted && result.error?.info?.name === 'AbortError'
      ? { status: 'error', error: message, cancelled: true }
      : { status: 'error', error: message }
  }
}
