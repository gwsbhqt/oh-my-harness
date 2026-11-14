/**
 * 两档模型挑选：档里有哪些模型、每家看哪几个额度窗口、保留线，都来自 模型额度服务 的档位文件
 * （`$DSH_HOME/preferences.json` 的 `modelTiers` 段，设置里「默认模型与档位」一页可改）。
 * 装有模型额度服务时直接调用它的挑选和判断接口；这里的计算只供未安装该服务的独立公开安装使用。
 * 只挑模型，不碰推理等级——切模型后等级由 模型额度服务 按这个模型上次用的值自动带上。
 *
 * 命令行的档位名沿用 `normal`（主力档）和 `fast`（轻量档）。
 *
 * 判断分两步：
 *   1. 门槛：看的窗口里任何一个已经用光、或剩余低于保留线，这个模型不可用。额度查不到只算警告，照样按顺序用。
 *   2. 按档位文件里的顺序挑，额度紧的往后排（用户 2026-10-12 定：「除非很少，否则按优先级来挑」）。
 *      额度紧 = 某个窗口照现在的速度撑不到重置，而且剩余不到一半（同 模型额度服务 的 riskyWindows）。
 *      几个都紧时，「余量」（剩余 − 按时间进度该剩多少，按权重加权平均）大的先用。
 *
 * 纯计算，不碰网络，方便测试。
 *
 * @module
 */

export type Tier = 'normal' | 'fast'

/** 剩余到这个百分比以下、又照现在的速度撑不到重置，才算额度紧（同 模型额度服务 的 RISKY_LEFT）。 */
export const TIGHT_LEFT_PERCENT = 50

/** 模型额度服务 报告里我们用到的部分。 */
export interface UsageWindowLike {
  key: string
  label: string
  kind?: string
  left: number
  expectedLeft?: number
  resetsAt?: number
  windowSeconds?: number
  runsOut?: number
  scope?: string
}

export interface UsageProviderLike {
  id: string
  name: string
  ok: boolean
  error?: string
  /** 模型额度服务 给的修复办法（例如 `claude auth login`）。 */
  hint?: string
  windows: UsageWindowLike[]
}

export interface UsageReportLike {
  fetchedAt: number
  stale?: boolean
  providers: UsageProviderLike[]
}

export interface Candidate {
  /** DSH 的模型路由 provider，例如 `claude`、`kimi-coding`。 */
  provider: string
  model: string
  /** 模型额度服务 里对应的那一家，例如 `claude`、`kimi`。 */
  quota: string
  /** 看哪几个窗口、各占多少权重（标签按 模型额度服务：`7d`、`30d`）。 */
  windows: Record<string, number>
  /** 档位文件没给这家写规则，`windows` 是默认权重：打分时按报告里实际有的窗口取（同 模型额度服务 的 ruleWindows）。 */
  defaultWindows?: true
}

export interface TierTable {
  normal: Candidate[]
  fast: Candidate[]
}

/** 模型额度服务 的档位文件内容（`modelTiers` 服务的 `document()`）里用到的部分。 */
export interface SharedTiersLike {
  tiers: { main: { provider: string; model: string }[]; light: { provider: string; model: string }[] }
  quotas: Record<string, { quota: string; windows: Record<string, number> }>
  reservePercent: number
}

/** 没写规则的订阅看哪几个窗口：有 7d 看 7d，有 30d 也看且权重更高（同 模型额度服务 的 DEFAULT_WINDOW_WEIGHTS）。 */
export const DEFAULT_WINDOW_WEIGHTS: Record<string, number> = { '7d': 1, '30d': 2 }

/**
 * 把共用档位换成这里的候选表：主力档 → normal，轻量档 → fast。
 * Configured relay providers use the model id prefix as quota source; other providers require a quota rule.
 */
