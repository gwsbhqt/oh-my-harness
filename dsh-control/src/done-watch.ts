/**
 * 派单「做完通知」：`send` / `new` / `chat` 带 `--notify <会话>` 时登记一条监听，目标会话按 `wait --settled`
 * 的口径真做完（这一轮结束、没在跑、没排队，名下没有在跑的后台任务和子代理，持续目标不会自动续跑）后，
 * 用插件通知给指定会话送一次结果。失败、中止、会话不见了也照送并写明。
 *
 * 监听记录落盘在 `$DSH_HOME/dsh-control/done-watches/<编号>.json`，插件启动时读回来接着盯，DSH 重启不丢；
 * 送之前先把记录标成 delivering，重启后看到 delivering 不再重送，宁可少送不重送。
 *
 * 同一个目标、同一个通知对象只留一条在等的监听：做完是一件事，派单方每次插话都带 --notify 时
 * 不能做完那一刻送来一串一样的通知（2026-11-06 一个长工做完，主控同时收到 9 条）。
 *
 * @module
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CommandResult } from './service.ts'

export interface DoneWatchRecord {
  id: string
  target: string
  targetTitle?: string
  notify: string
  since: number
  createdAt: number
  state: 'watching' | 'delivering' | 'delivered' | 'failed' | 'merged'
  /** state 为 merged 时，并进了哪一条。 */
  mergedInto?: string
  /** 已经通知过的提问（按提问编号），同一个提问只送一次。 */
  asked: string[]
  attempts: number
  outcome?: string
  finishedAt?: number
  error?: string
}

export interface DoneWatchDeps {
  dir: string
  /** 按 `wait --settled` 口径查一次；没做完返回 undefined 或 status running。memo 由监听保管，跨次保留稳定计时。 */
  check(target: string, since: number, memo: Record<string, unknown>): Promise<CommandResult | undefined>
  deliver(session: string, text: string, summary: string): Promise<unknown>
  /** 送之前查目标现在的标题：新会话登记时往往还没起标题。 */
  title?(target: string): Promise<string | undefined>
  onStatus(listener: (sessionId: string, running: boolean) => void): () => void
  log(line: string): void
  intervalMs?: number
  now?: () => number
}

const MAX_ATTEMPTS = 3
const KEEP_FINISHED_MS = 7 * 86_400_000
const REPLY_CHARS = 600

function short(id: string): string {
  return id.replace(/^session-/, '').slice(0, 8)
}

function cut(text: string, max: number): string {
  const t = text.trim()
  return t.length <= max ? t : `${t.slice(0, max)}… (${t.length - max} more characters)`
}

interface TurnWire { turn?: number; ended?: string; detail?: string | null; reply?: string | null }

/** 结果通知正文：读者是派单会话里的模型，先说成没成，再给最后回复的开头和读全文的命令。 */
export function finalNotice(record: DoneWatchRecord, outcome: CommandResult | 'gone'): { text: string; summary: string; outcome: string } {
  const name = `session ${record.target}${record.targetTitle === undefined ? '' : ` "${record.targetTitle}"`}`
  const label = record.targetTitle ?? short(record.target)
  if (outcome === 'gone') {
    return {
      outcome: 'gone',
      summary: `dsh-control: ${label} is gone`,
      text: [`dsh-control task result: ${name} is gone (it may have been deleted), so it can no longer be awaited.`, `This is the one-time completion notice registered with --notify when you sent the task.`].join('\n'),
    }
  }
  const data = (typeof outcome.data === 'object' && outcome.data !== null ? outcome.data : {}) as { turns?: TurnWire[]; lastSeq?: number }
  const turns = Array.isArray(data.turns) ? data.turns : []
  const last = turns.at(-1)
  const reply = [...turns].reverse().find((t) => typeof t.reply === 'string' && t.reply.trim() !== '')?.reply ?? undefined
  const reason = last === undefined ? 'none' : `${String(last.ended)}${last.detail ? ` (${last.detail})` : ''}`
  const status = outcome.status ?? 'ok'
  const headline = status === 'ok' ? 'has genuinely finished'
    : status === 'aborted' ? 'stopped, but its last turn was interrupted and it did not finish'
      : status === 'failed' ? 'stopped, but its last turn did not end successfully'
        : status === 'idle' ? 'is idle, but no new turn has ended since the task was sent (the message may have been withdrawn or deleted)'
          : `stopped (${status})`
  const summaryWord = status === 'ok' ? 'finished' : status === 'aborted' ? 'interrupted' : status === 'failed' ? 'failed' : 'no new result'
  return {
    outcome: status,
    summary: `dsh-control: ${label} ${summaryWord}`,
    text: [
      `dsh-control task result: ${name} ${headline}.`,
      `End reason: ${reason}. Settled rule: the turn ended, nothing is running, no message is queued, no background job or subagent of its own is running, and an active goal will not resume automatically.`,
      ...(reply === undefined ? ['There was no text reply at the end.'] : ['Start of the final reply:', cut(reply, REPLY_CHARS)]),
      `Read the full text: dsh-control last ${record.target}; read turn by turn: dsh-control read ${record.target} --turn -1.`,
      `This is the one-time completion notice registered with --notify when you sent the task.`,
    ].join('\n'),
  }
}

