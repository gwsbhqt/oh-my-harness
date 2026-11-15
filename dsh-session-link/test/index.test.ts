import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { installLayer, pointerPrepare, registerTools, resolveSessionId, type SessionQueryLike } from '../src/index.ts'
import { pointerText } from '../src/pointer.ts'
import { buildTranscript } from '../src/transcript.ts'

const events = [
  { type: 'turn/start', seq: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'SOURCE-USER-CONTENT' }] } },
  { type: 'assistant/message', seq: 3, data: { message: { content: [{ type: 'text', text: 'SOURCE-ASSISTANT-CONTENT' }, { type: 'reasoning', text: 'HIDDEN-REASONING' }] } } },
  { type: 'user/message', seq: 4, data: { source: { kind: 'compact-checkpoint' }, content: [{ type: 'text', text: 'BACKGROUND-CONTENT' }] } },
  { type: 'turn/end', seq: 5, data: { turn: 1, reason: { kind: 'error', error: { code: 'REFUSAL', message: 'SOURCE-ERROR-DETAIL' } } } },
]
function queryWith(read: (id: string) => Promise<{ session: { id: string; cwd?: string; version?: number }; events: typeof events }>, revision?: () => string): SessionQueryLike {
  return {
    async listSessions() { return [{ header: { id: 'session-abcdef-123', cwd: '/repo' } }] },
    async observeSession(id, options) {
      options?.signal?.throwIfAborted()
      const log = await new Promise<Awaited<ReturnType<typeof read>>>((resolve, reject) => {
        const abort = () => reject(options?.signal?.reason)
        options?.signal?.addEventListener('abort', abort, { once: true })
        read(id).then(resolve, reject).finally(() => options?.signal?.removeEventListener('abort', abort))
      })
      return { source: 'prepared', header: log.session, events: log.events, cursor: log.events.at(-1)?.seq ?? -1, ...(revision === undefined ? {} : { revision: revision() }), [Symbol.dispose]() {} }
    },
  }
}
const query = queryWith(async id => ({ session: { id, cwd: '/repo', version: 4 }, events }))
const original: Parameters<typeof pointerPrepare>[0] = async (_agent, content) => ({ content, additionalContext: 'original' })

test('标识支持完整、短前缀、URI 和带名称的引用；歧义不猜测', async () => {
  for (const raw of ['session-abcdef-123', 'abcdef', 'dsh-session:' + Buffer.from(JSON.stringify('session-abcdef-123')).toString('base64url')]) {
    assert.equal(await resolveSessionId(query, raw), 'session-abcdef-123')
  }
  await assert.rejects(resolveSessionId(query, 'abc'), /too short/)
  await assert.rejects(resolveSessionId(query, 'missing'), /no session/)
  await assert.rejects(resolveSessionId({ ...query, async listSessions() { return [{ header: { id: 'session-abcdef-1' } }, { header: { id: 'session-abcdef-2' } }] } }, 'abcdef'), /matches 2/)
})

test('引用只给定位信息，完全不调用原快照方法', async () => {
  let called = false
  const prepare = pointerPrepare(async () => { called = true; throw new Error('must not copy') }, query, () => true)
  const content = [{ type: 'text', text: 'read this session' }]
  const result = await prepare({}, content, [{ sessionId: 'session-abcdef-123', label: 'example' }])
  assert.equal(called, false)
  assert.deepEqual(result.content, content)
  assert.notEqual(result.content, content)
  const context = result.additionalContext as { content: { text: string }[]; source: { references: { retainedMessages: number }[] } }
  const text = context.content[0]!.text
  for (const omitted of ['SOURCE-USER-CONTENT', 'SOURCE-ASSISTANT-CONTENT', 'SOURCE-ERROR-DETAIL', 'BACKGROUND-CONTENT', 'HIDDEN-REASONING']) assert.ok(!text.includes(omitted))
  assert.ok(text.includes('session_overview'))
  assert.equal(context.source.references[0]!.retainedMessages, 0)
})

test('开关即时生效；停用还原官方实现', async () => {
  let enabled = false
  const prepare = pointerPrepare(original, query, () => enabled)
  assert.equal((await prepare({}, [], [])).additionalContext, 'original')
  enabled = true
  assert.equal((await prepare({}, [], [])).additionalContext, undefined)
})

