import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer, request } from 'node:http'
import { forbiddenApp, invokeCli } from './cli-fixture.ts'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteService, type Deps, type RestartRecoveryResult, type SessionSummaryWire, type MonitorStartRequest } from '../src/service.ts'
import { runCommand } from '../src/commands.ts'
import { createCli, parseCommand, spawnDetachedCli, type AppControl } from '../src/cli/core.ts'
import { UsageError } from '../src/gateway.ts'
import { startServer } from '../src/server.ts'
import { COMMANDS } from '../src/commands.ts'
import { fromShared, type UsageReportLike } from '../src/models.ts'

/** 测试用档位，和 模型额度服务 的共用档位文件同形状。 */
const DEFAULT_TIERS = fromShared({
  tiers: {
    main: [{ provider: 'claude', model: 'claude-opus-5-5' }, { provider: 'codex', model: 'gpt-6.1-sol' }, { provider: 'kimi-coding', model: 'k3-256k' }],
    light: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }],
  },
  quotas: {
    'claude': { quota: 'claude', windows: { '7d': 1 } },
    'codex': { quota: 'codex', windows: { '7d': 1 } },
    'kimi-coding': { quota: 'kimi', windows: { '7d': 1, '30d': 2 } },
    'opencode-go': { quota: 'opencode', windows: { '7d': 1, '30d': 2 } },
  },
  reservePercent: 10,
})
import { PendingQuestions } from '../src/questions.ts'
import type { InvocationDescriptor } from '../src/gateway.ts'

const NOW = Date.parse('2026-09-30T12:00:00+08:00')

interface Fake {
  sessions: SessionSummaryWire[]
  events: Record<string, { type: string; seq: number; time?: number; data?: unknown }[]>
  calls: { endpoint: string; args: Record<string, unknown> }[]
  statusListeners: ((id: string, running: boolean) => void)[]
  readOnly: boolean
  archived: string[]
  answerAccepted: boolean
  report: UsageReportLike | undefined
  workspaceBaseline?: unknown
  workspaceError?: boolean
  replies?: Record<string, unknown>
  defaultModel?: { provider: string; model: string; reasoningEffort?: string }
}

function makeFake(): Fake {
  return {
    sessions: [
      { sessionId: 'session-aaaa1111-0000', updatedAt: NOW - 1000, running: false, blank: false, agentAvailable: true, cwd: '/repo/a', projections: { values: { title: '修 CI 失败', todos: [{ content: 'x', status: 'completed' }, { content: 'y', status: 'pending' }], modelSelection: { lastUsed: { provider: 'claude', model: 'claude-opus-5-5' }, next: null } } } },
      { sessionId: 'session-bbbb2222-0000', updatedAt: NOW - 5000, running: true, blank: false, agentAvailable: true, cwd: '/repo/b', projections: { values: { title: '写文档' } } },
      { sessionId: 'session-cccc3333-0000', updatedAt: NOW, running: false, blank: false, agentAvailable: true, cwd: '/repo/a', projections: { values: { title: '问问题', userQuestions: { active: [{ callId: 'call-1', state: 'open', questions: [{ id: 'q1', question: '用哪个方案？', options: [{ label: 'A' }, { label: 'B' }] }] }], settled: [] } } } },
      { sessionId: 'session-dddd4444-0000', updatedAt: NOW, running: false, blank: false, agentAvailable: true, parentSessionId: 'session-aaaa1111-0000', origin: 'subagent', projections: { values: {} } },
    ],
    events: {
      'session-aaaa1111-0000': [
        { type: 'turn/start', seq: 1, time: NOW - 9000, data: { turn: 1 } },
        { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '帮我修 CI' }] } },
        { type: 'request/header', seq: 3, data: { header: { config: { provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'high' } } } },
        { type: 'assistant/message', seq: 4, data: { turn: 1, message: { content: [{ type: 'reasoning', text: 'SECRET-THINK' }, { type: 'text', text: '修好了，测试全绿。' }] } } },
        { type: 'turn/end', seq: 5, time: NOW - 8000, data: { turn: 1, reason: { kind: 'completed' } } },
      ],
      'session-bbbb2222-0000': [
        { type: 'turn/start', seq: 1, data: { turn: 1 } },
        { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '写文档' }] } },
      ],
      'session-cccc3333-0000': [],
      'session-eeee5555-0000': [{ type: 'session', seq: 0 }],
    },
    calls: [],
    statusListeners: [],
    readOnly: false,
    archived: [],
    answerAccepted: true,
    report,
  }
}

const report = {
  fetchedAt: NOW,
  providers: [
    { id: 'claude', name: 'Claude', ok: true, windows: [{ key: 'c7', label: '7d', left: 40, expectedLeft: 50, resetsAt: NOW + 86_400_000 }] },
    { id: 'codex', name: 'Codex', ok: true, windows: [{ key: 'x7', label: '7d', left: 80, expectedLeft: 50, resetsAt: NOW + 86_400_000 }] },
    { id: 'kimi', name: 'Kimi', ok: true, windows: [{ key: 'k7', label: '7d', left: 50, expectedLeft: 50 }, { key: 'k30', label: '30d', left: 50, expectedLeft: 50 }] },
    { id: 'opencode', name: 'OpenCode Go', ok: true, windows: [{ key: 'o7', label: '7d', left: 90, expectedLeft: 50 }, { key: 'o30', label: '30d', left: 90, expectedLeft: 50 }] },
  ],
}

const descriptors: InvocationDescriptor[] = [
  { id: 'p#session/list', service: 's', namespace: 'session', method: 'list', invocation: { kind: 'direct' }, parameters: [{ name: '_request', wire: '_request', source: 'json' }] },
  { id: 'p#credentials/set', service: 's', namespace: 'credentials', method: 'set', invocation: { kind: 'direct' }, parameters: [] },
  { id: 'p#schedule/delete', service: 's', namespace: 'schedule', method: 'delete', invocation: { kind: 'direct' }, parameters: [{ name: 'request', wire: 'request', source: 'json' }] },
]

function service(fake: Fake, pending?: PendingQuestions, live?: Deps['quitBlockers'], restartAbort?: Deps['restartAbort'], extra: Partial<Deps> = {}): RemoteService {
  const deps: Deps = {
    ...extra,
    ...(restartAbort === undefined ? {} : { restartAbort }),
    ...(pending === undefined ? {} : { pending }),
    ...(live === undefined ? {} : { quitBlockers: live }),
    gateway: {
      async invoke({ namespace, method, args }) {
        const endpoint = `${namespace}/${method}`
        fake.calls.push({ endpoint, args })
        if (fake.replies !== undefined && Object.hasOwn(fake.replies, endpoint)) return fake.replies[endpoint]
        switch (endpoint) {
          case 'session/list': return { items: fake.sessions }
          case 'session/modelCatalog': return { default: fake.defaultModel ?? { provider: 'claude', model: 'claude-opus-5-5' }, groups: [
            { id: 'claude', name: 'Claude', models: [{ id: 'claude-opus-5-5', name: 'Opus' }] },
            { id: 'codex', name: 'Codex', models: [{ id: 'gpt-6.1-sol', name: 'sol', reasoning: { efforts: [{ id: 'medium' }, { id: 'high' }, { id: 'xhigh' }] } }] },
            { id: 'kimi-coding', name: 'Kimi', models: [{ id: 'k3-256k', name: 'k3' }] },
            { id: 'opencode-go', name: 'OC', models: [{ id: 'deepseek-v4.1-flash', name: 'flash' }] },
          ], failures: [], routableProviders: [] }
          case 'session/prompt': {
            const req = args['request'] as { sessionId: string }
            const s = fake.sessions.find((x) => x.sessionId === req.sessionId)
            if (s !== undefined) s.running = true
            return { accepted: true }
          }
          case 'session/selectModel': {
            const req = args['request'] as { sessionId: string; provider: string; model: string; reasoningEffort?: string }
            const selected = { provider: req.provider, model: req.model, reasoningEffort: req.reasoningEffort ?? 'high' }
            const session = fake.sessions.find((item) => item.sessionId === req.sessionId)
            if (session?.projections?.values) session.projections.values.modelSelection = { next: selected }
            return { selected }
          }
          case 'workspace/archiveSession': {
            const req = args['request'] as { sessionId: string }
            if (fake.sessions.find((s) => s.sessionId === req.sessionId)?.running) throw Object.assign(new Error('active work'), { code: 'workspace/session-active' })
            if (!fake.archived.includes(req.sessionId)) fake.archived.push(req.sessionId)
            return { archivedSessionIds: [...fake.archived] }
          }
          case 'workspace/unarchiveSession': {
            const req = args['request'] as { sessionId: string }
            fake.archived = fake.archived.filter((id) => id !== req.sessionId)
            return { archivedSessionIds: [...fake.archived] }
          }
          case 'session/rename': {
            const req = args['request'] as { sessionId: string; title: string }
            const title = req.title.trim()
            fake.sessions.find((s) => s.sessionId === req.sessionId)!.projections!.values!.title = title
            return { title, seq: 6 }
          }
          case 'session/fork': return { sessionId: 'session-ffff6666-0000' }
          case 'session/create': fake.sessions.push({ sessionId: 'session-eeee5555-0000', updatedAt: NOW, running: false, blank: true, agentAvailable: true, projections: { values: {} } }); return { sessionId: 'session-eeee5555-0000' }
          case 'session/cancel': return { accepted: true }
          case 'session/updateQueue': {
            // 按宿主 0.2.0-rc.2 的约束：插话只对下一轮排队、且会话在跑时有效。
            const req = args['request'] as { sessionId: string; itemId: string; action: { kind: string } }
            const s = fake.sessions.find((x) => x.sessionId === req.sessionId)!
            const inbox = (s.projections!.values as Record<string, { 'next-turn': { id: string }[] }>)['inbox']
            const rows = inbox?.['next-turn'] ?? []
            const at = rows.findIndex((m) => m.id === req.itemId)
            if (at < 0) throw Object.assign(new Error('queued item is no longer pending'), { code: 'session/queue-item-not-found' })
            if (req.action.kind === 'steer' && !s.running) throw Object.assign(new Error('current turn no longer accepts steering'), { code: 'session/steer-unavailable' })
            rows.splice(at, 1)
            return { accepted: true }
          }
          case 'userQuestions/answer': return fake.answerAccepted
          case 'pluginManager/setBundleEnabled': return args['name'] === 'broken-plugin'
            ? { name: 'broken-plugin', changed: false, application: 'failed', error: { code: 'plugin/install-failed', diagnostic: 'boom' } }
            : { name: args['name'], changed: true, application: 'applied' }
          case 'pluginManager/listBundles': return [
            { name: 'short-one', version: '1.0.0', enabled: true, installed: true, removable: true, description: '短描述' },
            { name: 'long-one', version: '1.0.0', enabled: true, installed: true, removable: true, description: `很长的描述${'啊'.repeat(120)}结尾` },
          ]
          default: return { echoed: endpoint, args }
        }
      },
      async stream({ namespace, method }) {
        const endpoint = `${namespace}/${method}`
        fake.calls.push({ endpoint, args: {} })
        if (fake.workspaceError) throw new Error('workspace unavailable')
        async function* gen() {
          if (fake.workspaceBaseline !== undefined) { yield fake.workspaceBaseline; return }
          yield { type: 'baseline', value: { items: [{ workspaceId: 'w1', path: '/repo/a', title: 'repo-a', sessionIds: ['session-aaaa1111-0000', 'session-cccc3333-0000'] }, { workspaceId: 'w2', path: '/repo/b', title: 'repo-b', sessionIds: ['session-bbbb2222-0000'] }], archivedSessionIds: [...fake.archived], pinnedSessionIds: [] } }
          await new Promise((r) => setTimeout(r, 60_000))
        }
        return gen()
      },
    },
    typert: { list: () => descriptors, get: (e) => descriptors.find((d) => `${d.namespace}/${d.method}` === e) },
    query: { async readSession(id) { return { session: { id }, events: fake.events[id] ?? [] } } },
    usage: async () => fake.report,
    onStatus: (l) => { fake.statusListeners.push(l); return () => {} },
    config: () => ({ readOnly: fake.readOnly, denyNamespaces: ['credentials'], reservePercent: 10, waitSliceMs: 2000, tiers: DEFAULT_TIERS }),
    log: () => {},
    now: () => NOW,
  }
  return new RemoteService(deps)
}

const signal = new AbortController().signal
const run = (s: RemoteService, command: string, args: string[] = [], options: Record<string, unknown> = {}) => runCommand(s, command, args, options, signal)

test('notify 默认包含标题、正文与声音，允许分别替换或关闭', async () => {
  const fake = makeFake()
  const sent: unknown[] = []
  const s = service(fake, undefined, undefined, undefined, { desktopNotify: async (notification) => { sent.push(notification) } })
  await run(s, 'notify')
  for (const args of [
    ['notify', '--title', '标题', '--no-body', '--no-sound'],
    ['notify', '--no-title', '--body', '正文', '--no-sound'],
    ['notify', '--no-title', '--no-body'],
    ['notify', '--title', '自选标题', '--body', '自选正文'],
    ['notify', '正文有 空格和中文', '--no-sound'],
  ]) {
    const parsed = parseCommand(args)
    await run(s, parsed.command!, parsed.positional, parsed.options)
  }
  assert.deepEqual(sent, [
    { title: 'DSH', body: '有一条新通知', sound: true },
    { title: '标题', body: undefined, sound: false },
    { title: undefined, body: '正文', sound: false },
    { title: undefined, body: undefined, sound: true },
    { title: '自选标题', body: '自选正文', sound: true },
    { title: 'DSH', body: '正文有 空格和中文', sound: false },
  ])
  await assert.rejects(run(s, 'notify', [], { 'no-title': true, 'no-body': true, 'no-sound': true }), UsageError)
  for (const options of [{ title: '标题', 'no-title': true }, { body: '正文', 'no-body': true }, { sound: true, 'no-sound': true }, { body: ' ' }]) {
    await assert.rejects(run(s, 'notify', [], options), UsageError)
  }
  await assert.rejects(run(s, 'notify', ['']), UsageError)
  await assert.rejects(run(s, 'notify', ['正文'], { body: '另一正文' }), UsageError)
  await assert.rejects(run(s, 'notify', ['正文'], { 'no-body': true }), UsageError)
  await assert.rejects(run(s, 'notify', ['正文一', '正文二']), UsageError)
  fake.readOnly = true
  await assert.rejects(run(s, 'notify'), { code: 'read-only' })
  assert.equal(sent.length, 6)
})

