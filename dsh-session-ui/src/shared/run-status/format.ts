/** 纯函数：时长和汇总怎么说。网页半和测试共用。 */
import type { BlockerKind, GatewaySpeed, RunSnapshot } from './types.ts'

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

/** 和宿主自带统计卡一样的时长写法：「3小时10分5秒」「16分28秒」「12秒」，不留空格。 */
export function formatStatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor(total / 60) % 60
  const s = total % 60
  return `${h > 0 ? `${h}小时` : ''}${total >= 60 ? `${m}分` : ''}${s}秒`
}

interface GatewaySpeedLine { key: string; label: string; value: string; title?: string }

export function gatewaySpeedLines(stats: GatewaySpeed | undefined): GatewaySpeedLine[] {
  if (!stats || stats.state === 'unconfigured') return []
  const label = '平均输出速度'
  if (stats.state === 'unavailable') return [{ key: 'gateway', label, value: '暂时读不到' }]
  if (stats.state !== 'ready') return []
  const rows: GatewaySpeedLine[] = []
  if (stats.tps !== null) rows.push({ key: 'gateway', label, value: `${stats.tps} tok/s`,
    title: '按 Magpie 路由页口径，统计网关最近 60 次路由中本会话可实测的输出 token 和生成用时。' })
  if (stats.firstTokenMs != null) rows.push({ key: 'first-token', label: '首字等待',
    value: stats.firstTokenMs >= 60_000 ? formatStatDuration(stats.firstTokenMs) : `${(stats.firstTokenMs / 1000).toFixed(1)} 秒`,
    title: '同一网关窗口中，本会话成功请求从网关收到请求到首个输出信号的中位数。首个信号也可以是推理或工具调用。' })
  return rows
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
