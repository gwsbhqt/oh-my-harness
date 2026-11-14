import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DoneWatcher, finalNotice, type DoneWatchDeps, type DoneWatchRecord } from '../src/done-watch.ts'
import type { CommandResult } from '../src/service.ts'

function setup(check: DoneWatchDeps['check']) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-use-done-watch-'))
  const sent: { session: string; text: string; summary: string }[] = []
  const listeners: ((id: string, running: boolean) => void)[] = []
  const make = (c: DoneWatchDeps['check'] = check) => new DoneWatcher({
    dir, check: c, intervalMs: 20, log: () => {}, title: async (target) => target === 'session-bbbb' ? '修 CI' : undefined,
    deliver: async (session, text, summary) => { sent.push({ session, text, summary }) },
    onStatus: (l) => { listeners.push(l); return () => {} },
  })
  return { dir, sent, listeners, make, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const done = (status: NonNullable<CommandResult['status']>, reply = '全部改完，测试通过。', ended = 'completed'): CommandResult => ({
  text: '跑完了', status, data: { turns: [{ turn: 3, ended, detail: null, reply }] },
})
const until = async (cond: () => boolean) => {
  const deadline = Date.now() + 3000
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('等太久')
    await new Promise((r) => setTimeout(r, 10))
  }
}

test('做完通知：没做完不送，提问只送一次，真做完只送一次并落盘 delivered', async () => {
  const outcomes: (CommandResult | undefined)[] = [
    undefined,
    { text: '在等回答：选 A 还是 B？', status: 'waiting-input', data: { questions: [{ callId: 'call-1', question: '选 A 还是 B？' }] } },
    { text: '在等回答：选 A 还是 B？', status: 'waiting-input', data: { questions: [{ callId: 'call-1', question: '选 A 还是 B？' }] } },
    { text: '还没做完', status: 'running' },
    done('ok', '改好了'.repeat(400)),
  ]
  const s = setup(async () => outcomes.shift())
  try {
    const w = s.make()
    w.stop()
    const record = await w.add({ target: 'session-bbbb', notify: 'session-aaaa', since: 7 })
    const steps = []
    for (let i = 0; i < 5; i++) steps.push(await w.step(record))
    assert.deepEqual(steps, [false, false, false, false, true])
    assert.equal(s.sent.length, 2)
    assert.match(s.sent[0]!.text, /waiting for an answer/)
    assert.equal(s.sent[1]!.session, 'session-aaaa')
    assert.match(s.sent[1]!.text, /session session-bbbb "修 CI" has genuinely finished/)
    assert.match(s.sent[1]!.text, /End reason: completed/)
    assert.match(s.sent[1]!.text, /dsh-use last session-bbbb/)
    assert.ok(s.sent[1]!.text.length < 1500, '最后回复只带开头')
    assert.match(s.sent[1]!.summary, /修 CI finished/)
    const saved = JSON.parse(readFileSync(w.path(record.id), 'utf8')) as DoneWatchRecord
    assert.equal(saved.state, 'delivered')
    assert.equal(saved.outcome, 'ok')
    assert.equal(w.list().length, 0)
  } finally { s.cleanup() }
})

test('做完通知：失败、中止、会话不见了也送并写明', () => {
  const record: DoneWatchRecord = { id: 'w', target: 'session-bbbb', notify: 'session-aaaa', since: 1, createdAt: 0, state: 'watching', asked: [], attempts: 0 }
  assert.match(finalNotice(record, done('aborted', '做到一半', 'aborted')).text, /interrupted and it did not finish[\s\S]*End reason: aborted/)
  assert.match(finalNotice(record, done('failed', '', 'error')).text, /did not end successfully[\s\S]*There was no text reply at the end/)
  assert.match(finalNotice(record, 'gone').text, /is gone/)
})

test('做完通知：DSH 重启后新实例读回记录接着盯，只送一次；上次送到一半的不重送', async () => {
  let ready = false
  const s = setup(async () => ready ? done('ok') : undefined)
  try {
    const first = s.make()
    const record = await first.add({ target: 'session-bbbb', notify: 'session-aaaa', since: 3 })
    first.stop()
    mkdirSync(s.dir, { recursive: true })
    writeFileSync(join(s.dir, 'half.json'), JSON.stringify({ id: 'half', target: 'session-cccc', notify: 'session-aaaa', since: 1, createdAt: Date.now(), state: 'delivering', asked: [], attempts: 0 }))
    ready = true
    const second = s.make()
    await second.start()
    await until(() => s.sent.length >= 1)
    await new Promise((r) => setTimeout(r, 100))
    second.stop()
    assert.equal(s.sent.length, 1)
    assert.match(s.sent[0]!.text, /session-bbbb/)
    assert.equal((JSON.parse(readFileSync(second.path(record.id), 'utf8')) as DoneWatchRecord).state, 'delivered')
    const half = JSON.parse(readFileSync(join(s.dir, 'half.json'), 'utf8')) as DoneWatchRecord
    assert.equal(half.state, 'failed')
    assert.match(String(half.error), /不再重送/)
  } finally { s.cleanup() }
})

