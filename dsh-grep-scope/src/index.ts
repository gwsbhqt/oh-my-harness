import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subprocess'
import { defineTool, type ToolExecution, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { resolve } from 'node:path'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  GREP_MAX_LINE_BYTES, GREP_MAX_MATCHES, RAW_OUTPUT_MAX_BYTES, SEARCH_GRACE_MS,
  SEARCH_META_MAX_BYTES, SEARCH_STDERR_MAX_BYTES, SEARCH_TIMEOUT_MS, SearchError,
  formatGrepMatches, parseGrepArgs, previewLine, runRipgrep,
  toWorkdirRelative, trySaveFormattedResult, presentGrepCall, presentGrepResult,
  type GrepMatch,
} from '@deepseek-ai/dsh-tool-fs-search'
import { asarParts, asarReadablePath, currentCopyPath, prepareAsarSearch, toArchivePath, type AsarSearch } from './asar.ts'
import { makeGlobTool } from './glob.ts'
import { skipGlobs, skipNote, skippedDirectories } from './skip.ts'
import { workingDirectory } from './workdir.ts'

export { asarCopy, asarParts, asarReadablePath, currentCopyPath, prepareAsarSearch, toArchivePath } from './asar.ts'
export { GLOB_CAPS, makeGlobTool } from './glob.ts'
export { SKIPPED_DIRECTORIES, skippedDirectories, withSkipGlobs } from './skip.ts'

export const name = 'dsh-grep-scope'
export const inject = ['tools', 'subprocess', 'systemPrompt', 'agents', 'workingDirectory']

export type SearchScope = 'normal' | 'all'
export type ScopedGrepInput = { pattern: string; path?: string; include?: string; scope?: SearchScope }
export type UnreadablePath = { path: string; error: string }
export type ArchiveCopy = { archive: string; copy: string }
export type GrepValue = {
  matches: GrepMatch[]; unreadable?: UnreadablePath[]; unreadableIncomplete?: boolean; clippedLines?: boolean; asar?: ArchiveCopy
  skippedDirectories?: string[]; outputCapped?: true
}

const VCS_DIRECTORIES = ['.git', '.hg', '.svn', '.jj']

/**
 * ripgrep is stopped once it has printed this much, half the host's 20 MB raw cap: past the cap the host keeps only
 * the tail and fails the whole call, and ripgrep would still run to the end (127 MB and 18 s for "error" across
 * dotfiles on 2026-11-13, evolve I-014).
 */
export const EARLY_STOP_BYTES = 10_000_000
const EARLY_STOP_POLL_MS = 200

/**
 * ripgrep argv; `roots` replaces the input path, e.g. with an archive's extracted copy. Text output with each
 * line cut at GREP_MAX_LINE_BYTES, not the official --json: --json repeats every matched line whole, so one
 * minified file (2026-10-10: a 2.6 MB one-line plugin cache in dotfiles) overflows the 20 MB raw cap, and a
 * second clipped pass would blow the 30 s tool budget (evolve I-014).
 */
export function grepArgv(input: ScopedGrepInput, roots?: string[], skip: readonly string[] = []): string[] {
  const { pattern, path, include } = parseGrepArgs(input)
  const argv = ['--null', '--line-number', '--with-filename', '--no-heading', '--color=never',
    `--max-columns=${GREP_MAX_LINE_BYTES}`, '--max-columns-preview', `--regexp=${pattern}`]
  // ripgrep lets the LAST matching --glob win, so the include must come before the VCS
  // exclusions: otherwise include "*" / "**" re-admits .git and its files.
  if (include !== undefined) argv.push(`--glob=${include}`)
  if (input.scope === 'all') {
    argv.push('--hidden', '--no-ignore')
    // Never descend into VCS internals, even when the search root is itself a VCS directory.
    for (const dir of VCS_DIRECTORIES) argv.push(`--glob=!**/${dir}`, `--glob=!**/${dir}/**`)
  }
  argv.push(...skipGlobs(skip))
  // The extracted copy lives under DSH_HOME, which may sit inside someone's git checkout whose ignore rules have nothing to do with the archive.
  if (roots !== undefined) argv.push('--no-ignore-parent', '--no-ignore-global', '--no-ignore-exclude')
  argv.push('--', ...(roots ?? [path ?? './']))
  return argv
}

