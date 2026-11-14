/**
 * 反引号里的文字什么时候算「像路径」，以及怎么拆出行号。宿主和浏览器两边共用这一份。
 *
 * 宁可漏，不可错：命令（`jq`、`git status`）、占位写法（`<会话ID>.jsonl`）、通配（`*.ts`）、
 * 网址都不算路径，连查都不查。
 *
 * @module dsh-path-mention/shared/token
 */

/** 宿主和浏览器之间的路由。 */
export const RESOLVE_PATH = '/dsh-path-mention/resolve'
export const OPEN_PATH = '/dsh-path-mention/open'
/**
 * 用头栏清单里的某个应用打开。单独一条路由，不复用 OPEN_PATH：旧版宿主半不认 `app` 参数，会把请求当成「打开目录」
 * 一律开成访达（2026-10-08 踩到）。新路由在旧版里根本不存在，请求直接失败，菜单就能如实报「打开失败」。
 */
export const OPEN_WITH_PATH = '/dsh-path-mention/open-with'

/** 一条回复最多查多少个片段，防止超长回复把宿主拖住。 */
export const MAX_TOKENS = 200

/** 一个像路径的片段：去掉行号后的路径，可选的起止行，和原文里的行号写法（`:24-27`、`#L24`，原样保留）。 */
export interface PathToken {
  path: string
  line?: number
  endLine?: number
  suffix?: string
}

/** 宿主对一个片段的回答：真实存在的绝对路径和类型；不存在或拿不准就没有这一项。 */
export interface Resolved {
  path: string
  kind: 'file' | 'directory'
}

export interface ResolveRequest {
  cwd?: string
  tokens: string[]
}

export interface ResolveResponse {
  results: Record<string, Resolved>
}

const BARE_FILE = /^(?:\.?[^\s/\\.][^\s/\\]*\.[A-Za-z][A-Za-z0-9_-]{0,9}|\.[A-Za-z0-9_-][A-Za-z0-9_.-]*)$/u
const FORBIDDEN = /[<>*?[\]{}|"`$\u0000-\u001f\u007f]/u
const LINE_SUFFIX = /(?:#L([1-9]\d*)(?:-L?([1-9]\d*))?|:([1-9]\d*)(?:[-:]([1-9]\d*))?)$/u

/**
 * 判断一段反引号文字像不像路径，像就拆出路径和行号。
 * @param value - 宿主交给提及解析器的原文（已把换行换成空格）。
 * @returns 像路径时的路径和行号，否则 undefined。
 */
export function parsePathToken(value: string): PathToken | undefined {
  const text = value.trim()
  if (text.length < 2 || text.length > 1024 || text !== value) return undefined
  if (FORBIDDEN.test(text) || text.includes('://') || text.startsWith('-')) return undefined
  let path = text
  let line: number | undefined
  let endLine: number | undefined
  let suffix: string | undefined
  const match = LINE_SUFFIX.exec(text)
  if (match !== null) {
    path = text.slice(0, match.index)
    suffix = match[0]
    line = Number(match[1] ?? match[3])
    const end = match[2] ?? match[4]
    // 结束行比起始行小时（`:24:3` 这种「行:列」写法）不当成范围。
    if (end !== undefined && Number(end) >= line) endLine = Number(end)
  }
  if (path === '' || path === '~' || path === '/' || path === '.' || path === '..') return undefined
  const slashy = path.includes('/')
  if (!slashy && !BARE_FILE.test(path)) return undefined
  // 有斜杠的路径允许中间带空格，但开头结尾不能是空格，也不能出现连续空格这种明显是句子的写法。
  if (/\s{2}/u.test(path)) return undefined
  if (slashy && /\s/u.test(path) && !/^[~./]/u.test(path)) return undefined
  if (line === undefined) return { path }
  return { path, line, ...(endLine === undefined ? {} : { endLine }), ...(suffix === undefined ? {} : { suffix }) }
}

/** 路径里的省略段：`...` 或 `…`。 */
export function isEllipsisSegment(segment: string): boolean {
  return segment === '...' || segment === '…'
}

/**
 * 从 Markdown 原文里粗取所有行内代码片段的内容，按 CommonMark 去掉两侧各一个空格。
 * 代码块里的反引号也会被取到，多查几个无害：只有真正渲染成行内代码的片段才会问解析器。
 * @param text - 一段回复的 Markdown 原文。
 * @returns 去重后的片段，最多 MAX_TOKENS 个。
 */
export function inlineCodeTokens(text: string): string[] {
  const seen = new Set<string>()
  const pattern = /(?<!`)(`+)(?!`)([\s\S]+?)(?<!`)\1(?!`)/gu
  for (const match of text.matchAll(pattern)) {
    let content = (match[2] ?? '').replace(/\r\n|\r|\n/gu, ' ')
    if (content.length >= 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim() !== '') content = content.slice(1, -1)
    if (parsePathToken(content) === undefined) continue
    seen.add(content)
    if (seen.size >= MAX_TOKENS) break
  }
  return [...seen]
}
