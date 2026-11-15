/**
 * 技能暴露规则：纯数据和纯函数，宿主半与 python-repl 都按这份判档。
 *
 * ## 规则文件
 *
 * `~/.agents/skill-exposure.json`（dotfiles 的 packages/agents/.agents/skill-exposure.json，换机跟着走）。
 * 一份文件里有两层：
 *
 * - `global`：对所有会话生效；
 * - `projects["<项目根绝对路径>"]`：只对这个项目（最近的 .git 祖先）里的会话生效，盖过 `global` 里同一个技能的设置。
 *
 * 每层都分两类技能分别写，同名不互相串：
 *
 * - `skills`：普通技能（官方技能目录里那些，模型用 `skill` 工具加载）；
 * - `pySkills`：py 技能（python-repl 内核里 `skills.<名字>` 那些）。
 *
 * 普通技能的键是技能名；py 技能的键是技能名（SKILL.md 的 name，没有就是目录名）。
 *
 * ## 档位
 *
 * 普通技能四档（和 Claude Code 的 skillOverrides 同一套）：
 *
 * | 档 | 模型的技能清单里 | 模型能自己加载 | 你用 /名字 调 |
 * |---|---|---|---|
 * | on | 名字和介绍 | 能 | 能 |
 * | name-only | 名字和一句「用前先看」 | 能 | 能 |
 * | user-only | 不出现 | 不能 | 能 |
 * | off | 不出现 | 不能 | 不能 |
 *
 * 宿主要求每个技能必须有介绍，所以 name-only 不能真的把介绍清空，换成一句固定的短话（见 NAME_ONLY_DESCRIPTION）。
 *
 * py 技能两档：on（内核启动时导入，出现在提示里的 Python skills 清单）、off（不导入、不出现）。
 *
 * 文件里没写的技能就是 on。
 *
 * @module
 */

export const SKILL_LEVELS = ['on', 'name-only', 'user-only', 'off'] as const
export type SkillLevel = typeof SKILL_LEVELS[number]
export const PY_LEVELS = ['on', 'off'] as const
export type PyLevel = typeof PY_LEVELS[number]

/** 一层规则。 */
export interface Layer {
  skills: Record<string, SkillLevel>
  pySkills: Record<string, PyLevel>
}

export interface ExposureDocument {
  global: Layer
  /** 键是项目根的绝对路径。 */
  projects: Record<string, Layer>
}

export const EMPTY_LAYER: Layer = Object.freeze({ skills: Object.freeze({}), pySkills: Object.freeze({}) }) as Layer
export const EMPTY_DOCUMENT: ExposureDocument = Object.freeze({ global: EMPTY_LAYER, projects: Object.freeze({}) }) as ExposureDocument

/** name-only 档在技能清单里显示的介绍：宿主不许空介绍，只能换成一句短话。 */
export const NAME_ONLY_DESCRIPTION = '（只列名字）用户点名或任务确实需要时，先用 skill 工具加载看说明，再决定用不用。'

/** 一个技能最终的档和定这个档的那一层。 */
export interface Resolved<L extends string> {
  level: L
  from: 'default' | 'global' | 'project'
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function readLevels<L extends string>(raw: unknown, allowed: readonly L[], where: string, problems: string[]): Record<string, L> {
  if (raw === undefined) return {}
  if (!isObject(raw)) {
    problems.push(`${where} 必须是对象`)
    return {}
  }
  const out: Record<string, L> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) out[name] = value as L
    else problems.push(`${where}.${name} 只能是 ${allowed.join(' / ')}，现在是 ${JSON.stringify(value)}`)
  }
  return out
}

function readLayer(raw: unknown, where: string, problems: string[]): Layer {
  if (raw === undefined) return { skills: {}, pySkills: {} }
  if (!isObject(raw)) {
    problems.push(`${where} 必须是对象`)
    return { skills: {}, pySkills: {} }
  }
  for (const key of Object.keys(raw)) {
    if (key !== 'skills' && key !== 'pySkills') problems.push(`${where} 里不认识的字段 ${key}（只有 skills、pySkills）`)
  }
  return {
    skills: readLevels(raw['skills'], SKILL_LEVELS, `${where}.skills`, problems),
    pySkills: readLevels(raw['pySkills'], PY_LEVELS, `${where}.pySkills`, problems),
  }
}

