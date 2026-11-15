import { AsyncLocalStorage } from 'node:async_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import {
  GLOB_MAX_RESULTS, RAW_OUTPUT_MAX_BYTES, SEARCH_GRACE_MS, SEARCH_META_MAX_BYTES, SEARCH_STDERR_MAX_BYTES,
  SEARCH_TIMEOUT_MS, SearchError, applyGlobTool,
} from '@deepseek-ai/dsh-tool-fs-search'
import { currentCopyPath, prepareAsarSearch } from './asar.ts'
import { skipNote, skippedDirectories, withSkipGlobs } from './skip.ts'
import { workingDirectory } from './workdir.ts'

type GlobArgs = { pattern: string; path?: string }
type GlobValue = { root: string; paths: string[] }
type Content = Array<{ type: string; text?: string }>
type Decision = { kind: string; content?: Content; [key: string]: unknown }
type PostHandler = (exec: ToolRunContext & { name: string }, result: unknown, next: () => Promise<Decision>) => Promise<Decision>
export type GlobCaps = Parameters<typeof applyGlobTool>[1]

/** The presets ship `sampleOverCapGlobResults: false`; the other caps are the host defaults. */
export const GLOB_CAPS: GlobCaps = {
  sampleOverCapGlobResults: false, maxResults: GLOB_MAX_RESULTS, maxMetaBytes: SEARCH_META_MAX_BYTES,
  rawOutputMaxBytes: RAW_OUTPUT_MAX_BYTES, graceMs: SEARCH_GRACE_MS, stderrMaxBytes: SEARCH_STDERR_MAX_BYTES, timeoutMs: SEARCH_TIMEOUT_MS,
}

function appendNote(content: Content, note: string): Content {
  if (note.length === 0) return content
  return [...content, { type: 'text', text: `\n(${note})` }]
}

/**
 * The official glob, built by the host's own applyGlobTool so listing, sampling, the search card and the saved
 * full list stay the host's. Only ripgrep's argv changes: dependency and cache directories are excluded unless the
 * call names one. Paths inside an `.asar` archive list the extracted copy instead of failing with "Not a directory".
 * The host's pre-execute hook cannot rewrite arguments, which is why this is a replacement and not a policy.
 */
export function makeGlobTool(ctx: Context, caps: GlobCaps = GLOB_CAPS): { tool: ToolDefinition; postExecute: PostHandler } {
  const skips = new AsyncLocalStorage<string[]>()
  let tool: ToolDefinition | undefined
  let hostPost: PostHandler | undefined
  const host = {
    // The host already added its own glob prompt section; this copy must not add a second one.
    systemPrompt: { section: () => () => {}, getSectionOrder: () => 0 },
    tools: {
      register: (definition: ToolDefinition) => { tool = definition; return () => {} },
      get: (name: string, scope?: unknown) => (ctx.tools.get as (name: string, scope?: unknown) => unknown)(name, scope),
    },
    on: (event: string, handler: PostHandler) => { if (event === 'tools/post-execute') hostPost = handler; return () => {} },
    get: (name: string) => (ctx as unknown as { get(name: string): unknown }).get(name),
    get logger() { return (ctx as unknown as { logger: unknown }).logger },
    subprocess: {
      spawn: (spec: SubprocessSpawnSpec) => ctx.subprocess.spawn({ ...spec, argv: withSkipGlobs(spec.argv, skips.getStore() ?? []) }),
    },
    workingDirectory: { ensure: (...args: Parameters<ReturnType<typeof workingDirectory>['ensure']>) => workingDirectory(ctx).ensure(...args) },
  }
  applyGlobTool(host as never, caps)
  if (tool === undefined || hostPost === undefined) throw new Error('grep-scope: host applyGlobTool did not register glob')
  const own = tool as ToolDefinition & { execute(args: unknown, exec: ToolRunContext): Promise<GlobValue> }
  const hostExecute = own.execute.bind(own)
  const run = async (args: unknown, exec: ToolRunContext) => await hostExecute(args as never, exec) as GlobValue
  const render = own.output.render.bind(own.output)
  const noteFor = (args: GlobArgs) => skipNote(skippedDirectories(args.path, args.pattern))

  own.description = `${own.description} Dependency and cache directories (node_modules, .venv, site-packages, __pycache__ and similar) are skipped unless pattern or path names one. A path inside an Electron .asar archive lists its read-only extracted copy and app.asar.unpacked, so the returned paths are directly readable.`
  own.execute = async (args: unknown, exec: ToolRunContext): Promise<GlobValue> => {
    const input = args as GlobArgs
    if (input.path === undefined || exec.signal.aborted) return skips.run(skippedDirectories(input.path, input.pattern), () => run(args, exec))
    const workdir = exec.agent === undefined ? process.cwd() : await workingDirectory(ctx).ensure(exec.agent, exec.signal)
    const path = await currentCopyPath(input.path, workdir) ?? input.path
    let asar
    try {
      asar = await prepareAsarSearch(path, workdir, undefined, 'glob')
    } catch (error) {
      throw new SearchError(error instanceof Error && error.message.startsWith('glob ') ? error.message : `glob 无法展开 ${path} 所在的 Electron 打包文件：${String(error)}`, 'SEARCH_FAILED', { cause: error })
    }
    if (asar === undefined) return skips.run(skippedDirectories(path, input.pattern), () => run({ ...input, path }, exec))
    const values: GlobValue[] = []
    for (const root of asar.roots) values.push(await skips.run([], () => run({ ...input, path: root }, exec)))
    return { root: values[0]!.root, paths: values.flatMap(value => value.paths) }
  }
  own.output.render = (args: unknown, value: unknown) => appendNote(render(args as never, value as never) as Content, noteFor(args as GlobArgs)) as never

  const postExecute: PostHandler = async (exec, result, next) => {
    let downstream: Decision | undefined
    const decision = await hostPost!(exec, result, async () => (downstream = await next()))
    // Only the host's own spill rewrite is new content here; anything else already passed through render.
    if (decision === downstream || decision.content === undefined) return decision
    return { ...decision, content: appendNote(decision.content, noteFor((exec as unknown as { arguments: GlobArgs }).arguments)) }
  }
  return { tool: own, postExecute }
}
