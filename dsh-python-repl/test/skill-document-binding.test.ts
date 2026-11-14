import { strict as assert } from 'node:assert'
import { after, before, it } from 'node:test'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rewritePythonSkillDispatchLog, withPythonSkillDocument } from '../src/skill-document-binding.ts'
import { readSkillDocument } from '../src/skill-document.ts'
import type { SkillSummary } from '../src/skill-discovery.ts'

let home: string
const previousHome = process.env.HOME
const previousDshHome = process.env.DSH_HOME
before(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-skill-binding-home-'))
  process.env.HOME = home
  process.env.DSH_HOME = join(home, '.dsh')
})
after(() => {
  if (previousHome === undefined) delete process.env.HOME
  else process.env.HOME = previousHome
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  rmSync(home, { recursive: true, force: true })
})

function fixture(file: SkillSummary['instructions_file'] = 'PYSKILL.md') {
  const directory = mkdtempSync(join(home, 'demo-'))
  const standard = '---\nname: demo\ndescription: CLI guide\n---\nUse demo CLI.\n'
  const python = '---\nname: demo\ndescription: Python guide\n---\nUse skills.demo.\n'
  writeFileSync(join(directory, 'SKILL.md'), standard)
  if (file === 'PYSKILL.md') writeFileSync(join(directory, file), python)
  const record: SkillSummary = {
    skill: 'demo', description: file === 'PYSKILL.md' ? 'Python guide' : 'CLI guide',
    path: directory, instructions_file: file, import_name: 'demo', src: join(directory, 'src'), status: 'discovered',
  }
  const result = { name: 'demo', provider: 'filesystem', resourceBase: { kind: 'directory', path: directory }, content: standard }
  return { directory, record, result, standard, python }
}

/** DSH's model-facing text for a directory skill (dsh-skill renderSkillContent), which a cell now gets as `content`. */
function rendered(name: string, directory: string, body: string): string {
  return `<skill_content name="${name}">\n<skill_resources>\nBase directory for this skill: ${directory}\n`
    + 'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.\n'
    + `</skill_resources>\n\n<skill_instructions>\n${body}\n</skill_instructions>\n</skill_content>`
}

it('awaits the original binding once and changes only a copy of its successful content', async () => {
  const f = fixture()
  const original = Object.freeze({ ...f.result, resourceBase: Object.freeze(f.result.resourceBase) })
  const args = { name: 'demo' }
  let calls = 0
  const adapted = withPythonSkillDocument('skill', async (actual) => {
    assert.equal(actual, args)
    calls++
    writeFileSync(join(f.directory, 'PYSKILL.md'), f.python + 'Read after authorization.\n')
    return original
  }, [f.record])
  const result = await adapted(args) as typeof original
  assert.equal(calls, 1)
  assert.notEqual(result, original)
  assert.equal(result.content, rendered('demo', f.directory, f.python + 'Read after authorization.\n'))
  assert.deepEqual(Object.keys(result).sort(), Object.keys(original).sort())
  assert.equal(result.provider, original.provider)
  assert.equal(result.resourceBase, original.resourceBase)
  assert.equal(original.content, f.standard)
})

it('propagates the exact original rejection without reading a broken selected file or retrying', async () => {
  const f = fixture()
  unlinkSync(join(f.directory, 'PYSKILL.md'))
  const denial = new Error('skill is not available for model invocation')
  let calls = 0
  const adapted = withPythonSkillDocument('skill', async () => { calls++; throw denial }, [f.record])
  await assert.rejects(adapted({ name: 'demo' }), (error) => error === denial)
  assert.equal(calls, 1)
})

it('matches the real directory through a filesystem symlink', async () => {
  const f = fixture()
  const alias = join(home, 'demo-alias')
  symlinkSync(f.directory, alias, 'dir')
  const original = { ...f.result, resourceBase: { kind: 'directory', path: alias } }
  const result = await withPythonSkillDocument('skill', async () => original, [f.record])({ name: 'demo' }) as typeof original
  assert.equal(result.content, rendered('demo', alias, f.python))
  assert.equal(result.resourceBase, original.resourceBase)
})

