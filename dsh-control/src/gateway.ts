/**
 * 调 DSH 内部接口的薄封装。
 *
 * 界面用的每个操作都是一个带类型描述的「远程方法」（`<namespace>/<method>`），由 `ctx.typertGateway` 分发：
 * 按描述校验参数、解析会话之类的查找参数、调用真正的服务。插件在同一进程里直接调它，走的校验和界面
 * 一模一样，身份是进程内的「操作者」（与本机 GUI 相同）。
 *
 * 描述从 `ctx.typert.local.list()` 读，所以 DSH 升级新增的接口不用改这里就能调。
 *
 * @module
 */

export interface ParameterDescriptor {
  name: string
  wire: string
  source: 'json' | 'lookup' | string
  lookup?: string
  acceptsUndefined?: boolean
  codec?: { mode?: string; typeSymbol?: string; create?: () => { toJSONSchema?: unknown } }
}

export interface InvocationDescriptor {
  id: string
  service: string
  namespace: string
  method: string
  mode?: 'stream'
  invocation: { kind: 'direct' | 'context'; wire?: string; context?: string }
  parameters: ParameterDescriptor[]
  cancellation?: { parameter: string }
  sourceLocation?: { file: string; line: number }
}

export interface GatewayLike {
  invoke(request: { namespace: string; method: string; args: Record<string, unknown>; signal?: AbortSignal }): Promise<unknown>
  stream(request: { namespace: string; method: string; args: Record<string, unknown>; signal?: AbortSignal }): Promise<AsyncIterable<unknown>>
}

export interface TypertLocalLike {
  list(): readonly InvocationDescriptor[]
  get(endpoint: string): InvocationDescriptor | undefined
}

/** 一个接口的简介：给 `api list` 用。 */
export interface EndpointInfo {
  endpoint: string
  package: string
  stream: boolean
  /** 调用时 args 里要写的字段（wire 名）；带 `?` 的可以不写。 */
  args: string[]
  /** 进程内上下文（会话、智能体）的字段，例如 `agentId`。 */
  scope?: string
}

export function describeEndpoint(d: InvocationDescriptor): EndpointInfo {
  const args = d.parameters.map((p) => {
    const optional = p.acceptsUndefined === true || p.codec?.mode === 'src-json'
    const hint = p.source === 'lookup' ? `${p.wire}:<${p.lookup ?? 'id'}>` : p.wire
    return optional ? `${hint}?` : hint
  })
  if (d.invocation.kind === 'context' && d.invocation.wire !== undefined && !d.parameters.some((p) => p.wire === d.invocation.wire)) {
    args.unshift(`${d.invocation.wire}:<${d.invocation.context ?? 'context'}>`)
  }
  return {
    endpoint: `${d.namespace}/${d.method}`,
    package: d.id.split('#')[0] ?? d.id,
    stream: d.mode === 'stream',
    args,
    ...(d.invocation.kind === 'context' && d.invocation.wire !== undefined ? { scope: d.invocation.wire } : {}),
  }
}

/** 某个接口参数的 JSON Schema（生成的 zod 描述能转就转，转不了给 undefined）。 */
export function parameterSchemas(d: InvocationDescriptor): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const p of d.parameters) {
    try {
      const schema = p.codec?.create?.() as unknown
      const z = schema as { toJSONSchema?: () => unknown } | undefined
      const json = typeof z?.toJSONSchema === 'function' ? z.toJSONSchema() : zodToJson(schema)
      out[p.wire] = json ?? { source: p.source }
    } catch {
      out[p.wire] = { source: p.source }
    }
  }
  return out
}