test('monitor 直接给指定会话挂服务，保留命令与目录，不发消息也不唤醒模型', async () => {
  const f = makeFake()
  const requests: MonitorStartRequest[] = []
  const s = service(f, undefined, undefined, undefined, { startMonitor: async (request) => {
    requests.push(request)
    request.result = { id: 'monitor-original', owner: request.owner, command: request.command, cwd: request.cwd, label: request.label }
  } })
  const command = "fish -lc 'echo 中文; echo $HOME'"
  const result = await run(s, 'monitor', ['aaaa'], { command, cwd: '/repo/a', label: '原会话桥接' })
  assert.equal(requests.length, 1)
  assert.deepEqual(result.data, { id: 'monitor-original', owner: 'session-aaaa1111-0000', command, cwd: '/repo/a', label: '原会话桥接' })
  assert.equal(f.calls.some((c) => /prompt|send|generate|cancel/.test(c.endpoint)), false)
})

test('monitor 拒绝只读、坏参数、存档或不存在会话，插件缺失与未确认结果不报成功', async () => {
  const f = makeFake()
  let starts = 0
  let startMonitor: NonNullable<Deps['startMonitor']> = async () => { starts++ }
  const s = service(f, undefined, undefined, undefined, { startMonitor: (request) => startMonitor(request) })
  const valid = { command: 'serve', cwd: '/repo/a' }
  f.readOnly = true
  await assert.rejects(() => run(s, 'monitor', ['aaaa'], valid), /只读/)
  f.readOnly = false
  await assert.rejects(() => run(s, 'monitor', ['aaaa'], { ...valid, command: ' ' }), /--command/)
  await assert.rejects(() => run(s, 'monitor', ['aaaa'], { ...valid, cwd: 'relative' }), /绝对工作目录/)
  f.archived = ['session-aaaa1111-0000']
  await assert.rejects(() => run(s, 'monitor', ['aaaa'], valid), /已存档/)
  f.archived = []
  await assert.rejects(() => run(s, 'monitor', ['不存在'], valid), /找不到/)
  assert.equal(starts, 0)
  await assert.rejects(() => run(s, 'monitor', ['aaaa'], valid), /没有监听插件接收/)
  assert.equal(starts, 1)
  startMonitor = async (request) => {
    starts++
    request.result = { id: 'wrong-owner', owner: 'session-maintenance', command: request.command, cwd: request.cwd, label: request.label }
  }
  await assert.rejects(() => run(s, 'monitor', ['aaaa'], valid), /不要重复启动/)
  await assert.rejects(() => run(service(f), 'monitor', ['aaaa'], valid), /没有直接启动/)
  assert.equal(starts, 2)
})

test('monitor --restart 原样交给监听插件，只认 never 和 on-failure', async () => {
  const f = makeFake()
  const requests: MonitorStartRequest[] = []
  const s = service(f, undefined, undefined, undefined, { startMonitor: async (request) => {
    requests.push(request)
    request.result = { id: 'monitor-new', owner: request.owner, command: request.command, cwd: request.cwd, label: request.label }
  } })
  await run(s, 'monitor', ['aaaa'], { command: 'serve', cwd: '/repo/a', restart: 'never' })
  assert.equal(requests[0]!.restart, 'never')
  await run(s, 'monitor', ['aaaa'], { command: 'serve', cwd: '/repo/a' })
  assert.equal(requests[1]!.restart, undefined)
  await assert.rejects(() => run(s, 'monitor', ['aaaa'], { command: 'serve', cwd: '/repo/a', restart: 'always' }), /--restart/)
  assert.equal(requests.length, 2)
})

test('kill-jobs 停 bash 任务时从主人会话记录查出启动目录，查不到就不填', async () => {
  const f = makeFake()
  const owner = 'session-aaaa1111-0000'
  f.events[owner]!.push(
    { type: 'job/registered', seq: 6, data: { jobId: 'bash-1', owner, kind: 'bash', label: 'pnpm dev', toolCall: { callId: 'call-dev' } } },
    { type: 'tool/ptc-dispatch', seq: 7, data: { subCallId: 'call-other', meta: { cwd: '/wrong' } } },
    { type: 'tool/ptc-dispatch', seq: 8, data: { subCallId: 'call-dev', meta: { cwd: '/repo/a/site' } } },
    { type: 'job/registered', seq: 9, data: { jobId: 'bash-2', owner, kind: 'bash', label: 'sleep 9', toolCall: { callId: 'call-lost' } } },
  )
  const killed: string[] = []
  const s = service(f, undefined, () => ({ running: [], queued: [], jobs: [
    { id: 'bash-1', kind: 'bash', label: 'pnpm dev', owner },
    { id: 'bash-2', kind: 'bash', label: 'sleep 9', owner },
    { id: 'sub-1', kind: 'subagent', label: '子代理', owner },
  ] }), undefined, { killJob: (id) => { killed.push(id); return 'requested' } })
  const result = await run(s, 'kill-jobs', ['all'])
  assert.deepEqual(killed, ['bash-1', 'bash-2', 'sub-1'])
  assert.deepEqual((result.data as { killed: unknown[] }).killed, [
    { id: 'bash-1', outcome: 'requested', kind: 'bash', label: 'pnpm dev', owner, cwd: '/repo/a/site' },
    { id: 'bash-2', outcome: 'requested', kind: 'bash', label: 'sleep 9', owner },
    { id: 'sub-1', outcome: 'requested', kind: 'subagent', label: '子代理', owner },
  ])
})

test('旧会话只留子代理停止通知：不算运行、不算下一轮排队，也不阻挡等待', async () => {
  const f = makeFake()
  f.sessions.forEach((s) => { s.running = false })
  const old = f.sessions[0]!
  old.agentAvailable = false
  old.projections!.values!.inbox = { 'next-turn': [], 'next-step': [{ id: 'old-notice', content: [], source: { kind: 'subagent-settled' } }] }
  const s = service(f)
  const result = await s.waitIdle({ sliceMs: 1 })
  assert.deepEqual(result.data, { idle: true, running: [], queued: [] })
  assert.equal(((await s.status('aaaa1111')).data as { queued: number }).queued, 0)
  assert.equal(((await s.queue('aaaa1111', undefined, [])).data as { items: unknown[] }).items.length, 0)
})

test('等待用宿主真实状态：一条在跑、一条真实排队；旧磁盘通知不混进计数', async () => {
  const f = makeFake()
  f.sessions[0]!.projections!.values!.inbox = { 'next-step': [{ id: 'old-notice' }] }
  const s = service(f, undefined, () => ({ running: ['session-bbbb2222-0000'], queued: ['session-cccc3333-0000'], jobs: [] }))
  const result = await s.waitIdle({ sliceMs: 1 })
  assert.deepEqual(result.data, { idle: false, running: ['session-bbbb2222-0000'], queued: ['session-cccc3333-0000'] })
  assert.match(result.text, /还有 1 个会话在跑：bbbb2222/)
  assert.match(result.text, /1 个空闲会话有排队消息：cccc3333/)
  assert.doesNotMatch(result.text, /aaaa1111|2 个会话在跑/)
})

test('真实队列为空时等待立即完成，即使磁盘投影还留着通知', async () => {
  const f = makeFake()
  f.sessions[0]!.projections!.values!.inbox = { 'next-step': [{ id: 'old-notice' }] }
  const result = await service(f, undefined, () => ({ running: [], queued: [], jobs: [] })).waitIdle({ sliceMs: 30_000 })
  assert.deepEqual(result.data, { idle: true, running: [], queued: [] })
})

test('wait-idle 指定会话：忽略别的会话，只认实际运行和排队，提问单独返回', async () => {
  const fake = makeFake()
  const target = fake.sessions[0]!.sessionId
  let blockers = { running: [fake.sessions[1]!.sessionId], queued: [] as string[], jobs: [] }
  const s = service(fake, undefined, () => blockers)
  const idle = await run(s, 'wait-idle', ['aaaa1111'], { slice: '100' })
  assert.deepEqual(idle.data, { sessionId: target, idle: true, running: [], queued: [] })
  blockers = { ...blockers, queued: [target] }
  const queued = await run(s, 'wait-idle', ['aaaa1111'], { slice: '5' })
  assert.equal(queued.status, 'running')
  assert.deepEqual((queued.data as { queued: string[] }).queued, [target])
  const asking = await run(s, 'wait-idle', ['cccc3333'], { slice: '100' })
  assert.equal(asking.status, 'waiting-input')
  assert.equal((asking.data as { questions: unknown[] }).questions.length, 1)
  await assert.rejects(run(s, 'wait-idle', ['missing-session'], { slice: '1' }), (e: { code?: string }) => e.code === 'not-found')
  await assert.rejects(run(s, 'wait-idle', ['aaaa1111'], { slice: '0' }), /--slice/)
})

test('wait-idle 指定会话：只在目标停下并清完真实队列时返回', async () => {
  const fake = makeFake()
  const target = fake.sessions[1]!.sessionId
  let blockers = { running: [target, fake.sessions[0]!.sessionId], queued: [] as string[], jobs: [] }
  const s = service(fake, undefined, () => blockers)
  let done = false
  let waitedForQueue = false
  const waiting = run(s, 'wait-idle', ['bbbb2222'], { slice: '3000' }).then((result) => { done = true; return result })
  setTimeout(() => {
    blockers = { ...blockers, running: [fake.sessions[0]!.sessionId], queued: [target] }
    for (const listener of fake.statusListeners) listener(target, false)
  }, 30)
  setTimeout(() => {
    waitedForQueue = !done
    blockers = { ...blockers, queued: [] }
    for (const listener of fake.statusListeners) listener(target, false)
  }, 100)
  const result = await waiting
  assert.equal(waitedForQueue, true, '目标仍有排队消息，不能报空闲')
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.data, { sessionId: target, idle: true, running: [], queued: [] })
})

test('wait-idle 经真实命令行连续等待：改标题后仍盯原会话，超时和提问保留退出码', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-control-wait-idle-'))
  const fake = makeFake()
  const target = fake.sessions[1]!.sessionId
  const svc = service(fake)
  const socketPath = join(root, 'dsh-control/dsh.sock')
  let calls = 0
  let renameOnFirstSlice = false
  const server = await startServer({ socketPath, commands: () => COMMANDS, info: () => ({}), log: () => {}, run: async (command, args, options, signal) => {
    if (command === 'wait-idle') {
      calls++
      if (renameOnFirstSlice && calls === 2) fake.sessions[1]!.running = false
    }
    const result = await runCommand(svc, command, args, options, signal)
    if (command === 'wait-idle' && renameOnFirstSlice && calls === 1) {
      fake.sessions[1]!.projections!.values!.title = '已改的新标题'
      fake.sessions[0]!.projections!.values!.title = '写文档'
    }
    return result
  } })
  const cli = (args: string[]) => invokeCli(args, { DSH_HOME: root, DSH_CONTROL_SOCKET: socketPath })
  try {
    renameOnFirstSlice = true
    const result = await cli(['wait-idle', '写文档', '--timeout', '2', '--slice', '20', '--json'])
    assert.equal(result.code, 0, result.out + result.err)
    assert.ok(calls >= 2)
    assert.equal(JSON.parse(result.out).data.sessionId, target)
    calls = 0
    renameOnFirstSlice = false
    fake.sessions[1]!.running = true
    const timeout = await cli(['wait-idle', 'bbbb2222', '--timeout', '0.12', '--slice', '20', '--json'])
    assert.equal(timeout.code, 124, timeout.out + timeout.err)
    assert.equal(JSON.parse(timeout.out).status, 'timeout')
    assert.ok(calls >= 2)
    const asking = await cli(['wait-idle', 'cccc3333', '--timeout', '2', '--json'])
    assert.equal(asking.code, 10, asking.out + asking.err)
    assert.equal(JSON.parse(asking.out).status, 'waiting-input')
    for (const option of [['--timeout', '0'], ['--slice', '0'], ['--slice', '1.5']]) {
      const invalid = await cli(['wait-idle', 'bbbb2222', ...option, '--json'])
      assert.equal(invalid.code, 2, invalid.out + invalid.err)
    }
  } finally {
    await server.close()
    svc.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('wait-idle 在只读等待连接中断后重连，仍等待原会话', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-control-idle-reconnect-'))
  const fake = makeFake()
  const svc = service(fake)
  const socketPath = join(root, 'dsh-control/dsh.sock')
  let requests = 0
  let restarting: Promise<void> = Promise.resolve()
  const options = { socketPath, commands: () => COMMANDS, info: () => ({}), log: () => {}, run: async (command: string, args: string[], opts: Record<string, unknown>, signal: AbortSignal) => {
    if (command === 'wait-idle' && ++requests === 1) {
      restarting = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        await server.close()
        fake.sessions[1]!.running = false
        server = await startServer(options)
      })()
    }
    return runCommand(svc, command, args, opts, signal)
  } }
  let server = await startServer(options)
  try {
    const result = await invokeCli(['wait-idle', 'bbbb2222', '--timeout', '6', '--slice', '4000', '--json'], { DSH_HOME: root, DSH_CONTROL_SOCKET: socketPath })
    await restarting
    assert.equal(result.code, 0, result.out + result.err)
    assert.equal(JSON.parse(result.out).data.sessionId, fake.sessions[1]!.sessionId)
    assert.ok(requests >= 2)
  } finally {
    await restarting
    await server.close()
    svc.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})

test('restart-abort 等恢复确认才返回，成功与失败分别保留在协议结果', async () => {
  let release: (value: RestartRecoveryResult) => void = () => {}
  const pending = new Promise<RestartRecoveryResult>(resolve => { release = resolve })
  const svc = service(makeFake(), undefined, undefined, () => pending)
  let returned = false
  const response = runCommand(svc, 'restart-abort', [], {}, new AbortController().signal).then(result => { returned = true; return result })
  await Promise.resolve()
  assert.equal(returned, false, '不能把开始恢复当作确认恢复')
  const result: RestartRecoveryResult = { revived: ['monitor-1'], failed: [{ id: 'monitor-2', owner: 'session-owner', error: 'spawn refused' }] }
  release(result)
  const actual = await response
  assert.deepEqual(actual.data, result)
  assert.match(actual.text, /恢复未完成.*monitor-2.*spawn refused/)
  assert.doesNotMatch(actual.text, /已接回/)
})

