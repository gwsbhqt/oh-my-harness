/**
 * 模式偏好页的浏览器注册：本地化字典 + 设置侧栏 section（id `preset-prefs`，order 11.5）。
 */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { PresetPrefsPage, type PageInjected, type Translate } from './PresetPrefsPage.tsx'
import { en, zh, type PresetsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'presets': PresetsKey
  }
}

const NS = 'presets'
const SECTION_ID = 'preset-prefs'

export function applyPresetsClient(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-settings: presets dictionaries')
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  const t = ctx.locale.bind(NS) as unknown as Translate
  const injected = (): PageInjected => ({ rpc: connection.rpc, t })
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: 11.5,
    label: () => t('nav'),
    inject: injected,
  }, PresetPrefsPage)), 'dsh-settings: presets page')
}
