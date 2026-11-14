import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { recentRequestLines } from '../../src/shared/run-status/format.ts'
import type { RequestTiming } from '../../src/shared/run-status/types.ts'

/** 虚构的两次成功请求：一次记上传，一次不记上传；编号、模型、数字都是编的。 */
const OK_WITH_UPLOAD: RequestTiming = {
  responseId: 'req-fake-0001', step: 8, model: 'example-model', totalMs: 16_000, end: 16_000, state: 'ok',
  uploadMs: 9595, firstTokenMs: 6371, returnMs: 5,
}
const OK_NO_UPLOAD: RequestTiming = {
  responseId: 'req-fake-0002', step: 9, model: 'example-model', totalMs: 6100, end: 21_000, state: 'ok',
  firstTokenMs: 3392, returnMs: 2630,
}

describe('统计卡的最近请求分段行', () => {
  it('有真实请求时，每个请求一行，右边是上传/等首字/返回这些真数字', () => {
    const lines = recentRequestLines([OK_WITH_UPLOAD, OK_NO_UPLOAD])
    assert.equal(lines.length, 2)
    assert.equal(lines[0]!.label, '第 8 步')
    assert.match(lines[0]!.value, /上传 9\.6 秒/)
    assert.match(lines[0]!.value, /等首字 6\.4 秒/)
    assert.match(lines[0]!.value, /返回 0\.0 秒/)
    assert.match(lines[0]!.title, /整次 16秒/)
    assert.equal(lines[1]!.label, '第 9 步')
    assert.match(lines[1]!.value, /发出到首字 3\.4 秒/)
  })

  it('还在等 magpie 记录时也先占一行，说清正在等', () => {
    const pending: RequestTiming = { responseId: 'req-fake-0003', totalMs: 1000, end: 1000, state: 'pending' }
    const lines = recentRequestLines([pending])
    assert.equal(lines.length, 1)
    assert.equal(lines[0]!.label, '最近请求 1')
    assert.match(lines[0]!.value, /正在向 magpie 要各段用时/)
  })

  it('网关没配、requests 为空或没有这个字段时完全不显示这一区', () => {
    assert.deepEqual(recentRequestLines(undefined), [])
    assert.deepEqual(recentRequestLines([]), [])
  })
})
