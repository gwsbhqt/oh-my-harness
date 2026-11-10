/**
 * SMOKE: the whole stack, nothing faked.
 *
 * Real cordis host + real dsh-tools in PTC mode + real systemPrompt + THIS
 * plugin's real Python kernel. A cell goes in through the official `run_code`
 * tool; a real registered DSH tool is called back from Python; the result the
 * model would see comes out.
 *
 * If this passes, the seam composes for real — not in a stub.
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { type Agent } from '@deepseek-ai/dsh-agent'
import { mountAgents } from './fixtures/agents.ts'
import { defineTool, ToolRuntime, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as PtcExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { PythonReplRuntime } from '../src/index.ts'
const builtPlugin = await import(new URL('../lib/index.js', import.meta.url).href)
import { CELL_INSTRUCTIONS } from '../src/prompt.ts'

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

interface Harness {
  ctx: Context
  calls: unknown[]
  runCode: (code: string) => Promise<ToolExecutionResult>
  dispose: () => Promise<void>
}

async function boot(): Promise<Harness> {
  const ctx = new Context()
  const calls: unknown[] = []

  await mountAgents(ctx)
  await tick()
  // Same module-unwrapping rule as cordis-plugin-loader, on the BUILD output.
  // Never bypass apply by instantiating the runtime class in this smoke test.
  const loaded = Reflect.get(builtPlugin, 'default') ?? builtPlugin
  await ctx.plugin(loaded, { python: process.env['DSH_PY'] ?? 'python3', startupTimeoutMs: 30_000, teardownGraceMs: 5_000, interruptGraceMs: 5_000, skillRoots: [] })
  await tick()
  await ctx.plugin(SystemPrompt)
  await tick()
  // 0.2.2-rc.1 起 PTC 模式由单独的执行器插件提供，tools 本身不再有 mode。
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(PtcExecutor, { maxParallelSubCalls: 10 })
  await tick()

  // A real registered DSH tool, defined with the host's own helper.
  ctx.get('tools')?.register(
    defineTool({
      name: 'word_count',
      description: 'Count words in a piece of text.',
      parameters: { text: { type: 'string' } },
      output: {
        schema: {
          type: 'object',
          properties: { words: { type: 'number' }, chars: { type: 'number' } },
          additionalProperties: false,
        },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
      },
      async execute(args: { text: string }) {
        calls.push(args)
        return { words: args.text.trim().split(/\s+/).filter(Boolean).length, chars: args.text.length }
      },
    }) as never,
  )

  for (const name of ['read', 'write', 'edit', 'bash', 'glob', 'grep']) {
    ctx.tools.register(defineTool({
      name, description: `Core contract for ${name}.`,
      parameters: { path: { type: 'string' } },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute(args: { path: string }) { return args.path },
    }))
  }

  // One identity for the whole smoke run: the agent loop establishes exactly
  // this boundary before dispatching, and our runtime keys the kernel off it.
  const agent = { id: 'smoke-agent', sessionId: 'smoke-session' } as unknown as Agent

  const runCode = async (code: string): Promise<ToolExecutionResult> => {
    const tools = ctx.get('tools')
    const agents = ctx.get('agents')
    assert.ok(tools, 'tools service must be present')
    assert.ok(agents, 'agents service must be present')
    // 0.2.2-rc.1 起执行入口按批：模型原样的调用块进去，按调用编号取回每条结果。
    const batch = await agents.withInitiator(agent, () =>
      tools.execute({
        calls: [{ type: 'tool-call', id: `smoke-${Math.random().toString(36).slice(2)}` as never, name: 'run_code', arguments: JSON.stringify({ code, description: 'smoke test cell' }) }],
        signal: new AbortController().signal,
      }),
    )
    return batch.results[0]!.result
  }

  return {
    ctx,
    calls,
    runCode,
    dispose: async () => {
      // Tear the kernel down explicitly: the runtime's cordis effect fires on
      // host disposal, but tests must not depend on host lifecycle ordering.
      const runtime = ctx.get('ptcRuntime') as PythonReplRuntime | undefined
      await runtime?.disposeAll()
    },
  }
}

describe('SMOKE: run_code → PTC → Python kernel → DSH tool', () => {
  let harness: Harness | undefined
  after(async () => { await harness?.dispose() })

  it('runs a real cell end to end and calls a real DSH tool', async () => {
    harness = await boot()

    // 1. The seam picked OUR runtime.
    const runtime = harness.ctx.get('ptcRuntime')
    assert.equal(runtime?.language, 'python')
    assert.equal(runtime?.isolation, 'process')

    // 2. The prompt the model would receive describes CELLS, not function bodies.
    const assembly = await harness.ctx.systemPrompt.assemble({})
    const sdk = assembly.sections.find((s) => s.name === 'tools:sdk')
    assert.ok(sdk, 'tools:sdk section must exist in ptc mode')
    const shown = sdk.text
    assert.ok(shown.startsWith(CELL_INSTRUCTIONS), 'the assembled prompt carries the cell instructions, not the function-body preamble')
    assert.match(shown, /tools.word_count/, 'the real tool summary is available')
    assert.doesNotMatch(shown, /async def word_count/, 'non-core signatures are disclosed on demand')
    for (const name of ['read', 'write', 'edit', 'bash', 'glob', 'grep']) {
      assert.match(shown, new RegExp(`async def ${name}`), 'core contracts remain fully declared')
    }
    const transport = assembly.tools.find((t) => t.name === 'run_code')
    assert.ok(transport)
    assert.match(transport.description, /persistent Python cell/)
    assert.doesNotMatch(JSON.stringify(transport), /BODY of an async function|top-level.*return.*work/)
    const contract = await harness.runCode('(await tools.describe("word_count"))["items"][0]["returns"]["properties"]')
    assert.equal(contract.isError, false, JSON.stringify(contract))
    assert.match(JSON.stringify(contract.value), /words/)
    assert.match(JSON.stringify(contract.value), /chars/)
    const core = await harness.runCode('[await fn({"path": "fixture"}) for fn in (read, write, edit, bash, glob, grep)]')
    assert.equal(core.isError, false, JSON.stringify(core))
    assert.match(JSON.stringify(core.value), /fixture/)

    // 3. A cell calls the real tool; the canonical JSON value lands in Python.
    const first = await harness.runCode(
      'result = await tools.word_count({"text": "the quick brown fox"})\n' +
      'result["words"]\n',
    )
    assert.equal(first.isError, false, JSON.stringify(first))
    assert.deepEqual(harness.calls, [{ text: 'the quick brown fox' }])
    assert.match(JSON.stringify(first.value), /4/, 'trailing expression shows the word count')

    // 4. State PERSISTS: the next cell reuses the variable from the previous one.
    const second = await harness.runCode('result["chars"]')
    assert.equal(second.isError, false, JSON.stringify(second))
    assert.match(JSON.stringify(second.value), /19/, 'the kernel kept `result` across cells')

    // 5. The data-stays-in-the-kernel property: a big object is NOT in the output.
    const third = await harness.runCode(
      'rows = [{"id": i, "payload": "x" * 500} for i in range(200)]\n' +
      'len(rows)\n',
    )
    assert.equal(third.isError, false, JSON.stringify(third))
    const rendered = JSON.stringify(third.value)
    assert.match(rendered, /200/, 'the size is reported')
    assert.ok(rendered.length < 500, `only the size crossed into the context, got ${rendered.length} chars`)

    assert.deepEqual(harness.calls, [{ text: 'the quick brown fox' }], 'local inspection never repeats a tool')
  })

  it('reports a top-level return as a real Python SyntaxError', async () => {
    harness ??= await boot()
    const result = await harness.runCode('return 42')
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result), /SyntaxError/)
  })
})
