/**
 * dsh-use 浏览器半：设置侧栏「远程机器」一页。
 */
// 纯类型导入：带进 ctx.slots / ctx.connection 和 'settings.section' 槽位契约的声明合并。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { receiveDesktopNotifications } from './desktop-notifications.ts'
import { MachinesSection, type MachinesSectionInjected } from './MachinesSection.tsx'

export const inject = ['slots', 'connection']

export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  ctx.effect(receiveDesktopNotifications, 'dsh-use: desktop notifications')
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'remote-machines',
    order: 12,
    label: () => '远程机器',
    inject: (): MachinesSectionInjected => ({ rpc: connection.rpc }),
  }, MachinesSection)), 'dsh-use: remote machines page')
}
