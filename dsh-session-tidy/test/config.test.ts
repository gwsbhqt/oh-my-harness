import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Config, resolveConfig, tidyWorkspace, apply } from '../src/index.ts'

// ---- 纯配置解析 ----

test('默认配置指向通用 Typesafe 网关，三项都可读', () => {
  const c = resolveConfig(Config({}))
  assert.equal(c.apiKeyRef, 'TYPESAFE_API_KEY')
  assert.equal(c.baseUrl, 'https://api.typesafe.ai/v1/systemone')
  assert.equal(c.model, 'jev-latest')
})

test('配置覆盖被现读到；空串保持空串（不回落默认）', () => {
  const c = resolveConfig(Config({ apiKeyRef: 'X', baseUrl: 'http://127.0.0.1:1/systemone', model: 'm' }))
  assert.equal(c.apiKeyRef, 'X')
  assert.equal(c.baseUrl, 'http://127.0.0.1:1/systemone')
  assert.equal(c.model, 'm')
  const empty = resolveConfig(Config({ apiKeyRef: '' }))
  assert.equal(empty.apiKeyRef, '')
})

// ---- 用假 ctx 验证 runTidy 的规则路径与跳过条件（不需要任何网络） ----

function fakeCtx(ws: any, opts: { live?: string[]; subagent?: string[]; titles?: Record<string,string>; recent?: string[]; old?: string[]; extraSessions?: string[] } = {}) {
  const archived = new Set<string>()
  const archivedSession = new Set<string>()
  const ctx = {
    workspaceRegistry: {
      archivedSessionIds: [] as string[],
      pinnedSessionIds: ['s-pinned'],
      list: () => [ws],
      archiveSession: async (id: string) => { archivedSession.add(id); archived.add(id); ctx.workspaceRegistry.archivedSessionIds = [...archived] },
    },
    sessionQuery: {
      readTitleSnapshots: async (ids: string[]) => ids.map((id) => ({ status: 'fulfilled', sessionId: id, value: { title: { title: (opts.titles ?? {})[id] ?? '' } } })),
      listSessions: async () => [...ws.sessionIds, ...(opts.extraSessions ?? [])].map((id: string) => ({ header: { id, createdAt: (opts.old ?? []).includes(id) ? Date.now() - 10 * 24 * 3600 * 1000 : Date.now(), ...((opts.subagent ?? []).includes(id) ? { origin: 'subagent' } : {}) }, live: (opts.live ?? []).includes(id) })),
      readSession: async (id: string) => ({
        events: (opts.recent ?? []).includes(id) ? [{ type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }, time: Date.now() }] : [],
      }),
    },
    get: () => undefined,
  }
  return ctx
}

test('无 key（apiKeyRef 空）走纯规则：空白/测试标题归档、运行中/置顶/子代理/已归档不动、近期正常会话保留', async () => {
  const ws = { id: 'w1', title: 'W', path: '/w', sessionIds: ['s-junk', 's-live', 's-pinned', 's-sub', 's-archived', 's-real', 's-old'] }
  const ctx = fakeCtx(ws, {
    live: ['s-live'], subagent: ['s-sub'], recent: ['s-real'], old: ['s-old'],
    titles: { 's-junk': '运行慢查询并汇总结果', 's-live': '进行中的工作', 's-pinned': '真实工作P', 's-sub': '真实工作S', 's-archived': '真实工作A', 's-real': '真实工作', 's-old': '很久没动的工作' },
  })
  ctx.workspaceRegistry.archivedSessionIds = ['s-archived']
  const cfg = () => resolveConfig(Config({ apiKeyRef: '' }))
  const report = await tidyWorkspace(ctx as any, 's-real', {}, cfg)
  const archivedIds = report.archived.map((x) => x.sessionId).sort()
  assert.deepEqual(archivedIds, ['s-junk', 's-old'])
  assert.equal(report.judge, 'rules')
  const skippedIds = report.skipped.map((x) => x.sessionId).sort()
  assert.deepEqual(skippedIds, ['s-live', 's-pinned', 's-real', 's-sub'])
  assert.ok(!report.archived.some((x) => x.sessionId === 's-archived'))
})

test('dryRun 只预览不调用 archiveSession', async () => {
  const ws = { id: 'w1', title: 'W', sessionIds: ['s-junk', 's-real'] }
  const ctx = fakeCtx(ws, { recent: ['s-real'], titles: { 's-junk': '', 's-real': '真实工作' } })
  const cfg = () => resolveConfig(Config({ apiKeyRef: '' }))
  const report = await tidyWorkspace(ctx as any, 's-real', { dryRun: true }, cfg)
  assert.deepEqual(report.archived.map((x) => x.sessionId), ['s-junk'])
  assert.equal(report.dryRun, true)
  assert.deepEqual((ctx.workspaceRegistry as any).archivedSessionIds, [])
})

