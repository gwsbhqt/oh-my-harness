import { strict as assert } from 'node:assert'
import { it } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { mountAgents } from './fixtures/agents.ts'
import { Config, PythonReplRuntime } from '../src/index.ts'

function addSkill(root: string, name: string, origin: string) {
  const pkg = name.replace(/-/g, '_')
  mkdirSync(join(root, name, 'src', pkg), { recursive: true })
  writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} from ${origin}\n---\n`)
  writeFileSync(join(root, name, 'src', pkg, '__init__.py'), `ORIGIN = ${JSON.stringify(origin)}\n`)
}

async function runtimeWith(config: Record<string, unknown>) {
  const ctx = new Context()
  await mountAgents(ctx)
  await ctx.plugin(PythonReplRuntime, Config({ python: process.env['DSH_PY'] ?? 'python3', ...config }))
  await new Promise<void>((resolve) => setImmediate(resolve))
  return ctx.get('ptcRuntime') as PythonReplRuntime
}

it('imports the session project\'s .agents/skills ahead of same-named configured skills, and only inside that project', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-repl-project-skills-'))
  const trusted = join(dir, 'trusted')
  addSkill(trusted, 'shared', 'global')
  addSkill(trusted, 'global-only', 'global')
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, '.git'), { recursive: true })
  mkdirSync(join(repo, 'docs'), { recursive: true })
  addSkill(join(repo, '.agents', 'skills'), 'shared', 'project')
  addSkill(join(repo, '.agents', 'skills'), 'repo-only', 'project')
  const outside = join(dir, 'elsewhere')
  mkdirSync(outside)
  const runtime = await runtimeWith({ skillRoots: [trusted] })
  try {
    const inRepo = runtime.sessionFor('in-repo', join(repo, 'docs'))
    const result = await inRepo.runCell('print(skills.shared.ORIGIN, skills.repo_only.ORIGIN, skills.global_only.ORIGIN)', new Map())
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.match(result.logs.join(''), /project project global/)
    assert.deepEqual(runtime.knownSkills('in-repo').map((s) => s.skill), ['repo-only', 'shared', 'global-only'])
    const context = await runtime.stateContext('in-repo')
    assert.match(context, /Project Python skill roots for this session's repository/)
    assert.match(context, /trusted\/shared: shadowed by the project skill/)

    const away = runtime.sessionFor('outside', outside)
    const other = await away.runCell('print(skills.shared.ORIGIN, hasattr(skills, "repo_only"))', new Map())
    assert.equal(other.error, undefined, JSON.stringify(other))
    assert.match(other.logs.join(''), /global False/)
    assert.doesNotMatch(await runtime.stateContext('outside'), /Project Python skill roots|shadowed/)
  } finally { await runtime.disposeAll() }

  const off = await runtimeWith({ skillRoots: [trusted], projectSkillRoots: [] })
  try {
    assert.deepEqual(off.knownSkills('off', join(repo, 'docs')).map((s) => s.skill), ['global-only', 'shared'], 'projectSkillRoots: [] scans only skillRoots')
  } finally { await off.disposeAll(); rmSync(dir, { recursive: true, force: true }) }
})

it('passes profile rename hints into new kernels without creating aliases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-repl-rename-hints-'))
  addSkill(dir, 'demo-reader', 'fixture')
  const runtime = await runtimeWith({ skillRoots: [dir], projectSkillRoots: [], skillRenames: { old: 'demo_reader', gone: 'missing' } })
  try {
    const session = runtime.sessionFor('rename-hints')
    const hint = await session.runCell('skills.old', new Map())
    assert.match(hint.error?.message ?? '', /did you mean skills.demo_reader/)
    const missing = await session.runCell('skills.gone', new Map())
    assert.doesNotMatch(missing.error?.message ?? '', /did you mean/)
    const report = await session.runCell('await skills.list()', new Map())
    assert.equal(report.error, undefined)
    assert.doesNotMatch(report.logs.join(''), /skills.old/)
  } finally { await runtime.disposeAll(); rmSync(dir, { recursive: true, force: true }) }
})

it('does not count a configured root twice when the project is the directory that holds it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-repl-home-project-'))
  const trusted = join(home, '.agents', 'skills')
  addSkill(trusted, 'personal', 'global')
  const runtime = await runtimeWith({ skillRoots: [trusted] })
  try {
    assert.deepEqual(runtime.knownSkills('home', home).map((s) => s.skill), ['personal'])
    const context = await runtime.stateContext('home', home)
    assert.doesNotMatch(context, /shadowed|Project Python skill roots/)
  } finally { await runtime.disposeAll(); rmSync(home, { recursive: true, force: true }) }
})
