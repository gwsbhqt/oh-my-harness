import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, resolveConfig } from '../src/index.ts'
import { dedupeNotices } from '../src/dedupe.ts'
import type { MessageLike } from '../src/notice.ts'

function notice(kind: string, text: string): MessageLike {
  return Object.freeze({
    role: 'user',
    id: `m-${kind}-${text.length}`,
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind, form: 'notice', summary: 'bash × 3' }),
  })
}

const human = (text: string): MessageLike => ({ role: 'user', id: 'h', content: [{ type: 'text', text }], source: { kind: 'user' } })

test('同一步里一模一样的通知只留第一条', () => {
  const text = 'You are repeating the exact same tool call with identical arguments.'
  const input = [notice('repeat-tool-reminder', text), notice('repeat-tool-reminder', text), notice('repeat-tool-reminder', text)]
  const out = dedupeNotices(input)
  assert.equal(out.length, 1)
  assert.equal(out[0], input[0])
})

test('文本不同的通知、来源不同的通知都全保留', () => {
  const input = [
    notice('repeat-tool-reminder', 'bash × 3 温和版'),
    notice('repeat-tool-reminder', 'bash × 5 详细版'),
    notice('tool-jobs', 'bash × 3 温和版'),
  ]
  assert.deepEqual(dedupeNotices(input), input)
})

test('正文相同但摘要不同的通知都保留', () => {
  const first = notice('repeat-tool-reminder', '请勿重复调用')
  const second: MessageLike = { ...first, source: { ...first.source, summary: 'read × 3' } }
  assert.deepEqual(dedupeNotices([first, second]), [first, second])
})

test('非文本内容不同的通知都保留', () => {
  const image1 = { type: 'image', url: 'one' }
  const image2 = { type: 'image', url: 'two' }
  const first: MessageLike = { role: 'user', source: { kind: 'notice-test', form: 'notice' }, content: [image1] }
  const second: MessageLike = { ...first, content: [image2] }
  assert.deepEqual(dedupeNotices([first, second]), [first, second])
})

test('非通知消息不参与去重，一模一样也原样保留', () => {
  const input = [human('继续'), human('继续'), notice('tool-jobs', 'a'), notice('tool-jobs', 'a')]
  const out = dedupeNotices(input)
  assert.deepEqual(out, [input[0], input[1], input[2]])
})

test('开关默认开，可以关', () => {
  assert.equal(resolveConfig(Config({})).noticeDedupe, true)
  assert.equal(resolveConfig(Config({ noticeDedupe: false })).noticeDedupe, false)
})
