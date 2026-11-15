import type { Context } from '@deepseek-ai/cordis'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { reminderText } from '../../tooling/runtime/notice.mjs'

export const name = 'dsh-prompt-prefix'

/**
 * Moves the session-stable injections (workspace instructions, skill catalog,
 * memory profile) from after the first user message to the end of the system
 * prompt, keeping stable content in a consistent place for cache reuse (a hit
 * depends on the model service and an identical prefix).
 * The first step captures what the official plugins produced; later steps only
 * deduplicate against that pin. Anything that differs from the pin passes through.
 */

interface TextBlock { type?: string, text?: string }
interface Message { id?: string, role?: string, content?: TextBlock[] | string, source?: Record<string, unknown> }
interface Section { name: string, text: string, interpolate?: boolean }
interface Assembly { sections: Section[] }
interface SessionEvent { seq?: number, type?: string, data?: Message }
interface Session {
  id: unknown
  header?: { cwd?: string, origin?: string }
  inheritedEventCount?: number
  snapshotEvents?: (from?: number, to?: number) => readonly SessionEvent[]
  events?: SessionEvent[]
  surface?: { nodes: readonly number[] }
}
interface Agent { session?: Session }
interface Decision { kind?: string, messages: Message[] }
interface ProfileSource { profileMessage?: (agent: Agent, options: { consume: boolean }) => Promise<Message | null> }
interface SessionQuery { observeSession(id: unknown): Promise<{ events: readonly SessionEvent[], [Symbol.dispose](): void }> }
type Listener = (...args: any[]) => unknown
interface LooseContext {
  on(event: string, listener: Listener, options?: { prepend?: boolean }): unknown
  inject(deps: string[], callback: (scoped: LooseContext) => void): unknown
  get(name: string): unknown
  logger(name: string): { info(...args: unknown[]): void, warn(...args: unknown[]): void }
}

export interface Pin {
  v: 1
  createdAt: number
  instructions?: string
  catalog?: { text: string, digest: string }
  profile?: string
}

const POINTER_TEXT = 'The workspace instructions for this session are fixed in the system prompt, section "Workspace instructions", and are not sent again.'
// The key lets a forked session, which inherits this pointer instead of the full
// baseline, find and reuse the parent's pin.
export const pointer = (key: string) => reminderText('dsh-prompt-prefix', 'Workspace instructions location', `${POINTER_TEXT}\n<!-- prompt-prefix pin=${key} -->`)
const POINTER_KEY = /<!-- prompt-prefix pin=([0-9a-f]{32}) -->/
export const pinKey = (sessionId: string) => digest(sessionId).slice(0, 32)
// dsh-message-tidy reads the replaced baseline from here to diff later updates. It cannot ride on the message itself:
// the host rejects any symbol or non-enumerable key when it logs the message, which fails the whole turn.
// Keyed on globalThis so hot reloads and the other plugin share one table.
export const PINNED_ORIGINALS: WeakMap<object, Message> =
  ((globalThis as Record<symbol, unknown>)[Symbol.for('dsh-prompt-prefix.originals')] ??= new WeakMap()) as WeakMap<object, Message>
const MAX_AGE_MS = 30 * 24 * 3600 * 1000

const digest = (text: string) => createHash('sha256').update(text).digest('hex')

export function textOf(message: Message): string {
  const content = message.content
  if (typeof content === 'string') return content
  return (content ?? []).map((block) => (typeof block?.text === 'string' ? block.text : '')).join('')
}

export function stripListing(text: string): string {
  return text.replace(/\n?<available-memories>[\s\S]*?<\/available-memories>/g, '')
}


export function renderSections(pin: Pin): Section[] {
  const out: Section[] = []
  if (pin.instructions) out.push({ name: 'prefix:instructions', text: `# Workspace instructions\n\n${pin.instructions}`, interpolate: false })
  if (pin.catalog) out.push({ name: 'prefix:skills', text: `# Skill catalog\n\n${pin.catalog.text}`, interpolate: false })
  if (pin.profile) out.push({ name: 'prefix:memory', text: `# Memory profile\n\n${pin.profile}`, interpolate: false })
  return out
}

function realpathOrSelf(path: string): string {
  try { return realpathSync(path) } catch { return path }
}

