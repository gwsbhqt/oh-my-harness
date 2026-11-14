/**
 * dsh-session-ui 宿主半：一个 loader 条目、一个设置命名空间 session-ui，串起会话界面四块能力。
 *
 * 四块：页头只显示还在跑的后台任务和子代理（纯浏览器半，宿主无动作）、回复里路径可点、
 * 输入框上方的运行状态、头栏复制会话编号。每块在自己的子开关下挂载；关掉的块这里不调用，
 * 不注册路由、不装监听。
 *
 * @module dsh-session-ui
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { live } from '../../tooling/runtime/live.mjs'
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

export function apply(ctx: Context, config: ConfigCells): void {
  const logger = ctx.logger('session-ui')
  const fail = (what: string, error: unknown): void => {
    logger.warn(`${what}加载失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (enabled(config.pathMention)) {
    try { applyPathMention(ctx) } catch (error) { fail('路径可点', error) }
  }
  if (enabled(config.runStatus)) {
    try {
      applyRunStatus(ctx, { magpieBaseUrl: () => text(config.magpieBaseUrl), magpieKeyRef: () => text(config.magpieKeyRef) })
    } catch (error) { fail('运行状态', error) }
  }
  // 机器代号查询是给输入框会话引用共用的工具，不随按钮开关撤销：按钮关了，粘贴识别仍要认本机。
  try { applyCopySessionId(ctx) } catch (error) { fail('复制会话编号', error) }
  logger.info('已加载：会话界面四件套')
}
