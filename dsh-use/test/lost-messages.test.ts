import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findInterruptedUser, findLostMessages, scanLostMessages, UNTERMINATED_GRACE_MS } from '../src/lost-messages.ts'
import type { RawEvent } from '../src/transcript.ts'

// 形状照抄 2026-11-03 19:37 重启时真实丢消息那段日志（seq 1970~1973），文字换成占位。
const RESTART = 1_000_000
const userMessage = (id: string, text: string) => ({ content: [{ type: 'text', text }], source: { kind: 'user', rpcId: `rpc-${id}`, clientTimeZone: 'Asia/Shanghai' }, role: 'user', id })
const queued = (id: string, text: string, time: number): RawEvent => ({ type: 'agent/inbox/spliced', time, data: { target: 'next-turn', start: 0, inserted: [userMessage(id, text)] } })
const claim = (time: number, target = 'next-turn'): RawEvent => ({ type: 'agent/inbox/spliced', time, data: { target, start: 0, removedCount: 1, inserted: [] } })
const turnEnd = (time: number, kind: string): RawEvent => ({ type: 'turn/end', time, data: { turn: 20, reason: kind === 'aborted' ? { kind, reason: { kind: 'user' } } : { kind } } })
const written = (id: string, text: string, time: number): RawEvent => ({ type: 'user/message', time, data: userMessage(id, text) })

const swallowed: RawEvent[] = [
  queued('m1', '我批注了以下内容', RESTART + 3000),
  { type: 'turn/start', time: RESTART + 3000, data: { turn: 20 } },
  claim(RESTART + 3000),
  turnEnd(RESTART + 5000, 'aborted'),
]

test('取走后没写进记录、这一轮在重启后被中止：原样找回，标明它开启了那一轮', () => {
  const lost = findLostMessages(swallowed, RESTART)
  assert.equal(lost.length, 1)
  assert.deepEqual(lost[0]!.message, userMessage('m1', '我批注了以下内容'))
  assert.equal(lost[0]!.target, 'next-turn')
  assert.equal(lost[0]!.text, '我批注了以下内容')
})

test('已经写进记录、或这一轮正常结束、或中止发生在重启之前：都不算', () => {
  assert.deepEqual(findLostMessages([...swallowed.slice(0, 3), written('m1', '我批注了以下内容', RESTART + 4000), turnEnd(RESTART + 5000, 'aborted')], RESTART), [])
  assert.deepEqual(findLostMessages([...swallowed.slice(0, 3), turnEnd(RESTART + 5000, 'error')], RESTART), [])
  assert.deepEqual(findLostMessages(swallowed, RESTART + 6000), [])
})

test('放回过（同一编号再插入）或用户自己重发过同样的话：不再放，重复调用安全', () => {
  assert.deepEqual(findLostMessages([...swallowed, queued('m1', '我批注了以下内容', RESTART + 9000)], RESTART), [])
  assert.deepEqual(findLostMessages([...swallowed, queued('m2', '我批注了以下内容', RESTART + 9000), claim(RESTART + 9000), written('m2', '我批注了以下内容', RESTART + 11000)], RESTART), [])
})

test('界面删除排队消息（outcome canceled）不是取走；插话被取进 next-step 后吞掉也找得回', () => {
  assert.deepEqual(findLostMessages([queued('m1', '删掉的', RESTART), { type: 'agent/inbox/spliced', time: RESTART + 1, data: { target: 'next-turn', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' } }, turnEnd(RESTART + 2, 'aborted')], RESTART), [])
  const steer: RawEvent[] = [
    { type: 'agent/inbox/spliced', time: RESTART, data: { target: 'next-step', start: 0, inserted: [userMessage('s1', '改成 B')] } },
    claim(RESTART + 10, 'next-step'),
    turnEnd(RESTART + 500, 'aborted'),
  ]
  assert.deepEqual(findLostMessages(steer, RESTART).map((m) => [m.message['id'], m.target]), [['s1', 'next-step']])
})

test('进程被直接结束、日志停在取走之后：重启前不久取走的才算', () => {
  const cut = swallowed.slice(0, 3)
  assert.equal(findLostMessages(cut, RESTART + 3000 + UNTERMINATED_GRACE_MS).length, 1)
  assert.equal(findLostMessages(cut, RESTART + 3001 + UNTERMINATED_GRACE_MS).length, 0)
})

test('原来那一轮也在重启时被中止：标出来，调用方照发「继续」', () => {
  assert.equal(scanLostMessages(swallowed, RESTART).otherAborted, false)
  const both: RawEvent[] = [turnEnd(RESTART + 1000, 'aborted'), ...swallowed]
  assert.deepEqual(scanLostMessages(both, RESTART).lost.map((m) => m.message['id']), ['m1'])
  assert.equal(scanLostMessages(both, RESTART).otherAborted, true)
})

test('只认用户消息：插件通知、目标提示被吞不放回', () => {
  const notice = { ...userMessage('n1', '继续'), source: { kind: 'dsh-use', form: 'notice' } }
  const events: RawEvent[] = [{ type: 'agent/inbox/spliced', time: RESTART, data: { target: 'next-turn', start: 0, inserted: [notice] } }, claim(RESTART + 1), turnEnd(RESTART + 2, 'aborted')]
  assert.deepEqual(findLostMessages(events, RESTART), [])
})

test('被中止的那一轮里用户还没被回应完的话：找出来交给重启通知；正常结束、重启前的中止、插件通知都不算', () => {
  const asked: RawEvent[] = [
    { type: 'turn/start', time: RESTART - 60_000, data: { turn: 19 } },
    written('u19', '你是不是不会在目标达成的时候主动停止目标？', RESTART - 60_000),
    turnEnd(RESTART + 2000, 'aborted'),
  ]
  assert.deepEqual(findInterruptedUser(asked, RESTART), { text: '你是不是不会在目标达成的时候主动停止目标？', at: RESTART - 60_000 })
  assert.equal(findInterruptedUser([...asked.slice(0, 2), turnEnd(RESTART + 2000, 'completed')], RESTART), undefined)
  assert.equal(findInterruptedUser([...asked.slice(0, 2), turnEnd(RESTART - 1000, 'aborted')], RESTART), undefined)
  const goalRound: RawEvent[] = [
    { type: 'turn/start', time: RESTART, data: { turn: 21 } },
    { type: 'user/message', time: RESTART, data: { content: [{ type: 'text', text: '<goal_round>' }], source: { kind: 'goal' }, role: 'user', id: 'g1' } },
    turnEnd(RESTART + 2000, 'aborted'),
  ]
  assert.equal(findInterruptedUser(goalRound, RESTART), undefined, '目标续跑轮不是用户说的话')
  const cut = asked.slice(0, 2)
  assert.equal(findInterruptedUser(cut, RESTART)?.text, '你是不是不会在目标达成的时候主动停止目标？', '日志停在一轮中间也算被中止')
})
