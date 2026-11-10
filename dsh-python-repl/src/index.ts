/**
 * dsh-python-repl — persistent Python cells for DSH's PTC seam.
 *
 * Registers a `ctx.ptcRuntime` whose language is `python`, so the official
 * `run_code` tool routes model-written cells here instead of the TypeScript
 * worker. Everything outside the kernel — tool permissions, dispatch logging,
 * images, subagents, cancellation — stays with DSH; this plugin is the bridge,
 * not a second agent runtime.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
// Side-effect type imports: they bring in the module augmentation that declares
// `ctx.systemPrompt` and the `system-prompt/assemble` event.
import type {} from '@deepseek-ai/dsh-system-prompt'
import * as dshTools from '@deepseek-ai/dsh-tools'
import { PtcRuntime, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { discoverSkills, findProjectRoot, resolveSkillRoots, withDisabled, withProjectSkills, type SkillDiscovery, type SkillSummary } from './skill-discovery.ts'
import { createHash } from 'node:crypto'
import { ReplSession } from './session.ts'
import { readPanelLifecycle, readPanelSnapshot } from './snapshot.ts'
import { controlRoute, nameRoute, panelRoute, previewRoute, type PanelWebServer } from './panel-route.ts'
import type { PanelControlAction, PanelControlResult, PanelNameAction, PanelNameResult, PanelState } from './panel-types.ts'
import type { BoundTool } from './lease.ts'
import { renderResidentAccess, renderSkillCatalog, rewriteSdkSection, RUN_CODE_EXECUTION_INSTRUCTIONS, renderToolSummaries } from './prompt.ts'
import { renderToolsSdkPy } from '@deepseek-ai/dsh-tool-executor-ptc'
import { TOP_LEVEL, type ToolSchemaLike } from './catalog.ts'
import { applyPresetWorkflowOff } from './preset-workflow.ts'
import { createPresentationGuard } from './presentation-guard.ts'
import { boundCellOutput, type SaveOutput } from './output-budget.ts'
import { sharedPipeline, type PipelineLike } from './background-tools.ts'
import type { SubagentsLike } from './agent-runs.ts'
import { JobNotices, listUnfinished, unfinishedNotice, type HostJobs, type JobsService } from './bash-jobs.ts'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { reminderSummary, reminderText } from '../../tooling/runtime/notice.mjs'

export const name = 'dsh-python-repl'


/** The one method of DSH's `spillStore` service this plugin uses; the package itself is not a dependency. */
interface SpillStoreLike {
  saveText(spill: {
    owner: { sessionId: string }
    source: { kind: 'tool'; toolName: string; callId: string; label: string }
    suggestedName: string
    content: string
  }): Promise<{ locator: unknown; bytes?: number; retrievalHint?: string }>
}

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Tools declared in full by default, chosen from real usage rather than guessed:
 * each was called from its one-line summary with a guessed argument shape —
 * `job_output` without `timeout_ms` (so `wait: true` reads gave up after 30 s and
 * the model fell back to sleep-and-poll), `ask_user_question` with a flat
 * `question`, `read_image` with `image_path`, and likewise `interrupt_agent` and
 * `update_goal`. `job_kill` completes the job lifecycle the first one starts.
 */
const DEFAULT_RESIDENT_TOOLS = ['job_output', 'job_kill', 'ask_user_question', 'read_image', 'web_search', 'present', 'todo_write', 'interrupt_agent', 'update_goal'] as const

/** Minimum interpreter: Prime's own (prime-agent-runtime requires-python >= 3.11). */
const MIN_PYTHON = [3, 11] as const
/** How long assembling the context waits for the post-compaction name list. */
const COMPACTION_NAMES_WAIT_MS = 2_000
/** Names listed after a compaction; the rest are counted and left to repl.list. */
const COMPACTION_NAMES_SHOWN = 200
const COMPACTION_NAMES_BYTES = 4_096

/**
 * The default kernel Python, uv-managed as Prime's kernel is. `dill` 0.4.1
 * cannot serialize functions or classes on 3.15 (no `co_lnotab`), so the
 * default stays on the newest version it fully supports.
 */
const UV_PYTHON = '3.14'