/** 解析并校验；写错了抛错，带上每一处问题，不悄悄当成没写。 */
export function parseDocument(text: string, path = 'skill-exposure.json'): ExposureDocument {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`技能暴露规则 ${path} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  return validateDocument(raw, path)
}

export function validateDocument(raw: unknown, path = 'skill-exposure.json'): ExposureDocument {
  const problems: string[] = []
  if (!isObject(raw)) throw new Error(`技能暴露规则 ${path} 顶层必须是对象`)
  for (const key of Object.keys(raw)) {
    if (key !== 'global' && key !== 'projects' && key !== '$comment') problems.push(`顶层不认识的字段 ${key}（只有 global、projects）`)
  }
  const global = readLayer(raw['global'], 'global', problems)
  const projects: Record<string, Layer> = {}
  if (raw['projects'] !== undefined) {
    if (!isObject(raw['projects'])) problems.push('projects 必须是对象，键是项目根的绝对路径')
    else {
      for (const [root, layer] of Object.entries(raw['projects'])) {
        if (!root.startsWith('/') && !root.startsWith('~/')) problems.push(`projects 的键要写项目根的绝对路径（可用 ~/ 开头），现在是 ${JSON.stringify(root)}`)
        projects[root] = readLayer(layer, `projects[${JSON.stringify(root)}]`, problems)
      }
    }
  }
  if (problems.length > 0) throw new Error(`技能暴露规则 ${path} 有 ${problems.length} 处写错：${problems.join('；')}`)
  return { global, projects }
}

/** 去掉空层、按键排序，保证同一份规则写出来的文本一样（git diff 干净）。 */
export function formatDocument(doc: ExposureDocument): string {
  const sortObj = <T>(o: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)))
  const layer = (l: Layer) => ({
    ...(Object.keys(l.skills).length > 0 ? { skills: sortObj(l.skills) } : {}),
    ...(Object.keys(l.pySkills).length > 0 ? { pySkills: sortObj(l.pySkills) } : {}),
  })
  const projects = Object.fromEntries(Object.entries(doc.projects)
    .map(([root, l]) => [root, layer(l)] as const)
    .filter(([, l]) => Object.keys(l).length > 0)
    .sort(([a], [b]) => a.localeCompare(b)))
  return `${JSON.stringify({ global: layer(doc.global), projects }, null, 2)}\n`
}

/** `~/` 开头的项目键展开成绝对路径；比较项目根时两边都先展开。 */
export function expandHome(path: string, home: string): string {
  return path === '~' ? home : path.startsWith('~/') ? `${home}/${path.slice(2)}` : path
}

/** 某个项目根对应的那层（没有就是空层）。 */
export function projectLayer(doc: ExposureDocument, projectRoot: string | undefined, home: string): Layer | undefined {
  if (projectRoot === undefined) return undefined
  for (const [root, layer] of Object.entries(doc.projects)) {
    if (expandHome(root, home) === projectRoot) return layer
  }
  return undefined
}

/** 普通技能最终的档：项目层盖全局层，都没写就是 on。 */
export function resolveSkill(doc: ExposureDocument, name: string, projectRoot: string | undefined, home: string): Resolved<SkillLevel> {
  const project = projectLayer(doc, projectRoot, home)?.skills[name]
  if (project !== undefined) return { level: project, from: 'project' }
  const global = doc.global.skills[name]
  if (global !== undefined) return { level: global, from: 'global' }
  return { level: 'on', from: 'default' }
}

export function resolvePySkill(doc: ExposureDocument, name: string, projectRoot: string | undefined, home: string): Resolved<PyLevel> {
  const project = projectLayer(doc, projectRoot, home)?.pySkills[name]
  if (project !== undefined) return { level: project, from: 'project' }
  const global = doc.global.pySkills[name]
  if (global !== undefined) return { level: global, from: 'global' }
  return { level: 'on', from: 'default' }
}

/** 宿主技能候选里本插件要读、要改的字段。其余字段原样透传。 */
export interface CandidateLike {
  name: string
  description: string
  whenToUse?: string
  invocation: { modelInvocable: boolean; userInvocable: boolean }
  [key: string]: unknown
}

/**
 * 按档改写一个候选（或定义）。返回 undefined 表示整条拿掉（off）。
 * 技能自己声明的限制只收紧、不放宽：技能写了「只许用户调」，规则写 on 也不会让模型调。
 */
export function applyLevel<T extends CandidateLike>(candidate: T, level: SkillLevel): T | undefined {
  switch (level) {
    case 'on':
      return candidate
    case 'off':
      return undefined
    case 'user-only':
      return { ...candidate, invocation: { ...candidate.invocation, modelInvocable: false } }
    case 'name-only': {
      const { whenToUse: _drop, ...rest } = candidate
      return { ...rest, description: NAME_ONLY_DESCRIPTION } as T
    }
  }
}

/** 普通技能来自哪一类目录：宿主候选的 source 字段换成设置页上的分组。 */
export type Scope = 'project' | 'global' | 'builtin'

export function scopeOfSource(source: unknown): Scope {
  if (source === 'project-dsh' || source === 'project-agents') return 'project'
  if (source === 'user-dsh' || source === 'user-agents' || source === 'custom') return 'global'
  return 'builtin'
}

/** 改一项：level 为 undefined 表示删掉这一条（回到继承）。返回新文档，不改入参。 */
export function setLevel(
  doc: ExposureDocument,
  target: { layer: 'global' } | { layer: 'project'; root: string },
  kind: 'skills' | 'pySkills',
  name: string,
  level: string | undefined,
  home?: string,
): ExposureDocument {
  if (name === '' || name.length > 200) throw new Error('技能名不对')
  if (level !== undefined) {
    const allowed: readonly string[] = kind === 'skills' ? SKILL_LEVELS : PY_LEVELS
    if (!allowed.includes(level)) throw new Error(`档位只能是 ${allowed.join(' / ')}`)
  }
  const edit = (layer: Layer | undefined): Layer => {
    const base = layer ?? { skills: {}, pySkills: {} }
    const table = { ...base[kind] } as Record<string, string>
    if (level === undefined) delete table[name]
    else table[name] = level
    return { ...base, [kind]: table } as Layer
  }
  if (target.layer === 'global') return { ...doc, global: edit(doc.global) }
  if (!target.root.startsWith('/')) throw new Error('项目根要是绝对路径')
  // 同一个项目已经有一条（不管写的是绝对路径还是 ~/）就改那条；新建时把家目录写成 ~/，dotfiles 里不留用户名。
  const existing = home === undefined ? undefined : Object.keys(doc.projects).find((k) => expandHome(k, home) === target.root)
  const key = existing ?? (home !== undefined && target.root.startsWith(`${home}/`) ? `~/${target.root.slice(home.length + 1)}` : target.root)
  return { ...doc, projects: { ...doc.projects, [key]: edit(doc.projects[key]) } }
}