/** zod v4 实例自带 `toJSONSchema` 静态函数在 `z` 上，这里拿不到 `z`，只能读实例的 def 粗略给个形状。 */
function zodToJson(schema: unknown, depth = 0): unknown {
  if (depth > 6 || typeof schema !== 'object' || schema === null) return undefined
  const def = (schema as { _zod?: { def?: Record<string, unknown> }; def?: Record<string, unknown> })._zod?.def
    ?? (schema as { def?: Record<string, unknown> }).def
  if (def === undefined) return undefined
  const type = def['type']
  switch (type) {
    case 'object': {
      const shape = (def['shape'] ?? {}) as Record<string, unknown>
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = zodToJson(value, depth + 1) ?? {}
        const inner = (value as { _zod?: { def?: { type?: string } } })._zod?.def?.type
        if (inner !== 'optional') required.push(key)
      }
      return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
    }
    case 'array': return { type: 'array', items: zodToJson(def['element'], depth + 1) ?? {} }
    case 'string': return { type: 'string' }
    case 'number': return { type: 'number' }
    case 'boolean': return { type: 'boolean' }
    case 'literal': return { const: (def['values'] as unknown[] | undefined)?.[0] }
    case 'optional':
    case 'readonly':
    case 'nullable':
      return zodToJson(def['innerType'], depth + 1)
    case 'union': return { anyOf: ((def['options'] ?? []) as unknown[]).map((o) => zodToJson(o, depth + 1) ?? {}) }
    case 'intersection': return zodToJson(def['left'], depth + 1)
    case 'record': return { type: 'object', additionalProperties: zodToJson(def['valueType'], depth + 1) ?? {} }
    case 'lazy': return {}
    default: return typeof type === 'string' ? { type } : undefined
  }
}

/** 把 `namespace/method` 或 `namespace.method` 拆开。 */
export function splitEndpoint(raw: string): { namespace: string; method: string } {
  const m = /^([A-Za-z0-9_-]+)[./]([A-Za-z0-9_-]+)$/.exec(raw.trim())
  if (m === null) throw new UsageError(`接口名要写成 namespace/method，例如 session/list；收到 "${raw}"`)
  return { namespace: m[1]!, method: m[2]! }
}

/** 调用方写错了：参数、名字、找不到对象。命令行按退出码 2 报。 */
export class UsageError extends Error {
  readonly code: string
  readonly details: unknown
  constructor(message: string, code = 'usage', details?: unknown) {
    super(message)
    this.name = 'UsageError'
    this.code = code
    this.details = details
  }
}

/** 命令没做成（宿主拒绝、操作失败、依赖不在）：带稳定的英文 code，命令行据此给非 0 退出码。 */
export class CommandFailure extends Error {
  readonly code: string
  readonly details: unknown
  constructor(message: string, code: string, details?: unknown) {
    super(message)
    this.name = 'CommandFailure'
    this.code = code
    this.details = details
  }
}

/** 把宿主抛的错误（RemoteError 带 code / details）变成可以过线的样子。 */
export function errorPayload(error: unknown): { code: string; message: string; details?: unknown } {
  if (error instanceof UsageError) {
    return { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) }
  }
  const e = error as { code?: unknown; message?: unknown; details?: unknown; name?: unknown } | undefined
  const code = typeof e?.code === 'string' ? e.code : typeof e?.name === 'string' ? e.name : 'internal'
  const message = typeof e?.message === 'string' ? e.message : String(error)
  let details: unknown
  try {
    details = e?.details === undefined ? undefined : JSON.parse(JSON.stringify(e.details))
  } catch { details = undefined }
  return { code, message, ...(details === undefined ? {} : { details }) }
}

/** 流式接口最多收这么多项就停（`api call` 碰到流式接口时用）。 */
export async function collectStream(stream: AsyncIterable<unknown>, options: { maxItems: number; timeoutMs: number; signal?: AbortSignal }): Promise<{ items: unknown[]; ended: boolean }> {
  const items: unknown[] = []
  const iterator = stream[Symbol.asyncIterator]()
  const deadline = Date.now() + options.timeoutMs
  let ended = false
  try {
    while (items.length < options.maxItems) {
      const left = deadline - Date.now()
      if (left <= 0) break
      let timer: NodeJS.Timeout | undefined
      const next = await Promise.race([
        iterator.next(),
        new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), left) }),
      ]).finally(() => clearTimeout(timer))
      if (next === 'timeout') break
      if (next.done === true) { ended = true; break }
      items.push(next.value)
      if (options.signal?.aborted === true) break
    }
  } finally {
    void iterator.return?.().catch(() => {})
  }
  return { items, ended }
}
