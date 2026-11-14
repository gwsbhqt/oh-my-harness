/** 纯函数：时长和汇总怎么说。网页半和测试共用。 */
import type { BlockerKind, RequestTiming, RunSnapshot } from './types.ts'

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total} 秒`
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m < 60) return s === 0 ? `${m} 分` : `${m} 分 ${s} 秒`
  const h = Math.floor(m / 60)
  return `${h} 小时 ${m % 60} 分`
}

const KIND_NAME: Record<BlockerKind, string> = {
  hook: '插件钩子',
  'wait-user': '等你',
  compaction: '压缩上下文',
  retry: '重试等待',
  tool: '工具和命令',
  'model-wait': '等待响应',
  'model-thinking': '思考中（未提供文字）',
  'model-output': '接收内容',
  prepare: '准备请求',
  between: '步骤衔接',
}

/** 分段用时要看到零点几秒：一分钟内保留一位小数，再长和 formatDuration 一样。 */
export function formatSeconds(ms: number): string {
  if (ms >= 60_000) return formatDuration(ms)
  return `${(Math.max(0, ms) / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`
}

/**
 * 一次请求在详情里那一行怎么说。只留几个数字，长说明不进这一行，
 * 否则每条都带同一句，名字那一窄栏就全被占满。
 */
export function describeRequest(r: RequestTiming): string {
  const head = r.step === undefined ? '' : `第 ${r.step} 步：`
  if (r.state === 'pending') return `${head}请求刚结束，正在向 magpie 要各段用时`
  if (r.state === 'missing') return `${head}magpie 的请求记录里没找到这一次，拆不开`
  if (r.state === 'error') return `${head}读不到 magpie 的请求记录${r.note === undefined ? '' : `（${r.note}）`}`
  if (r.firstTokenMs === undefined) return `${head}${r.note ?? '拆不开'}`
  const parts: string[] = []
  if (r.uploadMs !== undefined) parts.push(`上传 ${formatSeconds(r.uploadMs)}${r.retriedMs === undefined ? '' : `（其中失败重试 ${formatSeconds(r.retriedMs)}）`}`)
  parts.push(r.uploadMs === undefined ? `发出到首字 ${formatSeconds(r.firstTokenMs)}` : `等首字 ${formatSeconds(r.firstTokenMs)}`)
  if (r.returnMs !== undefined) parts.push(`返回 ${formatSeconds(r.returnMs)}`)
  if (r.outsideMs !== undefined) parts.push(`到 magpie 来回 ${formatSeconds(r.outsideMs)}`)
  // 不记上传完的时刻时不再解释「上传算在首字里」：每条都带一遍会把这一栏撑爆，需要时看悬停提示
  return head + parts.join('，')
}

/** 和宿主自带统计卡一样的时长写法：「3小时10分5秒」「16分28秒」「12秒」，不留空格。 */
export function formatStatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor(total / 60) % 60
  const s = total % 60
  return `${h > 0 ? `${h}小时` : ''}${total >= 60 ? `${m}分` : ''}${s}秒`
}

/** 每秒输出多少 token：输出 token 数除以模型总用时，一位小数以内取整。 */
export function formatSpeed(tokens: number, ms: number): string {
  if (ms <= 0) return '0'
  const v = tokens / (ms / 1000)
  return v >= 10 ? String(Math.round(v)) : v.toFixed(1)
}

export function kindName(kind: BlockerKind): string {
  return KIND_NAME[kind]
}

/** 本轮各类用时，加上正在走的那一段，按时长从多到少。各行加起来就是这一轮已经用掉的时间。 */
export function breakdown(snap: RunSnapshot, nowMs: number): Array<{ kind: BlockerKind; name: string; ms: number }> {
  const totals: Partial<Record<BlockerKind, number>> = { ...snap.totals }
  const current = snap.current
  if (current !== undefined) totals[current.kind] = (totals[current.kind] ?? 0) + Math.max(0, nowMs - current.since)
  return (Object.entries(totals) as Array<[BlockerKind, number]>)
    .filter(([, ms]) => ms >= 500)
    .sort((a, b) => b[1] - a[1])
    .map(([kind, ms]) => ({ kind, name: KIND_NAME[kind], ms }))
}
