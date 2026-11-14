import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
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

/** Name and base directory DSH's rendered directory-skill text names, if this is that shape. */
function directoryFromRenderedSkill(text: string): { name: string; directory: string } | undefined {
  const name = /^<skill_content name="([^"]*)">/.exec(text)
  const directory = /Base directory for this skill: ([^\n]+)/.exec(text)
  if (name === null || directory === null) return undefined
  return { name: name[1]!, directory: directory[1]!.trim() }
}

/**
 * Rewrite the DURABLE `tool/ptc-dispatch` copy of a `skill` sub-call to the
 * Python document the kernel actually read.
 *
 * The host `skill` tool settles with `SKILL.md`, and `withPythonSkillDocument`
 * swaps the body only on the value the cell receives afterwards; the settled
 * projection DSH logs (and the conversation renders) therefore still carries
 * `SKILL.md`. This applies the same record matching and PYSKILL selection to
 * that logged copy, so the transcript shows what the model read. The program's
 * value and the model-visible result are untouched.
 *
 * @returns replacement blocks, or `undefined` to keep the settled content
 *   (not a directory skill, no matching Python record, or no PYSKILL.md).
 */
export function rewritePythonSkillDispatchLog(
  content: readonly ContentBlock[],
  records: readonly SkillSummary[],
): ContentBlock[] | undefined {
  const index = content.findIndex((block) => block.type === 'text')
  const block = index < 0 ? undefined : content[index]
  if (block === undefined || block.type !== 'text') return undefined
  const parsed = directoryFromRenderedSkill(block.text)
  if (parsed === undefined) return undefined
  const directory = realDirectory(parsed.directory)
  if (directory === undefined) return undefined
  const matches = records.filter((record) => record.skill === parsed.name && record.import_name !== null
    && realDirectory(record.path) === directory)
  if (matches.length !== 1) return undefined
  const record = matches[0]!
  if (record.status !== 'discovered' || record.instructions_file !== 'PYSKILL.md' || record.document_error !== undefined) return undefined
  let selected
  try {
    selected = readSkillDocument(record.path, 'PYSKILL.md', record.skill)
  } catch {
    return undefined
  }
  const replacement = [...content]
  replacement[index] = { type: 'text', text: renderDirectorySkill(parsed.name, parsed.directory, selected.content) }
  return replacement
}
