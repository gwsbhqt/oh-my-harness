import { STATE_PATH } from '../../shared/run-status/types.ts'

/** 宿主登记绝对路由，浏览器按页面的 <base> 解析部署前缀。 */
export function fetchRunStatus(base: string, session: string, view?: 'magpie', signal?: AbortSignal): Promise<Response> {
  const url = new URL(STATE_PATH.slice(1), base)
  url.searchParams.set('session', session)
  if (view) url.searchParams.set('view', view)
  return fetch(url, { mode: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' }, signal: signal ?? null })
}
