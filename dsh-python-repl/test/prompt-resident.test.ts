/**
 * Frequently used non-top-level tools carry their full contract in the prompt.
 *
 * Field regression (2026-09-23): `job_output` was called 84 times from a
 * one-line summary, so the model never saw `timeout_ms`; half its waits timed
 * out at the 30 s default and it fell back to sleep-and-poll loops.
 */

import { strict as assert } from 'node:assert'
import { it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgents } from './fixtures/agents.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as PtcExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import { apply, Config, PythonReplRuntime } from '../src/index.ts'

async function assembleSdk(residentTools?: string[]): Promise<string> {
  const ctx = new Context()
  await mountAgents(ctx)
  await ctx.plugin({ apply, Config }, {
    python: process.env['DSH_PY'] ?? 'python3',
    skillRoots: [],
    ...(residentTools === undefined ? {} : { residentTools }),
  })
  await ctx.plugin(SystemPrompt)
  // 0.2.2-rc.1 起 PTC 模式由单独的执行器插件提供，tools 本身不再有 mode。
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(PtcExecutor, { maxParallelSubCalls: 10 })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const runtime = ctx.get('ptcRuntime') as PythonReplRuntime
  try {
    const register = (name: string, description: string, parameters: Record<string, { type: 'string' | 'number'; description?: string }>) =>
      ctx.get('tools')!.register(defineTool({
        name,
        description,
        parameters: parameters as never,
        output: { schema: { type: 'null' }, render: () => [] },
        execute: async () => null,
      }) as never)
    register('job_output', 'Read a background job. Second sentence the summary drops.', {
      job_id: { type: 'string', description: 'Job id.' },
      timeout_ms: { type: 'number', description: 'Max wait in milliseconds.' },
    })
    register('web_fetch', 'Fetch a URL.', { url: { type: 'string' } })
    register('web_search', 'Search the web.', { query: { type: 'string', description: 'Search query.' } })
    register('present', 'Deliver a file.', { file_path: { type: 'string', description: 'Deliverable path.' } })
    register('read_image', 'Read a PNG/JPEG/WebP/GIF file and return the image itself.', {
      file_path: { type: 'string', description: 'Image path.' },
    })
    const result = await ctx.get('systemPrompt')!.assemble()
    return result.sections.find((section) => section.name === 'tools:sdk')!.text
  } finally {
    await runtime.disposeAll()
  }
}

it('declares resident tools in full and says they are reached through tools', async () => {
  const text = await assembleSdk()
  const [declarations, summaries] = text.split('## Other DSH tools (summaries, not signatures)')
  assert.ok(summaries !== undefined, 'summary section must follow the declarations')
  assert.match(declarations!, /timeout_ms: /)
  assert.match(declarations!, /Also declared in full above, but reached through `tools`.*`tools\.job_output\(\.\.\.\)`/)
  assert.doesNotMatch(summaries, /tools\.job_output/)
  assert.match(summaries, /`tools\.web_fetch\(\.\.\.\)` — Fetch a URL\./)
})

it('declares read_image in full by default', async () => {
  // Session 9ca3a036: from the summary alone, Gemini 3.8 Flash wrote
  // {"image_path": ...} 16 times and never saw an image.
  const [declarations, summaries] = (await assembleSdk()).split('## Other DSH tools (summaries, not signatures)')
  assert.match(declarations!, /file_path: /)
  assert.match(declarations!, /`tools\.read_image\(\.\.\.\)`/)
  assert.doesNotMatch(summaries!, /tools\.read_image/)
})

it('declares web_search and present by default, but keeps explicit resident settings', async () => {
  const [declarations, summaries] = (await assembleSdk()).split('## Other DSH tools (summaries, not signatures)')
  assert.match(declarations!, /query: /)
  assert.match(declarations!, /`tools\.present\(\.\.\.\)`/)
  assert.doesNotMatch(summaries!, /tools\.web_search|tools\.present/)
  const explicit = await assembleSdk(['job_output'])
  assert.doesNotMatch(explicit.split('## Other DSH tools')[0]!, /query: /)
  assert.match(explicit, /`tools\.web_search\(\.\.\.\)` — Search/)
})

it('an empty residentTools setting restores summaries only', async () => {
  const text = await assembleSdk([])
  assert.doesNotMatch(text, /timeout_ms: /)
  assert.doesNotMatch(text, /Also declared in full above/)
  assert.match(text, /`tools\.job_output\(\.\.\.\)` — Read a background job\./)
})
