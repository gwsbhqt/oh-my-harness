import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { Config, guardUpdateGoal, MODEL_PAUSE_CODE, resolveConfig, StallTracker, stallMessage, type GoalHost, type GoalViewLike } from '../src/goal-guard.ts'

/** 假宿主工具：denied 里的动作按宿主「这一轮没有权限」拒绝，threshold 按轮数门槛拒绝。 */
function fakeOriginal(opts: { denied?: string[]; threshold?: boolean } = {}) {
  const calls: { action: string | undefined }[] = []
  const tool = {
    name: 'update_goal',
    description: 'Update the current goal.',
    parameters: {},
    output: { schema: {}, render: () => [] },
    execute(args: unknown, _exec: unknown) {
      const action = (args as { action?: string }).action
      calls.push({ action })
      if (opts.denied?.includes(action ?? '')) return Promise.reject(new HarnessError('no authority', 'GOAL_TOOL_AUTHORITY_REQUIRED'))
      if (opts.threshold && action === 'blocked') return Promise.reject(new HarnessError('too early', 'GOAL_TOOL_BLOCK_THRESHOLD'))
      return Promise.resolve({ delegated: action })
    },
    presentCall: (args: { action: string }) => ({ kind: 'other' as const, label: args.action }),
  } as unknown as ToolDefinition & { presentCall(args: { action: string }): unknown }
  return { tool, calls }
}

/** 假目标服务：记下直接调用。 */
function fakeGoalHost(root = true, phaseNow = 'blocked') {
  const ops: { op: string; ref: unknown; extra?: unknown }[] = []
  const view = (phase: string, extra: Partial<GoalViewLike> = {}): GoalViewLike => ({ id: 'g', revision: 2, objective: 'o', phase, roundsStarted: 1, maxGoalRounds: 8, activation: 'disarmed', ...extra })
  const host: GoalHost = {
    isRoot: () => root,
    goals: () => ({
      block: (_a, ref, reason) => { ops.push({ op: 'block', ref, extra: reason }); return view('blocked', { blockedReason: reason }) },
      edit: (_a, ref, r) => { ops.push({ op: 'edit', ref, extra: r }); return view('active', r) },
      complete: (_a, ref) => { ops.push({ op: 'complete', ref }); return view('complete') },
      resume: (_a, ref) => { ops.push({ op: 'resume', ref }); return view('active', { activation: 'armed' }) },
      get: () => view(phaseNow),
    }),
  }
  return { host, ops }
}

const exec = { agent: {} } as never

test('开关默认开，可以关', () => {
  assert.equal(resolveConfig(Config({})).modelControl, true)
  assert.equal(resolveConfig(Config({ modelControl: false })).modelControl, false)
  assert.equal(resolveConfig(Config({})).wrapUpGuidance, true)
  assert.equal(resolveConfig(Config({ wrapUpGuidance: false })).wrapUpGuidance, false)
})

test('模型 pause：不走宿主的暂停（模型恢复不了），记成可以自己 resume 的 blocked，带上原因', async () => {
  const { tool, calls } = fakeOriginal()
  const h = fakeGoalHost()
  const out = await guardUpdateGoal(tool, true, h.host).execute({ action: 'pause', goal_id: 'g', revision: 1, blocked_reason: '只差用户验收' }, exec) as { goal: { phase: string; blockedReason: { code: string; message: string } } }
  assert.deepEqual(calls, [], '不能落到宿主的 pause')
  assert.deepEqual(h.ops, [{ op: 'block', ref: { id: 'g', revision: 1 }, extra: { code: MODEL_PAUSE_CODE, message: '只差用户验收' } }])
  assert.equal(out.goal.phase, 'blocked')
  assert.equal(out.goal.blockedReason.code, 'model-paused')
  await guardUpdateGoal(tool, true, h.host).execute({ action: 'pause', goal_id: 'g', revision: 1 }, exec)
  assert.equal((h.ops[1]!.extra as { message: string }).message, '模型暂停，没写原因')
  await assert.rejects(guardUpdateGoal(tool, true, h.host).execute({ action: 'pause', goal_id: 'g', revision: 1, objective: 'x' }, exec), /改目标用 edit/)
})

