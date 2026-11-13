import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { Context, Service } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import * as plugin from '../src/index.ts'

process.env['DSH_HOME'] = mkdtempSync(join(tmpdir(), 'compaction-bound-'))
import { COMPACTION_PACKAGE, injectedRetain, withRetain, withoutRetain, type PresetDefinition, type PresetGeneration, type PresetRecord } from '../src/retain.ts'
import { CHECKPOINT_KIND, HEADING, OPEN_TAG, STOCK_PREFIX, SUMMARY_CLOSE, attachmentText, boundedInstruction, carriedFromCheckpoint, checkOutput, collectUserMessages, parseAttachment, rejectCondensed, rewriteRequest, type UserMessage, HEAD_CHARS, boundItems, itemLine, placesById, turnSpan, type Item } from '../src/summary.ts'

const fulls = (texts: readonly UserMessage[]): Item[] => texts.map((text) => ({ kind: 'full', turn: null, text }))

/** 照官方 PTC 模式（dsh-web-app/presets/ptc.patch.yml）的压缩组写。 */
const ptcRows = () => [
  { id: 'persona', name: '@deepseek-ai/dsh-persona' },
  {
    id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true, toolResultPruner: true },
    config: [
      { id: 'compaction-basic', name: COMPACTION_PACKAGE },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner', config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } },
    ],
  },
]

const compactionRow = (rows: readonly unknown[]) => ((rows[1] as { config: unknown[] }).config[0]) as { config?: Record<string, unknown> }

test('只给压缩引擎那一行补保留量，其余行保持原对象，撤回后和原来一样', () => {
  const rows = ptcRows()
  const out = withRetain(rows, 12000)!
  assert.equal(out[0], rows[0])
  assert.deepEqual(compactionRow(out).config, { retainTokens: 12000 })
  const group = out[1] as { config: unknown[]; isolate: unknown }
  assert.deepEqual(group.isolate, rows[1]!.isolate)
  assert.equal(group.config[1], (rows[1] as { config: unknown[] }).config[1])
  assert.equal(injectedRetain(out), 12000)
  assert.equal(withRetain(out, 12000), undefined, '改过的不再改')
  assert.deepEqual(withoutRetain(out), rows)
  assert.equal(withoutRetain(rows), undefined)
})

test('行里已写保留量（retainTokens 或 retainRatio）的不动，其他配置键原样保留', () => {
  const rows = ptcRows()
  ;(rows[1] as { config: Array<Record<string, unknown>> }).config[0]!['config'] = { retainRatio: 0.1 }
  assert.equal(withRetain(rows, 12000), undefined)
  const rows2 = ptcRows()
  ;(rows2[1] as { config: Array<Record<string, unknown>> }).config[0]!['config'] = { headroomTokens: 50000 }
  assert.deepEqual(compactionRow(withRetain(rows2, 12000)!).config, { headroomTokens: 50000, retainTokens: 12000 })
})

test('补上的配置能过宿主压缩引擎自己的 schema', () => {
  const Config = (BasicCompactionEngine as unknown as { Config: (value: unknown) => Record<string, unknown> }).Config
  const parsed = Config(compactionRow(withRetain(ptcRows(), 12000)!).config)
  assert.equal(parsed['retainTokens'], 12000)
  assert.equal(parsed['retainRatio'], undefined)
})

test('宿主压缩指令的开头和本插件认的一致（DSH 改了措辞这条先红）', () => {
  const require = createRequire(import.meta.url)
  const source = readFileSync(require.resolve('@deepseek-ai/dsh-compaction-basic'), 'utf8')
  assert.ok(source.includes(`"${STOCK_PREFIX}`), '宿主 COMPACTION_INSTRUCTION 不再以这句开头')
  assert.ok(source.includes('purpose: "compaction"'), '宿主写摘要请求不再带 purpose: compaction')
})

