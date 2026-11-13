import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { BoundTool } from './lease.ts'
import type { SkillSummary } from './skill-discovery.ts'
import { readSkillDocument } from './skill-document.ts'

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * The text DSH's skill tool shows the model for a directory skill
 * (dsh-skill `renderSkillContent`, directory case), with the selected body.
 * A cell gets the structured value instead, whose `content` is the bare body:
 * the base directory was only in `resourceBase`, and a model that printed
 * `content` resolved `references/…` against a guessed directory (evolve
 * I-062, 2026-11-09). Keep in step with that function when DSH changes it.
 */
function renderDirectorySkill(name: string, directory: string, body: string): string {
  return [
    `<skill_content name="${name.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')}">`,
    '<skill_resources>',
    `Base directory for this skill: ${escapeText(directory)}`,
    'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
    '</skill_resources>',
    '',
    '<skill_instructions>',
    body,
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
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
    return { ...result, content: renderDirectorySkill(result['name'], base['path'], selected.content) }
  }
}