test('宿主因这一轮没权限拒绝 edit / complete / blocked：顶层会话直接调目标服务补上', async () => {
  const { tool } = fakeOriginal({ denied: ['edit', 'complete', 'blocked'] })
  const h = fakeGoalHost()
  const g = guardUpdateGoal(tool, true, h.host)
  await g.execute({ action: 'complete', goal_id: 'g', revision: 3 }, exec)
  await g.execute({ action: 'edit', goal_id: 'g', revision: 4, objective: '已提交待合并', max_goal_rounds: 0 }, exec)
  await g.execute({ action: 'blocked', goal_id: 'g', revision: 5, blocked_reason: '登录要用户确认' }, exec)
  assert.deepEqual(h.ops.map((o) => o.op), ['complete', 'edit', 'block'])
  assert.deepEqual(h.ops[1]!.extra, { objective: '已提交待合并' }, '轮数上限 0 是占位，不当成改上限')
  assert.deepEqual(h.ops[2]!.extra, { code: 'model-reported', message: '登录要用户确认' })
})

test('宿主有权限时原样委托；轮数门槛等其他拒绝原样抛出，不补位', async () => {
  const ok = fakeOriginal()
  const h = fakeGoalHost()
  for (const action of ['complete', 'blocked', 'resume', 'edit']) {
    assert.deepEqual(await guardUpdateGoal(ok.tool, true, h.host).execute({ action, goal_id: 'g', revision: 1 }, exec), { delegated: action })
  }
  assert.equal(h.ops.length, 0)
  const th = fakeOriginal({ threshold: true })
  await assert.rejects(guardUpdateGoal(th.tool, true, h.host).execute({ action: 'blocked', goal_id: 'g', revision: 1, blocked_reason: 'r' }, exec), /too early/)
  const denied = fakeOriginal({ denied: ['edit'] })
  await assert.rejects(guardUpdateGoal(denied.tool, true, h.host).execute({ action: 'edit', goal_id: 'g', revision: 1 }, exec), /no authority/, '什么都不改的 edit 不补位')
  assert.equal(h.ops.length, 0)
})

test('没权限的轮次里 resume：模型自己的暂停能恢复，用户亲手点的暂停不恢复', async () => {
  const { tool } = fakeOriginal({ denied: ['resume'] })
  const mine = fakeGoalHost(true, 'blocked')
  const out = await guardUpdateGoal(tool, true, mine.host).execute({ action: 'resume', goal_id: 'g', revision: 5 }, exec) as { goal: { phase: string } }
  assert.deepEqual(mine.ops, [{ op: 'resume', ref: { id: 'g', revision: 5 } }])
  assert.equal(out.goal.phase, 'active')
  const users = fakeGoalHost(true, 'paused')
  await assert.rejects(guardUpdateGoal(tool, true, users.host).execute({ action: 'resume', goal_id: 'g', revision: 5 }, exec), /用户亲手暂停的/)
  assert.equal(users.ops.length, 0)
})

test('子代理不补位、不暂停', async () => {
  const { tool } = fakeOriginal({ denied: ['complete'] })
  const h = fakeGoalHost(false)
  await assert.rejects(guardUpdateGoal(tool, true, h.host).execute({ action: 'pause', goal_id: 'g', revision: 1 }, exec), /只有顶层会话/)
  await assert.rejects(guardUpdateGoal(tool, true, h.host).execute({ action: 'complete', goal_id: 'g', revision: 1 }, exec), /只有顶层会话/)
  assert.equal(h.ops.length, 0)
})

test('开关关掉时全部原样委托', async () => {
  const { tool, calls } = fakeOriginal()
  const h = fakeGoalHost()
  assert.deepEqual(await guardUpdateGoal(tool, false, h.host).execute({ action: 'pause', goal_id: 'g', revision: 1 }, exec), { delegated: 'pause' })
  assert.equal(calls.length, 1)
  assert.equal(h.ops.length, 0)
})

test('描述、参数、输出、调用展示都透传原工具', () => {
  const { tool } = fakeOriginal()
  const guarded = guardUpdateGoal(tool, true, fakeGoalHost().host)
  assert.equal(guarded.description, tool.description)
  assert.equal(guarded.parameters, tool.parameters)
  assert.equal(guarded.output, tool.output)
  assert.deepEqual((guarded as typeof tool).presentCall({ action: 'complete' }), { kind: 'other', label: 'complete' })
})


