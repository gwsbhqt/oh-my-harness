/**
 * 快捷回复：共用偏好文件 `$DSH_HOME/preferences.json` 的 `quickReplies` 段
 * （dotfiles 按人一份 preferences.main.json / preferences.mm.json，smartstow 按机器链成 preferences.json）。
 *
 * ```json
 * { "presets": ["继续"], "action": "send" }
 * ```
 *
 * 文件不存在等于全部用默认值，不报错；写错了就报错，不悄悄当成没写。
 * 读写、按修改时间和大小缓存、只改自己那一段、顺着符号链接写真实文件，
 * 这几条与本包模式偏好 `src/presets/store.ts` 是同一套读写规则。
 *
 * @module
 */
import { preferencesPath as sharedPreferencesPath, readPreferences, writeSection } from '../../../tooling/runtime/preferences.mjs'
import { statSync } from 'node:fs'

/** 点一条预设时做什么：`send` 直接发出，`insert` 只填进输入框。 */
export type QuickReplyAction = 'send' | 'insert'

export interface QuickRepliesDocument {
  presets: string[]
  action: QuickReplyAction
}

/** 文件不存在、或某个字段没写时用它。 */
export const DEFAULT_DOCUMENT: QuickRepliesDocument = Object.freeze({
  presets: Object.freeze(['继续']) as unknown as string[],
  action: 'send',
}) as QuickRepliesDocument

/** 快捷回复所在偏好文件位置；测试用 `DSH_PREFERENCES_FILE` 改。 */
export function quickRepliesPath(): string {
  return sharedPreferencesPath()
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 校验 `quickReplies` 段；写错了抛错，带上每一处问题。 */
export function validateQuickReplies(raw: unknown, path = quickRepliesPath()): QuickRepliesDocument {
  if (!isObject(raw)) throw new Error(`快捷回复 ${path} 顶层必须是对象`)
  const problems: string[] = []
  for (const key of Object.keys(raw)) {
    if (key !== 'presets' && key !== 'action' && key !== '$comment') problems.push(`顶层不认识的字段 ${key}（只有 presets、action）`)
  }
  const presets: string[] = []
  if (raw['presets'] !== undefined) {
    if (!Array.isArray(raw['presets'])) problems.push('presets 必须是字符串数组')
    else {
      raw['presets'].forEach((entry, at) => {
        if (typeof entry !== 'string') problems.push(`presets[${at}] 必须是字符串，现在是 ${JSON.stringify(entry)}`)
        else if (entry.trim() === '') problems.push(`presets[${at}] 是空的`)
        else presets.push(entry)
      })
    }
  }
  const action = raw['action'] ?? 'send'
  if (action !== 'send' && action !== 'insert') problems.push(`action 只能是 send 或 insert，现在是 ${JSON.stringify(action)}`)
  if (problems.length > 0) throw new Error(`快捷回复 ${path} 有 ${problems.length} 处写错：${problems.join('；')}`)
  return { presets, action: action as QuickReplyAction }
}

export interface QuickRepliesReadResult {
  doc: QuickRepliesDocument
  exists: boolean
  path: string
  /** 文件写错时的原因；这时 doc 是默认值，设置页要把错误亮出来。 */
  error?: string
}

export class QuickRepliesStore {
  private stamp: string | undefined
  private cached: QuickRepliesReadResult | undefined
  readonly path: string
  constructor(path = quickRepliesPath()) {
    this.path = path
  }

  read(): QuickRepliesReadResult {
    let stamp: string
    try {
      const s = statSync(this.path)
      stamp = `${s.mtimeMs}:${s.size}`
    } catch {
      stamp = 'missing'
    }
    if (this.cached === undefined || stamp !== this.stamp) {
      this.cached = this.load()
      this.stamp = stamp
    }
    return this.cached
  }

  private load(): QuickRepliesReadResult {
    const read = readPreferences(this.path)
    if (read.error !== undefined) return { doc: DEFAULT_DOCUMENT, exists: read.exists, path: this.path, error: read.error }
    const section = read.raw['quickReplies']
    if (section === undefined) return { doc: DEFAULT_DOCUMENT, exists: read.exists, path: this.path }
    try {
      return { doc: validateQuickReplies(section, this.path), exists: true, path: this.path }
    } catch (error) {
      return { doc: DEFAULT_DOCUMENT, exists: true, path: this.path, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 只写 `quickReplies` 段，其他段保留；顺着符号链接写真实文件。 */
  async write(doc: QuickRepliesDocument): Promise<void> {
    validateQuickReplies(doc, this.path)
    await writeSection('quickReplies', doc, this.path)
    this.stamp = undefined
  }
}
