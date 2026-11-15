/**
 * 规则文件的读写：`~/.agents/skill-exposure.json`（dotfiles 跟踪，换机跟着走）。
 * 按修改时间缓存：手改、git pull、设置页保存后，下次读就拿到新的。
 *
 * 文件不存在时等于什么都没写（全部 on），不报错；写错了就报错，不悄悄当成没写。
 */
import { readFileSync, statSync } from 'node:fs'
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { EMPTY_DOCUMENT, formatDocument, parseDocument, type ExposureDocument } from './rules.ts'

/** 规则文件位置；测试用 `DSH_SKILL_EXPOSURE_FILE` 改。 */
export function exposurePath(): string {
  const override = process.env['DSH_SKILL_EXPOSURE_FILE']
  return override !== undefined && override !== '' ? override : join(homedir(), '.agents', 'skill-exposure.json')
}

export interface ReadResult {
  doc: ExposureDocument
  exists: boolean
  path: string
  /** 文件写错时的原因；这时 doc 是空规则（全部 on），设置页要把错误亮出来。 */
  error?: string
}

const updates = new Map<string, Promise<void>>()

export class DocumentStore {
  private stamp: string | undefined
  private cached: ReadResult | undefined
  readonly path: string
  constructor(path = exposurePath()) {
    this.path = path
  }

  read(): ReadResult {
    let stamp: string
    try {
      const s = statSync(this.path)
      stamp = `${s.ino}:${s.ctimeMs}:${s.mtimeMs}:${s.size}`
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
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { doc: EMPTY_DOCUMENT, exists: false, path: this.path }
      return { doc: EMPTY_DOCUMENT, exists: true, path: this.path, error: `读不到：${error instanceof Error ? error.message : String(error)}` }
    }
    try {
      return { doc: parseDocument(text, this.path), exists: true, path: this.path }
    } catch (error) {
      return { doc: EMPTY_DOCUMENT, exists: true, path: this.path, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** 先写临时文件再改名，不留半截文件。 */
  async write(doc: ExposureDocument): Promise<void> {
    const text = formatDocument(doc)
    parseDocument(text, this.path)
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try {
      await writeFile(temp, text, 'utf8')
      await rename(temp, this.path)
      this.stamp = undefined
    } catch (error) {
      await unlink(temp).catch(() => {})
      throw error
    }
  }

  async update(change: (current: ReadResult) => ExposureDocument): Promise<void> {
    const key = resolve(this.path)
    const previous = updates.get(key) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(async () => {
      const current = this.load()
      await this.write(change(current))
    })
    updates.set(key, pending)
    try {
      await pending
    } finally {
      if (updates.get(key) === pending) updates.delete(key)
    }
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