function questionNotice(record: DoneWatchRecord, outcome: CommandResult): { text: string; summary: string } {
  const label = record.targetTitle ?? short(record.target)
  return {
    summary: `dsh-control: ${label} is waiting for an answer`,
    text: [
      `dsh-control task progress: session ${record.target}${record.targetTitle === undefined ? '' : ` "${record.targetTitle}"`} has not finished; it stopped and is waiting for an answer:`,
      outcome.text,
      `You will be notified again when it finishes.`,
    ].join('\n'),
  }
}

function questionKeys(outcome: CommandResult): string[] {
  const data = (typeof outcome.data === 'object' && outcome.data !== null ? outcome.data : {}) as { questions?: { callId?: unknown; id?: unknown }[] }
  return (data.questions ?? []).map((q, i) => String(q.callId ?? q.id ?? i))
}

export class DoneWatcher {
  private readonly deps: DoneWatchDeps
  private readonly records = new Map<string, DoneWatchRecord>()
  private readonly memos = new Map<string, Record<string, unknown>>()
  private readonly adding = new Map<string, Promise<DoneWatchRecord>>()
  private timer: ReturnType<typeof setInterval> | undefined
  private unsubscribe: (() => void) | undefined
  private running = false
  private again = false
  private stopped = false

  constructor(deps: DoneWatchDeps) {
    this.deps = deps
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }

  /** 读回没送完的监听接着盯；上次正送到一半的标成失败，不重送。 */
  async start(): Promise<void> {
    await mkdir(this.deps.dir, { recursive: true, mode: 0o700 })
    for (const name of await readdir(this.deps.dir)) {
      if (!name.endsWith('.json')) continue
      const path = join(this.deps.dir, name)
      let record: DoneWatchRecord
      try { record = JSON.parse(await readFile(path, 'utf8')) as DoneWatchRecord }
      catch (error) { this.deps.log(`done-watch 读不了 ${name}：${error instanceof Error ? error.message : String(error)}`); continue }
      if (record.state === 'watching') this.records.set(record.id, { ...record, asked: record.asked ?? [], attempts: record.attempts ?? 0 })
      else if (record.state === 'delivering') {
        await this.save({ ...record, state: 'failed', finishedAt: this.now(), error: '上次送通知时 DSH 退出了，确认不了送到没有，按只送一次不再重送' })
      } else if ((record.finishedAt ?? record.createdAt) < this.now() - KEEP_FINISHED_MS) await rm(path, { force: true })
    }
    await this.mergeDuplicates()
    if (this.stopped) return
    this.unsubscribe = this.deps.onStatus((sessionId) => {
      if ([...this.records.values()].some((r) => r.target === sessionId)) this.kick()
    })
    this.timer = setInterval(() => { if (this.records.size > 0) this.kick() }, this.deps.intervalMs ?? 5000)
    this.timer.unref?.()
    if (this.records.size > 0) this.deps.log(`done-watch 接着盯 ${this.records.size} 条`)
    this.kick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.unsubscribe?.()
  }

  list(): DoneWatchRecord[] {
    return [...this.records.values()]
  }

  /** 同一目标、同一通知对象已有在等的监听就沿用它；起点保留更早的那个，不影响「真做完」的判定。 */
  async add(input: { target: string; notify: string; since: number; targetTitle?: string }): Promise<DoneWatchRecord & { reused?: boolean }> {
    // 新记录要先落盘才进内存表，同一对目标和通知对象同时登记时，第二个要等第一个写完再沿用它。
    const key = `${input.target}\0${input.notify}`
    const inflight = this.adding.get(key)
    const existing = this.pendingFor(input.target, input.notify) ?? (inflight === undefined ? undefined : await inflight)
    if (existing !== undefined) {
      this.deps.log(`done-watch reuse ${existing.id} target=${input.target} notify=${input.notify} since=${input.since}`)
      this.kick()
      return { ...existing, reused: true }
    }
    const creating = this.create(input)
    this.adding.set(key, creating)
    try { return await creating } finally { this.adding.delete(key) }
  }

