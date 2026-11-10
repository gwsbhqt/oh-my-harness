/**
 * The host ToolRow's CSS-module class names, read from the stylesheet the
 * host injects at load instead of hard-coded.
 *
 * Why: the hashed prefix changes with every host build (0.1.7-rc.2 shipped
 * `_5Tb7VW_`, 0.2.0-rc.1 `qefBqa_`, 0.2.0-rc.2 `Q2dzhW_`). A stale prefix matched nothing, so
 * the run_code card lost all its styling — including the visually-hidden
 * status, which then showed as a bare "失败" / "运行中" line (2026-09-29).
 * The `<style data-plugin-css>` tag id is stable across builds; only the
 * prefix inside it moves.
 *
 * Delete together with CodeRow.tsx once the host exports its ToolRow or picks
 * the code language from the code runtime.
 */

export const TOOL_ROW_STYLE_ID = '@deepseek-ai/dsh-client-ui-tool/ToolRow.module.css'

export const TOOL_ROW_CLASS_KEYS = [
  'root', 'row', 'leading', 'title', 'sep', 'summary', 'errorSummary', 'stoppedSummary',
  'bodyWrap', 'bodyScroll', 'codeBody', 'ioCard', 'ioSection', 'ioLabel', 'ioText', 'inspectButton',
  'visuallyHidden',
] as const

// 0.2.0-rc.2 dropped `chevron` from the stylesheet and the host's own rows pass it as undefined;
// the disclosure arrow styles itself, so a missing optional class must not blank the whole card.
export const TOOL_ROW_OPTIONAL_CLASS_KEYS = ['chevron'] as const

export type ToolRowClassKey = (typeof TOOL_ROW_CLASS_KEYS)[number]
export type ToolRowOptionalClassKey = (typeof TOOL_ROW_OPTIONAL_CLASS_KEYS)[number]
export type ToolRowClasses = Record<ToolRowClassKey, string> & Partial<Record<ToolRowOptionalClassKey, string>>

/** Class names from the ToolRow stylesheet text, or null with the keys it lacks. */
export function toolRowClassesFromCss(css: string): { classes: ToolRowClasses | null; missing: ToolRowClassKey[] } {
  const prefix = /\.([\w-]+)_root[{\s,:[]/.exec(css)?.[1]
  if (prefix === undefined) return { classes: null, missing: [...TOOL_ROW_CLASS_KEYS] }
  const defined = new Set<string>()
  for (const m of css.matchAll(/\.([\w-]+)(?=[{\s,:[.>+~)])/g)) defined.add(m[1]!)
  const missing = TOOL_ROW_CLASS_KEYS.filter((k) => !defined.has(`${prefix}_${k}`))
  if (missing.length > 0) return { classes: null, missing }
  const present = [...TOOL_ROW_CLASS_KEYS, ...TOOL_ROW_OPTIONAL_CLASS_KEYS.filter((k) => defined.has(`${prefix}_${k}`))]
  const classes = Object.fromEntries(present.map((k) => [k, `${prefix}_${k}`])) as ToolRowClasses
  return { classes, missing }
}

let cached: ToolRowClasses | null | undefined

/** The live host's ToolRow class names; null when its stylesheet is absent or no longer has them. */
export function hostToolRowClasses(): ToolRowClasses | null {
  if (cached !== undefined) return cached
  if (typeof document === 'undefined') return null
  const tag = document.querySelector(`style[data-plugin-css=${JSON.stringify(TOOL_ROW_STYLE_ID)}]`)
  if (tag === null) return null
  const { classes, missing } = toolRowClassesFromCss(tag.textContent ?? '')
  if (classes === null) console.warn(`[dsh-python-repl] host ToolRow stylesheet lacks: ${missing.join(', ')}; run_code card falls back to plain layout`)
  cached = classes
  return cached
}
