/**
 * 找出「重启时被吞掉」的用户消息。
 *
 * 宿主开始处理一条消息时，先把它从排队区取走（`agent/inbox/spliced` 只记 removedCount，没有 outcome），
 * 做完拼提示词、各插件预处理等准备，才写进会话记录（`user/message`）。这段平时 1~5 秒；
 * 期间被中止，消息就既不在排队区也不在记录里，界面和上键历史都找不回（2026-11-03 实测丢过一条）。
 * 取走那一刻消息原文已经写在日志的插入记录里，所以能从日志原样拿回来。
 *
 * @module
 */
import type { RawEvent } from './transcript.ts'

export interface LostMessage {
  /** 宿主排队消息原样（id、role、source、content），放回排队区时整条交回。 */
  message: Record<string, unknown>
  /** 被取进哪一处：next-turn 说明它开启了被中止的那一轮。 */
  target: 'next-turn' | 'next-step'
  claimedAt: number
  text: string
}

/** 进程被直接结束时日志里没有 turn/end：取走时间在重启开始前这么久以内的，也算重启吞掉的。 */
export const UNTERMINATED_GRACE_MS = 30_000

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (typeof v === 'object' && v !== null ? v as Json : {})

function textOf(message: Json): string {
  const content = message['content']
  if (!Array.isArray(content)) return ''
  return content.flatMap((b) => obj(b)['type'] === 'text' && typeof obj(b)['text'] === 'string' ? [obj(b)['text'] as string] : []).join('\n')
}

function isUser(message: Json): boolean {
  return obj(message['source'])['kind'] === 'user' && typeof message['id'] === 'string'
}

/**
 * 重放排队区，返回取走后没写进记录、所在这一轮在 `since` 之后被中止（或日志在取走后就断了）的用户消息。
 * 之后已经原样放回过（同一 id 再次插入）、或用户自己重发过同样文字的不算，所以重复调用不会放回两次。
 */
export function findLostMessages(events: readonly RawEvent[], since: number): LostMessage[] {
  return scanLostMessages(events, since).lost
}

/**
 * 同上，另外说明 `since` 之后有没有「不是因为吞消息」被中止的轮次（手上原来的活也被打断了）。
 * 只有吞消息那一轮被中止时，消息放回去会话自己会重跑这一轮，不用再叫它「继续」。
 */
export function scanLostMessages(events: readonly RawEvent[], since: number): { lost: LostMessage[]; otherAborted: boolean } {
  let otherAborted = false
  const inbox: Record<string, Json[]> = { 'next-turn': [], 'next-step': [] }
  let claimed = new Map<string, LostMessage>()
  const lost = new Map<string, LostMessage>()
  for (const event of events) {
    const data = obj(event.data)
    const time = typeof event.time === 'number' ? event.time : 0
    if (event.type === 'agent/inbox/spliced') {
      const target = data['target'] === 'next-step' ? 'next-step' : 'next-turn'
      const list = inbox[target]!
      const start = typeof data['start'] === 'number' ? data['start'] : 0
      const count = typeof data['removedCount'] === 'number' ? data['removedCount'] : 0
      const inserted = Array.isArray(data['inserted']) ? data['inserted'].map(obj) : []
      const removed = list.splice(start, count, ...inserted)
      for (const m of inserted) {
        const id = m['id']
        if (typeof id === 'string') { claimed.delete(id); lost.delete(id) }
      }
      if (count > 0 && data['outcome'] === undefined) {
        for (const m of removed) if (isUser(m)) claimed.set(m['id'] as string, { message: m, target, claimedAt: time, text: textOf(m) })
      }
    } else if (event.type === 'user/message') {
      const id = data['id']
      if (typeof id === 'string') { claimed.delete(id); lost.delete(id) }
      if (obj(data['source'])['kind'] === 'user') {
        const text = textOf(data)
        for (const [key, m] of lost) if (m.text !== '' && m.text === text) lost.delete(key)
      }
    } else if (event.type === 'turn/end') {
      if (obj(data['reason'])['kind'] === 'aborted' && time >= since) {
        if (claimed.size === 0) otherAborted = true
        for (const [id, m] of claimed) lost.set(id, m)
      }
      claimed = new Map()
    }
  }
  for (const [id, m] of claimed) if (m.claimedAt >= since - UNTERMINATED_GRACE_MS) lost.set(id, m)
  return { lost: [...lost.values()], otherAborted }
}


/** 被中止的那一轮里用户最后说的话：重启通知要原样带上，让模型先回应它。 */
export interface InterruptedUser {
  text: string
  at: number
}

/**
 * `since` 之后被中止的轮次里，最后一条用户亲自发的消息（开启这一轮的或中途插话的）。
 * 那一轮被中止说明模型还没回应完；重启后的「继续」只说「任务没变、接着做」会把它盖掉
 * （2026-11-04 会话 cac50301：用户问「你是不是不会主动停止目标」，重启后模型照旧干活，没回答）。
 * 日志停在一轮中间（进程被直接结束，没有 turn/end）时，这一轮也算被中止。
 */
export function findInterruptedUser(events: readonly RawEvent[], since: number): InterruptedUser | undefined {
  let current: InterruptedUser | undefined
  let found: InterruptedUser | undefined
  for (const event of events) {
    const data = obj(event.data)
    const time = typeof event.time === 'number' ? event.time : 0
    if (event.type === 'turn/start') current = undefined
    else if (event.type === 'user/message' && obj(data['source'])['kind'] === 'user') {
      const text = textOf(data)
      if (text !== '') current = { text, at: time }
    } else if (event.type === 'turn/end') {
      if (obj(data['reason'])['kind'] === 'aborted' && time >= since && current !== undefined) found = current
      current = undefined
    }
  }
  return current ?? found
}