  private async create(input: { target: string; notify: string; since: number; targetTitle?: string }): Promise<DoneWatchRecord> {
    const record: DoneWatchRecord = { id: randomUUID(), ...input, createdAt: this.now(), state: 'watching', asked: [], attempts: 0 }
    await mkdir(this.deps.dir, { recursive: true, mode: 0o700 })
    await this.save(record)
    this.records.set(record.id, record)
    this.deps.log(`done-watch add ${record.id} target=${record.target} notify=${record.notify} since=${record.since}`)
    this.kick()
    return record
  }

  private pendingFor(target: string, notify: string): DoneWatchRecord | undefined {
    return [...this.records.values()].filter((r) => r.target === target && r.notify === notify)
      .sort((a, b) => a.createdAt - b.createdAt)[0]
  }

  /** 读回的记录里同一目标、同一通知对象有多条在等的，只留最早一条，其余标成 merged。 */
  private async mergeDuplicates(): Promise<void> {
    for (const record of [...this.records.values()]) {
      const keep = this.pendingFor(record.target, record.notify)
      if (keep === undefined || keep.id === record.id) continue
      this.records.delete(record.id)
      await this.save({ ...record, state: 'merged', mergedInto: keep.id, finishedAt: this.now() })
      this.deps.log(`done-watch ${record.id} merged into ${keep.id}`)
    }
  }

  path(id: string): string {
    return join(this.deps.dir, `${id}.json`)
  }

  private async save(record: DoneWatchRecord): Promise<void> {
    const tmp = join(this.deps.dir, `.${record.id}.${randomUUID()}.tmp`)
    await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    await rename(tmp, this.path(record.id))
  }

  /** 状态变化和定时器都走这里；同一时间只跑一遍，跑的时候来的请求合并成下一遍。 */
  kick(): void {
    if (this.stopped) return
    if (this.running) { this.again = true; return }
    this.running = true
    void (async () => {
      try {
        do {
          this.again = false
          for (const record of [...this.records.values()]) {
            if (this.stopped) return
            try { await this.step(record) }
            catch (error) { this.deps.log(`done-watch ${record.id} 检查出错：${error instanceof Error ? error.message : String(error)}`) }
          }
        } while (this.again && !this.stopped)
      } finally { this.running = false }
    })()
  }

  /** 查一次；跑完返回 true（已送或已放弃）。 */
  async step(record: DoneWatchRecord): Promise<boolean> {
    const memo = this.memos.get(record.id) ?? {}
    this.memos.set(record.id, memo)
    let outcome: CommandResult | 'gone' | undefined
    try { outcome = await this.deps.check(record.target, record.since, memo) }
    catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 'not-found') throw error
      outcome = 'gone'
    }
    if (outcome === undefined || (outcome !== 'gone' && (outcome.status === 'running' || outcome.status === 'timeout'))) return false
    if (outcome !== 'gone' && this.deps.title !== undefined) {
      const title = await this.deps.title(record.target).catch(() => undefined)
      if (title !== undefined && title.trim() !== '') record.targetTitle = title
    }
    if (outcome !== 'gone' && outcome.status === 'waiting-input') {
      const fresh = questionKeys(outcome).filter((k) => !record.asked.includes(k))
      if (fresh.length === 0) return false
      const { text, summary } = questionNotice(record, outcome)
      await this.deps.deliver(record.notify, text, summary)
      record.asked.push(...fresh)
      await this.save(record)
      this.deps.log(`done-watch ${record.id} asked ${fresh.join(',')}`)
      return false
    }
    const notice = finalNotice(record, outcome)
    record.state = 'delivering'
    record.outcome = notice.outcome
    await this.save(record)
    try {
      await this.deps.deliver(record.notify, notice.text, notice.summary)
      record.state = 'delivered'
      record.finishedAt = this.now()
      delete record.error
    } catch (error) {
      record.attempts++
      record.error = error instanceof Error ? error.message : String(error)
      if (record.attempts < MAX_ATTEMPTS) {
        record.state = 'watching'
        await this.save(record)
        this.deps.log(`done-watch ${record.id} 送通知失败（第 ${record.attempts} 次），稍后再试：${record.error}`)
        return false
      }
      record.state = 'failed'
      record.finishedAt = this.now()
    }
    await this.save(record)
    this.records.delete(record.id)
    this.memos.delete(record.id)
    this.deps.log(`done-watch ${record.id} ${record.state} outcome=${record.outcome}${record.error === undefined ? '' : ` error=${record.error}`}`)
    return true
  }
}
