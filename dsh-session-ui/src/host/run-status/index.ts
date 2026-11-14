/**
 * dsh-run-status 宿主半：记录每个在跑的会话此刻卡在哪一步，给网页半一条只读路由。
 *
 *   GET /dsh-run-status/state?session=<会话 id>  → RunSnapshot
 *
 * 数据来源都是宿主公开的事件：会话日志追加（session/event）、agent 状态（agent/status）、
 * 模型流（agent/assistant-stream），以及给会阻塞对话的事件里每个插件的监听器计时（见 hooks.ts）。
 * 走 magpie 的请求结束后，再按回复编号读 magpie 的请求记录，拆出上传、等首字、返回（见 magpie.ts）。
 * 另把整段会话统计登记成宿主的会话投影 `runStatusTotals`（见 totals.ts），网页半的统计卡读它。
 * 只读不改：不拦截、不改写任何事件的结果。
 *
 * @module dsh-run-status
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { installHookTiming, realEvents } from './hooks.ts'
import { readRows, requestsUrl, TimingLookup } from './magpie.ts'
import { resolveMagpieGateway } from './magpie-gateway.ts'
import { STATE_PATH } from '../../shared/run-status/types.ts'
import { totalsProjection } from './totals.ts'
import { RunTracker, type SessionEventLike, type StreamFrameLike } from './tracker.ts'

/** 本块从 session-ui 顶层配置现读的 magpie 网关参数。 */
export interface RunStatusHostConfig {
  magpieBaseUrl(): string
  magpieKeyRef(): string
}

type AnyRecord = Record<string, unknown>

function rec(value: unknown): AnyRecord | undefined {
  return typeof value === 'object' && value !== null ? value as AnyRecord : undefined
}

/** agent 对象上的会话 id。 */
export function sessionIdOfAgent(agent: unknown): string | undefined {
  const id = rec(rec(agent)?.session)?.id
  return typeof id === 'string' ? id : undefined
}

/** 一次分发的参数里找会话：payload.agent、exec.agent、req.agent，或直接带 session。 */
export function sessionIdOfArgs(args: readonly unknown[]): string | undefined {
  for (const arg of args) {
    const r = rec(arg)
    if (r === undefined) continue
    const viaAgent = sessionIdOfAgent(r.agent)
    if (viaAgent !== undefined) return viaAgent
    const direct = rec(r.session)?.id
    if (typeof direct === 'string') return direct
  }
  return undefined
}

