import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { BoundTool } from './lease.ts'
import type { SkillSummary } from './skill-discovery.ts'
import { readSkillDocument } from './skill-document.ts'

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function realDirectory(path: string): string | undefined {
  if (!isAbsolute(path)) return undefined
  try { return realpathSync(path) } catch { return undefined }
}

/** Adapt only a successful local skill binding; its original call owns permission and audit. */
export function withPythonSkillDocument(name: string, call: BoundTool, records: readonly SkillSummary[]): BoundTool {
  if (name !== 'skill') return call
  return async (args) => {
    const result = await call(args)
    if (!object(result) || typeof result['name'] !== 'string' || result['name'] === ''
      || typeof result['provider'] !== 'string' || result['provider'] === '' || typeof result['content'] !== 'string') return result
    const base = result['resourceBase']
    if (!object(base) || base['kind'] !== 'directory' || typeof base['path'] !== 'string') return result
    const directory = realDirectory(base['path'])
    if (directory === undefined) return result
    const matches = records.filter((record) => record.skill === result['name'] && record.import_name !== null
      && realDirectory(record.path) === directory)
    if (matches.length === 0) return result
    if (matches.length !== 1) throw new Error(`skill ${JSON.stringify(result['name'])}: multiple Python document records match ${directory}`)
    const record = matches[0]!
    if (record.document_error !== undefined) throw new Error(`skill ${JSON.stringify(record.skill)} instruction document unavailable: ${record.document_error}`)
    if (record.status !== 'discovered') return result
    const selected = readSkillDocument(record.path, record.instructions_file, record.skill)
    return { ...result, content: selected.content }
  }
}
