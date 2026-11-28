import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteService, type Deps } from '../src/service.ts'
import type { RawEvent } from '../src/transcript.ts'
import { COMMANDS, runCommand } from '../src/commands.ts'
import { UsageError } from '../src/gateway.ts'
import { startServer } from '../src/server.ts'
import { invokeCli } from './cli-fixture.ts'
import { remoteFixture } from './remote-fixture.ts'

const SESSION = 'session-AAAA'
const OTHER_SESSION = 'session-BBBB'
const TARGET = '11111111-1111-4111-8111-000000000002'
const ENQUEUED = '11111111-1111-4111-8111-000000000007'
const REMOTE_ENQUEUED = '11111111-1111-4111-8111-000000000008'
const SAME_PREFIX = '11111111-1111-4111-8111-000000000099'
const MISSING_PREFIX = '11111111-1111-4111-8111-000000000098'
const INHERITED = '11111111-1111-4111-8111-000000000010'
const INJECTED = '11111111-1111-4111-8111-000000000011'
const ADJACENT = '11111111-1111-4111-8111-000000000012'
const OTHER_SESSION_REQUEST = '11111111-1111-4111-8111-000000000009'
const ENQUEUE_BODY = 'SYNTHETIC-ENQUEUE-BODY'
const USER_BODY = 'SYNTHETIC-USER-BODY'
const INJECTED_BODY = 'SYNTHETIC-INJECTED-BODY'

function fixtureEvents(): RawEvent[] {
  return [
    { type: 'user/message', seq: 0, data: { turn: 9, source: { kind: 'user', rpcId: INHERITED }, content: [{ type: 'text', text: 'PARENT-INHERITED' }] } },
    // 正式 new 路径的入队事件：seq 1、agent/inbox/spliced；测试元数据不含正文。
    { type: 'agent/inbox/spliced', seq: 1, data: { target: 'next-turn', start: 0, inserted: [{ id: 'item-target', role: 'user', source: { kind: 'user', rpcId: TARGET } }] } },
    { type: 'turn/start', seq: 2, data: { turn: 2 } },
    // 正式 user/message 可没有 data.turn；这里也不带 content，只保留元数据。
    { type: 'user/message', seq: 3, data: { id: 'message-target', role: 'user', source: { kind: 'user', rpcId: TARGET } } },
    { type: 'turn/end', seq: 4, data: { turn: 2, reason: { kind: 'completed' } } },
    { type: 'assistant/message', seq: 5, data: { turn: 2, message: { content: [{ type: 'text', text: `正文提到相邻编号 ${ADJACENT}，不是收件证据` }] } } },
    { type: 'agent/inbox/spliced', seq: 6, data: { target: 'next-turn', start: 0, inserted: [{ id: 'item-injected', role: 'user', source: { kind: 'injected', rpcId: INJECTED } }] } },
    { type: 'user/message', seq: 7, data: { id: 'message-injected', role: 'user', source: { kind: 'injected', rpcId: INJECTED }, content: [{ type: 'text', text: INJECTED_BODY }] } },
    // 既有 send 路径可只在 seq 47 记录入队，尚无 user/message。
    { type: 'agent/inbox/spliced', seq: 47, data: { target: 'next-turn', start: 0, inserted: [{ id: 'item-enqueued', role: 'user', source: { kind: 'user', rpcId: ENQUEUED } }] } },
    { type: 'agent/inbox/spliced', seq: 48, data: { target: 'next-turn', start: 0, inserted: [{ id: 'item-remote', role: 'user', source: { kind: 'remote-control', rpcId: REMOTE_ENQUEUED } }] } },
    { type: 'agent/inbox/spliced', seq: 49, data: { target: 'next-turn', start: 0, inserted: [{ id: 'item-neighbor', role: 'user', source: { kind: 'user', rpcId: SAME_PREFIX }, content: [{ type: 'text', text: ENQUEUE_BODY }] }] } },
    { type: 'user/message', seq: 50, data: { turn: 4, source: { kind: 'user', rpcId: SAME_PREFIX }, content: [{ type: 'text', text: USER_BODY }] } },
  ]
}