// ---- apply() 的接线：用假的 cordis 上下文，不起宿主 ----
import { apply } from '../src/goal-guard.ts'

function fakeHost(withGoalTool = true) {
  const listeners: Record<string, ((...a: never[]) => unknown)[]> = {}
  const store: Record<string, unknown> = {}
  const getCalls: { name: string, scope: unknown }[] = []
  if (withGoalTool) store.update_goal = fakeOriginal().tool
  const agents: { ctx: { get(): unknown }; session: { id: string; header: { origin: string } }; registered: { name: string }[] }[] = []
  const sections: { name: string; order: unknown; text: (o: { scope: unknown }) => string }[] = []
  const ctx = {
    systemPrompt: { section: (s: never) => { sections.push(s) }, getSectionOrder: (key: string) => `order:${key}` },
    tools: { get: (n: string, scope?: unknown) => { getCalls.push({ name: n, scope }); return store[n] } },
    on: (event: string, cb: never) => {
      ;(listeners[event] ??= []).push(cb)
      return () => { listeners[event] = (listeners[event] ?? []).filter((l) => l !== cb) }
    },
    agents: { list: () => agents, get: (id: unknown) => agents.find((x) => x.session.id === id) },
    effect: () => undefined,
    logger: () => ({ warn: () => undefined }),
  }
  const emit = (event: string, ...args: unknown[]) => {
    for (const cb of [...(listeners[event] ?? [])]) (cb as (...a: unknown[]) => unknown)(...args)
  }
  const makeAgent = () => {
    const goals = { block: (_a: unknown, ref: { id: string; revision: number }, reason: { code: string; message: string }) => ({ ...ref, objective: 'o', phase: 'blocked', roundsStarted: 1, maxGoalRounds: 8, blockedReason: reason }) }
    const registry = { register: (t: { name: string }) => { agent.registered.push(t); return () => undefined } }
    const agent = { ctx: { get: (key?: string) => key === 'goals' ? goals : registry }, session: { id: `s${agents.length + 1}`, header: { origin: 'user' } }, registered: [] as { name: string }[] }
    agents.push(agent)
    return agent
  }
  return { ctx, store, agents, emit, makeAgent, listeners, getCalls, sections }
}

test('apply 时 update_goal 已注册：现有 agent 立即遮蔽', () => {
  const h = fakeHost(true)
  const a = h.makeAgent()
  apply(h.ctx as never, Config({}))
  assert.equal(a.registered[0]?.name, 'update_goal')
  assert.ok(h.getCalls.length > 0 && h.getCalls.every((c) => c.scope === a), '必须带 agent 作用域查（预设层）')
})

test('apply 时 update_goal 还没注册（加载顺序在后）：不炸，之后新建的 agent 现取到就遮蔽', async () => {
  const h = fakeHost(false)
  const a = h.makeAgent()
  apply(h.ctx as never, Config({}))
  assert.equal(a.registered.length, 0, '注册前不装')
  h.store.update_goal = fakeOriginal().tool
  const b = h.makeAgent()
  h.emit('agent/created', { agent: b })
  assert.equal(b.registered[0]?.name, 'update_goal', '之后新建的 agent 也装上')
  const paused = await (b.registered[0] as unknown as { execute(a: unknown, e: unknown): Promise<{ goal: { blockedReason: { code: string } } }> }).execute({ action: 'pause', goal_id: 'g', revision: 1 }, { agent: b })
  assert.equal(paused.goal.blockedReason.code, 'model-paused', '经 agent 自己的目标服务记成可恢复的暂停')
})


test('创建 agent 时工具还没注册（恢复会话早于 dsh-tool-goal）：第一个 pre-step 重试装上', async () => {
  const h = fakeHost(false)
  const a = h.makeAgent()
  apply(h.ctx as never, Config({}))
  h.emit('agent/created', { agent: a })
  assert.equal(a.registered.length, 0, '工具未注册时跳过')
  h.store.update_goal = fakeOriginal().tool
  const pre = (h.listeners['agent/pre-step'] ?? [])[0] as unknown as (p: unknown, next: () => Promise<string>) => Promise<string>
  assert.equal(await pre({ agent: a }, async () => 'decision'), 'decision', '中间件要透传 next 的结果')
  assert.equal(a.registered[0]?.name, 'update_goal', 'pre-step 重试装上了')
  const paused = await (a.registered[0] as unknown as { execute(x: unknown, e: unknown): Promise<{ goal: { blockedReason: { code: string } } }> }).execute({ action: 'pause', goal_id: 'g', revision: 1 }, { agent: a })
  assert.equal(paused.goal.blockedReason.code, 'model-paused')
})