const stockRequest = () => ({
  provider: 'example-provider', model: 'example-model', purpose: 'compaction',
  messages: [
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '把超时改成 90 秒' }] },
    Object.freeze({ role: 'user', content: Object.freeze([Object.freeze({ type: 'text', text: `${STOCK_PREFIX} for this AI coding assistant.` })]) }),
  ],
})

test('只换写摘要请求的最后一条指令，前面的消息保持原对象', () => {
  const options = stockRequest()
  const first = options.messages[0]
  assert.equal(rewriteRequest(options, 12000), 'replaced')
  assert.equal(options.messages[0], first)
  const text = ((options.messages[1] as { content: Array<{ text: string }> }).content[0]!).text
  assert.ok(text.includes('under 12000 characters'))
  assert.ok(text.includes('Active User Requirements'))
  assert.ok(text.includes('<user-messages>'))
  assert.equal(rewriteRequest({ purpose: 'main', messages: [] }, 12000), 'skipped')
  assert.equal(rewriteRequest({ purpose: 'compaction', messages: [{ role: 'user', content: [{ type: 'text', text: 'other' }] }] }, 12000), 'unrecognized')
  assert.equal(rewriteRequest(Object.freeze(stockRequest()), 12000), 'unrecognized', '冻结的请求不改')
})

test('各栏上限加起来不超过总上限', () => {
  for (const budget of [6000, 12000, 20000]) {
    const caps = [...boundedInstruction(budget).matchAll(/at most (\d+) characters/g)].map((m) => Number(m[1]))
    assert.equal(caps.length, 7)
    assert.ok(caps.reduce((a, b) => a + b, 0) <= budget * 1.01, `${budget}: ${caps}`)
  }
})

/** 和宿主模式注册表同形状：definitions、register、activate、collect。 */
class Registry extends Service {
  definitions = new Map<string, PresetRecord>()
  activations = 0
  collected: PresetGeneration[] = []
  constructor(ctx: Context) { super(ctx, 'agentPresets') }
  async register(definition: PresetDefinition) {
    const record: PresetRecord = { config: definition, ready: Promise.resolve() }
    this.definitions.set(definition.id, record)
    record.ready = this.activate(record)
    await record.ready
    return async () => { this.definitions.delete(definition.id) }
  }
  async activate(record: PresetRecord) {
    this.activations++
    // 照宿主：按行挂载，压缩引擎那一行的生效配置是它自己的 schema 解析后的值
    const Config = (BasicCompactionEngine as unknown as { Config: (value: unknown) => unknown }).Config
    const flat = (rows: readonly unknown[]): Array<{ options: Record<string, unknown>; fiber?: { state: number; effectiveConfig: unknown } }> => rows.flatMap((row) => {
      const r = row as Record<string, unknown>
      if (r['group'] === true && Array.isArray(r['config'])) return [{ options: r }, ...flat(r['config'])]
      return [{ options: r, fiber: { state: 2, effectiveConfig: r['name'] === COMPACTION_PACKAGE ? Config(r['config'] ?? {}) : r['config'] } }]
    })
    const entries = flat(record.config.plugins)
    record.generation = { users: 0, retired: false, mount: { tree: { entries: () => entries } } }
  }
  async collect(generation: PresetGeneration) { this.collected.push(generation) }
}

/** 照宿主 LlmRuntime.stream：经 `llm/stream` 瀑布，最内层读同一个 options。 */
class Llm extends Service {
  seen: string[] = []
  constructor(ctx: Context) { super(ctx, 'llm') }
  stream(options: { messages: Array<{ content: Array<{ text: string }> }> }): AsyncIterable<unknown> {
    return this.ctx.waterfall(this, 'llm/stream' as never, options as never, (() => {
      this.seen.push(options.messages.at(-1)!.content[0]!.text)
      return modelOutput('## Goal and Status\n- done', { kind: 'stop' })
    }) as never) as never
  }
}

