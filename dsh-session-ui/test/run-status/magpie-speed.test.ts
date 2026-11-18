import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { gatewaySpeeds, sessionSpeed, traceWindow } from '../../src/host/run-status/magpie-speed.ts'
import { gatewaySpeedLines } from '../../src/shared/run-status/format.ts'

type Fields = Record<string, unknown>
const session = 'example-session'
const route = (id: number, fields: Fields = {}) => ({ id, agent: 'dsh', session, done: true, status: 200, out: 200, ttft: 1000, ms: 3000, ...fields })
const snapshot = (routes: ReturnType<typeof route>[]) => ({ object: 'trace', ids: routes.map(r => r.id), routes })
function stats(routes: ReturnType<typeof route>[]) {
  const stats = sessionSpeed(traceWindow(snapshot(routes)), session)
  assert.ok(stats.state === 'ready')
  return stats
}
const latest = (fields: Fields) => stats([route(1, fields)]).recent[0]!

describe('Magpie 路由页的有效生成时间窗', () => {
  it('采用最早的流式推理信号；隐藏推理起点不明，只算有首段文字计时的答案', () => {
    assert.equal(latest({ out: 200, reasoning: 100, ttft: 2000, firstReasoning: 1500, firstText: 3000, ms: 4000 }).tps, 80)
    assert.equal(latest({ usage: [{ reasoning: 10 }, { reasoning: 100 }], firstText: 2000, ms: 4000 }).tps, 50)
    assert.equal(latest({ reasoningHidden: true, ttft: 1000 }).kind, 'unmeasured')
    assert.equal(latest({ out: null }).kind, 'unmeasured')
    assert.equal(latest({ out: '200' }).kind, 'unmeasured')
    assert.equal(latest({ ttft: null }).kind, 'unmeasured')
  })

  it('保留门限相等的读数，排除计时太短、速率太高、集中送达和推理后突发的回复', () => {
    assert.equal(latest({ out: 1000, ttft: 100, ms: 200 }).tps, 10_000)
    assert.equal(latest({ out: 1001, ttft: 100, ms: 200 }).kind, 'unmeasured')
    assert.equal(latest({ out: 10, ttft: 100, ms: 199 }).kind, 'unmeasured')
    assert.equal(latest({ flow: 500 }).tps, 100)
    assert.equal(latest({ flow: 499 }).kind, 'unmeasured')
    assert.equal(latest({ ttft: 3996, ms: 4995 }).kind, 'measured')
    assert.equal(latest({ ttft: 3997, ms: 4996 }).kind, 'unmeasured')
    assert.equal(latest({ out: 450, reasoning: 2, firstReasoning: 1500, firstText: 2900 }).kind, 'unmeasured')
  })

  it('答案下限和整次请求下限都保留 ≥，没有可靠下限的请求不给速度', () => {
    assert.deepEqual(latest({ out: 250, reasoning: 150, ms: 2000, flow: 250 }), { kind: 'floor', time: null, tps: 100 })
    assert.equal(latest({ out: 250, reasoning: 150, ms: 2000, flow: 249 }).kind, 'unmeasured')
    assert.deepEqual(latest({ out: 1200, ttft: 0, ms: 2000 }), { kind: 'floor', time: null, tps: 600 })
    assert.equal(latest({ out: 999, ttft: 0, ms: 2000 }).kind, 'unmeasured')
    assert.equal(stats([route(1, { ttft: 0, out: 1200 })]).tps, null)
  })
})

describe('Magpie 实时会话分组', () => {
  it('先取全网关最近 60 个不同的路由编号，再严格按 agent 和会话取数', () => {
    const other = Array.from({ length: 60 }, (_, i) => route(i + 1, { session: 'other' }))
    const rows = [route(0), ...other, route(61, { session: 'child', parentSession: session }), route(62, { agent: 'other' })]
    const result = stats(rows.reverse())
    assert.deepEqual([result.windowSize, result.requests, result.completed, result.measured, result.tps], [60, 1, 1, 1, 100])
    const old = stats(Array.from({ length: 61 }, (_, i) => route(i, { session: i ? 'other' : session })))
    assert.equal(old.requests, 0)
    assert.equal(old.tps, null)
    assert.match(gatewaySpeedLines(old)[0]!.value, /网关最近 60 次里没有本会话/)
  })

  it('只取同一路由最新状态，按有效生成时长加权，单项下限、取消和仍在途都不计入平均', () => {
    const ok = [{ done: true, status: 429, fail: 'retry' }, { done: true, status: 200 }]
    const rows = [route(1, { seq: 7, tries: ok, responseId: 'example-reply' }), route(1, { seq: 3, done: false }),
      route(2, { out: 100, ms: 2000, responseId: 'example-reply' }), route(3, { done: false }),
      route(4, { status: 499, canceled: true }), route(5, { tries: [{ done: true, status: 200, fail: 'incomplete' }] }),
      route(6, { out: 300, reasoning: 150, firstText: 0 }), route(7, { out: 300, ttft: 0 }), route(8, { out: 500, ms: 2000 })]
    const result = stats(rows)
    assert.deepEqual([result.requests, result.completed, result.measured, result.floors], [8, 7, 3, 1])
    assert.equal(result.tps, Math.round((200 + 100 + 500) * 1000 / (2000 + 1000 + 1000)))
    assert.deepEqual(result.recent.map(r => r.kind), ['measured', 'unmeasured', 'floor'])
    assert.match(gatewaySpeedLines(result).at(-1)!.value, /500 tok\/s · 未测速 · ≥75 tok\/s/)
  })

  it('快照缺少窗口或窗口中缺行时不能给出部分平均', () => {
    assert.throws(() => traceWindow({ object: 'trace', routes: [] }), /窗口/)
    assert.throws(() => traceWindow({ object: 'trace', ids: [1, 2], routes: [route(1)] }), /缺行/)
  })

  it('多个会话共用读取，停止上报或断网时清掉旧的速率，恢复后重新读取', async () => {
    const gw = { magpieBaseUrl: 'https://magpie.example.com/v1', magpieKeyRef: 'EXAMPLE_KEY' }
    let calls = 0, now = 0, offline = false
    const get = gatewaySpeeds(async () => {
      calls++
      if (offline) throw new Error('offline')
      return snapshot([route(1, { time: '2000-01-01T00:00:00Z' })])
    }, () => now)
    const [own, other] = await Promise.all([get(gw, session), get(gw, 'other')])
    assert.ok(own.state === 'ready' && own.tps === 100 && own.recent[0]?.time === Date.UTC(2000, 0, 1))
    assert.ok(other.state === 'ready' && other.requests === 0)
    assert.equal(calls, 1)
    now += 5000
    offline = true
    assert.deepEqual(await get(gw, session), { state: 'unavailable' })
    assert.match(gatewaySpeedLines(await get(gw, session))[0]!.value, /暂时读不到/)
    assert.equal(calls, 2)
    assert.deepEqual(gatewaySpeedLines(await get(undefined, session)), [])
    offline = false
    assert.equal((await get(gw, session)).state, 'ready')
    assert.equal(calls, 3)
  })
})