export function fromShared(doc: SharedTiersLike, quotaFromModelPrefix: readonly string[] = []): TierTable {
  const toCandidate = (m: { provider: string; model: string }): Candidate => {
    const key = `${m.provider}/${m.model}`
    const slash = m.model.indexOf('/')
    const source = quotaFromModelPrefix.includes(m.provider) && slash > 0 ? m.model.slice(0, slash) : undefined
    const rule = doc.quotas[key] ?? doc.quotas[source ?? m.provider]
    if (rule !== undefined) return { provider: m.provider, model: m.model, quota: rule.quota, windows: { ...rule.windows } }
    if (source !== undefined) return { provider: m.provider, model: m.model, quota: source, windows: { ...DEFAULT_WINDOW_WEIGHTS }, defaultWindows: true }
    return { provider: m.provider, model: m.model, quota: m.provider, windows: {} }
  }
  return { normal: doc.tiers.main.map(toCandidate), fast: doc.tiers.light.map(toCandidate) }
}

export interface ConfiguredTiers { normal: readonly string[]; fast: readonly string[] }

/** Resolve the shared tier document first, or the plugin's explicit local lists. */
export function resolveModelTiers(doc: SharedTiersLike | undefined, local: ConfiguredTiers,
  prefixes: readonly string[] = []): { tiers: TierTable; reservePercent: number; tiersError?: string } {
  if (doc !== undefined) return { tiers: fromShared(doc, prefixes), reservePercent: doc.reservePercent }
  const candidate = (route: string): Candidate => {
    const slash = route.indexOf('/')
    if (slash < 1 || slash === route.length - 1) throw new Error(`Invalid tier route ${JSON.stringify(route)}; use provider/model`)
    const provider = route.slice(0, slash), model = route.slice(slash + 1)
    const modelSlash = model.indexOf('/')
    const quota = prefixes.includes(provider) && modelSlash > 0 ? model.slice(0, modelSlash) : provider
    return { provider, model, quota, windows: { ...DEFAULT_WINDOW_WEIGHTS }, defaultWindows: true }
  }
  const tiers = { normal: local.normal.map(candidate), fast: local.fast.map(candidate) }
  return { tiers, reservePercent: 10, ...(tiers.normal.length || tiers.fast.length ? {} : {
    tiersError: '没配置档位：配置 dsh-control 的 tiers.normal / tiers.fast，或安装并配置 模型额度服务 的模型档位。',
  }) }
}

export interface WindowView {
  label: string
  /** 能用但要当心（例如照现在的速度会在重置前用光），不排除，只扣分。 */
  warning?: string
  weight: number
  left?: number
  expectedLeft?: number
  /** 剩余 − 基准线：正数是省下的，负数是超支的。 */
  margin?: number
  resetsAt?: number
  runsOut?: number
  problem?: string
}

export interface Verdict {
  provider: string
  model: string
  quota?: string
  tier: Tier
  rank: number
  /** 在模型目录里有没有（没配凭据、服务商挂了就没有）。 */
  inCatalog: boolean
  usable: boolean
  /** 不可用的原因，人话。 */
  reasons: string[]
  /** 能用但要当心的地方。 */
  warnings: string[]
  /** 加权余量：几个都额度紧时，越大越先用。 */
  score?: number
  /** 额度紧：某个窗口照现在的速度撑不到重置，而且剩余不到一半。可用，但排到不紧的后面。 */
  tight?: boolean
  routingGroup?: boolean
  renamedFrom?: string
  windows: WindowView[]
}

export interface PickResult {
  tier: Tier
  chosen?: Verdict
  candidates: Verdict[]
  /** 全档不可用时，最早哪个窗口重置（epoch ms）。 */
  earliestReset?: number
  quotaFetchedAt?: number
  quotaStale?: boolean
  ordered?: Verdict[]
  renamed?: { from: string; to: string }[]
}

export type SharedTier = 'main' | 'light'
export type SharedVerdict = Omit<Verdict, 'tier'> & { tier: SharedTier }
export type SharedPickResult = Omit<PickResult, 'tier' | 'chosen' | 'candidates' | 'ordered'> & {
  tier: SharedTier
  chosen?: SharedVerdict
  candidates: SharedVerdict[]
  ordered: SharedVerdict[]
}
export interface ModelJudgement { tier: Tier; verdict: Verdict; exhausted: boolean }

/** 可选 modelTiers 服务已有接口的公开结构描述，不依赖它的实现或安装。 */
export interface ModelTiersLike {
  pick(tier: SharedTier): Promise<SharedPickResult>
  judgeModel(provider: string, model: string): Promise<{ tier: SharedTier; verdict: SharedVerdict; exhausted: boolean } | undefined>
}