test('不属于任何工作区的孤儿会话也一并扫描回收', async () => {
  const ws = { id: 'w1', title: 'W', path: '/w', sessionIds: ['s-real'] }
  const ctx = fakeCtx(ws, {
    recent: ['s-real', 's-orphan-real'],
    extraSessions: ['s-orphan', 's-orphan-real', 's-sub-orphan'],
    subagent: ['s-sub-orphan'],
    titles: { 's-real': '真实工作', 's-orphan': '运行慢查询并汇总结果', 's-orphan-real': '进行中的活', 's-sub-orphan': '运行慢查询并汇总结果' },
  })
  const cfg = () => resolveConfig(Config({ apiKeyRef: '' }))
  const report = await tidyWorkspace(ctx as any, 's-real', {}, cfg)
  // 孤儿只有 s-orphan 是测试标题被收；s-orphan-real 近期有使用、保留；
  // s-sub-orphan 是子代理会话，从孤儿里剔除，不进总数也不归档
  assert.deepEqual(report.archived.map((x) => x.sessionId), ['s-orphan'])
  assert.equal(report.ungroupedTotal, 2)
  assert.equal(report.total, 3)
  assert.ok(!report.archived.some((x) => x.sessionId === 's-real'))
  assert.ok(!report.skipped.some((x) => x.sessionId === 's-sub-orphan'))
})

test('有 key 但网关连不上时，该条保留不归档（调用失败不误收，不退回规则）', async () => {
  process.env.DSH_TEST_JEV_KEY = 'dummy'
  try {
    const ws = { id: 'w1', title: 'W', sessionIds: ['s-real'] }
    const ctx = fakeCtx(ws, { recent: ['s-real'], titles: { 's-real': '真实工作' } })
    const cfg = () => resolveConfig(Config({ apiKeyRef: 'DSH_TEST_JEV_KEY', baseUrl: 'http://127.0.0.1:1/systemone', model: 'jev-latest' }))
    const report = await tidyWorkspace(ctx as any, 's-real', {}, cfg)
    assert.equal(report.judge, 'jev')
    assert.deepEqual(report.archived, [])
    assert.equal(report.skipped.length, 1)
    assert.match(report.skipped[0]!.reason, /保留/)
  } finally {
    delete process.env.DSH_TEST_JEV_KEY
  }
})

// ---- 回环 HTTP fixture：验证真实 HttpJev 请求与 volatile 热改 ----

interface CapturedRequest {
  method: string | undefined
  url: string | undefined
  authorization: string | undefined
  contentType: string | undefined
  body: any
}

async function loopbackJev() {
  const requests: CapturedRequest[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      requests.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        body: raw === '' ? undefined : JSON.parse(raw),
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      // finished 高：判为“任务已结束”，归档
      res.end(JSON.stringify({ answers: { finished: { noul: 0.99 } } }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const port = (server.address() as AddressInfo).port
  return {
    base: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** 记录 credentials.resolve 的 ref，并按 ref 返回虚构测试 key。 */
function integrationCtx(workspaces: any[], titles: Record<string, string>, firstMsgs: Record<string, string>) {
  const resolvedRefs: string[] = []
  const secrets: Record<string, string> = { REF_A: 'sk-test-A', REF_B: 'sk-test-B' }
  const credentials = {
    async resolve(ref: string): Promise<{ value: string } | undefined> {
      resolvedRefs.push(ref)
      return secrets[ref] === undefined ? undefined : { value: secrets[ref] }
    },
  }
  const captured: { route?: any; tool?: any } = {}
  const allIds = workspaces.flatMap((w) => w.sessionIds as string[])
  const ctx: any = {
    workspaceRegistry: {
      archivedSessionIds: [] as string[],
      pinnedSessionIds: [] as string[],
      list: () => workspaces,
      archiveSession: async (id: string) => { ctx.workspaceRegistry.archivedSessionIds.push(id) },
    },
    sessionQuery: {
      readTitleSnapshots: async (ids: string[]) => ids.map((id) => ({ status: 'fulfilled', sessionId: id, value: { title: { title: titles[id] ?? '' } } })),
      listSessions: async () => allIds.map((id) => ({ header: { id, createdAt: Date.now() }, live: false })),
      readSession: async (id: string) => ({
        events: firstMsgs[id] === undefined ? [] : [
          { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: firstMsgs[id] }] }, time: Date.now() },
          { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '任务已完成并推送，无需再操作' }] } }, time: Date.now() },
        ],
      }),
    },
    get: (name: string) => (name === 'credentials' ? credentials : undefined),
    effect: (fn: () => unknown) => { const d = fn(); return typeof d === 'function' ? d : () => {} },
    connection: { fetch: { register: (route: any) => { captured.route = route; return () => {} } } },
    tools: { register: (def: any) => { captured.tool = def } },
    logger: () => ({ warn() {}, info() {}, debug() {} }),
  }
  return { ctx, captured, resolvedRefs }
}