it('preserves a project skill that shadows a same-name Python skill from another directory', async () => {
  const registered = fixture()
  const project = fixture('SKILL.md')
  const result = await withPythonSkillDocument('skill', async () => project.result, [registered.record])({ name: 'demo' })
  assert.equal(result, project.result)
})

it('leaves OpenViking and remote resource results untouched, even with a matching name', async () => {
  const f = fixture()
  const originals = [
    { ...f.result, provider: 'openviking', resourceBase: { kind: 'opaque', description: 'viking://~/skills/demo' } },
    { ...f.result, provider: 'remote', resourceBase: { kind: 'url', url: 'https://example.test/demo/' } },
    { ...f.result, provider: 'openviking', resourceBase: { kind: 'directory', path: join(home, 'unregistered-provider') } },
  ]
  for (const original of originals) {
    assert.equal(await withPythonSkillDocument('skill', async () => original, [f.record])({ name: 'demo' }), original)
  }
})

it('preserves a custom provider identity when it owns the exact authorized local resource', async () => {
  const f = fixture()
  const original = { ...f.result, provider: 'configured-local-provider' }
  const result = await withPythonSkillDocument('skill', async () => original, [f.record])({ name: 'demo' }) as typeof original
  assert.equal(result.provider, original.provider)
  assert.equal(result.resourceBase, original.resourceBase)
  assert.equal(result.content, rendered('demo', f.directory, f.python))
})

it('does not adapt unregistered, disabled, docs-only or unavailable Python skill records', async () => {
  const f = fixture()
  const selections: SkillSummary[][] = [
    [], [{ ...f.record, skill: 'another' }],
    [{ ...f.record, import_name: null, src: null, status: 'docs-only' }],
    [{ ...f.record, status: 'unavailable', reason: 'module unavailable' }],
  ]
  for (const records of selections) {
    assert.equal(await withPythonSkillDocument('skill', async () => f.result, records)({ name: 'demo' }), f.result)
  }
})

it('surfaces a discovery document error even if the file is later repaired', async () => {
  const f = fixture()
  const record: SkillSummary = { ...f.record, status: 'unavailable', document_error: 'PYSKILL.md: invalid YAML at discovery' }
  await assert.rejects(withPythonSkillDocument('skill', async () => f.result, [record])({ name: 'demo' }), /instruction document unavailable.*invalid YAML at discovery/)
})

it('does not reselect CLI when the already-selected Python document disappears', async () => {
  const f = fixture()
  unlinkSync(join(f.directory, 'PYSKILL.md'))
  await assert.rejects(withPythonSkillDocument('skill', async () => f.result, [f.record])({ name: 'demo' }), /PYSKILL\.md/)
})

it('uses an explicitly selected SKILL document when no Python document was discovered', async () => {
  const f = fixture('SKILL.md')
  const expected = readSkillDocument(f.directory, 'SKILL.md', 'demo').content
  const result = await withPythonSkillDocument('skill', async () => f.result, [f.record])({ name: 'demo' }) as typeof f.result
  assert.equal(result.content, rendered('demo', f.directory, expected))
})

it('a cell that prints content sees the base directory, as the model does through the skill tool (evolve I-062)', async () => {
  // Field shape 2026-11-09: the cell printed `r['content']`, saw no directory, then read `references/...` from a guessed root.
  const f = fixture()
  const original = { ...f.result, name: 'de"m<o', resourceBase: { kind: 'directory', path: f.directory } }
  const record = { ...f.record, skill: 'de"m<o' }
  writeFileSync(join(f.directory, 'PYSKILL.md'), '---\nname: de"m<o\ndescription: Python guide\n---\nRead references/a&b.md.\n')
  const result = await withPythonSkillDocument('skill', async () => original, [record])({ name: 'de"m<o' }) as typeof original
  const lines = result.content.split('\n')
  assert.equal(lines[0], '<skill_content name="de&quot;m&lt;o">')
  assert.equal(lines[2], `Base directory for this skill: ${f.directory}`)
  assert.ok(result.content.includes('<skill_instructions>\n---\nname: de"m<o\ndescription: Python guide\n---\nRead references/a&b.md.\n\n</skill_instructions>'), 'the body is not escaped, as in DSH')
  assert.deepEqual(Object.keys(result).sort(), Object.keys(original).sort())
})

