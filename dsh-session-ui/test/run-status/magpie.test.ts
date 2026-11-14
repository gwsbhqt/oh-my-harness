import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { LOOKUP_DELAYS, requestsUrl, splitRow, TimingLookup, type MagpieRow, type TimingPatch } from '../../src/host/run-status/magpie.ts'
import { describeRequest, formatSeconds } from '../../src/shared/run-status/format.ts'
import { RunTracker } from '../../src/host/run-status/tracker.ts'

// 虚构的 magpie 请求记录样例（只留用到的字段，编号为虚构值）。
/** 大文件上传：9.6 秒才传完，第 15 秒才第一次收到回音。 */
const BIG_UPLOAD: MagpieRow = { response_id: 'req-upload-0001', ms: 15971, ttft_ms: 15966, sent_ms: 9595 }
/** 失败重试了 52.6 秒的请求。 */
const RETRIED: MagpieRow = { response_id: 'req-retry-0002', ms: 63122, ttft_ms: 59551, sent_ms: 56845, retried_ms: 52640 }
/** 不记 sent_ms 的线路。 */
const CLAUDE: MagpieRow = { response_id: 'req-plain-0003', ms: 6022, ttft_ms: 3392 }

describe('把 magpie 的一行拆成三段', () => {
  it('有上传完的时刻：上传、等首字、返回', () => {
    const t = splitRow(BIG_UPLOAD, 16_000)
    assert.deepEqual(t, { state: 'ok', uploadMs: 9595, firstTokenMs: 6371, returnMs: 5 })
    assert.equal(describeRequest({ responseId: 'x', step: 8, totalMs: 16_000, end: 0, ...t }), '第 8 步：上传 9.6 秒，等首字 6.4 秒，返回 0.0 秒')
  })

  it('失败重试算在上传里并单独说出来', () => {
    const t = splitRow(RETRIED, 63_500)
    assert.equal(t.retriedMs, 52640)
    assert.match(describeRequest({ responseId: 'x', totalMs: 63_500, end: 0, ...t }), /^上传 57 秒（其中失败重试 53 秒），等首字 2\.7 秒，返回 3\.6 秒$/)
  })

  it('Claude 线路只能拆成发出到首字和返回', () => {
    const t = splitRow(CLAUDE, 6100)
    assert.deepEqual(t, { state: 'ok', firstTokenMs: 3392, returnMs: 2630 })
    assert.equal(describeRequest({ responseId: 'x', totalMs: 6100, end: 0, ...t }), '发出到首字 3.4 秒，返回 2.6 秒')
  })

  it('DSH 量到的比 magpie 记的长 1 秒以上，单独记成到 magpie 来回', () => {
    assert.equal(splitRow(BIG_UPLOAD, 17_500).outsideMs, 1529)
    assert.equal(splitRow(BIG_UPLOAD, 16_900).outsideMs, undefined)
  })

  it('没有首字时刻时不编数字', () => {
    const t = splitRow({ response_id: 'x', ms: 900 }, 1000)
    assert.equal(t.firstTokenMs, undefined)
    assert.match(describeRequest({ responseId: 'x', totalMs: 1000, end: 0, ...t }), /拆不开/)
  })

  it('秒数格式', () => {
    assert.equal(formatSeconds(870), '0.9 秒')
    assert.equal(formatSeconds(12_400), '12 秒')
    assert.equal(formatSeconds(75_000), '1 分 15 秒')
  })
})

describe('magpie 地址', () => {
  it('本机 http、别处 https 可以，别处 http 和带账号的不行', () => {
    assert.equal(requestsUrl('http://127.0.0.1:3425/v1').href, 'http://127.0.0.1:3425/v1/magpie/usage/requests?limit=100')
    assert.equal(requestsUrl('https://magpie.example.com/v1/').pathname, '/v1/magpie/usage/requests')
    assert.throws(() => requestsUrl('http://192.168.1.20:3425/v1'))
    assert.throws(() => requestsUrl('https://a:b@example.com/v1'))
  })
})

