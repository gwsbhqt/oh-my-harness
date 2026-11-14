/**
 * dsh-session-ui 浏览器半：一个设置命名空间 session-ui 下四个子开关，各自按需挂载。
 *
 * 默认四个都开；关掉的块这里不调用对应 apply，不注册槽位、不装事件监听。
 * hide-finished 只有浏览器半，其余三块在宿主半另有路由/监听。
 *
 * @module dsh-session-ui/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
// 类型导入会被擦除，不进 bundle，只为拿 Context 的类型扩充。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import { apply as applyCopySessionId } from './copy-session-id/index.tsx'
import { apply as applyHideFinished } from './hide-finished/index.tsx'
import { apply as applyPathMention } from './path-mention/index.tsx'
import { apply as applyRunStatus } from './run-status/index.tsx'

export const inject = ['slots', 'configForms', 'sessions', 'connection']

const NS = 'session-ui'

/** 配置还没读到时按默认（开启）；只有明确写了 false 才关。 */
function enabled(form: ConfigForm<unknown>, key: string): boolean {
  const value = form.getSnapshot().value
  return !(typeof value === 'object' && value !== null && (value as Record<string, unknown>)[key] === false)
}

export function apply(ctx: ClientContext): void {
  const form = ctx.configForms.get<unknown>(NS)
  let started = false
  const start = (): void => {
    if (started) return
    started = true
    if (enabled(form, 'hideFinished')) applyHideFinished(ctx)
    if (enabled(form, 'pathMention')) applyPathMention(ctx)
    if (enabled(form, 'runStatus')) applyRunStatus(ctx)
    if (enabled(form, 'copySessionId')) applyCopySessionId(ctx)
  }
  ctx.effect(() => ctx.configForms.whileServed([NS], () => {
    start()
    return () => {}
  }), 'session-ui: features')
}
