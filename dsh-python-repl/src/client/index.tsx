/**
 * dsh-python-repl, browser half: one keyed `tool.call.toolview` entry that
 * draws `run_code` with its code labelled and highlighted as Python (see
 * CodeRow.tsx for why the host's own card cannot), plus the plugin-page
 * settings card (settings.tsx).
 *
 * `locale: "conversation"` hands the entry the conversation locale seat, so
 * "代码 / 输出 / 运行中" are the host's own strings, not a copy.
 *
 * @module dsh-python-repl/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// 纯类型导入（会被擦除）：'tool.call.toolview' 槽位契约 ← ui-tool 的 slot-contract。
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
// 'conversation' locale 命名空间的类型 ← ui-conversation。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { CodeRow, type CodeRowProps } from './CodeRow.tsx'
import { registerSettingsCard } from './settings.tsx'
import { KernelPanel } from './KernelPanel.tsx'

export const inject = ['slots', 'locale', 'configForms']

export function apply(ctx: ClientContext): void {
  ctx.slots.inject('tool.call.toolview', () =>
    ctx.slots.register(
      { name: 'tool.call.toolview', key: 'run_code', locale: 'conversation' },
      (props: CodeRowProps) => <CodeRow {...props} />,
    ),
  )
  registerSettingsCard(ctx)
  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      { name: 'conversation.view', id: 'python-kernel', label: '内核', order: 35, inject: sessionId => ({ sessionId }) },
      KernelPanel,
    ),
  )
}
