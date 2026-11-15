import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { executeOne, mountAgents, mountNativeTools } from './host.ts'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { projectToolSchema } from '@deepseek-ai/dsh-tools'
import { renderToolsSdkPy } from '@deepseek-ai/dsh-tool-executor-ptc'
import { fakeWorkingDirectory } from './working-directory.ts'
import { apply, makeGrepTool } from '../src/index.ts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

test('real agent registry shadows ancestor grep and exposes scope in Python SDK', async () => {
  const ctx = new Context()
  await mountAgents(ctx)
  await ctx.plugin(SystemPrompt)
  await mountNativeTools(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  const moved = new Map<string, string>()
  ctx.provide('workingDirectory', fakeWorkingDirectory(moved) as never)
  await tick()
  assert.ok(ctx.get('subprocess'))
  const ancestor = { id: 'preset' }
  const ancestorScope = createScope(ctx, ancestor)
  const dir = mkdtempSync(join(tmpdir(), 'grep-scope-integration-'))
  mkdirSync(join(dir, '.hidden'))
  writeFileSync(join(dir, 'visible.txt'), 'needle_here\n')
  writeFileSync(join(dir, '.hidden', 'hidden.txt'), 'needle_here\n')
  const agent = { id: 'grep-agent', sessionId: 'grep-agent' } as unknown as Agent
  const agentScope = createScope(ctx, agent, { parent: ancestor })
  Object.defineProperty(agent, 'ctx', { value: agentScope.ctx })
  Object.defineProperty(agent, 'session', { value: { id: 'grep-agent', header: { id: 'grep-agent', cwd: dir } } })
  ancestorScope.ctx.get('tools')!.register(defineTool({
    name: 'grep', description: 'Unmodified built-in grep',
    parameters: { pattern: { type: 'string', required: true } },
    output: { schema: { type: 'null' }, render: () => [] }, execute: async () => null,
  }))
  const registry = ctx.get('tools')!
  const original = registry.get('grep', agent)
  assert.ok(original)
  const mockCtx = { tools: registry } as Context
  assert.equal(typeof makeGrepTool(mockCtx).execute, 'function')
  const stop = ctx.agents.register(agent)
  assert.equal(registry.get('grep', agent), original, 'already-open agent still uses official grep before activation')
  const plugin = await ctx.plugin({ apply, inject: ['tools', 'subprocess', 'systemPrompt', 'agents', 'workingDirectory'] })
  await tick()
  try {
    const replacement = registry.get('grep', agent)
    assert.ok(replacement)
    assert.notEqual(replacement, original)
    assert.equal(registry.get('grep', ancestor), original)
    // 0.2.2-rc.1 删了 sdkSchemas：照官方 PTC 执行器，可见定义投影成 schema 再补输出类型。
    const schema = registry.definitions(agent).filter(row => row.name === 'grep').map(row => ({ ...projectToolSchema(row, false), output: row.output.schema }))[0]
    assert.ok(schema)
    assert.ok('scope' in (schema.parameters as { properties: Record<string, unknown> }).properties)
    const sdk = renderToolsSdkPy([schema as never])
    assert.match(sdk, /scope/)
    assert.match(sdk, /unreadable: NotRequired\[/, 'the partial-result field is optional so the official {matches} shape stays valid')
    assert.match(replacement.description, /scope all includes hidden and ignored/)
    const call = async (scope: 'normal' | 'all') => executeOne(registry, {
      callId: `grep-${scope}` as never, name: 'grep', arguments: { pattern: 'needle_here', scope },
      agent, signal: new AbortController().signal,
    })
    const normal = await call('normal')
    assert.equal(normal.isError, false, JSON.stringify(normal))
    assert.equal((normal.value as { matches: unknown[] }).matches.length, 1)
    const all = await call('all')
    assert.equal(all.isError, false, JSON.stringify(all))
    assert.equal((all.value as { matches: unknown[] }).matches.length, 2)
    const elsewhere = join(dir, 'elsewhere')
    mkdirSync(elsewhere)
    moved.set('grep-agent', elsewhere)
    const afterCd = await executeOne(registry, {
      callId: 'grep-after-cd' as never, name: 'grep', arguments: { pattern: 'needle_here', path: 'missing' },
      agent, signal: new AbortController().signal,
    })
    assert.equal(afterCd.isError, true)
    assert.match(JSON.stringify(afterCd), new RegExp(`相对路径按工作区 ${elsewhere.replace(/[/.]/g, '\\$&')} 解析`), 'paths resolve against the current working directory, not the starting one')
    moved.delete('grep-agent')
    await plugin.dispose()
    assert.equal(registry.get('grep', agent), original, 'plugin unload restores official grep on the same agent')
  } finally {
    await plugin.dispose()
    stop()
    assert.equal(registry.get('grep', agent), original)
    await agentScope.dispose()
    await ancestorScope.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
