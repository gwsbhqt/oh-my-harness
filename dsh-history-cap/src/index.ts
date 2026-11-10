import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-history-cap'
export const inject = ['sessionController']
export const DEFAULT_MAX_HISTORY_RECORDS = 1000

export interface HistoryPage {
  readonly records: readonly unknown[]
  readonly hasMore: boolean
  readonly [key: string]: unknown
}

export type FollowFrame = { readonly type: string; readonly [key: string]: unknown }

export interface SessionHistoryService {
  page(request: unknown, signal?: AbortSignal): Promise<HistoryPage>
  events(request: unknown, signal?: AbortSignal): Promise<HistoryPage>
  follow(request: unknown, signal?: AbortSignal): AsyncIterable<FollowFrame>
}

export function capRecords<T extends HistoryPage>(page: T, maxRecords = DEFAULT_MAX_HISTORY_RECORDS): T {
  if (page.records.length <= maxRecords) return page
  return { ...page, records: page.records.slice(-maxRecords), hasMore: true }
}

// 打开会话走 follow：第一帧快照带着整轮历史，只截它；后续增量原样放过。
export async function* capFollowFrames(
  frames: AsyncIterable<FollowFrame>,
  maxRecords = DEFAULT_MAX_HISTORY_RECORDS,
): AsyncGenerator<FollowFrame> {
  for await (const frame of frames) {
    yield frame.type === 'snapshot' ? capRecords(frame as unknown as HistoryPage & FollowFrame, maxRecords) : frame
  }
}

type Method = (this: unknown, ...args: unknown[]) => unknown

function inherited(service: object, key: string): Method {
  const method = Reflect.get(Object.getPrototypeOf(service) as object, key) as unknown
  if (typeof method !== 'function') throw new Error(`sessionController.${key} 不存在`)
  return method as Method
}

// 网关每次调用都从服务上现取方法，所以在实例上放同名方法即可生效；原方法总从原型取，热加载不会叠层。
export function patchSessionHistory(service: SessionHistoryService, maxRecords = DEFAULT_MAX_HISTORY_RECORDS): () => void {
  const target = service as unknown as Record<string, unknown>
  const installed: Record<string, Method> = {}
  for (const key of ['page', 'events'] as const) {
    const original = inherited(service, key)
    installed[key] = async function (this: unknown, ...args: unknown[]) {
      return capRecords(await (original.apply(this, args) as Promise<HistoryPage>), maxRecords)
    }
  }
  const follow = inherited(service, 'follow')
  installed.follow = function (this: unknown, ...args: unknown[]) {
    return capFollowFrames(follow.apply(this, args) as AsyncIterable<FollowFrame>, maxRecords)
  }
  for (const [key, value] of Object.entries(installed)) {
    Object.defineProperty(service, key, { value, writable: true, configurable: true, enumerable: false })
  }
  return () => {
    for (const [key, value] of Object.entries(installed)) {
      if (Object.getOwnPropertyDescriptor(service, key)?.value === value) delete target[key]
    }
  }
}

export function apply(ctx: Context): void {
  const service = (ctx as unknown as { sessionController: SessionHistoryService }).sessionController
  ctx.effect(() => patchSessionHistory(service), 'dsh-history-cap: session history')
}
