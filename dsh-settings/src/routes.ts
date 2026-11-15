/**
 * dsh-settings 宿主半共用的设置接口信封。
 *
 * 三个功能模块（模式偏好 / 技能 / 快捷回复）的端点都挂在共享 `/api` 通道的
 * `/api/settings.<endpoint>` 下，端点名带模块前缀避免同名冲突。信封格式与宿主 `/api` 通道的
 * client-request 一致：请求是 `{ type: 'client-request', method, rpcId, payload }`，回 `{ type: 'server-response', rpcId, result }`。
 *
 * @module
 */

export interface FetchRoute {
  path: string
  methods: readonly string[]
  requestBody: 'buffered'
  fetch(request: Request): Promise<Response>
}

export function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {}
}

/** 处理函数抛它带错误码，失败信封里带上；其他异常记 failed。 */
export class RouteError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export function failure(error: unknown) {
  const code = error instanceof RouteError ? error.code : 'failed'
  return { ok: false, error: { code: `settings/${code}`, message: error instanceof Error ? error.message : String(error), details: {} } }
}

/** `/api/settings.<endpoint>`，信封同宿主 `/api` 通道。 */
export function route(endpoint: string, handler: (payload: unknown) => Promise<unknown>): FetchRoute {
  return {
    path: `/api/settings.${endpoint}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') return new Response('content type must be application/json', { status: 415 })
      let body: Record<string, unknown>
      try {
        body = obj(await request.json())
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const rpcId = typeof body['rpcId'] === 'string' ? body['rpcId'] : 'invalid-request'
      const reply = (result: unknown) => Response.json({ type: 'server-response', rpcId, result })
      if (body['type'] !== 'client-request' || typeof body['method'] !== 'string') return reply(failure(new RouteError('invalid-request', 'invalid client-request message')))
      try {
        return reply({ ok: true, value: await handler(body['payload']) })
      } catch (error) {
        return reply(failure(error))
      }
    },
  }
}
