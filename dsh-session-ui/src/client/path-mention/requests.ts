import { OPEN_IN_APP_OPEN_ROUTE } from '@deepseek-ai/dsh-host-open-in-app/shared'
import { OPEN_PATH, OPEN_WITH_PATH, RESOLVE_PATH, type Resolved, type ResolveResponse } from '../../shared/path-mention/token.ts'
import type { MentionTarget } from './menu.ts'

export async function fetchResolved(cwd: string | undefined, tokens: string[], signal?: AbortSignal): Promise<Record<string, Resolved>> {
  const response = await fetch(RESOLVE_PATH.slice(1), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ cwd, tokens }),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) return {}
  const value = (await response.json()) as Partial<ResolveResponse>
  return typeof value.results === 'object' && value.results !== null ? value.results : {}
}

export function openOnHost(path: string, action: 'open' | 'reveal'): void {
  void fetch(OPEN_PATH.slice(1), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, action }),
  }).catch(() => undefined)
}

export async function openWithApp(target: MentionTarget, app: string): Promise<boolean> {
  const route = target.kind === 'directory' ? OPEN_IN_APP_OPEN_ROUTE : OPEN_WITH_PATH.slice(1)
  try {
    const response = await fetch(route, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: target.path, app }),
    })
    return response.ok
  } catch {
    return false
  }
}
