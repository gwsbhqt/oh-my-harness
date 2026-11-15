/**
 * 预设列表的增删改（纯函数）：浏览器半算出新数组，再整份写回配置。
 * 判重时句尾标点、空白和英文大小写不算：「继续」「继续。」算同一句。
 */

/** 改动被拒的原因；浏览器半按它挑文案。 */
export type PresetIssue = 'empty' | 'duplicate'

export type PresetChange = { ok: true; presets: string[] } | { ok: false; issue: PresetIssue }

/** 句尾这些标点不影响意思。 */
const TRAILING = /[\s。．.!！~～,，、;；]+$/u

/** 比对用的写法：折叠空白、去句尾标点、英文转小写。 */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim().replace(TRAILING, '').toLowerCase()
}

function clean(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** 加在末尾。 */
export function addPreset(presets: readonly string[], text: string): PresetChange {
  const value = clean(text)
  if (value === '') return { ok: false, issue: 'empty' }
  const key = normalize(value)
  if (presets.some(entry => normalize(entry) === key)) return { ok: false, issue: 'duplicate' }
  return { ok: true, presets: [...presets, value] }
}

/** 改第 index 条；改成和别的某条一样算重复，改成空算无效（界面上恢复原文）。 */
export function editPreset(presets: readonly string[], index: number, text: string): PresetChange {
  const value = clean(text)
  if (value === '') return { ok: false, issue: 'empty' }
  const key = normalize(value)
  if (presets.some((entry, at) => at !== index && normalize(entry) === key)) return { ok: false, issue: 'duplicate' }
  return { ok: true, presets: presets.map((entry, at) => (at === index ? value : entry)) }
}

export function removePreset(presets: readonly string[], index: number): string[] {
  return presets.filter((_, at) => at !== index)
}

/** 把 from 这条挪到 to 的位置（拖拽排序用）；越界或原地不动就原样返回。 */
export function movePresetTo(presets: readonly string[], from: number, to: number): string[] {
  if (from < 0 || from >= presets.length || to < 0 || to >= presets.length || from === to) return [...presets]
  const next = [...presets]
  const [entry] = next.splice(from, 1)
  next.splice(to, 0, entry!)
  return next
}

/** 第 index 条上移（delta = -1）或下移（+1）；到头不动。 */
export function movePreset(presets: readonly string[], index: number, delta: -1 | 1): string[] {
  const target = index + delta
  if (index < 0 || index >= presets.length || target < 0 || target >= presets.length) return [...presets]
  const next = [...presets]
  const [entry] = next.splice(index, 1)
  next.splice(target, 0, entry!)
  return next
}
