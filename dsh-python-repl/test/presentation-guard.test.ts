import { strict as assert } from 'node:assert'
import { it } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as PtcExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { apply, Config, PythonReplRuntime } from '../src/index.ts'
import { createPresentationGuard, expectedPtc, type AssemblyLike } from '../src/presentation-guard.ts'

const ERROR = 'python-repl:presentation-error'
function signals(composed: unknown, selected: unknown, initialized = true) {
  return { get(name: string) {
    if (name === 'tools') return initialized ? {} : undefined
    if (name === 'agentPresets') return { composedPreset: () => composed }
    if (name === 'sessionProjections') return { stateOf: () => selected }
  } } as unknown as Context
}
it('does not warn while the tool registry has not initialized', () => {
  const logs: string[] = []
  const ctx = Object.assign(signals(undefined, undefined, false), { logger: { error: (text: string) => logs.push(text) } })
  const guard = createPresentationGuard(ctx)
  const assembly = { sections: [], contexts: [], variables: {} }
  guard(assembly, { session: { id: 'initializing', header: { agentPreset: 'ptc' } } })
  assert.deepEqual(assembly.contexts, [])
  assert.deepEqual(logs, [])
})

it('uses current public selection rather than a stale creation header', () => {
  const scope = { ctx: new Context(), session: { header: { agentPreset: 'ptc' } } }
  for (const selected of ['standard', 'cordis', null, false, 12, {}]) {
    assert.equal(expectedPtc(signals(undefined, selected), scope), false)
  }
  assert.equal(expectedPtc(signals(undefined, 'ptc'), { session: { header: {} } }), true)
  assert.equal(expectedPtc(signals('standard', 'ptc'), scope), false)
  assert.equal(expectedPtc(signals('cordis', 'ptc'), scope), false)
  assert.equal(expectedPtc(signals('ptc', 'standard'), scope), true)
  assert.equal(expectedPtc(signals(undefined, undefined), scope), true)
})

it('keeps a not-yet-calculated tool surface unknown and removes only its own dynamic error', () => {
  const logs: string[] = []
  const ctx = Object.assign(signals(undefined, undefined), { logger: { error: (text: string) => logs.push(text) } })
  const guard = createPresentationGuard(ctx)
  const scope = { session: { id: 'incomplete', header: { agentPreset: 'ptc' } } }
  const assembly = { contexts: [{ name: 'other', text: 'retain me' }], variables: {} } as unknown as AssemblyLike
  guard(assembly, scope)
  assert.equal(logs.length, 0)
  assert.deepEqual(assembly.contexts, [{ name: 'other', text: 'retain me' }])
  assembly.sections = []
  guard(assembly, scope)
  guard(assembly, scope)
  assert.equal(assembly.contexts.filter(c => c.name === ERROR).length, 1)
  assert.equal(logs.length, 1)
  assembly.sections = [{ name: 'tools:sdk' }]
  guard(assembly, scope)
  assert.deepEqual(assembly.contexts, [{ name: 'other', text: 'retain me' }])
})

it('the hook gets no tool array: the PTC executor\'s tools:sdk section decides', () => {
  const logs: string[] = []
  const ctx = Object.assign(signals(undefined, undefined), { logger: { error: (text: string) => logs.push(text) } })
  const guard = createPresentationGuard(ctx)
  const scope = { session: { id: 'sections-only', header: { agentPreset: 'ptc' } } }
  const assembly: AssemblyLike = { sections: [{ name: 'persona' }], contexts: [] }
  guard(assembly, scope)
  assert.equal(assembly.contexts.filter(c => c.name === ERROR).length, 1)
  assembly.sections = [{ name: 'persona' }, { name: 'tools:sdk' }]
  guard(assembly, scope)
  assert.deepEqual(assembly.contexts, [])
  assert.equal(logs.length, 1)
})

it('isolates warning deduplication across sessions and never trusts malformed legacy ids', () => {
  const logs: string[] = []
  const ctx = Object.assign(signals(undefined, undefined), { logger: { error: (text: string) => logs.push(text) } })
  const guard = createPresentationGuard(ctx)
  const assembly = { sections: [], contexts: [], variables: {} }
  const first = { id: 'agent-1', session: { id: 'session-1', header: { agentPreset: 'ptc' } } }
  const second = { id: 'agent-2', session: { id: 'session-2', header: { agentPreset: 'ptc' } } }
  guard(assembly, first)
  guard(assembly, { ...first, id: 'another-agent' })
  guard(assembly, second)
  assert.equal(logs.length, 2)
  assert.match(logs[0]!, /session-1/)
  assert.match(logs[1]!, /session-2/)
  guard(assembly, { id: {}, session: { id: 42, header: { agentPreset: 'ptc' } } })
  assert.equal(logs.length, 2)
  assert.deepEqual(assembly.contexts, [])
})

