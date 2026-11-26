import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { Config, PYTHON_SKILLS_SERVICE, PythonReplRuntime, type PythonSkillsService } from '../src/index.ts'
import { mountAgents } from './fixtures/agents.ts'
import './fixtures/isolated-home.mjs'
import { testKernelPython } from './fixtures/test-kernel.ts'

function makeSkill(base: string, origin: string): string {
  const root = join(base, origin)
  const pkg = join(root, 'src', 'fixture_reader')
  mkdirSync(pkg, { recursive: true })
  writeFileSync(join(root, 'SKILL.md'), '---\nname: fixture-reader\ndescription: Read fixture data\n---\n')
  writeFileSync(join(pkg, '__init__.py'), `ORIGIN = ${JSON.stringify(origin)}\n`)
  return root
}

it('discovers linked skills for new sessions and settings while running kernels keep their bindings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-skill-bindings-'))
  const trusted = join(dir, 'trusted')
  const repo = join(dir, 'project')
  const projectSkills = join(repo, '.agents', 'skills')
  const workspace = join(repo, 'docs')
  const personalLink = join(trusted, 'fixture-reader')
  const projectLink = join(projectSkills, 'fixture-reader')
  const ctx = new Context()
  let runtime: PythonReplRuntime | undefined
  try {
    mkdirSync(trusted)
    mkdirSync(projectSkills, { recursive: true })
    mkdirSync(join(repo, '.git'))
    mkdirSync(workspace)
    await mountAgents(ctx)
    await ctx.plugin(PythonReplRuntime, Config({ python: await testKernelPython(), skillRoots: [trusted] }))
    await new Promise<void>((resolve) => setImmediate(resolve))
    runtime = ctx.get('ptcRuntime') as PythonReplRuntime
    const settings = ctx.get(PYTHON_SKILLS_SERVICE as never) as PythonSkillsService | undefined
    assert.ok(settings)
    const origin = async (key: string, cwd = workspace) => {
      const session = runtime!.sessionFor(key, cwd)
      const cell = await session.runCell(`getattr(getattr(skills, 'fixture_reader', None), 'ORIGIN', 'absent')`, new Map())
      assert.equal(cell.error, undefined, JSON.stringify(cell))
      return cell.logs[0]?.split('\n')[0]
    }
    assert.deepEqual(settings.list(workspace), [])
    assert.equal(await origin('started-before-install'), "'absent'")
    assert.deepEqual(runtime.knownSkills('preview-before-install', workspace), [])

    symlinkSync(makeSkill(dir, 'personal'), personalLink)
    assert.equal(await origin('preview-before-install'), "'personal'")
    assert.deepEqual(settings.list(workspace).map((skill) => skill.path), [personalLink])
    assert.deepEqual(runtime.knownSkills('started-before-install', workspace), [])

    symlinkSync(makeSkill(dir, 'project-copy'), projectLink)
    assert.deepEqual(settings.list(workspace).map((skill) => skill.path), [projectLink])
    assert.deepEqual(await Promise.all([origin('same-project'), origin('outside', dir)]), ["'project-copy'", "'personal'"])
    assert.equal(await origin('preview-before-install'), "'personal'")

    unlinkSync(projectLink)
    unlinkSync(personalLink)
    assert.deepEqual(settings.list(workspace), [])
    assert.deepEqual(runtime.knownSkills('same-project', workspace).map((skill) => skill.path), [projectLink])
    assert.equal(await origin('same-project'), "'project-copy'")
    assert.equal(await origin('after-uninstall'), "'absent'")
    await runtime.releaseIfUnused({ id: 'fixture-agent', sessionId: 'same-project' })
    assert.equal(await origin('same-project'), "'absent'")
  } finally {
    await runtime?.disposeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})
