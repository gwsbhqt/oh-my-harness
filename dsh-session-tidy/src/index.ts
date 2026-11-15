/**
 * dsh-session-tidy 宿主半：一键把某个工作区里“没用”的会话批量归档。
 *
 * 一次操作只在宿主实现一份（runTidy），暴露给三处入口：
 * - 工作区「…」菜单项，经 /api/session-tidy.tidy 调它；
 * - agent 用 tidy_workspace_sessions 工具调它。
 *
 * 判定交给 Jev（Typesafe 的“是非概率”模型）：每条会话带上标题、创建时间、多久没用、第一段用户消息，
 * 问“是不是一次性的测试/临时/调试会话”，概率 ≥ JUNK_THRESHOLD 就归档。真实对照里，
 * 只给标题会把「…合并验收（主控）」这类正在推进的会话误判成垃圾，带上第一段消息后能干净分开，
 * 所以第一段消息是必需的输入（截 300 字）。
 *
 * 正在内存里的（打开着 / 在跑，含当前会话）、子代理、置顶、已归档的会话永不处理。
 * Jev 没配 key 或某条调用失败时，该条保留（调用失败不归档）；完全没 key 时退回原来的纯规则口径。
 * 归档走宿主正式的 workspaceRegistry.archiveSession，可撤销（unarchive）。
 * 支持 dryRun：只预览将被归档的清单，不真正归档。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { HttpJev, type JevAsker, type NoulQuestion } from './jev.ts'
import { isJunkTitle } from './rules.ts'
import z from '@deepseek-ai/schemastery'
import { live } from '../../tooling/runtime/live.mjs'

export const name = 'dsh-session-tidy'
export const inject = ['tools', 'sessionQuery', 'workspaceRegistry', 'connection']

/** volatile 配置：路由和工具每次现读，设置页改完不用重启。地址和 key 引用都不写死。 */
export const Config = z.object({
  /** 取 Jev key 的凭据引用名（不能填钥匙本身）。取不到时退回纯规则兜底。 */
  apiKeyRef: z.string().default('TYPESAFE_API_KEY').volatile(),
  /** Jev 的完整请求端点（含 /systemone）。 */
  baseUrl: z.string().default('https://api.typesafe.ai/v1/systemone').volatile(),
  /** Jev 模型名。 */
  model: z.string().default('jev-latest').volatile(),
})

export type ConfigCells = ReturnType<typeof Config>
export interface SessionTidyConfig {
  readonly apiKeyRef: string
  readonly baseUrl: string
  readonly model: string
}

/** 把 volatile 单元格解析成普通值快照。 */
export function resolveConfig(config: ConfigCells): SessionTidyConfig {
  const text = (cell: unknown): string => {
    const value = live(cell as never)
    return typeof value === 'string' ? value : ''
  }
  return { apiKeyRef: text(config.apiKeyRef), baseUrl: text(config.baseUrl), model: text(config.model) }
}

type Ctx = Context & Record<string, any>

export interface TidyItem {
  sessionId: string
  title: string
  /** 归档原因（用于预览里说明为什么收它）。 */
  reason?: string
  /** 距最后一次用户消息多少天。 */
  ageDays?: number
  /** Jev 给的“无用”概率（0~1）。 */
  score?: number
}

/** Jev 判为“无用”的主门槛。真实 17 条 + 24 条合成数据上：无用最低 0.61，有用最高 0.54，取中间。 */
const JUNK_THRESHOLD = 0.58
/** 补强：标题/第一段明显是“一次性测试/验收”，且不像仍在进行的工作时，即使 junk 分数在边缘也收。 */
const TESTLIKE_THRESHOLD = 0.9
const ONGOING_KEEP_THRESHOLD = 0.5
const TESTLIKE_MIN_JUNK = 0.35
/** 第一段用户消息最多带多少字给 Jev（截断不影响判断，见插件手册的校准记录）。 */
const MAX_FIRST_CHARS = 300
const JEV_TIMEOUT_MS = 15_000
const JEV_CONCURRENCY = 6

