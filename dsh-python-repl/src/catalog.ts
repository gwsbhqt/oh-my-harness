/**
 * The capability catalog behind `tools.list` / `tools.describe`.
 *
 * Built from the schemas the host already generated for THIS call, so the
 * catalog can never advertise a capability the caller is not allowed to use.
 * Disclosure filtering and permission filtering stay separate (design §7):
 * we never call `ctx.tools.restrict` to hide things, because that would also
 * remove the binding.
 *
 * ## MCP grouping is deliberately absent
 *
 * `dsh-mcp-client` registers each MCP tool under `mcp__<serverName>__<rawName>`
 * (or a normalized form that appends a SHA-256 fragment when the raw name is
 * lossy), and its README is explicit: "The raw name is the only wire name. The
 * public name is never sent to the server and never parsed to recover the raw
 * name." The package exports no service and registers nothing on `ctx`, so
 * there is no supported way to obtain a trustworthy server → tool map.
 *
 * Splitting the public name on `__` would therefore be a GUESS: a server named
 * `a__b`, a raw name containing `__`, or any hash-normalized name all break it,
 * silently and in a way that looks like it works. So MCP tools appear in the
 * flat `tools` catalog under their registered names, correctly callable, and
 * there is no `mcp` namespace grouping them by server.
 *
 * @module
 */

import { assertObjectJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { BoundTool } from './lease.ts'

/** The kernel reaches the catalog through these bindings (`python/dsh_kernel.py`). */
const CATALOG_LIST = '__catalog_list__'
const CATALOG_DESCRIBE = '__catalog_describe__'

/** Whether a binding is one of the catalog's own, never a tool the model may call. */
export function isCatalogBinding(name: string): boolean {
  return name.startsWith('__catalog_')
}

/** One catalog entry, as the model sees it. */
export interface CatalogItem {
  id: string
  name: string
  summary: string
  access: string
  status: 'available'
}

/** A tool schema as the host describes it. */
export interface ToolSchemaLike {
  name: string
  description?: string
  parameters?: unknown
  output?: unknown
}

/** Python identifier rules, for choosing dotted vs subscript access. */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Meta names on a container; a business tool with one of these needs subscript. */
const META_MEMBERS = new Set(['list', 'describe'])

/** The six always-present top-level tools (they do not need `tools.` prefix). */
/** The six fixed top-level tools, by DSH hot path (design decision D04). */
export const TOP_LEVEL_TOOLS = ['read', 'write', 'edit', 'bash', 'glob', 'grep'] as const
export const TOP_LEVEL: ReadonlySet<string> = new Set(TOP_LEVEL_TOOLS)

/** How the model should write a call to this tool. */
export function accessPath(name: string): string {
  if (TOP_LEVEL.has(name)) return `${name}(...)`
  if (IDENTIFIER.test(name) && !META_MEMBERS.has(name)) return `tools.${name}(...)`
  return `tools[${JSON.stringify(name)}](...)`
}

/** First sentence of a description, for a listing. */
export function summarize(description: string | undefined, limit = 160): string {
  if (description === undefined || description.length === 0) return ''
  const firstLine = description.split('\n')[0] ?? ''
  const sentenceEnd = firstLine.indexOf('. ')
  const text = sentenceEnd === -1 ? firstLine : firstLine.slice(0, sentenceEnd + 1)
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/**
 * Build the paged listing for `tools.list`.
 *
 * `cursor` is the offset a previous page returned as `next_cursor`, the same
 * convention as `repl.list` and `skills.list`.
 */
export function listTools(
  schemas: readonly ToolSchemaLike[],
  options: { query?: string | null; limit?: number; cursor?: string | null } = {},
): { items: CatalogItem[]; next_cursor: string | null; total: number } {
  const query = options.query?.toLowerCase().trim()
  const limit = options.limit ?? 20
  const offset = parseCursor(options.cursor)
  const matched = schemas
    .filter((schema) => {
      if (query === undefined || query.length === 0) return true
      return (
        schema.name.toLowerCase().includes(query) ||
        (schema.description ?? '').toLowerCase().includes(query)
      )
    })
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const page = matched.slice(offset, offset + limit).map<CatalogItem>((schema) => ({
    id: schema.name,
    name: schema.name,
    summary: summarize(schema.description),
    access: accessPath(schema.name),
    status: 'available',
  }))
  const consumed = offset + page.length
  const result: {
    items: CatalogItem[]
    next_cursor: string | null
    total: number
    note?: string
  } = {
    items: page,
    next_cursor: consumed < matched.length ? String(consumed) : null,
    total: matched.length,
  }
  // An empty result reads as "no such capability", which is the wrong
  // conclusion when the query was simply in another language: names and
  // descriptions come from the host and are English, and matching is plain
  // substring. Say so rather than let a Chinese query look like absence.
  if (matched.length === 0 && query !== undefined && query.length > 0) {
    result.note =
      `no match for ${JSON.stringify(options.query)} — names and descriptions are English and `
      + 'matching is literal substring, so try an English term or call list() with no query to browse all '
      + `${schemas.length}`
  }
  return result
}

/**
 * Decode a list cursor: the decimal offset of the next item. An unusable one is
 * an error, not page one again, which would loop a model that pages forever.
 */
function parseCursor(cursor: string | null | undefined): number {
  if (cursor === undefined || cursor === null) return 0
  if (!/^\d+$/.test(cursor)) throw new Error(`tools.list: invalid cursor ${JSON.stringify(cursor)}; pass a previous next_cursor, or None to start over`)
  return Number(cursor)
}

/** Levenshtein distance, for pairing a guessed parameter name with the real one. */
function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = row[0] ?? 0
    row[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const above = row[j] ?? 0
      row[j] = Math.min(above + 1, (row[j - 1] ?? 0) + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = above
    }
  }
  return row[b.length] ?? 0
}

/** How alike two parameter names are, 0..1: shared `_` words, else spelling. */
function nameSimilarity(a: string, b: string): number {
  const words = (s: string): Set<string> => new Set(s.toLowerCase().split(/[_\-]+/).filter(Boolean))
  const wa = words(a)
  const wb = words(b)
  const shared = [...wa].filter((w) => wb.has(w)).length
  const byWords = shared / Math.max(wa.size, wb.size, 1)
  const bySpelling = 1 - editDistance(a.toLowerCase(), b.toLowerCase()) / Math.max(a.length, b.length, 1)
  return Math.max(byWords, bySpelling)
}

/** Render unchanged JSON values as Python, refusing a call too large to show verbatim. */
function pythonCallValue(value: unknown): string | undefined {
  let remaining = 600
  const piece = (text: string): string => {
    remaining -= text.length
    if (remaining < 0) throw new Error('call too long')
    return text
  }
  const render = (v: unknown, depth = 0): string => {
    if (depth > 20) throw new Error('call too deep')
    if (v === null) return piece('None')
    if (v === true) return piece('True')
    if (v === false) return piece('False')
    if (typeof v === 'string') {
      if (v.length > remaining) throw new Error('call too long')
      // Python does not recognize JSON's escaped surrogate pairs as one codepoint.
      const encoded = JSON.stringify(v)
      if (/\\u[dD][89aAbBcCdDeEfF][0-9a-fA-F]{2}/.test(encoded)) throw new Error('unpaired surrogate')
      return piece(encoded)
    }
    if (typeof v === 'number' && Number.isFinite(v)) return piece(String(v))
    if (Array.isArray(v)) {
      let text = piece('[')
      for (let index = 0; index < v.length; index++) {
        if (index > 0) text += piece(',')
        text += render(v[index], depth + 1)
      }
      return text + piece(']')
    }
    if (v !== null && typeof v === 'object') {
      const parts: string[] = []
      for (const [key, item] of Object.entries(v)) {
        if (parts.length > 0) piece(',')
        parts.push(render(key, depth + 1) + piece(':') + render(item, depth + 1))
      }
      return piece('{') + parts.join(',') + piece('}')
    }
    throw new Error('not a JSON value')
  }
  try { return render(value) } catch { return undefined }
}

/**
 * Turn a host "invalid arguments" rejection into the exact fix.
 *
 * The host reports only what is MISSING. A model that guessed a name
 * (`image_path` for `file_path`, 16 times in session 9ca3a036) reads
 * "missing file_path" next to its own `image_path` and still does not connect
 * them — nor does it follow a pointer to `tools.describe`. Pairing the unknown
 * name with the missing one, and showing the corrected call, is one step it
 * cannot misread.
 *
 * Only top-level properties are paired: nested paths come from the host
 * already qualified, and guessing inside them would be noise.
 *
 * When no pair can be made, the fix is a pointer to the tool's contract.
 *
 * @returns text to append to the host message, or '' for other errors.
 */
export function argumentFix(tool: string, message: string, args: unknown, parameters: unknown): string {
  const pydantic = /validation errors? for \w+Arguments/.test(message)
  if (!message.startsWith('invalid arguments') && !pydantic) return ''
  // MCP servers built on pydantic report `uris\n  Field required`; restate it in the host's words so the same rename check applies.
  const normalized = pydantic
    ? [...message.matchAll(/^(\w+)\n\s+Field required/gm)].map((m) => `missing required property "${m[1]}"`).join('; ')
    : message
  return shapeFix(tool, normalized, args, parameters) || `read the contract with: await tools.describe("${tool}")`
}

function shapeFix(tool: string, message: string, args: unknown, parameters: unknown): string {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return ''
  const properties = (parameters as { properties?: unknown } | null | undefined)?.properties
  if (properties === null || typeof properties !== 'object') return ''
  const known = Object.keys(properties)
  const given = args as Record<string, unknown>
  const missing = [...message.matchAll(/missing required property "([^".[\]]+)"/g)]
    .map((m) => m[1] ?? '')
    .filter((name) => name.length > 0 && !Object.hasOwn(given, name))
  const unknown = Object.keys(given).filter((key) => !known.includes(key))
  if (unknown.length === 0) {
    try {
      assertObjectJsonSchema(parameters)
      const composite = Object.keys(given).some((key) => {
        const node = parameters.properties?.[key]
        return node?.type === 'array' || node?.type === 'object'
      })
      const violations = composite ? validateJsonSchemaValue(parameters, given) : []
      return violations.length === 0 ? ''
        : `Argument shape does not match: ${violations.slice(0, 3).join('; ')}. Values were not converted or dropped; read the contract.`
    } catch { return '' }
  }

  const renames = new Map<string, string>()
  const free = new Set(unknown)
  for (const want of missing) {
    let best: string | undefined
    let score = 0
    for (const candidate of free) {
      const s = nameSimilarity(candidate, want)
      if (s > score) {
        best = candidate
        score = s
      }
    }
    // One missing and one unknown pair up regardless of spelling; otherwise
    // only a clearly similar name, so a pairing is never a coin toss.
    if (best !== undefined && (score >= 0.5 || (missing.length === 1 && unknown.length === 1))) {
      renames.set(best, want)
      free.delete(best)
    }
  }

  const lines: string[] = []
  for (const [from, to] of renames) lines.push(`\`${from}\` is not a parameter of ${tool}; it should be \`${to}\`.`)
  if (free.size > 0) {
    lines.push(`Not parameters of ${tool}: ${[...free].map((k) => `\`${k}\``).join(', ')}. `
      + `Its parameters are: ${known.map((k) => `\`${k}\``).join(', ')}.`)
  }
  if (renames.size > 0) {
    const fixed: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(given)) {
      fixed[renames.get(key) ?? key] = value
    }
    try {
      assertObjectJsonSchema(parameters)
      const violations = validateJsonSchemaValue(parameters, fixed)
      if (violations.length > 0) {
        lines.push(`Renaming alone is not a valid call: ${violations.slice(0, 3).join('; ')}. `
          + 'Values were not converted or dropped; read the contract before choosing their intended shape.')
      } else if (free.size === 0) {
        const shown = pythonCallValue(fixed)
        lines.push(shown === undefined
          ? 'The unchanged arguments are too long or cannot be represented safely; apply the rename to the original values, not placeholders.'
          : `Corrected call: ${accessPath(tool).replace('(...)', `(${shown})`)}`)
      }
    } catch {
      lines.push('The supplied schema cannot be verified; no executable correction is suggested.')
    }
  }
  return lines.join(' ')
}

/** Build the full contract for `tools.describe`. */
export function describeTools(
  schemas: readonly ToolSchemaLike[],
  targets: readonly string[],
): { items: Array<Record<string, unknown>> } {
  const index = new Map(schemas.map((schema) => [schema.name, schema]))
  const items = targets.map((target) => {
    const schema = index.get(target)
    if (schema === undefined) {
      return {
        id: target,
        status: 'unknown',
        reason: `no tool named ${JSON.stringify(target)} is available to this call`,
      }
    }
    return {
      id: schema.name,
      status: 'available',
      access: accessPath(schema.name),
      description: schema.description ?? '',
      parameters: schema.parameters ?? null,
      returns: schema.output ?? null,
      ...((schema.parameters === undefined || schema.output === undefined) ? {
        metadata_status: 'incomplete',
        reason: 'The host did not supply a complete input/output contract. This binding exists, but missing fields are unknown; do not guess them.',
      } : {}),
    }
  })
  return { items }
}

/**
 * The catalog bindings for one cell, answered from that cell's grant.
 *
 * The catalog describes THIS cell's authority, so it is the intersection of
 * the host's schemas with the bindings actually granted. A schema the cell
 * cannot call must not appear as available, and a binding without a schema
 * still appears (by bare name) because it IS callable.
 */
export function catalogBindings(granted: Iterable<string>, schemas: readonly ToolSchemaLike[]): Map<string, BoundTool> {
  const byName = new Map(schemas.map((schema) => [schema.name, schema]))
  const visible: ToolSchemaLike[] = [...granted]
    .filter((name) => !isCatalogBinding(name))
    .map((name) => byName.get(name) ?? { name })
  // Skills describe their local Python objects; only DSH tools use this
  // host catalog. Never silently answer another namespace with tool entries.
  const membersFor = (container: unknown): ToolSchemaLike[] => {
    if (container !== undefined && container !== 'tools') {
      throw new Error('host catalog only supports the tools container')
    }
    return visible
  }
  return new Map<string, BoundTool>([
    [CATALOG_LIST, async (args) => {
      const options = (args ?? {}) as { query?: string | null; limit?: number; cursor?: string | null; container?: unknown }
      return listTools(membersFor(options.container), options) as unknown as Record<string, unknown>
    }],
    [CATALOG_DESCRIBE, async (args) => {
      const options = (args ?? {}) as { targets?: unknown; container?: unknown }
      const targets = Array.isArray(options.targets) ? (options.targets as string[]) : [String(options.targets ?? '')]
      return describeTools(membersFor(options.container), targets) as unknown as Record<string, unknown>
    }],
  ])
}