test('restart-abort 全部成功和空记录都有明确确认，缺能力或事件失败不能当成功', async () => {
  const success = await service(makeFake(), undefined, undefined, async () => ({ revived: ['monitor-1'], failed: [] })).restartAbort()
  assert.deepEqual(success.data, { revived: ['monitor-1'], failed: [] })
  assert.match(success.text, /已接回：monitor-1/)
  const empty = await service(makeFake(), undefined, undefined, async () => ({ revived: [], failed: [] })).restartAbort()
  assert.deepEqual(empty.data, { revived: [], failed: [] })
  await assert.rejects(service(makeFake()).restartAbort(), { code: 'restart-abort-unsupported' })
  await assert.rejects(service(makeFake(), undefined, undefined, async () => { throw new Error('recovery event failed') }).restartAbort(), /recovery event failed/)
  const readOnly = makeFake()
  readOnly.readOnly = true
  let called = false
  await assert.rejects(service(readOnly, undefined, undefined, async () => { called = true; return { revived: [], failed: [] } }).restartAbort())
  assert.equal(called, false, '只读模式不能触发恢复写操作')
})

test('health 数出在跑和在等回答的会话，子代理不算', async () => {
  const r = await run(service(makeFake()), 'health')
  assert.match(r.text, /会话 3 个（和 dsh-control sessions 默认口径一致.*），在跑 1 个，等你回答 1 个/)
})

test('会话标识：id 开头、末尾、标题词都认；对上多个就列候选不猜', async () => {
  const s = service(makeFake())
  assert.equal((await s.resolve('aaaa1111')).id, 'session-aaaa1111-0000')
  assert.equal((await s.resolve('修 CI')).id, 'session-aaaa1111-0000')
  await assert.rejects(s.resolve('0000'), /对上了 4 个会话/)
  await assert.rejects(s.resolve('没有这个'), /找不到会话/)
})

test('sessions 按工作区、在跑过滤', async () => {
  const s = service(makeFake())
  const byWs = await run(s, 'sessions', [], { workspace: 'repo-a' })
  assert.deepEqual((byWs.data as { sessionId: string }[]).map((x) => x.sessionId).sort(), ['session-aaaa1111-0000', 'session-cccc3333-0000'])
  const running = await run(s, 'sessions', [], { running: true })
  assert.deepEqual((running.data as { sessionId: string }[]).map((x) => x.sessionId).sort(), ['session-bbbb2222-0000', 'session-cccc3333-0000'])
})

test('sessions --cwd 按目录过滤（不在工作区列表里的目录也能找）', async () => {
  const r = await run(service(makeFake()), 'sessions', [], { cwd: '/repo/b' })
  assert.deepEqual((r.data as { sessionId: string }[]).map((x) => x.sessionId), ['session-bbbb2222-0000'])
})

test('status 和 last：给出模型、待办、最后回复，不输出思考块', async () => {
  const s = service(makeFake())
  const st = await run(s, 'status', ['aaaa1111'])
  assert.match(st.text, /模型：claude\/claude-opus-5-5/)
  assert.match(st.text, /待办：1\/2 完成/)
  const last = await run(s, 'last', ['aaaa1111'])
  assert.match(last.text, /修好了，测试全绿。/)
  assert.doesNotMatch(last.text, /SECRET-THINK/)
})

test('read --turn：结构化结果里带这一轮正文，命令行 --json 和 Python 入口都拿得到', async () => {
  const s = service(makeFake())
  const r = await run(s, 'read', ['aaaa1111'], { turn: '1' })
  const data = r.data as { turn: number; text: string }
  assert.equal(data.turn, 1)
  assert.equal(data.text, r.text)
  assert.match(data.text, /帮我修 CI/)
  assert.match(data.text, /修好了，测试全绿。/)
})

function promptModes(fake: Fake): string[] {
  return fake.calls.filter((c) => c.endpoint === 'session/prompt').map((c) => (c.args['request'] as { mode: string }).mode)
}

/** 排队消息：id 是 q1、q2…，发消息时的请求 id 是 aaaa000N-…，所以编号是 aaaa000N。 */
function setQueue(fake: Fake, sessionId: string, texts: string[]): void {
  const s = fake.sessions.find((x) => x.sessionId === sessionId)!
  ;(s.projections!.values as Record<string, unknown>)['inbox'] = { 'next-turn': texts.map((text, i) => ({ id: `q${i + 1}`, source: { kind: 'user', rpcId: `aaaa000${i + 1}-1111-2222-3333-444455556666` }, content: [{ type: 'text', text }] })), 'next-step': [] }
}

function steeredIds(fake: Fake): string[] {
  return fake.calls.filter((c) => c.endpoint === 'session/updateQueue' && (c.args['request'] as { action: { kind: string } }).action.kind === 'steer').map((c) => (c.args['request'] as { itemId: string }).itemId)
}

test('send --now：会话在跑就插进当前这一轮（宿主 steer）；旧名 --steer 一样', async () => {
  const fake = makeFake()
  const s = service(fake)
  const r = await run(s, 'send', ['bbbb2222', '改一下目标'], { now: true })
  assert.match(r.text, /已插进当前这一轮/)
  await run(s, 'send', ['bbbb2222', '再改'], { steer: true })
  assert.deepEqual(promptModes(fake), ['steer', 'steer'])
  assert.equal(fake.calls.some((c) => c.endpoint === 'session/cancel'), false)
})

test('send --now：会话没在跑时照常发出（不插话，宿主此时不接受插话）', async () => {
  const fake = makeFake()
  const r = await run(service(fake), 'send', ['aaaa1111', '继续'], { now: true })
  assert.deepEqual(promptModes(fake), ['queue'])
  assert.match(r.text, /已发出，会话开始处理/)
})

test('send 默认排队：在跑时说清前面排了几条、怎么提前', async () => {
  const fake = makeFake()
  setQueue(fake, 'session-bbbb2222-0000', ['旧消息一', '旧消息二'])
  const r = await run(service(fake), 'send', ['bbbb2222', '新消息'])
  assert.deepEqual(promptModes(fake), ['queue'])
  assert.match(r.text, /排到下一轮（会话正在跑，前面还有 2 条排队）/)
  assert.match(r.text, /这条的编号是 [0-9a-f]{8}/)
})

test('send --interrupt：先中止当前这一步（保留排队），再把这条作为下一轮开头', async () => {
  const fake = makeFake()
  setQueue(fake, 'session-bbbb2222-0000', ['旧消息'])
  const r = await run(service(fake), 'send', ['bbbb2222', '停下，改做这个'], { interrupt: true })
  const order = fake.calls.filter((c) => c.endpoint === 'session/cancel' || c.endpoint === 'session/prompt').map((c) => c.endpoint)
  assert.deepEqual(order, ['session/cancel', 'session/prompt'])
  assert.deepEqual(promptModes(fake), ['queue'])
  assert.match(r.text, /已中止当前这一步/)
  assert.match(r.text, /前面还有 1 条排队消息/)
  assert.equal((r.data as { interrupted: boolean }).interrupted, true)
})

test('send --interrupt 对没在跑的会话不中止，直接发', async () => {
  const fake = makeFake()
  await run(service(fake), 'send', ['aaaa1111', '做这个'], { interrupt: true })
  assert.equal(fake.calls.some((c) => c.endpoint === 'session/cancel'), false)
  assert.deepEqual(promptModes(fake), ['queue'])
})

test('notice、send 不往已存档的会话送：宿主不让它开新一轮，明说送不到；查不到存档名单时照常送', async () => {
  // 2026-10-19：重启放弃的通知送进已存档的 5d27c6fd，那一轮直接 blocked，没人重排（复盘 I-018）
  const fake = makeFake()
  fake.archived = ['session-aaaa1111-0000']
  const notices: string[] = []
  const s = service(fake, undefined, undefined, undefined, { notice: async (id) => { notices.push(id); return { accepted: true, scheduled: true, delivery: 'followup', agentStatus: 'running' } } })
  await assert.rejects(run(s, 'notice', ['aaaa1111', '请再排一次']), (e: unknown) => e instanceof UsageError && e.code === 'session-archived' && /已存档/.test(e.message))
  await assert.rejects(run(s, 'send', ['aaaa1111', '继续']), (e: unknown) => e instanceof UsageError && e.code === 'session-archived')
  assert.deepEqual(notices, [])
  assert.deepEqual(promptModes(fake), [])
  await run(s, 'notice', ['cccc3333', '请再排一次'])
  assert.deepEqual(notices, ['session-cccc3333-0000'])
  fake.workspaceError = true
  await run(s, 'notice', ['aaaa1111', '请再排一次'])
  assert.deepEqual(notices, ['session-cccc3333-0000', 'session-aaaa1111-0000'])
})

test('notice 区分已记录和已安排执行，未确认执行的失败保留回执', async () => {
  const fake = makeFake()
  let accepted = 0
  const s = service(fake, undefined, undefined, undefined, { notice: async () => { accepted++; return { accepted: true, scheduled: false, delivery: 'followup', agentStatus: 'idle' } } })
  await assert.rejects(run(s, 'notice', ['aaaa1111', '继续']), (error: unknown) => {
    const result = error as { code: string; details: { accepted: boolean; scheduled: boolean; sessionId: string } }
    assert.equal(result.code, 'notice-wakeup-unconfirmed')
    assert.equal(result.details.accepted, true)
    assert.equal(result.details.scheduled, false)
    assert.equal(result.details.sessionId, 'session-aaaa1111-0000')
    return true
  })
  assert.equal(accepted, 1)
  assert.deepEqual(promptModes(fake), [])
  const success = service(fake, undefined, undefined, undefined, { notice: async () => ({ accepted: true, scheduled: true, delivery: 'followup', agentStatus: 'running' }) })
  const result = await run(success, 'notice', ['aaaa1111', '继续'])
  assert.equal((result.data as { scheduled: boolean }).scheduled, true)
  assert.match(result.text, /尚未确认模型回复/)
})

test('send 不能同时 --now 和 --interrupt', async () => {
  await assert.rejects(run(service(makeFake()), 'send', ['bbbb2222', 'x'], { now: true, interrupt: true }), /只能选一个/)
})

test('queue list / steer all / remove / edit', async () => {
  const fake = makeFake()
  const s = service(fake)
  setQueue(fake, 'session-bbbb2222-0000', ['第一条', '第二条', '第三条'])
  const list = await run(s, 'queue', ['bbbb2222'])
  assert.match(list.text, /有 3 条排队消息/)
  assert.match(list.text, /2\. \[aaaa0002\] 第二条/)
  await run(s, 'queue', ['bbbb2222', 'edit', 'aaaa0003', '改过的第三条'])
  const edit = fake.calls.find((c) => c.endpoint === 'session/updateQueue')!
  assert.deepEqual(edit.args['request'], { sessionId: 'session-bbbb2222-0000', itemId: 'q3', action: { kind: 'edit', content: [{ type: 'text', text: '改过的第三条' }] } })
  setQueue(fake, 'session-bbbb2222-0000', ['第一条', '第二条', '第三条'])
  await run(s, 'queue', ['bbbb2222', 'remove', '1'])
  const steered = await run(s, 'queue', ['bbbb2222', 'steer'])
  assert.match(steered.text, /已把 2 条插进当前这一轮/)
  await assert.rejects(run(s, 'queue', ['bbbb2222', 'remove', '9']), /排队里没有 9/)
})

test('queue steer：会话没在跑时拒绝（排队本来就会马上处理）', async () => {
  const fake = makeFake()
  setQueue(fake, 'session-aaaa1111-0000', ['x'])
  await assert.rejects(run(service(fake), 'queue', ['aaaa1111', 'steer']), /不用插话/)
})

test('queue steer 乱序挑几条：只提前点名的，按队列原来的先后插进当前轮，其余留在排队里', async () => {
  const fake = makeFake()
  setQueue(fake, 'session-bbbb2222-0000', ['真排队一', '修正A', '真排队二', '修正B', '真排队三'])
  const r = await run(service(fake), 'queue', ['bbbb2222', 'steer', 'aaaa0004', '2'])
  assert.deepEqual(steeredIds(fake), ['q2', 'q4'])
  assert.match(r.text, /已把 2 条插进当前这一轮/)
  assert.match(r.text, /还剩 3 条照常排队/)
  const left = (fake.sessions.find((x) => x.sessionId === 'session-bbbb2222-0000')!.projections!.values as Record<string, { 'next-turn': { id: string }[] }>)['inbox']!['next-turn'].map((m) => m.id)
  assert.deepEqual(left, ['q1', 'q3', 'q5'])
})

test('queue 点名有一个对不上就整条不做，免得做了一半', async () => {
  const fake = makeFake()
  setQueue(fake, 'session-bbbb2222-0000', ['一', '二'])
  await assert.rejects(run(service(fake), 'queue', ['bbbb2222', 'steer', 'aaaa0001', 'ffff9999']), /排队里没有 ffff9999/)
  assert.deepEqual(steeredIds(fake), [])
})

test('queue 编号不随队列前移：前面的被领走后，同一个编号还是点到同一条', async () => {
  const fake = makeFake()
  setQueue(fake, 'session-bbbb2222-0000', ['一', '二', '三'])
  const s = service(fake)
  const inbox = (fake.sessions.find((x) => x.sessionId === 'session-bbbb2222-0000')!.projections!.values as Record<string, { 'next-turn': unknown[] }>)['inbox']!
  inbox['next-turn'].shift()
  await run(s, 'queue', ['bbbb2222', 'steer', 'aaaa0003'])
  assert.deepEqual(steeredIds(fake), ['q3'])
})

test('queue remove 可以一次删几条', async () => {
  const fake = makeFake()
  setQueue(fake, 'session-bbbb2222-0000', ['一', '二', '三'])
  const r = await run(service(fake), 'queue', ['bbbb2222', 'remove', 'aaaa0001', 'aaaa0003'])
  assert.match(r.text, /已删掉 2 条/)
})

test('send 排队时给出这条的编号，之后可以直接点名提前', async () => {
  const fake = makeFake()
  const r = await run(service(fake), 'send', ['bbbb2222', '真排队'])
  const code = (r.data as { queueCode: string }).queueCode
  const rpcId = (fake.calls.find((c) => c.endpoint === 'session/prompt')!.args['request'] as { requestId: string }).requestId
  assert.equal(code, rpcId.replace(/-/g, '').slice(0, 8))
  assert.match(r.text, new RegExp(`queue bbbb2222 steer ${code}`))
})

