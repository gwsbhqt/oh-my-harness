import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import { decodeBody, parseAnswers } from '../src/jev.ts'

test('parseAnswers 取出每道题的概率', () => {
  assert.deepEqual(parseAnswers('{"answers":{"junk":{"noul":0.82}}}', ['junk']), { junk: 0.82 })
})

test('parseAnswers 缺答案/非法 JSON 要报错', () => {
  assert.throws(() => parseAnswers('{"answers":{}}', ['junk']))
  assert.throws(() => parseAnswers('not json', ['junk']))
})

test('decodeBody 按魔数解 gzip', () => {
  const raw = new TextEncoder().encode('{"answers":{"junk":{"noul":0.5}}}')
  const gz = new Uint8Array(gzipSync(raw))
  assert.deepEqual(new TextDecoder().decode(decodeBody(gz)), new TextDecoder().decode(raw))
})
