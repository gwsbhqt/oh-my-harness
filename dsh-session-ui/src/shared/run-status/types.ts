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

/**
 * 一次模型请求的分段用时。请求结束时先记下 DSH 这边的总时长（state 为 pending），
 * 再按回复编号去 magpie 的请求记录里找这一次，拆成上传、等首字、返回。
 * 请求进行中没法拆：上传完的时刻只有 magpie 知道，它要等请求结束才写进记录。
 */
export interface RequestTiming {
  /** 回复编号，DSH 和 magpie 两边都记着它，靠它对上同一次请求。 */
  readonly responseId: string
  readonly step?: number
  readonly model?: string
  /** DSH 这边从发出请求到收完回复。 */
  readonly totalMs: number
  readonly end: number
  /** pending：还在等 magpie 的记录；ok：已拆好；missing：记录里找不到这一次；error：读不到 magpie。 */
  readonly state: 'pending' | 'ok' | 'missing' | 'error'
  /** 上传：magpie 把请求完整交给模型服务商之前用掉的时间，含 magpie 自己处理和失败重试。缺这项说明这条线路 magpie 不记上传完的时刻。 */
  readonly uploadMs?: number
  /** 等首字：上传完到第一个字；没有上传那项时，是发出到第一个字。 */
  readonly firstTokenMs?: number
  /** 返回：第一个字到收完。 */
  readonly returnMs?: number
  /** 上传里 magpie 失败重试用掉的部分。 */
  readonly retriedMs?: number
  /** magpie 记录之外的时间：DSH 到 magpie 这一来一回，至少 1 秒才记。 */
  readonly outsideMs?: number
  readonly note?: string
}

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
  /** 最近几次走 magpie 的模型请求，旧的在前；跨轮保留。 */
  readonly requests?: readonly RequestTiming[]
}

export const STATE_PATH = '/dsh-run-status/state'
