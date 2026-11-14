/**
 * 右键菜单和拖拽要用到的纯函数（不碰 DOM 和 React，单独测试）。
 *
 * @module dsh-path-mention/client/menu
 */

/** 一个提及背后的真实路径；文件可以带起止行。 */
export interface MentionTarget {
  path: string
  kind: 'file' | 'directory'
  line?: number
  endLine?: number
}

export type MenuAction = 'copy-relative' | 'copy-absolute'

/**
 * 相对路径：在会话工作区里就相对工作区（工作区本身写成 `.`）；不在工作区但在家目录里就写成 `~/…`
 * （2026-10-08 用户要求：`~/.agents/skills/shot-sheet` 这种不该灰掉）；都不在才退回绝对路径。
 * @param path - 绝对路径。
 * @param cwd - 会话工作区，没有就是 undefined。
 * @param home - 家目录，没有就是 undefined。
 */
export function relativePath(path: string, cwd: string | undefined, home?: string): string {
  const under = (root: string | undefined): string | undefined => {
    if (root === undefined || root === '') return undefined
    const trimmed = root.replace(/\/+$/u, '')
    if (trimmed === '') return undefined
    if (path === trimmed) return ''
    return path.startsWith(`${trimmed}/`) ? path.slice(trimmed.length + 1) : undefined
  }
  const inWorkspace = under(cwd)
  if (inWorkspace !== undefined) return inWorkspace === '' ? '.' : inWorkspace
  const inHome = under(home)
  if (inHome !== undefined) return inHome === '' ? '~' : `~/${inHome}`
  return path
}

/**
 * 把宿主给的路径（Markdown 链接地址或提及的 title，可能是相对工作区的）补成绝对路径；结尾的 `/` 表示目录。
 * 补不出来（相对路径但不知道工作区）就返回 undefined。
 * @param path - 宿主给的路径。
 * @param cwd - 会话工作区。
 */
export function absoluteTarget(path: string, cwd: string | undefined): MentionTarget | undefined {
  const kind = /\/$/u.test(path) ? 'directory' : 'file'
  const trimmed = path.replace(/\/+$/u, '') || '/'
  if (trimmed.startsWith('/')) return { path: trimmed, kind }
  if (cwd === undefined || cwd === '') return undefined
  const root = cwd.replace(/\/+$/u, '')
  const rel = trimmed.replace(/^(?:\.\/)+/u, '')
  return { path: rel === '.' || rel === '' ? root : `${root}/${rel}`, kind }
}


/**
 * 输入框里提及块的写法，和宿主从访达拖文件进来时生成的一模一样：
 * `@相对路径`，目录以 `/` 结尾，含空白就加引号。含控制字符或双引号时宿主语法写不出来，返回 undefined。
 * @param target - 真实路径和类型。
 * @param cwd - 会话工作区。
 */
export function composerMention(target: MentionTarget, cwd: string | undefined): string | undefined {
  const rel = relativePath(target.path, cwd)
  const path = target.kind === 'directory' ? `${rel === '.' ? '.' : rel}/` : rel
  if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined
  return /\s/u.test(path) ? `@"${path}"` : `@${path}`
}

/** 行号写法：`:24`、`:24-27`；目录和没有行号的返回空串。 */
export function lineSuffix(target: MentionTarget): string {
  if (target.kind !== 'file' || target.line === undefined) return ''
  return target.endLine === undefined || target.endLine === target.line ? `:${target.line}` : `:${target.line}-${target.endLine}`
}

/**
 * 发给模型的文字。不带行号时和宿主的写法一字不差（`@路径`），模型照宿主的提示去读这个文件；
 * 带行号时在后面另写一句「第 24–27 行」，不把行号拼进 `@路径`：拼进去模型会把 `index.tsx:24-27` 当文件名去读。
 * @param target - 真实路径、类型和行号。
 * @param cwd - 会话工作区。
 */
export function mentionModelText(target: MentionTarget, cwd: string | undefined): string | undefined {
  const ref = composerMention(target, cwd)
  if (ref === undefined) return undefined
  if (target.kind !== 'file' || target.line === undefined) return ref
  const range = target.endLine === undefined || target.endLine === target.line ? `第 ${target.line} 行` : `第 ${target.line}–${target.endLine} 行`
  return `${ref}（${range}）`
}

/** 提及块上显示的名字：最后一段，目录带 `/`，文件带行号（`index.tsx:24-27`）。 */
export function mentionLabel(target: MentionTarget): string {
  const trimmed = target.path.replace(/\/+$/u, '')
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1) || trimmed
  return target.kind === 'directory' ? `${name}/` : `${name}${lineSuffix(target)}`
}

/**
 * 粘贴进来的文字是不是「一个路径」：去掉首尾空白后只有一个片段，可以带反引号、引号或 `@`。
 * 多行、夹着别的字的都不算，交给输入框照常粘贴。
 * @param text - 剪贴板里的纯文本。
 * @returns 去掉包裹后的原文，不算时返回 undefined。
 */
export function pastedPathText(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed === '' || trimmed.length > 1024 || /[\r\n]/u.test(trimmed)) return undefined
  const unwrapped = trimmed.replace(/^`([^`]+)`$/u, '$1').replace(/^"([^"]+)"$/u, '$1').replace(/^'([^']+)'$/u, "$1").replace(/^@/u, '')
  return unwrapped === '' ? undefined : unwrapped
}

/** 编辑器以外的应用：选「默认」时最后才考虑它们。 */
const NON_EDITORS = new Set(['finder', 'terminal', 'ghostty', 'warp', 'iterm', 'kitty', 'fork', 'sourcetree', 'github', 'tower', 'gitkraken', 'smartgit', 'sublimemerge'])

/**
 * 右键菜单最上面单独放的那个「默认」打开方式。
 * 顺序：上次在这个菜单里用过的 → 头栏「打开工作区」记住的那个 → 装了的第一个编辑器 → 列表第一个。
 * 文件不能用访达打开（那是「显示文件位置」），所以文件跳过访达。
 * @param apps - 本机装了、菜单里会列出的应用 id，按头栏顺序。
 * @param lastUsed - 上次在本菜单用过的应用 id。
 * @param headerChoice - 头栏菜单记住的应用 id。
 * @param kind - 右键的是文件还是目录。
 * @returns 默认应用 id；列表为空时是 undefined。
 */
export function pickPreferred(apps: readonly string[], lastUsed: string | undefined, headerChoice: string | undefined, kind: 'file' | 'directory'): string | undefined {
  const usable = apps.filter((id) => !(id === 'finder' && kind === 'file'))
  for (const candidate of [lastUsed, headerChoice]) if (candidate !== undefined && usable.includes(candidate)) return candidate
  return usable.find((id) => !NON_EDITORS.has(id)) ?? usable[0]
}