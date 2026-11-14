/**
 * copy-session-id 宿主半：给网页半一条只读路由，告诉它本机的机器代号。
 *
 * 网页端「复制会话编号」按钮复制本会话裸编号时在末尾加 `#机器名`；桌面端不加。
 * 代号来自 `scutil --get LocalHostName`，拿不到退回 `os.hostname()`，和 dsh-use「远程机器」页认本机一致，不读配置。
 *
 * @module dsh-session-ui/host/copy-session-id
 */
import { execFileSync } from 'node:child_process'
import { hostname } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'

/** 宿主 fetch 路由的最小结构（和 dsh-use 用的一致）。 */
interface FetchRoute {
  path: string
  methods: readonly string[]
  requestBody: 'buffered'
  fetch(request: Request): Promise<Response>
}

/** 本机代号：优先 `scutil --get LocalHostName`，拿不到退回 `os.hostname()`。 */
export function localHostName(): string {
  try {
    return execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim() || hostname()
  } catch {
    return hostname()
  }
}

export function machineRoute(getName: () => string = localHostName): FetchRoute {
  return {
    path: '/api/session-ui.machine',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async request => {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return new Response('content type must be application/json', { status: 415 })
      let body: unknown
      try { body = await request.json() } catch { return new Response('body is not JSON', { status: 400 }) }
      if (typeof body !== 'object' || body === null) return new Response('invalid client request', { status: 400 })
      const message = body as Record<string, unknown>
      if (message.type !== 'client-request' || typeof message.rpcId !== 'string' || message.method !== 'session-ui.machine') return new Response('invalid client request', { status: 400 })
      return Response.json({ type: 'server-response', rpcId: message.rpcId, result: { ok: true, value: { machine: getName() } } })
    },
  }
}

export function applyCopySessionId(ctx: Context): void {
  const logger = ctx.logger('session-ui/copy-session-id')
  ctx.inject(['connection'], (c) => {
    const register = (c as unknown as {
      connection?: { fetch?: { register?: (route: FetchRoute) => () => void } }
    }).connection?.fetch?.register
    if (register === undefined) {
      logger.warn('connection.fetch 不可用：网页端无法得知机器代号，只复制裸编号')
      return
    }
    c.effect(() => register(machineRoute()), 'session-ui: machine route')
  })
}
