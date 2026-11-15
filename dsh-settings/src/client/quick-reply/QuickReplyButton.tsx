/**
 * 输入框工具行的「快捷回复」按钮（conversation.input.right，模型选择器左边）。
 *
 * 点开是一张菜单：预设一行一条，点一条按设置直接发出或填进输入框；最后一行「编辑快捷回复…」
 * 打开宿主设置面板里的「快捷回复」页。发出走宿主输入框自己的提交（`inputActions.setDraft` + `submit`），
 * 所以 AI 忙时进排队区、闲着开新一轮，和你按 Enter 完全一样，也照样经过 dsh-composer 的分诊。
 *
 * 输入框里已经有草稿时不覆盖它：直接发出改走 `conversation.send`（只发这一句，草稿留着），
 * 填进输入框改成接在草稿后面。
 */
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CSSProperties } from 'react'
import {
  IconListPenOutlineRegular,
  Menu,
  MenuItemButton,
  Toast,
  Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type { Translate } from './QuickReplySection.tsx'
import type { QuickReplyStore } from './store.ts'

/** 发出一句话，不碰输入框里的草稿。 */
export type SendDetached = (sessionId: string, text: string) => Promise<void>

export interface QuickReplyButtonInjected {
  readonly store: QuickReplyStore
  readonly t: Translate
  readonly sendDetached: SendDetached
  /** 打开设置面板的「快捷回复」页；返回 false = 宿主没给打开的办法。 */
  readonly openSettings: () => boolean
}

export type QuickReplyButtonProps = PropsRuntime<'conversation.input.right'> & Partial<QuickReplyButtonInjected>

// 几何照抄宿主工具行的触发按钮（同 dsh-git-worktree 的分支按钮）：28px 高、13/20 中粗、透明底
const styles: Record<string, CSSProperties> = {
  trigger: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
    height: 28, minWidth: 28, padding: '0 6px', border: 'none', borderRadius: 'var(--dsw-radius-sm, 8px)',
    background: 'transparent', color: 'var(--dsw-alias-label-secondary)', font: 'inherit',
    fontSize: 13, lineHeight: '20px', fontWeight: 500, cursor: 'pointer',
  },
  triggerOpen: { background: 'var(--dsw-alias-interactive-bg-hover, color-mix(in srgb, currentColor 8%, transparent))' },
  // 卡片宽度由最长那条决定：上限收窄，长句提前截断，短句菜单就不会被单条长预设撑开
  menuText: { display: 'inline-block', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' },
  empty: { padding: '6px 12px', fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
}

export function QuickReplyButton(props: QuickReplyButtonProps) {
  const { sessionId, useInput, inputActions, store, t, sendDetached, openSettings } = props
  const draft = useInput((state: { draft: string }) => state.draft)
  const phase = useInput((state: { phase: string }) => state.phase)
  const snapshot = useSyncExternalStore(store?.subscribe ?? noop, store?.getSnapshot ?? none)
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const [toast, setToast] = useState<{ seq: number; text: string } | undefined>(undefined)
  const seq = useRef(0)

  const notify = useCallback((text: string) => {
    seq.current += 1
    setToast({ seq: seq.current, text })
  }, [])

  if (store === undefined || t === undefined || sendDetached === undefined || openSettings === undefined || snapshot === undefined) return null
  if (snapshot.status === 'unavailable') return null
  const { presets, action } = snapshot.value

  const pick = (text: string) => {
    setOpen(false)
    // `/` 命令认领中、正在提交：输入框不收新内容，什么都不做
    if (phase !== 'plain') return
    if (action === 'insert') {
      const current = draft.trimEnd()
      inputActions.setDraft(current === '' ? text : `${current} ${text}`)
      return
    }
    if (draft.trim() === '') {
      inputActions.setDraft(text)
      inputActions.submit()
      return
    }
    sendDetached(sessionId, text).then(
      () => notify(t('sent', { text })),
      (error: unknown) => notify(t('sendFailed', { message: error instanceof Error ? error.message : String(error) })),
    )
  }

  const manage = () => {
    setOpen(false)
    if (!openSettings()) notify(t('openSettingsFailed'))
  }

  const title = action === 'insert' ? t('buttonTitleInsert') : t('buttonTitle')
  return (
    <>
      <Menu
        open={open}
        onClose={() => setOpen(false)}
        side="top"
        align="end"
        portal
        autoFocus
        anchor={(
          <Tooltip label={title} side="top" portal disabled={open}>
            <button
              type="button"
              aria-label={t('button')}
              aria-haspopup="menu"
              aria-expanded={open}
              style={{ ...styles.trigger, ...(open || hover ? styles.triggerOpen : {}) }}
              onMouseEnter={() => setHover(true)}
              onMouseLeave={() => setHover(false)}
              onClick={() => setOpen(value => !value)}
            >
              <IconListPenOutlineRegular size={16} />
            </button>
          </Tooltip>
        )}
      >
        {presets.length === 0 ? <div style={styles.empty}>{t('menuEmpty')}</div> : null}
        {presets.map((text, index) => (
          <MenuItemButton key={`${index}:${text}`} onSelect={() => pick(text)}>
            <PresetText text={text} />
          </MenuItemButton>
        ))}
        <MenuItemButton separatorBefore={presets.length > 0} onSelect={manage}>
          {t('menuManage')}
        </MenuItemButton>
      </Menu>
      {toast === undefined
        ? null
        : <Toast key={toast.seq} text={toast.text} holdMs={2400} onDone={() => setToast(undefined)} />}
    </>
  )
}

/**
 * 菜单里的一行预设：文字被截断时给悬停提示，没截断的不弹。
 * 不用原生 `title`——那是浏览器自己的延迟（约 1 秒）且改不了；宿主 Tooltip 的 `delayMs` 可以设成 0。
 */
function PresetText({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const [truncated, setTruncated] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (el !== null) setTruncated(el.scrollWidth > el.clientWidth + 1)
  }, [text])
  return (
    <Tooltip label={text} side="top" portal delayMs={0} disabled={!truncated}>
      <span ref={ref} style={styles.menuText}>{text}</span>
    </Tooltip>
  )
}

const noop = () => () => {}
const none = () => undefined