describe('排队找记录', () => {
  function setup(read: () => Promise<MagpieRow[]>) {
    const done: Array<[string, TimingPatch]> = []
    let reads = 0
    const lookup = new TimingLookup(async () => { reads += 1; return read() }, (item, patch) => done.push([item.responseId, patch]))
    return { lookup, done, reads: () => reads }
  }

  it('到点的几条合并成一次读取，找到就拆好', async () => {
    const { lookup, done, reads } = setup(async () => [CLAUDE, BIG_UPLOAD])
    lookup.add({ session: 's', responseId: BIG_UPLOAD.response_id! }, 16_000, 0)
    lookup.add({ session: 's', responseId: CLAUDE.response_id! }, 6100, 100)
    await lookup.poll(1000)
    assert.equal(reads(), 0)
    await lookup.poll(LOOKUP_DELAYS[0] + 100)
    assert.equal(reads(), 1)
    assert.deepEqual(done.map(([id, p]) => [id, p.state, p.uploadMs]), [[BIG_UPLOAD.response_id, 'ok', 9595], [CLAUDE.response_id, 'ok', undefined]])
    assert.equal(lookup.nextAt(), undefined)
  })

  it('一直找不到就记成找不到；读不到 magpie 就记原因', async () => {
    for (const [read, state] of [[async () => [CLAUDE], 'missing'], [async () => { throw new Error('magpie 返回 HTTP 401，网关钥匙不对') }, 'error']] as const) {
      const { lookup, done, reads } = setup(read as () => Promise<MagpieRow[]>)
      lookup.add({ session: 's', responseId: 'gone' }, 1000, 0)
      let now = 0
      while (lookup.nextAt() !== undefined) {
        now = lookup.nextAt()!
        await lookup.poll(now)
      }
      assert.equal(reads(), LOOKUP_DELAYS.length)
      assert.equal(done[0]?.[1].state, state)
      if (state === 'error') assert.match(done[0]![1].note!, /401/)
    }
  })

  it('清理后迟到的旧查询不能覆盖重新排队的请求', async () => {
    let finish: (rows: MagpieRow[]) => void = () => {}
    const { lookup, done } = setup(() => new Promise(resolve => { finish = resolve }))
    lookup.add({ session: 's', responseId: CLAUDE.response_id! }, 1000, 0)
    const old = lookup.poll(LOOKUP_DELAYS[0])
    lookup.forget('s')
    lookup.add({ session: 's', responseId: CLAUDE.response_id! }, 2000, 2000)
    finish([CLAUDE])
    await old
    assert.deepEqual(done, [])
    assert.equal(lookup.nextAt(), 2000 + LOOKUP_DELAYS[0])
  })
})

describe('记录每次请求', () => {
  const message = (provider: string, responseId: string) => ({ turn: 1, step: 3, message: { source: { provider, model: 'demo/probe-model', replayState: { response: { responseId } } } } })

  it('模型流开始到回复写进日志算总时长，补上 magpie 的分段后快照里能看到', () => {
    const t = new RunTracker()
    t.event('s', { type: 'turn/start', time: 0, data: { turn: 1 } })
    t.stream('s', { type: 'start', turn: 1, step: 3 }, 1000)
    const added = t.event('s', { type: 'assistant/message', time: 17_000, data: message('magpie', BIG_UPLOAD.response_id!) })
    assert.deepEqual(added, { responseId: BIG_UPLOAD.response_id, step: 3, model: 'demo/probe-model', totalMs: 16_000, end: 17_000, state: 'pending' })
    t.resolveRequest('s', BIG_UPLOAD.response_id!, splitRow(BIG_UPLOAD, 16_000))
    const r = t.snapshot('s', 17_500).requests?.[0]
    assert.equal(r?.state, 'ok')
    assert.equal(r?.uploadMs, 9595)
    assert.equal(r?.step, 3)
  })

  it('不走 magpie 的不记，也不会拿上一次的开始时间算', () => {
    const t = new RunTracker()
    t.stream('s', { type: 'start', turn: 1, step: 1 }, 0)
    assert.equal(t.event('s', { type: 'assistant/message', time: 5000, data: message('deepseek', 'a') }), undefined)
    assert.equal(t.event('s', { type: 'assistant/message', time: 9000, data: message('magpie-responses', 'b') }), undefined)
    t.stream('s', { type: 'start', turn: 1, step: 2 }, 10_000)
    assert.equal(t.event('s', { type: 'assistant/message', time: 12_000, data: message('magpie-responses', 'c') })?.totalMs, 2000)
  })
})