export const Config = Schema.object({
  python: Schema.string()
    .volatile()
    .default(UV_PYTHON)
    .description(
      'Python that session kernels are built from: each kernel runs in a venv made from it, as Prime\'s does. Must be >= 3.11. A version such as `3.14` is a uv-managed Python, installed '
      + 'on first use; like Prime, kernels stay on a version `dill` can snapshot. A bare name is looked up on the host PATH '
      + "(host launch environment fills it from the login shell, so it matches a terminal). A value containing a path is used verbatim "
      + '(`~` expands to the home directory).',
    ),
  maxFrameBytes: Schema.natural()
    .volatile()
    .min(1000)
    .default(64 * 1024 * 1024)
    .description('Maximum bytes in one kernel protocol frame; oversized frames retire that kernel rather than exhaust host memory.'),
  startupTimeoutMs: Schema.natural()
    .volatile()
    .min(1000)
    .default(30_000)
    .description('Host-side ceiling for kernel handshake and complete bootstrap, including skill imports. Expiry kills this kernel; external effects are not rolled back.'),
  teardownGraceMs: Schema.natural()
    .volatile()
    .min(500)
    .default(5_000)
    .description(
      'Host-side ceiling on end-of-cell cleanup. Independent of the kernel timeout, which cannot fire '
      + 'while a cell blocks the event loop; on expiry the kernel process is killed and state loss reported.',
    ),
  interruptGraceMs: Schema.natural()
    .volatile()
    .min(500)
    .default(5_000)
    .description(
      'How long a cancelled cell that has not stopped may keep running once the next cell arrives, before the kernel process is killed. '
      + 'The cancel itself returns after 1 s and leaves the kernel alone, as Prime does. Authority is revoked immediately on abort regardless of this value.',
    ),
  toolCallTimeoutMs: Schema.natural()
    .volatile()
    .default(0)
    .description('Optional bridge reply deadline in ms; 0 uses DSH tool lifetimes, including human waits. Expiry does not stop external work or make retries safe. Applies to new session kernels.'),
  maxCellOutputTokens: Schema.natural()
    .volatile()
    .default(8_000)
    .description(
      'Estimated tokens one cell may print and display before only its start and end are shown; the whole output goes to the DSH spill store '
      + 'and the notice names the file. 0 turns it off. Without a spill store the output is left whole. Applies to new session kernels.',
    ),
  residentTools: Schema.array(Schema.string())
    .volatile()
    .default([...DEFAULT_RESIDENT_TOOLS])
    .description(
      'Non-top-level tools whose FULL contract is declared in the prompt next to the six fixed helpers; '
      + 'every other tool gets a one-line summary. Keep it short and stable: each entry costs prompt '
      + 'tokens on every step, and a change invalidates the cached prompt prefix.',
    ),
  skillRoots: Schema.array(Schema.string())
    .volatile()
    .default([])
    .description(
      'Trusted directories scanned for Python skills, pre-imported into `skills` at kernel start. '
      + 'Relative roots are resolved against the host process cwd captured when this runtime is created, not the session workspace; ~ expands to the home directory. '
       + 'Only list roots you trust: importing a module runs its top-level code. Skills inside the session\'s project come from projectSkillRoots.',
    ),
  skillRenames: Schema.dict(Schema.string())
    .volatile()
    .default({})
    .description('Optional old Python skill names mapped to current import names for missing-name hints. Does not create aliases or load skills. Applies to new session kernels.'),
  archiveAfterCells: Schema.natural()
    .volatile()
    .default(100)
    .description(
      'A user name not used by this many cells in a row is moved out of the kernel into an archive file: it is not snapshotted or restored, '
      + 'and a cell that uses it gets it back automatically. 0 turns archiving off. Names pinned with repl.keep are exempt. Applies to new session kernels.',
    ),
  deleteAfterCells: Schema.natural()
    .volatile()
    .default(200)
    .description(
      'A user name not used by this many cells in a row is deleted, archived or not; only a one-line record stays so a NameError can say so. '
      + '0 turns deletion off. Counted in cells, never in time: an idle session loses nothing. Applies to new session kernels.',
    ),
  cellWaitMs: Schema.natural()
    .volatile()
    .default(5000)
    .description(
      'Longest a cell waits on one bash command or job, in ms. Past it the command keeps running as a DSH background job and the cell moves on; '
      + 'DSH wakes the agent when it finishes. 0 = no cap (bash then waits for its own timeout). Default 5000: 95% of bash calls finish sooner. Applies to new session kernels.',
    ),
  maxCellTimeoutMs: Schema.natural()
    .volatile()
    .min(1000)
    .max(2_147_483_647)
    .default(86_400_000)
    .description(
      'Longest a cell may run, in ms, and its budget when run_code gives no timeoutMs; a smaller timeoutMs the model passes wins. '
      + 'Past it the cell is cancelled like an interrupt: CancelledError in the cell, the kernel and its variables stay, finished effects are not undone or replayed. '
      + 'Counts tool and approval waits. Default one day, so a cell without timeoutMs effectively has no deadline. Read per call.',
    ),
  idleKernelMinutes: Schema.natural()
    .volatile()
    .default(60)
    .description(
      'Stop a session kernel idle this many minutes to free memory; the next cell starts a new one with the snapshot restored. '
      + 'Never while anything still runs inside it (tasks, threads, child processes) or when its snapshot could not hold every name. 0 = never.',
    ),
  projectSkillRoots: Schema.array(Schema.string())
    .volatile()
    .default(['.agents/skills'])
    .description(
      'Directories inside the session\'s project (the nearest ancestor holding .git, else the session cwd) also scanned for Python skills, '
      + 'the same rule Prime and the host skill list use for `.agents/skills`. A project skill wins over a configured one of the same name. '
      + 'Importing runs the module\'s top-level code, so every repository you open is trusted like skillRoots; set [] to scan only skillRoots.',
    ),
})

/**
 * Deref volatile cells (loader-patched live config) into a plain snapshot.
 * Every field is volatile: edits apply to NEW session kernels without a
 * plugin restart — existing kernels keep their interpreter and variables,
 * and are never restarted on a form edit.
 */
export function resolveConfig(config: Config): {
  [K in keyof Config]: Config[K] extends { get(): infer V } ? V : Config[K]
} {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    out[key] =
      value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
        ? (value as { get(): unknown }).get()
        : value
  }
  return out as never
}

type ResolvedConfig = ReturnType<typeof resolveConfig>

export type Config = ReturnType<typeof Config>

/** The service other plugins read this runtime's Python skills from. */
export const PYTHON_SKILLS_SERVICE = 'pythonSkills'

export interface PythonSkillsService {
  /** Skills under the configured roots plus, given a cwd, that project's roots; no workspace switches applied. */
  list(cwd?: string): SkillSummary[]
}

/**
 * The Python code runtime.
 *
 * One kernel per session key. Keyed by the caller's identity rather than a
 * process-wide singleton: two sessions must not share a heap.
 */
const IDLE_SWEEP_MS = 5 * 60_000
const UNFINISHED_SHOWN = 10

export class PythonReplRuntime extends PtcRuntime {
  readonly language = 'python'
  // 0.2.2-rc.1 起 run_code 的说明由官方执行器拼：通用一句 + 这一段；改不了工具数组。
  override get executionInstructions(): string { return RUN_CODE_EXECUTION_INSTRUCTIONS }
  /** Per-cell budgets: run_code then accepts timeoutMs (dsh-tool-executor-ptc); expiry cancels the cell. */
  override get timeout(): { defaultMs: number; maxMs: number } {
    const max = this.config.maxCellTimeoutMs
    return { defaultMs: max, maxMs: max }
  }
  readonly isolation = 'process'

  // NOTE: no `#private` fields on this class. cordis hands consumers a Proxy
  // around the service, and a private-brand check on a proxied receiver throws
  // "Receiver must be an instance of class". The shipped worker-thread backend
  // uses plain fields for the same reason.
  readonly sessions = new Map<string, ReplSession>()
  /** Closed sessions whose kernel could not be confirmed stopped; the next disposeAll retries them. */
  private readonly unclosed = new Set<ReplSession>()
  /** Interpreter per configured value: the probes run once, not per session. */
  private readonly interpreters = new Map<string, Promise<ResolvedInterpreter>>()
  private readonly rawConfig: Config
  private readonly skillRootBase = process.cwd()
  private readonly discoveries = new Map<string, SkillDiscovery>()
  private readonly sessionDiscoveries = new Map<string, SkillDiscovery>()
  /** One notice for background jobs a cell left running that end close together (src/bash-jobs.ts). */
  readonly jobNotices: JobNotices

