import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectQuitBlockers, type LiveAgent } from '../src/quit-blockers.ts'
import { RemoteService, type Deps, type QuitBlockers } from '../src/service.ts'

function agent(id: string, nextStep: readonly unknown[] = [], nextTurn: readonly unknown[] = [], status = 'idle'): LiveAgent {
  return Object.freeze({ id, status, inbox: Object.freeze({ nextTurn: Object.freeze([...nextTurn]), nextStep: Object.freeze([...nextStep]) }) })
}

function service(blockers: QuitBlockers, scheduled?: Deps['scheduledReminders']): RemoteService {
  const forbidden = () => { throw new Error('只读诊断不许调用宿主或历史') }
  const deps: Deps = {
    gateway: { invoke: async () => forbidden(), stream: async () => forbidden() },
    typert: { list: forbidden, get: forbidden },
    query: { readSession: async () => forbidden() },
    usage: async () => forbidden(), onStatus: () => () => {},
    config: () => ({ readOnly: true, denyNamespaces: [], tiers: { normal: [], fast: [] }, reservePercent: 10, waitSliceMs: 0 }),
    log: forbidden, quitBlockers: () => blockers,
    ...(scheduled === undefined ? {} : { scheduledReminders: scheduled }),
  }
  return new RemoteService(deps)
}

const unreadableContent = { get content() { throw new Error('不许读正文') }, get text() { throw new Error('不许读正文') } }

test('真实采集函数只投影 live agents，保留原始数量及运行子代理归属', () => {
  const live = Object.freeze([
    agent('session-job-notice', [Object.assign(unreadableSource(), { source: { kind: 'tool-jobs', form: 'notice', summary: '任务已取消', rpcId: 'secret' } })]),
    agent('session-user', [{ source: { kind: 'user' } }], [{ source: { kind: 'user' } }]),
    agent('session-plugin', [{ source: { kind: 'plugin:openviking-memory', form: 'instructions' } }]),
    agent('session-unknown', [null, 42, {}, { source: { kind: 3, form: false, summary: 3 } }]),
    Object.freeze({ ...agent('session-child', [{ source: { kind: 'tool-jobs' } }], [], 'running'), session: { header: { origin: 'subagent', parentSession: 'session-parent' } } }),
    agent('session-empty'),
  ])
  const result = collectQuitBlockers(live)
  assert.deepEqual(result.running, ['session-child'])
  assert.deepEqual(result.queued, ['session-job-notice', 'session-user', 'session-plugin', 'session-unknown'])
  assert.deepEqual(result.parents, { 'session-child': 'session-parent' })
  const idle = collectQuitBlockers([Object.freeze({ ...agent('session-idle-child'), session: { header: { origin: 'subagent', parentSession: 'session-parent' } } })])
  assert.deepEqual(idle.parents, { 'session-idle-child': 'session-parent' }, '闲着的子代理也记上级，名下任务的说明才能送到')
  assert.deepEqual(idle.running, [])
  assert.equal(result.queuedDetails.length, live.length)
  assert.deepEqual(result.queuedDetails[0], { id: 'session-job-notice', nextTurnCount: 0, nextStepCount: 1, nextStepSources: [{ kind: 'tool-jobs', form: 'notice', summary: '任务已取消' }] })
  assert.equal(result.queuedDetails[1]?.nextTurnCount, 1)
  assert.equal(result.queuedDetails[3]?.nextStepCount, 4)
  assert.deepEqual(result.queuedDetails[3]?.nextStepSources, Array.from({ length: 4 }, () => ({ kind: 'unknown' })))
  assert.deepEqual(result.queuedDetails[5]?.nextStepSources, [])
  assert.doesNotMatch(JSON.stringify(result), /secret|content|text|rpcId/)
})

function unreadableSource() {
  return Object.create(null, Object.getOwnPropertyDescriptors(unreadableContent)) as typeof unreadableContent
}

test('摘要只取 source.summary，归一空白并截断，不读正文及其他来源字段', () => {
  const message = unreadableSource()
  Object.defineProperty(message, 'source', { value: { kind: 'tool-jobs', form: 'notice', summary: '  一行\n' + '长'.repeat(300), get rpcId() { throw new Error('不许读其他来源字段') } } })
  const source = collectQuitBlockers([agent('session-bounded', [message])]).queuedDetails[0]?.nextStepSources[0]
  assert.equal(source?.summary?.length, 120)
  assert.equal(source?.summary?.endsWith('…'), true)
  assert.doesNotMatch(source?.summary ?? '', /\n/)
})