test('做完通知：目标会话被删按不见了送；送不出去重试三次后放弃', async () => {
  const s = setup(async () => { throw Object.assign(new Error('找不到'), { code: 'not-found' }) })
  try {
    const w = s.make()
    w.stop()
    const record = await w.add({ target: 'session-gone', notify: 'session-aaaa', since: 0 })
    assert.equal(await w.step(record), true)
    assert.match(s.sent[0]!.text, /is gone/)
  } finally { s.cleanup() }
  let tries = 0
  const dir = mkdtempSync(join(tmpdir(), 'dsh-use-done-watch-'))
  try {
    const w = new DoneWatcher({ dir, check: async () => done('ok'), log: () => {}, onStatus: () => () => {}, deliver: async () => { tries++; throw new Error('会话控制器不可用') } })
    w.stop()
    const record = await w.add({ target: 'session-bbbb', notify: 'session-aaaa', since: 0 })
    assert.deepEqual([await w.step(record), await w.step(record), await w.step(record)], [false, false, true])
    assert.equal(tries, 3)
    assert.equal((JSON.parse(readFileSync(w.path(record.id), 'utf8')) as DoneWatchRecord).state, 'failed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('做完通知：同一目标同一通知对象只留一条，做完只送一次；换通知对象另算', async () => {
  let ready = false
  const s = setup(async () => ready ? done('ok') : undefined)
  try {
    const w = s.make()
    const first = await w.add({ target: 'session-bbbb', notify: 'session-aaaa', since: 3 })
    const again = await w.add({ target: 'session-bbbb', notify: 'session-aaaa', since: 9 })
    const other = await w.add({ target: 'session-bbbb', notify: 'session-zzzz', since: 9 })
    assert.equal(again.id, first.id)
    assert.equal(again.reused, true)
    assert.equal(again.since, 3)
    assert.notEqual(other.id, first.id)
    assert.equal(w.list().length, 2)
    ready = true
    w.kick()
    await until(() => s.sent.length >= 2)
    await new Promise((r) => setTimeout(r, 100))
    w.stop()
    assert.deepEqual(s.sent.map((x) => x.session).sort(), ['session-aaaa', 'session-zzzz'])
  } finally { s.cleanup() }
})

test('做完通知：重启读回同一目标同一通知对象的多条，只留最早一条，其余标 merged', async () => {
  let ready = false
  const s = setup(async () => ready ? done('ok') : undefined)
  try {
    mkdirSync(s.dir, { recursive: true })
    const base = { target: 'session-bbbb', notify: 'session-aaaa', state: 'watching', asked: [], attempts: 0 }
    writeFileSync(join(s.dir, 'old.json'), JSON.stringify({ ...base, id: 'old', since: 1, createdAt: 1000 }))
    writeFileSync(join(s.dir, 'new.json'), JSON.stringify({ ...base, id: 'new', since: 5, createdAt: 2000 }))
    const w = s.make()
    await w.start()
    assert.deepEqual(w.list().map((r) => r.id), ['old'])
    const merged = JSON.parse(readFileSync(join(s.dir, 'new.json'), 'utf8')) as DoneWatchRecord
    assert.equal(merged.state, 'merged')
    assert.equal(merged.mergedInto, 'old')
    ready = true
    await until(() => s.sent.length >= 1)
    await new Promise((r) => setTimeout(r, 100))
    w.stop()
    assert.equal(s.sent.length, 1)
  } finally { s.cleanup() }
})


test('同一目标、同一通知对象同时登记两次：只留一条监听，第二次沿用', async () => {
  const s = setup(async () => undefined)
  try {
    const w = s.make()
    w.stop()
    const [a, b] = await Promise.all([
      w.add({ target: 'session-bbbb', notify: 'session-aaaa', since: 7 }),
      w.add({ target: 'session-bbbb', notify: 'session-aaaa', since: 9 }),
    ])
    assert.equal(b.id, a.id)
    assert.equal(b.reused, true)
    assert.equal(w.list().length, 1)
    assert.equal(readdirSync(s.dir).filter((n) => n.endsWith('.json')).length, 1)
  } finally { s.cleanup() }
})