  /** Plain snapshot of the (possibly volatile-cell) config, resolved per read. */
  get config(): ResolvedConfig { return resolveConfig(this.rawConfig) }

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.rawConfig = config
    this.jobNotices = new JobNotices(() => ctx.get('jobs' as never) as JobsService | undefined, {
      deliver: (owner, text, summary, extras) => {
        const agent = (ctx.get('agents') as { get?(id: string): { status?: string; followup(m: unknown): void; inject(m: unknown): void } | undefined } | undefined)?.get?.(owner)
        if (agent === undefined) return
        const contextBlocks = (extras?.contexts ?? []).flatMap((context) => {
          if (Array.isArray(context)) return context
          if (context !== null && typeof context === 'object') {
            const content = (context as { content?: unknown }).content
            if (Array.isArray(content)) return content
            if (typeof (context as { type?: unknown }).type === 'string') return [context]
          }
          return []
        })
        const content = [{ type: 'text', text: reminderText('dsh-python-repl', summary, text) }, ...(extras?.images ?? []), ...contextBlocks]
        const message = createUserMessage({ content, source: { kind: 'python-repl-jobs', form: 'notice', summary: reminderSummary('dsh-python-repl', summary) } } as never)
        // As DSH's tool-jobs does by default: wake an idle agent, else queue for its next step.
        if (agent.status === 'idle' && extras?.quiet !== true) agent.followup(message)
        else agent.inject(message)
      },
    })
    // Returned, not voided: the host waits for the final snapshots and kernel exits.
    ctx.effect(() => () => this.disposeAll().catch((error: unknown) => this.reportCloseFailure(error)), 'python-repl teardown')
    ctx.on('agent/disposed', ({ agent }) => void this.releaseIfUnused(agent))
    // Idle kernels are stopped to free memory (ReplSession.reclaimIfIdle); a sweep every few minutes is cheap.
    ctx.effect(() => {
      const timer = setInterval(() => void this.reclaimIdle(), IDLE_SWEEP_MS)
      timer.unref?.()
      return () => clearInterval(timer)
    }, 'python-repl idle kernel sweep')
    ctx.on('session/event' as never, ((session: { id?: unknown } | undefined, event: { type?: unknown } | undefined) => {
      if (event?.type === 'compaction/end' && typeof session?.id === 'string') {
        const repl = this.sessions.get(session.id)
        repl?.noteCompaction()
        if (repl !== undefined) repl.unfinishedAtCompaction = this.unfinishedWork(repl)
      }
    }) as never, { global: true })
    ctx.inject(['tools' as never], (scoped) => {
      this.toolsContext = scoped
      scoped.effect(() => () => { if (this.toolsContext === scoped) this.toolsContext = undefined }, 'python-repl tool pipeline context')
    })
    // skill settings provider lists these on its settings page instead of scanning again.
    ctx.provide(PYTHON_SKILLS_SERVICE, { list: (cwd?: string) => this.discoveryAt(cwd).skills } satisfies PythonSkillsService)
  }

  /**
   * The interpreter a new kernel should use: the kernel venv built from the
   * configured Python.
   *
   * Cached per configured value, so a settings change re-probes and an
   * unchanged one costs nothing. The promise is cached so sessions starting
   * together share one venv build; a failure is dropped so the next cell retries.
   *
   * @internal
   */
  interpreterFor(configured: string): Promise<ResolvedInterpreter> {
    const cached = this.interpreters.get(configured)
    if (cached !== undefined) return cached
    const pending = (async () => {
      const base = await resolvePythonInterpreter(configured)
      const venv = await kernelEnvironment(base, pluginState('kernel-venv', base.version.split('.').slice(0, 2).join('.')))
      this.ctx.logger?.('python-repl')?.info?.(`python-repl: using Python ${venv.version} (${venv.python}, built from ${base.python})`)
      return venv
    })()
    this.interpreters.set(configured, pending)
    pending.catch(() => this.interpreters.delete(configured))
    return pending
  }

  /**
   * End a session's kernel once no live agent maps to its key any more.
   *
   * Without this every session that ever ran a cell kept its Python process —
   * and all the data in it — until the plugin unloaded. A parent and its fork
   * share one key, so one agent leaving is not enough.
   *
   * @internal
   */
  async releaseIfUnused(agent: unknown): Promise<void> {
    const key = sessionKeyOf(agent)
    if (key === undefined || !this.sessions.has(key)) return
    let live: unknown[]
    try {
      live = this.ctx.get('agents')?.list() ?? []
    } catch {
      // Without a readable registry we cannot prove the session is unused;
      // keeping a kernel alive is recoverable, killing a used one is not.
      return
    }
    if (live.some((other) => sessionKeyOf(other) === key)) return
    const session = this.sessions.get(key)
    this.sessions.delete(key)
    if (session === undefined) return
    try {
      await session.dispose()
    } catch (error) {
      // Callers do not await this; keep the session so a later close retries it.
      this.unclosed.add(session)
      this.reportCloseFailure(error)
    }
  }

  private reportCloseFailure(error: unknown): void {
    this.ctx.logger?.('python-repl').warn?.(`python-repl: ${error instanceof Error ? error.message : String(error)}`)
  }

  /**
   * Validate the per-call choices this backend supports and fix the rest.
   *
   * A numeric `timeoutMs` is capped at maxCellTimeoutMs, an absent one gets
   * it, and `null` (asked for by workflow adapters) means no deadline. No
   * confinement: `sandboxMode` stays undefined, so dsh-tools never OFFERS
   * `sandbox_permissions`, and an explicit policy arriving anyway is contract
   * misuse and rejects, per the Service Definition. `cwd` defaults to the
   * session workspace (the host already passes `session.header.cwd`).
   */
  resolve(request: PtcRunRequest): PtcRunSpec {
    const max = this.config.maxCellTimeoutMs
    if (typeof request.timeoutMs === 'number' && !(Number.isFinite(request.timeoutMs) && request.timeoutMs > 0)) {
      throw new Error(`dsh-python-repl: invalid timeoutMs ${String(request.timeoutMs)}; expected a positive number of milliseconds.`)
    }
    const timeoutMs = request.timeoutMs === null ? null : Math.min(Math.ceil(request.timeoutMs ?? max), max)
    if (request.sandboxPolicy !== undefined) {
      throw new Error('dsh-python-repl: no confinement support; an explicit sandboxPolicy is rejected rather than silently ignored.')
    }
    return {
      ...request,
      cwd: request.cwd ?? this.workspaceCwd(),
      timeoutMs,
    }
  }

  /**
   * Execute one cell.
   *
   * `PtcRunSpec` carries no agent field, so session identity comes from
   * the host's initiator boundary: the agent loop wraps its dispatch in
   * `withInitiator`, and `currentInitiator()` is read here, before the first
   * await. Each session gets its own kernel; two sessions never share a heap.
   *
   * Fails closed when no identity is available — an agentless call must not
   * silently land in a shared kernel with someone else's variables.
   */
  async run(spec: PtcRunSpec): Promise<PtcRunResult> {
    const identity = this.resolveIdentity()
    const host = this.hostJobs()
    const cwd = this.currentCwd() ?? spec.cwd
    if (identity.kind === 'denied') {
      return {
        logs: [],
        error: { kind: 'exception', message: identity.message },
      }
    }
    let session = this.sessions.get(identity.key)
    if (session === undefined) {
      try {
        const interpreter = await this.interpreterFor(this.config.python)
        session = this.sessionFor(identity.key, cwd, interpreter.python)
      } catch (error) {
        // No interpreter satisfies the floor: fail this cell with the remedy
        // instead of starting a kernel that cannot clean up after itself.
        return {
          logs: [],
          error: { kind: 'exception', message: error instanceof Error ? error.message : String(error) },
        }
      }
    }
    const tools = collectBindings(spec)
    const budget = cellBudget(spec.signal, spec.timeoutMs)
    let result: Awaited<ReturnType<ReplSession['runCell']>>
    try {
      result = await session.runCell(
        spec.program,
        tools,
        budget.signal,
        this.visibleSchemas(this.ctx.get('agents')?.currentInitiator()),
        cwd,
        host,
      )
    } finally {
      budget.dispose()
    }
    const logs = [...result.logs]
    if (result.error === undefined) return { logs }
    if (result.error.kind === 'abort' && budget.expired && !(spec.signal?.aborted ?? false)) {
      return { logs, error: { kind: 'timeout', message: timeoutMessage(spec.timeoutMs as number, result.error.message) } }
    }
    return {
      logs,
      error: {
        kind: result.error.kind === 'abort' ? 'abort' : result.error.kind === 'worker-exit' ? 'worker-exit' : 'exception',
        message: result.error.message,
      },
    }
  }

  /**
   * Resolve which kernel this call belongs to.
   *
   * Keyed by session id when the agent exposes one (a fork/subagent on the
   * same session shares the namespace, matching how the user thinks about
   * "this conversation"), else by agent id. Never falls back to a shared
   * default: that fallback IS the cross-session leak.
   *
   * @internal
   */
  resolveIdentity(): { kind: 'ok'; key: string } | { kind: 'denied'; message: string } {
    const registry = this.ctx.get('agents')
    if (registry === undefined) {
      return {
        kind: 'denied',
        message:
          'dsh-python-repl: no agent registry is loaded, so this call cannot be attributed to a session. ' +
          'Refusing to run rather than sharing one kernel across callers.',
      }
    }
    let agent: { id?: string; sessionId?: string } | undefined
    try {
      agent = registry.currentInitiator() as { id?: string; sessionId?: string } | undefined
    } catch (error) {
      return {
        kind: 'denied',
        message: `dsh-python-repl: agent registry rejected the identity lookup: ${
          error instanceof Error ? error.message : String(error)
        }`,
      }
    }
    if (agent === undefined) {
      return {
        kind: 'denied',
        message:
          'dsh-python-repl: no initiating agent for this run_code call. A persistent kernel holds one ' +
          "session's variables, so an unattributed call is refused instead of joining a shared namespace.",
      }
    }
    const key = sessionKeyOf(agent)
    if (key === undefined) {
      return {
        kind: 'denied',
        message: 'dsh-python-repl: the initiating agent exposes no usable session or agent id.',
      }
    }
    return { kind: 'ok', key }
  }

  /** Static configured catalog; a session's import outcome never changes its system prefix. */
  knownSkills(sessionKey?: string, cwd?: string): SkillSummary[] {
    if (sessionKey === undefined) return []
    return this.discoveryFor(sessionKey, cwd).skills
  }

  private discoveryFor(key: string, cwd?: string): SkillDiscovery {
    return this.sessionDiscoveries.get(key) ?? withDisabled(this.discoveryAt(cwd), this.disabledSkills(cwd))
  }

  /** Configured skills, with the skills of the project holding `cwd` in front. */
  private discoveryAt(cwd?: string): SkillDiscovery {
    const configured = this.configuredDiscovery()
    if (cwd === undefined || cwd === '') return configured
    const real = (path: string) => { try { return realpathSync(path) } catch { return path } }
    const trusted = new Set(configured.roots.map(real))
    const project = findProjectRoot(cwd)
    // A project without the directory is the normal case, not a discovery issue. A home
    // directory without .git is its own project, and its `.agents/skills` is the configured root.
    const roots = this.config.projectSkillRoots.map((root) => join(project, root))
      .filter((root) => { try { return statSync(root).isDirectory() && !trusted.has(real(root)) } catch { return false } })
    const cacheKey = `project:${JSON.stringify(roots)}`
    let discovery = this.discoveries.get(cacheKey)
    if (discovery === undefined) {
      discovery = discoverSkills(roots)
      this.discoveries.set(cacheKey, discovery)
    }
    return withProjectSkills(configured, discovery)
  }

  /** Every skill under the configured roots, before any workspace switches one off. */
  private configuredDiscovery(): SkillDiscovery {
    const roots = resolveSkillRoots(this.config.skillRoots, this.skillRootBase)
    const cacheKey = JSON.stringify(roots)
    let discovery = this.discoveries.get(cacheKey)
    if (discovery === undefined) {
      discovery = discoverSkills(roots)
      this.discoveries.set(cacheKey, discovery)
    }
    return discovery
  }

  /**
   * Skills the user switched off for this workspace (skill settings provider). Read
   * live and optional: without that plugin, or when it fails, nothing is off.
   */
  private disabledSkills(cwd: string | undefined): string[] {
    const exposure = this.ctx.get('skillExposure' as never) as { disabledPySkills?(cwd: string | undefined): string[] } | undefined
    try {
      const names = exposure?.disabledPySkills?.(cwd)
      return Array.isArray(names) ? names.filter((n): n is string => typeof n === 'string') : []
    } catch (error) {
      this.ctx.logger?.('dsh-python-repl')?.warn?.(`skill exposure lookup failed, importing every skill: ${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  /** Public assembly context: facts about this session only, never a claim that data was recovered. */
  async stateContext(key?: string, cwd?: string): Promise<string> {
    if (key === undefined) return ''
    const session = this.sessions.get(key)
    const discovery = this.discoveryFor(key, cwd)
    const saved = existsSync(join(statePath(key), 'kernel-state.dill'))
    const state = session?.started && session.kernelAlive ? `running (epoch ${session.epoch})`
      : session?.epoch ? `not running (last epoch ${session.epoch})`
        : 'not started in this process'
    const parts = [`Python kernel for this session: ${state}. Variables are saved shortly after each successful cell and restored when a new kernel starts; the first cell on a new kernel reports what came back.`,
      `Trusted Python skillRoots resolved: ${JSON.stringify(discovery.roots)}. Relative configured roots are resolved against the host configuration base ${JSON.stringify(this.skillRootBase)}, not the session workspace. Static discovery does not execute modules or prove availability.`]
    if (JSON.stringify(discovery.roots) !== JSON.stringify(resolveSkillRoots(this.config.skillRoots, this.skillRootBase))) {
      parts.push('Configuration changed: this existing session retains its startup roots; new sessions use the current configuration.')
    }
    if (discovery.projectRoots?.length) parts.push(`Project Python skill roots for this session's repository: ${JSON.stringify(discovery.projectRoots)}; a project skill wins over a configured one of the same name.`)
    if (discovery.issues.length) parts.push(`Discovery issues: ${discovery.issues.join('; ')}`)
    if (discovery.disabled?.length) parts.push(`Python skills switched off by the user for this workspace (not imported, not an error): ${JSON.stringify(discovery.disabled)}.`)
    const unterminated = session?.unterminatedPids ?? []
    if (unterminated.length) parts.push(`Earlier kernel processes not confirmed stopped (pids ${unterminated.join(', ')}); they may still use memory or CPU and are never reused. Closing the session retries stopping them.`)
    // Presence only: details change after almost every cell, and the host
    // appends a fresh runtime-context snapshot whenever this text changes.
    if (saved) parts.push('A saved Python state exists for this session; it is restored when a new kernel starts.')
    // Changes only at a compaction, so it adds one snapshot then, not one per cell.
    const compacted = await session?.compactionNames(COMPACTION_NAMES_WAIT_MS)
    if (compacted !== undefined && session?.kernelAlive && compacted.epoch === session.epoch) {
      const prefix = 'At the last context compaction this kernel held these names; they are still there unless a later cell removed them, so reuse them instead of reading or fetching their data again: '
      const shown: string[] = []
      const notice = (names: string[]): string => {
        const more = compacted.names.length - names.length
        return `${prefix}${names.join(', ')}${more > 0 ? ` … and ${more} more (await repl.list())` : ''}.`
      }
      for (const name of compacted.names.slice(0, COMPACTION_NAMES_SHOWN)) {
        const candidate = [...shown, name]
        if (Buffer.byteLength(notice(candidate), 'utf8') > COMPACTION_NAMES_BYTES) break
        shown.push(name)
      }
      parts.push(compacted.names.length === 0
        ? 'At the last context compaction this kernel held no variables of yours.'
        : notice(shown))
    }
    const unfinished = session?.unfinishedAtCompaction
    if (unfinished !== undefined) parts.push(unfinishedNotice(unfinished))
    if (session?.started && session.kernelAlive && session.skillReport) {
      const report = session.skillReport
      parts.push(`Skill imports in this kernel: ${JSON.stringify(report.loaded)}.`)
      if (report.failed.length) parts.push(`Skill import failures: ${report.failed.map(s => `${s.skill}: ${s.reason}`).join('; ')}. Use skills.describe for details; fixing a dependency requires explicit repl.install and repl.restart.`)
    } else {
      parts.push('No current kernel import/restore result is available. Do not assume old variables exist; inspect the next startup result.')
    }
    return parts.join('\n')
  }

  /**
   * Tool schemas for the catalog. Read from the live registry so descriptions
   * and parameter shapes come from one source, not a second hand-written list.
   *
   * @internal
   */
  visibleSchemas(scope?: unknown, toolSet?: unknown): ToolSchemaLike[] {
    const registry = this.ctx.get('tools') as { definitions?: (scope?: unknown, toolSet?: unknown) => unknown } | undefined
    try {
      // Pass the CALLING agent as the viewing scope. Omitting it yields the
      // global view, where scope-registered core tools (bash/read/write/edit/
      // glob/grep/present/subagent/...) appear as bare names with no
      // description and no parameters — so `tools.describe("bash")` returned
      // nothing useful, which is exactly the case disclosure exists to serve.
      // Verified in a live session 2026-09-22.
      // As the PTC executor's renderSdk does: project the visible definitions, then add output types.
      const project = (dshTools as unknown as Record<string, unknown>)['projectToolSchema'] as ((definition: unknown, withCallbacks: boolean) => object) | undefined
      const definitions = registry?.definitions?.(scope, toolSet)
      if (Array.isArray(definitions) && typeof project === 'function') {
        return definitions.map((definition) => ({ ...project(definition, false), output: (definition as { output?: { schema?: unknown } }).output?.schema }) as ToolSchemaLike)
      }
    } catch {
      // A registry that refuses introspection is not fatal: the catalog falls
      // back to bare names from the bindings, which are always accurate.
    }
    return []
  }

  /**
   * Where the calling session is now (DSH 0.2.1 `workingDirectory`): a session
   * can cd mid-conversation, and `bash` and the file tools follow it.
   * Undefined on hosts without the service or outside an initiator.
   *
   * @internal
   */
  currentCwd(): string | undefined {
    try {
      const service = this.ctx.get('workingDirectory' as never) as { get?(session: unknown): unknown } | undefined
      const session = (this.ctx.get('agents')?.currentInitiator() as { session?: unknown } | undefined)?.session
      if (service?.get === undefined || session === undefined) return undefined
      const cwd = service.get(session)
      return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
    } catch {
      return undefined
    }
  }

  /**
   * The session's workspace directory — what `bash` and the file tools use.
   *
   * Read from the initiating agent's validated session metadata. Falls back to
   * the host process's cwd only when no agent is in scope, which for a real
   * call cannot happen: `run` rejects unattributable callers before it gets
   * here.
   *
   * @internal
   */
  workspaceCwd(): string {
    try {
      const agent = this.ctx.get('agents')?.currentInitiator() as
        | { meta?: { cwd?: string } }
        | undefined
      const cwd = agent?.meta?.cwd
      if (typeof cwd === 'string' && cwd.length > 0) return cwd
    } catch {
      // Identity lookup is best-effort here; the fallback below is safe.
    }
    return process.cwd()
  }

  /**
   * Saves one cell's whole output in DSH's spill store, owned by this session;
   * undefined when no store is mounted, so the output then stays whole.
   *
   * @internal
   */
  spillSaver(key: string, runId: string): SaveOutput | undefined {
    const store = (this.ctx as unknown as { get(name: string): unknown }).get('spillStore') as SpillStoreLike | undefined
    if (store === undefined || typeof store.saveText !== 'function') return undefined
    return async (content) => {
      const ref = await store.saveText({
        owner: { sessionId: key },
        source: { kind: 'tool', toolName: 'run_code', callId: runId, label: 'cell output' },
        suggestedName: 'run_code-cell.txt',
        content,
      })
      return { locator: String(ref.locator), retrievalHint: ref.retrievalHint }
    }
  }

  /** Read an existing session or its persisted snapshot, without creating runtime state. */
  async panelState(key: string): Promise<PanelState> {
    const [snapshot, lifecycle] = await Promise.all([readPanelSnapshot(statePath(key)), readPanelLifecycle(statePath(key))])
    const session = this.sessions.get(key)
    const observation = session === undefined ? {
      alive: false, started: false, busy: false, epoch: 0, python: null, executable: null, cwd: null,
      skillReport: null, observedAt: null, namespaceStatus: 'unavailable' as const,
      namespaceReason: 'not-started' as const, complete: false,
      scope: 'top-level-excluding-dunder' as const, total: null, names: [],
    } : await session.panelObservation()
    const history = session?.cellLog.view() ?? { recordedSince: null, cells: [], cellsDropped: 0, generations: [] }
    return { session: key, now: Date.now(), ...observation, ...history, snapshot, lifecycle }
  }

  /**
   * A click in the kernel tab. After a DSH restart the session has no kernel
   * yet, so start/restart/reset build one in the session's own working
   * directory, read from DSH; an unknown session is refused, never guessed.
   */
  /** Pin, unpin, bring back or archive a name; only a session whose kernel runs in this DSH process. */
  async panelNameAction(key: string, action: PanelNameAction, name: string): Promise<PanelNameResult> {
    const session = this.sessions.get(key)
    if (session === undefined) return { action, name, ok: false, reason: '内核没有在运行，先启动内核' }
    return session.panelNameAction(action, name)
  }

  async panelControl(key: string, action: PanelControlAction): Promise<PanelControlResult> {
    let session = this.sessions.get(key)
    if (session === undefined) {
      if (action === 'stop') return { action, ok: true, epoch: 0, reason: '内核没有在运行' }
      const cwd = this.sessionCwd(key)
      if (cwd === undefined) return { action, ok: false, epoch: 0, reason: '在 DSH 里找不到这个会话，无法确定内核的工作目录' }
      try {
        const interpreter = await this.interpreterFor(this.config.python)
        session = this.sessionFor(key, cwd, interpreter.python)
      } catch (error) {
        return { action, ok: false, epoch: 0, reason: error instanceof Error ? error.message : String(error) }
      }
    }
    return session.panelControl(action)
  }

  /** The live session's current directory, the one `bash` uses; undefined when DSH does not hold it. */
  sessionCwd(key: string): string | undefined {
    try {
      const live = (this.ctx.get('sessions' as never) as { get?(id: string): unknown } | undefined)?.get?.(key)
      if (live === undefined || live === null) return undefined
      const service = this.ctx.get('workingDirectory' as never) as { get?(session: unknown): unknown } | undefined
      const cwd = service?.get?.(live) ?? (live as { header?: { cwd?: unknown } }).header?.cwd
      return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
    } catch {
      return undefined
    }
  }

  async panelPreview(key: string, name: string, epoch: number): Promise<import('./panel-types.ts').PanelPreview> {
    const session = this.sessions.get(key)
    if (session === undefined) return { session: key, name, epoch, status: 'not-started', reason: '内核尚未启动' }
    return { session: key, ...await session.panelPreview(name, epoch) }
  }

  /** @internal */
  sessionFor(key: string, runCwd?: string, python: string = this.config.python): ReplSession {
    const existing = this.sessions.get(key)
    if (existing !== undefined) return existing
    const config = this.config
    const discovery = this.discoveryFor(key, runCwd ?? this.workspaceCwd())
    this.sessionDiscoveries.set(key, discovery)
    const session = new ReplSession({
      python,
      sessionId: key,
      vendorRoot: join(packageRoot, 'vendor', 'prime'),
      pythonRoot: join(packageRoot, 'python'),
      // The kernel runs in the SESSION's workspace, the same directory `bash`
      // and the file tools use, so `open("out.csv")` in a cell and `> out.csv`
      // in a shell land in the same place.
      //
      // `process.cwd()` is only a fallback: under the GUI it is the host
      // process's directory (observed: `$HOME`), which is neither the
      // workspace nor anywhere a cell should write by default. And it must
      // never fall back into `vendor/` — that tree is byte-for-byte upstream
      // and a relative write would corrupt it (observed 2026-09-22).
      // Prefer the run's resolved cwd (the host passes session.header.cwd);
      // fall back to the initiator's metadata for direct callers.
      cwd: runCwd ?? this.workspaceCwd(),
      skills: discovery.skills,
      skillRenames: config.skillRenames,
      disabledSkills: discovery.disabled ?? [],
      statePath: statePath(key),
      archiveAfterCells: config.archiveAfterCells,
      deleteAfterCells: config.deleteAfterCells,
      cellWaitMs: config.cellWaitMs,
      startupTimeoutMs: config.startupTimeoutMs,
      maxFrameBytes: config.maxFrameBytes,
      teardownGraceMs: config.teardownGraceMs,
      interruptGraceMs: config.interruptGraceMs,
      toolCallTimeoutMs: config.toolCallTimeoutMs,
      boundOutput: (logs, runId) => boundCellOutput(logs, config.maxCellOutputTokens, this.spillSaver(key, runId)),
      backgroundPipeline: () => this.toolPipeline(),
      subagents: () => this.ctx.get('subagents' as never) as SubagentsLike | undefined,
    })
    this.sessions.set(key, session)
    return session
  }

  /** A context that declared `tools`, which the pipeline reads; set while the tool registry is loaded. */
  private toolsContext: Context | undefined
  private pipeline: { ctx: Context; pending: Promise<PipelineLike | undefined> } | undefined

  /** DSH's public tool pipeline, one per tool registry; undefined without a registry (src/background-tools.ts). */
  toolPipeline(): Promise<PipelineLike | undefined> {
    const ctx = this.toolsContext
    if (ctx === undefined) return Promise.resolve(undefined)
    if (this.pipeline?.ctx !== ctx) {
      const pending = sharedPipeline(ctx, (error) => this.ctx.logger('python-repl').warn(`python-repl: ${error instanceof Error ? error.message : String(error)}`))
      this.pipeline = { ctx, pending }
    }
    return this.pipeline.pending
  }

  /** DSH's job service and the calling agent, read before the first await like the session identity; undefined runs bash as before. */
  private hostJobs(): HostJobs | undefined {
    const jobs = this.ctx.get('jobs' as never) as JobsService | undefined
    let agent: { id?: unknown } | undefined
    try {
      agent = this.ctx.get('agents')?.currentInitiator() as { id?: unknown } | undefined
    } catch {
      return undefined
    }
    const owner = agent?.id
    return jobs === undefined || typeof owner !== 'string' ? undefined : { jobs, owner, notices: this.jobNotices, agent }
  }

  /**
   * Background jobs and subagents still running, recorded at a compaction:
   * the summary keeps only a generic "pending jobs" line, so the model loses
   * the ids it would await or message. Goals are not listed: DSH sends the
   * objective again every goal round.
   */
  unfinishedWork(session: ReplSession): ReplSession['unfinishedAtCompaction'] {
    return listUnfinished(this.ctx.get('jobs' as never), this.ctx.get('agents') as never, session.jobOwner, session.subagentsStarted, UNFINISHED_SHOWN)
  }

  /** Stop kernels idle past idleKernelMinutes; one at a time, failures only logged. */
  async reclaimIdle(): Promise<void> {
    const minutes = this.config.idleKernelMinutes
    if (!(minutes > 0)) return
    for (const [key, session] of [...this.sessions]) {
      try {
        const kept = await session.reclaimIfIdle(minutes * 60_000)
        if (kept === undefined) this.ctx.logger.info(`python-repl: stopped idle kernel of ${key}`)
      } catch (error) {
        this.ctx.logger.warn(`python-repl: idle check for ${key} failed: ${String(error)}`)
      }
    }
  }

  /** @internal */
  async disposeAll(): Promise<void> {
    this.jobNotices.dispose()
    const sessions = [...this.sessions.values(), ...this.unclosed]
    this.sessions.clear()
    this.unclosed.clear()
    const results = await Promise.allSettled(sessions.map((s) => s.dispose()))
    const failed = results.flatMap((result, index) => result.status === 'rejected' ? [{ session: sessions[index]!, error: result.reason as unknown }] : [])
    for (const { session } of failed) this.unclosed.add(session)
    if (failed.length > 0) throw new AggregateError(failed.map((f) => f.error), 'dsh-python-repl: some kernels could not be confirmed stopped; disposeAll() again retries them')
  }
}

/** This plugin's state under DSH_HOME, never the source tree. */
function pluginState(...parts: string[]): string {
  return join(process.env['DSH_HOME'] || join(homedir(), '.dsh'), 'plugins', 'python-repl', ...parts)
}

/**
 * Where a session's namespace snapshot lives: one directory per kernel key.
 * The key is hashed because it is a host id, not a file name the host promises
 * to keep path-safe.
 */
function statePath(key: string): string {
  return pluginState('state', createHash('sha256').update(key).digest('hex').slice(0, 32))
}

/** The session workspace of an agent, for per-project skill exposure; undefined when not exposed. */
function scopeCwd(agent: unknown): string | undefined {
  const cwd = (agent as { session?: { header?: { cwd?: unknown } } } | undefined)?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/** The kernel key for an agent: its session id when it has one, else its own id. */
function sessionKeyOf(agent: unknown): string | undefined {
  if (agent === null || typeof agent !== 'object') return undefined
  const { sessionId, id } = agent as { sessionId?: unknown; id?: unknown }
  const key = sessionId ?? id
  return typeof key === 'string' && key.length > 0 ? key : undefined
}

/**
 * Flatten PTC's binding namespaces into the tool map a cell may call.
 *
 * These are the EXACT functions PTC created for this call — they already carry
 * the agent, parent token and abort signal. We never re-dispatch through a
 * separate path, which is what keeps permissions and logging intact.
 */
export function collectBindings(request: PtcRunRequest): Map<string, BoundTool> {
  const tools = new Map<string, BoundTool>()
  for (const namespace of request.bindings) {
    for (const [toolName, fn] of Object.entries(namespace.functions)) {
      tools.set(toolName, fn as BoundTool)
    }
  }
  return tools
}

/**
 * Expand a leading `~` and nothing else: `/a/~/b` and `~other/x` are left
 * alone, so a typo never silently turns into a path under the home directory.
 */
export function expandHome(value: string, home: string = homedir()): string {
  if (value === '~') return home
  if (value.startsWith('~/')) return join(home, value.slice(2))
  return value
}

/**
 * The command to run for the configured value. A value containing a path
 * separator is an explicit choice, used verbatim after `~` expansion; a bare
 * name is looked up on the host's PATH. Nothing is ever substituted, so a pin
 * that broke fails loudly instead of quietly running a different Python.
 */
export function pythonCommand(configured: string, home: string = homedir()): string {
  return expandHome(configured.trim(), home) || 'python3'
}

/** Run one interpreter and report its version, or why it cannot be used. */
/**
 * The cell's cancellation: the caller's, or the deadline when `timeoutMs` is
 * a number. Expiry takes the cancel path (authority revoked, CancelledError
 * in Python, kernel and variables kept); only the reported kind differs.
 */
export function cellBudget(signal: AbortSignal | undefined, timeoutMs: number | null | undefined): { signal: AbortSignal | undefined; readonly expired: boolean; dispose(): void } {
  if (typeof timeoutMs !== 'number') return { signal, expired: false, dispose: () => undefined }
  const controller = new AbortController()
  const state = { expired: false }
  const onAbort = (): void => controller.abort(signal?.reason)
  if (signal?.aborted) controller.abort(signal.reason)
  else signal?.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => {
    state.expired = true
    controller.abort(new Error(`cell exceeded its ${timeoutMs} ms budget`))
  }, timeoutMs)
  timer.unref?.()
  return {
    signal: controller.signal,
    get expired() { return state.expired },
    dispose: () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort) },
  }
}