function serviceFor(query: Deps['query']): RemoteService {
  return new RemoteService({
    query,
    gateway: {
      invoke: async () => { throw new Error('receipt 不得调用 gateway/list/status') },
      stream: async () => { throw new Error('receipt 不得调用 gateway stream') },
    },
    onStatus: () => () => {},
    config: () => ({ readOnly: false }),
    log: () => {},
  } as unknown as Deps)
}

function exactQuery(events: readonly RawEvent[], inheritedEventCount = 1, missingSessionIds: readonly string[] = []) {
  const calls: { sessionId: string; options: { projectionMode: 'none'; signal?: AbortSignal } }[] = []
  const state = { calls, readSessionCalls: 0, disposals: 0 }
  const query: Deps['query'] = {
    readSession: async () => { state.readSessionCalls++; throw new Error('receipt 不得退回 readSession') },
    observeSession: async (sessionId, options) => {
      calls.push({ sessionId, options })
      if (missingSessionIds.includes(sessionId)) throw Object.assign(new Error('UPSTREAM-MISSING-SECRET'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' })
      return {
        header: { id: sessionId }, inheritedEventCount, events,
        [Symbol.dispose]() { state.disposals++ },
      }
    },
  }
  return { query, state }
}

function runReceipt(service: RemoteService, sessionId: string, requestId: string) {
  return runCommand(service, 'receipt', [sessionId, requestId], {}, new AbortController().signal)
}

async function expectCode(promise: Promise<unknown>, code: string, forbidden?: string, usage = false) {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { code?: unknown }).code, code)
    if (usage) assert.ok(error instanceof UsageError)
    if (forbidden !== undefined) assert.doesNotMatch(String((error as Error).message), new RegExp(forbidden))
    return true
  })
}

test('receipt 精确区分入队与用户消息，排除同前缀、正文、注入、继承和相邻请求', async () => {
  const { query, state } = exactQuery(fixtureEvents())
  const service = serviceFor(query)
  const message = await runReceipt(service, SESSION, TARGET)
  assert.deepEqual(message.data, {
    sessionId: SESSION, requestId: TARGET, matched: true, state: 'user-message', asUserMessage: true,
    enqueued: true, turn: 2, seq: 3, enqueuedSeq: 1,
  })
  const serialized = JSON.stringify(message)
  for (const forbidden of [ENQUEUE_BODY, USER_BODY, INJECTED_BODY, INHERITED, INJECTED, ADJACENT, SAME_PREFIX]) {
    assert.ok(!serialized.includes(forbidden), `响应不得包含 ${forbidden}`)
  }
  const enqueued = await runReceipt(service, SESSION, ENQUEUED)
  assert.deepEqual(enqueued.data, {
    sessionId: SESSION, requestId: ENQUEUED, matched: true, state: 'enqueued', asUserMessage: false, enqueued: true, seq: 47,
  })
  assert.match(enqueued.text, /不表示现在仍在队列/)
  const remoteEnqueued = await runReceipt(service, SESSION, REMOTE_ENQUEUED)
  assert.deepEqual(remoteEnqueued.data, {
    sessionId: SESSION, requestId: REMOTE_ENQUEUED, matched: true, state: 'enqueued', asUserMessage: false, enqueued: true, seq: 48,
  })
  for (const missing of [MISSING_PREFIX, ADJACENT, INJECTED, INHERITED]) {
    await expectCode(runReceipt(service, SESSION, missing), 'request-not-found', USER_BODY)
  }
  const beforeInvalid = state.calls.length
  await expectCode(runReceipt(service, SESSION, TARGET.slice(0, 8)), 'usage')
  for (const invalidSession of ['1', 'session-', 'session-A B', '标题']) {
    await expectCode(runReceipt(service, invalidSession, TARGET), 'usage')
  }
  assert.equal(state.calls.length, beforeInvalid, '前缀或非法会话参数不得触发任何会话读取')
  assert.ok(state.calls.every((call) => call.sessionId === SESSION && call.options.projectionMode === 'none'))
  assert.equal(state.readSessionCalls, 0)
  assert.equal(state.disposals, state.calls.length)

  for (const shortSessionId of ['session-1', 'session-A']) {
    const short = exactQuery(fixtureEvents())
    const shortResult = await runReceipt(serviceFor(short.query), shortSessionId, TARGET)
    assert.equal((shortResult.data as Record<string, unknown>).sessionId, shortSessionId)
    assert.deepEqual(short.state.calls.map((call) => call.sessionId), [shortSessionId])
    assert.equal(short.state.disposals, 1)
  }

  const other = exactQuery([{ type: 'user/message', seq: 102, data: { id: 'other-message', role: 'user', source: { kind: 'remote-control', rpcId: OTHER_SESSION_REQUEST } } }], 0)
  await expectCode(runReceipt(serviceFor(other.query), OTHER_SESSION, TARGET), 'request-not-found')
  assert.deepEqual((await runReceipt(serviceFor(other.query), OTHER_SESSION, OTHER_SESSION_REQUEST)).data, {
    sessionId: OTHER_SESSION, requestId: OTHER_SESSION_REQUEST, matched: true, state: 'user-message', asUserMessage: true,
    enqueued: false, seq: 102,
  })
})

