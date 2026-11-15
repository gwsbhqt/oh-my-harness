/**
 * 快捷回复的页面仓库：数据来自宿主半的 `/api/settings.quickRepliesOverview`、`/api/settings.quickRepliesSave`，
 * 存在 `$DSH_HOME/preferences.json` 的 `quickReplies` 段（不再读 configForms 的 `presets`/`action`）。
 *
 * 打开页面时拉一次，保存后按接口回来的内容更新；手改文件要刷新页面才看得到。
 * 宿主没加载本插件（拿不到 connection）时状态是 `unavailable`。
 */
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { call } from '../rpc.ts'

export interface QuickReplyValue {
  readonly presets: readonly string[]
  readonly action: 'send' | 'insert'
}

export interface QuickReplySnapshot {
  readonly status: 'loading' | 'ready' | 'unavailable'
  readonly writable: boolean
  readonly value: QuickReplyValue
  /** 文件在哪；宿主返回时带上。 */
  readonly path?: string
  /** 文件写错或接口失败时的原因，页面要亮出来。 */
  readonly error?: string
}

export interface QuickReplyStore {
  getSnapshot(): QuickReplySnapshot
  subscribe(listener: () => void): () => void
  set(field: 'presets' | 'action', value: unknown): Promise<boolean>
  /** 整份保存（撤销 / 保存页头用）：一次写回预设和动作。 */
  save(value: QuickReplyValue): Promise<boolean>
  reload(): Promise<void>
}

/** 文件不存在时的默认值（和宿主半的 DEFAULT_DOCUMENT 一致）。 */
export const DEFAULTS: QuickReplyValue = {
  presets: ['继续'],
  action: 'send',
}

interface Overview {
  presets?: unknown
  action?: unknown
  path?: string
  exists?: boolean
  error?: string
}

function strings(value: unknown, fallback: readonly string[]): readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : fallback
}

/** 接口返回的一节内容 → 页面用的值；字段缺失或形状不对就用默认值。 */
export function readValue(section: unknown): QuickReplyValue {
  const record = typeof section === 'object' && section !== null ? section as Record<string, unknown> : {}
  return {
    presets: strings(record['presets'], DEFAULTS.presets),
    action: record['action'] === 'insert' ? 'insert' : 'send',
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function createStore(rpc: ConnectionHandle['rpc'] | undefined): QuickReplyStore {
  let snapshot: QuickReplySnapshot = rpc === undefined
    ? { status: 'unavailable', writable: false, value: DEFAULTS }
    : { status: 'loading', writable: true, value: DEFAULTS }
  const listeners = new Set<() => void>()
  const publish = (next: QuickReplySnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }
  const accept = (data: Overview): void => {
    publish({
      status: 'ready',
      writable: true,
      value: readValue(data),
      ...(typeof data.path === 'string' ? { path: data.path } : {}),
      ...(typeof data.error === 'string' ? { error: data.error } : {}),
    })
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    reload: async () => {
      if (rpc === undefined) return
      try {
        accept(await call<Overview>(rpc, 'quickRepliesOverview', {}))
      } catch (error) {
        publish({ status: 'ready', writable: true, value: DEFAULTS, error: messageOf(error) })
      }
    },
    set: async (field, value) => {
      if (rpc === undefined) return false
      const next = field === 'presets'
        ? { presets: value, action: snapshot.value.action }
        : { presets: snapshot.value.presets, action: value }
      try {
        accept(await call<Overview>(rpc, 'quickRepliesSave', next))
        return true
      } catch {
        return false
      }
    },
    save: async (value) => {
      if (rpc === undefined) return false
      try {
        accept(await call<Overview>(rpc, 'quickRepliesSave', { presets: value.presets, action: value.action }))
        return true
      } catch {
        return false
      }
    },
  }
}