function timeoutMessage(timeoutMs: number, cancelled: string): string {
  const rest = cancelled.replace(/^cell was cancelled(?: before it started)?;?\s*/, '')
  return `cell ran past its ${timeoutMs} ms budget (timeoutMs) and was cancelled, as if interrupted: the kernel and its variables are kept, `
    + 'and what the cell already did (tool calls, files, processes) is not undone or retried.'
    + (rest === '' ? '' : `\n${rest}`)
}

export async function probeInterpreter(python: string, options: { timeoutMs?: number } = {}): Promise<{ version: string }> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const probe =
    'import sys, json; print(json.dumps({"v": list(sys.version_info[:3])}))'
  let parsed: { v: number[] }
  let probePid: number | undefined
  try {
    const timeout = options.timeoutMs ?? 5_000
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('probe timeoutMs must be a positive integer')
    const pending = run(python, ['-c', probe], { timeout, killSignal: 'SIGKILL' })
    probePid = pending.child.pid
    const { stdout } = await pending
    parsed = JSON.parse(stdout) as { v: number[] }
  } catch (error) {
    throw new Error(
      `dsh-python-repl: cannot run the configured interpreter ${JSON.stringify(python)}${probePid === undefined ? '' : ` (probe pid: ${probePid})`}: ${
        error instanceof Error ? `${error.message}${(error as NodeJS.ErrnoException & { signal?: string }).signal ? ` (signal: ${(error as { signal?: string }).signal})` : ''}` : String(error)
      }`,
    )
  }
  const [major = 0, minor = 0, patch = 0] = parsed.v
  const version = `${major}.${minor}.${patch}`
  if (major < MIN_PYTHON[0] || (major === MIN_PYTHON[0] && minor < MIN_PYTHON[1])) {
    throw new Error(`dsh-python-repl: Python ${MIN_PYTHON[0]}.${MIN_PYTHON[1]}+ required, found ${version}.`)
  }
  return { version }
}

