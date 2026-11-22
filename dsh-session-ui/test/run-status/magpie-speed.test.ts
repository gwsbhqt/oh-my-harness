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
const latest = (fields: Fields) => stats([route(1, fields)]).tps

describe('Magpie 路由页的有效生成时间窗', () => {
  it('采用最早的流式推理信号；隐藏推理起点不明，只算有首段文字计时的答案', () => {
    assert.equal(latest({ out: 200, reasoning: 100, ttft: 2000, firstReasoning: 1500, firstText: 3000, ms: 4000 }), 80)
    assert.equal(latest({ usage: [{ reasoning: 10 }, { reasoning: 100 }], firstText: 2000, ms: 4000 }), 50)
    assert.equal(latest({ reasoningHidden: true, ttft: 1000 }), null)
    assert.equal(latest({ out: null }), null)
    assert.equal(latest({ out: '200' }), null)
    assert.equal(latest({ ttft: null }), null)
  })

  it('保留门限相等的读数，排除计时太短、速率太高、集中送达和推理后突发的回复', () => {
    assert.equal(latest({ out: 1000, ttft: 100, ms: 200 }), 10_000)
    assert.equal(latest({ out: 1001, ttft: 100, ms: 200 }), null)
    assert.equal(latest({ out: 10, ttft: 100, ms: 199 }), null)
    assert.equal(latest({ flow: 500 }), 100)
    assert.equal(latest({ flow: 499 }), null)
    assert.equal(latest({ ttft: 3996, ms: 4995 }), 200)
    assert.equal(latest({ ttft: 3997, ms: 4996 }), null)
    assert.equal(latest({ out: 450, reasoning: 2, firstReasoning: 1500, firstText: 2900 }), null)
  })

  it('答案下限和整次请求下限都不参与平均', () => {
    assert.equal(latest({ out: 250, reasoning: 150, ms: 2000, flow: 250 }), null)
    assert.equal(latest({ out: 1200, ttft: 0, ms: 2000 }), null)
  })
})

describe('Magpie 实时会话分组', () => {
  it('先取全网关最近 60 个不同的路由编号，再严格按 agent 和会话取数', () => {
    const other = Array.from({ length: 60 }, (_, i) => route(i + 1, { session: 'other' }))
    const rows = [route(0), ...other, route(61, { session: 'child', parentSession: session }), route(62, { agent: 'other' })]
    const result = stats(rows.reverse())
    assert.equal(result.tps, 100)
    const old = stats(Array.from({ length: 61 }, (_, i) => route(i, { session: i ? 'other' : session })))
    assert.equal(old.tps, null)
    assert.deepEqual(gatewaySpeedLines(old), [])
  })

  it('只取同一路由最新状态，按有效生成时长加权，单项下限、取消和仍在途都不计入平均', () => {
    const ok = [{ done: true, status: 429, fail: 'retry' }, { done: true, status: 200 }]
    const rows = [route(1, { seq: 7, tries: ok, responseId: 'example-reply' }), route(1, { seq: 3, done: false }),
      route(2, { out: 100, ms: 2000, responseId: 'example-reply' }), route(3, { done: false }),
      route(4, { status: 499, canceled: true }), route(5, { tries: [{ done: true, status: 200, fail: 'incomplete' }] }),
      route(6, { out: 300, reasoning: 150, firstText: 0 }), route(7, { out: 300, ttft: 0 }), route(8, { out: 500, ms: 2000 })]
    const result = stats(rows)
    assert.equal(result.tps, Math.round((200 + 100 + 500) * 1000 / (2000 + 1000 + 1000)))
    assert.equal(result.latestTps, 500)
    assert.deepEqual(gatewaySpeedLines(result).map(({ label, value }) => ({ label, value })), [{ label: '平均输出速度', value: '200 tok/s' }, { label: '首字等待', value: '1.0 秒' }])
  })

  it('首字等待取网关计时中位数，包含测速被排除的成功请求', () => {
    const result = stats([route(1, { ttft: 1200, flow: 1 }), route(2, { ttft: 2400, flow: 1 }),
      route(3, { ttft: 9000, status: 499 }), route(4, { ttft: 8000, done: false })])
    assert.equal(result.tps, null)
    assert.equal(result.latestTps, null)
    assert.equal(result.firstTokenMs, 1800)
    assert.equal(gatewaySpeedLines(result)[0]?.value, '1.8 秒')
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
      return snapshot([route(1)])
    }, () => now)
    const [own, other] = await Promise.all([get(gw, session), get(gw, 'other')])
    assert.deepEqual(own, { state: 'ready', tps: 100, latestTps: 100, firstTokenMs: 1000 })
    assert.deepEqual(other, { state: 'ready', tps: null, latestTps: null, firstTokenMs: null })
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