/** Jev 的题目：一条会话是否是没保留价值的一次性会话，以及两条用于补强的旁证。 */
const JUNK_QUESTION: NoulQuestion = {
  type: 'noul',
  instructions: '这条会话是一次性的测试、临时、调试或顺手试试的会话，事后没有继续保留的价值，可以归档。',
}
const TEST_QUESTION: NoulQuestion = {
  type: 'noul',
  instructions: '标题或第一段消息显示这是一次性的测试、验收、验证、联调类会话，而不是一件持续的工作。',
}
const ONGOING_QUESTION: NoulQuestion = {
  type: 'noul',
  instructions: '这条会话对应的是一件仍在进行、以后还要继续使用的实际工作。',
}

/** 标题正常、但超过这么多天没有任何用户消息，也当没用的收起来（仅在没配 Jev key 时作为兜底）。 */
const MAX_IDLE_DAYS = 3
const DAY_MS = 24 * 60 * 60 * 1000

interface CredentialsLike {
  resolve(ref: string): Promise<{ value: string } | undefined>
}

/** 解析 key 引用：先走 credentials 服务，再退回环境变量（照抄 dsh-composer 的做法）。 */
async function resolveApiKey(ctx: Ctx, ref: string): Promise<string> {
  if (ref.length === 0) return ''
  const credentials = (ctx as unknown as { get(name: string): unknown }).get('credentials') as CredentialsLike | undefined
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(ref)
      if (resolved !== undefined && resolved.value.length > 0) return resolved.value
    } catch {
      /* credentials 解析失败就退回环境变量再试一次 */
    }
  }
  return process.env[ref] ?? ''
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((x) => typeof x === 'object' && x !== null && (x as { type?: unknown }).type === 'text')
    .map((x) => String((x as { text?: unknown }).text ?? ''))
    .join('\n')
}

/** 一条 user/message 事件里用户本人说的话；插件通知、目标提示、系统提醒、空消息返回空串。 */
function humanText(data: Record<string, unknown>): string {
  const source = data['source'] as { kind?: unknown } | undefined
  if (source?.kind !== 'user') return ''
  const body = textOf(data['content'])
  if (body.trimStart().startsWith('<system-reminder>') || body.trim() === '') return ''
  return body
}

interface SessionFacts {
  /** 第一段用户消息（截断）。 */
  firstUserMessage: string
  /** 最后一条用户消息的时间；没有则退回创建时间。 */
  lastUserAt: number
}

/** 读一次会话日志，取出第一段用户消息和最后一条用户消息的时间。 */
async function sessionFacts(query: any, id: string, fallbackCreatedAt: number): Promise<SessionFacts> {
  let firstUserMessage = ''
  let lastUserAt = 0
  try {
    const log = await query.readSession(id)
    const events = Array.isArray(log?.events) ? log.events : []
    for (const e of events) {
      if (e?.type !== 'user/message' || typeof e.data !== 'object' || e.data === null) continue
      const body = humanText(e.data as Record<string, unknown>)
      if (body === '') continue
      if (firstUserMessage === '') firstUserMessage = body.slice(0, MAX_FIRST_CHARS)
      if (typeof e.time === 'number' && e.time > lastUserAt) lastUserAt = e.time
    }
  } catch {
    /* 读不到日志就当没有第一段消息、时间退回创建时间 */
  }
  return { firstUserMessage, lastUserAt: lastUserAt > 0 ? lastUserAt : fallbackCreatedAt }
}

/** 小并发地跑一批异步任务，保持输出顺序。 */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i] as T, i)
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker())
  await Promise.all(workers)
  return out
}

export interface TidyReport {
  workspaceTitle: string
  total: number
  archived: TidyItem[]
  skipped: Array<TidyItem & { reason: string }>
  /** true 表示只预览、不真正归档。 */
  dryRun?: boolean
  /** 这次用的是 Jev 判断还是没 key 时的纯规则兜底。 */
  judge?: 'jev' | 'rules'
}
export interface TidyOptions { dryRun?: boolean }
export interface WorkspaceSelector { sessionId?: string; workspaceId?: string }

