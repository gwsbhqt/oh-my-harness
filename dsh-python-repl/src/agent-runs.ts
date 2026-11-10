/**
 * `repl.agent(...)`: start a subagent from Python and hand its result back to
 * the code (python/agents.py).
 *
 * The `subagent` tool only returns an id and reports the result to the model
 * as a message, so a cell cannot wait for a child and use what it returns.
 * DSH's official workflow engine does exactly that through the public
 * subagent service: `startActivation({ delivery: 'caller' })` returns the
 * child's result to the caller and sends the parent no notice. This module
 * does the same for the kernel, mirroring the engine's `agent()`: wait for
 * the result, then always dispose the activation.
 *
 * Every run has an owner: the cell that started it, or the `repl.background`
 * job it runs in. When the owner ends (cell settled or cancelled, job ended or
 * killed, kernel replaced, session closed), its unfinished children are
 * stopped. DSH caps live children per tree (`maxActiveSubagents`, default 8)
 * and refuses rather than queues past it; a refused start waits for one of
 * this session's own children to finish and tries again.
 *
 * @module
 */

/** The slice of DSH's subagent service (`ctx.subagents`) this module uses. */
export interface SubagentsLike {
  startActivation(spec: {
    provider: string
    label: string
    delivery: 'caller'
    signal: AbortSignal
    request: Record<string, unknown>
  }): Promise<ActivationLike>
  getProvider?(name: string): unknown
}

export interface ActivationLike {
  childId: string
  result: Promise<{ output?: ReadonlyArray<{ type: string; text?: string }>; stopReason: string; structured?: unknown }>
  dispose(): Promise<void>
}

export interface AgentSpec {
  /** The exact live agent the child belongs to. */
  parent: unknown
  prompt: string
  label: string
  schema?: unknown
  provider?: string
  model?: string
}

export interface AgentOutcome {
  childId: string
  stopReason: string
  text: string
  structured?: unknown
}

/** Same provider the shipped workflow engine and `subagent` tool use. */
export const DEFAULT_PROVIDER = 'spawn'

interface Live {
  owner: string
  controller: AbortController
  activation?: ActivationLike
  settled: Promise<void>
}

function codeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
}

function outputText(output: ReadonlyArray<{ type: string; text?: string }> | undefined): string {
  return (output ?? []).filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('')
}

/** One session's `repl.agent` children. */
export class AgentRuns {
  readonly #subagents: () => SubagentsLike | undefined
  readonly #live = new Map<string, Live>()

  constructor(subagents: () => SubagentsLike | undefined) {
    this.#subagents = subagents
  }

  /** Running children, for the idle check and tests. */
  get size(): number { return this.#live.size }

  /**
   * Start one child for `owner`, wait for its result, and dispose it.
   * @param callId - the kernel's id for this call; `cancel(callId)` stops it.
   * @throws when the service is missing, the start is refused, or the owner ends first (an `AbortError`).
   */
  async run(callId: string, owner: string, spec: AgentSpec): Promise<AgentOutcome> {
    const service = this.#subagents()
    if (service === undefined || typeof service.startActivation !== 'function') {
      throw new Error('this DSH has no subagent service, so repl.agent cannot start a child; use tools.subagent instead')
    }
    if (this.#live.has(callId)) throw new Error(`duplicate repl.agent call id ${callId}`)
    let done!: () => void
    const live: Live = { owner, controller: new AbortController(), settled: new Promise((resolve) => { done = resolve }) }
    this.#live.set(callId, live)
    try {
      const request: Record<string, unknown> = {
        prompt: [{ type: 'text', text: spec.prompt }],
        parent: spec.parent,
        ...(spec.schema === undefined ? {} : { outputSchema: spec.schema }),
        ...(spec.provider === undefined && spec.model === undefined ? {} : { agentOptions: {
          ...(spec.provider === undefined ? {} : { provider: spec.provider }),
          ...(spec.model === undefined ? {} : { model: spec.model }),
        } }),
      }
      for (;;) {
        this.#throwIfStopped(live)
        try {
          live.activation = await service.startActivation({ provider: DEFAULT_PROVIDER, label: spec.label, delivery: 'caller', signal: live.controller.signal, request })
          break
        } catch (error) {
          if (codeOf(error) !== 'ACTIVATION_LIMIT_REACHED') throw error
          // DSH refuses past its cap instead of queueing; wait for one of ours to finish.
          const others = [...this.#live.values()].filter((other) => other !== live && other.activation !== undefined)
          if (others.length === 0) throw error
          await Promise.race([...others.map((other) => other.settled), this.#stopped(live)])
        }
      }
      // Stopped while starting: the activation was published anyway, so dispose it.
      if (live.controller.signal.aborted) await this.#dispose(live)
      this.#throwIfStopped(live)
      const activation = live.activation
      const result = await Promise.race([activation.result, this.#stopped(live)])
      return {
        childId: activation.childId,
        stopReason: result.stopReason,
        text: outputText(result.output),
        ...(result.structured === undefined ? {} : { structured: result.structured }),
      }
    } finally {
      this.#live.delete(callId)
      await this.#dispose(live).catch(() => undefined)
      done()
    }
  }

  /** Stop one call (its Python side was cancelled). */
  cancel(callId: string): void {
    const live = this.#live.get(callId)
    if (live !== undefined) this.#stop(live)
  }

  /** Stop every child an owner started; returns once they are disposed. */
  async stopOwner(owner: string): Promise<void> {
    const mine = [...this.#live.values()].filter((live) => live.owner === owner)
    for (const live of mine) this.#stop(live)
    await Promise.all(mine.map((live) => live.settled))
  }

  /** Stop every child (kernel replaced, session closed). */
  async stopAll(): Promise<void> {
    const all = [...this.#live.values()]
    for (const live of all) this.#stop(live)
    await Promise.all(all.map((live) => live.settled))
  }

  #stop(live: Live): void {
    if (!live.controller.signal.aborted) live.controller.abort(new Error('repl.agent owner ended'))
    void this.#dispose(live).catch(() => undefined)
  }

  #disposals = new WeakMap<Live, Promise<void>>()

  #dispose(live: Live): Promise<void> {
    const activation = live.activation
    if (activation === undefined) return Promise.resolve()
    let pending = this.#disposals.get(live)
    if (pending === undefined) {
      pending = Promise.resolve().then(() => activation.dispose())
      this.#disposals.set(live, pending)
    }
    return pending
  }

  #stopped(live: Live): Promise<never> {
    const stopped = new Promise<never>((_, reject) => {
      const fail = (): void => {
        const error = new Error('repl.agent was stopped: the cell or background job that started it ended')
        error.name = 'AbortError'
        reject(error)
      }
      if (live.controller.signal.aborted) fail()
      else live.controller.signal.addEventListener('abort', fail, { once: true })
    })
    // Raced, never awaited alone: once the race settles, a later rejection must not go unhandled.
    stopped.catch(() => undefined)
    return stopped
  }

  #throwIfStopped(live: Live): void {
    if (!live.controller.signal.aborted) return
    const error = new Error('repl.agent was stopped: the cell or background job that started it ended')
    error.name = 'AbortError'
    throw error
  }
}
