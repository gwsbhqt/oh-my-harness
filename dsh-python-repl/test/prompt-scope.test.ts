import { strict as assert } from 'node:assert'
import { createRequire } from 'node:module'
import { it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { type Agent } from '@deepseek-ai/dsh-agent'
import { mountAgents } from './fixtures/agents.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as PtcExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import { apply, Config, PythonReplRuntime } from '../src/index.ts'

// Use the same scope package instance as the actual tool registry.
const require = createRequire(import.meta.url)
const { createScope } = await import(require.resolve('@deepseek-ai/dsh-scope', {
  paths: [require.resolve('@deepseek-ai/dsh-tools')],
}))

it('prompt assembly honors explicit/global scope independently of the ambient initiator', async () => {
  const ctx = new Context()
  await mountAgents(ctx)
  await ctx.plugin({ apply, Config }, { python: process.env['DSH_PY'] ?? 'python3', skillRoots: [] })
  await ctx.plugin(SystemPrompt)
  // 0.2.2-rc.1 起 PTC 模式由单独的执行器插件提供，tools 本身不再有 mode。
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(PtcExecutor, { maxParallelSubCalls: 10 })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const runtime = ctx.get('ptcRuntime') as PythonReplRuntime
  try {
    const a = { id: 'scope-a', sessionId: 'scope-a' } as unknown as Agent
    const b = { id: 'scope-b', sessionId: 'scope-b' } as unknown as Agent
    const register = (owner: Context, name: string) => owner.get('tools')!.register(defineTool({
      name,
      description: `Contract for ${name}`,
      parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      execute: async () => null,
    }) as never)
    register(ctx, 'global_probe')
    register(createScope(ctx, a).ctx, 'private_a_probe')
    register(createScope(ctx, b).ctx, 'private_b_probe')
    const prompt = ctx.get('systemPrompt')!
    const agents = ctx.get('agents')!
    const sdk = (result: Awaited<ReturnType<typeof prompt.assemble>>) =>
      result.sections.find((section) => section.name === 'tools:sdk')!.text

    const globalText = sdk(await agents.withInitiator(a, () => prompt.assemble()))
    assert.match(globalText, /global_probe/)
    assert.doesNotMatch(globalText, /private_[ab]_probe/)

    const bText = sdk(await agents.withInitiator(a, () => prompt.assemble({ scope: b })))
    assert.match(bText, /global_probe/)
    assert.match(bText, /private_b_probe/)
    assert.doesNotMatch(bText, /private_a_probe/)

    const aText = sdk(await agents.withInitiator(b, () => prompt.assemble({ scope: a })))
    assert.match(aText, /private_a_probe/)
    assert.doesNotMatch(aText, /private_b_probe/)
  } finally {
    await runtime.disposeAll()
  }
})
