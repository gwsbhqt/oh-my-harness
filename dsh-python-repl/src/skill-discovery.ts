import { readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { readSkillDocument, selectPythonSkillDocument, SkillDocumentError, type SkillDocumentFile } from './skill-document.ts'
export { frontmatter } from './skill-document.ts'

/** One skill under a configured root, as the host found it; the kernel imports from this, never rescans. */
export interface SkillSummary {
  skill: string
  description: string
  /** The skill directory; both instruction variants share this identity. */
  path: string
  instructions_file: SkillDocumentFile
  /** The SKILL.md description the host skill list shows; set only when `description` (from PYSKILL.md) differs from it. */
  standard_description?: string
  document_error?: string
  /** Set for a Python skill: the package under `src/` the kernel imports. */
  import_name: string | null
  src: string | null
  status: 'discovered' | 'docs-only' | 'unavailable'
  reason?: string
}

export interface SkillDiscovery {
  /** The configured, trusted roots. */
  roots: string[]
  /** Roots inside the session's project, scanned before `roots`; absent when the project has none. */
  projectRoots?: string[]
  skills: SkillSummary[]
  issues: string[]
  /** Skill names switched off by skill settings provider for this session; dropped from `skills`, never imported. */
  disabled?: string[]
}

/** Drop switched-off skills from a discovery; the names travel with it so the kernel reports them. */
export function withDisabled(discovery: SkillDiscovery, disabled: readonly string[]): SkillDiscovery {
  if (disabled.length === 0) return discovery
  const off = new Set(disabled)
  return { ...discovery, skills: discovery.skills.filter((s) => !off.has(s.skill)), disabled: [...off].sort() }
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

/** Same rule as the host's skill-filesystem: the nearest ancestor holding `.git`, else the cwd itself. */
export function findProjectRoot(cwd: string): string {
  for (let current = resolve(cwd); ; current = dirname(current)) {
    try { statSync(join(current, '.git')); return current } catch { /* keep walking up */ }
    if (dirname(current) === current) return resolve(cwd)
  }
}

/**
 * Put a project's skills in front of the configured ones. As in Prime, the
 * project copy wins a name clash; the shadowed configured skill is reported,
 * never imported, so one `skills.<name>` cannot point at two packages.
 */
export function withProjectSkills(configured: SkillDiscovery, project: SkillDiscovery): SkillDiscovery {
  if (project.roots.length === 0) return configured
  const names = new Set(project.skills.map((s) => s.skill))
  const imports = new Set(project.skills.flatMap((s) => s.import_name === null ? [] : [s.import_name]))
  const shadows = (s: SkillSummary) => names.has(s.skill) || (s.import_name !== null && imports.has(s.import_name))
  return {
    roots: configured.roots,
    projectRoots: project.roots,
    skills: [...project.skills, ...configured.skills.filter((s) => !shadows(s))],
    issues: [
      ...project.issues,
      ...configured.issues,
      ...configured.skills.filter(shadows).map((s) => `${s.path}: shadowed by the project skill of the same name`),
    ],
  }
}

/** Keep discovery and kernel imports on the same explicit roots, independent of session cwd. */
export function resolveSkillRoots(roots: readonly string[], base: string = process.cwd(), home: string = homedir()): string[] {
  return roots.map(configured => resolve(base, configured === '~' ? home : configured.startsWith('~/') ? join(home, configured.slice(2)) : configured))
}

/**
 * The package a Python skill imports. Prime's rule: `src/<skill name with - as _>/`.
 * DSH also takes the only package when its name differs (for example `demo`),
 * and refuses to guess between several.
 */
function importNameOf(skill: string, src: string): { name: string | null; reason?: string } {
  const packages = readdirSync(src).filter(name => isFile(join(src, name, '__init__.py'))).sort()
  const expected = skill.replace(/-/g, '_')
  if (packages.includes(expected)) return { name: expected }
  if (packages.length === 1) return { name: packages[0]! }
  if (packages.length === 0) return { name: null }
  return { name: null, reason: `src/ holds several packages (${packages.join(', ')}) and none is named ${expected}` }
}

/** Find skills under the trusted roots: read SKILL.md frontmatter, never import or run Python. */
export function discoverSkills(roots: readonly string[], base: string = process.cwd()): SkillDiscovery {
  const result: SkillDiscovery = { roots: resolveSkillRoots(roots, base), skills: [], issues: [] }
  for (const root of result.roots) {
    let entries: string[]
    try {
      if (!statSync(root).isDirectory()) throw new Error('not a directory')
      entries = readdirSync(root).sort()
    } catch (error) {
      result.issues.push(`${root}: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    for (const entry of entries) {
      const path = join(root, entry)
      const md = join(path, 'SKILL.md')
      if (!isDirectory(path) || !isFile(md)) continue
      let meta: Record<string, unknown>
      try {
        meta = readSkillDocument(path, 'SKILL.md').metadata
      } catch (error) {
        result.issues.push(`${md}: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      const skill = typeof meta['name'] === 'string' && meta['name'] !== '' ? meta['name'] : entry
      const description = typeof meta['description'] === 'string' ? meta['description'].trim() : ''
      // Prime does not load a skill without a description.
      if (description === '') {
        result.issues.push(`${md}: no description, skipped`)
        continue
      }
      const src = join(path, 'src')
      let found: { name: string | null; reason?: string } = { name: null }
      try {
        if (isDirectory(src)) found = importNameOf(skill, src)
      } catch (error) {
        result.issues.push(`${src}: ${error instanceof Error ? error.message : String(error)}`)
      }
      let instructions_file: SkillDocumentFile = 'SKILL.md'
      let selectedDescription = description
      let document_error: string | undefined
      if (found.name !== null) {
        try {
          const selected = selectPythonSkillDocument(path, skill)
          instructions_file = selected.file
          selectedDescription = selected.description
        } catch (error) {
          instructions_file = error instanceof SkillDocumentError ? error.file : 'PYSKILL.md'
          document_error = error instanceof Error ? error.message : String(error)
          result.issues.push(document_error)
        }
      }
      result.skills.push({
        skill, description: selectedDescription, path, instructions_file,
        import_name: found.name, src: found.name === null ? null : src,
        status: document_error !== undefined ? 'unavailable' : found.name === null ? 'docs-only' : 'discovered',
        ...(selectedDescription === description ? {} : { standard_description: description }),
        ...(document_error === undefined ? {} : { document_error }),
        ...(found.reason === undefined ? {} : { reason: found.reason }),
      })
    }
  }
  return result
}
