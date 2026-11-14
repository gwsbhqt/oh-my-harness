import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { RunTracker, describeTool, type SessionEventLike, type StreamFrameLike } from '../../src/host/run-status/tracker.ts'
import { breakdown, formatDuration } from '../../src/shared/run-status/format.ts'

describe('模型流和重试', () => {
  it('发出请求后先等响应，再按思考、写回复、写工具调用切换', () => {
    const t = new RunTracker()
    t.event('s', { type: 'turn/start', time: 0, data: { turn: 1 } })
    t.event('s', { type: 'step/start', time: 10, data: { turn: 1, step: 1 } })
    t.stream('s', { type: 'start', turn: 1, step: 1 }, 20)
    assert.equal(t.snapshot('s', 5000).blocker?.kind, 'model-wait')
    assert.equal(t.snapshot('s', 5000).blocker?.since, 20)
    t.stream('s', { type: 'chunk', time: 6000, chunk: { type: 'reasoning-delta', text: '想一想' } }, 6000)
    assert.equal(t.snapshot('s', 6500).blocker?.title, '模型在思考')
    t.stream('s', { type: 'chunk', time: 7000, chunk: { type: 'tool-call-delta', name: 'run_code', argumentsDelta: '{"code"' } }, 7000)
    const snap = t.snapshot('s', 7100)
    assert.equal(snap.blocker?.title, '模型在写工具调用 run_code')
    assert.equal(snap.blocker?.detail, '已输出约 10 字')
    assert.equal(snap.totals['model-wait'], 5980)
  })

  it('真实空思考流：开始思考后不再算等首字，连续空段不重置计时', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/empty-thinking.json', import.meta.url), 'utf8')) as {
      requestStart: number; frames: Array<Extract<StreamFrameLike, { type: 'chunk' }>>
    }
    const t = new RunTracker()
    t.stream('s', { type: 'start', turn: 11, step: 46 }, fixture.requestStart)
    for (const frame of fixture.frames) t.stream('s', frame, frame.time)
    const first = fixture.frames[0]!.time
    const last = fixture.frames.at(-1)!.time
    const snap = t.snapshot('s', last)
    assert.equal(snap.blocker?.kind, 'model-thinking')
    assert.equal(snap.blocker?.since, first)
    assert.match(snap.blocker!.detail!, /上游暂未提供可展示的思考文字/)
    assert.equal(snap.totals['model-wait'], first - fixture.requestStart)
    assert.equal(snap.totals['model-output'] ?? 0, 0)
    assert.equal(breakdown(snap, last).find((row) => row.kind === 'model-thinking')?.ms, last - first)
    t.stream('s', { type: 'chunk', time: last + 1, chunk: { type: 'reasoning-delta', text: '\n\n' } }, last + 1)
    assert.equal(t.snapshot('s', last + 2).blocker?.kind, 'model-thinking')
    t.stream('s', { type: 'chunk', time: last + 3, chunk: { type: 'reasoning-delta', text: '检查字符串' } }, last + 3)
    assert.equal(t.snapshot('s', last + 4).blocker?.kind, 'model-output')
    assert.equal(t.snapshot('s', last + 4).blocker?.detail, '已输出约 5 字')
  })

  it('请求失败等重试时说出失败原因和第几次', () => {
    const t = new RunTracker()
    t.event('s', { type: 'turn/start', time: 0, data: { turn: 5 } })
    t.event('s', { type: 'llm/retry', time: 100, data: { turn: 5, step: 2, retry: 1, maxRetries: 5, delayMs: 523, failure: { message: 'claude API request failed: ECONNRESET', code: 'TRANSPORT' } } })
    const b = t.snapshot('s', 200).blocker!
    assert.equal(b.kind, 'retry')
    assert.match(b.title, /第 1\/5 次重试，等 0\.5 秒/)
    assert.match(b.detail!, /ECONNRESET/)
  })
})

