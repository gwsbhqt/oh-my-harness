import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PendingQuestions } from '../src/questions.ts'

const questions = [{ id: 'color', question: '喜欢哪种颜色？', options: [{ label: '红' }, { label: '蓝' }] }]

test('远程先答：返回远程答案，下游收到取消，待答表清空', async () => {
  const changes: string[] = []
  const p = new PendingQuestions((id) => changes.push(id))
  let downstreamSignal: AbortSignal | undefined
  const request = { questions, agent: { id: 'session-x' }, signal: new AbortController().signal, wait: { callId: 'call-1' } }
  const answer = p.listener(request, () => {
    downstreamSignal = request.signal
    return new Promise((_, reject) => request.signal.addEventListener('abort', () => reject(new Error('card closed'))))
  })
  assert.equal(p.list('session-x').length, 1)
  assert.equal(p.list('session-x')[0]!.callId, 'call-1')
  assert.throws(() => p.answer('session-x', { answers: [] }), /逐个覆盖/)
  assert.equal(p.answer('session-x', { answers: [{ id: 'color', selected: ['蓝'] }] }), true)
  assert.deepEqual(await answer, { answers: [{ id: 'color', selected: ['蓝'] }] })
  assert.equal(downstreamSignal?.aborted, true)
  assert.equal(p.list().length, 0)
  assert.deepEqual(changes, ['session-x', 'session-x'])
})

test('浏览器先答：返回浏览器答案，远程再答找不到', async () => {
  const p = new PendingQuestions()
  const request = { questions, agent: { id: 'session-y' } }
  const result = await p.listener(request, async () => ({ answers: [{ id: 'color', selected: ['红'] }] }))
  assert.deepEqual(result, { answers: [{ id: 'color', selected: ['红'] }] })
  assert.equal(p.answer('session-y', { answers: [{ id: 'color', selected: ['蓝'] }] }), false)
})

test('上游取消（工具调用被中止）：整体失败、待答表清空', async () => {
  const p = new PendingQuestions()
  const upstream = new AbortController()
  const request = { questions, agent: { id: 'session-z' }, signal: upstream.signal }
  const pending = p.listener(request, () => new Promise(() => {}))
  upstream.abort(new Error('tool aborted'))
  await assert.rejects(pending, /tool aborted/)
  assert.equal(p.list().length, 0)
})

const noAnswerer = () => Promise.reject(Object.assign(new Error('no user-questions answerer accepted the request'), { code: 'NO_PROVIDER' }))

test('窗口全关：不当场失败，提醒一次，等待期间远程回答照样生效', async () => {
  const reminded: { sessionId: string; graceMs: number }[] = []
  const p = new PendingQuestions(() => {}, { graceMs: () => 60_000, onUnattended: ({ sessionId, graceMs }) => reminded.push({ sessionId, graceMs }) })
  const answer = p.listener({ questions, agent: { id: 'session-n' } }, noAnswerer)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(reminded, [{ sessionId: 'session-n', graceMs: 60_000 }])
  assert.equal(p.list('session-n').length, 1)
  assert.equal(p.answer('session-n', { answers: [{ id: 'color', selected: ['红'] }] }), true)
  assert.deepEqual(await answer, { answers: [{ id: 'color', selected: ['红'] }] })
  assert.equal(p.list().length, 0)
})

test('窗口全关、到点没人答：原样抛出宿主的 NO_PROVIDER', async () => {
  const p = new PendingQuestions(() => {}, { graceMs: () => 20, onUnattended: () => {} })
  await assert.rejects(p.listener({ questions, agent: { id: 'session-t' } }, noAnswerer), (error: { code?: string }) => error.code === 'NO_PROVIDER')
  assert.equal(p.list().length, 0)
})

test('等待设为 0 或别的错误：照原样当场失败，不提醒', async () => {
  let reminded = 0
  const off = new PendingQuestions(() => {}, { graceMs: () => 0, onUnattended: () => { reminded += 1 } })
  await assert.rejects(off.listener({ questions, agent: { id: 'session-o' } }, noAnswerer), (error: { code?: string }) => error.code === 'NO_PROVIDER')
  const on = new PendingQuestions(() => {}, { graceMs: () => 60_000, onUnattended: () => { reminded += 1 } })
  await assert.rejects(on.listener({ questions, agent: { id: 'session-e' } }, () => Promise.reject(new Error('card crashed'))), /card crashed/)
  assert.equal(reminded, 0)
})

test('等待期间工具被中止：整体失败，不留计时', async () => {
  const p = new PendingQuestions(() => {}, { graceMs: () => 60_000, onUnattended: () => {} })
  const upstream = new AbortController()
  const pending = p.listener({ questions, agent: { id: 'session-a' }, signal: upstream.signal }, noAnswerer)
  await new Promise((resolve) => setImmediate(resolve))
  upstream.abort(new Error('tool aborted'))
  await assert.rejects(pending, /tool aborted/)
  assert.equal(p.list().length, 0)
})

test('没有 agent 的程序化提问原样交给下一环', async () => {
  const p = new PendingQuestions()
  const r = await p.listener({ questions }, async () => ({ answers: [] }))
  assert.deepEqual(r, { answers: [] })
  assert.equal(p.list().length, 0)
})