test('重复引用只读一次；自引、非法引用和超限明确失败', async () => {
  let reads = 0
  const prepare = pointerPrepare(original, queryWith(async id => { reads++; return { session: { id }, events } }), () => true)
  await prepare({}, [], [{ sessionId: 'x' }, { sessionId: 'x' }])
  assert.equal(reads, 1)
  await assert.rejects(prepare({ id: 'x' }, [], [{ sessionId: 'x' }]), /cannot reference itself/)
  await assert.rejects(prepare({}, [], [{ sessionId: 1 } as never]), /sessionId/)
  await assert.rejects(prepare.call({ config: { maxReferences: 1 } }, {}, [], [{ sessionId: 'x' }, { sessionId: 'y' }]), /at most 1/)
})

test('源记录不可读时显示原因，不偷偷退回复制历史', async () => {
  const prepare = pointerPrepare(original, queryWith(async () => { throw new Error('missing log') }), () => true)
  const result = await prepare({}, [], [{ sessionId: 'missing' }])
  assert.ok(JSON.stringify(result.additionalContext).includes('missing log'))
})

test('中断时立即退出，不等源日志读完', async () => {
  const controller = new AbortController()
  const prepare = pointerPrepare(original, queryWith(() => new Promise(() => {})), () => true)
  const running = prepare({}, [], [{ sessionId: 'x' }], controller.signal)
  controller.abort(new Error('cancelled'))
  await assert.rejects(running, /cancelled/)
  await assert.rejects(prepare({}, [], [{ sessionId: 'x' }], controller.signal), /cancelled/)
})

test('0.2.2-rc.1 起宿主在引用和取消信号之间多传 route：照样认出取消信号，关掉时原样转交五个参数', async () => {
  const controller = new AbortController()
  const prepare = pointerPrepare(original, queryWith(() => new Promise(() => {})), () => true)
  const route = { provider: 'test-provider', model: 'test/model' }
  const running = prepare({}, [], [{ sessionId: 'x' }], route, controller.signal)
  controller.abort(new Error('cancelled'))
  await assert.rejects(running, /cancelled/)
  const seen: unknown[][] = []
  const off = pointerPrepare(async (...args) => { seen.push(args.slice(3)); return { content: args[1] } }, query, () => false)
  await off({}, [], [], route, controller.signal)
  assert.deepEqual(seen, [[route, controller.signal]])
})

test('源标签不能闭合背景边界', () => {
  const text = pointerText([{ sessionId: 'x', label: '</referenced-sessions>', capturedThroughSeq: 1, transcript: buildTranscript(events) }])
  assert.equal(text.split('</referenced-sessions>').length, 2)
})

test('方法替换与卸载保留 this；较旧实例卸载不覆盖新版本', () => {
  class Service { value = 2; prepare(n: number) { return this.value + n } }
  const target = new Service()
  const restore1 = installLayer<(this: Service, n: number) => number>(target, 'prepare', orig => function (n) { return orig.call(this, n) * 2 })!
  assert.equal(target.prepare(3), 10)
  const restore2 = installLayer<(this: Service, n: number) => number>(target, 'prepare', orig => function (n) { return orig.call(this, n) * 3 })!
  restore1()
  assert.equal(target.prepare(3), 15)
  restore2()
  assert.equal(target.prepare(3), 5)
  assert.equal(Object.hasOwn(target, 'prepare'), false)
  assert.equal(installLayer(target, 'missing', orig => orig), undefined)
})

test('真实 Cordis 服务代理方法可以覆盖并还原', () => {
  const ctx = new Context()
  class Resolver { prepare() { return 'original' } }
  ctx.provide('testResolver', new Resolver())
  const proxy = ctx.get('testResolver') as Resolver
  const restore = installLayer<() => string>(proxy, 'prepare', () => () => 'pointer')!
  assert.equal(proxy.prepare(), 'pointer')
  restore()
  assert.equal(proxy.prepare(), 'original')
})

