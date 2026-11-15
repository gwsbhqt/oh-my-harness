/**
 * 技能页的浏览器注册：本地化字典 + 设置侧栏 section（id `skill-exposure`，order 12）。
 */
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { SkillExposurePage, type PageInjected, type Translate } from './SkillExposurePage.tsx'
import { en, zh, type SkillExposureKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'skill-exposure': SkillExposureKey
  }
}

const NS = 'skill-exposure'
const SECTION_ID = 'skill-exposure'

export function applySkillsClient(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-settings: skills dictionaries')
  const connection = ctx.get('connection') as unknown as ConnectionHandle
  const t = ctx.locale.bind(NS) as unknown as Translate
  const injected = (): PageInjected => ({ rpc: connection.rpc, t })
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: SECTION_ID,
    order: 12,
    label: () => t('nav'),
    inject: injected,
  }, SkillExposurePage)), 'dsh-settings: skills page')
}
