/**
 * 整段会话统计：用合成事件验证折出来的轮次、步数、模型切换和空档归类。
 * 不依赖真实会话日志，样例里的模型名和编号都是虚构的。
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { applyTotals, initTotals, totalsProjection, totalsStateSchema, totalsViewSchema, viewTotals, IDLE_MS, type TotalsEvent, type TotalsState } from '../../src/host/run-status/totals.ts'

const fold = (list: readonly TotalsEvent[], from: TotalsState = initTotals()): TotalsState => list.reduce(applyTotals, from)

describe('整段会话统计', () => {
  it('一轮里中途换模型，当前速度从换后的第一步重新算', () => {
    const step = (n: number, t: number, out: number): TotalsEvent[] => [
      { type: 'step/start', time: t, data: { turn: 1, step: n } },
      { type: 'assistant/message', time: t + 1000, data: { turn: 1, step: n, usage: { outputTokens: out } } },
      { type: 'step/end', time: t + 1000, data: { turn: 1, step: n } },
    ]
    const view = viewTotals(fold([
      { type: 'model/selection', time: 0, data: { provider: 'a', model: 'x' } },
      ...step(1, 0, 100),
      { type: 'model/selection', time: 2000, data: { provider: 'a', model: 'y' } },
      ...step(2, 2000, 30),
    ]))
    assert.deepEqual(view.current, { turn: 1, model: 'a/y', steps: 1, outputTokens: 30, tokenMs: 1000, medianTtftMs: null })
    assert.equal(view.average?.model, 'a/y')
    assert.equal(view.average?.outputTokens, 30)
    assert.equal(view.average?.switched, true)
  })

  it('无关事件原样返回同一个状态', () => {
    const state = fold([
      { type: 'turn/start', time: 0, data: { turn: 1 } },
      { type: 'step/start', time: 0, data: { turn: 1, step: 1 } },
      { type: 'step/end', time: 100, data: { turn: 1, step: 1 } },
      { type: 'turn/end', time: 100, data: { turn: 1 } },
    ])
    assert.equal(applyTotals(state, { type: 'job/registered', time: 1, data: {} }), state)
    assert.equal(applyTotals(state, { type: 'user/message', time: 1, data: { source: { kind: 'time-context' } } }), state)
  })

  it('两轮之间的空档：有人发消息算等你，没人发算等后台通知，超过半小时算离开', () => {
    const turn = (n: number, start: number, end: number, human: boolean): TotalsEvent[] => [
      { type: 'turn/start', time: start, data: { turn: n } },
      { type: 'step/start', time: start, data: { turn: n, step: 1 } },
      { type: 'user/message', time: start, data: { source: { kind: human ? 'user' : 'demo-notice' } } },
      { type: 'step/end', time: end, data: { turn: n, step: 1 } },
      { type: 'turn/end', time: end, data: { turn: n } },
    ]
    const view = viewTotals(fold([
      ...turn(1, 0, 1000, true),
      ...turn(2, 61_000, 62_000, true),
      ...turn(3, 182_000, 183_000, false),
      ...turn(4, 183_000 + IDLE_MS, 184_000 + IDLE_MS, true),
    ]))
    assert.equal(view.runMs, 4000)
  })

  it('状态和视图经 JSON 存取后仍能通过校验；坏数据直接报错', () => {
    const state = JSON.parse(JSON.stringify(fold([
      { type: 'turn/start', time: 0, data: { turn: 1 } },
      { type: 'step/start', time: 0, data: { turn: 1, step: 1 } },
      { type: 'step/end', time: 100, data: { turn: 1, step: 1 } },
      { type: 'turn/end', time: 100, data: { turn: 1 } },
    ]))) as unknown
    assert.doesNotThrow(() => totalsStateSchema.parse(state))
    assert.doesNotThrow(() => totalsViewSchema.parse(JSON.parse(JSON.stringify(viewTotals(state as TotalsState)))))
    assert.throws(() => totalsStateSchema.parse({ ...(state as object), runMs: 'x' }))
    assert.throws(() => totalsViewSchema.parse(null))
    assert.equal(totalsProjection.wire.summary, false)
  })
})