export function retained(matches: GrepMatch[]) {
  return matches.slice(0, GREP_MAX_MATCHES).map(match => ({
    ...match, line: previewLine(match.line, GREP_MAX_LINE_BYTES),
  }))
}

export function searchMeta(matches: GrepMatch[]) {
  const byFile = new Map<string, Array<{ lineNumber: number; line: string }>>()
  for (const { path, lineNumber, line } of retained(matches)) {
    const group = byFile.get(path) ?? []
    group.push({ lineNumber, line })
    byFile.set(path, group)
  }
  const files = [...byFile].map(([path, group]) => ({ path, matches: group }))
  const meta = { shape: 'matches' as const, files, total: matches.length, truncated: matches.length > GREP_MAX_MATCHES }
  while (files.length > 1 && Buffer.byteLength(JSON.stringify(meta)) > SEARCH_META_MAX_BYTES) {
    files.pop()
    meta.truncated = true
  }
  return meta
}

function scopeLabel(input: ScopedGrepInput): string {
  return input.scope === 'all' ? 'all (hidden and ignored included; VCS metadata excluded)' : 'normal (hidden and ignored may be skipped)'
}

function renderUnreadable(value: GrepValue): string {
  const list = value.unreadable ?? []
  if (list.length === 0) return ''
  const more = value.unreadableIncomplete === true ? '\n(ripgrep reported more unreadable paths than were retained)' : ''
  return `\n\nIncomplete: ripgrep could not read ${list.length} ${list.length === 1 ? 'path' : 'paths'}; matches inside them are missing.\nUnreadable paths:\n${list.map(row => `- ${row.path}: ${row.error}`).join('\n')}${more}`
}

function renderClipped(value: GrepValue): string {
  return value.clippedLines === true ? `\nSome matched lines were longer than ${GREP_MAX_LINE_BYTES} bytes and are cut; read the file for the full line.` : ''
}

function renderSkipped(value: GrepValue): string {
  const note = skipNote(value.skippedDirectories)
  return note.length === 0 ? '' : `\n${note}`
}

/** The directories holding most of the kept matches, so the model knows where to narrow. */
function busiestDirectories(matches: GrepMatch[]): string {
  const counts = new Map<string, number>()
  for (const { path } of matches) {
    const parts = path.split(/[\\/]/).slice(0, -1).slice(0, 3)
    const key = parts.length === 0 ? '.' : parts.join('/')
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([dir, n]) => `${dir} (${n})`).join(', ')
}

function renderCapped(value: GrepValue): string {
  if (value.outputCapped !== true) return ''
  const where = value.matches.length === 0 ? '' : ` Most kept matches are under: ${busiestDirectories(value.matches)}.`
  return `\nIncomplete: ripgrep printed more than ${EARLY_STOP_BYTES / 1_000_000} MB, so the search was stopped and only part of the result is kept; other files were not searched or their matches were dropped.${where} Narrow path, include or pattern and search again.`
}

function renderAsar(value: GrepValue): string {
  if (value.asar === undefined) return ''
  const { archive, copy } = value.asar
  return `\nSearched inside the Electron archive ${archive} through a read-only extracted copy; app.asar.unpacked files were searched in place. ` +
    `Paths under ${archive}/ are archive paths: to read one, replace that prefix with ${copy}/.`
}

function renderNotes(value: GrepValue): string {
  return `${renderCapped(value)}${renderClipped(value)}${renderSkipped(value)}${renderAsar(value)}`
}

