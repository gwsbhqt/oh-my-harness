/**
 * 旧版「阻塞式」提问的远程应答。
 *
 * DSH 的 `ask_user_question` 默认是 legacy 模式：工具一直等到有人回答，问题只沿 `user-questions/request`
 * 这条事件链转给浏览器，不写进会话投影（`userQuestions` 投影只认 timed 模式），所以从会话列表看不到。
 *
 * 这里在事件链上挂一个监听：记下这个问题，然后照常交给下一环（浏览器卡片），
 * 同时和「远程回答」赛跑——浏览器先答就用浏览器的，`dsh-use answer` 先答就用远程的。
 * 远程先答时，浏览器那一环收到取消（请求的 signal 被我们换成了一个会 abort 的），卡片自动收起。
 *
 * 网页和桌面窗口全关时，下一环当场报 NO_PROVIDER（宿主只给连着的窗口挂转发），远程回答来不及赢。
 * 所以这时不马上失败：再等 `graceMs` 让远程回答，并提醒一次；到点没人答，原样抛出那个 NO_PROVIDER。
 *
 * @module
 */

export interface PendingQuestionItem {
  id: string
  question: string
  header?: string
  detail?: string
  options?: { label: string; description?: string }[]
  multiSelect?: boolean
}

export interface AnswerBatch {
  answers: { id: string; selected: string[]; custom?: string }[]
}

interface Entry {
  key: string
  sessionId: string
  callId?: string
  questions: PendingQuestionItem[]
  askedAt: number
  resolve: (answer: AnswerBatch) => void
}

interface QuestionRequest {
  questions: PendingQuestionItem[]
  agent?: { id?: string }
  signal?: AbortSignal
  wait?: { callId?: string }
}

export interface UnattendedOptions {
  /** 没有窗口接时再等多久（毫秒）；0 = 照宿主原样当场失败。每次提问时现读，改设置即时生效。 */
  graceMs: () => number
  /** 开始等的那一刻调一次，用来提醒用户。 */
  onUnattended: (question: { sessionId: string; questions: PendingQuestionItem[]; graceMs: number }) => void
}

function isNoAnswerer(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'NO_PROVIDER'
}

export class PendingQuestions {
  private readonly entries = new Map<string, Entry>()
  private seq = 0
  private readonly onChange: (sessionId: string) => void
  private readonly unattended: UnattendedOptions

  constructor(onChange: (sessionId: string) => void = () => {}, unattended: UnattendedOptions = { graceMs: () => 0, onUnattended: () => {} }) {
    this.onChange = onChange
    this.unattended = unattended
  }

  /** 列出某会话（或全部）正在等回答的问题。 */
  list(sessionId?: string): { key: string; sessionId: string; callId?: string; questions: PendingQuestionItem[]; askedAt: number }[] {
    return [...this.entries.values()]
      .filter((e) => sessionId === undefined || e.sessionId === sessionId)
      .map(({ resolve: _r, ...rest }) => rest)
  }

  /** 远程回答。返回是否有问题被回答。 */
  answer(sessionId: string, answer: AnswerBatch, key?: string): boolean {
    const entry = [...this.entries.values()].find((e) => e.sessionId === sessionId && (key === undefined || e.key === key || e.callId === key))
    if (entry === undefined) return false
    const ids = new Set(answer.answers.map((a) => a.id))
    if (ids.size !== entry.questions.length || !entry.questions.every((q) => ids.has(q.id))) {
      throw new Error(`回答要逐个覆盖这批的 ${entry.questions.length} 个问题（id：${entry.questions.map((q) => q.id).join('、')}）`)
    }
    entry.resolve(answer)
    return true
  }

  /**
   * `user-questions/request` 的监听。`next` 是事件链的下一环（浏览器卡片 → 没人接时报 NO_PROVIDER）。
   * 返回值就是这次提问的答案。
   */
  listener(request: QuestionRequest, next: () => Promise<AnswerBatch>): Promise<AnswerBatch> {
    const sessionId = request.agent?.id
    if (typeof sessionId !== 'string') return next()
    const key = `q${++this.seq}`
    const remote = Promise.withResolvers<AnswerBatch>()
    const cancelDownstream = new AbortController()
    const entry: Entry = {
      key,
      sessionId,
      ...(request.wait?.callId === undefined ? {} : { callId: request.wait.callId }),
      questions: request.questions.map((q) => ({ ...q })),
      askedAt: Date.now(),
      resolve: remote.resolve,
    }
    this.entries.set(key, entry)
    this.onChange(sessionId)
    const cleanup = () => {
      this.entries.delete(key)
      this.onChange(sessionId)
    }
    // cordis 的 waterfall 里下一环拿到的是同一个 request 对象（next() 不带参数），所以只能就地换掉它的 signal：
    // 远程先答时 abort，浏览器那一环据此收起卡片、宿主转发层撤回这次提问。
    const upstream = request.signal
    request.signal = upstream === undefined ? cancelDownstream.signal : AbortSignal.any([upstream, cancelDownstream.signal])
    const local = next()
    let graceTimer: ReturnType<typeof setTimeout> | undefined
    const localSide = local.then((v) => ({ from: 'local' as const, v }), (error: unknown) => {
      const graceMs = this.unattended.graceMs()
      if (!isNoAnswerer(error) || graceMs <= 0) throw error
      try {
        this.unattended.onUnattended({ sessionId, questions: entry.questions, graceMs })
      } catch { /* 提醒失败不影响等回答 */ }
      return new Promise<never>((_, reject) => { graceTimer = setTimeout(() => reject(error), graceMs) })
    })
    const aborted = new Promise<never>((_, reject) => {
      if (upstream === undefined) return
      const onAbort = () => reject(upstream.reason ?? new Error('question aborted'))
      if (upstream.aborted) onAbort()
      else upstream.addEventListener('abort', onAbort, { once: true })
    })
    return Promise.race([
      localSide,
      remote.promise.then((v) => ({ from: 'remote' as const, v })),
      aborted,
    ]).then((winner) => {
      if (winner.from === 'remote') {
        cancelDownstream.abort(new Error('answered remotely via dsh-use'))
        local.catch(() => {})
      }
      return winner.v
    }).finally(() => {
      clearTimeout(graceTimer)
      cleanup()
    })
  }
}