test('真实 HttpJev：端点/Authorization/model/body 正确；同一 volatile 单元格热改后重放；覆盖 route 与 tool 路径', async () => {
  const srv = await loopbackJev()
  try {
    const wsRoute = { id: 'w-route', title: 'R', path: '/r', sessionIds: ['s-route'] }
    const wsTool = { id: 'w-tool', title: 'T', path: '/t', sessionIds: ['s-tool'] }
    const titles = { 's-route': 'route 会话', 's-tool': 'tool 会话' }
    const firstMsgs = { 's-route': 'first message route', 's-tool': 'first message tool' }
    const { ctx, captured, resolvedRefs } = integrationCtx([wsRoute, wsTool], titles, firstMsgs)

    // 同一份 schema 配置：先按 A 值
    const config = Config({ apiKeyRef: 'REF_A', baseUrl: `${srv.base}/v1/systemone`, model: 'model-A' })
    apply(ctx, config)
    assert.ok(captured.route && typeof captured.route.fetch === 'function', 'apply 应注册 route')
    assert.ok(captured.tool && typeof captured.tool.execute === 'function', 'apply 应注册 tool')

    // 第一次请求：走注册的 route
    const reqBody = { type: 'client-request', method: 'session-tidy.tidy', rpcId: 'r1', payload: { sessionId: 's-route' } }
    const resp = await captured.route.fetch(new Request('http://local/api/session-tidy.tidy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(reqBody) }))
    const json: any = await resp.json()
    assert.equal(json.result.ok, true)
    assert.deepEqual(json.result.value.archived.map((x: any) => x.sessionId), ['s-route'])

    assert.equal(srv.requests.length, 1)
    const r1 = srv.requests[0]!
    assert.equal(r1.method, 'POST')
    assert.equal(r1.url, '/v1/systemone')                 // 端点 = baseUrl（完整含 /systemone）
    assert.equal(r1.authorization, 'Bearer sk-test-A') // key 按 ref 由 credentials 解析出来
    assert.equal(r1.contentType, 'application/json')
    assert.equal(r1.body.model, 'model-A')                 // model 进请求体
    // 有最后一条助手回复时不再带第一段用户消息（避免任务书误导“还在进行”）
    assert.equal(r1.body.state.firstUserMessage, undefined)
    assert.equal(r1.body.state.lastAssistantMessage, '任务已完成并推送，无需再操作')
    assert.deepEqual(Object.keys(r1.body.questions), ['finished']) // 只问“任务结没结束”
    assert.equal(r1.body.questions.finished.type, 'noul')
    assert.deepEqual(resolvedRefs, ['REF_A'])             // credentials 收到的是 ref，不是明文

    // 按本仓 volatile 机制修改同一单元格（模拟设置页热更新）
    const W = Symbol.for('cosmokit.volatile.write')
    ;(config.apiKeyRef as any)[W]('REF_B')
    ;(config.baseUrl as any)[W](`${srv.base}/v2/systemone`)
    ;(config.model as any)[W]('model-B')
    assert.deepEqual(resolveConfig(config), { apiKeyRef: 'REF_B', baseUrl: `${srv.base}/v2/systemone`, model: 'model-B' })

    // 重放：走注册的 tool，必须读热改后的当前配置
    const out = await captured.tool.execute({ session: 's-tool' })
    assert.match(out.text, /已归档 1 个/)

    assert.equal(srv.requests.length, 2)
    const r2 = srv.requests[1]!
    assert.equal(r2.url, '/v2/systemone')
    assert.equal(r2.authorization, 'Bearer sk-test-B')
    assert.equal(r2.body.model, 'model-B')
    assert.equal(r2.body.state.firstUserMessage, undefined)
    assert.equal(r2.body.state.lastAssistantMessage, '任务已完成并推送，无需再操作')
    assert.deepEqual(resolvedRefs, ['REF_A', 'REF_B'])
  } finally {
    await srv.close()
  }
})
