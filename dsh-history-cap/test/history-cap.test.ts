import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import {
  DEFAULT_MAX_HISTORY_RECORDS,
  apply,
  capRecords,
  inject,
  patchSessionHistory,
  type FollowFrame,
  type HistoryPage,
  type SessionHistoryService,
} from '../src/index.ts'

function page(count: number, start = 0): HistoryPage & { cursor: number } {
  return {
    cursor: start + count - 1,
    records: Array.from({ length: count }, (_, index) => ({ event: { seq: start + index } })),
    hasMore: start > 0,
  }
}

function seqs(value: HistoryPage): number[] {
  return value.records.map(record => (record as { event: { seq: number } }).event.seq)
}

async function frames(iterable: AsyncIterable<FollowFrame>): Promise<FollowFrame[]> {
  const out: FollowFrame[] = []
  for await (const frame of iterable) out.push(frame)
  return out
}

// 照宿主：一轮里的记录不按条数分页，整轮发出；方法在原型上，网关调用时 this 是服务。
class FakeSessionController extends Service implements SessionHistoryService {
  readonly total: number
  readonly receivers: unknown[] = []
  followClosed = false

  constructor(ctx: Context, total: number) {
    super(ctx, 'sessionController')
    this.total = total
  }

  async page(request: unknown): Promise<HistoryPage> {
    this.receivers.push(this)
    const before = (request as { beforeSeq?: number }).beforeSeq ?? this.total
    return page(before, 0)
  }

  async events(request: unknown): Promise<HistoryPage> {
    return this.page(request)
  }

  async *follow(): AsyncGenerator<FollowFrame> {
    try {
      yield { type: 'snapshot', header: {}, projections: { asOfSeq: this.total - 1 }, ...page(this.total) }
      yield { type: 'event', event: { seq: this.total } }
    } finally {
      this.followClosed = true
    }
  }
}

test('不超过上限时原样返回', () => {
  const original = page(DEFAULT_MAX_HISTORY_RECORDS)
  assert.equal(capRecords(original), original)
})

test('超过上限时保留最新一段并提示还有更早记录，不改原页', () => {
  const original = page(24_000)
  const capped = capRecords(original)
  assert.deepEqual(seqs(capped), Array.from({ length: DEFAULT_MAX_HISTORY_RECORDS }, (_, i) => 24_000 - DEFAULT_MAX_HISTORY_RECORDS + i))
  assert.equal(capped.hasMore, true)
  assert.equal(capped.cursor, 23_999)
  assert.equal(original.records.length, 24_000)
})

const name = 'dsh-history-cap'

async function withPlugin(total: number, run: (root: Context, service: FakeSessionController) => Promise<void>): Promise<void> {
  const root = new Context()
  let service!: FakeSessionController
  const host = root.plugin({ name: 'session', apply: (ctx: Context) => { service = new FakeSessionController(ctx, total) } })
  await host
  const fiber = root.plugin({ name, inject, apply })
  await fiber
  await run(root, service)
  await fiber.dispose()
  await host.dispose()
}

// 照网关：每次调用从带调用信息的上下文现取服务和方法（dsh-api-gateway prepareInvocation）。
function remoteCall<T>(root: Context, method: keyof SessionHistoryService, request: unknown): T {
  const receiver = root.extend({ invocation: { method } } as never).get('sessionController') as unknown as SessionHistoryService
  const fn = Reflect.get(receiver, method) as (...args: unknown[]) => T
  return Reflect.apply(fn, receiver, [request])
}

test('虚构大记录输入：一轮 24000 条，打开会话只发出最新一段，后续增量照常', async () => {
  await withPlugin(24_000, async (root) => {
    const [snapshot, next] = await frames(remoteCall(root, 'follow', {}))
    const opening = snapshot as unknown as HistoryPage & { cursor: number; header: unknown; projections: unknown }
    assert.equal(opening.records.length, DEFAULT_MAX_HISTORY_RECORDS)
    assert.equal(opening.hasMore, true)
    assert.equal(opening.cursor, 23_999)
    assert.deepEqual(opening.projections, { asOfSeq: 23_999 })
    assert.deepEqual(next, { type: 'event', event: { seq: 24_000 } })
  })
})

test('「加载更早」连续翻完整轮：无缺口、无重复', async () => {
  await withPlugin(24_000, async (root) => {
    const seen: number[] = []
    let beforeSeq: number | undefined
    for (let index = 0; ; index++) {
      const result = await remoteCall<Promise<HistoryPage>>(root, index % 2 === 0 ? 'page' : 'events', beforeSeq === undefined ? {} : { beforeSeq })
      const current = seqs(result)
      seen.unshift(...current)
      beforeSeq = current[0]
      if (!result.hasMore) break
    }
    assert.deepEqual(seen, Array.from({ length: 24_000 }, (_, index) => index))
  })
})

test('切走会话时提前结束，原始流也被关闭', async () => {
  await withPlugin(10, async (root, service) => {
    for await (const frame of remoteCall<AsyncIterable<FollowFrame>>(root, 'follow', {})) {
      assert.equal(frame.type, 'snapshot')
      break
    }
    assert.equal(service.followClosed, true)
  })
})

test('卸装后恢复原方法；重复安装不叠层', async () => {
  const root = new Context()
  const service = new FakeSessionController(root, 2000)
  const first = patchSessionHistory(service, 1000)
  first()
  const second = patchSessionHistory(service, 500)
  const again = patchSessionHistory(service, 300)
  assert.equal((await service.page({})).records.length, 300)
  second()
  assert.equal((await service.page({})).records.length, 300, '旧的卸装不能拆掉新装的')
  again()
  assert.equal(Object.hasOwn(service, 'page'), false)
  assert.equal((await service.page({})).records.length, 2000)
})