export function renderGrep(input: ScopedGrepInput, value: GrepValue, locator?: string): string {
  const { matches } = value
  const count = matches.length
  const rows = retained(matches)
  const header = `Search scope: ${scopeLabel(input)}. Found ${count > GREP_MAX_MATCHES ? `${rows.length} of ${count}` : count} ${count === 1 ? 'match' : 'matches'}${renderNotes(value)}`
  if (count === 0) return `${header}\nNo matches found in the ${value.unreadable?.length ? 'readable part of the ' : ''}selected scope.${renderUnreadable(value)}`
  const footer = count <= GREP_MAX_MATCHES ? '' : `\n\n(${locator ?? 'The complete result could not be saved; narrow pattern, path, or include to see more.'})`
  return `${header}\n\n${formatGrepMatches(rows)}${footer}${renderUnreadable(value)}`
}

const PATH_ERROR = /^rg: (.+): (Permission denied|No such file or directory|Not a directory) \(os error (\d+)\)$/
const PATH_ERRNOS: Record<string, number> = { 'Permission denied': 13, 'No such file or directory': 2, 'Not a directory': 20 }

/** Per-path ripgrep diagnostics, or undefined when any stderr line is not one (a real failure). */
export function parseUnreadable(stderr: string, lossy = false): UnreadablePath[] | undefined {
  // Lost diagnostics can hide a fatal error, even if every retained line is a path error.
  if (lossy) return undefined
  const rows: UnreadablePath[] = []
  const lines = stderr.split('\n')
  for (const line of lines) {
    if (line.trim().length === 0) continue
    const hit = PATH_ERROR.exec(line)
    if (hit === null || PATH_ERRNOS[hit[2]!] !== Number(hit[3])) return undefined
    const rawPath = hit[1]!
    const wrapped = rawPath.split(': IO error for operation on ')
    if (wrapped.length > 2 || (wrapped.length === 2 && wrapped[0] !== wrapped[1])) return undefined
    const path = wrapped[0]!
    // Unescaped diagnostic separators in a filename make the path boundary unprovable.
    if (path.includes(': ') || path.length === 0) return undefined
    rows.push({ path, error: `${hit[2]} (os error ${hit[3]})` })
  }
  return rows
}

/** The search-root error message when ripgrep could not open the root itself, else undefined. */
export function rootFailure(root: string, workdir: string, rows: UnreadablePath[], roots: string[] = [root]): string | undefined {
  const hit = rows.find(row => roots.some(one => resolve(workdir, row.path) === resolve(workdir, one)))
  if (hit === undefined) return undefined
  const asar = /Not a directory/.test(hit.error) ? asarParts(root, workdir) : undefined
  if (asar !== undefined) return `grep 路径无效：${asar.archive} 存在，但不是可识别的 Electron 打包文件，无法搜索它里面的 ${asar.inner}。`
  if (/No such file or directory/.test(hit.error)) return `grep 路径不存在：${root}（相对路径按工作区 ${workdir} 解析）。请检查拼写，或先用 glob 找到正确路径。`
  if (/Not a directory/.test(hit.error)) return `grep 路径无效：${root} 中有一段是文件而不是目录（${hit.error}）。`
  return `grep 无法读取搜索路径 ${root}：${hit.error}`
}

/**
 * Official runRipgrep with two outcomes kept that the host turns into failures:
 * - exit 2: ripgrep could not read SOME paths yet still printed every match it found. For exit 2 whose stderr is
 *   only per-path errors, the collected output is parsed here.
 * - too much output: ripgrep is stopped at EARLY_STOP_BYTES (or overran the host cap first) and the complete
 *   matches printed so far come back marked outputCapped, so the model sees where to narrow instead of an error.
 */
