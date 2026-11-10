import { strict as assert } from 'node:assert'
import { it } from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { type Agent } from '@deepseek-ai/dsh-agent'
import { mountAgents } from './fixtures/agents.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as PtcExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import { apply, Config, PythonReplRuntime } from '../src/index.ts'

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-repl-skills-'))
  const roots = join(dir, 'skills')
  const src = join(roots, 'sample', 'src', 'sample')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(roots, 'sample', 'SKILL.md'), '---\nname: sample\ndescription: Static fixture\n---\nInstructions')
  writeFileSync(join(src, '__init__.py'), `from pathlib import Path\nPath(${JSON.stringify(join(dir, 'imported'))}).touch()\nraise RuntimeError("fixture import failure")\n`)
  const ctx = new Context()
  await mountAgents(ctx)
  // projectSkillRoots: [] — tests run inside the plugins repository, whose own .agents/skills must not leak in.
  await ctx.plugin({ apply, Config }, { python: process.env['DSH_PY'] ?? 'python3', skillRoots: [roots], projectSkillRoots: [] })
  await ctx.plugin(SystemPrompt)
  // 0.2.2-rc.1 起 PTC 模式由单独的执行器插件提供，tools 本身不再有 mode。
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(PtcExecutor, { maxParallelSubCalls: 10 })
  await new Promise<void>((resolve) => setImmediate(resolve))
  ctx.get('tools')!.register(defineTool({ name: 'read', description: 'Read.', parameters: {}, output: { schema: { type: 'null' }, render: () => [] }, execute: async () => null }) as never)
  const runtime = ctx.get('ptcRuntime') as PythonReplRuntime
  const scope = { id: 'agent-1', sessionId: dir } as unknown as Agent
  const assemble = () => ctx.get('systemPrompt')!.assemble({ scope })
  return { dir, ctx, roots, runtime, scope, assemble, cleanup: async () => { await runtime.disposeAll(); rmSync(dir, { recursive: true, force: true }) } }
}

it('discovers configured skills without importing and keeps the system prefix stable after a failed import and restart', async () => {
  const f = await fixture()
  try {
    const before = await f.assemble()
    const sdk = before.sections.find(s => s.name === 'tools:sdk')!.text
    assert.match(sdk, /`skills\.sample` — sample/)
    assert.equal(existsSync(join(f.dir, 'imported')), false)
    await f.ctx.get('agents')!.withInitiator(f.scope, () => f.runtime.run({ program: '1', bindings: [], signal: undefined } as never))
    const after = await f.assemble()
    assert.equal(after.sections.find(s => s.name === 'tools:sdk')!.text, sdk)
    assert.match(after.contexts.map(c => c.text).join('\n'), /fixture import failure/)
    assert.deepEqual(f.runtime.knownSkills('other-session'), f.runtime.knownSkills(f.dir))
    await f.ctx.get('agents')!.withInitiator(f.scope, () => f.runtime.run({ program: 'await repl.restart()', bindings: [], signal: undefined } as never))
    assert.equal((await f.assemble()).sections.find(s => s.name === 'tools:sdk')!.text, sdk)
  } finally { await f.cleanup() }
})

it('uses one host-relative skill root snapshot across different session workspaces', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-repl-relative-roots-'))
  const root = join(dir, 'trusted')
  const src = join(root, 'host_skill', 'src', 'host_skill')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(root, 'host_skill', 'SKILL.md'), '---\nname: host_skill\ndescription: Host trusted skill\n---\n')
  writeFileSync(join(src, '__init__.py'), 'ORIGIN = "host-trusted"\n')
  const ctx = new Context()
  await mountAgents(ctx)
  const hostCwd = process.cwd()
  try {
    process.chdir(dir)
    await ctx.plugin(PythonReplRuntime, Config({ python: process.env['DSH_PY'] ?? 'python3', skillRoots: ['trusted'] }))
    await new Promise<void>((resolve) => setImmediate(resolve))
    const initializing = ctx.get('ptcRuntime') as PythonReplRuntime
    assert.equal(initializing.knownSkills('relative-workspace-a')[0]?.import_name, 'host_skill')
  } finally { process.chdir(hostCwd) }
  await new Promise<void>((resolve) => setImmediate(resolve))
  const runtime = ctx.get('ptcRuntime') as PythonReplRuntime
  try {
    for (const workspace of ['workspace-a', 'workspace-b']) {
      const cwd = join(dir, workspace)
      mkdirSync(cwd)
      const key = `relative-${workspace}`
      const before = runtime.knownSkills(key)
      assert.equal(before[0]?.import_name, 'host_skill')
      const session = runtime.sessionFor(key, cwd)
      const result = await session.runCell('skills.host_skill.ORIGIN', new Map())
      assert.equal(result.error, undefined, JSON.stringify(result))
      assert.match(result.logs.join(''), /host-trusted/)
      assert.deepEqual(runtime.knownSkills(key), before)
      const context = await runtime.stateContext(key)
      assert.match(context, /Relative configured roots are resolved against the host configuration base/)
      assert.doesNotMatch(context, /Configuration changed/)
    }
  } finally { await runtime.disposeAll(); rmSync(dir, { recursive: true, force: true }) }
})