interface Candidate { sessionId: string; title: string; createdAt: number }
interface Judgement {
  junk: boolean
  reason: string
  ageDays?: number
  score?: number
}

async function runTidy(ctx: Ctx, ws: any, options: TidyOptions, getConfig: () => SessionTidyConfig): Promise<TidyReport> {
  const registry = ctx.workspaceRegistry
  const query = ctx.sessionQuery
  if (registry === undefined || query === undefined) throw new Error('缺少 workspaceRegistry 或 sessionQuery 服务')
  // 工作区 sessionIds 包含历史归档；已归档的跳过。固定会话是用户故意留的，也不动。
  const archivedIds = new Set<string>(((registry as any).archivedSessionIds ?? []) as string[])
  const pinnedIds = new Set<string>(((registry as any).pinnedSessionIds ?? []) as string[])
  const ids: string[] = (([...ws.sessionIds] as string[])).filter((id) => !archivedIds.has(id))

  // 标题（批量；拿不到的当空）
  const titleById = new Map<string, string>()
  try {
    const snaps = await query.readTitleSnapshots(ids)
    for (const r of snaps) {
      if (r.status === 'fulfilled') {
        const t = r.value?.title?.title
        if (typeof t === 'string') titleById.set(r.sessionId, t)
      }
    }
  } catch {
    /* 标题缺失按空处理 */
  }

  // 会话记录：live（打开着/在跑）与子代理会话不动；顺便记下创建时间做兜底
  const live = new Set<string>()
  const subagent = new Set<string>()
  const createdAtById = new Map<string, number>()
  try {
    const records = await query.listSessions()
    for (const rec of records) {
      const header = rec.header ?? {}
      if (typeof header.id === 'string' && typeof header.createdAt === 'number') createdAtById.set(header.id, header.createdAt)
      if (rec.live === true) live.add(header.id)
      if (header.origin === 'subagent') subagent.add(header.id)
    }
  } catch {
    /* 拿不到记录就只靠标题/Idle */
  }

  const skipped: Array<TidyItem & { reason: string }> = []
  const candidates: Candidate[] = []
  for (const id of ids) {
    const title = titleById.get(id) ?? ''
    if (pinnedIds.has(id)) { skipped.push({ sessionId: id, title, reason: '已固定' }); continue }
    if (live.has(id)) { skipped.push({ sessionId: id, title, reason: '打开着或正在运行' }); continue }
    if (subagent.has(id)) { skipped.push({ sessionId: id, title, reason: '子代理会话' }); continue }
    candidates.push({ sessionId: id, title, createdAt: createdAtById.get(id) ?? 0 })
  }

  // Jev 的完整端点、模型、key 引用都来自当前 volatile 配置，不在代码里写死。
  const cfg = getConfig()
  const jevUrl = cfg.baseUrl.trim()
  const apiKey = await resolveApiKey(ctx, cfg.apiKeyRef.trim())
  const model = cfg.model.trim() || 'jev-latest'
  const asker: JevAsker | undefined = apiKey === '' || jevUrl === '' ? undefined : new HttpJev(apiKey, jevUrl, model)

  const judged = await mapLimit(candidates, JEV_CONCURRENCY, async (c): Promise<Judgement> => {
    const facts = await sessionFacts(query, c.sessionId, c.createdAt)
    const idleMs = Math.max(0, Date.now() - facts.lastUserAt)
    const ageDays = Math.floor(idleMs / DAY_MS)

    if (asker === undefined) {
      // 没配 Jev key：退回原来的纯规则口径（标题模板 + 超过 MAX_IDLE_DAYS 天没用）。
      const titleJunk = c.title.trim() === '' || isJunkTitle(c.title)
      if (titleJunk) return { junk: true, reason: '空白或测试会话', ageDays }
      if (idleMs > MAX_IDLE_DAYS * DAY_MS) return { junk: true, reason: `超过 ${MAX_IDLE_DAYS} 天没动（${ageDays} 天）`, ageDays }
      return { junk: false, reason: '最近还在用，保留', ageDays }
    }

    const state = {
      title: c.title,
      createdAt: c.createdAt > 0 ? new Date(c.createdAt).toISOString() : '',
      idleDays: ageDays,
      firstUserMessage: facts.firstUserMessage,
    }
    try {
      const scores = await asker.ask(
        state,
        { junk: JUNK_QUESTION, testlike: TEST_QUESTION, ongoing: ONGOING_QUESTION },
        AbortSignal.timeout(JEV_TIMEOUT_MS),
      )
      const score = scores.junk
      if (typeof score !== 'number' || !Number.isFinite(score)) throw new Error('Jev 没给出 junk 概率')
      const testlike = typeof scores.testlike === 'number' ? scores.testlike : 0
      const ongoing = typeof scores.ongoing === 'number' ? scores.ongoing : 1
      const testOverride = testlike >= TESTLIKE_THRESHOLD && ongoing < ONGOING_KEEP_THRESHOLD && score >= TESTLIKE_MIN_JUNK
      if (score >= JUNK_THRESHOLD) {
        return { junk: true, reason: `Jev 判为无用（${score.toFixed(2)}）`, ageDays, score }
      }
      if (testOverride) {
        return { junk: true, reason: `Jev 判为一次性测试/验收（test ${testlike.toFixed(2)}，junk ${score.toFixed(2)}）`, ageDays, score }
      }
      return { junk: false, reason: `Jev 认为还有用（${score.toFixed(2)}）`, ageDays, score }
    } catch (error) {
      return { junk: false, reason: `模型判断失败，保留（${String((error as Error)?.message ?? error).slice(0, 60)}）`, ageDays }
    }
  })

  const archived: TidyItem[] = []
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i] as Candidate
    const j = judged[i] as Judgement
    if (!j.junk) { skipped.push({ sessionId: c.sessionId, title: c.title, reason: j.reason }); continue }
    const item: TidyItem = {
      sessionId: c.sessionId,
      title: c.title,
      reason: j.reason,
      ...(j.ageDays === undefined ? {} : { ageDays: j.ageDays }),
      ...(j.score === undefined ? {} : { score: j.score }),
    }
    if (options.dryRun === true) { archived.push(item); continue }
    try {
      await registry.archiveSession(c.sessionId)
      archived.push(item)
    } catch (error) {
      skipped.push({ sessionId: c.sessionId, title: c.title, reason: String((error as Error)?.message ?? error) })
    }
  }

  return {
    workspaceTitle: ws.title ?? ws.path ?? '',
    total: ids.length,
    archived,
    skipped,
    dryRun: options.dryRun === true,
    judge: asker === undefined ? 'rules' : 'jev',
  }
}

