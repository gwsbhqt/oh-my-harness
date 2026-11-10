import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTranscript, renderTurn, turnLine } from '../src/transcript.ts'

const events = [
  { type: 'session', cwd: '/repo' },
  { type: 'session/title', seq: 0, data: { title: '修 CI' } },
  { type: 'turn/start', seq: 1, time: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '修一下' }] } },
  { type: 'user/message', seq: 3, data: { source: { kind: 'skill-catalog' }, content: [{ type: 'text', text: 'X'.repeat(5000) }] } },
  { type: 'request/header', seq: 4, data: { header: { config: { provider: 'claude', model: 'claude-opus-5-5' } } } },
  { type: 'step/start', seq: 5, data: { turn: 1, step: 1 } },
  { type: 'assistant/message', seq: 6, data: { turn: 1, message: { content: [{ type: 'reasoning', text: 'THINK' }, { type: 'text', text: '我先看看' }, { type: 'tool-call', id: 't1', name: 'bash', arguments: '{"command":"ls"}' }] } } },
  { type: 'tool/result', seq: 7, data: { message: { toolCallId: 't1', isError: true, content: [{ type: 'text', text: 'boom' }] } } },
  { type: 'assistant/message', seq: 8, data: { turn: 1, message: { content: [{ type: 'text', text: '修好了' }] } } },
  { type: 'turn/end', seq: 9, time: 2, data: { turn: 1, reason: { kind: 'error', error: { code: 'REFUSAL', message: '拒答' } } } },
  { type: 'turn/start', seq: 10, data: { turn: 2 } },
]

test('逐轮汇总：最后一段回复、工具失败、结束原因、模型、cwd、lastSeq', () => {
  const t = buildTranscript(events)
  assert.equal(t.title, '修 CI')
  assert.equal(t.cwd, '/repo')
  assert.equal(t.lastSeq, 10)
  assert.deepEqual(t.model, { provider: 'claude', model: 'claude-opus-5-5' })
  const [one, two] = t.turns
  assert.equal(one!.reply, '修好了')
  assert.equal(one!.toolErrors, 1)
  assert.equal(one!.ended, 'error')
  assert.equal(one!.endDetail, 'REFUSAL: 拒答')
  assert.equal(two!.ended, undefined)
  assert.match(turnLine(one!), /问：修一下/)
})

test('单轮详情：默认略过工具，不输出思考块，注入内容只标长度', () => {
  const t = buildTranscript(events)
  const plain = renderTurn(t, 1, { itemChars: 2000, tools: false, maxChars: 16000 })
  assert.doesNotMatch(plain, /THINK/)
  assert.doesNotMatch(plain, /boom/)
  assert.match(plain, /注入的背景 skill-catalog · 5000 字/)
  const withTools = renderTurn(t, 1, { itemChars: 2000, tools: true, maxChars: 16000 })
  assert.match(withTools, /结果 bash · 出错/)
})

test('历史控制来源仍按用户发言解码，现行插件通知保持背景来源', () => {
  const t = buildTranscript([
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { source: { kind: 'remote-control' }, content: [{ type: 'text', text: '历史问题仍可读' }] } },
    { type: 'user/message', seq: 3, data: { source: { kind: 'dsh-control', form: 'notice' }, content: [{ type: 'text', text: '系统续跑通知' }] } },
  ])
  assert.equal(t.turns[0]?.user, '历史问题仍可读')
  assert.match(renderTurn(t, 1, { itemChars: 2000, tools: false, maxChars: 16000 }), /历史问题仍可读/)
  assert.equal(t.items.find((item) => item.seq === 3)?.kind, 'injected')
})