for (const [label, invalid] of [
  ['invalid YAML', '---\nname: demo\ndescription: [broken\n---\nbody'],
  ['missing description', '---\nname: demo\n---\nbody'],
  ['changed identity', '---\nname: other\ndescription: guide\n---\nbody'],
  ['invalid UTF-8', Buffer.concat([Buffer.from('---\nname: demo\ndescription: guide\n---\n'), Buffer.from([0xc3, 0x28])])],
] as const) {
  it(`rejects a selected Python document with ${label} without falling back`, async () => {
    const f = fixture()
    writeFileSync(join(f.directory, 'PYSKILL.md'), invalid)
    await assert.rejects(withPythonSkillDocument('skill', async () => f.result, [f.record])({ name: 'demo' }), /PYSKILL\.md/)
  })
}

it('rejects a directory in place of the selected instruction file', async () => {
  const f = fixture()
  unlinkSync(join(f.directory, 'PYSKILL.md'))
  mkdirSync(join(f.directory, 'PYSKILL.md'))
  await assert.rejects(withPythonSkillDocument('skill', async () => f.result, [f.record])({ name: 'demo' }), /not a regular file/)
})

it('leaves non-skill bindings and unexpected tool result shapes untouched', async () => {
  const f = fixture()
  const call = async () => f.result
  assert.equal(withPythonSkillDocument('read', call, [f.record]), call)
  const originals: unknown[] = [null, [], { content: f.standard }, { ...f.result, content: null },
    { ...f.result, name: '' }, { ...f.result, provider: null },
    { ...f.result, resourceBase: { kind: 'directory', path: 'relative/path' } }]
  for (const original of originals) {
    assert.equal(await withPythonSkillDocument('skill', async () => original, [f.record])({ name: 'demo' }), original)
  }
})

it('fails explicitly rather than choosing between duplicate matching document records', async () => {
  const f = fixture()
  await assert.rejects(withPythonSkillDocument('skill', async () => f.result, [f.record, { ...f.record }])({ name: 'demo' }), /multiple Python document records/)
})

it('rewrites the durable dispatch-log copy of a skill sub-call to the Python document the cell read', () => {
  const f = fixture()
  const original = [{ type: 'text' as const, text: rendered('demo', f.directory, f.standard) }]
  const out = rewritePythonSkillDispatchLog(original, [f.record])
  assert.ok(out !== undefined)
  assert.equal(out.length, 1)
  assert.equal(out[0]!.type, 'text')
  assert.equal((out[0] as { text: string }).text, rendered('demo', f.directory, f.python))
  // The settled input is not mutated.
  assert.equal((original[0] as { text: string }).text, rendered('demo', f.directory, f.standard))
})

it('keeps the settled log copy for no PYSKILL, no match, a directory mismatch, or a non-directory text', () => {
  const cli = fixture('SKILL.md')
  const f = fixture()
  const dispatched = (dir: string) => [{ type: 'text' as const, text: rendered('demo', dir, f.standard) }]
  assert.equal(rewritePythonSkillDispatchLog(dispatched(cli.directory), [cli.record]), undefined)
  assert.equal(rewritePythonSkillDispatchLog(dispatched(f.directory), []), undefined)
  assert.equal(rewritePythonSkillDispatchLog(dispatched(join(home, 'not-a-skill')), [f.record]), undefined)
  assert.equal(rewritePythonSkillDispatchLog([{ type: 'text' as const, text: 'plain result' }], [f.record]), undefined)
  assert.equal(rewritePythonSkillDispatchLog([], [f.record]), undefined)
})
