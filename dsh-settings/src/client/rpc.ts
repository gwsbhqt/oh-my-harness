import type { ConnectionHandle, RpcResult } from '@deepseek-ai/dsh-api-remotes/client'

/** 三个模块的端点在共享 `/api` 通道的 `/api/settings.<endpoint>` 下。 */
const CHANNEL = '/api'
const PREFIX = 'settings.'

export async function call<T>(rpc: ConnectionHandle['rpc'], endpoint: string, payload: unknown): Promise<T> {
  let result: RpcResult<unknown>
  try {
    result = await rpc.call(CHANNEL, `${PREFIX}${endpoint}`, payload)
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : String(error))
  }
  if (!result.ok) throw new Error(result.error.message)
  return result.value as T
}