describe('插件钩子', () => {
  it('钩子在处理时压过工具和模型，说出是哪个插件；等下游时不算它的', () => {
    const t = new RunTracker()
    t.event('s', { type: 'turn/start', time: 0, data: { turn: 1 } })
    t.event('s', { type: 'tool/call', time: 10, data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } })
    const outer = t.hookStart('s', 'dsh-compaction-tuning', 'tools/post-execute', 100)
    let b = t.snapshot('s', 3100).blocker!
    assert.equal(b.kind, 'hook')
    assert.equal(b.plugin, 'dsh-compaction-tuning')
    assert.equal(b.title, '插件 dsh-compaction-tuning 在处理「工具执行后」')
    t.hookWait('s', outer, 3100)
    assert.equal(t.snapshot('s', 3200).blocker?.kind, 'tool')
    t.hookResume('s', outer, 4000)
    t.hookEnd('s', outer, 4500)
    const snap = t.snapshot('s', 4600)
    assert.equal(snap.totals.hook, 3500)
    assert.ok(snap.recent.some((s) => s.title === '插件 dsh-compaction-tuning 在处理「工具执行后」' && s.ms === 3500))
  })

  it('连着几次同一件事在「最近」里合成一条，时长相加', () => {
    const t = new RunTracker()
    t.event('s', { type: 'turn/start', time: 0, data: { turn: 1 } })
    for (let i = 0; i < 4; i++) {
      t.event('s', { type: 'tool/ptc-dispatch-start', time: i * 3000, data: { subCallId: `c:${i}`, name: 'bash', arguments: { command: 'git log', description: '读取仓库数据' } } })
      t.event('s', { type: 'tool/ptc-dispatch', time: i * 3000 + 2000, data: { subCallId: `c:${i}` } })
    }
    const recent = t.snapshot('s', 20_000).recent
    assert.equal(recent.length, 1)
    assert.equal(recent[0]!.count, 4)
    assert.equal(recent[0]!.ms, 8000)
  })

  it('等批准单独显示成「等你」', () => {
    const t = new RunTracker()
    t.status('s', true, 0)
    t.hookStart('s', 'acp', 'approval/request', 10)
    assert.equal(t.snapshot('s', 20).blocker?.kind, 'wait-user')
    assert.equal(t.snapshot('s', 20).partial, true)
  })
})

describe('时间合计', () => {
  it('正在走的那一段跟着当前时间往合计里长', () => {
    const t = new RunTracker()
    t.status('s', true, 0)
    t.hookStart('s', 'acp', 'approval/request', 10)
    const snap = t.snapshot('s', 1000)
    assert.equal(breakdown(snap, 6000).find((r) => r.kind === 'wait-user')?.ms, 5990)
  })

  it('快照里没有正在走的那一段时，合计就是死数（老宿主的样子）', () => {
    const t = new RunTracker()
    t.status('s', true, 0)
    t.hookStart('s', 'acp', 'approval/request', 10)
    const { current: _ignored, ...snap } = t.snapshot('s', 1000)
    const atSix = breakdown(snap, 6000).find((r) => r.kind === 'wait-user')?.ms ?? 0
    const atSixty = breakdown(snap, 60_000).find((r) => r.kind === 'wait-user')?.ms ?? 0
    assert.equal(atSix, atSixty)
  })

  it('工具里等你回答的那段算「等你」，不算在工具头上', () => {
    const t = new RunTracker()
    t.event('s', { type: 'turn/start', time: 0, data: { turn: 1 } })
    t.event('s', { type: 'tool/call', time: 1000, data: { callId: 'c1', name: 'run_code', arguments: { description: '跑脚本' } } })
    const asked = t.hookStart('s', 'acp', 'user-questions/request', 61_000)
    assert.equal(t.snapshot('s', 62_000).blocker?.kind, 'wait-user')
    t.hookEnd('s', asked, 121_000)
    t.event('s', { type: 'tool/result', time: 300_000, data: { toolCallId: 'c1' } })
    const rows = breakdown(t.snapshot('s', 300_000), 300_000)
    assert.equal(rows.find((r) => r.kind === 'wait-user')?.ms, 60_000)
    assert.equal(rows.find((r) => r.kind === 'tool')?.ms, 239_000)
    assert.equal(rows.reduce((a, r) => a + r.ms, 0), 300_000)
  })
})

describe('工具描述', () => {
  it('子代理、联网、普通工具各有说法', () => {
    assert.equal(describeTool('subagent', { task: '查一下' }).tag, '子代理')
    assert.equal(describeTool('web_fetch', { url: 'https://x' }).detail, 'https://x')
    assert.equal(describeTool('read', '{"file_path":"/a/b.ts"}').title, '在跑工具 read')
    assert.equal(describeTool('bash', { command: 'sleep 1', run_in_background: true }).title, '在跑命令（后台）')
  })

  it('时长格式', () => {
    assert.equal(formatDuration(999), '0 秒')
    assert.equal(formatDuration(60_000), '1 分')
    assert.equal(formatDuration(3_725_000), '1 小时 2 分')
  })
})