async function* modelOutput(text: string, reason: { kind: string }): AsyncGenerator<unknown> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } }
  yield { type: 'finish', reason }
}

/** 照宿主 BlockAssembler：各块以 block-end 为准，按出现顺序。 */
async function assemble(stream: AsyncIterable<unknown>): Promise<{ text: string; blocks: string[]; last: string }> {
  const blocks = new Map<number, string>()
  let last = ''
  for await (const raw of stream) {
    const c = raw as { type: string; index?: number; text?: string; block?: { text: string } }
    if (c.type === 'text-delta' && !blocks.has(c.index!)) blocks.set(c.index!, '')
    if (c.type === 'block-end') blocks.set(c.index!, c.block!.text)
    last = c.type
  }
  return { text: [...blocks.values()].join(''), blocks: [...blocks.values()], last }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

test('按宿主方式加载：已注册和后注册的模式都补上，写摘要换指令；卸下后都回原样，两轮都干净', async () => {
  const ctx = new Context()
  const registry = new Registry(ctx)
  const llm = new Llm(ctx)
  await settle()
  await registry.register({ id: 'ptc', plugins: ptcRows() })
  const ptc = () => registry.definitions.get('ptc')!

  for (let round = 0; round < 2; round++) {
    const fiber = ctx.plugin(plugin as never, { retainTokens: 12000 } as never)
    await settle()
    await ptc().ready
    assert.equal(injectedRetain(ptc().config.plugins), 12000, `第 ${round + 1} 轮：已注册的模式补上`)
    assert.ok(ptc().generation !== undefined && ptc().broken === undefined)
    if (round === 0) await registry.register({ id: 'agent', plugins: ptcRows() })
    assert.equal(injectedRetain(registry.definitions.get('agent')!.config.plugins), 12000, '后注册的模式挂载前补上')
    await settle()
    const status = JSON.parse(readFileSync(plugin.statusPath(), 'utf8')) as { mounted: Array<{ preset: string; rows: Array<{ retainTokens: number }> }> }
    assert.deepEqual(status.mounted.map((m) => [m.preset, m.rows.map((r) => r.retainTokens)]), [['ptc', [12000]], ['agent', [12000]]], '状态文件记的是挂载后解析出的值')

    const out = await assemble(llm.stream(stockRequest() as never))
    assert.ok(llm.seen.at(-1)!.includes('Active User Requirements'), '写摘要请求换成有界指令')
    assert.ok(out.text.startsWith('## Goal and Status'), '模型写的部分在前')
    assert.deepEqual(parseAttachment(out.blocks.at(-1)!), fulls([['把超时改成 90 秒']]), '用户原话逐字附在后面、自成一块')
    assert.equal(out.last, 'finish', '结束块仍在最后')
    llm.stream({ purpose: 'main', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] } as never)
    assert.equal(llm.seen.at(-1), 'hi', '别的请求不动')

    await fiber.dispose()
    await settle()
    await ptc().ready
    assert.equal(injectedRetain(ptc().config.plugins), undefined, '卸下后撤掉保留量')
    assert.deepEqual(ptc().config.plugins, ptcRows())
    assert.equal(Object.hasOwn(registry, 'register'), false, '卸下后注册表上不留包装')
    const plain = await assemble(llm.stream(stockRequest() as never))
    assert.ok(llm.seen.at(-1)!.startsWith(STOCK_PREFIX), '卸下后写摘要照宿主原样')
    assert.equal(plain.blocks.length, 1, '卸下后不附原话')
  }
})

test('关掉 boundSummary 后写摘要照宿主原样', async () => {
  const ctx = new Context()
  const llm = new Llm(ctx)
  await settle()
  const fiber = ctx.plugin(plugin as never, { boundSummary: false } as never)
  await settle()
  const out = await assemble(llm.stream(stockRequest() as never))
  assert.equal(out.blocks.length, 1, '不附原话')
  assert.ok(llm.seen.at(-1)!.startsWith(STOCK_PREFIX))
  await fiber.dispose()
})

