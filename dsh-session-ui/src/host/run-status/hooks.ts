/**
 * 给会阻塞对话的宿主事件（waterfall、serial）里每个插件的监听器计时。
 *
 * 宿主事件总线每次分发都先取出这次要跑的监听器再挨个调用：cordis 4.0 是 `events.dispatch(type, args)`（已绑好 this），
 * cordis 4.1（DSH 0.2.2-rc.1）起是 `events._resolve(type, args)` 返回 `[this, 回调]`，waterfall、serial 不再经过 dispatch。
 * 这里在实例上盖一层（有 `_resolve` 就盖它，否则盖 dispatch）：原样调宿主的，再按同样的过滤条件找回每个监听器
 * 的登记（里面有它属于哪个插件），把返回的回调包一层计时。登记本身不改，插件卸载照常摘得掉。
 * 数量对不上（宿主改了实现）就原样返回，不计时。
 */

const FILTER = Symbol.for('cordis.filter')
const ORIGINAL = Symbol.for('cordis.original')

/** 会卡住对话、值得计时的事件。llm/stream 返回的是流，计时没有意义，不在这里。 */
export const TIMED_EVENTS: ReadonlySet<string> = new Set([
  'agent/pre-step',
  'agent/request',
  'agent/request-error',
  'agent/turn-stopping',
  'system-prompt/assemble',
  'tools/pre-execute',
  'tools/execute',
  'tools/post-execute',
  'tools/ptc-dispatch-log',
  'compaction/summary-error',
  'fs/write-intent',
  'fs/edit-intent',
  'approval/request',
  'user-questions/request',
])

interface HookRecord {
  readonly ctx: unknown
  readonly callback: (...args: unknown[]) => unknown
  readonly global?: boolean
}

type Callback = (...args: unknown[]) => unknown

export interface EventsLike {
  _hooks: Record<string, HookRecord[] | undefined>
  dispatch(type: string, args: unknown[]): Callback[]
  _resolve?(type: string, args: unknown[]): [unknown, Callback[]]
}

export interface HookTimer {
  /** 这次分发属于哪个会话；认不出返回 undefined，不计时。 */
  sessionOf(event: string, args: readonly unknown[]): string | undefined
  start(sessionId: string, plugin: string, event: string): number
  wait(sessionId: string, handle: number): void
  resume(sessionId: string, handle: number): void
  end(sessionId: string, handle: number): void
}

function pluginName(ctx: unknown): string {
  const fiber = (ctx as { fiber?: { name?: unknown } } | undefined)?.fiber
  const name = fiber?.name
  return typeof name === 'string' && name !== '' ? name : '未知插件'
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

/** 拿到 cordis 代理背后的真实事件服务。 */
export function realEvents(events: unknown): EventsLike | undefined {
  const target = (events as Record<symbol, unknown> | undefined)?.[ORIGINAL] ?? events
  const t = target as Partial<EventsLike> | undefined
  return t !== undefined && typeof t.dispatch === 'function' && typeof t._hooks === 'object' ? t as EventsLike : undefined
}

/**
 * 盖上计时层。返回撤销函数。
 * @param events - 真实事件服务。
 * @param timer - 计时回调。
 * @param skip - 不计时的监听器所属上下文（本插件自己）。
 */
export function installHookTiming(events: EventsLike, timer: HookTimer, skip?: (ctx: unknown) => boolean): () => void {
  const key = typeof events._resolve === 'function' ? '_resolve' : 'dispatch'
  const hadOwn = Object.prototype.hasOwnProperty.call(events, key)
  const previous = events[key] as (this: EventsLike, type: string, args: unknown[]) => Callback[] | [unknown, Callback[]]
  const timed = (self: EventsLike, type: string, name: unknown, thisArg: unknown, args: unknown[], callbacks: Callback[]): Callback[] => {
    if (type === 'emit' || typeof name !== 'string' || !TIMED_EVENTS.has(name) || callbacks.length === 0) return callbacks
    const sessionId = timer.sessionOf(name, args)
    if (sessionId === undefined) return callbacks
    const filter = (thisArg as Record<symbol, unknown> | null)?.[FILTER] as ((ctx: unknown) => boolean) | undefined
    const hooks = (self._hooks[name] ?? []).filter((hook) => hook.global === true || filter === undefined || filter.call(thisArg, hook.ctx))
    if (hooks.length !== callbacks.length) return callbacks
    return callbacks.map((cb, i) => {
      const hook = hooks[i]!
      if (skip?.(hook.ctx) === true) return cb
      return wrap(cb, type, timer, sessionId, pluginName(hook.ctx), name)
    })
  }
  // 别的插件在上面又盖了一层时本层摘不掉，只能靠撤销后原样转发保证无害。
  let active = true
  const patched = function (this: EventsLike, type: string, args: unknown[]) {
    if (!active) return previous.call(this, type, args)
    const thisArg = typeof args[0] === 'object' || typeof args[0] === 'function' ? args[0] : null
    const name = thisArg === null ? args[0] : args[1]
    const result = previous.call(this, type, args)
    if (key === 'dispatch') return timed(this, type, name, thisArg, args, result as Callback[])
    const [boundThis, callbacks] = result as [unknown, Callback[]]
    return [boundThis, timed(this, type, name, thisArg, args, callbacks)]
  }
  ;(events as unknown as Record<string, unknown>)[key] = patched
  return () => {
    active = false
    const own = events as unknown as Record<string, unknown>
    if (own[key] !== patched) return
    if (hadOwn) own[key] = previous
    else delete own[key]
  }
}

function wrap(cb: Callback, type: string, timer: HookTimer, sessionId: string, plugin: string, event: string): Callback {
  // cordis 4.1 的回调没有预先绑 this，由分发方 Reflect.apply 传进来，所以这里要原样转交。
  return function (this: unknown, ...args: unknown[]) {
    const handle = timer.start(sessionId, plugin, event)
    let callArgs = args
    if (type === 'waterfall' && typeof args[args.length - 1] === 'function') {
      const next = args[args.length - 1] as (...a: unknown[]) => unknown
      const timedNext = (...a: unknown[]) => {
        timer.wait(sessionId, handle)
        let out: unknown
        try {
          out = next(...a)
        } catch (error) {
          timer.resume(sessionId, handle)
          throw error
        }
        if (isThenable(out)) {
          return Promise.resolve(out).finally(() => timer.resume(sessionId, handle))
        }
        timer.resume(sessionId, handle)
        return out
      }
      callArgs = [...args.slice(0, -1), timedNext]
    }
    let ret: unknown
    try {
      ret = cb.apply(this, callArgs)
    } catch (error) {
      timer.end(sessionId, handle)
      throw error
    }
    if (isThenable(ret)) {
      return Promise.resolve(ret).finally(() => timer.end(sessionId, handle))
    }
    timer.end(sessionId, handle)
    return ret
  }
}