test('queue steer：中途这一轮结束了就停下，剩下的照常进下一轮，不算失败', async () => {
  const fake = makeFake()
  setQueue(fake, 'session-bbbb2222-0000', ['一', '二', '三'])
  const s = service(fake)
  const b = fake.sessions.find((x) => x.sessionId === 'session-bbbb2222-0000')!
  const gw = (s as unknown as { deps: Deps }).deps.gateway
  const orig = gw.invoke.bind(gw)
  let n = 0
  gw.invoke = async (req) => {
    if (req.namespace === 'session' && req.method === 'updateQueue' && ++n === 2) b.running = false
    return orig(req)
  }
  const r = await run(s, 'queue', ['bbbb2222', 'steer', 'all'])
  assert.match(r.text, /插进了 1 条；aaaa0002、aaaa0003 没插成/)
})

test('send 返回起点 seq，并在额度紧张时只提醒不换模型', async () => {
  const fake = makeFake()
  const s = service(fake)
  const r = await run(s, 'send', ['aaaa1111', '继续', '跑测试'])
  const data = r.data as { since: number; notes: string[] }
  assert.equal(data.since, 5)
  const prompt = fake.calls.find((c) => c.endpoint === 'session/prompt')!
  assert.deepEqual((prompt.args['request'] as { content: unknown }).content, [{ type: 'text', text: '继续 跑测试' }])
  assert.equal(fake.calls.some((c) => c.endpoint === 'session/selectModel'), false)
})

test('wait：空闲且 since 之后有新的一轮结束就返回回复；在等回答返回 waiting-input；还在跑到时间返回 running', async () => {
  const fake = makeFake()
  const s = service(fake)
  const done = await run(s, 'wait', ['aaaa1111'], { since: '4' })
  assert.equal(done.status, 'ok')
  assert.match(done.text, /修好了/)
  const asking = await run(s, 'wait', ['cccc3333'])
  assert.equal(asking.status, 'waiting-input')
  assert.match(asking.text, /用哪个方案？/)
  const running = await run(s, 'wait', ['bbbb2222'], { slice: '1000' })
  assert.equal(running.status, 'running')
})

test('wait 被状态事件唤醒：会话跑完后不必等满一段', async () => {
  const fake = makeFake()
  const s = service(fake)
  const b = fake.sessions.find((x) => x.sessionId === 'session-bbbb2222-0000')!
  setTimeout(() => {
    b.running = false
    fake.events['session-bbbb2222-0000']!.push(
      { type: 'assistant/message', seq: 3, data: { turn: 1, message: { content: [{ type: 'text', text: '文档写好了' }] } } },
      { type: 'turn/end', seq: 4, data: { turn: 1, reason: { kind: 'completed' } } },
    )
    for (const l of fake.statusListeners) l(b.sessionId, false)
  }, 200)
  const started = Date.now()
  const r = await run(s, 'wait', ['bbbb2222'], { since: '2', slice: '20000' })
  assert.equal(r.status, 'ok')
  assert.match(r.text, /文档写好了/)
  assert.ok(Date.now() - started < 5000)
})

test('model：已开始的会话额度没用光就拒绝换（保护缓存）；--force 才换，并且不传推理等级', async () => {
  const fake = makeFake()
  // Claude 额度紧（撑不到重置、剩不到一半）但没用光：normal 档改挑 Codex，已开始的会话仍拒绝换。
  fake.report = { fetchedAt: NOW, providers: report.providers.map((p) => p.id === 'claude' ? { ...p, windows: p.windows.map((w) => ({ ...w, runsOut: NOW + 3_600_000 })) } : p) }
  const s = service(fake)
  await assert.rejects(run(s, 'model', ['aaaa1111'], { tier: 'normal' }), (e: { code?: string; message: string }) => e.code === 'model-change-refused' && /没换/.test(e.message))
  assert.equal(fake.calls.some((c) => c.endpoint === 'session/selectModel'), false)
  const forced = await run(s, 'model', ['aaaa1111'], { tier: 'normal', force: true })
  const call = fake.calls.find((c) => c.endpoint === 'session/selectModel')!
  assert.deepEqual(call.args['request'], { sessionId: 'session-aaaa1111-0000', provider: 'codex', model: 'gpt-6.1-sol' })
  assert.match(forced.text, /codex\/gpt-6.1-sol/)
})

test('model：当前模型额度用光（停滞）时允许换', async () => {
  const fake = makeFake()
  const s = service(fake)
  report.providers[0]!.windows[0]!.left = 0
  try {
    const r = await run(s, 'model', ['aaaa1111'], { tier: 'normal' })
    assert.match(r.text, /模型换成 codex\/gpt-6.1-sol/)
  } finally {
    report.providers[0]!.windows[0]!.left = 40
  }
})