/** The interpreter picked for new kernels. */
export interface ResolvedInterpreter {
  python: string
  version: string
}

/**
 * Check the configured interpreter for new kernels.
 *
 * When it does not qualify the error carries what was run and the remedy: it
 * is the only thing the user sees when a kernel cannot start.
 */
export async function resolvePythonInterpreter(
  configured: string,
  probe: (candidate: string) => Promise<{ version: string }> = probeInterpreter,
  managed: (version: string) => Promise<string> = uvPython,
): Promise<ResolvedInterpreter> {
  const version = /^3\.\d+$/.test(configured.trim()) ? configured.trim() : undefined
  let python = pythonCommand(configured)
  try {
    if (version !== undefined) python = await managed(version)
    return { python, version: (await probe(python)).version }
  } catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).replace(/^dsh-python-repl: /, '')
    const bare = !python.includes('/')
    throw new Error(
      `dsh-python-repl: 没找到能用的 Python，需要 ${MIN_PYTHON[0]}.${MIN_PYTHON[1]} 或更高。试过 ${version === undefined ? python : `uv 管理的 Python ${version}`}：${detail}`
      + (version !== undefined
        ? `\n修法：先在终端里确认 uv python install ${version} 能成功（DSH 用登录 shell 里的 uv），再重启 DSH；`
        : `\n修法：装一个 ${MIN_PYTHON[0]}.${MIN_PYTHON[1]} 以上的 Python（uv python install 3.14），`
          + (bare ? `先在终端里确认 ${python} --version 已达标，再重启 DSH（DSH 启动时读登录 shell 的环境）；` : ''))
      + '或者把插件配置里的 python 指到解释器的完整路径（支持 ~ 开头）。',
    )
  }
}

