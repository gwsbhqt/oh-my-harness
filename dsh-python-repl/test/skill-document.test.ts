import { strict as assert } from 'node:assert'
import { it, type TestContext } from 'node:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSkills } from '../src/skill-discovery.ts'
import { selectPythonSkillDocument, SkillDocumentError } from '../src/skill-document.ts'

function fixture(t: TestContext, withPackage = true) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-skill-documents-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, 'demo-skill')
  mkdirSync(directory)
  writeFileSync(join(directory, 'SKILL.md'), '---\nname: demo-skill\ndescription: CLI summary\n---\nCLI workflow\n')
  if (withPackage) {
    mkdirSync(join(directory, 'src', 'demo_skill'), { recursive: true })
    writeFileSync(join(directory, 'src', 'demo_skill', '__init__.py'), 'raise RuntimeError("discovery must not import")\n')
  }
  return { root, directory, preferred: join(directory, 'PYSKILL.md') }
}

it('uses one Python document for the startup description and selected instruction filename', (t) => {
  const { root, directory, preferred } = fixture(t)
  writeFileSync(preferred, '---\nname: demo-skill\ndescription: >\n  Python skill\n  summary\n---\nPython workflow\n')
  const selected = selectPythonSkillDocument(directory, 'demo-skill')
  assert.equal(selected.file, 'PYSKILL.md')
  assert.equal(selected.description, 'Python skill summary')
  assert.match(selected.content, /Python workflow/)
  const discovery = discoverSkills([root])
  assert.equal(discovery.skills.length, 1, 'the second document does not create a second skill')
  assert.equal(discovery.skills[0]?.skill, 'demo-skill')
  assert.equal(discovery.skills[0]?.import_name, 'demo_skill')
  assert.equal(discovery.skills[0]?.instructions_file, selected.file)
  assert.equal(discovery.skills[0]?.description, selected.description)
  assert.deepEqual(discovery.issues, [])
})

it('selects the standard document only when the Python document is absent', (t) => {
  const { root, directory } = fixture(t)
  const selected = selectPythonSkillDocument(directory, 'demo-skill')
  assert.equal(selected.file, 'SKILL.md')
  assert.equal(selected.description, 'CLI summary')
  assert.match(selected.content, /CLI workflow/)
  assert.equal(discoverSkills([root]).skills[0]?.instructions_file, 'SKILL.md')
})

for (const [label, content] of [
  ['invalid YAML', '---\nname: demo-skill\ndescription: [unfinished\n---\n'],
  ['missing description', '---\nname: demo-skill\n---\n'],
  ['changed identity', '---\nname: another-skill\ndescription: Python summary\n---\n'],
  ['invalid UTF-8', Buffer.from([45, 45, 45, 10, 100, 101, 115, 99, 114, 105, 112, 116, 105, 111, 110, 58, 32, 255, 10, 45, 45, 45, 10])],
] as const) {
  it(`reports ${label} without importing the skill or selecting CLI instructions`, (t) => {
    const { root, directory, preferred } = fixture(t)
    writeFileSync(preferred, content)
    assert.throws(() => selectPythonSkillDocument(directory, 'demo-skill'), SkillDocumentError)
    const discovery = discoverSkills([root])
    assert.equal(discovery.skills.length, 1, 'retain an unavailable record so its document error cannot become a CLI fallback')
    assert.equal(discovery.skills[0]?.status, 'unavailable')
    assert.equal(discovery.skills[0]?.instructions_file, 'PYSKILL.md')
    assert.ok(discovery.skills[0]?.document_error?.includes(preferred))
    assert.ok(discovery.issues.some((issue) => issue.includes(preferred)))
  })
}

it('a broken preferred-document symlink is an error, not an absent-document fallback', (t) => {
  const { directory, preferred } = fixture(t)
  symlinkSync(join(directory, 'missing.md'), preferred)
  assert.throws(() => selectPythonSkillDocument(directory, 'demo-skill'), SkillDocumentError)
})

it('rejects a directory in place of the preferred document', (t) => {
  const { directory, preferred } = fixture(t)
  mkdirSync(preferred)
  assert.throws(() => selectPythonSkillDocument(directory, 'demo-skill'), /not a regular file/)
})

it('does not fall back after a preferred-document permission denial', { skip: process.getuid?.() === 0 }, (t) => {
  const { directory, preferred } = fixture(t)
  writeFileSync(preferred, '---\nname: demo-skill\ndescription: Python summary\n---\n')
  chmodSync(preferred, 0)
  assert.throws(() => selectPythonSkillDocument(directory, 'demo-skill'), /EACCES|permission/i)
})

it('instruction-only skills keep their standard document and are not advertised as Python packages', (t) => {
  const { root, preferred } = fixture(t, false)
  writeFileSync(preferred, '---\ndescription: [invalid YAML\n---\n')
  const discovery = discoverSkills([root])
  assert.equal(discovery.skills[0]?.status, 'docs-only')
  assert.equal(discovery.skills[0]?.instructions_file, 'SKILL.md')
  assert.equal(discovery.skills[0]?.description, 'CLI summary')
  assert.deepEqual(discovery.issues, [])
})