test('收口规则：只在当前会话有 update_goal 时出现，排在宿主 goal 说明的位置，开关能关', () => {
  const on = fakeHost(true)
  apply(on.ctx as never, Config({}))
  const section = on.sections.find((s) => s.name === 'goal-guard-wrap-up')
  assert.ok(section, '注册了收口规则')
  assert.equal(section.order, 'order:TOOL_GOAL')
  const text = section.text({ scope: 'agent-scope' })
  assert.match(text, /pause 暂停/)
  assert.match(text, /edit 修改/)
  assert.match(text, /等别人、等用户不算“有用的剩余工作”/)
  assert.match(text, /不要让用户去目标面板操作/)
  assert.ok(on.getCalls.some((c) => c.name === 'update_goal' && c.scope === 'agent-scope'), '按当前会话的作用域查工具')

  const noGoal = fakeHost(false)
  apply(noGoal.ctx as never, Config({}))
  assert.equal(noGoal.sections[0]!.text({ scope: 'x' }), '', '没有目标工具的会话不加这段')

  const off = fakeHost(true)
  apply(off.ctx as never, Config({ wrapUpGuidance: false }))
  assert.equal(off.sections[0]!.text({ scope: 'x' }), '', '开关关掉就不加')
})

/** 一轮：source 是这一轮进来的消息来源，results 是各次工具调用是否报错。 */
function turn(t: StallTracker, source: { kind: string; round?: number }, results: boolean[], aborted = false) {
  t.turnStart('a')
  t.userMessage('a', source)
  for (const failed of results) t.toolResult('a', failed, failed ? "No module named 'rlm'" : undefined)
  return t.turnEnd('a', aborted)
}

test('空转刹车：续跑轮里工具全失败或一次不调，连续 3 轮就停下目标', () => {
  assert.equal(resolveConfig(Config({})).stallRounds, 3)
  const t = new StallTracker()
  const goal = (round: number) => ({ kind: 'goal', round })
  assert.equal(turn(t, goal(15), [true]).streak, 1)
  assert.equal(turn(t, goal(16), []).streak, 2, '一次没调也算空转')
  const third = turn(t, goal(17), [true])
  assert.equal(third.streak, 3)
  assert.equal(third.lastError, "No module named 'rlm'")
  assert.match(stallMessage(3, third.lastError), /连续 3 轮.*No module named 'rlm'/)
})

test('空转刹车：有一次工具成功或用户亲自发消息就清零；通知轮和被中止的轮不改计数', () => {
  const t = new StallTracker()
  const goal = (round: number) => ({ kind: 'goal', round })
  turn(t, goal(1), [true]); turn(t, goal(2), [true])
  assert.equal(turn(t, goal(3), [true, false]).streak, 0, '这一轮有一次成功')
  turn(t, goal(4), [true])
  assert.equal(turn(t, { kind: 'user' }, [true]).streak, 0, '用户发了消息')
  turn(t, goal(5), [])
  assert.equal(turn(t, { kind: 'plugin' }, []).streak, 1, '通知轮不加也不清')
  assert.equal(turn(t, goal(6), [], true).streak, 1, '被中止的轮不算')
  assert.equal(turn(t, goal(0), []).streak, 1, '第 0 轮是建目标时的提示，不是续跑')
  t.reset('a')
  assert.equal(turn(t, goal(7), []).streak, 1, '停下后重新计数')
})