export class PinStore {
  private readonly cache = new Map<string, Pin>()
  private readonly dir: string
  constructor(dir: string) { this.dir = dir }
  private path(key: string) { return join(this.dir, `${key}.json`) }
  get(sessionId: string): Pin | undefined {
    const hit = this.cache.get(sessionId)
    if (hit) return hit
    const pin = this.byKey(pinKey(sessionId))
    if (pin) this.cache.set(sessionId, pin)
    return pin
  }
  /** Reads a pin file and refreshes its mtime so pruning only drops pins no session has used. */
  byKey(key: string): Pin | undefined {
    try {
      const file = this.path(key)
      const pin = JSON.parse(readFileSync(file, 'utf8')) as Pin
      if (pin?.v !== 1) return undefined
      try { const now = new Date(); utimesSync(file, now, now) } catch {}
      return pin
    } catch { return undefined }
  }
  set(sessionId: string, pin: Pin) {
    this.cache.set(sessionId, pin)
    mkdirSync(this.dir, { recursive: true })
    // An interrupted in-place write leaves truncated JSON, which reads as "no pin" and drops the session's fixed prefix.
    const file = this.path(pinKey(sessionId))
    const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
    try {
      writeFileSync(temp, JSON.stringify(pin))
      renameSync(temp, file)
    } catch (error) {
      rmSync(temp, { force: true })
      throw error
    }
  }
  prune(now = Date.now()) {
    let names: string[] = []
    try { names = readdirSync(this.dir) } catch { return }
    for (const n of names) {
      const p = join(this.dir, n)
      try { if (now - statSync(p).mtimeMs > MAX_AGE_MS) unlinkSync(p) } catch {}
    }
  }
}

interface RewriteEnv { capturing: boolean, globalFiles: Set<string>, cwd?: string | undefined, key: string }

/** Nested instruction message that only re-delivers a user-global file through another path. */
export function isGlobalDuplicate(source: Record<string, unknown>, env: RewriteEnv): boolean {
  const changes = source['changes']
  if (!Array.isArray(changes) || changes.length === 0) return false
  return changes.every((change) => {
    const path = (change as { path?: unknown, action?: unknown })?.path
    if ((change as { action?: unknown }).action !== 'set' || typeof path !== 'string') return false
    const full = isAbsolute(path) ? path : env.cwd ? resolve(env.cwd, path) : undefined
    return full !== undefined && env.globalFiles.has(realpathOrSelf(full))
  })
}

/** The OpenViking startup profile; its kind is `plugin:openviking-memory` in DSH, `plugin` in older builds. */
export function isMemoryProfile(source: Record<string, unknown> | undefined): boolean {
  if (!source || source['form'] !== 'instructions') return false
  const kind = String(source['kind'] ?? '')
  if (kind !== 'plugin' && !kind.startsWith('plugin:')) return false
  return `${kind} ${String(source['plugin'] ?? '')}`.includes('openviking')
}

/** Parent pin key carried by a pointer the session inherited (a fork's seed history). */
export function inheritedKey(session: Session, own: string): string | undefined {
  // Only the fork-inherited prefix can carry a parent's pointer.
  const inherited = typeof session.snapshotEvents === 'function'
    ? (session.inheritedEventCount ? session.snapshotEvents(0, session.inheritedEventCount) : [])
    : session.events ?? []
  for (const event of inherited) {
    if (event?.type !== 'user/message' || !event.data) continue
    const match = POINTER_KEY.exec(textOf(event.data))
    if (match?.[1] && match[1] !== own) return match[1]
  }
  return undefined
}

/** Returns the rewritten batch and whether the pin gained content. */
export function rewrite(messages: Message[], pin: Pin, env: RewriteEnv): { messages: Message[], changed: boolean } {
  const out: Message[] = []
  let changed = false
  for (const m of messages) {
    const source = m?.source
    const kind = source?.['kind']
    const text = textOf(m)
    if (kind === 'agent-instructions' && source?.['baseline'] === true) {
      const single = Array.isArray(m.content) ? m.content.length === 1 : true
      if (env.capturing && pin.instructions === undefined && single && text) { pin.instructions = text; changed = true }
      if (pin.instructions !== undefined && text === pin.instructions) {
        const replaced = { ...m, content: [{ type: 'text', text: pointer(env.key) }] }
        PINNED_ORIGINALS.set(replaced, m)
        out.push(replaced)
        continue
      }
      out.push(m)
      continue
    }
    if (kind === 'agent-instructions' && source && isGlobalDuplicate(source, env)) continue
    if (kind === 'skill-catalog' && text) {
      const d = digest(text)
      if (pin.catalog === undefined && env.capturing) {
        pin.catalog = { text, digest: d }
        changed = true
        continue
      }
      if (pin.catalog?.digest === d) continue
      pin.catalog = { text, digest: d }
      changed = true
      out.push(m)
      continue
    }
    if (isMemoryProfile(source)) {
      if (env.capturing && pin.profile === undefined && text) { pin.profile = stripListing(text); changed = true }
      if (pin.profile !== undefined) continue
      out.push(m)
      continue
    }
    out.push(m)
  }
  return { messages: out, changed }
}