function sameOrigin(req: IncomingMessage): boolean {
  const raw = req.headers['sec-fetch-site']
  const value = Array.isArray(raw) ? raw[0] : raw
  return value === undefined || value === '' || value === 'same-origin' || value === 'none'
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export function applyRunStatus(ctx: Context, config: RunStatusHostConfig): void {
  const logger = ctx.logger('session-ui/run-status')
  // 现读网关选择：本机装了 Magpie 用本机，否则看 session-ui 显式配置的远程地址；都没有就不记分段用时。
  const gateway = () => {
    try {
      return resolveMagpieGateway({ baseUrl: config.magpieBaseUrl(), keyRef: config.magpieKeyRef() })
    } catch {
      return undefined
    }
  }
  // 现读网关：远程地址是后来才配上的话，下一次请求就能开始记分段，不必重载插件。
  const tracker = new RunTracker({ trackRequests: () => gateway() !== undefined })
  const now = () => Date.now()
  const resolveRef = async (name: string) => {
    const found = await ctx.get('credentials')?.resolve(credentialRef(name))
    return found === undefined ? undefined : { value: found.value }
  }
  const lookup = new TimingLookup(async () => {
    const resolved = gateway()
    if (resolved === undefined) throw new Error('未配置 magpie 网关')
    const url = requestsUrl(resolved.magpieBaseUrl)
    const ref = resolved.magpieKeyRef
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error('网关钥匙必须写凭据引用名')
    const found = await resolveRef(ref)
    return readRows(url, found?.value ?? process.env[ref])
  }, (item, patch) => tracker.resolveRequest(item.session, item.responseId, patch))
  let timer: ReturnType<typeof setTimeout> | undefined
  let polling = false
  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const at = lookup.nextAt()
    if (at === undefined) return
    timer = setTimeout(() => {
      timer = undefined
      if (polling) return
      polling = true
      void lookup.poll(now()).finally(() => {
        polling = false
        schedule()
      })
    }, Math.max(0, at - now()))
  }
  ctx.effect(() => () => {
    if (timer !== undefined) clearTimeout(timer)
    lookup.clear()
  }, 'run-status: magpie lookup')
  const guard = (what: string, fn: () => void) => {
    try {
      fn()
    } catch (error) {
      logger.warn(`${what} 记录失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  ctx.on('session/event' as never, ((session: unknown, event: SessionEventLike) => {
    const id = rec(session)?.id
    if (typeof id === 'string' && rec(event) !== undefined) {
      guard('会话事件', () => {
        const added = tracker.event(id, event)
        if (added === undefined) return
        lookup.add({ session: id, responseId: added.responseId }, added.totalMs, now())
        if (!polling) schedule()
      })
    }
  }) as never, { global: true })

  ctx.on('session/disposed' as never, ((session: unknown) => {
    const id = rec(session)?.id
    if (typeof id === 'string') guard('清理会话', () => {
      tracker.forget(id)
      lookup.forget(id)
      if (!polling) schedule()
    })
  }) as never, { global: true })

  ctx.on('agent/status' as never, ((payload: { agent?: unknown; status?: unknown }) => {
    const id = sessionIdOfAgent(payload?.agent)
    if (id !== undefined) guard('agent 状态', () => tracker.status(id, payload.status === 'running', now()))
  }) as never, { global: true })

  ctx.on('agent/assistant-stream' as never, ((payload: { agent?: unknown; frame?: StreamFrameLike }) => {
    const id = sessionIdOfAgent(payload?.agent)
    if (id !== undefined && payload.frame !== undefined) guard('模型流', () => tracker.stream(id, payload.frame!, now()))
  }) as never, { global: true })

  const events = realEvents((ctx as unknown as { events?: unknown }).events)
  if (events === undefined) {
    logger.warn('宿主事件服务的形状变了，钩子计时不可用；其余状态照常显示')
  } else {
    const self = ctx as unknown as { fiber?: unknown }
    ctx.effect(() => installHookTiming(events, {
      sessionOf: (_event, args) => sessionIdOfArgs(args),
      start: (id, plugin, event) => tracker.hookStart(id, plugin, event, now()),
      wait: (id, handle) => tracker.hookWait(id, handle, now()),
      resume: (id, handle) => tracker.hookResume(id, handle, now()),
      end: (id, handle) => tracker.hookEnd(id, handle, now()),
    }, (hookCtx) => (hookCtx as { fiber?: unknown } | undefined)?.fiber === self.fiber), 'run-status: hook timing')
  }

  // 整段会话统计登记成宿主的会话投影：宿主负责从日志折出来、存检查点、推给网页，聊天记录压缩后数字也不变。
  ctx.inject(['sessionProjections'], async (projCtx) => {
    const registry = (projCtx as unknown as {
      sessionProjections: { register: (definition: unknown) => PromiseLike<{ dispose?: () => Promise<void> } | undefined> }
    }).sessionProjections
    let handle: { dispose?: () => Promise<void> } | undefined
    try {
      handle = await registry.register(totalsProjection)
    } catch {
      return
    }
    // 投影登记在投影服务自己的 fiber 上，不随本块子 fiber 自动消失；把返回的句柄挂到本块 effect 上，
    // 关掉 runStatus 时连同投影一起撤销，否则会一直存在、白算统计。
    if (typeof handle?.dispose !== 'function') return
    const dispose = handle.dispose.bind(handle)
    try {
      projCtx.effect(() => () => { void dispose() }, 'run-status: totals projection')
    } catch {
      void dispose()
    }
  })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: STATE_PATH,
      handler: (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'GET' || !sameOrigin(req)) return send(res, 403, { error: 'forbidden' })
        const url = new URL(req.url ?? '/', 'http://local')
        const session = url.searchParams.get('session')
        if (session === null || session === '') return send(res, 200, { running: tracker.runningIds() })
        send(res, 200, tracker.snapshot(session, now()))
      },
    }), 'run-status: state route')
  })

  logger.info('已加载：记录会话每一步卡在哪')
}