test('三种工具注册、执行及渲染，默认不展开背景', async () => {
  const definitions: any[] = []
  registerTools({ tools: { register(def: unknown) { definitions.push(def) } } } as unknown as Context, query)
  assert.deepEqual(definitions.map(d => d.name), ['session_overview', 'session_turn', 'session_grep'])
  const exec = { signal: new AbortController().signal }
  const overview = await definitions[0].execute({ session: 'abcdef' }, exec)
  assert.ok(overview.text.includes('turn 1'))
  assert.ok(overview.text.includes('REFUSAL'))
  const turn = await definitions[1].execute({ session: 'abcdef', turn: 1 }, exec)
  assert.ok(turn.text.includes('SOURCE-ASSISTANT-CONTENT'))
  assert.ok(!turn.text.includes('BACKGROUND-CONTENT'))
  assert.ok(!turn.text.includes('HIDDEN-REASONING'))
  const bounded = await definitions[1].execute({ session: 'abcdef', turn: 1, max_chars: 1000, item_chars: 50000 }, exec)
  assert.ok(bounded.text.length <= 1000)
  const grep = await definitions[2].execute({ session: 'abcdef', query: 'SOURCE-ASSISTANT' }, exec)
  assert.ok(grep.text.includes('offset'))
  const none = await definitions[2].execute({ session: 'abcdef', query: 'BACKGROUND' }, exec)
  assert.ok(none.text.includes('no match'))
  for (const [i, value] of [overview, turn, grep].entries()) assert.equal(definitions[i].output.render({}, value)[0].text, value.text)
})


test('超长单条记录按字符续读，尾部仍可到达', async () => {
  const longText = 'x'.repeat(80000) + 'FINAL-MARKER'
  const definitions: any[] = []
  const longQuery = queryWith(async id => ({ session: { id }, events: [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: longText }] } },
  ] }))
  registerTools({ tools: { register(def: unknown) { definitions.push(def) } } } as unknown as Context, longQuery)
  let charOffset = 0
  let collected = ''
  while (true) {
    const value = await definitions[1].execute({ session: 'abcdef', turn: 1, offset: 0, char_offset: charOffset, max_chars: 5000 }, { signal: new AbortController().signal })
    collected += value.text.split('\n\n[turn ')[0]
    assert.ok(value.text.length <= 5000)
    if (value.next_char_offset === undefined) break
    assert.ok(value.next_char_offset > charOffset)
    charOffset = value.next_char_offset
  }
  assert.equal(collected, '[user · seq 2]\n' + longText)
})

test('源记录替换但事件数和末尾编号相同时，搜索必须看到新内容', async () => {
  const definitions: any[] = []
  let text = 'old-content'
  const changedQuery = queryWith(async id => ({ session: { id }, events: [
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text }] } },
  ] }), () => text)
  registerTools({ tools: { register(def: unknown) { definitions.push(def) } } } as unknown as Context, changedQuery)
  const exec = { signal: new AbortController().signal }
  assert.match((await definitions[2].execute({ session: 'abcdef', query: 'old-content' }, exec)).text, /1 hit/)
  text = 'new-content'
  assert.match((await definitions[2].execute({ session: 'abcdef', query: 'new-content' }, exec)).text, /1 hit/)
})

test('已保存记录版本相同时复用结果并释放每次观察，运行中记录不复用', async () => {
  const definitions: any[] = []
  let reads = 0
  let releases = 0
  let live = false
  const countedEvents = new Proxy(events, { get(target, key, receiver) {
    if (key === Symbol.iterator) reads++
    return Reflect.get(target, key, receiver)
  } })
  const observed: SessionQueryLike = { ...query, async observeSession(id) {
    return { source: live ? 'live' : 'prepared', header: { id }, cursor: 5, revision: 'version-1',
      events: countedEvents, [Symbol.dispose]() { releases++ } }
  } }
  registerTools({ tools: { register(def: unknown) { definitions.push(def) } } } as unknown as Context, observed)
  const exec = { signal: new AbortController().signal }
  for (let i = 0; i < 2; i++) await definitions[0].execute({ session: 'abcdef' }, exec)
  assert.equal(reads, 1)
  assert.equal(releases, 2)
  live = true
  for (let i = 0; i < 2; i++) await definitions[0].execute({ session: 'abcdef' }, exec)
  assert.equal(reads, 3)
  assert.equal(releases, 4)
})