export async function runScopedSearch(ctx: Context, exec: ToolRunContext, input: ScopedGrepInput): Promise<GrepValue> {
  let handle: SubprocessHandle | undefined
  let stopped = false
  const workdir = exec.agent === undefined ? process.cwd() : await workingDirectory(ctx).ensure(exec.agent, exec.signal)
  const asked = parseGrepArgs(input).path
  const moved = asked === undefined ? undefined : await currentCopyPath(asked, workdir)
  if (moved !== undefined) input = { ...input, path: moved }
  const root = parseGrepArgs(input).path ?? './'
  const watch = (child: SubprocessHandle) => {
    let seen = 0
    const timer = setInterval(() => {
      const read = child.collected.stdout?.readFrom(seen)
      if (read === undefined) return
      seen = read.nextOffset
      if (seen <= EARLY_STOP_BYTES) return
      stopped = true
      clearInterval(timer)
      child.terminate()
    }, EARLY_STOP_POLL_MS)
    timer.unref?.()
    child.done.then(() => clearInterval(timer), () => clearInterval(timer))
    return child
  }
  // The host search resolves the directory again; hand it the one already used for the archive and root checks.
  const seam = {
    subprocess: { spawn: (spec: SubprocessSpawnSpec) => (handle = watch(ctx.subprocess.spawn(spec))) },
    workingDirectory: { ensure: async () => workdir },
  } as unknown as Context
  let asar: AsarSearch | undefined
  try {
    asar = await prepareAsarSearch(root, workdir)
  } catch (error) {
    throw new SearchError(error instanceof Error && error.message.startsWith('grep ') ? error.message : `grep 无法展开 ${root} 所在的 Electron 打包文件：${String(error)}`, 'SEARCH_FAILED', { cause: error })
  }
  const roots = asar?.roots ?? [root]
  const skip = asar === undefined ? skippedDirectories(input.path, input.include) : []
  const argv = grepArgv(input, asar?.roots, skip)
  const note = {
    ...(asar === undefined ? {} : { asar: { archive: asar.archive, copy: asar.copy } }),
    ...(skip.length === 0 ? {} : { skippedDirectories: skip }),
  }
  try {
    const run = await runRipgrep(seam, exec, 'grep', argv, RAW_OUTPUT_MAX_BYTES, SEARCH_GRACE_MS, SEARCH_STDERR_MAX_BYTES)
    return { ...relativeMatches(run.noMatches ? '' : run.stdout, run.workdir, asar, roots), ...note }
  } catch (error) {
    if (!(error instanceof SearchError) || handle === undefined || exec.signal.aborted) throw error
    const outcome = await handle.done.catch(() => undefined)
    if (outcome === undefined || exec.signal.aborted) throw error
    const stdout = handle.collected.stdout?.readFrom(0)
    const stderr = handle.collected.stderr?.readFrom(0)
    if (stdout === undefined || stderr === undefined) throw error
    const capped = () => {
      const rows = stderr.lossy ? undefined : parseUnreadable(stderr.text)
      return {
        ...relativeMatches(completeRecords(stdout.text, stdout.lossy), workdir, asar, roots),
        ...(rows !== undefined && rows.length > 0 ? { unreadable: rows.map(row => ({ ...row, path: displayPath(row.path, workdir, asar) })) } : {}),
        outputCapped: true as const,
        ...note,
      }
    }
    if (stopped || error.code === 'SEARCH_RAW_OUTPUT_OVERFLOW') return capped()
    if (error.code !== 'SEARCH_FAILED' || outcome.signal !== null || outcome.exitCode !== 2) throw error
    const unreadable = parseUnreadable(stderr.text, stderr.lossy)
    if (unreadable === undefined || unreadable.length === 0) throw error
    const rootMessage = rootFailure(root, workdir, unreadable, roots)
    if (rootMessage !== undefined) throw new SearchError(rootMessage, 'SEARCH_FAILED', { cause: error })
    if (stdout.lossy || Buffer.byteLength(stdout.text, 'utf8') > RAW_OUTPUT_MAX_BYTES) return capped()
    return {
      ...relativeMatches(stdout.text, workdir, asar, roots),
      unreadable: unreadable.map(row => ({ ...row, path: displayPath(row.path, workdir, asar) })),
      ...note,
    }
  }
}