test('quit-check 真实服务显示下一步通知、用户消息和插件背景，不泛称下一轮排队', async () => {
  const blockers = { ...collectQuitBlockers([
    agent('session-job-notice', [{ source: { kind: 'tool-jobs', form: 'notice', summary: '任务已取消' } }]),
    agent('session-user', [{ source: { kind: 'user' } }], [{}]),
    agent('session-plugin', [{ source: { kind: 'plugin:openviking-memory', form: 'instructions' } }]),
    agent('session-plugin-notice', [{ source: { kind: 'dsh-use', form: 'notice' } }]),
    agent('session-unknown', [{}]),
    agent('session-running', [{ source: { kind: 'tool-jobs' } }], [], 'running'),
  ]), jobs: [] }
  const result = await service(blockers).quitCheck()
  assert.match(result.text, /下一轮排队 0 条；下一步待领 1 条（后台任务通知〔tool-jobs\/notice〕：任务已取消）/)
  assert.match(result.text, /下一轮排队 1 条；下一步待领 1 条（用户消息〔user〕）/)
  assert.match(result.text, /插件背景〔plugin:openviking-memory\/instructions〕/)
  assert.match(result.text, /插件通知〔dsh-use\/notice〕/)
  assert.match(result.text, /未知来源〔unknown〕/)
  assert.doesNotMatch(result.text, /有排队消息的会话/)
  assert.deepEqual(result.data, { ...blockers, clear: false, restartReady: false })
})

test('未知消息仍然阻碍退出；后台任务终态后留下的待领通知也不被删掉', async () => {
  for (const message of [null, { source: { kind: 'tool-jobs', form: 'notice', summary: '任务已取消' } }]) {
    const blockers = { ...collectQuitBlockers([agent('session-pending', [message])]), jobs: [] }
    const result = await service(blockers).quitCheck()
    assert.deepEqual(result.data, { ...blockers, clear: false, restartReady: false })
    assert.equal(blockers.queuedDetails[0]?.nextStepCount, 1)
  }
})

test('旧 quitBlockers 无 details 时保留诊断，退出标准与可续监听不变', async () => {
  const legacy = { running: [], queued: ['session-legacy'], jobs: [] }
  assert.match((await service(legacy).quitCheck()).text, /有排队消息的会话 1 个/)
  assert.deepEqual((await service(legacy).quitCheck()).data, { ...legacy, clear: false, restartReady: false })
  const empty = { ...collectQuitBlockers([agent('session-empty')]), jobs: [] }
  assert.deepEqual((await service(empty).quitCheck()).data, { ...empty, clear: true, restartReady: true })
  const survivable = { ...empty, jobs: [{ id: 'job-survivor', kind: 'monitor', label: '监听', survivable: true }] }
  assert.deepEqual((await service(survivable).quitCheck()).data, { ...survivable, clear: false, restartReady: true })
  const blocking = { ...empty, jobs: [{ id: 'job-normal', kind: 'bash', label: '普通任务' }] }
  assert.deepEqual((await service(blocking).quitCheck()).data, { ...blocking, clear: false, restartReady: false })
})

test('已加载会话挂着定时提醒：会话和任务都空闲也照实报出，App 退出仍会弹框', async () => {
  const empty = { ...collectQuitBlockers([agent('session-424e24d6-e0f0')]), jobs: [] }
  const scheduled = [{ sessionId: 'session-424e24d6-e0f0', items: [{ id: 'schedule-de8631b1-0ae6', label: 'dsh-use 验收测试提醒' }] }]
  const result = await service(empty, async () => scheduled).quitCheck()
  assert.deepEqual(result.data, { ...empty, clear: true, restartReady: true, scheduled })
  assert.match(result.text, /应用关闭期间，定时任务不会运行/)
  assert.match(result.text, /会话 424e24d6：「dsh-use 验收测试提醒」（de8631b1）/)
  assert.doesNotMatch((await service(empty, async () => []).quitCheck()).text, /定时提醒/)
})