export function publicTier(tier: SharedTier): Tier { return tier === 'main' ? 'normal' : 'fast' }

export function fromSharedPick(result: SharedPickResult): PickResult {
  const { chosen, ...rest } = result
  const converted = new Map<SharedVerdict, Verdict>()
  const verdict = (v: SharedVerdict): Verdict => {
    let found = converted.get(v)
    if (found === undefined) { found = { ...v, tier: publicTier(v.tier) }; converted.set(v, found) }
    return found
  }
  return {
    ...rest, tier: publicTier(result.tier), candidates: result.candidates.map(verdict), ordered: result.ordered.map(verdict),
    ...(chosen === undefined ? {} : { chosen: verdict(chosen) }),
  }
}

export interface PickOptions {
  /** 剩余低于这个百分比就不用。 */
  reservePercent: number
  now: number
  /** 模型目录里有的 `provider/model`；不给就不查目录。 */
  catalog?: ReadonlySet<string>
  /** 这台机器上最近调用失败、正在暂停的模型 → 原因（来自 模型额度服务）。 */
  skip?: ReadonlyMap<string, string>
}

function findWindow(provider: UsageProviderLike, label: string): UsageWindowLike | undefined {
  return provider.windows.find((w) => w.label === label && w.scope !== 'model' && (w.kind === undefined || w.kind === 'ratio'))
}

function scoredWindows(candidate: Candidate, provider: UsageProviderLike | undefined): Record<string, number> {
  if (candidate.defaultWindows !== true || provider === undefined) return candidate.windows
  const labels = provider.windows.filter((w) => w.scope !== 'model' && (w.kind === undefined || w.kind === 'ratio')).map((w) => w.label)
  const preferred = Object.entries(candidate.windows).filter(([label]) => labels.includes(label))
  return Object.fromEntries(preferred.length > 0 ? preferred : labels.map((label) => [label, 1]))
}

export function routeKey(provider: string, model: string): string {
  return `${provider}/${model}`
}

function pct(n: number): string {
  return `${Math.round(n)}%`
}

export function judge(candidate: Candidate, tier: Tier, rank: number, report: UsageReportLike | undefined, options: PickOptions): Verdict {
  const reasons: string[] = []
  const warnings: string[] = []
  const windows: WindowView[] = []
  const inCatalog = options.catalog === undefined || options.catalog.has(routeKey(candidate.provider, candidate.model))
  if (!inCatalog) reasons.push('不在共用模型列表里（这台机器没登录、没配钥匙、内网不通，或这个模型已下线）')
  const paused = options.skip?.get(routeKey(candidate.provider, candidate.model))
  if (paused !== undefined) reasons.push(paused)
  if (Object.keys(candidate.windows).length === 0) reasons.push(`没有 ${candidate.provider} 的额度规则，不知道该看哪家额度`)

  // 额度查不到不等于不能用（查额度和发请求是两回事），照样按顺序用。和 模型额度服务 同一条规则。
  const matches = report?.providers.filter((p) => p.id === candidate.quota) ?? []
  const provider = matches.length === 1 ? matches[0] : undefined
  if (report === undefined) {
    warnings.push('拿不到额度报告（模型额度服务 没装或没加载），看不出额度紧不紧，照顺序用')
  } else if (matches.length > 1) {
    warnings.push(`${candidate.quota} 有多个账号，路由未指定本会话使用哪一个，额度不合并、不猜测，照顺序用`)
  } else if (provider === undefined) {
    warnings.push(`额度报告里没有 ${candidate.quota}，看不出额度紧不紧，照顺序用`)
  } else if (!provider.ok) {
    warnings.push(`${provider.name} 额度查不到（${provider.error ?? '未知原因'}），看不出额度紧不紧，照顺序用`)
  }

  let weighted = 0
  let totalWeight = 0
  let tight = false
  for (const [label, weight] of Object.entries(scoredWindows(candidate, provider))) {
    const view: WindowView = { label, weight }
    windows.push(view)
    if (provider === undefined || !provider.ok) continue
    const w = findWindow(provider, label)
    if (w === undefined) {
      view.warning = '报告里没有这个窗口'
      warnings.push(`${provider.name} 没有 ${label} 窗口，这一项不计分`)
      continue
    }
    view.left = w.left
    if (w.expectedLeft !== undefined) view.expectedLeft = w.expectedLeft
    if (w.resetsAt !== undefined) view.resetsAt = w.resetsAt
    if (w.runsOut !== undefined) view.runsOut = w.runsOut
    const margin = w.expectedLeft === undefined ? w.left - 50 : w.left - w.expectedLeft
    view.margin = margin
    const resetPassed = w.resetsAt !== undefined && w.resetsAt <= options.now
    if (!resetPassed) {
      if (w.left <= 0) {
        view.problem = '已用光'
        reasons.push(`${label} 已用光${w.resetsAt === undefined ? '' : `，${clock(w.resetsAt)} 重置`}`)
      } else if (w.left < options.reservePercent) {
        view.problem = '低于保留线'
        reasons.push(`${label} 只剩 ${pct(w.left)}，低于保留线 ${pct(options.reservePercent)}`)
      } else if (w.runsOut !== undefined && (w.resetsAt === undefined || w.runsOut < w.resetsAt)) {
        view.warning = '会提前用光'
        if (w.left <= TIGHT_LEFT_PERCENT) {
          tight = true
          warnings.push(`${label} 只剩 ${pct(w.left)}，照现在的速度 ${clock(w.runsOut)} 用光，早于重置，排到后面`)
        } else warnings.push(`${label} 照现在的速度 ${clock(w.runsOut)} 用光，早于重置`)
      }
    }
    weighted += margin * weight
    totalWeight += weight
  }
  const usable = reasons.length === 0
  return {
    provider: candidate.provider,
    model: candidate.model,
    quota: candidate.quota,
    tier,
    rank,
    inCatalog,
    usable,
    reasons,
    warnings,
    ...(totalWeight > 0 ? { score: weighted / totalWeight } : {}),
    ...(tight ? { tight: true } : {}),
    windows,
  }
}

