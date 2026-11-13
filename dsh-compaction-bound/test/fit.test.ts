import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { CHECKPOINT_KIND } from '../src/summary.ts'
import { budgetTokens, fitMessages, promptTokens, requestChars, TOOL_TEXT_KEEP } from '../src/fit.ts'

type M = { role: string; content: Array<{ type: string; text?: string; id?: string; name?: string; arguments?: string }>; source?: { kind: string }; toolCallId?: string }
const sys: M = { role: 'system', content: [{ type: 'text', text: 'system prompt' }], source: { kind: 'system-prompt' } }
const user = (text: string): M => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const checkpoint: M = { role: 'user', content: [{ type: 'text', text: 'prior checkpoint' }], source: { kind: CHECKPOINT_KIND } }
const call = (id: string): M => ({ role: 'assistant', content: [{ type: 'tool-call', id, name: 'read', arguments: '{}' }], source: { kind: 'model' } })
const result = (id: string, size: number): M => ({ role: 'tool', toolCallId: id, content: [{ type: 'text', text: 'x'.repeat(size) }], source: { kind: 'tool' } })
const reply = (size: number): M => ({ role: 'assistant', content: [{ type: 'text', text: 'y'.repeat(size) }], source: { kind: 'model' } })
const instruction: M = { role: 'user', content: [{ type: 'text', text: 'compaction instruction' }] }

test('先截工具结果：只截超长的文本块，留开头和结尾，够了就不再丢消息', () => {
  const messages = [sys, user('u1'), call('a'), result('a', 20000), reply(100), user('u2'), reply(100), instruction]
  const before = requestChars(messages, undefined)
  const fit = fitMessages(messages, undefined, before - 10000)!
  assert.equal(fit.trimmedToolResults, 1)
  assert.equal(fit.droppedMessages, 0)
  assert.equal(fit.messages.length, messages.length)
  const text = (fit.messages[3] as M).content[0]!.text!
  assert.ok(text.length < TOOL_TEXT_KEEP + 200)
  assert.match(text, /characters of this tool result omitted/)
  assert.ok(fit.afterChars <= before - 10000)
  assert.equal(messages[3]!.content[0]!.text!.length, 20000, '不改原请求对象')
})

test('再从最早处丢：切口只在用户消息前，工具调用和结果不拆开；系统提示、上一份检查点、最后的指令保留', () => {
  // u2 夹在调用 b 和它的结果之间（插话），切在 u2 前会留下孤立的工具结果，不合法
  const messages = [sys, checkpoint, user('u1'), reply(30000), call('b'), user('u2'), result('b', 500), user('u3'), reply(2000), instruction]
  const fit = fitMessages(messages, undefined, 6000)!
  const out = fit.messages as M[]
  assert.equal(out[0], sys)
  assert.equal(out[1], checkpoint)
  assert.equal(out.at(-1), instruction)
  assert.equal(out[2]!.content[1]!.text, 'u3', '切在 u3 前，不切在 u2 前')
  assert.match(out[2]!.content[0]!.text!, /^\[5 earlier messages/)
  for (const m of out) if (m.role === 'tool') assert.ok(out.some((x) => x.content.some((b) => b.type === 'tool-call' && b.id === m.toolCallId)))
  assert.equal(fit.droppedMessages, 5)
  assert.ok(fit.afterChars <= 6000)
})

test('怎么丢都放不下就返回 undefined，照原请求发', () => {
  assert.equal(fitMessages([sys, user('u1'), reply(50000), instruction], undefined, 1000), undefined)
})

test('用量和预算：输入 token 取「总数减输出」和各项相加里大的；预算扣掉输出预留再留一成', () => {
  assert.equal(promptTokens({ inputTokens: 3805, outputTokens: 1102, totalTokens: 437547, cacheReadTokens: 432640 }), 436445)
  assert.equal(promptTokens({ inputTokens: 710757, outputTokens: 206, totalTokens: 710963 }), 710757)
  assert.equal(promptTokens(undefined), undefined)
  assert.equal(budgetTokens(400000, 65536), Math.floor((400000 - 65536) * 0.9))
  assert.equal(budgetTokens(400000, 384000), Math.floor(200000 * 0.9), '输出预留最多算半个窗口')
})
