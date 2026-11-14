/**
 * 真 cordis：加载包的两个入口模块（`src/index.ts`、`src/goal-guard.ts`，分别编译成
 * 包导出的 `.` 与 `./goal-guard`），确认它们是两个不同模块、各 apply 恰好一次；目标条目
 * 只装一次收口规则与一次 update_goal 遮蔽，卸载后工具包装被撤掉、监听不再重装。
 * 另静态核对 package.json 的 exports：两个子路径必须指向两个不同文件——loader 的行选项
 * 只给模块说明符、没有按行导出选择，这是两条目互不串钩子的前提。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import * as outEntry from '../src/index.ts'
import * as goalEntry from '../src/goal-guard.ts'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, string> }

class FakeSystemPrompt extends Service {
  sections: { name: string; order: unknown; text: (o: { scope: unknown }) => string }[] = []
  constructor(ctx: Context) { super(ctx, 'systemPrompt') }
  section(s: { name: string; order: unknown; text: (o: { scope: unknown }) => string }) {
    this.sections.push(s)
    return () => { this.sections = this.sections.filter((x) => x !== s) }
  }
  getSectionOrder(key: string) { return `order:${key}` }
}
class FakeTools extends Service {
  byScope = new Map<unknown, Record<string, unknown>>()
  global: Record<string, unknown> = {}
  constructor(ctx: Context) { super(ctx, 'tools') }
  get(name: string, scope?: unknown) { return scope === undefined ? this.global[name] : this.byScope.get(scope)?.[name] }
}
class FakeAgents extends Service {
  items: { session: { id: string; header: { origin: string } } }[] = []
  constructor(ctx: Context) { super(ctx, 'agents') }
  get(id: unknown) { return this.items.find((a) => a.session.id === id) }
  list() { return this.items }
}
class FakeLlm extends Service {
  constructor(ctx: Context) { super(ctx, 'llm') }
}

const settle = () => new Promise((r) => setTimeout(r, 40))
const fakeUpdateGoal = () => ({ name: 'update_goal', description: '', parameters: {}, output: { schema: {}, render: () => [] }, execute: async (args: unknown) => ({ delegated: args }) })

function setup() {
  const ctx = new Context()
  const sys = new FakeSystemPrompt(ctx)
  const tools = new FakeTools(ctx)
  const agents = new FakeAgents(ctx)
  new FakeLlm(ctx)
  const disposals: { disposed: number }[] = []
  const goals = {
    block: (_a: unknown, ref: { id: string; revision: number }, reason: { code: string; message: string }) => ({ ...ref, objective: 'o', phase: 'blocked', roundsStarted: 1, maxGoalRounds: 8, blockedReason: reason }),
    get: () => ({ id: 'g', revision: 1, objective: 'o', phase: 'active', roundsStarted: 1, maxGoalRounds: 8 }),
  }
  const registry = { register: (_tool: unknown) => { const rec = { disposed: 0 }; disposals.push(rec); return () => { rec.disposed += 1 } } }
  const agent = { session: { id: 's1', header: { origin: 'user' } }, ctx: { get: (key?: string) => key === 'goals' ? goals : registry } }
  agents.items.push(agent)
  tools.byScope.set(agent, { update_goal: fakeUpdateGoal() })
  return { ctx, sys, tools, agents, disposals }
}

function asPlugin(mod: { name: string; inject: readonly string[]; Config: unknown; apply: (c: never, cfg: never) => void }, count: { n: number }) {
  return { name: mod.name, inject: mod.inject, Config: mod.Config, apply: (c: never, cfg: never) => { count.n += 1; mod.apply(c, cfg) } }
}

test('两个入口是两个不同模块，且 package.json 两个子路径指向不同文件', () => {
  assert.equal(typeof outEntry.apply, 'function')
  assert.equal(typeof goalEntry.apply, 'function')
  assert.notEqual(outEntry.apply as unknown, goalEntry.apply as unknown, '两个入口的 apply 必须是不同函数')
  assert.equal(outEntry.name, 'dsh-guard')
  assert.equal(goalEntry.name, 'dsh-guard/goal-guard')
  assert.equal((outEntry as Record<string, unknown>)['guardUpdateGoal'], undefined, '输出模块不导出目标守卫')
  assert.equal(typeof (goalEntry as Record<string, unknown>)['guardUpdateGoal'], 'function', '目标模块导出目标守卫')
  assert.equal(pkg.exports['.'], './lib/index.js')
  assert.equal(pkg.exports['./goal-guard'], './lib/goal-guard.js')
  assert.notEqual(pkg.exports['.'], pkg.exports['./goal-guard'], '两个子路径不能指向同一文件')
})

test('真 cordis：各 apply 一次、只装一次收口规则与一次 update_goal 遮蔽；卸载后工具包装撤、监听不再重装', async () => {
  const { ctx, sys, agents, disposals } = setup()
  const outCount = { n: 0 }
  const goalCount = { n: 0 }
  const goalFiber = ctx.plugin(asPlugin(goalEntry, goalCount) as never, {} as never) as unknown as { await: () => Promise<unknown>; dispose: () => Promise<unknown> }
  const outFiber = ctx.plugin(asPlugin(outEntry, outCount) as never, {} as never) as unknown as { await: () => Promise<unknown>; dispose: () => Promise<unknown> }
  await settle()
  await goalFiber.await()
  await outFiber.await()
  assert.equal(goalCount.n, 1, '目标条目 apply 恰好一次')
  assert.equal(outCount.n, 1, '输出条目 apply 恰好一次')
  assert.equal(sys.sections.filter((s) => s.name === 'goal-guard-wrap-up').length, 1, '收口规则只装一次（两条目不是各装一遍）')
  assert.equal(disposals.length, 1, 'update_goal 只遮蔽一次')

  await goalFiber.dispose()
  await settle()
  assert.equal(disposals[0]!.disposed, 1, '卸载后 update_goal 遮蔽已撤')
  const before = disposals.length
  const extra = { session: { id: 's2', header: { origin: 'user' } }, ctx: { get: () => ({ register: () => () => undefined }) } }
  ;(agents.items as unknown[]).push(extra)
  ;(ctx as unknown as { emit: (e: string, p: unknown) => void }).emit('agent/created', { agent: extra })
  await settle()
  assert.equal(disposals.length, before, '卸载后监听已随 fiber 撤掉，不会再装 update_goal')

  await outFiber.dispose()
  await settle()
})