/** The uv-managed interpreter for `version`, installing it on first use. */
async function uvPython(version: string): Promise<string> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const find = async (): Promise<string> =>
    (await run('uv', ['python', 'find', '--managed-python', version], { timeout: 30_000 })).stdout.trim()
  try {
    return await find()
  } catch {
    await run('uv', ['python', 'install', version], { timeout: 600_000 })
    return await find()
  }
}

/**
 * Prime's preinstalled kernel packages (`DEFAULT_RLM_EXTRA_PACKAGES`), plus
 * `dill`, which the vendored kernel needs for namespace snapshots, and
 * matplotlib/openpyxl: without them a data task left the kernel for a skill's
 * bundled interpreter and never came back.
 */
export const KERNEL_PACKAGES = [
  'requests', 'httpx', 'pyyaml', 'tomli', 'python-dotenv', 'pandas', 'numpy', 'scipy',
  'beautifulsoup4', 'lxml', 'pydantic', 'tyro', 'dill', 'matplotlib', 'openpyxl',
  'websockets>=15,<17',
] as const

/**
 * The kernel's own venv at `dir`, built from `base` like Prime's kernel-venv.
 *
 * A venv keeps the user's site-packages and the base interpreter's packages
 * out of the kernel, and `repl.install` writes straight into it. A marker
 * records what the venv was built from and with; when it matches, nothing
 * runs and no network is needed. A different base interpreter rebuilds the
 * venv; a different package list only installs.
 */