test('总开关：关掉时收口规则不出、工具包装直通；重开恢复', async () => {
  const state = { enabled: true }
  const cells = { enabled: { get: () => state.enabled }, modelControl: { get: () => true }, wrapUpGuidance: { get: () => true }, stallRounds: { get: () => 3 } }
  const h = fakeHost(true)
  const a = h.makeAgent()
  apply(h.ctx as never, cells as never)
  const section = h.sections.find((s) => s.name === 'goal-guard-wrap-up')!
  assert.match(section.text({ scope: 'x' }), /pause 暂停/)
  const reg = a.registered[0] as unknown as { execute(x: unknown, e: unknown): Promise<{ goal?: { blockedReason?: { code: string } } }> }
  assert.equal((await reg.execute({ action: 'pause', goal_id: 'g', revision: 1 }, { agent: a })).goal?.blockedReason?.code, 'model-paused')
  state.enabled = false
  assert.equal(section.text({ scope: 'x' }), '', '总开关关掉收口规则不出现')
  assert.deepEqual(await reg.execute({ action: 'pause', goal_id: 'g', revision: 1 }, { agent: a }), { delegated: 'pause' }, '总开关关掉工具包装直通')
  state.enabled = true
  assert.equal((await reg.execute({ action: 'pause', goal_id: 'g', revision: 1 }, { agent: a })).goal?.blockedReason?.code, 'model-paused', '重开后恢复遮蔽')
})

test('总开关：关掉期间不计数；重开后不拿关闭期间的轮次刹车', async () => {
  const state = { enabled: true }
  const cells = { enabled: { get: () => state.enabled }, modelControl: { get: () => true }, wrapUpGuidance: { get: () => true }, stallRounds: { get: () => 2 } }
  const h = fakeHost(false)
  const a = h.makeAgent()
  const blocked: { code: string }[] = []
  const goals = {
    block: (_ag: unknown, ref: { id: string; revision: number }, reason: { code: string }) => { blocked.push(reason); return { ...ref, objective: 'o', phase: 'blocked', roundsStarted: 1, maxGoalRounds: 8 } },
    get: () => ({ id: 'g', revision: 1, objective: 'o', phase: 'active', roundsStarted: 1, maxGoalRounds: 8 }),
  }
  ;(a.ctx as unknown as { get: (k?: string) => unknown }).get = (k?: string) => k === 'goals' ? goals : { register: () => () => undefined }
  apply(h.ctx as never, cells as never)
  const session = (a as unknown as { session: unknown }).session
  const emit = (type: string, data: Record<string, unknown> = {}) => h.emit('session/event', session, { type, data })
  const failRound = (round: number) => { emit('turn/start'); emit('user/message', { source: { kind: 'goal', round } }); emit('tool/result', { message: { isError: true }, error: { reason: 'boom' } }); emit('turn/end', { reason: { kind: 'normal' } }) }
  const tick = () => new Promise((r) => setTimeout(r, 0))

  state.enabled = false
  for (let i = 1; i <= 5; i++) { failRound(i); await tick() }
  assert.equal(blocked.length, 0, '关掉期间不计数、不停目标')

  state.enabled = true
  failRound(10); await tick()
  assert.equal(blocked.length, 0, '重开后第一轮不该用关闭期间的轮次刹车')
  failRound(11); await tick()
  assert.equal(blocked.length, 1, '重开后满 stallRounds 轮才刹')
  assert.equal(blocked[0]!.code, 'no-progress')
})

test('总开关：turn/end 已排队、microtask 执行前关掉，也不停目标', async () => {
  const state = { enabled: true }
  const cells = { enabled: { get: () => state.enabled }, modelControl: { get: () => true }, wrapUpGuidance: { get: () => true }, stallRounds: { get: () => 1 } }
  const h = fakeHost(false)
  const a = h.makeAgent()
  const blocked: unknown[] = []
  const goals = {
    block: (_ag: unknown, ref: { id: string; revision: number }) => { blocked.push(ref); return { ...ref, objective: 'o', phase: 'blocked', roundsStarted: 1, maxGoalRounds: 8 } },
    get: () => ({ id: 'g', revision: 1, objective: 'o', phase: 'active', roundsStarted: 1, maxGoalRounds: 8 }),
  }
  ;(a.ctx as unknown as { get: (k?: string) => unknown }).get = (k?: string) => k === 'goals' ? goals : { register: () => () => undefined }
  apply(h.ctx as never, cells as never)
  const session = (a as unknown as { session: unknown }).session
  const emit = (type: string, data: Record<string, unknown>) => h.emit('session/event', session, { type, data })
  emit('turn/start', {})
  emit('user/message', { source: { kind: 'goal', round: 1 } })
  emit('tool/result', { message: { isError: true }, error: { reason: 'x' } })
  emit('turn/end', { reason: { kind: 'normal' } }) // 这一轮在开时结束，已排队 microtask
  state.enabled = false // microtask 执行前关掉
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(blocked.length, 0, '排队后关掉就不停目标')
})
