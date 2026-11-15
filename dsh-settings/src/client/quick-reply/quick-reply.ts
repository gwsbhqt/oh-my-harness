/**
 * dsh-settings 的快捷回复浏览器半（合并入口在 `../index.ts`）：
 * - 输入框工具行的「快捷回复」按钮（conversation.input.right）；
 * - 设置侧栏「快捷回复」一页（settings.section，order 12，紧跟「默认模型与档位」的 11）。
 *
 * 两处用同一份数据：预设和动作在 `$DSH_HOME/preferences.json` 的 `quickReplies` 段（经 `/api/settings.quickReplies*` 读写），
 * 只有开关 `quickReply` 还在 configForms 的 `settings-prefs` 命名空间里；宿主没加载本插件时两处都不出现，
 * `quickReply` 写成 false 时两处都撤掉，改回来再挂上，不用重启。
 * 按钮菜单里的「编辑快捷回复…」打开的就是设置面板里这一页，不另做弹窗。
 */
// 纯类型导入：带进 ctx.slots / ctx.locale / ctx.configForms / ctx.sessions 和各槽位契约的声明合并。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { QuickReplyButton, type QuickReplyButtonInjected } from './QuickReplyButton.tsx'
import { QuickReplySection, type QuickReplyFace, type Translate } from './QuickReplySection.tsx'
import { en, zh, type QuickReplyKey } from './locales.ts'
import { createStore } from './store.ts'
import { openSettingsSection } from './open-settings.ts'

export type { QuickReplyKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'quick-reply': QuickReplyKey
  }
}

/** 文案命名空间。 */
const NS = 'quick-reply'

/** 宿主配置命名空间（= 条目 id）。 */
const CONFIG_NS = 'settings-prefs'

/** 设置侧栏里这一页的 id（「编辑快捷回复…」靠它跳转，沿用拆分前的值）。 */
const SECTION_ID = 'quick-reply'

export const inject = ['slots', 'locale', 'configForms', 'sessions', 'connection']

/** 会话作用域里的 conversation 服务，只用到 send。 */
interface ConversationLike {
  send(text: string): Promise<void>
}

/** 配置还没读到时按默认值（显示）；只有明确写了 `quickReply: false` 才撤掉。 */
export function quickReplyEnabled(value: unknown): boolean {
  return !(typeof value === 'object' && value !== null && (value as Record<string, unknown>)['quickReply'] === false)
}

export function applyQuickReplyClient(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-settings: quick-reply dictionaries')
  const t = ctx.locale.bind(NS) as unknown as Translate
  const form = ctx.configForms.get<unknown>(CONFIG_NS)
  const connection = ctx.get('connection') as ConnectionHandle | undefined
  const store = createStore(connection?.rpc)
  void store.reload()

  const face = (): QuickReplyFace => ({ store, t })

  /**
   * 输入框有草稿时不覆盖它：直接经会话作用域的 conversation.send 发这一句。
   * 那是宿主公开的「发一条排队消息」动词，AI 忙时同样进排队区。
   */
  const sendDetached: QuickReplyButtonInjected['sendDetached'] = async (sessionId, text) => {
    const scoped = ctx.sessions.scope(sessionId as never)
    const conversation = scoped?.get('conversation') as ConversationLike | undefined
    if (conversation === undefined) throw new Error('conversation service unavailable for this session')
    await conversation.send(text)
  }

  const mount = (): (() => void) => {
    const disposeButton = ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
      name: 'conversation.input.right',
      id: 'quick-reply',
      order: 5,
      inject: (): QuickReplyButtonInjected => ({
        store,
        t,
        sendDetached,
        openSettings: () => openSettingsSection(ctx.slots as never, SECTION_ID),
      }),
    }, QuickReplyButton))
    const disposeSection = ctx.slots.inject('settings.section', () => ctx.slots.register({
      name: 'settings.section',
      id: SECTION_ID,
      order: 12,
      label: () => t('nav'),
      inject: face,
    }, QuickReplySection))
    return () => {
      disposeButton()
      disposeSection()
    }
  }

  ctx.effect(() => ctx.configForms.whileServed([CONFIG_NS], () => {
    let unmount: (() => void) | undefined
    const sync = (): void => {
      const wanted = quickReplyEnabled(form.getSnapshot().value)
      if (wanted && unmount === undefined) unmount = mount()
      else if (!wanted && unmount !== undefined) {
        unmount()
        unmount = undefined
      }
    }
    sync()
    const unsubscribe = form.subscribe(sync)
    return () => {
      unsubscribe()
      unmount?.()
      unmount = undefined
    }
  }), 'dsh-settings: quick-reply button and settings page')
}