export async function kernelEnvironment(
  base: ResolvedInterpreter,
  dir: string,
  packages: readonly string[] = KERNEL_PACKAGES,
): Promise<ResolvedInterpreter> {
  const python = join(dir, 'bin', 'python')
  const markerPath = join(dir, '.dsh-kernel-env.json')
  const wanted = JSON.stringify({ base: base.python, version: base.version, packages })
  let marker: { base?: unknown; version?: unknown } | undefined
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8')) as typeof marker
  } catch {
    marker = undefined
  }
  if (existsSync(python) && JSON.stringify(marker) === wanted) return { python, version: base.version }
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  try {
    if (!existsSync(python) || marker?.base !== base.python || marker?.version !== base.version) {
      await run('uv', ['venv', '--clear', '--python', base.python, dir], { timeout: 120_000 })
    }
    if (packages.length > 0) await run('uv', ['pip', 'install', '--python', python, ...packages], { timeout: 900_000 })
  } catch (error) {
    const detail = error instanceof Error ? error.message.trim().split('\n').slice(-15).join('\n') : String(error)
    throw new Error(
      `dsh-python-repl: 建 Python 内核的专用环境失败（${dir}，用 ${base.python}）：\n${detail}\n`
      + '修法：按上面的报错处理（多半是网络或 uv 不可用），在终端里确认 uv 能用；下次运行 Python 时会自动重试。',
    )
  }
  writeFileSync(markerPath, wanted)
  return { python, version: base.version }
}