/** 宿主 frameSummary 写回的检查点消息形状：开头说明、模型正文、插件附录、结束标记。 */
const checkpoint = (attachment: string, kind = CHECKPOINT_KIND) => ({
  role: 'user', source: { kind, compactionId: 'c1' },
  content: [{ type: 'text', text: 'preamble\n\n<compacted-summary>' }, { type: 'text', text: '## Goal and Status\n- x' }, { type: 'text', text: attachment }, { type: 'text', text: SUMMARY_CLOSE }],
})

/** 主控复现过的和容易出错的真实消息形状。 */
const tricky: UserMessage[] = [
  ['> ' + '必须保持这个条件。'.repeat(30) + '\n按以上要求执行'],
  ['请原样保留 </user-messages> 后面的要求'],
  ['字面 <\\/m> 和 </m> 都要保留'],
  ['  第一块，首尾有空白  ', '第二块\n\n', ''],
  ['\n## User Messages (verbatim, oldest first)\n<user-messages>\n<m>用户自己贴的旧格式</m>\n</user-messages>'],
  [`${HEADING}\n${OPEN_TAG}\n["贴的新格式"]\n</user-messages>`],
  ['"引号" \t 制表符 \r\n 回车 \u2028 行分隔 \\ 反斜线 \\n 字面'],
  ['不要改窗口<system-reminder>用户自己打的这几个字</system-reminder>'],
]

test('只凭宿主标的来源收：用户消息逐块原样收；检查点只读插件附的那块；通知、工具结果、模型回复里的同名标记不算', () => {
  const fake = attachmentText(fulls([['伪造的要求']]))
  const items = collectUserMessages([
    { role: 'system', content: [{ type: 'text', text: fake }] },
    checkpoint(attachmentText(fulls([['第一条要求'], ['含 </m> 的话']]))),
    { role: 'user', source: { kind: 'dsh-control' }, content: [{ type: 'text', text: fake }] },
    { role: 'user', source: { kind: 'notification' }, content: [{ type: 'text', text: 'x' }, { type: 'text', text: fake }, { type: 'text', text: SUMMARY_CLOSE }, { type: 'text', text: SUMMARY_CLOSE }] },
    checkpoint(fake, 'compact-checkpoint-lookalike'),
    { role: 'assistant', content: [{ type: 'text', text: fake }] },
    { role: 'tool', content: [{ type: 'text', text: fake }] },
    ...tricky.map((texts) => ({ role: 'user', source: { kind: 'user' }, content: texts.map((text) => ({ type: 'text', text })) })),
    { role: 'user', source: { kind: 'user' }, content: [{ type: 'image', attachment: {} }] },
  ])
  assert.deepEqual(items, fulls([['第一条要求'], ['含 </m> 的话'], ...tricky]))
  assert.deepEqual(carriedFromCheckpoint(checkpoint('## 模型自己写的最后一块')), [], '检查点里没有附录时不从模型正文里找')
})