/**
 * Whole match records from output that was cut off: the last record may stop mid-line, and a lossy read is the
 * tail of the stream, so its first record may start mid-line too.
 */
export function completeRecords(stdout: string, lossy: boolean): string {
  const start = lossy ? stdout.indexOf('\n') + 1 : 0
  const end = stdout.lastIndexOf('\n') + 1
  return end <= start ? '' : stdout.slice(start, end)
}

const CLIP_MARK = / ?\[\.\.\. (?:omitted end of long line|\d+ more matches?)\]$/

/**
 * Paths end at NUL, so embedded newlines belong to the path. Binary notices are skipped only when their
 * path is one of the explicit search roots; directory searches do not emit them.
 */
export function parseClippedMatches(stdout: string, roots: readonly string[] = []): { matches: GrepMatch[]; clippedLines?: true } {
  const matches: GrepMatch[] = []
  let clipped = false
  let offset = 0
  while (offset < stdout.length) {
    const cut = stdout.indexOf('\0', offset)
    if (cut < 0) break
    let path = stdout.slice(offset, cut)
    for (const root of roots) {
      if (root.endsWith('/')) continue
      const prefix = `${root}: binary file matches (found "\\0" byte around offset `
      if (!path.startsWith(prefix)) continue
      const end = path.indexOf(')\n', prefix.length)
      if (end < 0 || !/^\d+$/.test(path.slice(prefix.length, end))) continue
      if (roots.includes(path)) throw new SearchError('grep received ambiguous binary notice and file name', 'SEARCH_FAILED')
      path = path.slice(end + 2)
    }
    const end = stdout.indexOf('\n', cut + 1)
    if (end < 0) throw new SearchError('grep received malformed ripgrep output (unterminated match)', 'SEARCH_FAILED')
    const row = stdout.slice(cut + 1, end)
    const hit = /^(\d+):/.exec(row)
    if (hit === null) throw new SearchError('grep received malformed ripgrep output (a match has no line number)', 'SEARCH_FAILED')
    const body = row.slice(hit[0].length).replace(/\r$/, '')
    const long = CLIP_MARK.test(body)
    const kept = long ? body.replace(CLIP_MARK, '') : body
    const line = long ? `${previewLine(kept, GREP_MAX_LINE_BYTES).replace(/ \(line truncated\)$/, '')} (line truncated)` : previewLine(body, GREP_MAX_LINE_BYTES)
    if (line.endsWith(' (line truncated)')) clipped = true
    matches.push({ path, lineNumber: Number(hit[1]), line })
    offset = end + 1
  }
  return clipped ? { matches, clippedLines: true } : { matches }
}

function displayPath(path: string, workdir: string, asar: AsarSearch | undefined): string {
  return toWorkdirRelative(asar === undefined ? path : toArchivePath(path, asar), workdir)
}

function relativeMatches(stdout: string, workdir: string, asar: AsarSearch | undefined, roots: readonly string[]): Pick<GrepValue, 'matches' | 'clippedLines'> {
  const parsed = parseClippedMatches(stdout, roots)
  return { ...parsed, matches: parsed.matches.map(match => ({ ...match, path: displayPath(match.path, workdir, asar) })) }
}

/** Argument naming the path for the host tools that cannot enter an `.asar` file; glob is replaced by makeGlobTool. */
const ARCHIVE_BLIND: Record<string, string> = { read: 'file_path' }

/**
 * Denial text for a host read/glob aimed inside an `.asar` file, pointing at the readable copy; undefined otherwise.
 * The host read fails there with "Cannot mix BigInt and other types" and glob with "Not a directory", which
 * tells the model nothing (2026-10-09: 12 failed reads across three sessions, evolve I-003).
 */
