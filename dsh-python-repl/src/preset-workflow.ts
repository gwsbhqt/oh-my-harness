/**
 * Turn workflows off in every agent preset.
 *
 * This plugin replaces the Host-level `ptcRuntime` with the Python kernel, and
 * `@deepseek-ai/dsh-workflow-ptc` throws while loading under any runtime whose
 * language is not `typescript`. The `cordis` and `standard` presets mount it in
 * their `delegation` group, so the whole preset would fail to load. Workflows
 * are not used here (user 2026-11-04: Python cells already start subagents),
 * so each enabled workflow row is switched off, as the shipped PTC preset does;
 * no TypeScript runtime is kept for them. The Host-level rows are switched off
 * in this plugin's cordis.patch.yml.
 *
 * A profile patch cannot reach rows inside a preset declaration. So the rewrite
 * happens on the preset registry's own records, and each record is remounted
 * with the registry's own generation semantics.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { updateWorkflowGuard } from '../../tooling/runtime/workflow-guard.mjs'

/** Structural view of `AgentPresetRegistry`. */
export interface PresetDefinition {
  readonly id: string
  readonly plugins: readonly unknown[]
  readonly [key: string]: unknown
}

export interface PresetGeneration {
  users: number
  retired: boolean
}

export interface PresetRecord {
  config: PresetDefinition
  ready: Promise<void>
  generation?: PresetGeneration
  broken?: string
}

export interface PresetRegistry {
  readonly definitions: Map<string, PresetRecord>
  register(definition: PresetDefinition): Promise<unknown>
  activate(record: PresetRecord): Promise<void>
  collect(generation: PresetGeneration): Promise<void>
}

/** Switch off workflow rows while this plugin is active. */
export function withoutWorkflow(rows: readonly unknown[]): unknown[] | undefined {
  return updateWorkflowGuard(rows, 'python-repl', true)
}

/** Remove only this plugin's reason for disabling each workflow row. */
export function withWorkflowRestored(rows: readonly unknown[]): unknown[] | undefined {
  return updateWorkflowGuard(rows, 'python-repl', false)
}

/**
 * Rewrite one registered record and remount it the way the registry would.
 *
 * Chained on `record.ready`, because other plugins may remount the same record
 * and `unregister` waits for `ready` before retiring. The rewrite reads the
 * config at its turn in that chain, not when it is queued. On success the new
 * generation takes over and the old one is retired. Agents still holding the
 * old one keep it until `collect` sees its user count drop to zero. On failure
 * the record shows the diagnostic, as a failed first registration would.
 */
export function remount(
  registry: PresetRegistry,
  record: PresetRecord,
  rewrite: (rows: readonly unknown[]) => unknown[] | undefined,
  onError: (error: unknown) => void,
): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    if (registry.definitions.get(record.config.id) !== record) return false
    const plugins = rewrite(record.config.plugins)
    if (plugins === undefined) return false
    const previous = record.generation
    record.config = { ...record.config, plugins }
    await registry.activate(record)
    if (record.generation === previous) delete record.generation
    else delete record.broken
    if (previous !== undefined) {
      previous.retired = true
      await registry.collect(previous)
    }
    return true
  }
  const turn = record.ready.then(run, run).catch((error: unknown) => {
    onError(error)
    return false
  })
  // The host's diagnostic, retain and unregister all await `ready`; it must never reject.
  record.ready = turn.then(() => undefined)
  return turn
}

/** Own method on the instance, or the prototype's. Read by descriptor: the cordis service proxy re-wraps every method read. */
function ownOrInherited(target: object, key: string): PropertyDescriptor | undefined {
  for (let at: object | null = target; at !== null; at = Object.getPrototypeOf(at)) {
    const found = Object.getOwnPropertyDescriptor(at, key)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Install the rewrite on the preset registry: records already registered are
 * remounted now, and later registrations are rewritten before they mount.
 *
 * @returns A disposer that stops rewriting and remounts every record still
 *   carrying our edits without them.
 */
export function installPresetWorkflowOff(
  registry: PresetRegistry,
  logger: { info(message: string): void; warn(message: string): void },
): () => Promise<void> {
  let active = true
  const warn = (error: unknown) => logger.warn(`python-repl: preset remount failed: ${error instanceof Error ? error.message : String(error)}`)

  const previous = Object.getOwnPropertyDescriptor(registry, 'register')
  const original = ownOrInherited(registry, 'register')?.value as PresetRegistry['register']
  function register(this: unknown, definition: PresetDefinition): Promise<unknown> {
    const plugins = active ? withoutWorkflow(definition.plugins) : undefined
    if (plugins !== undefined) logger.info(`python-repl: preset ${definition.id} has workflows switched off`)
    return original.call(this, plugins === undefined ? definition : { ...definition, plugins })
  }
  Object.defineProperty(registry, 'register', { value: register, writable: true, configurable: true, enumerable: false })

  for (const record of registry.definitions.values()) {
    void remount(registry, record, withoutWorkflow, warn).then((done) => {
      if (!done) return
      if (record.broken === undefined) logger.info(`python-repl: preset ${record.config.id} remounted with workflows switched off`)
      else logger.warn(`python-repl: preset ${record.config.id} still fails with workflows switched off: ${record.broken}`)
    })
  }

  return async () => {
    active = false
    // Another plugin may have wrapped ours since; then ours stays in its chain as a pass-through.
    if (Object.getOwnPropertyDescriptor(registry, 'register')?.value === register) {
      if (previous === undefined) delete (registry as { register?: unknown }).register
      else Object.defineProperty(registry, 'register', previous)
    }
    await Promise.all([...registry.definitions.values()].map((record) => remount(registry, record, withWorkflowRestored, warn)))
  }
}

/** Plugin half: follow the registry's lifetime through `inject`. */
export function applyPresetWorkflowOff(ctx: Context): void {
  ctx.inject(['agentPresets'], (scoped: Context) => {
    const registry = scoped.get('agentPresets') as unknown as PresetRegistry | undefined
    if (registry === undefined || !(registry.definitions instanceof Map) || typeof registry.activate !== 'function' || typeof registry.collect !== 'function') {
      scoped.logger('python-repl').warn('python-repl: agentPresets lacks definitions/activate/collect; presets with workflow-ptc keep failing')
      return
    }
    const logger = scoped.logger('python-repl')
    scoped.effect(() => installPresetWorkflowOff(registry, logger), 'python-repl preset workflows off')
  })
}