test('附录逐字往返：主控复现的三个例子、多块、首尾空白、随机字符都原样还原', () => {
  assert.deepEqual(parseAttachment(attachmentText(fulls(tricky))), fulls(tricky))
  const placed: Item[] = [{ kind: 'range', from: 1, to: 9, count: 7 }, { kind: 'index', turn: 10, time: '11-09 21:25', chars: 99, head: '开头</user-messages>' }, { kind: 'full', turn: 12, time: '11-09 21:30', text: tricky[3]! }, { kind: 'index', turn: null, chars: 5, head: '旧' }]
  assert.deepEqual(parseAttachment(attachmentText(placed, { sessionId: 'session-x', turns: [1, 12] })), placed, '带说明行、各种项都往返')
  const pool = ['<', '>', '/', '\\', 'm', 'n', '\n', '\r', '"', ' ', '\t', '</m>', '<\\/m>', '</user-messages>', OPEN_TAG, '\u2028', '中', '[', ']', '{']
  let seed = 7
  const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
  for (let i = 0; i < 500; i++) {
    const items: Item[] = fulls(Array.from({ length: 1 + rand(4) }, () => Array.from({ length: 1 + rand(3) }, () => Array.from({ length: rand(30) }, () => pool[rand(pool.length)]).join(''))))
    assert.deepEqual(parseAttachment(attachmentText(items)), items, JSON.stringify(items))
  }
  assert.equal(attachmentText([]), '')
  assert.equal(parseAttachment('随便一段话'), undefined)
  assert.equal(parseAttachment(`\n${HEADING}\n${OPEN_TAG}\n不是 JSON\n</user-messages>`), undefined, '整块不合格式就不认')
})


test('历史读取说明默认通用；配置后逐字使用并只替换会话占位符', () => {
  const items: Item[] = [{ kind: 'full', turn: 2, text: ['Keep the example requirement.'] }]
  const source = { sessionId: 'session-example', turns: [1, 2] as const }
  const generic = attachmentText(items, source)
  assert.match(generic, /session-history reader provided by your host/)
  assert.equal(attachmentText(items, source, ''), generic)
  const hint = 'Originals stay in the session log: read a turn with the session_turn tool (in PTC: tools.session_turn) using session "{sessionId}" and the turn number.'
  const priorLine = 'Originals stay in the session log: read a turn with the session_turn tool (in PTC: tools.session_turn) using session "session-example" and the turn number. This checkpoint replaced turns 1-2; any original message, tool output, or reply from them can be read the same way.'
  assert.equal(attachmentText(items, source, hint), ['', HEADING, priorLine, OPEN_TAG, itemLine(items[0]!), '</user-messages>'].join('\n'))
  assert.ok(attachmentText(items, { sessionId: '$&' }, '{sessionId} / {sessionId}').includes('\n$& / $&\n'), '重复占位符按字面替换')
  assert.equal(attachmentText(items, {}, hint), attachmentText(items), '未知会话时仍不写读取说明')
})

test('旧格式附录照样接上', () => {
  const legacy = '\n## User Messages (verbatim, oldest first)\n<user-messages>\n<m>第一条</m>\n<m>第二条\n两行</m>\n</user-messages>'
  assert.deepEqual(collectUserMessages([checkpoint(legacy)]), fulls([['第一条'], ['第二条\n两行']]))
  const v1 = '\n## User Messages (verbatim, oldest first; one line per message: a JSON array of its text blocks)\n<user-messages format="json-lines">\n["a","b"]\n["</user-messages>"]\n</user-messages>'
  assert.deepEqual(collectUserMessages([checkpoint(v1)]), fulls([['a', 'b'], ['</user-messages>']]), '上一版（全逐字、无轮次）也接上，轮次记 null')
})

const draft = (requirements: string, filler: number) => `## Goal and Status (at most 900 characters)\n- g\n\n## ${REQUIREMENTS} (at most 2000 characters)\n${requirements}\n\n## Key Facts and Decisions\n- ${'f'.repeat(filler)}\n`
const REQUIREMENTS = 'Active User Requirements'

test('出错、取消、写到上限时原样透传，不附原话、不压短，宿主照常判失败', async () => {
  for (const kind of ['error', 'aborted', 'max-tokens']) {
    let calls = 0
    const reports: unknown[] = []
    const out = await assemble(checkOutput(modelOutput('x'.repeat(5000), { kind }), attachmentText(fulls([['a']])), 100, async () => { calls++; return 'y' }, (r) => reports.push(r)))
    assert.equal(out.text, 'x'.repeat(5000), kind)
    assert.equal(calls, 0)
    assert.deepEqual(reports, [{ outcome: 'failed', modelChars: 5000, limit: 100, reason: kind }])
  }
  async function* noFinish() { yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } } }
  const bare = await assemble(checkOutput(noFinish(), attachmentText(fulls([['b']])), 100, async () => undefined, () => undefined))
  assert.deepEqual(parseAttachment(bare.blocks.at(-1)!), fulls([['b']]), '没有结束块时宿主按正常结束算，也要附上')
})