async function fixture(mode = 'native') {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  // 0.2.2-rc.1 起 PTC 模式由单独的执行器插件提供，tools 本身不再有 mode。
  await ctx.plugin(ToolRuntime)
  if (mode === 'ptc') await ctx.plugin(PtcExecutor, { maxParallelSubCalls: 10 })
  else await ctx.plugin(NativeExecutor)
  const logs: string[] = []
  const logger = ctx.logger('presentation-test')
  logger.error = (message: unknown) => { logs.push(String(message)) }
  Object.defineProperty(ctx, 'logger', { value: logger })
  await ctx.plugin({ apply, Config }, { python: process.env['DSH_PY'] ?? 'python3', skillRoots: [] })
  await ctx.fiber.await()
  const session = { id: 'guard-session', header: { agentPreset: 'ptc' } }
  const scope = { id: session.id, sessionId: session.id, session, ctx }
  const assemble = () => ctx.get('systemPrompt')!.assemble({ scope })
  const errors = async () => (await assemble()).contexts.filter(c => c.name === ERROR)
  return { ctx, scope, session, logs, assemble, errors, cleanup: async () => {
    await (ctx.get('ptcRuntime') as PythonReplRuntime).disposeAll()
    await ctx.fiber.dispose()
  } }
}

it('warns for a recorded PTC session before any SDK gate, once per session, without steering or changing the prefix', async () => {
  const f = await fixture()
  try {
    Object.assign(f.scope, { steer: () => { throw new Error('must not wake the agent') } })
    const first = await f.assemble()
    assert.ok(!first.sections.some(s => s.name === 'tools:sdk'))
    const errors = first.contexts.filter(c => c.name === ERROR)
    assert.equal(errors.length, 1)
    assert.match(errors[0]!.text, /run_code/)
    assert.match(errors[0]!.text, /monitor/)
    assert.match(errors[0]!.text, /停止|stop/i)
    assert.match(errors[0]!.text, /直接重启/)
    assert.match(errors[0]!.text, /restart --detach/)
    for (let i = 0; i < 4; i++) {
      const again = await f.assemble()
      assert.deepEqual(again.sections, first.sections)
      assert.deepEqual(again.contexts.filter(c => c.name === ERROR), errors)
    }
    assert.equal(f.logs.filter(s => s.includes('guard-session') && s.includes('run_code')).length, 1)
  } finally { await f.cleanup() }
})

it('uses public composedPreset even when the session header is unavailable', async () => {
  const f = await fixture()
  try {
    class Presets extends Service {
      constructor(ctx: Context) { super(ctx, 'agentPresets'); }
      definitions = new Map()
      activate() {}
      collect() {}
      register() {}
      composedPreset() { return 'ptc' }
    }
    await f.ctx.plugin(Presets)
    Object.assign(f.session, { header: {} })
    assert.equal((await f.errors()).length, 1)
  } finally { await f.cleanup() }
})

it('does not mistake standard, cordis, unknown, malformed legacy fields, or absent scopes for broken PTC', async () => {
  const f = await fixture()
  try {
    for (const value of ['standard', 'cordis', undefined, null, true, 42, { id: 'ptc' }, ' ptc ']) {
      Object.assign(f.session, { header: { agentPreset: value } })
      Object.assign(f.scope, { agentPreset: 'ptc', meta: { agentPreset: 'ptc' } })
      assert.deepEqual(await f.errors(), [], String(value))
    }
    const global = await f.ctx.get('systemPrompt')!.assemble()
    assert.deepEqual(global.contexts.filter(c => c.name === ERROR), [])
    assert.equal(f.logs.filter(s => s.includes('run_code')).length, 0)
  } finally { await f.cleanup() }
})

it('does not warn for an initialized real PTC surface', async () => {
  const f = await fixture('ptc')
  try {
    const assembly = await f.assemble()
    assert.deepEqual(assembly.tools.map(t => t.name), ['run_code'])
    assert.deepEqual(assembly.contexts.filter(c => c.name === ERROR), [])
    assert.equal(f.logs.filter(s => s.includes('run_code')).length, 0)
  } finally { await f.cleanup() }
})

it('does not report normal PTC with run_code, and removes a previous error when presentation recovers', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.errors()).length, 1)
    const dispose = f.ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
      const result = await next()
      // 0.2.2-rc.1 起钩子拿不到工具数组，PTC 呈现正常的标志是执行器产出的 tools:sdk 段。
      result.sections = [...result.sections, { name: 'tools:sdk', text: '' }]
      return result
    })
    try { assert.deepEqual(await f.errors(), []) } finally { dispose() }
    assert.equal((await f.errors()).length, 1)
    assert.equal(f.logs.filter(s => s.includes('guard-session') && s.includes('run_code')).length, 1)
  } finally { await f.cleanup() }
})
