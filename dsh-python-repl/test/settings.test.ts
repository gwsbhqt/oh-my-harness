import { strict as assert } from 'node:assert'
import { it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { mountAgents } from './fixtures/agents.ts'
import { Config, PythonReplRuntime, resolveConfig } from '../src/index.ts'
import { SETTINGS_FIELD_NAMES } from '../src/client/settings-fields.ts'
const pidOf = (r: { logs: string[] }): number => Number(r.logs.join('').trim())

/**
 * 0.1.7 的设置链路：设置页写 profile patch，loader 把 volatile 字段的新值
 * **原地提交**进正在运行的 config 单元格（写入符号是 cosmokit 的跨副本协议
 * `Symbol.for('cosmokit.volatile.write')`），插件不重载。这里模拟这一步。
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

type Cells = ReturnType<typeof Config>

function snapshotCells(config: Cells): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).map(([key, cell]) => [key, (cell as { get(): unknown }).get()]),
  )
}

/** 模拟用户改设置：把补丁层的新值原地提交进运行中的单元格。 */
function commitCells(config: Cells, patch: Record<string, unknown>): void {
  const next = Config({ ...snapshotCells(config), ...patch })
  for (const key of Object.keys(patch)) {
    const cell = (config as Record<string, unknown>)[key]
    ;(cell as Record<symbol, (value: unknown) => void>)[VOLATILE_WRITE]!(
      (next as Record<string, { get(): unknown }>)[key]!.get(),
    )
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

it('exposes every config field as volatile for live updates', () => {
  // loader 的原地配置更新依赖 volatile；GUI 由插件自己的设置页注册。
  const dict = (Config as unknown as { dict: Record<string, { meta: { volatile?: boolean } }> }).dict
  for (const [key, child] of Object.entries(dict)) {
    assert.equal(child.meta.volatile, true, `${key} must be volatile`)
  }
})

it('the settings card lists every Config field except profile-only rename hints', () => {
  const keys = Object.keys((Config as unknown as { dict: Record<string, unknown> }).dict).filter((key) => key !== 'skillRenames').sort()
  assert.deepEqual([...SETTINGS_FIELD_NAMES].sort(), keys)
})

it('resolveConfig unwraps volatile cells into a plain snapshot', () => {
  const config = Config({ toolCallTimeoutMs: 25 })
  const resolved = resolveConfig(config)
  assert.equal(resolved.toolCallTimeoutMs, 25)
  assert.equal(resolved.python, '3.14')
  assert.deepEqual(resolved.skillRenames, {})
  assert.throws(() => Config({ skillRenames: { old: 123 } } as never))
  assert.deepEqual(resolved.residentTools, ['job_output', 'job_kill', 'ask_user_question', 'read_image', 'web_search', 'present', 'todo_write', 'interrupt_agent', 'update_goal'])
})

it('validates protocol frame limits and applies updates only to new kernels', async () => {
  assert.equal(resolveConfig(Config({})).maxFrameBytes, 64 * 1024 * 1024)
  assert.throws(() => Config({ maxFrameBytes: 999 }))
  assert.throws(() => Config({ maxFrameBytes: -1 }))
  const ctx = new Context()
  await mountAgents(ctx)
  const config = Config({ python: process.env['DSH_PY'] ?? 'python3', maxFrameBytes: 4096, projectSkillRoots: [] })
  await ctx.plugin(PythonReplRuntime, config)
  await tick()
  const runtime = ctx.get('ptcRuntime') as PythonReplRuntime
  try {
    const before = runtime.sessionFor('frame-before')
    assert.equal((await before.runCell('kept = list(range(2))', new Map())).error, undefined)
    const pid = pidOf(await before.runCell('import os; os.getpid()', new Map()))
    commitCells(config, { maxFrameBytes: 8192 })
    assert.equal(runtime.config.maxFrameBytes, 8192)
    assert.equal(runtime.sessionFor('frame-before'), before)
    assert.match((await before.runCell('len(kept)', new Map())).logs.join(''), /2/)
    assert.equal(pidOf(await before.runCell('import os; os.getpid()', new Map())), pid)
    const after = runtime.sessionFor('frame-after')
    const withinNewBudget = await after.runCell('import os\nos.write(1, b"x" * 5000 + b"\\n")', new Map())
    assert.equal(withinNewBudget.error, undefined)
    const overOldBudget = await before.runCell('import os\nos.write(1, b"x" * 5000 + b"\\n")', new Map())
    assert.equal(overOldBudget.error?.kind, 'worker-exit')
  } finally { await runtime.disposeAll() }
})

it('reads volatile updates for new sessions without destroying existing state', async () => {
  const ctx = new Context()
  await mountAgents(ctx)
  await tick()
  const config = Config({ python: process.env['DSH_PY'] ?? 'python3' })
  await ctx.plugin(PythonReplRuntime, config)
  await tick()
  const runtime = ctx.get('ptcRuntime') as PythonReplRuntime
  try {
    assert.equal(runtime.config.toolCallTimeoutMs, 0)
    const existing = runtime.sessionFor('before')
    assert.equal((await existing.runCell('kept = 42', new Map())).error, undefined)
    // loader 的原地提交：运行中的 runtime 立即读到新值，已有内核不受影响
    commitCells(config, { toolCallTimeoutMs: 25 })
    assert.equal(runtime.config.toolCallTimeoutMs, 25)
    assert.equal(runtime.sessionFor('before'), existing)
    assert.match((await existing.runCell('kept', new Map())).logs.join(''), /42/)
    const next = runtime.sessionFor('after')
    const timed = await next.runCell('await tools.wait({})', new Map([['wait', async () => new Promise(() => {})]]))
    assert.match(timed.error?.message ?? '', /25ms/)
  } finally {
    await runtime.disposeAll()
  }
})
