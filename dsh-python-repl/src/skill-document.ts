import { lstatSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { TextDecoder } from 'node:util'
import { parse as parseYaml } from 'yaml'

export type SkillDocumentFile = 'SKILL.md' | 'PYSKILL.md'
export interface SkillDocument {
  file: SkillDocumentFile
  path: string
  description: string
  content: string
  metadata: Record<string, unknown>
}

export class SkillDocumentError extends Error {
  readonly file: SkillDocumentFile
  readonly path: string

  constructor(file: SkillDocumentFile, path: string, message: string) {
    super(`${path}: ${message}`)
    this.name = 'SkillDocumentError'
    this.file = file
    this.path = path
  }
}

export function frontmatter(text: string): Record<string, unknown> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (match === null) return {}
  const parsed: unknown = parseYaml(match[1]!)
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}

export function readSkillDocument(directory: string, file: SkillDocumentFile, skill?: string): SkillDocument {
  const path = join(directory, file)
  try {
    if (!statSync(path).isFile()) throw new Error('instruction document is not a regular file')
    const content = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(path)).replace(/\r\n?/g, '\n')
    const meta = frontmatter(content)
    if (skill !== undefined && meta['name'] !== undefined && meta['name'] !== skill) throw new Error(`name must remain ${JSON.stringify(skill)}`)
    const description = typeof meta['description'] === 'string' ? meta['description'].trim() : ''
    if (description === '') throw new Error('no description: instruction document requires a non-empty description')
    return { file, path, description, content, metadata: meta }
  } catch (error) {
    throw new SkillDocumentError(file, path, error instanceof Error ? error.message : String(error))
  }
}

/** Only an absent directory entry permits the standard document fallback. */
export function selectPythonSkillDocument(directory: string, skill: string): SkillDocument {
  const preferred = join(directory, 'PYSKILL.md')
  try {
    lstatSync(preferred)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return readSkillDocument(directory, 'SKILL.md', skill)
    throw new SkillDocumentError('PYSKILL.md', preferred, error instanceof Error ? error.message : String(error))
  }
  return readSkillDocument(directory, 'PYSKILL.md', skill)
}