test('receipt 区分目标缺失、读取失败与旧宿主能力边界，不透传上游错误内容', async () => {
  for (const [upstreamCode, expected] of [
    ['SESSION_QUERY_SESSION_NOT_FOUND', 'session-not-found'],
    ['SESSION_QUERY_PERSISTENCE_FAILED', 'receipt-read-failed'],
    ['SESSION_QUERY_CORRUPT_SESSION', 'receipt-read-failed'],
  ] as const) {
    const query: Deps['query'] = {
      readSession: async () => { throw new Error('不得回退') },
      observeSession: async () => { throw Object.assign(new Error(`UPSTREAM-SECRET-${upstreamCode}`), { code: upstreamCode }) },
    }
    await expectCode(runReceipt(serviceFor(query), SESSION, TARGET), expected, 'UPSTREAM-SECRET', expected === 'session-not-found')
  }
  let legacyReads = 0
  const legacy: Deps['query'] = { readSession: async () => { legacyReads++; throw new Error('不得回退') } }
  await expectCode(runReceipt(serviceFor(legacy), SESSION, TARGET), 'exact-receipt-unavailable')
  assert.equal(legacyReads, 0)

  const malformed = exactQuery(fixtureEvents(), 999)
  await expectCode(runReceipt(serviceFor(malformed.query), SESSION, TARGET), 'receipt-read-failed')
  assert.equal(malformed.state.disposals, 1)
})

test('receipt 消毒观察方法与事件 getter 异常，并处理释放失败', async () => {
  let getterCalls = 0
  const getterQuery: Deps['query'] = {
    readSession: async () => { throw new Error('不得回退') },
    get observeSession(): NonNullable<Deps['query']['observeSession']> {
      getterCalls++
      throw new Error('UPSTREAM-OBSERVE-GETTER-SECRET')
    },
  }
  await expectCode(runReceipt(serviceFor(getterQuery), SESSION, TARGET), 'receipt-read-failed', 'UPSTREAM-OBSERVE-GETTER-SECRET')
  assert.equal(getterCalls, 1)

  let eventGetterDisposals = 0
  const eventGetterQuery: Deps['query'] = {
    readSession: async () => { throw new Error('不得回退') },
    observeSession: async () => ({
      header: { id: SESSION }, inheritedEventCount: 0,
      get events(): readonly RawEvent[] { throw new Error('UPSTREAM-EVENTS-GETTER-SECRET') },
      [Symbol.dispose]() { eventGetterDisposals++ },
    }),
  }
  await expectCode(runReceipt(serviceFor(eventGetterQuery), SESSION, TARGET), 'receipt-read-failed', 'UPSTREAM-EVENTS-GETTER-SECRET')
  assert.equal(eventGetterDisposals, 1)

  let failedDisposals = 0
  const disposeQuery: Deps['query'] = {
    readSession: async () => { throw new Error('不得回退') },
    observeSession: async () => ({
      header: { id: SESSION }, inheritedEventCount: 0, events: [],
      [Symbol.dispose]() { failedDisposals++; throw new Error('UPSTREAM-DISPOSE-SECRET') },
    }),
  }
  await expectCode(runReceipt(serviceFor(disposeQuery), SESSION, TARGET), 'receipt-read-failed', 'UPSTREAM-DISPOSE-SECRET')
  assert.equal(failedDisposals, 1)
})