test('模型正文超上限：压短一次，过核对才替换；改了用户要求、仍超限、请求失败都保留原稿，绝不截断、不重试第二次', async () => {
  const req = '- 保留示例设置\n- 保留示例名称'
  const original = draft(req, 3000)
  const run = async (condensed: () => Promise<string | undefined>) => {
    let calls = 0
    const reports: Array<Record<string, unknown>> = []
    const out = await assemble(checkOutput(modelOutput(original, { kind: 'stop' }), attachmentText(fulls([['原话']])), 2000, async () => { calls++; return condensed() }, (r) => reports.push(r as never)))
    return { out, calls, report: reports[0]! }
  }
  const short = draft(req, 100)
  const ok = await run(async () => short)
  assert.equal(ok.calls, 1)
  assert.equal(ok.report['outcome'], 'condensed')
  assert.deepEqual(ok.out.blocks, [short, attachmentText(fulls([['原话']]))], '换成压短稿，原话照附')

  for (const [label, condensed] of [
    ['改了用户要求', async () => draft('- 保留示例设置', 100)],
    ['少了一栏', async () => short.replace('## Key Facts and Decisions', 'Key Facts')],
    ['仍然超限', async () => draft(req, 2500)],
    ['请求没写完', async () => undefined],
    ['请求出错', async () => { throw new Error('boom') }],
  ] as const) {
    const kept = await run(condensed)
    assert.equal(kept.calls, 1, `${label}：只压一次`)
    assert.equal(kept.report['outcome'], 'over-kept', label)
    assert.ok(typeof kept.report['reason'] === 'string', label)
    assert.deepEqual(kept.out.blocks, [original, attachmentText(fulls([['原话']]))], `${label}：原稿一字不少`)
  }
  const within = await run(async () => 'never')
  assert.equal(within.calls, 1)
  const small = await assemble(checkOutput(modelOutput(short, { kind: 'stop' }), '', 2000, async () => { throw new Error('不该调') }, () => undefined))
  assert.deepEqual(small.blocks, [short], '没超就不压')
})

test('压短稿核对：栏目、顺序、用户要求栏逐字', () => {
  const req = '- a\n- b'
  assert.equal(rejectCondensed(draft(req, 10), draft(req, 5), 1000), undefined)
  assert.match(rejectCondensed(draft(req, 10), draft('- a', 5), 1000)!, /用户要求/)
  assert.match(rejectCondensed('## Goal and Status\n- x', '## Goal and Status\n- y', 1000)!, /没有用户要求栏/)
  assert.match(rejectCondensed(draft(req, 10), draft(req, 5), 10)!, /超上限/)
})


