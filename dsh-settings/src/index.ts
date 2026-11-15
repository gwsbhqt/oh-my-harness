/**
 * dsh-settings：设置包。一个 loader 条目 `settings-prefs`、一个设置命名空间 `settings-prefs`，承载设置侧栏三页：
 *
 * 1. **模式偏好**（`./presets/`）：按工作区给新会话选默认模式；新会话走会话控制器内部的
 *    `agents.createSession(request)`，没指定模式时按 `request.cwd` 所在项目补上偏好。
 * 2. **技能**（`./skills/`）：按全局和每个项目调整每个技能给模型看多少，普通技能和 py 技能分开管；
 *    另给 python-repl 提供 `skillExposure.disabledPySkills` 服务。
 * 3. **快捷回复**（`./quick-reply/`）：输入框工具行的按钮和设置页，预设和动作存在共用偏好文件。
 *
 * 三个功能的配置平铺在同一个条目下；本包只有 `quickReply` 一个开关（客户端按它显示按钮和设置页）。
 * volatile 字段是活的引用，设置页改完由 loader 原地写回，不能为某个模块重新解析一次，否则改设置不生效。
 *
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { applyPresets } from './presets/index.ts'
import { applySkills } from './skills/index.ts'
import { applyQuickReply } from './quick-reply/quick-reply.ts'

export const name = 'dsh-settings'

/** 技能模块在 apply 里要读宿主技能注册表（`ctx.skills`），其余模块运行期各自 `ctx.inject`。 */
export const inject = ['skills']

export const Config = z.object({
  /** 快捷回复总开关：关掉时输入框按钮和设置侧栏「快捷回复」页都不出现，改回来即时出现，不用重启。 */
  quickReply: z.boolean().default(true).volatile(),
})

type ConfigCells = ReturnType<typeof Config>

export function apply(ctx: Context, _config: ConfigCells): void {
  applyPresets(ctx)
  applySkills(ctx)
  applyQuickReply(ctx)
}