export function pick(tier: Tier, tiers: TierTable, report: UsageReportLike | undefined, options: PickOptions): PickResult {
  const candidates = tiers[tier].map((c, i) => judge(c, tier, i, report, options))
  const usable = candidates.filter((v) => v.usable)
  const roomy = usable.filter((v) => v.tight !== true)
  const tight = usable.filter((v) => v.tight === true).sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || a.rank - b.rank)
  const chosen = [...roomy, ...tight][0]
  const resets = candidates.flatMap((v) => v.windows.filter((w) => w.problem !== undefined && w.resetsAt !== undefined && w.resetsAt > options.now).map((w) => w.resetsAt!))
  return {
    tier,
    ...(chosen === undefined ? {} : { chosen }),
    candidates,
    ...(chosen === undefined && resets.length > 0 ? { earliestReset: Math.min(...resets) } : {}),
    ...(report === undefined ? {} : { quotaFetchedAt: report.fetchedAt }),
    ...(report?.stale === true ? { quotaStale: true } : {}),
  }
}

/** 某个模型当前在哪一档（不在任何一档返回 undefined）。 */
export function tierOf(tiers: TierTable, provider: string, model: string): { tier: Tier; candidate: Candidate } | undefined {
  for (const tier of ['normal', 'fast'] as const) {
    const candidate = tiers[tier].find((c) => c.provider === provider && c.model === model)
    if (candidate !== undefined) return { tier, candidate }
  }
  return undefined
}

export function clock(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function windowLine(w: WindowView): string {
  if (w.left === undefined) return `${w.label} ${w.problem ?? '无数据'}`
  const margin = w.margin === undefined ? '' : w.margin >= 0 ? ` 省${pct(w.margin)}` : ` 超${pct(-w.margin)}`
  const reset = w.resetsAt === undefined ? '' : ` ${clock(w.resetsAt)}重置`
  const flag = w.problem ?? w.warning
  return `${w.label} 剩${pct(w.left)}${margin}${reset}${flag === undefined ? '' : ` [${flag}]`}`
}

export function verdictLine(v: Verdict): string {
  const head = `${routeKey(v.provider, v.model)}`
  const body = v.windows.map(windowLine).join('，')
  const tail = v.usable ? (v.warnings.length === 0 ? '' : ` —— 注意：${v.warnings.join('；')}`) : ` —— 不可用：${v.reasons.join('；')}`
  return `${head}  ${body}${tail}`
}