export async function archiveRedirect(name: string, args: unknown, workdir: string): Promise<string | undefined> {
  const key = ARCHIVE_BLIND[name]
  const path = key === undefined ? undefined : (args as Record<string, unknown> | undefined)?.[key]
  if (typeof path !== 'string') return undefined
  const moved = await currentCopyPath(path, workdir).catch(() => undefined)
  if (moved !== undefined) return `${path} 所在的打包文件副本已随 App 更新换成新的，旧副本已删除。改用这个路径再调一次 ${name}：${moved}`
  const hit = await asarReadablePath(path, workdir).catch(() => undefined)
  if (hit === undefined) return undefined
  if (hit.readable === undefined) return `${name} 路径不存在：${hit.archive} 里没有 ${hit.inner}。`
  return `${hit.archive} 是 Electron 打包文件，宿主的 ${name} 进不去。这个路径已备好只读副本，改用这个路径再调一次 ${name}：${hit.readable}`
}

export function shouldSpill(ctx: Context, tool: object, exec: ToolExecution, result: { isError: boolean; value?: unknown }, decision: { kind: string; content?: unknown }): boolean {
  return decision.kind === 'accept' && decision.content === undefined && !Object.hasOwn(decision, 'value') &&
    exec.parent === undefined && exec.name === 'grep' && !result.isError && ctx.tools.get('grep', exec.agent) === tool
}

const OUTPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: { matches: {
    type: 'array' as const, required: true,
    items: { type: 'object' as const, additionalProperties: false, properties: {
      path: { type: 'string' as const, required: true },
      lineNumber: { type: 'integer' as const, required: true },
      line: { type: 'string' as const, required: true },
    } },
  },
  unreadable: {
    type: 'array' as const,
    items: { type: 'object' as const, additionalProperties: false, properties: {
      path: { type: 'string' as const, required: true },
      error: { type: 'string' as const, required: true },
    } },
  },
  unreadableIncomplete: { type: 'boolean' as const },
  clippedLines: { type: 'boolean' as const },
  skippedDirectories: { type: 'array' as const, items: { type: 'string' as const } },
  outputCapped: { type: 'boolean' as const },
  asar: {
    type: 'object' as const, additionalProperties: false, properties: {
      archive: { type: 'string' as const, required: true },
      copy: { type: 'string' as const, required: true },
    },
  } },
} as const

export function makeGrepTool(ctx: Context) {
  return defineTool({
    name: 'grep',
    description: 'Search file contents with ripgrep. scope normal (default) follows ignore rules and skips hidden paths; scope all includes hidden and ignored paths, except VCS metadata. Returns {matches:[{path,lineNumber,line}]} with every match to programmatic PTC callers; when some paths could not be read the matches found elsewhere are still returned with unreadable:[{path,error}] listing what was skipped (the result is then incomplete); the program must not infer search scope from the value alone. The native display names the search scope, shows total count and the first 250 matches; beyond that it saves a complete formatted list when possible. A zero result with unreadable covers only the readable part, never the entire scope; otherwise it covers only the selected scope. Each matched line is cut to 2000 bytes so long minified or one-line files cannot overflow the result; a cut line ends with "(line truncated)" and the value then carries clippedLines:true — read the file for the full line. Dependency and cache directories (node_modules, .venv, site-packages, __pycache__ and similar) are skipped unless path or include names one; the value then lists them in skippedDirectories. When ripgrep prints more than 10 MB the search is stopped and the value carries outputCapped:true with only the matches found so far: it is incomplete, narrow path, include or pattern. A path inside an Electron .asar archive (e.g. app.asar/dsh/...) is searched through a read-only extracted copy plus app.asar.unpacked; matches keep app.asar/... paths and the result says where the readable copy is.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Ripgrep regular expression.' },
      path: { type: 'string', description: 'File or directory; defaults to the session workspace.' },
      include: { type: 'string', description: 'One positive glob filter (e.g. "*.ts"); not a list.' },
      scope: { type: 'string', enum: ['normal', 'all'], description: 'normal (default): honor ignore rules and skip hidden paths. all: include hidden and ignored paths except VCS metadata.' },
    },
    timeoutMs: SEARCH_TIMEOUT_MS,
    output: {
      schema: OUTPUT_SCHEMA,
      render: (args, value) => [{ type: 'text', text: renderGrep(args as ScopedGrepInput, value as GrepValue) }],
      presentationMeta: (_args, value) => searchMeta((value as GrepValue).matches),
    },
    async execute(args, exec: ToolRunContext) {
      return runScopedSearch(ctx, exec, args as ScopedGrepInput)
    },
    presentCall: args => ({ ...presentGrepCall(args), title: `Grep ${args.pattern} [${scopeLabel(args)}]` }),
    presentResult: presentGrepResult,
  })
}

