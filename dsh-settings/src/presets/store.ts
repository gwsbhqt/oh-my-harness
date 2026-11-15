/**
 * 规则文件的读写：共用偏好文件 `$DSH_HOME/preferences.json` 的 `presetPreferences` 段
 * （dotfiles 的 packages/dsh/.dsh/preferences.main.json / preferences.mm.json，换机跟着走）。
 * 按修改时间和大小缓存：手改、git pull、设置页保存后，下次读就拿到新的。
 *
 * 文件不存在等于什么都没写（全部跟随全局默认），不报错；写错了就报错，不悄悄当成没写。
 * 读写、项目根的规则与本包技能模块 `src/skills/store.ts` 同一套。
 */
import { readPreferences, preferencesPath as sharedPreferencesPath, writeSection } from '../../../tooling/runtime/preferences.mjs'
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { EMPTY_DOCUMENT, parseDocument, type PresetDocument } from './rules.ts'

/** 规则所在偏好文件位置；测试用 `DSH_PREFERENCES_FILE` 改。 */
export function preferencesPath(): string {
  return sharedPreferencesPath()
}

export interface ReadResult {
  doc: PresetDocument
  exists: boolean
  path: string
  /** 文件写错时的原因；这时 doc 是空规则（全部跟随全局默认），设置页要把错误亮出来。 */
  error?: string
}

export class DocumentStore {
  private stamp: string | undefined
  private cached: ReadResult | undefined
  readonly path: string
  constructor(path = preferencesPath()) {
    this.path = path
  }

  read(): ReadResult {
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

  private load(): ReadResult {
    const read = readPreferences(this.path)
    if (read.error !== undefined) return { doc: EMPTY_DOCUMENT, exists: read.exists, path: this.path, error: read.error }
    const section = read.raw['presetPreferences']
    if (section === undefined) return { doc: EMPTY_DOCUMENT, exists: read.exists, path: this.path }
    try {
      return { doc: parseDocument(JSON.stringify(section), this.path), exists: true, path: this.path }
    } catch (error) {
      return { doc: EMPTY_DOCUMENT, exists: true, path: this.path, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 只写 `presetPreferences` 段，其他段保留；顺着符号链接写真实文件。 */
  async write(doc: PresetDocument): Promise<void> {
    parseDocument(JSON.stringify(doc), this.path)
    await writeSection('presetPreferences', doc, this.path)
    this.stamp = undefined
  }
}

/** 与宿主 skill-filesystem 同一个规则：最近的 .git 祖先，没有就是 cwd 本身。 */
export function findProjectRoot(cwd: string): string {
  let current = cwd
  for (;;) {
    try {
      statSync(join(current, '.git'))
      return current
    } catch {
      // 往上找
    }
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

export function home(): string {
  return homedir()
}
