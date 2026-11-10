import { strict as assert } from 'node:assert'
import { it } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSkills, findProjectRoot, resolveSkillRoots, withDisabled, withProjectSkills, type SkillSummary } from '../src/skill-discovery.ts'

const skill = (name: string, description = ''): SkillSummary =>
  ({ skill: name, description, path: `/r/${name}`, instructions_file: 'SKILL.md', import_name: name, src: `/r/${name}/src`, status: 'discovered' })

it('switched-off skills leave the static catalog and travel to the kernel by name', () => {
  const base = { roots: ['/r'], issues: [], skills: [skill('keep'), skill('off')] }
  assert.equal(withDisabled(base, []), base, 'nothing switched off returns the same discovery')
  const out = withDisabled(base, ['off', 'unknown'])
  assert.deepEqual(out.skills.map((s) => s.skill), ['keep'])
  assert.deepEqual(out.disabled, ['off', 'unknown'])
})

it('resolves relative roots against an explicit host base and keeps home expansion', () => {
  assert.deepEqual(resolveSkillRoots(['skills', '../shared', '~', '~/trusted', '/absolute'], '/host/config', '/fixture-home'), ['/host/config/skills', '/host/shared', '/fixture-home', '/fixture-home/trusted', '/absolute'])
})

it('derives the import name as Prime does, never guessing between packages and never running module code', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-discovery-'))
  const add = (dir: string, md: string, packages: string[] = []) => {
    for (const pkg of packages) {
      mkdirSync(join(root, dir, 'src', pkg), { recursive: true })
      writeFileSync(join(root, dir, 'src', pkg, '__init__.py'), 'raise RuntimeError("must not execute")')
    }
    mkdirSync(join(root, dir), { recursive: true })
    writeFileSync(join(root, dir, 'SKILL.md'), md)
  }
  try {
    add('word-count', '---\nname: word-count\ndescription: "quoted: summary"\n---\nbody', ['_vendor', 'word_count'])
    add('browser-control', '---\nname: browser-control\ndescription: >\n  Drive a\n  browser.\n---\n', ['browser_control', '_helper'])
    add('demo-skill', '---\nname: demo-skill\ndescription: Generic alternate package\n---\n', ['demo'])
    add('two', '---\nname: two\ndescription: two packages\n---\n', ['a_pkg', 'b_pkg'])
    add('guide', '---\nname: guide\ndescription: instructions only\n---\n')
    add('silent', '---\nname: silent\n---\n', ['silent'])
    mkdirSync(join(root, 'no-skill-md', 'src', 'x'), { recursive: true })
    const found = discoverSkills([root])
    const by = Object.fromEntries(found.skills.map((s) => [s.skill, s]))
    assert.equal(by['word-count']?.import_name, 'word_count', 'the package named after the skill wins over a helper package')
    assert.equal(by['word-count']?.description, 'quoted: summary', 'YAML quotes are not part of the value')
    assert.equal(by['browser-control']?.import_name, 'browser_control', 'the full skill package wins over helpers')
    assert.equal(by['browser-control']?.description, 'Drive a browser.', 'a folded YAML block is read whole')
    assert.equal(by['demo-skill']?.import_name, 'demo', 'the generic single-package fallback remains available')
    assert.equal(by['two']?.status, 'docs-only')
    assert.match(by['two']?.reason ?? '', /several packages \(a_pkg, b_pkg\)/)
    assert.equal(by['guide']?.status, 'docs-only')
    assert.equal(by['silent'], undefined, 'Prime does not load a skill without a description')
    assert.match(found.issues.join('\n'), /silent.*no description/)
    assert.equal(discoverSkills([join(root, 'missing')]).issues.length, 1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
it('finds the project root the way the host skill list does', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-project-root-'))
  try {
    mkdirSync(join(root, 'repo', '.git'), { recursive: true })
    mkdirSync(join(root, 'repo', 'sub', 'module'), { recursive: true })
    writeFileSync(join(root, 'repo', 'sub', '.git'), 'gitdir: ../.git/modules/sub\n')
    mkdirSync(join(root, 'plain', 'deep'), { recursive: true })
    assert.equal(findProjectRoot(join(root, 'repo', 'a', '..')), join(root, 'repo'))
    assert.equal(findProjectRoot(join(root, 'repo', 'sub', 'module')), join(root, 'repo', 'sub'), 'a submodule is its own project')
    assert.equal(findProjectRoot(join(root, 'plain', 'deep')), join(root, 'plain', 'deep'), 'no .git above: the cwd itself')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('puts project skills first and drops the configured skill they shadow', () => {
  const configured = { roots: ['/g'], issues: ['g-issue'], skills: [skill('shared'), skill('global-only'), { ...skill('renamed'), import_name: 'proj_only' }] }
  assert.equal(withProjectSkills(configured, { roots: [], issues: [], skills: [] }), configured, 'no project root keeps the configured discovery')
  const project = { roots: ['/p/.agents/skills'], issues: [], skills: [{ ...skill('shared'), path: '/p/shared' }, { ...skill('proj-only'), import_name: 'proj_only' }] }
  const out = withProjectSkills(configured, project)
  assert.deepEqual(out.roots, ['/g'], 'configured roots stay separate from project roots')
  assert.deepEqual(out.projectRoots, ['/p/.agents/skills'])
  assert.deepEqual(out.skills.map((s) => [s.skill, s.path]), [['shared', '/p/shared'], ['proj-only', '/r/proj-only'], ['global-only', '/r/global-only']])
  assert.match(out.issues.join('\n'), /\/r\/shared: shadowed/)
  assert.match(out.issues.join('\n'), /\/r\/renamed: shadowed/, 'the same import name is a clash even under another skill name')
})

it('records the SKILL.md description only when the Python instructions describe the skill differently', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-discovery-desc-'))
  const add = (name: string, cli: string, py: string) => {
    const pkg = name.replace(/-/g, '_')
    mkdirSync(join(root, name, 'src', pkg), { recursive: true })
    writeFileSync(join(root, name, 'src', pkg, '__init__.py'), '')
    writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${cli}\n---\n`)
    writeFileSync(join(root, name, 'PYSKILL.md'), `---\nname: ${name}\ndescription: ${py}\n---\n`)
  }
  try {
    add('same', 'Same words.', 'Same words.')
    add('other', 'Run the command.', 'Call it from the kernel.')
    const by = Object.fromEntries(discoverSkills([root]).skills.map((s) => [s.skill, s]))
    assert.equal(by['same']?.standard_description, undefined)
    assert.equal(by['other']?.description, 'Call it from the kernel.')
    assert.equal(by['other']?.standard_description, 'Run the command.')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