function findWorkspace(ctx: Ctx, sel: WorkspaceSelector): any {
  const registry = ctx.workspaceRegistry
  if (registry === undefined) throw new Error('缺少 workspaceRegistry 服务')
  const list = registry.list() as any[]
  if (typeof sel.workspaceId === 'string' && sel.workspaceId !== '') {
    const byId = list.find((w) => w.id === sel.workspaceId)
    if (byId !== undefined) return byId
    throw new Error('找不到该工作区')
  }
  if (typeof sel.sessionId === 'string' && sel.sessionId !== '') {
    const bySession = list.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.includes(sel.sessionId))
    if (bySession !== undefined) return bySession
    throw new Error('这条会话不属于任何工作区')
  }
  throw new Error('缺少会话编号或工作区编号')
}

export async function tidyWorkspace(ctx: Ctx, sessionId: string, options: TidyOptions, getConfig: () => SessionTidyConfig): Promise<TidyReport> {
  return runTidy(ctx, findWorkspace(ctx, { sessionId }), options, getConfig)
}
export async function tidyWorkspaceById(ctx: Ctx, workspaceId: string, options: TidyOptions, getConfig: () => SessionTidyConfig): Promise<TidyReport> {
  return runTidy(ctx, findWorkspace(ctx, { workspaceId }), options, getConfig)
}

