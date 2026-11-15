import assert from 'node:assert/strict'
import test from 'node:test'
import { buildTranscript, readTurn, renderItem, search, turnLine, type RawEvent } from '../src/transcript.ts'

const text = (value: string) => ({ type: 'text', text: value })
const ev = (type: string, seq: number, data: unknown): RawEvent => ({ type, seq, time: 1000 + seq, data })
const options = { itemChars: 2000, includeInjected: false }
const fixture: RawEvent[] = [
  ev('turn/start', 3, { turn: 1 }),
  ev('user/message', 7, { source: { kind: 'user' }, content: [text('Find [literal].\nTwo words')] }),
  ev('user/message', 8, { source: { kind: 'skill-catalog' }, content: [text('hidden catalog')] }),
  ev('step/start', 14, { turn: 1, step: 1 }),
  ev('assistant/message', 16, { turn: 1, message: { content: [
    { type: 'reasoning', text: 'private reasoning sentinel' }, text('before'),
    { type: 'tool-call', id: 'call-1', name: 'grep', arguments: '{"query":"x"}' },
    text('between'), { type: 'tool-call', id: 'call-2', name: 'read', arguments: { path: 'file' } },
    text('after'), { type: 'image' }, { type: 'file', name: 'report.pdf' },
  ] } }),
  ev('tool/result', 20, { turn: 1, message: { toolCallId: 'call-1', isError: true, content: [text('missing file')] } }),
  ev('assistant/attempt', 21, { turn: 1, stream: [
    { chunk: { type: 'reasoning-delta', text: 'private attempt sentinel' } },
    { chunk: { type: 'finish', reason: { kind: 'error', failure: { code: 'EMPTY_RESPONSE', message: 'no content' } } } },
  ] }),
  ev('turn/end', 22, { turn: 1, reason: { kind: 'error', error: { code: 'EMPTY_RESPONSE', message: 'no content' } } }),
]

test('按原顺序输出回复内容和工具信息，不输出思考', () => {
  const transcript = buildTranscript(fixture)
  const assistant = transcript.items.filter(i => i.seq === 16)
  assert.deepEqual(assistant.map(i => [i.kind, i.text]), [
    ['assistant', 'before'], ['tool-call', '{"query":"x"}'], ['assistant', 'between'],
    ['tool-call', '{"path":"file"}'], ['assistant', 'after\n[image]\n[file report.pdf]'],
  ])
  assert.equal(assistant[1]!.callId, 'call-1')
  assert.equal(assistant[3]!.label, 'read')
  const result = transcript.items.find(i => i.kind === 'tool-result')!
  assert.equal(result.callId, 'call-1')
  assert.equal(result.label, 'grep')
  assert.equal(result.isError, true)
  assert.equal(result.text, 'missing file')
  assert.equal(JSON.stringify(transcript).includes('private reasoning sentinel'), false)
  assert.equal(JSON.stringify(transcript).includes('private attempt sentinel'), false)
  assert.equal(search(transcript, 'private reasoning sentinel', 20, true).total, 0)
})

test('汇总步骤、请求失败、背景内容和结束错误', () => {
  const transcript = buildTranscript(fixture)
  assert.deepEqual(transcript.turns[0], {
    turn: 1, start: 1003, end: 1022, user: 'Find [literal].\nTwo words', steps: 1,
    toolCalls: 2, toolErrors: 1, injected: [{ label: 'skill-catalog', chars: 14 }],
    ended: 'error', endDetail: 'EMPTY_RESPONSE: no content',
  })
  assert.equal(transcript.items.find(i => i.kind === 'attempt-failed')!.text, 'EMPTY_RESPONSE: no content')
  assert.match(turnLine(transcript.turns[0]!), /2 tool calls \(1 failed\).*EMPTY_RESPONSE/)
})

test('首条待发消息及连续待发消息归到正确轮次', () => {
  const transcript = buildTranscript([
    ev('user/message', 1, { content: [text('first')] }),
    ev('turn/start', 2, { turn: 1 }),
    ev('turn/end', 3, { turn: 1, reason: { kind: 'completed' } }),
    ev('user/message', 4, { content: [text('second')] }),
    ev('user/message', 5, { content: [text('third')] }),
    ev('user/message', 6, { source: { kind: 'runtime-context' }, content: [text('context')] }),
    ev('turn/start', 7, { turn: 2 }),
    ev('user/message', 8, { content: [text('during turn')] }),
  ])
  assert.equal(transcript.turns[0]!.user, 'first')
  assert.equal(transcript.turns[1]!.user, 'second\n\nthird\n\nduring turn')
  assert.deepEqual(transcript.items.filter(i => i.kind !== 'turn-end').map(i => i.turn), [1, 2, 2, 2, 2])
  assert.equal(transcript.turns[1]!.ended, undefined)
})

test('尊重显式轮次，保留空轮和中止原因', () => {
  const transcript = buildTranscript([
    ev('turn/start', 1, { turn: 1 }),
    ev('turn/end', 2, { turn: 1, reason: { kind: 'aborted', reason: { kind: 'disposed' } } }),
    ev('user/message', 3, { turn: 1, content: [text('explicit turn')] }),
    ev('turn/start', 4, { turn: 2 }),
    ev('turn/end', 5, { turn: 2, reason: { kind: 'blocked' } }),
  ])
  assert.equal(transcript.turns[0]!.user, 'explicit turn')
  assert.equal(transcript.turns[0]!.endDetail, 'disposed')
  assert.equal(transcript.turns[1]!.user, '')
  assert.equal(transcript.turns[1]!.ended, 'blocked')
})

