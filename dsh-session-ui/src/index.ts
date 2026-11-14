/**
 * dsh-session-ui 宿主半：一个 loader 条目、一个设置命名空间 session-ui，串起会话界面四块能力。
 *
 * 四块：页头只显示还在跑的后台任务和子代理（纯浏览器半，宿主无动作）、回复里路径可点、
 * 输入框上方的运行状态、头栏复制会话编号。每块在自己的子开关下挂到一个独立子 fiber：
 * 关掉就把那个子 fiber 整个卸掉，路由、事件监听、计时器、会话投影随之一并撤销；再开重新挂。
 *
 * 开关是 volatile 配置。volatile 改动不会重载插件，所以这里监听 loader 的 volatile 更新事件，
 * 每次更新按当前值重新对齐挂载状态（见 shared/toggle.ts）。
 *
 * @module dsh-session-ui
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { live } from '../../tooling/runtime/live.mjs'
import { createToggler } from './shared/toggle.ts'
import { applyCopySessionId } from './host/copy-session-id/index.ts'
import { applyPathMention } from './host/path-mention/index.ts'
import { applyRunStatus } from './host/run-status/index.ts'

export const name = 'session-ui'

export const Config = z.object({
  hideFinished: z.boolean().default(true).volatile().description('页头「后台任务」「子代理」只显示还在跑的'),
  pathMention: z.boolean().default(true).volatile().description('回复里本机真实存在的路径可点，右键用应用打开，可拖进输入框'),
  runStatus: z.boolean().default(true).volatile().description('输入框上方说清卡在哪一步、用时多久；输入框下方统计卡'),
  copySessionId: z.boolean().default(true).volatile().description('会话头栏「复制会话编号」按钮'),
  magpieBaseUrl: z.string().default('').volatile().description('magpie 网关地址：留空时本机装了 Magpie 自动用 127.0.0.1:3425，否则不读分段用时；本机可用 http，别的机器上的网关只能 https'),
  magpieKeyRef: z.string().default('').volatile().description('网关钥匙的凭据引用名，不能填钥匙本身；留空时本机用本机钥匙'),
})

export type ConfigCells = ReturnType<typeof Config>

/** 现读开关：默认开，只有明确写了 false 才关。 */
function enabled(cell: unknown): boolean {
  return live(cell as never) !== false
}

/** 现读字符串配置。 */
function text(cell: unknown): string {
  const value = live(cell as never)
  return typeof value === 'string' ? value : ''
}

/** 监听 loader 的 volatile 配置更新；回调在配置值已写进运行中的引用之后触发。 */
function onVolatileUpdate(ctx: Context, listener: () => void): () => void {
  const on = (ctx as unknown as {
    on(name: string, callback: () => void): () => void
  }).on.bind(ctx)
  return on('loader/volatile-update', listener)
}

export function apply(ctx: Context, config: ConfigCells): void {
  const logger = ctx.logger('session-ui')

  // 机器代号查询是给输入框会话引用共用的工具，不随按钮开关撤销：按钮关了，粘贴识别仍要认本机。
  try { applyCopySessionId(ctx) } catch (error) {
    logger.warn(`复制会话编号加载失败：${error instanceof Error ? error.message : String(error)}`)
  }

  const toggler = createToggler(ctx, {
    pathMention: (child) => applyPathMention(child),
    runStatus: (child) => applyRunStatus(child, {
      magpieBaseUrl: () => text(config.magpieBaseUrl),
      magpieKeyRef: () => text(config.magpieKeyRef),
    }),
  })
  const sync = (): void => toggler.sync({
    pathMention: enabled(config.pathMention),
    runStatus: enabled(config.runStatus),
  })

  ctx.effect(() => {
    sync()
    // volatile 更新不重载插件，靠这个事件把开关变化对到挂载状态上。
    const off = onVolatileUpdate(ctx, sync)
    return () => {
      off()
      toggler.dispose()
    }
  }, 'session-ui: host features')

  logger.info('已加载：会话界面四件套')
}
