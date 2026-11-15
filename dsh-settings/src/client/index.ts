/**
 * dsh-settings 浏览器半：一个产物管三页 + 快捷回复按钮。
 *
 * - 模式偏好（`./presets/`）：设置侧栏 section `preset-prefs`。
 * - 技能（`./skills/`）：设置侧栏 section `skill-exposure`。
 * - 快捷回复（`./quick-reply/`）：输入框工具行按钮 + 设置侧栏 section `quick-reply`，按 `settings-prefs` 命名空间的
 *   `quickReply` 开关显示，宿主半没加载时都不出现。
 *
 * 三页共用同包里的页头组件（`./shared/PageHeader.tsx`）——客户端插件不能跨插件 import，同包才能共用。
 */
// 纯类型导入：带进 ctx.slots / ctx.locale / ctx.connection / ctx.configForms / ctx.sessions 和槽位契约的声明合并。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { applyPresetsClient } from './presets/page.ts'
import { applySkillsClient } from './skills/page.ts'
import { applyQuickReplyClient } from './quick-reply/quick-reply.ts'

export const name = 'dsh-settings'

export const inject = ['slots', 'locale', 'configForms', 'sessions', 'connection']

export function apply(ctx: ClientContext): void {
  applyPresetsClient(ctx)
  applySkillsClient(ctx)
  applyQuickReplyClient(ctx)
}