export function apply(ctx: Context): void {
  const loose = ctx as unknown as LooseContext
  const log = loose.logger(name)
  const home = process.env['DSH_HOME'] || join(homedir(), '.dsh')
  const store = new PinStore(join(home, 'plugins', 'prompt-prefix', 'sessions'))
  store.prune()
  const globalFiles = new Set([join(home, 'AGENTS.md'), join(homedir(), '.agents', 'AGENTS.md')].map(realpathOrSelf))
  const slots = new WeakMap<object, Section[]>()
  const recovered = new WeakSet<object>()

  const recoverCatalog = async (pin: Pin, session: Session, id: unknown): Promise<{ pin: Pin, valid: boolean }> => {
    if (!session.surface) return { pin, valid: true }
    try {
      const query = loose.get('sessionQuery') as SessionQuery | undefined
      if (!query) throw new Error('sessionQuery unavailable')
      const observation = await query.observeSession(id)
      try {
        const visible = new Set(session.surface.nodes)
        const latest = [...observation.events].reverse().find(event => event.seq !== undefined && visible.has(event.seq)
          && event.type === 'user/message' && event.data?.source?.['kind'] === 'skill-catalog'
          && Array.isArray(event.data.source['entries'])
          && event.data.source['entries'].every((entry: unknown) => typeof entry === 'object' && entry !== null
            && typeof (entry as { name?: unknown }).name === 'string' && (entry as { name: string }).name !== ''
            && typeof (entry as { description?: unknown }).description === 'string')
          && textOf(event.data) !== '')
        const text = latest?.data ? textOf(latest.data) : ''
        return { pin: text && pin.catalog?.digest !== digest(text) ? { ...pin, catalog: { text, digest: digest(text) } } : pin, valid: true }
      } finally {
        observation[Symbol.dispose]()
      }
    } catch (error) {
      log.warn('could not restore visible skill catalog: %s', error instanceof Error ? error.message : String(error))
      const { catalog: _catalog, ...rest } = pin
      return { pin: rest, valid: false }
    }
  }

  loose.inject(['systemPrompt'], (scoped) => {
    scoped.on('system-prompt/assemble', async (_assembly: unknown, context: { agent?: Agent }, next: () => Promise<Assembly>) => {
      const result = await next()
      const agent = context?.agent
      const id = agent?.session?.id
      if (!agent || id === undefined || !Array.isArray(result?.sections)) return result
      const pin = store.get(String(id))
      let renderPin = pin
      if (!recovered.has(agent)) {
        recovered.add(agent)
        const session = agent.session
        if (pin && session?.surface) {
          const result = await recoverCatalog(pin, session, id)
          renderPin = result.pin
          if (result.valid && renderPin !== pin) store.set(String(id), renderPin)
          if (!result.valid) recovered.delete(agent)
        }
      }
      if (renderPin) result.sections.push(...renderSections(renderPin))
      slots.set(agent, result.sections)
      return result
    })
  })

  loose.on('agent/pre-step', async ({ agent }: { agent?: Agent }, next: () => Promise<Decision>) => {
    const decision = await next()
    const session = agent?.session
    if (!agent || !session || decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
    const id = String(session.id)
    try {
      const existing = store.get(id)
      const capturing = existing === undefined
      const key = pinKey(id)
      const parentKey = capturing ? inheritedKey(session, key) : undefined
      const parent = parentKey ? store.byKey(parentKey) : undefined
      let pin: Pin = existing ?? (parent ? { ...parent, createdAt: Date.now() } : { v: 1, createdAt: Date.now() })
      if (capturing && parent && session.surface) {
        const result = await recoverCatalog(pin, session, id)
        pin = result.pin
        if (!result.valid) recovered.delete(agent)
      }
      const env: RewriteEnv = { capturing, globalFiles, cwd: session.header?.cwd, key }
      const result = rewrite(decision.messages, pin, env)
      if (capturing && pin.profile === undefined && session.header?.origin !== 'subagent') {
        const memory = loose.get('openvikingMemory') as ProfileSource | undefined
        // The memory plugin already waited for the server this step; do not stack a second health timeout.
        const message = await Promise.race([
          memory?.profileMessage?.(agent, { consume: true }).catch(() => null) ?? Promise.resolve(null),
          new Promise<null>((done) => setTimeout(() => done(null), 2000).unref?.()),
        ])
        const text = message ? textOf(message) : ''
        if (text) pin.profile = stripListing(text)
      }
      if (capturing) {
        const sections = renderSections(pin)
        if (sections.length === 0) return decision
        const slot = slots.get(agent)
        if (!slot) return decision
        slot.push(...sections)
        slots.delete(agent)
        store.set(id, pin)
        log.info('pinned %s: instructions=%d skills=%d memory=%d', id, pin.instructions?.length ?? 0, pin.catalog?.text.length ?? 0, pin.profile?.length ?? 0)
      } else if (result.changed) {
        const slot = slots.get(agent)
        const updated = renderSections(pin).find(section => section.name === 'prefix:skills')
        if (slot && updated) {
          const index = slot.findIndex(section => section.name === updated.name)
          if (index >= 0) slot[index] = updated
          else {
            const memoryIndex = slot.findIndex(section => section.name === 'prefix:memory')
            slot.splice(memoryIndex < 0 ? slot.length : memoryIndex, 0, updated)
          }
        }
        store.set(id, pin)
      }
      slots.delete(agent)
      return { ...decision, messages: result.messages }
    } catch (error) {
      log.warn('left step unchanged: %s', error instanceof Error ? error.message : String(error))
      return decision
    }
  }, { prepend: true })
}
