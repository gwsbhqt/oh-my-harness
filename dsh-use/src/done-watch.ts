/**
 * 派单「做完通知」：`send` / `new` / `chat` 带 `--notify <会话>` 时登记一条监听，目标会话按 `wait --settled`
 * 的口径真做完（这一轮结束、没在跑、没排队，名下没有在跑的后台任务和子代理，持续目标不会自动续跑）后，
 * 用插件通知给指定会话送一次结果。失败、中止、会话不见了也照送并写明。
 *
 * 监听记录落盘在 `$DSH_HOME/dsh-use/done-watches/<编号>.json`，插件启动时读回来接着盯，DSH 重启不丢；
 * 送之前先把记录标成 delivering，重启后看到 delivering 不再重送，宁可少送不重送。
 *
 * 同一个目标和通知对象只复用仍在等待任务结束的监听。旧任务开始最终投递后，新派单使用自己的监听。
 *
 * @module
 */
import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgyDeliveryError, parseAgyNotifyTarget } from './agy-notify.ts'
import type { CommandResult } from './service.ts'

export interface DoneWatchRecord {
  id: string
  target: string
  targetTitle?: string
  notify: string
  since: number
  createdAt: number
  state: 'watching' | 'delivering' | 'delivered' | 'failed' | 'merged' | 'unconfirmed'
  /** state 为 merged 时，并进了哪一条。 */
  mergedInto?: string
  /** 已通知的提问编号。AGY 在发送前也用它记录投递意图，防止重启重发。 */
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
      summary: `dsh-use: ${label} is gone`,
      text: [`dsh-use task result: ${name} is gone (it may have been deleted), so it can no longer be awaited.`, `This is the one-time completion notice registered with --notify when you sent the task.`].join('\n'),
    }
  }
  const data = (typeof outcome.data === 'object' && outcome.data !== null ? outcome.data : {}) as { turns?: TurnWire[]; lastSeq?: number }
  const turns = Array.isArray(data.turns) ? data.turns : []
  const last = turns.at(-1)
  const reply = [...turns].reverse().find((t) => typeof t.reply === 'string' && t.reply.trim() !== '')?.reply ?? undefined
  const reason = last === undefined ? 'none' : `${String(last.ended)}${last.detail ? ` (${last.detail})` : ''}`
  const status = outcome.status ?? 'ok'
  const headline = status === 'ok' ? 'has finished its own work'
    : status === 'aborted' ? 'stopped, but its last turn was interrupted and it did not finish'
      : status === 'failed' ? 'stopped, but its last turn did not end successfully'
        : status === 'idle' ? 'is idle, but no new turn has ended since the task was sent (the message may have been withdrawn or deleted)'
          : `stopped (${status})`
  const summaryWord = status === 'ok' ? 'finished its own work' : status === 'aborted' ? 'interrupted' : status === 'failed' ? 'failed' : 'no new result'
  return {
    outcome: status,
    summary: `dsh-use: ${label} ${summaryWord}`,
    text: [
      `dsh-use task result: ${name} ${headline}.`,
      `End reason: ${reason}. Settled rule: the turn ended, nothing is running, no message is queued, no background job or subagent of its own is running, and an active goal will not resume automatically.`,
      ...(status === 'ok' ? ['For a task dispatched to a separate session, check that session with its own completion notice or wait --settled.'] : []),
      ...(reply === undefined ? ['There was no text reply at the end.'] : ['Start of the final reply:', cut(reply, REPLY_CHARS)]),
      `Read the full text: dsh-use last ${record.target}; read turn by turn: dsh-use read ${record.target} --turn -1.`,
      `This is the one-time completion notice registered with --notify when you sent the task.`,
    ].join('\n'),
  }
}

function questionNotice(record: DoneWatchRecord, outcome: CommandResult): { text: string; summary: string } {
  const label = record.targetTitle ?? short(record.target)
  return {
    summary: `dsh-use: ${label} is waiting for an answer`,
    text: [
      `dsh-use task progress: session ${record.target}${record.targetTitle === undefined ? '' : ` "${record.targetTitle}"`} has not finished; it stopped and is waiting for an answer:`,
      outcome.text,
      `You will be notified again when it finishes.`,
    ].join('\n'),
  }
}

function agyStateLabel(status: string | undefined): string {
  if (status === undefined || status === 'ok') return 'completed'
  return status
}

/** 跨宿主发给 Antigravity 的完成通知只保留最小去敏元数据：DSH 任务编号、明确状态和 watch ID。 */
function agyFinalNotice(record: DoneWatchRecord, outcome: CommandResult | 'gone'): { text: string; summary: string; outcome: string } {
  const status = outcome === 'gone' ? 'gone' : (outcome.status ?? 'ok')
  const state = outcome === 'gone' ? 'gone' : agyStateLabel(status)
  return {
    outcome: status,
    summary: `dsh-use: ${record.target} ${state}`,
    text: `dsh-use notice: task=${record.target} state=${state} watch=${record.id}`,
  }
}