/** 客户端按钮/菜单调这个 /api 路由（路径 = /api/<method>）。 */
export function tidyRoute(getCtx: () => Ctx, getConfig: () => SessionTidyConfig) {
  return {
    path: '/api/session-tidy.tidy',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request: Request) => {
      const ct = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (ct !== 'application/json') return new Response('content type must be application/json', { status: 415 })
      let body: any
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      if (typeof body !== 'object' || body === null) return new Response('invalid client request', { status: 400 })
      const rpcId = typeof body.rpcId === 'string' ? body.rpcId : 'invalid-request'
      const reply = (result: unknown) => Response.json({ type: 'server-response', rpcId, result })
      if (body.type !== 'client-request' || body.method !== 'session-tidy.tidy') {
        return new Response('invalid client request', { status: 400 })
      }
      const payload = body.payload ?? {}
      const dryRun = payload.dryRun === true
      const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : ''
      const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId : ''
      if (sessionId === '' && workspaceId === '') return reply({ ok: false, error: '缺少会话编号或工作区编号' })
      try {
        const report = workspaceId !== ''
          ? await tidyWorkspaceById(getCtx(), workspaceId, { dryRun }, getConfig)
          : await tidyWorkspace(getCtx(), sessionId, { dryRun }, getConfig)
        return reply({ ok: true, value: report })
      } catch (error) {
        return reply({ ok: false, error: String((error as Error)?.message ?? error) })
      }
    },
  }
}

function registerTools(ctx: Ctx, getConfig: () => SessionTidyConfig): void {
  const tools = ctx.tools as { register(def: unknown): void } | undefined
  if (tools === undefined) return
  tools.register(
    defineTool({
      name: 'tidy_workspace_sessions',
      description:
        'Archive the useless (one-off test/temp/debug, non-running, non-pinned, non-archived) sessions of the workspace that contains the given session. Each session is judged by the Jev model from its title, creation time, idle days and first user message. Returns which sessions were archived and which were kept and why. Archiving is reversible (unarchive).',
      parameters: {
        session: { type: 'string', required: true, description: 'Any session id in the target workspace (full id or unique prefix).' },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } },
        render: (_args: unknown, value: { text: string }) => [{ type: 'text', text: value.text }],
      },
      isConcurrencySafe: () => false,
      async execute(args: { session: string }) {
        const report = await tidyWorkspace(ctx, args.session, {}, getConfig)
        const lines = [
          `工作区「${report.workspaceTitle}」共 ${report.total} 个会话（判断方式：${report.judge === 'rules' ? '纯规则兜底' : 'Jev 模型'}）。`,
          `已归档 ${report.archived.length} 个：`,
          ...report.archived.slice(0, 50).map((x) => `  - ${x.title || '(无标题)'}（${x.reason ?? '无用'}）[${x.sessionId.slice(0, 18)}]`),
          `保留 ${report.skipped.length} 个：`,
          ...report.skipped.slice(0, 50).map((x) => `  - ${x.title || '(无标题)'}：${x.reason}`),
        ]
        return { text: lines.join('\n') }
      },
    }),
  )
}

export function apply(ctx: Ctx, config: ConfigCells): void {
  const logger = ctx.logger?.(name) ?? console
  const getConfig = (): SessionTidyConfig => resolveConfig(config)
  const register = (ctx as any).connection?.fetch?.register
  if (typeof register === 'function') {
    ctx.effect(() => register(tidyRoute(() => ctx, getConfig)), 'dsh-session-tidy: tidy route')
  } else {
    logger.warn?.('connection.fetch 不可用：按钮点了没法通知宿主')
  }
  registerTools(ctx, getConfig)
}
