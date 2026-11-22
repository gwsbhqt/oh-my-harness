/**
 * 宿主半和网页半共用的快照形状。宿主算好中文说明，网页只负责显示和走秒。
 */

/** 现在卡在哪一类事情上。 */
export type BlockerKind =
  | 'hook' // 某个插件的钩子在处理
  | 'wait-user' // 等你批准或回答
  | 'compaction' // 压缩上下文
  | 'retry' // 模型请求失败，等重试
  | 'tool' // 工具或命令在跑
  | 'model-wait' // 请求已发出，等模型开始响应
  | 'model-thinking' // 已开始思考，上游尚未提供可展示文字
  | 'model-output' // 模型正在往外吐字
  | 'prepare' // 准备发给模型（组装上下文、跑发请求前的钩子）
  | 'between' // 一步结束、下一步还没开始

export interface Blocker {
  readonly kind: BlockerKind
  /** 两三个字的类别：钩子、命令行、等模型…… */
  readonly tag: string
  /** 一句话：卡在什么上。 */
  readonly title: string
  /** 补充：命令原文、失败原因、已输出多少字等。 */
  readonly detail?: string
  /** 这个状态从什么时候开始（毫秒时间戳）。 */
  readonly since: number
  /** 卡在钩子上时，是哪个插件。 */
  readonly plugin?: string
}

/** 本轮已经结束的一段：做了什么、花了多久。 */
export interface Segment {
  readonly kind: BlockerKind
  readonly tag: string
  readonly title: string
  /** 连着几次同一件事合成一条时，ms 是合计。 */
  readonly ms: number
  readonly end: number
  readonly count?: number
}

/** Magpie 路由页的会话平均速度，只有可实测的请求参与平均。 */
export type GatewaySpeed =
  | { readonly state: 'unconfigured' | 'unavailable' }
  | { readonly state: 'ready'; readonly tps: number | null; readonly latestTps: number | null; readonly firstTokenMs: number | null }

export interface RunSnapshot {
  readonly sessionId: string
  /** 宿主当前时间，网页用它校正走秒。 */
  readonly now: number
  readonly running: boolean
  readonly turn?: number
  readonly step?: number
  readonly turnStart?: number
  readonly model?: string
  readonly blocker: Blocker | null
  /**
   * 本轮各类事情累计用时（毫秒），不含正在走的这一段。
   * 按界面显示的那一件切分：同一时刻只算一类，各数加起来等于这一轮的已用时间。
   */
  readonly totals: Readonly<Partial<Record<BlockerKind, number>>>
  /** 正在走的那一段属于哪一类、从何时开始算；网页把它加到 totals 上。 */
  readonly current?: { readonly kind: BlockerKind; readonly since: number }
  /** 本轮最近几段较长的事情，旧的在前。 */
  readonly recent: readonly Segment[]
  /** 插件开始记录时这一轮已经在跑，开头的信息缺了一截。 */
  readonly partial: boolean
}

export const STATE_PATH = '/dsh-run-status/state'