/** Plugin entry: verify the interpreter, register the runtime, fix the prompt, keep workflow presets on TypeScript. */
export function apply(ctx: Context, config: Config): void {
  const guardPresentation = createPresentationGuard(ctx)
  ctx.inject(['systemPrompt'], (scoped) => {
    // Replace the function-body preamble with cell semantics. The waterfall's
    // return value is authoritative, and the generated declarations survive.
    scoped.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      // run_code's own description comes from executionInstructions; this hook only adds state and the SDK text.
      guardPresentation(result, context.scope)
      const runtime = ctx.get('ptcRuntime') as unknown as PythonReplRuntime | undefined
      const key = sessionKeyOf(context.scope)
      const state = await runtime?.stateContext?.(key, scopeCwd(context.scope))
      if (state) result.contexts.push({ name: 'python-repl:state', text: state })
      for (const section of result.sections) {
        if (section.name === 'tools:sdk' && section.text.length > 0) {
          // Append the skill catalog to the SDK section rather than
          // registering a second one: skills are part of "what you can call",
          // and one section keeps the ordering stable across assemblies.
          // A static catalog uses this session's pinned roots, never another kernel's imports.
          const catalog = renderSkillCatalog(runtime?.knownSkills?.(key, scopeCwd(context.scope)) ?? [])
          const schemas = runtime?.visibleSchemas(context.scope, (context as { toolSet?: unknown }).toolSet) ?? []
          if (schemas.length === 0) {
            // Preserve the host's declarations when introspection is unavailable.
            // This is an explicit loss of disclosure, not a pretend empty catalog.
            section.text = rewriteSdkSection(section.text)
              + '\n\nCatalog metadata unavailable; the host declarations above are retained. Do not guess missing contracts.'
          } else {
            const resident = new Set(runtime?.config.residentTools ?? resolveConfig(config).residentTools)
            const declared = (name: string) => TOP_LEVEL.has(name) || resident.has(name)
            const full = schemas.filter((schema) => declared(schema.name))
            section.text = rewriteSdkSection(renderToolsSdkPy(full as unknown as Parameters<typeof renderToolsSdkPy>[0]))
              + renderResidentAccess(full.map((schema) => schema.name).filter((name) => !TOP_LEVEL.has(name)))
              + '\n\n' + renderToolSummaries(schemas.filter((schema) => !declared(schema.name)))
          }
          if (catalog.length > 0) section.text += `\n\n${catalog}`
        }
      }
      return result
    })
  })

  ctx.plugin(PythonReplRuntime, config)
  ctx.inject(['webServer' as never], (webCtx) => {
    const server = webCtx.get('webServer' as never) as unknown as PanelWebServer
    webCtx.effect(() => server.register(panelRoute(async (session) => {
      const runtime = ctx.get('ptcRuntime') as unknown as PythonReplRuntime | undefined
      if (runtime?.panelState === undefined) throw new Error('Python runtime unavailable')
      return runtime.panelState(session)
    })), 'python-repl: read-only state route')
    webCtx.effect(() => server.register(previewRoute(async ({ session, name, epoch }) => {
      const runtime = ctx.get('ptcRuntime') as unknown as PythonReplRuntime | undefined
      if (runtime?.panelPreview === undefined) throw new Error('Python runtime unavailable')
      return runtime.panelPreview(session, name, epoch)
    })), 'python-repl: click preview route')
    webCtx.effect(() => server.register(controlRoute(async (session, action) => {
      const runtime = ctx.get('ptcRuntime') as unknown as PythonReplRuntime | undefined
      if (runtime?.panelControl === undefined) throw new Error('Python runtime unavailable')
      return runtime.panelControl(session, action)
    })), 'python-repl: kernel control route')
    webCtx.effect(() => server.register(nameRoute(async (session, action, name) => {
      const runtime = ctx.get('ptcRuntime') as unknown as PythonReplRuntime | undefined
      if (runtime?.panelNameAction === undefined) throw new Error('Python runtime unavailable')
      return runtime.panelNameAction(session, action, name)
    })), 'python-repl: name lifecycle route')
  })
  applyPresetWorkflowOff(ctx)
}

// No default runtime-class export: the loader prefers default over the module,
// which would bypass apply's hooks and the module Config. The packaged-entry
// smoke test covers this path; class plugins elsewhere remain valid.