test('真实 socket 上 CLI 文本/JSON 只给目标元数据，旧服明确拒绝且不改发 status/read', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-use-receipt-cli-'))
  const socketPath = join(root, 'dsh.sock')
  const legacySocket = join(root, 'legacy.sock')
  const { query, state } = exactQuery(fixtureEvents(), 1, ['session-missing'])
  const service = serviceFor(query)
  const server = await startServer({
    socketPath, commands: () => COMMANDS, info: () => ({}), log: () => {},
    run: (command, args, options, signal) => runCommand(service, command, args, options, signal),
  })
  const legacyCalls: string[] = []
  const legacy = await startServer({
    socketPath: legacySocket, commands: () => COMMANDS.filter((command) => command.name !== 'receipt'), info: () => ({}), log: () => {},
    run: async (command) => {
      legacyCalls.push(command)
      throw new UsageError(`没有命令 "${command}"。dsh-use help 看全部`)
    },
  })
  const shared = remoteFixture(root)
  const env = { HOME: root, DSH_HOME: root, DSH_USE_SOCKET: socketPath, DSH_USE_SHARED_ROOT: shared, XDG_STATE_HOME: join(root, 'state') }
  try {
    const json = await invokeCli(['receipt', SESSION, TARGET, '--json'], env)
    assert.equal(json.code, 0, json.out + json.err)
    const parsed = JSON.parse(json.out)
    assert.equal(parsed.data.state, 'user-message')
    assert.equal(parsed.data.requestId, TARGET)
    assert.ok(!json.out.includes(USER_BODY) && !json.out.includes(ENQUEUE_BODY) && !json.out.includes(ADJACENT))

    const plain = await invokeCli(['receipt', SESSION, ENQUEUED], env)
    assert.equal(plain.code, 0, plain.out + plain.err)
    assert.match(plain.out, /曾记录入队/)
    assert.match(plain.out, /不表示现在仍在队列/)
    assert.ok(!plain.out.includes(ENQUEUE_BODY))

    const missing = await invokeCli(['receipt', SESSION, ADJACENT, '--json'], env)
    assert.notEqual(missing.code, 0)
    assert.equal(JSON.parse(missing.out).error.code, 'request-not-found')

    const missingSession = await invokeCli(['receipt', 'session-missing', TARGET, '--json'], env)
    assert.equal(missingSession.code, 2, missingSession.out + missingSession.err)
    assert.equal(JSON.parse(missingSession.out).error.code, 'session-not-found')
    assert.ok(!missingSession.out.includes('session-missing') && !missingSession.out.includes('UPSTREAM-MISSING-SECRET'))

    const beforeBadOption = state.calls.length
    const badOption = await invokeCli(['receipt', SESSION, TARGET, '--request-id', TARGET], env)
    assert.notEqual(badOption.code, 0)
    assert.equal(state.calls.length, beforeBadOption)

    const old = await invokeCli(['receipt', SESSION, TARGET, '--json'], { ...env, DSH_USE_SOCKET: legacySocket })
    assert.notEqual(old.code, 0)
    assert.match(old.out, /没有命令/)
    assert.ok(!old.out.includes(USER_BODY) && !old.out.includes(ENQUEUE_BODY))
    assert.deepEqual(legacyCalls, ['receipt'])
    assert.equal(state.readSessionCalls, 0)
  } finally {
    await legacy.close()
    await server.close()
    rmSync(root, { recursive: true, force: true })
  }
})