test('默认隐藏压缩及引用背景，明确要求后才展开', () => {
  const transcript = buildTranscript([
    ev('turn/start', 1, { turn: 1 }),
    ev('user/message', 2, { source: { kind: 'compact-checkpoint' }, content: [text('checkpoint secret')] }),
    ev('user/message', 3, { source: { kind: 'session-reference' }, content: [text('reference secret')] }),
    ev('compaction/summary', 4, { summary: [text('duplicate checkpoint')] }),
  ])
  assert.equal(transcript.items.length, 2)
  const hidden = readTurn(transcript, 1, 0, 1000, options).text
  assert.match(hidden, /compact-checkpoint/)
  assert.match(hidden, /session-reference/)
  assert.equal(hidden.includes('secret'), false)
  assert.equal(search(transcript, 'secret', 20, false).total, 0)
  assert.equal(search(transcript, 'secret', 20, true).total, 2)
  assert.match(readTurn(transcript, 1, 0, 1000, { ...options, includeInjected: true }).text, /checkpoint secret/)
})

test('分页顺序和定位稳定，字数上限包含分隔符', () => {
  const transcript = buildTranscript(fixture)
  const rendered = transcript.items.map(i => renderItem(i, options))
  const firstLength = rendered[0]!.length
  const boundary = readTurn(transcript, 1, 0, firstLength + rendered[1]!.length + 1, options)
  assert.equal(boundary.text, rendered[0])
  assert.equal(boundary.nextOffset, 1)
  const collected: string[] = []
  let offset = 0
  do {
    const page = readTurn(transcript, 1, offset, 170, options)
    assert.ok(page.text.length <= 170)
    collected.push(page.text)
    if (page.nextOffset === undefined) break
    assert.ok(page.nextOffset > offset)
    offset = page.nextOffset
  } while (true)
  assert.equal(collected.join('\n\n'), rendered.join('\n\n'))
  assert.equal(readTurn(transcript, 1, -3, 170, options).text, readTurn(transcript, 1, 0, 170, options).text)
  assert.equal(readTurn(transcript, 1, 999, 170, options).text, '')
  assert.equal(readTurn(transcript, 99, 0, 170, options).total, 0)
})

test('截断过大的首条与错误记录，翻页仍能前进', () => {
  const transcript = buildTranscript([
    ev('turn/start', 1, { turn: 1 }), ev('user/message', 2, { content: [text('x'.repeat(10000))] }),
    ev('turn/end', 3, { turn: 1, reason: { kind: 'error', error: { message: 'e'.repeat(10000) } } }),
  ])
  const page = readTurn(transcript, 1, 0, 100, { itemChars: 20000, includeInjected: false })
  assert.equal(page.text.length, 100)
  assert.match(page.text, /raise max_chars/)
  assert.equal(page.nextOffset, 1)
  assert.ok(renderItem(transcript.items[1]!, { ...options, itemChars: 20 }).length < 200)
  assert.equal(readTurn(transcript, 1, 0, 0, options).text, '')
  assert.equal(readTurn(transcript, 1, 0, 0, options).nextOffset, 1)
})

test('搜索按字面匹配并忽略大小写和空白差异，命中可定位', () => {
  const transcript = buildTranscript(fixture)
  assert.equal(search(transcript, ' ', 10, false).total, 0)
  assert.equal(search(transcript, '[literal]. two   words', 10, false).total, 1)
  assert.equal(search(transcript, '[literal]X', 10, false).total, 0)
  const found = search(transcript, 'call', 0, true)
  assert.deepEqual(found.hits, [])
  const hit = search(transcript, 'BEtween', 10, false).hits[0]!
  assert.equal(hit.turn, 1)
  assert.equal(hit.seq, 16)
  assert.equal(hit.kind, 'assistant')
  assert.match(readTurn(transcript, hit.turn, hit.offset, 1000, options).text, /^\[assistant · seq 16\]\nbetween/)
  const limited = search(transcript, 'o', 1, false)
  assert.equal(limited.hits.length, 1)
  assert.ok(limited.total > 1)
})

test('搜索长文本时摘要仍受输出上限约束', () => {
  const value = 'z'.repeat(10000)
  const transcript = buildTranscript([ev('user/message', 1, { content: [text(value)] })])
  const result = search(transcript, value, 10, false)
  assert.equal(result.total, 1)
  assert.ok(result.hits[0]!.snippet.length <= 321)
  assert.ok(result.hits[0]!.snippet.endsWith('…'))
})

test('容忍不完整事件并采用最新标题，不暴露纯思考消息', () => {
  const transcript = buildTranscript([
    ev('session/title', 1, { title: 'old' }), ev('session/title', 2, { title: 'new' }),
    { type: 'turn/start', data: { turn: 1 } },
    ev('assistant/message', 3, { turn: 1, message: { content: [{ type: 'reasoning', text: 'private only' }] } }),
    { type: 'unrecognized', data: null },
  ])
  assert.equal(transcript.title, 'new')
  assert.equal(transcript.items.length, 0)
  assert.equal(transcript.turns.length, 1)
  assert.equal(transcript.firstTime, 1001)
  assert.equal(transcript.lastTime, 1003)
})