export function apply(ctx: Context): void {
  const tool = makeGrepTool(ctx)
  const glob = makeGlobTool(ctx)
  ctx.systemPrompt.section({
    name: 'grep-scope-guidance',
    order: ctx.systemPrompt.getSectionOrder('TOOL_GREP'),
    text: ({ scope }) => ctx.tools.get('grep', scope) === tool
      ? 'Use grep scope: all when searching dotfiles configuration, checking for references, or claiming an item does not exist: default normal skips hidden and ignored paths. Scope all includes hidden and ignored files except VCS metadata. Both scopes skip dependency and cache directories such as node_modules and .venv unless path or include names one. Limit path/include to keep results small; a result marked outputCapped or Incomplete is partial. A zero result applies only to the selected scope, and unreadable means the search is incomplete even when matches is empty. Never conclude that an item is absent from unreadable paths.'
      : '',
  })
  const owners = new Map<Agent, () => void>()
  const install = (agent: Agent) => {
    if (owners.has(agent)) return
    // Preset tools live on an ancestor layer; the agent's own layer shadows them.
    const registry = agent.ctx.get('tools')
    if (registry === undefined) throw new Error('grep-scope: tool registry unavailable in agent scope')
    const grepOff = registry.register(tool)
    const globOff = registry.register(glob.tool)
    owners.set(agent, () => { grepOff(); globOff() })
  }
  ctx.on('agent/created', ({ agent }) => {
    install(agent)
    return undefined
  })
  ctx.on('agent/disposed', ({ agent }) => {
    owners.get(agent)?.()
    owners.delete(agent)
    return undefined
  })
  for (const agent of ctx.agents.list()) install(agent)
  ctx.effect(() => () => {
    for (const dispose of owners.values()) dispose()
    owners.clear()
  }, 'grep-scope registrations')
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (ARCHIVE_BLIND[exec.name] === undefined) return next()
    const reason = await archiveRedirect(exec.name, exec.arguments, exec.agent === undefined ? process.cwd() : workingDirectory(ctx).get(exec.agent.session))
    return reason === undefined ? next() : { kind: 'deny' as const, reason }
  })
  ctx.on('tools/post-execute', glob.postExecute as never)
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (!shouldSpill(ctx, tool, exec, result, decision)) return decision
    const value = result.value as unknown as GrepValue
    const { matches } = value
    if (matches.length <= GREP_MAX_MATCHES) return decision
    const args = exec.arguments as ScopedGrepInput
    const all = matches.map(match => ({ ...match, line: previewLine(match.line, GREP_MAX_LINE_BYTES) }))
    const ref = await trySaveFormattedResult(ctx, exec, 'grep-results.txt',
      `Search scope: ${scopeLabel(args)}. Found ${matches.length} matches${renderNotes(value)}\n\n${formatGrepMatches(all)}${renderUnreadable(value)}`)
    return {
      kind: 'accept' as const,
      content: [{ type: 'text' as const, text: renderGrep(args, value,
        ref === undefined ? undefined : `Full grep result stored at: ${ref.locator}. ${ref.retrievalHint}`) }],
      ...(decision.additionalContexts !== undefined ? { additionalContexts: decision.additionalContexts } : {}),
    }
  })
}