function agyQuestionNotice(record: DoneWatchRecord): { text: string; summary: string } {
  return {
    summary: `dsh-use: ${record.target} waiting-input`,
    text: `dsh-use notice: task=${record.target} state=waiting-input watch=${record.id}`,
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
  private restoring: Promise<void> | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private unsubscribe: (() => void) | undefined
  private running = false
  private again = false
  private stopped = false

  constructor(deps: DoneWatchDeps) {
    this.deps = deps
  }

  private now(): number { return this.deps.now?.() ?? Date.now() }

  /** 恢复仍在等的监听。中断的最终投递不重送。 */
  async start(): Promise<void> {
    this.restoring = this.restore()
    await this.restoring
    this.restoring = undefined
    if (this.stopped) return
    this.unsubscribe = this.deps.onStatus((sessionId) => {
      if ([...this.records.values()].some((r) => r.target === sessionId)) this.kick()
    })
    this.timer = setInterval(() => { if (this.records.size > 0) this.kick() }, this.deps.intervalMs ?? 5000)
    this.timer.unref?.()
    if (this.records.size > 0) this.deps.log(`done-watch 接着盯 ${this.records.size} 条`)
    this.kick()
  }

  private async restore(): Promise<void> {
    await mkdir(this.deps.dir, { recursive: true, mode: 0o700 })
    for (const name of await readdir(this.deps.dir)) {
      if (!name.endsWith('.json')) continue
      const path = join(this.deps.dir, name)
      let record: DoneWatchRecord
      try { record = JSON.parse(await readFile(path, 'utf8')) as DoneWatchRecord }
      catch (error) { this.deps.log(`done-watch 读不了 ${name}：${error instanceof Error ? error.message : String(error)}`); continue }
      if (record.state === 'watching') this.records.set(record.id, { ...record, asked: record.asked ?? [], attempts: record.attempts ?? 0 })
      else if (record.state === 'delivering') {
        const state = parseAgyNotifyTarget(record.notify) === undefined ? 'failed' : 'unconfirmed'
        await this.save({ ...record, state, finishedAt: this.now(), error: '上次送通知时 DSH 退出了，确认不了送到没有，按只送一次不再重送' })
      } else if ((record.finishedAt ?? record.createdAt) < this.now() - KEEP_FINISHED_MS) await rm(path, { force: true })
    }
    await this.mergeDuplicates()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== undefined) clearInterval(this.timer)
    this.unsubscribe?.()
  }

  list(): DoneWatchRecord[] {
    return [...this.records.values()]
  }

  /** 复用仍在等待任务结束的监听，保留它的起点。 */
  async add(input: { target: string; notify: string; since: number; targetTitle?: string }): Promise<DoneWatchRecord & { reused?: boolean }> {
    if (this.restoring !== undefined) await this.restoring
    const key = `${input.target}\0${input.notify}`
    for (let inflight = this.adding.get(key); inflight !== undefined; inflight = this.adding.get(key)) {
      await inflight
    }
    const existing = this.pendingFor(input.target, input.notify)
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
    return [...this.records.values()]
      .filter((r) => r.target === target && r.notify === notify && r.state === 'watching' && r.outcome === undefined)
      .sort((a, b) => a.createdAt - b.createdAt)[0]
  }

  /** 读回的记录里同一目标、同一通知对象有多条在等的，只留最早一条，其余标成 merged。 */
  private async mergeDuplicates(): Promise<void> {
    for (const record of [...this.records.values()]) {
      if (record.outcome !== undefined) continue
      const keep = this.pendingFor(record.target, record.notify)
      if (keep === undefined || keep.id === record.id) continue
      if (record.asked.some((key) => !keep.asked.includes(key))) {
        const asked = [...new Set([...keep.asked, ...record.asked])]
        await this.save({ ...keep, asked })
        keep.asked = asked
      }
      await this.save({ ...record, state: 'merged', mergedInto: keep.id, finishedAt: this.now() })
      this.records.delete(record.id)
      this.deps.log(`done-watch ${record.id} merged into ${keep.id}`)
    }
  }

  path(id: string): string {
    return join(this.deps.dir, `${id}.json`)
  }

  private async save(record: DoneWatchRecord): Promise<void> {
    const tmp = join(this.deps.dir, `.${record.id}.${randomUUID()}.tmp`)
    try {
      await writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
      await rename(tmp, this.path(record.id))
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  }

  /** 状态变化和定时器都走这里；同一时间只跑一遍，跑的时候来的请求合并成下一遍。 */
  kick(): void {
    if (this.stopped || this.restoring !== undefined) return
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

  /** 查一次，送完或放弃后返回 true。 */
  async step(record: DoneWatchRecord): Promise<boolean> {
    if (record.state === 'delivering') return false
    if (record.state !== 'watching') {
      if (this.records.has(record.id)) await this.finish(record)
      return true
    }
    const memo = this.memos.get(record.id) ?? {}
    this.memos.set(record.id, memo)
    let outcome: CommandResult | 'gone' | undefined
    try { outcome = await this.deps.check(record.target, record.since, memo) }
    catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 'not-found') throw error
      outcome = 'gone'
    }
    if (outcome === undefined || (outcome !== 'gone' && (outcome.status === 'running' || outcome.status === 'timeout'))) return false
    const agyTarget = parseAgyNotifyTarget(record.notify) !== undefined
    if (outcome !== 'gone' && !agyTarget && this.deps.title !== undefined) {
      const title = await this.deps.title(record.target).catch(() => undefined)
      if (title !== undefined && title.trim() !== '') record.targetTitle = title
    }
    if (outcome !== 'gone' && outcome.status === 'waiting-input') {
      const fresh = questionKeys(outcome).filter((k) => !record.asked.includes(k))
      if (fresh.length === 0) return false
      if (agyTarget) {
        await this.deliverAgyQuestion(record, fresh)
        return false
      }
      const { text, summary } = questionNotice(record, outcome)
      try {
        await this.deps.deliver(record.notify, text, summary)
      } catch (error) {
        if ((error as { unconfirmed?: unknown } | null)?.unconfirmed === true) {
          record.asked.push(...fresh)
          await this.save(record)
          this.deps.log(`done-watch ${record.id} 提问通知已提交但收件未确认，不再重送：${error instanceof Error ? error.message : String(error)}`)
          return false
        }
        throw error
      }
      record.asked.push(...fresh)
      await this.save(record)
      this.deps.log(`done-watch ${record.id} asked ${fresh.join(',')}`)
      return false
    }
    const notice = agyTarget ? agyFinalNotice(record, outcome) : finalNotice(record, outcome)
    record.state = 'delivering'
    record.outcome = notice.outcome
    try {
      await this.save(record)
    } catch (error) {
      record.state = 'watching'
      throw error
    }
    try {
      await this.deps.deliver(record.notify, notice.text, notice.summary)
      record.state = 'delivered'
      record.finishedAt = this.now()
      delete record.error
    } catch (error) {
      record.attempts++
      record.error = error instanceof Error ? error.message : String(error)
      const permanent = (error as { permanent?: unknown } | null)?.permanent === true
      const unconfirmed = agyTarget
        ? !(error instanceof AgyDeliveryError) || error.unconfirmed
        : (error as { unconfirmed?: unknown } | null)?.unconfirmed === true
      if (unconfirmed) {
        record.state = 'unconfirmed'
        record.finishedAt = this.now()
      } else if (!permanent && record.attempts < MAX_ATTEMPTS) {
        record.state = 'watching'
        await this.save(record)
        this.deps.log(`done-watch ${record.id} 送通知失败（第 ${record.attempts} 次），稍后再试：${record.error}`)
        return false
      } else {
        record.state = 'failed'
        record.finishedAt = this.now()
      }
    }
    await this.finish(record)
    return true
  }

  private async deliverAgyQuestion(record: DoneWatchRecord, fresh: string[]): Promise<void> {
    const previous = record.asked
    const asked = [...previous, ...fresh]
    await this.save({ ...record, asked })
    record.asked = asked
    const { text, summary } = agyQuestionNotice(record)
    try {
      await this.deps.deliver(record.notify, text, summary)
      this.deps.log(`done-watch ${record.id} asked ${fresh.join(',')}`)
    } catch (error) {
      if (error instanceof AgyDeliveryError && !error.unconfirmed && !error.permanent) {
        await this.save({ ...record, asked: previous })
        record.asked = previous
        throw error
      }
      const detail = error instanceof Error ? error.message : String(error)
      const status = error instanceof AgyDeliveryError && error.permanent ? '永久拒绝' : '收件未确认'
      this.deps.log(`done-watch ${record.id} 提问通知${status}，不再重送：${detail}`)
    }
  }

  private async finish(record: DoneWatchRecord): Promise<void> {
    await this.save(record)
    this.records.delete(record.id)
    this.memos.delete(record.id)
    this.deps.log(`done-watch ${record.id} ${record.state} outcome=${record.outcome}${record.error === undefined ? '' : ` error=${record.error}`}`)
  }
}
