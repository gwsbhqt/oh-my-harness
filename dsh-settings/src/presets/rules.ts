/**
 * 工作区模式偏好：纯数据和纯函数。
 *
 * 规则在共用偏好文件 `$DSH_HOME/preferences.json` 的 `presetPreferences` 段
 * （dotfiles 的 packages/dsh/.dsh/preferences.main.json / preferences.mm.json，换机跟着走）：
 *
 * ```json
 * { "projects": { "~/dotfiles": "cordis" } }
 * ```
 *
 * 键是项目根（工作目录往上最近的 .git 所在目录），写绝对路径或 `~/` 开头；值是模式 id。
 * 没写的项目跟随 DSH 自己的全局默认模式，全局默认不存这里。
 *
 * @module
 */

export interface PresetDocument {
  /** 键是项目根，`~/` 开头或绝对路径；值是模式 id。 */
  projects: Record<string, string>
}

export const EMPTY_DOCUMENT: PresetDocument = Object.freeze({ projects: Object.freeze({}) }) as PresetDocument

const PRESET_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 解析并校验；写错了抛错，带上每一处问题，不悄悄当成没写。 */
export function parseDocument(text: string, path = 'preset-preferences.json'): PresetDocument {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`模式偏好 ${path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  return validateDocument(raw, path)
}

export function validateDocument(raw: unknown, path = 'preset-preferences.json'): PresetDocument {
  if (!isObject(raw)) throw new Error(`模式偏好 ${path} 顶层必须是对象`)
  const problems: string[] = []
  for (const key of Object.keys(raw)) {
    if (key !== 'projects' && key !== '$comment') problems.push(`顶层不认识的字段 ${key}（只有 projects）`)
  }
  const projects: Record<string, string> = {}
  if (raw['projects'] !== undefined) {
    if (!isObject(raw['projects'])) problems.push('projects 必须是对象，键是项目根，值是模式 id')
    else {
      for (const [root, preset] of Object.entries(raw['projects'])) {
        if (!root.startsWith('/') && !root.startsWith('~/')) problems.push(`projects 的键要写项目根的绝对路径（可用 ~/ 开头），现在是 ${JSON.stringify(root)}`)
        if (typeof preset !== 'string' || !PRESET_ID.test(preset)) problems.push(`projects[${JSON.stringify(root)}] 要写模式 id，现在是 ${JSON.stringify(preset)}`)
        else projects[root] = preset
      }
    }
  }
  if (problems.length > 0) throw new Error(`模式偏好 ${path} 有 ${problems.length} 处写错：${problems.join('；')}`)
  return { projects }
}

/** 按键排序，同一份规则写出来的文本一样（git diff 干净）。 */
export function formatDocument(doc: PresetDocument): string {
  const projects = Object.fromEntries(Object.entries(doc.projects).sort(([a], [b]) => a.localeCompare(b)))
  return `${JSON.stringify({ projects }, null, 2)}\n`
}

/** `~/` 开头的键展开成绝对路径；比较项目根时两边都先展开。 */
export function expandHome(path: string, home: string): string {
  return path === '~' ? home : path.startsWith('~/') ? `${home}/${path.slice(2)}` : path
}

/** 家目录下的路径写成 `~/`，dotfiles 里不留用户名。 */
export function collapseHome(path: string, home: string): string {
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path
}

/** 这个项目根偏好的模式；没写就是 undefined（跟随全局默认）。 */
export function preferredPreset(doc: PresetDocument, projectRoot: string, home: string): string | undefined {
  for (const [root, preset] of Object.entries(doc.projects)) {
    if (expandHome(root, home) === projectRoot) return preset
  }
  return undefined
}

/**
 * 换掉若干项目的偏好：值为 null 表示删掉这一条（回到跟随全局默认）。返回新文档，不改入参。
 * 同一个项目已有一条（不管写的是绝对路径还是 ~/）就改那条，新建时把家目录写成 ~/。
 */
export function setProjects(doc: PresetDocument, changes: Record<string, string | null>, home: string): PresetDocument {
  const projects = { ...doc.projects }
  for (const [root, preset] of Object.entries(changes)) {
    if (!root.startsWith('/')) throw new Error(`项目根要是绝对路径：${root}`)
    if (preset !== null && !PRESET_ID.test(preset)) throw new Error(`模式 id 不对：${JSON.stringify(preset)}`)
    for (const key of Object.keys(projects)) if (expandHome(key, home) === root) delete projects[key]
    if (preset !== null) projects[collapseHome(root, home)] = preset
  }
  return { projects }
}
