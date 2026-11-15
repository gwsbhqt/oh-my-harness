import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeMessageText, looksEscapedMessage, decodeMessageEscapes } from '../src/message-text.ts'

/** 模拟 json.dumps(ensure_ascii=True) 的字符串内容（不含两端引号），把非 ASCII 转成 \\uXXXX。 */
function jsonEscapedContent(s: string): string {
  const quoted = JSON.stringify(s) // 控制字符、引号、反斜杠已转义
  return quoted
    .slice(1, -1)
    .replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))
}

test('还原被 json.dumps 转义的中文', () => {
  const original = '只做一件事，禁止使用任何文件和工具。'
  const escaped = jsonEscapedContent(original)
  assert.ok(escaped.includes('\\u'))
  assert.ok(looksEscapedMessage(escaped))
  assert.equal(normalizeMessageText(escaped), original)
})

test('带换行和中文的转义串完整还原', () => {
  const original = '第一行\n第二行：中文，标点。'
  const escaped = jsonEscapedContent(original)
  assert.ok(escaped.includes('\\n'))
  assert.equal(normalizeMessageText(escaped), original)
})

test('正常中文原样返回', () => {
  const s = '这是护栏实机验证，请照做。'
  assert.equal(looksEscapedMessage(s), false)
  assert.equal(normalizeMessageText(s), s)
})

test('纯英文原样返回', () => {
  const s = 'Please review the diff and report.'
  assert.equal(normalizeMessageText(s), s)
})

test('单个被转义的汉字也会被还原（尽可能解析清楚）', () => {
  const s = 'use the code \\u6b64 to print that character'
  assert.equal(looksEscapedMessage(s), true)
  assert.equal(normalizeMessageText(s), 'use the code 此 to print that character')
})

test('正文里已经含真实中文、又夹着转义字样时不改动', () => {
  const s = '这段代码里的 \\u6b64 表示「此」'
  assert.equal(normalizeMessageText(s), s)
})

test('decodeMessageEscapes 处理常见单字符转义', () => {
  assert.equal(decodeMessageEscapes('a\\tb\\nc\\\\d\\"e'), 'a\tb\nc\\d"e')
})