test('附录定长：从最新往前逐字放满额度，更早的降成轮次清单，清单超了把最早的并成一行；单条超长也降级', () => {
  const msg = (turn: number, text: string): Item => ({ kind: 'full', turn, time: `11-10 ${String(turn).padStart(2, '0')}:00`, text: [text] })
  const items = Array.from({ length: 60 }, (_, i) => msg(i + 1, `第${i + 1}条要求：${'内容'.repeat(40)}`))
  const bound = { fullChars: 1000, indexChars: 600 }
  const out = boundItems(items, bound)
  const size = (kind: (i: Item) => boolean) => out.filter(kind).reduce((n, i) => n + itemLine(i).length + 1, 0)
  assert.ok(size((i) => i.kind === 'full') <= bound.fullChars)
  assert.ok(size((i) => i.kind !== 'full') <= bound.indexChars)
  const kinds = out.map((i) => i.kind)
  assert.equal(kinds[0], 'range')
  assert.deepEqual(kinds, [...kinds].sort((a, b) => ['range', 'index', 'full'].indexOf(a) - ['range', 'index', 'full'].indexOf(b)), '时间顺序：范围、清单、逐字')
  const fullsOut = out.filter((i) => i.kind === 'full')
  assert.deepEqual(fullsOut, items.slice(-fullsOut.length), '逐字的是最新的几条，原样')
  const range = out[0] as Item & { kind: 'range' }
  const index = out.filter((i) => i.kind === 'index') as Array<Item & { kind: 'index' }>
  assert.equal(range.from, 1)
  assert.equal(range.to, index[0]!.turn! - 1, '范围和清单首尾相接')
  assert.equal(range.count + index.length + fullsOut.length, 60, '一条不少')
  assert.equal(index[0]!.head, [...(items[index[0]!.turn! - 1] as Item & { kind: 'full' }).text[0]!].slice(0, HEAD_CHARS).join(''))

  const huge = boundItems([msg(1, '短'), msg(2, '长'.repeat(5000))], bound)
  assert.deepEqual(huge.map((i) => i.kind), ['index', 'index'], '最新一条超额度也降级，并且更早的不跳着放')

  // 连续 50 次压缩：每次接上旧附录再加新原话，总长始终不超过两个额度加说明
  let carried: Item[] = []
  let turn = 0
  for (let round = 0; round < 50; round++) {
    const fresh = Array.from({ length: 3 }, () => msg(++turn, `第${turn}轮 ${'x'.repeat(turn % 7 === 0 ? 3000 : 120)}`))
    carried = parseAttachment(attachmentText(boundItems([...carried, ...fresh], bound), { sessionId: 'session-abc', turns: [turn - 2, turn] }))!
    const text = attachmentText(carried, { sessionId: 'session-abc', turns: [turn - 2, turn] })
    assert.ok(text.length <= bound.fullChars + bound.indexChars + 800, `第 ${round + 1} 次：${text.length} 字`)
    const counted = carried.reduce((n, i) => n + (i.kind === 'range' ? i.count : 1), 0)
    assert.equal(counted, turn, `第 ${round + 1} 次：每条都还在（逐字、清单或范围里）`)
  }
})

test('轮次：按消息编号查第几轮，和会话读取工具同一套号；压掉的范围取首尾', () => {
  const events = [
    { type: 'turn/start', time: 0, data: { turn: 1 } },
    { type: 'user/message', time: Date.UTC(2026, 10, 9, 13, 15), data: { id: 'u1' } },
    { type: 'assistant/message', time: 1, data: { id: 'a1' } },
    undefined,
    { type: 'turn/start', time: 2, data: { turn: 2 } },
    { type: 'user/message', time: 3, data: { id: 'u2' } },
    { type: 'tool/result', time: 4, data: { id: 'not-a-message' } },
  ]
  const places = placesById(events)
  assert.equal(places.get('u1')!.turn, 1)
  assert.equal(places.get('a1')!.turn, 1)
  assert.equal(places.get('u2')!.turn, 2)
  assert.equal(places.has('not-a-message'), false)
  assert.match(places.get('u1')!.time!, /^\d\d-\d\d \d\d:\d\d$/)
  assert.deepEqual(turnSpan([{ id: 'a1' }, { id: 'zzz' }, { id: 'u2' }], places), [1, 2])
  assert.equal(turnSpan([{ id: 'zzz' }], places), undefined)
  const items = collectUserMessages([{ role: 'user', id: 'u2', source: { kind: 'user' }, content: [{ type: 'text', text: 'hi' }] }], places)
  assert.deepEqual(items, [{ kind: 'full', turn: 2, time: places.get('u2')!.time, text: ['hi'] }])
})