it('keeps existing session roots pinned while new sessions use explicit live configuration', async () => {
  const f = await fixture()
  try {
    f.runtime.sessionFor(f.dir)
    const config = Config({ skillRoots: [f.roots], projectSkillRoots: [] })
    const ctx = new Context()
    await mountAgents(ctx)
    await ctx.plugin(PythonReplRuntime, config)
    await new Promise<void>((resolve) => setImmediate(resolve))
    const runtime = ctx.get('ptcRuntime') as PythonReplRuntime
    try {
      runtime.sessionFor('existing')
      const next = Config({ skillRoots: [] })
      const cell = config.skillRoots as unknown as Record<symbol, (value: unknown) => void>
      cell[Symbol.for('cosmokit.volatile.write')]!((next.skillRoots as unknown as { get(): string[] }).get())
      assert.equal(runtime.knownSkills('existing')[0]?.import_name, 'sample')
      assert.deepEqual(runtime.knownSkills('new-session'), [])
      assert.match(await runtime.stateContext('existing'), /retains its startup roots/)
    } finally { await runtime.disposeAll() }
  } finally { await f.cleanup() }
})

it('says a saved state exists after a host restart', async () => {
  const f = await fixture()
  try {
    await f.ctx.get('agents')!.withInitiator(f.scope, () => f.runtime.run({ program: 'computed = list(range(3))', bindings: [], signal: undefined } as never))
    await f.runtime.disposeAll()
    const context = (await f.assemble()).contexts.map(c => c.text).join('\n')
    assert.match(context, /A saved Python state exists for this session/)
  } finally { await f.cleanup() }
})

it('assembles session-local kernel state as dynamic context before the next cell', async () => {
  const f = await fixture()
  try {
    const before = await f.assemble()
    assert.match(before.contexts.map(c => c.text).join('\n'), /not started/)
    const first = await f.ctx.get('agents')!.withInitiator(f.scope, () => f.runtime.run({ program: 'answer = 42\ncomputed = list(range(3))', bindings: [], signal: undefined } as never))
    assert.equal(first.error, undefined)
    assert.match((await f.assemble()).contexts.map(c => c.text).join('\n'), /running/)
    await f.runtime.releaseIfUnused(f.scope)
    assert.match((await f.assemble()).contexts.map(c => c.text).join('\n'), /not started/)
    const reopened = await f.ctx.get('agents')!.withInitiator(f.scope, () => f.runtime.run({ program: 'answer', bindings: [], signal: undefined } as never))
    assert.equal(reopened.error, undefined)
    assert.match(reopened.logs.join('\n'), /42/)
    assert.match(reopened.logs.join('\n'), /2 names are back\.\nVariables[^\n]*: (answer, computed|computed, answer)\./)
    await f.runtime.disposeAll()
    const restart = await f.assemble()
    assert.match(restart.contexts.map(c => c.text).join('\n'), /A saved Python state exists for this session/)
  } finally { await f.cleanup() }
})

it('keeps the dynamic context text stable while saved variables keep changing', async () => {
  const f = await fixture()
  try {
    const run = (program: string) => f.ctx.get('agents')!.withInitiator(f.scope, () => f.runtime.run({ program, bindings: [], signal: undefined } as never))
    await run('first = 1')
    await sleep(2_000)
    const before = (await f.assemble()).contexts.map(c => c.text).join('\n')
    assert.match(before, /A saved Python state exists for this session/)
    await run('second = 2')
    await sleep(2_000)
    const after = (await f.assemble()).contexts.map(c => c.text).join('\n')
    assert.equal(after, before)
  } finally { await f.cleanup() }
})