test('new：默认 normal 档挑模型，fast 档用 opencode', async () => {
  const fake = makeFake()
  const s = service(fake)
  await run(s, 'new', ['repo-a', '做点小事'], { tier: 'fast' })
  const create = fake.calls.find((c) => c.endpoint === 'session/create')!
  assert.deepEqual(create.args['request'], { workspaceId: 'w1' })
  const sel = fake.calls.find((c) => c.endpoint === 'session/selectModel')!
  assert.deepEqual(sel.args['request'], { sessionId: 'session-eeee5555-0000', provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
  assert.ok(fake.calls.some((c) => c.endpoint === 'session/prompt'))
})

test('new：目标就是默认模型时带上默认的推理等级，不让它落回模型自带的低等级', async () => {
  const fake = makeFake()
  fake.defaultModel = { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' }
  await run(service(fake), 'new', ['repo-a', '长任务'], { model: 'codex/gpt-6.1-sol' })
  const sel = fake.calls.find((c) => c.endpoint === 'session/selectModel')!
  assert.deepEqual(sel.args['request'], { sessionId: 'session-eeee5555-0000', provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' })
  const other = makeFake()
  other.defaultModel = { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' }
  await run(service(other), 'new', ['repo-a', '小事'], { tier: 'fast' })
  const otherSel = other.calls.find((c) => c.endpoint === 'session/selectModel')!
  assert.deepEqual(otherSel.args['request'], { sessionId: 'session-eeee5555-0000', provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
})

test('new / model：装了 模型额度服务 时换模型走它的自动入口，不算用户「上一次选的」', async () => {
  const fake = makeFake()
  const automatic: { sessionId: string; provider: string; model: string; reasoningEffort?: string }[] = []
  const s = service(fake, undefined, undefined, undefined, {
    automaticSelect: () => ({
      async selectModel(request) {
        automatic.push(request)
        return { selected: { provider: request.provider, model: request.model, reasoningEffort: 'high' } }
      },
    }),
  })
  await run(s, 'new', ['repo-a', '做点小事'], { tier: 'fast' })
  assert.deepEqual(automatic, [{ sessionId: 'session-eeee5555-0000', provider: 'opencode-go', model: 'deepseek-v4.1-flash' }])
  assert.equal(fake.calls.some((c) => c.endpoint === 'session/selectModel'), false, '不再走普通切模型接口')
})

test('model：会话已经在用目标模型时不再发选择请求，免得等级被清掉', async () => {
  const fake = makeFake()
  fake.sessions[0]!.projections = { values: { title: '修 CI 失败', modelSelection: { lastUsed: null, next: { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' } } } }
  const r = await run(service(fake), 'model', ['aaaa1111'], { model: 'codex/gpt-6.1-sol', force: true })
  assert.equal(fake.calls.some((c) => c.endpoint === 'session/selectModel'), false)
  assert.match(r.text, /模型不变.*推理等级 xhigh/)
})

test('推理档位：只改档位遵守强制规则，换模型和新会话会传递档位', async () => {
  const fake = makeFake()
  fake.sessions[0]!.projections = { values: { title: '修 CI 失败', modelSelection: { next: { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' } } } }
  const s = service(fake)
  await assert.rejects(run(s, 'model', ['aaaa1111'], { effort: 'medium' }), /没换/)
  await run(s, 'model', ['aaaa1111'], { effort: 'medium', force: true })
  assert.deepEqual(fake.calls.find((c) => c.endpoint === 'session/selectModel')!.args['request'], { sessionId: 'session-aaaa1111-0000', provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'medium' })
  const other = makeFake()
  await run(service(other), 'model', ['aaaa1111'], { model: 'codex/gpt-6.1-sol', effort: 'high', force: true })
  assert.deepEqual(other.calls.filter((c) => c.endpoint === 'session/selectModel').map((c) => c.args['request']), [
    { sessionId: 'session-aaaa1111-0000', provider: 'codex', model: 'gpt-6.1-sol' },
    { sessionId: 'session-aaaa1111-0000', provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' },
  ])
  const fresh = makeFake()
  await run(service(fresh), 'new', ['repo-a'], { model: 'codex/gpt-6.1-sol', effort: 'high' })
  assert.deepEqual(fresh.calls.filter((c) => c.endpoint === 'session/selectModel').map((c) => c.args['request']), [
    { sessionId: 'session-eeee5555-0000', provider: 'codex', model: 'gpt-6.1-sol' },
    { sessionId: 'session-eeee5555-0000', provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high' },
  ])
})

test('换模型时记忆先覆盖，第二次设置后会话状态显示显式档位', async () => {
  const fake = makeFake()
  const requests: { provider: string; model: string; reasoningEffort?: string }[] = []
  const s = service(fake, undefined, undefined, undefined, { automaticSelect: () => ({
    async selectModel(request) {
      requests.push(request)
      const session = fake.sessions.find((item) => item.sessionId === request.sessionId)!
      const current = (session.projections!.values!.modelSelection as { next?: { model: string } }).next
      const effort = current?.model === request.model ? request.reasoningEffort : 'xhigh'
      const selected = { provider: request.provider, model: request.model, reasoningEffort: effort }
      session.projections!.values!.modelSelection = { next: selected }
      return { selected }
    },
  }) })
  await run(s, 'model', ['aaaa1111'], { model: 'codex/gpt-6.1-sol', effort: 'medium', force: true })
  assert.equal(requests.length, 2)
  const status = await run(s, 'status', ['aaaa1111'])
  assert.equal((status.data as { model: { reasoningEffort: string } }).model.reasoningEffort, 'medium')
})

test('会话没有确认指定档位时返回失败', async () => {
  const fake = makeFake()
  const s = service(fake, undefined, undefined, undefined, { automaticSelect: () => ({
    async selectModel(request) { return { selected: request } },
  }) })
  await assert.rejects(run(s, 'model', ['aaaa1111'], { model: 'codex/gpt-6.1-sol', effort: 'medium', force: true }), (error: { code?: string }) => error.code === 'effort-unconfirmed')
})

test('非法推理档位列出可选值，且创建前拒绝', async () => {
  const fake = makeFake()
  await assert.rejects(run(service(fake), 'new', ['repo-a'], { model: 'codex/gpt-6.1-sol', effort: 'max' }), /可选值：medium、high、xhigh/)
  assert.equal(fake.calls.some((c) => c.endpoint === 'session/create'), false)
})

test('answer：单个问题用选项回答；不是选项就报错', async () => {
  const fake = makeFake()
  const s = service(fake)
  await assert.rejects(run(s, 'answer', ['cccc3333'], { select: 'C' }), /不是这个问题的选项/)
  const r = await run(s, 'answer', ['cccc3333'], { select: 'A' })
  assert.match(r.text, /已回答/)
  const call = fake.calls.find((c) => c.endpoint === 'userQuestions/answer')!
  assert.deepEqual(call.args, { agentId: 'session-cccc3333-0000', callId: 'call-1', answer: { answers: [{ id: 'q1', selected: ['A'] }] } })
})

test('阻塞式提问：wait 返回在等回答，answer 走待答表把答案交回提问方', async () => {
  const fake = makeFake()
  const pending = new PendingQuestions()
  const s = service(fake, pending)
  const b = fake.sessions.find((x) => x.sessionId === 'session-bbbb2222-0000')!
  const asked = pending.listener({ questions: [{ id: 'color', question: '喜欢哪种颜色？', options: [{ label: '红' }, { label: '蓝' }] }], agent: { id: b.sessionId }, wait: { callId: 'call-9' } }, () => new Promise(() => {}))
  const waited = await run(s, 'wait', ['bbbb2222'], { since: '2' })
  assert.equal(waited.status, 'waiting-input')
  assert.match(waited.text, /喜欢哪种颜色？/)
  const health = await run(s, 'health')
  assert.match(health.text, /等你回答 2 个/)
  const r = await run(s, 'answer', ['bbbb2222'], { select: '蓝' })
  assert.match(r.text, /已回答/)
  assert.deepEqual(await asked, { answers: [{ id: 'color', selected: ['蓝'] }] })
  assert.equal(fake.calls.some((c) => c.endpoint === 'userQuestions/answer'), false)
})

test('只读模式拒绝写命令，api call 的写接口也拒；禁用的命名空间始终拒', async () => {
  const fake = makeFake()
  fake.readOnly = true
  const s = service(fake)
  await assert.rejects(run(s, 'send', ['aaaa1111', 'hi']), /只读模式/)
  await assert.rejects(run(s, 'api', ['call', 'schedule/delete', '{"request":{}}']), /只读模式/)
  const ok = await run(s, 'api', ['call', 'session/list', '{"_request":{}}'])
  assert.ok(ok.data)
  fake.readOnly = false
  await assert.rejects(run(s, 'api', ['call', 'credentials/set', '{}']), /被禁用/)
})

test('停用或卸载远程控制本身要 --force', async () => {
  const s = service(makeFake())
  await assert.rejects(run(s, 'plugin', ['disable', 'dsh-control']), /关掉远程控制本身/)
  await assert.rejects(run(s, 'plugin', ['remove', 'dsh-control']), /关掉远程控制本身/)
})

test('api list 标出写接口和禁用接口', async () => {
  const r = await run(service(makeFake()), 'api', ['list'])
  assert.match(r.text, /credentials\/set\(\) \[已禁用\]/)
  assert.match(r.text, /schedule\/delete\(request\) \[写\]/)
  assert.match(r.text, /session\/list\(_request\)$/m)
})

test('命令表里每条命令都有实现', async () => {
  const s = service(makeFake())
  for (const c of COMMANDS) {
    try {
      await run(s, c.name, [], {})
    } catch (error) {
      assert.doesNotMatch(String(error), /没有命令/)
    }
  }
})

// ---- 可靠性：退出码、等待、输出口径 ----

const code = (c: string) => (e: { code?: string }) => e.code === c

test('wait：会话空闲、起点之后没有新的一轮结束，立即返回 idle，不等满', async () => {
  const s = service(makeFake())
  const started = Date.now()
  const r = await run(s, 'wait', ['aaaa1111'], { since: '999', slice: '20000' })
  assert.equal(r.status, 'idle')
  assert.match(r.text, /没有新内容/)
  assert.match(r.text, /空闲/)
  assert.match(r.text, /最新 seq 5/)
  assert.ok(Date.now() - started < 5000)
  const same = await run(s, 'wait', ['aaaa1111'], { since: '5', slice: '20000' })
  assert.equal(same.status, 'idle')
})

test('wait：空闲但还有排队消息时不算空闲，到时间返回 running，文案写真实状态而不是写死「还在跑」', async () => {
  const fake = makeFake()
  const a = fake.sessions.find((x) => x.sessionId === 'session-aaaa1111-0000')!
  ;(a.projections!.values as Record<string, unknown>)['inbox'] = { 'next-turn': [{ id: 'm1' }], 'next-step': [] }
  const r = await run(service(fake), 'wait', ['aaaa1111'], { since: '5', slice: '1000' })
  assert.equal(r.status, 'running')
  assert.doesNotMatch(r.text, /还在跑/)
  assert.match(r.text, /排队/)
  assert.equal((r.data as { state: string }).state, 'idle')
})

test('status：会话在等回答时带 waiting-input（命令行给 10）', async () => {
  const s = service(makeFake())
  assert.equal((await run(s, 'status', ['cccc3333'])).status, 'waiting-input')
  assert.notEqual((await run(s, 'status', ['aaaa1111'])).status, 'waiting-input')
})

test('pick：整档没有可用模型是失败（no-model），不是成功', async () => {
  const fake = makeFake()
  fake.report = { fetchedAt: NOW, providers: report.providers.map((p) => p.id === 'opencode' ? { ...p, windows: p.windows.map((w) => ({ ...w, left: 0, resetsAt: NOW + 86_400_000 })) } : p) }
  await assert.rejects(run(service(fake), 'pick', ['fast']), code('no-model'))
})

test('new：档位没有可用模型时直接失败，不留下空会话', async () => {
  const fake = makeFake()
  fake.report = { fetchedAt: NOW, providers: report.providers.map((p) => p.id === 'opencode' ? { ...p, windows: p.windows.map((w) => ({ ...w, left: 0, resetsAt: NOW + 86_400_000 })) } : p) }
  await assert.rejects(run(service(fake), 'new', ['repo-a', '做点小事'], { tier: 'fast' }), code('no-model'))
  assert.equal(fake.calls.some((c) => c.endpoint === 'session/create'), false)
  assert.equal(fake.calls.some((c) => c.endpoint === 'session/prompt'), false)
})

test('new：给出可直接用于 wait 的真实起点 seq（文本和 data 一致）', async () => {
  const fake = makeFake()
  const r = await run(service(fake), 'new', ['repo-a', '做点小事'], { tier: 'fast' })
  assert.equal((r.data as { since: number }).since, 0)
  assert.match(r.text, /起点 seq 0/)
  assert.match(r.text, /dsh-control wait eeee5555 --since 0/)
  const blank = await run(service(makeFake()), 'new', ['repo-a'], { tier: 'fast' })
  assert.equal((blank.data as { since: number }).since, 0)
  assert.match(blank.text, /最新 seq 0/)
})

test('model：会话正在跑时拒绝换也是失败（session-running）', async () => {
  const fake = makeFake()
  fake.events['session-bbbb2222-0000'] = []
  await assert.rejects(run(service(fake), 'model', ['bbbb2222'], { tier: 'normal' }), code('session-running'))
})

test('answer：回答没被接收是失败（answer-rejected）', async () => {
  const fake = makeFake()
  fake.answerAccepted = false
  await assert.rejects(run(service(fake), 'answer', ['cccc3333'], { select: 'A' }), code('answer-rejected'))
})

test('plugin：宿主报告操作失败时命令失败（plugin-action-failed），不是「完成」', async () => {
  const s = service(makeFake())
  await assert.rejects(run(s, 'plugin', ['enable', 'broken-plugin']), (e: { code?: string; message: string }) => e.code === 'plugin-action-failed' && /boom/.test(e.message))
  const ok = await run(s, 'plugin', ['enable', 'fine-plugin'])
  assert.match(ok.text, /已经生效/)
})

test('quota：拿不到额度报告是失败（quota-unavailable）', async () => {
  const fake = makeFake()
  fake.report = undefined
  await assert.rejects(run(service(fake), 'quota'), code('quota-unavailable'))
})

function askColors(fake: Fake, labels: string[]): void {
  const c = fake.sessions.find((x) => x.sessionId === 'session-cccc3333-0000')!
  ;(c.projections!.values as Record<string, unknown>)['userQuestions'] = { active: [{ callId: 'call-1', state: 'open', questions: [{ id: 'q1', question: '颜色？', options: labels.map((label) => ({ label })) }] }], settled: [] }
}

test('answer --select：完全匹配优先，否则唯一前缀或唯一包含也接受，多个匹配报歧义列候选', async () => {
  const selected = (fake: Fake) => ((fake.calls.find((c) => c.endpoint === 'userQuestions/answer')!.args['answer'] as { answers: { selected: string[] }[] }).answers[0]!.selected)
  let fake = makeFake()
  askColors(fake, ['红色', '蓝色'])
  await run(service(fake), 'answer', ['cccc3333'], { select: '蓝' })
  assert.deepEqual(selected(fake), ['蓝色'])
  fake = makeFake()
  askColors(fake, ['浅红', '深蓝色'])
  await run(service(fake), 'answer', ['cccc3333'], { select: '蓝' })
  assert.deepEqual(selected(fake), ['深蓝色'])
  fake = makeFake()
  askColors(fake, ['蓝', '蓝色'])
  await run(service(fake), 'answer', ['cccc3333'], { select: '蓝' })
  assert.deepEqual(selected(fake), ['蓝'])
  fake = makeFake()
  askColors(fake, ['蓝色', '深蓝'])
  await run(service(fake), 'answer', ['cccc3333'], { select: '蓝' })
  assert.deepEqual(selected(fake), ['蓝色'])
  fake = makeFake()
  askColors(fake, ['蓝色', '蓝绿'])
  await assert.rejects(run(service(fake), 'answer', ['cccc3333'], { select: '蓝' }), (e: { code?: string; message: string }) => e.code === 'ambiguous' && /蓝色/.test(e.message) && /蓝绿/.test(e.message))
  fake = makeFake()
  askColors(fake, ['红色', '蓝色'])
  await assert.rejects(run(service(fake), 'answer', ['cccc3333'], { select: '绿' }), (e: { code?: string; message: string }) => e.code === 'invalid-option' && /红色、蓝色/.test(e.message))
})

test('sessions：默认模式提示被省略的归档会话数量；health 用同一口径并说明', async () => {
  const fake = makeFake()
  fake.archived = ['session-bbbb2222-0000']
  const s = service(fake)
  const r = await run(s, 'sessions', [], { limit: '5' })
  assert.equal((r.data as unknown[]).length, 2)
  assert.match(r.text, /另有 1 个已归档/)
  assert.match(r.text, /--all/)
  assert.deepEqual((r as { meta?: unknown }).meta, { shown: 2, matched: 2, archivedHidden: 1, blankHidden: 0 })
  const limited = await run(s, 'sessions', [], { limit: '1' })
  assert.match(limited.text, /还有 1 个/)
  const h = await run(s, 'health')
  assert.match(h.text, /会话 2 个/)
  assert.match(h.text, /已归档 1 个/)
  assert.equal((h.data as { sessions: number; archived: number }).sessions, 2)
  assert.equal((h.data as { archived: number }).archived, 1)
})

test('quota / models / pick：某家额度查不到时带上去哪修的提示和重查命令', async () => {
  const fake = makeFake()
  fake.report = { fetchedAt: NOW, providers: report.providers.map((p) => p.id === 'claude' ? { id: 'claude', name: 'Claude', ok: false, error: '读不到凭据', hint: 'claude auth login', windows: [] } : p) }
  const s = service(fake)
  const q = await run(s, 'quota')
  assert.match(q.text, /Claude：查不到（读不到凭据）/)
  assert.match(q.text, /claude auth login/)
  assert.match(q.text, /dsh-control quota --refresh/)
  const m = await run(s, 'models')
  assert.match(m.text, /claude auth login/)
  assert.match(m.text, /dsh-control quota --refresh/)
  const p = await run(s, 'pick', ['normal'])
  assert.match(p.text, /claude auth login/)
})

test('plugins：描述被截断时提示用 --json 看全文，--json 里带完整描述', async () => {
  const r = await run(service(makeFake()), 'plugins')
  assert.match(r.text, /…/)
  assert.match(r.text, /--json/)
  const long = (r.data as { name: string; description: string | null }[]).find((x) => x.name === 'long-one')!
  assert.match(long.description!, /结尾$/)
})

test('会话管理：存档、取消存档、重命名和分叉按宿主结果确认', async () => {
  const f = makeFake()
  const s = service(f)
  const archived = await run(s, 'archive', ['修 CI'])
  assert.deepEqual(archived.data, { sessionId: f.sessions[0]!.sessionId, archived: true })
  assert.deepEqual(f.calls.at(-1), { endpoint: 'workspace/archiveSession', args: { request: { sessionId: f.sessions[0]!.sessionId } } })
  await run(s, 'archive', ['aaaa1111'])
  assert.equal(f.archived.length, 1)
  assert.deepEqual((await run(s, 'unarchive', ['aaaa1111'])).data, { sessionId: f.sessions[0]!.sessionId, archived: false })
  await run(s, 'unarchive', ['aaaa1111'])
  assert.deepEqual((await run(s, 'rename', ['aaaa1111', '  新标题 中文  '])).data, { sessionId: f.sessions[0]!.sessionId, title: '新标题 中文', seq: 6 })
  assert.equal((await s.resolve('新标题')).id, f.sessions[0]!.sessionId)
  assert.deepEqual((await run(s, 'fork', ['aaaa1111'])).data, { sessionId: 'session-ffff6666-0000', sourceSessionId: f.sessions[0]!.sessionId })
  assert.deepEqual(f.calls.at(-1), { endpoint: 'session/fork', args: { request: { sessionId: f.sessions[0]!.sessionId } } })
  await run(s, 'fork', ['aaaa1111'], { 'at-seq': '0' })
  assert.deepEqual(f.calls.at(-1), { endpoint: 'session/fork', args: { request: { sessionId: f.sessions[0]!.sessionId, atSeq: 0 } } })
  assert.equal(f.calls.some((c) => c.endpoint === 'session/prompt' || c.endpoint === 'session/cancel'), false)
})

test('会话管理安全边界：只读、歧义、空标题、非法边界、活动任务都不写', async () => {
  const f = makeFake()
  const s = service(f)
  f.readOnly = true
  for (const [command, args] of [['archive', ['aaaa1111']], ['unarchive', ['aaaa1111']], ['rename', ['aaaa1111', '新']], ['fork', ['aaaa1111']]] as const) {
    await assert.rejects(run(s, command, [...args]), /只读模式/)
  }
  assert.equal(f.calls.length, 0)
  f.readOnly = false
  await assert.rejects(run(s, 'archive', ['0000']), { code: 'ambiguous' })
  await assert.rejects(run(s, 'rename', ['aaaa1111', '  ']), /空白/)
  await assert.rejects(run(s, 'rename', ['aaaa1111']), /缺少新标题/)
  await assert.rejects(run(s, 'archive', ['不存在']), { code: 'not-found' })
  for (const seq of ['-1', '1.5', '9007199254740992']) await assert.rejects(run(s, 'fork', ['aaaa1111'], { 'at-seq': seq }))
  await assert.rejects(run(s, 'archive', ['bbbb2222']), { code: 'session-active' })
  assert.deepEqual(f.archived, [])
  assert.equal(f.calls.some((c) => c.endpoint === 'session/cancel'), false)
  assert.equal((f.calls.at(-1)!.args['request'] as Record<string, unknown>)['stopActivity'], undefined)
})

test('未分组筛选拒绝残缺基线和会话列表，不能误报全部或零条', async () => {
  const f = makeFake()
  const s = service(f)
  for (const value of [{}, { items: [], archivedSessionIds: [] }, { items: [{ workspaceId: 'w', path: '/repo', title: 'w' }], archivedSessionIds: [], pinnedSessionIds: [] }, { items: [], archivedSessionIds: [42], pinnedSessionIds: [] }]) {
    f.workspaceBaseline = { type: 'baseline', value }
    await assert.rejects(run(s, 'sessions', [], { ungrouped: true }), { code: 'workspaces-unavailable' })
  }
  f.workspaceBaseline = undefined
  f.replies = { 'session/list': {} }
  await assert.rejects(run(s, 'sessions', [], { ungrouped: true }), { code: 'sessions-unavailable' })
})

test('宿主没有确认写入结果时不能报告成功', async () => {
  const f = makeFake()
  const s = service(f)
  f.replies = { 'workspace/archiveSession': { archivedSessionIds: [] }, 'workspace/unarchiveSession': { archivedSessionIds: [f.sessions[0]!.sessionId] }, 'session/rename': {}, 'session/fork': { sessionId: f.sessions[0]!.sessionId } }
  for (const [command, args, code] of [['archive', ['aaaa1111'], 'archive-unconfirmed'], ['unarchive', ['aaaa1111'], 'unarchive-unconfirmed'], ['rename', ['aaaa1111', '新'], 'rename-unconfirmed'], ['fork', ['aaaa1111'], 'fork-unconfirmed']] as const) {
    await assert.rejects(run(s, command, [...args]), { code })
  }
})

test('未分组按实际归属判断：同目录、分叉、空白、归档、子代理和超过一页', async () => {
  const f = makeFake()
  const grouped = f.sessions[0]!.sessionId
  for (let i = 0; i < 25; i++) f.sessions.push({ sessionId: `session-loose-${i}`, updatedAt: NOW - i, running: false, blank: i === 0, agentAvailable: true, cwd: '/repo/a', parentSessionId: grouped, projections: { values: { title: `未分组 ${i}` } } })
  f.archived = ['session-loose-1']
  const s = service(f)
  const list = await run(s, 'sessions', [], { ungrouped: true })
  assert.equal((list.data as unknown[]).length, 20)
  assert.deepEqual(list.meta, { shown: 20, matched: 23, archivedHidden: 1, blankHidden: 1 })
  const all = await run(s, 'sessions', [], { ungrouped: true, 'include-blank': true, all: true, limit: '0' })
  assert.equal((all.data as unknown[]).length, 25)
  assert.equal(all.meta!.matched, 25)
  const ids = (all.data as { sessionId: string }[]).map((x) => x.sessionId)
  assert.ok(!ids.includes(grouped) && !ids.includes('session-dddd4444-0000'))
  assert.ok(ids.includes('session-loose-0') && ids.includes('session-loose-1'))
  assert.equal((all.data as { archived: boolean }[]).filter((x) => x.archived).length, 1)
  assert.equal((await run(s, 'sessions', [], { workspace: 'w1', limit: '0' })).meta!.matched, 2)
  await assert.rejects(run(s, 'sessions', [], { workspace: 'w1', ungrouped: true }), /不能同时/)
  await assert.rejects(run(s, 'sessions', [], { limit: '-1' }), /非负/)
  f.workspaceError = true
  for (const options of [{ ungrouped: true }, { workspace: 'w1' }, {}]) await assert.rejects(run(s, 'sessions', [], options), /workspace unavailable/)
})



test('审查原始输入：模型保护、chat 写前校验、失败终态都走真实 CLI/socket/分派/服务', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-control-regression-'))
  const fake = makeFake()
  const s = service(fake)
  const socketPath = join(root, 'dsh-control/dsh.sock')
  let finishReason: string | undefined
  let waitFailure: 'usage' | 'exception' | undefined
  const server = await startServer({ socketPath, commands: () => COMMANDS, info: () => ({}), log: () => {}, run: async (c, a, o, sig) => {
    if (c === 'wait' && waitFailure === 'usage') throw new UsageError('夹具等待请求被拒', 'fixture-wait-rejected')
    if (c === 'wait' && waitFailure === 'exception') throw new Error('夹具等待服务出错')
    const result = await runCommand(s, c, a, o, sig)
    if (c === 'send' && finishReason !== undefined) {
      fake.sessions[0]!.running = false
      const rows = fake.events[fake.sessions[0]!.sessionId]!
      const seq = Math.max(...rows.map((e) => e.seq))
      const turn = rows.filter((e) => e.type === 'turn/start').length + 1
      rows.push({ type: 'turn/start', seq: seq + 1, data: { turn } }, { type: 'turn/end', seq: seq + 2, data: { turn, reason: { kind: finishReason } } })
    }
    return result
  } })
  const cli = (args: string[]) => invokeCli(args, { DSH_HOME: root, DSH_CONTROL_SOCKET: socketPath })
  const writes = () => fake.calls.filter((c) => ['session/selectModel', 'session/prompt', 'session/cancel'].includes(c.endpoint))
  // Claude 额度紧（撑不到重置、剩不到一半）：normal 档改挑 Codex，才测得到「已开始的会话拒绝换模型」。
  fake.report = { fetchedAt: NOW, providers: report.providers.map((p) => p.id === 'claude' ? { ...p, windows: p.windows.map((w) => ({ ...w, runsOut: NOW + 3_600_000 })) } : p) }
  try {
    for (const command of ['send', 'chat']) for (const option of [['--model', 'codex/gpt-6.1-sol'], ['--tier', 'normal']]) {
      fake.calls.length = 0
      const r = await cli([command, 'aaaa1111', '继续', ...option, '--json'])
      assert.equal(r.code, 2, r.out + r.err)
      assert.equal(JSON.parse(r.out).error.code, 'model-change-refused')
      assert.deepEqual(writes(), [])
    }
    for (const option of [
      ['--timeout', '0'], ['--timeout', 'NaN'], ['--timeout'], ['--timeout', '1', '--timeout', '2'],
      ['--since', '1.5'], ['--since'], ['--since', '-2'], ['--slice', 'bad'], ['--slice', '0'], ['--slice'],
      ['--slice', '1', '--slice', '2'], ['--tier'], ['--model'], ['--now=false'], ['--unknown'],
    ]) {
      fake.calls.length = 0
      const r = await cli(['chat', 'aaaa1111', '继续', ...option, '--json'])
      assert.equal(r.code, 2, r.out + r.err)
      assert.equal(JSON.parse(r.out).ok, false)
      assert.deepEqual(fake.calls, [], '无效 chat 不应连接服务后写入')
    }
    for (const args of [['health', '-H', 'alpha'], ['api', 'list', '-H', 'alpha'], ['api', 'list', '--host', 'alpha'], ['status', 'aaaa1111', 'extra']]) {
      fake.calls.length = 0
      const r = await cli([...args, '--json'])
      assert.equal(r.code, 2, r.out + r.err)
      assert.deepEqual(fake.calls, [])
    }
    fake.sessions[0]!.running = true
    fake.calls.length = 0
    const same = await cli(['send', 'aaaa1111', '正文 -H alpha', '--model', 'claude/claude-opus-5-5', '--json'])
    assert.equal(same.code, 0, same.out)
    const receipt = JSON.parse(same.out).data
    assert.equal(receipt.sent, true)
    assert.match(receipt.requestId, /^[0-9a-f-]{36}$/)
    assert.equal(fake.calls.some((c) => c.endpoint === 'session/selectModel'), false)
    assert.equal((fake.calls.find((c) => c.endpoint === 'session/prompt')!.args.request as { requestId: string }).requestId, receipt.requestId)
    for (const failure of ['usage', 'exception'] as const) {
      waitFailure = failure
      fake.sessions[0]!.running = false
      const r = await cli(['chat', 'aaaa1111', '继续', '--timeout', '1', '--json'])
      const payload = JSON.parse(r.out)
      assert.equal(r.code, failure === 'usage' ? 2 : 1)
      assert.equal(payload.receipt.sent, true)
      assert.equal(payload.receipt.sessionId, fake.sessions[0]!.sessionId)
      assert.equal(payload.receipt.since, 5)
      assert.ok(payload.receipt.requestId)
    }
    waitFailure = undefined
    for (const reason of ['error', 'aborted', 'max-tokens', 'unknown']) {
      fake.sessions[0]!.running = false
      fake.events[fake.sessions[0]!.sessionId]![4]!.data = { turn: 1, reason: { kind: reason, error: { code: 'REAL_FAILURE', message: '审查故障输入' } } }
      const r = await cli(['wait', 'aaaa1111', '--since', '0', '--timeout', '1', '--json'])
      const payload = JSON.parse(r.out)
      assert.equal(r.code, 1, r.out)
      assert.equal(payload.ok, false)
      assert.equal(payload.status, reason === 'aborted' ? 'aborted' : 'failed')
      assert.equal(payload.data.turns[0].ended, reason)
      assert.equal(payload.data.turns[0].detail, 'REAL_FAILURE: 审查故障输入')
      assert.equal(payload.data.turns[0].reply, '修好了，测试全绿。')
    }
    for (const reason of ['completed', 'error', 'aborted']) {
      finishReason = reason
      fake.sessions[0]!.running = false
      const result = await cli(['chat', 'aaaa1111', '继续', '--timeout', '1', '--json'])
      const payload = JSON.parse(result.out)
      assert.equal(result.code, reason === 'completed' ? 0 : 1, result.out)
      assert.equal(payload.receipt.sent, true)
      assert.equal(payload.data.turns.at(-1).ended, reason)
    }
    finishReason = undefined
    const timeout = await cli(['chat', 'aaaa1111', '继续', '--timeout', '0.02', '--slice', '1', '--json'])
    assert.equal(timeout.code, 124, timeout.out)
    assert.equal(JSON.parse(timeout.out).receipt.sent, true)
  } finally { await server.close(); s.dispose(); rmSync(root, { recursive: true, force: true }) }
})

test('send 复用运行保护、额度放行；宿主未确认接收时不冒称已发送', async () => {
  const fake = makeFake()
  fake.report = structuredClone(report)
  fake.report!.providers[0]!.windows[0]!.left = 0
  fake.sessions[0]!.running = true
  await assert.rejects(run(service(fake), 'send', ['aaaa1111', '继续'], { model: 'codex/gpt-6.1-sol' }), { code: 'session-running' })
  assert.equal(fake.calls.some((c) => c.endpoint === 'session/prompt'), false)
  fake.sessions[0]!.running = false
  const sent = await run(service(fake), 'send', ['aaaa1111', '继续'], { tier: 'normal' })
  assert.equal((sent.data as { sent: boolean }).sent, true)
  assert.equal(fake.calls.filter((c) => c.endpoint === 'session/selectModel').length, 1)
  fake.replies = { 'session/prompt': { accepted: false } }
  await assert.rejects(run(service(fake), 'send', ['aaaa1111', '继续']), { code: 'send-unconfirmed' })
})



test('旧运行中插件不能靠新入口握手放行 send/chat/wait；无正文请求发送', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-control-old-protocol-'))
  const socketPath = join(root, 'old.sock')
  let posts = 0
  const server = createServer((req, res) => {
    if (req.method === 'POST') posts++
    res.end(JSON.stringify({ ok: true, pid: 123, startedAt: 1 }))
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  try {
    for (const command of ['send', 'chat', 'wait']) {
      const r = await invokeCli([command, 'abcd', ...(command === 'wait' ? [] : ['继续']), '--json'], { DSH_HOME: root, DSH_CONTROL_SOCKET: socketPath })
      assert.equal(r.code, 2, r.out)
      assert.equal(JSON.parse(r.out).error.code, 'protocol-mismatch')
    }
    assert.equal(posts, 0)
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }) }
})

test('wait 途中通信口连接被断开（DSH 重启时）：重连接着等，不当成失败', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-control-wait-reset-'))
  const socketPath = join(root, 'dsh.sock')
  let posts = 0
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      res.end(JSON.stringify({ ok: true, tool: 'dsh-control', protocol: 1, features: ['task-outcomes', 'send-receipts'] }))
      return
    }
    posts++
    req.resume()
    req.on('end', () => {
      if (posts === 1) { req.socket.destroy(); return }
      res.end(JSON.stringify({ ok: true, status: 'ok', text: '会话 abcd 跑完了', data: { sessionId: 'session-abcd', turns: [] } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  try {
    const r = await invokeCli(['wait', 'abcd', '--timeout', '30', '--json'], { DSH_HOME: root, DSH_CONTROL_SOCKET: socketPath })
    assert.equal(r.code, 0, r.err)
    assert.equal(JSON.parse(r.out).status, 'ok')
    assert.equal(posts, 2)
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }) }
})

test('通信口收到坏请求体：按调用方用错回 400（命令行退出 2），不报成执行出错 500', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-control-bad-body-'))
  const socketPath = join(root, 'dsh.sock')
  let ran = 0
  const server = await startServer({ socketPath, commands: () => [], info: () => ({}), log: () => {}, run: async () => { ran++; return { text: '' } } })
  const post = (body: string) => new Promise<{ status: number; json: { ok: boolean; error?: { code: string } } }>((resolve, reject) => {
    const req = request({ socketPath, path: '/v1/run', method: 'POST', agent: false, headers: { 'content-type': 'application/json' } }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => { text += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }))
    })
    req.on('error', reject)
    req.end(body)
  })
  try {
    const bad = await post('{不是 JSON')
    assert.equal(bad.status, 400)
    assert.equal(bad.json.ok, false)
    assert.equal(bad.json.error?.code, 'usage')
    assert.equal(ran, 0)
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }) }
})

// ---- 真 socket + 可导入命令行核心 ----

const dir = mkdtempSync(join(tmpdir(), 'dsh-control-'))
after(() => rmSync(dir, { recursive: true, force: true }))

test('dsh-control 经 unix socket 跑通：help、sessions、wait 的退出码、找不到会话的退出码、DSH 没运行的退出码', async () => {
  const socketPath = join(dir, 'dsh.sock')
  const fake = makeFake()
  const s = service(fake)
  const server = await startServer({ socketPath, commands: () => COMMANDS, run: (c, a, o, sig) => runCommand(s, c, a, o, sig), info: () => ({ pid: process.pid }), log: () => {} })
  const cli = (args: string[], env: Record<string, string> = {}) => invokeCli(args, { ...process.env, DSH_CONTROL_SOCKET: socketPath, ...env })
  try {
    const help = await cli(['help'])
    assert.equal(help.code, 0)
    assert.match(help.out, /send <会话> <消息>/)
    const list = await cli(['sessions', '--json'])
    assert.equal(list.code, 0)
    assert.equal(JSON.parse(list.out).data.length, 3)
    const renamed = await cli(['rename', 'aaaa1111', '测试新标题', '--json'])
    assert.equal(renamed.code, 0)
    assert.equal(JSON.parse(renamed.out).data.title, '测试新标题')
    const forked = await cli(['fork', 'aaaa1111', '--at-seq', '4', '--json'])
    assert.equal(forked.code, 0)
    assert.equal(JSON.parse(forked.out).data.sessionId, 'session-ffff6666-0000')
    const archive = await cli(['archive', 'aaaa1111', '--json'])
    assert.equal(archive.code, 0)
    assert.equal(JSON.parse(archive.out).data.archived, true)
    assert.equal((await cli(['unarchive', 'aaaa1111'])).code, 0)
    const activeArchive = await cli(['archive', 'bbbb2222', '--json'])
    assert.equal(activeArchive.code, 2)
    assert.equal(JSON.parse(activeArchive.out).error.code, 'session-active')
    const ungrouped = await cli(['sessions', '--ungrouped', '--include-blank', '--limit', '0', '--json'])
    assert.equal(ungrouped.code, 0)
    assert.deepEqual(JSON.parse(ungrouped.out).data, [])
    assert.deepEqual(JSON.parse(ungrouped.out).meta, { shown: 0, matched: 0, archivedHidden: 0, blankHidden: 0 })
    const done = await cli(['wait', 'aaaa1111', '--since', '4'])
    assert.equal(done.code, 0)
    assert.match(done.out, /修好了/)
    const asking = await cli(['wait', 'cccc3333'])
    assert.equal(asking.code, 10)
    const timeout = await cli(['wait', 'bbbb2222', '--timeout', '2', '--slice', '1000'])
    assert.equal(timeout.code, 124)
    assert.match(timeout.out, /等了 2 秒还没有结果：会话在跑/)
    const idle = await cli(['wait', 'aaaa1111', '--since', '999', '--timeout', '8'])
    assert.equal(idle.code, 11)
    assert.match(idle.out, /没有新内容，会话空闲，最新 seq 5/)
    const idleJson = JSON.parse((await cli(['wait', 'aaaa1111', '--since', '999', '--json'])).out)
    assert.equal(idleJson.status, 'idle')
    const asked = await cli(['status', 'cccc3333'])
    assert.equal(asked.code, 10)
    const refused = await cli(['model', 'aaaa1111', '--model', 'codex/gpt-6.1-sol', '--json'])
    assert.equal(refused.code, 2)
    assert.equal(JSON.parse(refused.out).ok, false)
    assert.equal(JSON.parse(refused.out).error.code, 'model-change-refused')
    const rejected = await cli(['plugin', 'enable', 'broken-plugin'])
    assert.equal(rejected.code, 1)
    assert.match(rejected.err, /plugin-action-failed/)
    const chatHelp = await cli(['help', 'chat'])
    assert.equal(chatHelp.code, 0)
    assert.match(chatHelp.out, /chat <会话> <消息>/)
    assert.match(help.out, /chat <会话> <消息>/)
    assert.match(help.out, /version/)
    assert.match(help.out, /11 /)
    const missing = await cli(['status', '没有这个'])
    assert.equal(missing.code, 2)
    assert.match(missing.err, /找不到会话/)
    const batch = { answers: [
      { id: 'q1', selected: ['A', 'B'] },
      { id: 'q2', selected: [], custom: '自定义中文回答' },
    ] }
    const active = (fake.sessions[2]!.projections!.values as any).userQuestions.active[0]
    active.questions.push({ id: 'q2', question: '还有什么？' })
    const payload = JSON.stringify(batch)
    for (const args of [['--json', payload], [`--json=${payload}`], ['--json', payload, '--json']]) {
      const answered = await cli(['answer', 'cccc3333', ...args])
      assert.equal(answered.code, 0)
      assert.equal(answered.err, '')
      if (args.length === 3) assert.deepEqual(JSON.parse(answered.out), { ok: true, status: 'ok', data: { sessionId: 'session-cccc3333-0000', accepted: true, answer: batch } })
      else assert.equal(answered.out, '已回答，会话会接着跑\n')
      assert.deepEqual(fake.calls.at(-1), { endpoint: 'userQuestions/answer', args: { agentId: 'session-cccc3333-0000', callId: 'call-1', answer: batch } })
    }
    fake.answerAccepted = false
    const rejectedAnswer = await cli(['answer', 'cccc3333', '--json', payload, '--json'])
    assert.equal(rejectedAnswer.code, 2)
    assert.equal(JSON.parse(rejectedAnswer.out).error.code, 'answer-rejected')
    const malformed = await cli(['answer', 'cccc3333', '--json={invalid'])
    assert.equal(malformed.code, 2)
    assert.match(malformed.err, /不是合法 JSON/)
    const down = await cli(['health'], { DSH_CONTROL_SOCKET: join(dir, 'nope.sock') })
    assert.equal(down.code, 69)
    assert.match(down.err, /dsh-control start/)
    const offlineHelp = await cli(['help'], { DSH_CONTROL_SOCKET: join(dir, 'nope.sock') })
    assert.equal(offlineHelp.code, 0)
    for (const c of COMMANDS) assert.match(offlineHelp.out, new RegExp(`^  ${c.name}\\b`, 'm'))
    for (const name of ['chat', 'start', 'restart', 'doctor', 'version', 'help']) assert.match(offlineHelp.out, new RegExp(`^  ${name}\\b`, 'm'))
    const offlineTopic = await cli(['help', 'send'], { DSH_CONTROL_SOCKET: join(dir, 'nope.sock') })
    assert.equal(offlineTopic.code, 0)
    assert.match(offlineTopic.out, /send <会话> <消息>/)
  } finally {
    await server.close()
  }
})

test('通信口权限：目录 0700、socket 0600', async () => {
  const socketPath = join(dir, 'perm', 'dsh.sock')
  const server = await startServer({ socketPath, commands: () => [], run: async () => ({ text: '' }), info: () => ({}), log: () => {} })
  try {
    assert.equal(statSync(join(dir, 'perm')).mode & 0o777, 0o700)
    assert.equal(statSync(socketPath).mode & 0o777, 0o600)
  } finally {
    await server.close()
  }
})


test('通信口文件被删后自动在原路径重新监听；路径被别的 socket 占了不抢', async () => {
  // 2026-10-19 03:01 起 ~/.dsh/dsh-control/dsh.sock 被删，DSH 进程还开着它，dsh-control 全部连不上（复盘 I-029）
  const socketPath = join(dir, 'heal', 'dsh.sock')
  const health = (path: string) => new Promise<number>((resolve, reject) => {
    const req = request({ socketPath: path, path: '/v1/health', agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
    req.on('error', reject)
    req.end()
  })
  const lines: string[] = []
  const server = await startServer({ socketPath, commands: () => [], run: async () => ({ text: '' }), info: () => ({}), log: (l) => lines.push(l), watchMs: 300 })
  let other: ReturnType<typeof createServer> | undefined
  try {
    assert.equal(await health(socketPath), 200)
    rmSync(socketPath)
    await assert.rejects(health(socketPath))
    await new Promise((r) => setTimeout(r, 700))
    assert.equal(await health(socketPath), 200)
    assert.deepEqual(lines, ['socket rebound'])
    assert.equal(statSync(socketPath).mode & 0o777, 0o600)
    rmSync(socketPath)
    other = createServer((_req, res) => { res.writeHead(418); res.end() })
    await new Promise<void>((resolve) => other!.listen(socketPath, resolve))
    await new Promise((r) => setTimeout(r, 700))
    assert.equal(await health(socketPath), 418, '别人的 socket 不抢')
    assert.deepEqual(lines, ['socket rebound'])
  } finally {
    await server.close()
    await new Promise<void>((resolve) => other === undefined ? resolve() : other.close(() => resolve()))
  }
})

test('旧实例晚于新实例关闭时，不删新实例的通信口文件', async () => {
  // 插件热重载、或重启时旧 DSH 还没退干净：新实例已在原路径监听，旧实例随后关闭，按路径删文件把新的删了，
  // 之后 dsh-control 一直「找不到通信口」（复盘 I-029，2026-10-21 重启完成后和等待重启时都撞上）。
  const socketPath = join(dir, 'reload', 'dsh.sock')
  const health = (path: string) => new Promise<number>((resolve, reject) => {
    const req = request({ socketPath: path, path: '/v1/health', agent: false }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)) })
    req.on('error', reject)
    req.end()
  })
  const options = { socketPath, commands: () => [], run: async () => ({ text: '' }), log: () => {}, watchMs: 60_000 }
  const old = await startServer({ ...options, info: () => ({ generation: 'old' }) })
  const next = await startServer({ ...options, info: () => ({ generation: 'new' }) })
  try {
    await old.close()
    assert.equal(await health(socketPath), 200, '旧实例关闭后新实例仍连得上，不靠 30 秒自查补回')
    assert.equal(statSync(socketPath).mode & 0o777, 0o600)
  } finally {
    await next.close()
  }
  assert.throws(() => statSync(socketPath), '自己的文件照常删掉')
})

test('DSH 开着但通信口文件不见了：说清原因和下一步，不让人去 start', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-control-down-'))
  const running: AppControl = { ...forbiddenApp, running: () => true, backendRunning: () => true }
  const stopped: AppControl = forbiddenApp
  const call = async (app: AppControl) => {
    let out = '', err = ''
    const code = await createCli({ DSH_HOME: root, DSH_CONTROL_SOCKET: join(root, 'dsh-control', 'dsh.sock') }, (t) => { out += t }, (t) => { err += t }, spawnDetachedCli, app)(['sessions'])
    return { code, out, err }
  }
  try {
    const alive = await call(running)
    assert.equal(alive.code, 69, alive.out + alive.err)
    assert.match(alive.err, /DSH 还开着/)
    assert.match(alive.err, /自动重建/)
    assert.match(alive.err, /dsh-control restart/)
    assert.doesNotMatch(alive.err, /dsh-control start/)
    const dead = await call(stopped)
    assert.equal(dead.code, 69, dead.out + dead.err)
    assert.match(dead.err, /DSH 没在运行/)
    assert.match(dead.err, /dsh-control start/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('cwd：显示当前目录与起始目录，换目录走工作目录服务，相对路径和不存在的目录拒绝', async () => {
  const fake = makeFake()
  fake.sessions[0]!.projections!.values!.workingDirectory = '/repo/a/sub'
  const moved: [string, string][] = []
  const svc = service(fake, undefined, undefined, undefined, {
    setWorkingDirectory: async (id, dir) => {
      if (dir === '/nope') throw new Error('working-directory: directory does not exist: "/nope"')
      moved.push([id, dir]); return dir
    },
  })
  const shown = await run(svc, 'cwd', ['aaaa1111'], {})
  assert.match(shown.text, /当前目录：\/repo\/a\/sub/)
  assert.match(shown.text, /起始目录：\/repo\/a/)
  const status = await run(svc, 'status', ['aaaa1111'], {})
  assert.match(status.text, /目录：\/repo\/a\/sub（起始目录 \/repo\/a）/)
  const listed = await run(svc, 'sessions', [], { cwd: '/repo/a/sub' })
  assert.deepEqual((listed.data as { sessionId: string }[]).map((s) => s.sessionId), ['session-aaaa1111-0000'])
  const changed = await run(svc, 'cwd', ['aaaa1111', '/tmp'], {})
  assert.deepEqual(moved, [['session-aaaa1111-0000', '/tmp']])
  assert.match(changed.text, /换到 \/tmp/)
  await assert.rejects(run(svc, 'cwd', ['aaaa1111', 'rel/dir'], {}), (e: unknown) => e instanceof UsageError)
  await assert.rejects(run(svc, 'cwd', ['aaaa1111', '/nope'], {}), (e: unknown) => e instanceof UsageError && e.code === 'not-found')
  fake.readOnly = true
  await assert.rejects(run(svc, 'cwd', ['aaaa1111', '/tmp'], {}), (e: unknown) => e instanceof UsageError && e.code === 'read-only')
})

test('schedule：列出、按会话筛、按编号开头删和看记录，对不上和对上多条都拒绝', async () => {
  const fake = makeFake()
  const items = [
    { id: 'schedule-de8631b1-aaaa', kind: 'at', title: '验收', scheduledAt: '2026-11-17T01:00:00.000Z', sessionId: 'session-aaaa1111-0000', status: 'active' },
    { id: 'schedule-de86ffff-bbbb', kind: 'daily', title: '日报', scheduledAt: '2026-10-18T15:00:00.000Z', sessionId: 'session-bbbb2222-0000', status: 'active' },
  ]
  fake.replies = {
    'schedule/catalog': items,
    'schedule/delete': { deleted: true },
    'schedule/history': { id: items[0]!.id, records: [{ scheduledAt: '2026-10-17T01:00:00.000Z', deliveredAt: '2026-10-17T01:00:02.000Z', messageId: 'm1' }], earlierRecordsUnavailable: false },
  }
  const svc = service(fake)
  const all = await run(svc, 'schedule', [], {})
  assert.match(all.text, /共 2 条/)
  assert.match(all.text, /de8631b1  「验收」  一次/)
  const one = await run(svc, 'schedule', ['list', 'bbbb2222'], {})
  assert.deepEqual((one.data as { id: string }[]).map((s) => s.id), [items[1]!.id])
  await assert.rejects(run(svc, 'schedule', ['delete', 'de86'], {}), (e: unknown) => e instanceof UsageError && e.code === 'ambiguous')
  await assert.rejects(run(svc, 'schedule', ['delete', 'zzzz'], {}), (e: unknown) => e instanceof UsageError && e.code === 'not-found')
  const history = await run(svc, 'schedule', ['history', 'de8631'], { limit: '5' })
  assert.match(history.text, /最近 1 次发送/)
  assert.deepEqual(fake.calls.find((c) => c.endpoint === 'schedule/history')!.args, { request: { sessionId: 'session-aaaa1111-0000', id: items[0]!.id, limit: 5 } })
  await run(svc, 'schedule', ['delete', 'de8631'], {})
  assert.deepEqual(fake.calls.find((c) => c.endpoint === 'schedule/delete')!.args, { request: { sessionId: 'session-aaaa1111-0000', id: items[0]!.id } })
})

test('goal：看、暂停带上当前版本号，没有目标和宿主拒绝都报用法错误', async () => {
  const fake = makeFake()
  let goal: Record<string, unknown> | null = { id: 'goal-1', revision: 3, phase: 'active', objective: '把升级做完' }
  const svc = service(fake, undefined, undefined, undefined, {})
  const inner = (svc as unknown as { deps: Deps }).deps.gateway
  const original = inner.invoke.bind(inner)
  inner.invoke = async (request) => {
    const endpoint = `${request.namespace}/${request.method}`
    if (endpoint === 'goals/get') return goal
    if (endpoint === 'goals/pause') { fake.calls.push({ endpoint, args: request.args }); goal = { ...goal!, phase: 'paused', revision: 4 }; return goal }
    if (endpoint === 'goals/resume') throw Object.assign(new Error('goal is not paused'), { code: 'GOAL_NOT_PAUSED' })
    return original(request)
  }
  assert.match((await run(svc, 'goal', ['aaaa1111'], {})).text, /目标（进行中）：把升级做完/)
  const paused = await run(svc, 'goal', ['aaaa1111', 'pause'], {})
  assert.match(paused.text, /已暂停/)
  assert.deepEqual(fake.calls.at(-1)!.args, { agentId: 'session-aaaa1111-0000', ref: { id: 'goal-1', revision: 3 } })
  goal = { ...goal!, phase: 'active' }
  await assert.rejects(run(svc, 'goal', ['aaaa1111', 'resume'], {}), (e: unknown) => e instanceof UsageError && /恢复目标没成/.test(e.message))
  await assert.rejects(run(svc, 'goal', ['aaaa1111', 'stop'], {}), (e: unknown) => e instanceof UsageError)
  goal = null
  assert.match((await run(svc, 'goal', ['aaaa1111'], {})).text, /没有目标/)
})

test('new --if-idle 拒绝活重启、在跑会话、真实队列及普通后台任务，零创建零发送', async () => {
  const blockers = [
    { running: ['session-other'], queued: [], jobs: [] },
    { running: [], queued: ['session-queued'], jobs: [] },
    { running: [], queued: [], jobs: [{ id: 'job', kind: 'bash', label: '仍在改仓库' }] },
  ]
  for (const live of blockers) {
    const f = makeFake()
    const svc = service(f, undefined, () => live, undefined, { pendingRestart: () => undefined })
    await assert.rejects(run(svc, 'new', ['/repo/a', '维护'], { 'if-idle': true }), (e: unknown) => e instanceof UsageError && e.code === 'idle-required')
    assert.equal(f.calls.length, 0)
  }
  const f = makeFake()
  const svc = service(f, undefined, () => ({ running: [], queued: [], jobs: [] }), undefined, { pendingRestart: () => ({ phase: 'waiting', pid: process.pid }) })
  await assert.rejects(run(svc, 'new', ['/repo/a', '维护'], { 'if-idle': true }), (e: unknown) => e instanceof UsageError && e.code === 'restart-pending')
  assert.equal(f.calls.length, 0)
})

test('new 普通入口不检查维护门禁；空闲维护允许 survivable 监听，仍复用模型选择', async () => {
  for (const maintenance of [false, true]) {
    const f = makeFake()
    f.replies = { 'session/create': { sessionId: 'session-created-maintenance' } }
    const svc = service(f, undefined, () => ({ running: [], queued: [], jobs: [{ id: 'monitor', kind: 'monitor', label: '监听', survivable: true }] }), undefined, {
      pendingRestart: () => { if (!maintenance) throw new Error('普通 new 不应检查'); return undefined },
    })
    const result = await run(svc, 'new', ['/repo/a', '维护'], maintenance ? { 'if-idle': true } : {})
    assert.equal((result.data as { sent: boolean }).sent, true)
    assert.equal(f.calls.filter((c) => c.endpoint === 'session/create').length, 1)
    assert.equal(f.calls.filter((c) => c.endpoint === 'session/selectModel').length, 1)
    assert.equal(f.calls.filter((c) => c.endpoint === 'session/prompt').length, 1)
  }
})

test('new 模型选取 await 期间出现重启或新任务：创建前复查并拒绝', async () => {
  for (const reason of ['restart', 'running']) {
    const f = makeFake()
    let appeared = false
    const svc = service(f, undefined, () => ({ running: appeared && reason === 'running' ? ['other'] : [], queued: [], jobs: [] }), undefined, {
      pendingRestart: () => appeared && reason === 'restart' ? { phase: 'waiting', pid: process.pid } : undefined,
    })
    const deps = (svc as unknown as { deps: Deps }).deps
    const original = deps.gateway.invoke.bind(deps.gateway)
    deps.gateway.invoke = async (request) => {
      const result = await original(request)
      if (request.method === 'modelCatalog') appeared = true
      return result
    }
    await assert.rejects(run(svc, 'new', ['/repo/a', '维护'], { 'if-idle': true }), (e: unknown) => e instanceof UsageError && e.code === (reason === 'restart' ? 'restart-pending' : 'idle-required'))
    assert.equal(f.calls.some((c) => c.endpoint === 'session/create' || c.endpoint === 'session/prompt'), false)
  }
})

test('new 已创建后、发送前被重启拦下：CLI exit1，保留真实编号与未发送回执', async () => {
  const f = makeFake()
  const id = 'session-created-maintenance'
  f.replies = { 'session/create': { sessionId: id } }
  const svc = service(f, undefined, () => ({ running: [], queued: [], jobs: [] }), undefined, {
    pendingRestart: () => f.calls.some((c) => c.endpoint === 'session/create') ? { phase: 'waiting', pid: process.pid } : undefined,
  })
  const home = mkdtempSync(join(tmpdir(), 'dsh-if-idle-'))
  const socketPath = join(home, 'control.sock')
  const server = await startServer({ socketPath, commands: () => COMMANDS, info: () => ({}), run: (command, args, options, signal) => runCommand(svc, command, args, options, signal), log: () => {} })
  try {
    const cli = await invokeCli(['new', '/repo/a', '维护', '--if-idle', '--json'], { DSH_HOME: home, DSH_CONTROL_SOCKET: socketPath })
    assert.equal(cli.code, 1, cli.err)
    const result = JSON.parse(cli.out)
    assert.equal(result.ok, false)
    assert.equal(result.status, 'failed')
    assert.equal(result.error.code, 'restart-pending')
    assert.deepEqual({ sessionId: result.data.sessionId, sent: result.data.sent, created: result.data.created, since: result.data.since }, { sessionId: id, sent: false, created: true, since: -1 })
    assert.match(result.error.message, /不要重放 new/)
    assert.equal(f.calls.filter((c) => c.endpoint === 'session/create').length, 1)
    assert.equal(f.calls.some((c) => c.endpoint === 'session/prompt'), false)
  } finally { await server.close(); rmSync(home, { recursive: true, force: true }) }
})

test('notice --quiet 从命令行到插件都按裸开关处理，送出不唤醒的通知', async () => {
  const parsed = parseCommand(['notice', 'aaaa', '说明', '--quiet', '--json'])
  assert.equal(parsed.options['quiet'], true)
  const f = makeFake()
  const sent: { sessionId: string; quiet: boolean | undefined }[] = []
  const s = service(f, undefined, undefined, undefined, { notice: async (sessionId, _text, _summary, quiet) => {
    sent.push({ sessionId, quiet })
    return { accepted: true, scheduled: false, delivery: 'inject', agentStatus: 'idle' }
  } })
  await run(s, 'notice', ['aaaa', '说明'], { quiet: true })
  assert.deepEqual(sent, [{ sessionId: 'session-aaaa1111-0000', quiet: true }])
  await assert.rejects(run(s, 'notice', ['aaaa', '说明'], { quiet: 'true' }), /单个不带值的开关/)
})

test('new --if-idle CLI 真正解析裸开关，拒绝带值和重复值', async () => {
  const parsed = parseCommand(['new', '--if-idle', '/repo/a', '维护', '--json'])
  assert.equal(parsed.options['if-idle'], true)
  assert.deepEqual(parsed.positional, ['/repo/a', '维护'])
  const f = makeFake()
  for (const value of ['true', [true, true]]) {
    await assert.rejects(run(service(f), 'new', ['/repo/a'], { 'if-idle': value }), /单个不带值的开关/)
  }
  assert.equal(f.calls.length, 0)
})

test('goal hold：只收回自动续跑，不调会打断这一轮的 goals/pause；目标不在进行中、宿主不支持都报用法错误', async () => {
  // 2026-10-18 8191aefd：重启等待里用 goals/pause 让路，宿主当场中止了正在跑的这一轮
  const fake = makeFake()
  let goal: Record<string, unknown> | null = { id: 'goal-1', revision: 3, phase: 'active', activation: 'armed', objective: '把升级做完' }
  const held: string[] = []
  const svc = service(fake, undefined, undefined, undefined, {})
  const deps = (svc as unknown as { deps: Deps }).deps
  const original = deps.gateway.invoke.bind(deps.gateway)
  deps.gateway.invoke = async (request) => {
    const endpoint = `${request.namespace}/${request.method}`
    if (endpoint === 'goals/get') return goal
    if (endpoint.startsWith('goals/')) { fake.calls.push({ endpoint, args: request.args }); throw new Error(`不该调 ${endpoint}`) }
    return original(request)
  }
  await assert.rejects(run(svc, 'goal', ['aaaa1111', 'hold'], {}), (e: unknown) => e instanceof UsageError && e.code === 'unsupported')
  deps.holdGoal = (id) => { held.push(id); goal = { ...goal!, activation: 'disarmed' }; return true }
  const r = await run(svc, 'goal', ['aaaa1111', 'hold'], {})
  assert.deepEqual(held, ['session-aaaa1111-0000'])
  assert.ok(!fake.calls.some((c) => c.endpoint.startsWith('goals/')))
  assert.match(r.text, /已停掉会话 aaaa1111 的目标自动续跑，手上这一轮照常跑完/)
  assert.match(r.text, /目标（进行中，不自动续跑）：把升级做完/)
  goal = { ...goal!, phase: 'paused' }
  await assert.rejects(run(svc, 'goal', ['aaaa1111', 'hold'], {}), (e: unknown) => e instanceof UsageError && e.code === 'goal-not-active')
})


test('wait --settled：一轮结束但名下还有后台任务、子代理在干活、目标会自动续跑或正在重启都不算做完；全清掉稳定后才返回', async () => {
  const fake = makeFake()
  const live = { running: [] as string[], queued: [] as string[], parents: {} as Record<string, string>, jobs: [] as { id: string; kind: string; label: string; owner?: string }[] }
  let restarting = false
  const s = service(fake, undefined, () => live, undefined, { settleMs: 50, startedAt: Date.now() - 600_000, pendingRestart: () => restarting ? { phase: 'quitting', pid: 1 } : undefined })
  const plain = await run(s, 'wait', ['aaaa1111'], { since: '4', slice: '1000' })
  assert.equal(plain.status, 'ok', '不带 --settled 照旧：一轮结束就返回')

  live.jobs = [{ id: 'bash-7', kind: 'bash', label: 'sleep 30', owner: 'session-aaaa1111-0000' }]
  let r = await run(s, 'wait', ['aaaa1111'], { since: '4', slice: '1000', settled: true })
  assert.equal(r.status, 'running')
  assert.match(String((r.data as { waitingFor: string }).waitingFor), /还没真做完：还有 1 个后台任务在跑：bash-7（sleep 30）/)

  live.jobs = [{ id: 'py-1', kind: 'python', label: '后台计算', owner: 'session-dddd4444-0000' }]
  live.parents = { 'session-dddd4444-0000': 'session-aaaa1111-0000' }
  r = await run(s, 'wait', ['aaaa1111'], { since: '4', slice: '500', settled: true })
  assert.match(String((r.data as { waitingFor: string }).waitingFor), /属于子代理 dddd4444/)
  live.jobs = []
  live.running = ['session-dddd4444-0000']
  r = await run(s, 'wait', ['aaaa1111'], { since: '4', slice: '500', settled: true })
  assert.match(String((r.data as { waitingFor: string }).waitingFor), /子代理还在干活：dddd4444/)
  live.running = []

  const a = fake.sessions.find((x) => x.sessionId === 'session-aaaa1111-0000')!
  a.projections!.values!.goal = { goal: { id: 'g', revision: 1, phase: 'active' } }
  fake.replies = { 'goals/get': { id: 'g', revision: 1, phase: 'active', activation: 'armed' } }
  r = await run(s, 'wait', ['aaaa1111'], { since: '4', slice: '500', settled: true })
  assert.match(String((r.data as { waitingFor: string }).waitingFor), /持续目标还在进行/)
  fake.replies = { 'goals/get': { id: 'g', revision: 1, phase: 'active', activation: 'disarmed' } }

  restarting = true
  r = await run(s, 'wait', ['aaaa1111'], { since: '4', slice: '500', settled: true })
  assert.match(String((r.data as { waitingFor: string }).waitingFor), /DSH 正在重启/)
  restarting = false

  const started = Date.now()
  r = await run(s, 'wait', ['aaaa1111'], { since: '4', slice: '2000', settled: true })
  assert.equal(r.status, 'ok')
  assert.equal((r.data as { settled?: boolean }).settled, true)
  assert.match(r.text, /修好了/)
  assert.ok(Date.now() - started >= 50, '要连续保持一阵才算数')
})

test('wait --settled：刚重启时上次退出被中止的那一轮不算终态；过了宽限期如实报中止', async () => {
  const fake = makeFake()
  const ended = Date.now() - 5000
  fake.events['session-aaaa1111-0000']!.push(
    { type: 'turn/start', seq: 6, time: ended - 1000, data: { turn: 2 } },
    { type: 'turn/end', seq: 7, time: ended, data: { turn: 2, reason: { kind: 'aborted' } } },
  )
  const live = () => ({ running: [], queued: [], parents: {}, jobs: [] })
  const fresh = service(fake, undefined, live, undefined, { settleMs: 10, startedAt: Date.now(), pendingRestart: () => undefined })
  const r = await run(fresh, 'wait', ['aaaa1111'], { since: '5', slice: '300', settled: true })
  assert.equal(r.status, 'running')
  assert.match(String((r.data as { waitingFor: string }).waitingFor), /上次退出时被中止/)
  const later = service(fake, undefined, live, undefined, { settleMs: 10, startedAt: Date.now() - 600_000, pendingRestart: () => undefined })
  const r2 = await run(later, 'wait', ['aaaa1111'], { since: '5', slice: '1000', settled: true })
  assert.equal(r2.status, 'aborted')
  assert.equal(r2.ok, false)
})

test('send / new --notify：发送前核对通知对象，发出后登记监听并写进回执；不支持时不发送', async () => {
  const fake = makeFake()
  const watches: { target: string; notify: string; since: number; targetTitle?: string }[] = []
  const s = service(fake, undefined, () => ({ running: [], queued: [], jobs: [] }), undefined, { watchDone: async (request) => { watches.push(request); return { id: 'watch-0001-xxxx', path: '/tmp/watch.json' } } })
  const sent = await run(s, 'send', ['aaaa1111', '修一下'], { notify: 'bbbb2222' })
  assert.deepEqual(watches, [{ target: 'session-aaaa1111-0000', notify: 'session-bbbb2222-0000', since: 5, targetTitle: '修 CI 失败' }])
  assert.deepEqual((sent.data as { notify: unknown }).notify, { watchId: 'watch-0001-xxxx', session: 'session-bbbb2222-0000', record: '/tmp/watch.json' })
  assert.match(sent.text, /做完通知已登记/)
  await assert.rejects(run(s, 'send', ['aaaa1111', '修一下'], { notify: 'aaaa1111' }), /不能是目标会话自己/)
  await assert.rejects(run(s, 'send', ['aaaa1111', '修一下'], { notify: 'self' }), /--notify self 要经 dsh-control 命令行/)
  await assert.rejects(run(s, 'new', ['/tmp/x'], { notify: 'bbbb2222' }), /要和第一条消息一起用/)
  const prompts = fake.calls.filter((c) => c.endpoint === 'session/prompt').length
  assert.equal(prompts, 1, '核对不过就不发送')
  const created = await run(s, 'new', ['/tmp/x', '开干'], { notify: 'bbbb2222' })
  assert.equal(watches.at(-1)?.target, 'session-eeee5555-0000')
  assert.equal((created.data as { notify: { watchId: string } }).notify.watchId, 'watch-0001-xxxx')

  const old = service(makeFake())
  const before = fake.calls.length
  await assert.rejects(run(old, 'send', ['aaaa1111', '修一下'], { notify: 'bbbb2222' }), /不支持做完通知/)
  assert.equal(fake.calls.length, before)
})
