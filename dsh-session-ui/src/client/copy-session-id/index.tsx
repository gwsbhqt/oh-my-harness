/**
 * copy-session-id 浏览器半：会话头栏的「复制会话编号」按钮。
 *
 * 在 `conversation.session.header.utilities` 槽位注册一个小方按钮，order -20 排在「用 IDE 打开」左边。
 * 点击后把当前会话的裸编号写入剪贴板（网页端带 `#机器代号`），图标短暂变勾。
 * 贴进输入框时由 dsh-composer 换成引用小块，不在本插件。
 *
 * @module dsh-session-ui/client/copy-session-id
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IconCheckOutlineRegular,
  IconLinkOutlineRegular,
  Tooltip,
  writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 类型导入会被擦除，不进 bundle，只为拿 Context 的类型扩充。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-connection/client'

const CSS = `
.dsh-deep-link-btn {
  box-sizing: border-box;
  height: 24px;
  min-width: 24px;
  padding: 3px 5px;
  color: var(--dsw-alias-label-primary);
  background: transparent;
  border: .5px solid var(--dsw-alias-border-l4);
  border-radius: var(--dsw-radius-sm);
  cursor: pointer;
  flex: none;
  display: inline-flex;
  justify-content: center;
  align-items: center;
  font-family: var(--dsw-font-family);
}
.dsh-deep-link-btn:hover,
.dsh-deep-link-btn:focus-visible {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-deep-link-btn:focus-visible {
  outline: none;
}
.dsh-deep-link-btn.dsh-deep-link-copied {
  color: var(--dsw-alias-state-success-primary);
}
`

const STYLE_PLUGIN = 'dsh-session-ui-copy-session-id'

function injectCss(): void {
  document
    .querySelectorAll(`style[data-plugin="${STYLE_PLUGIN}"]`)
    .forEach((stale) => stale.remove())
  const tag = document.createElement('style')
  tag.dataset.plugin = STYLE_PLUGIN
  tag.textContent = CSS
  document.head.appendChild(tag)
}

const COPIED_FEEDBACK_MS = 1500

export interface CopySessionIdButtonProps {
  sessionId: unknown
}

export function CopySessionIdButton({ sessionId }: CopySessionIdButtonProps): JSX.Element {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  const handleCopy = useCallback(async () => {
    const id = String(sessionId) + machineSuffix()
    let accepted = false
    try {
      accepted = await writeClipboard(id)
    } catch {
      accepted = false
    }
    if (!accepted) return
    setCopied(true)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS)
  }, [sessionId])

  return (
    <Tooltip
      label={() => (copied ? '已复制会话编号' : '复制会话编号，贴进输入框会变成引用')}
      side="bottom"
      delayMs={300}
      maxWidth={260}
    >
      <button
        type="button"
        className={copied ? 'dsh-deep-link-btn dsh-deep-link-copied' : 'dsh-deep-link-btn'}
        aria-label="复制会话编号"
        onClick={handleCopy}
      >
        {copied ? <IconCheckOutlineRegular size={13} /> : <IconLinkOutlineRegular size={13} />}
      </button>
    </Tooltip>
  )
}

/** 宿主返回的本机代号；桌面端不适用。 */
let cachedMachine = ''

async function loadMachine(ctx: ClientContext): Promise<void> {
  try {
    const rpc = ctx.get('connection').rpc
    const result = await rpc.call('/api', 'session-ui.machine', {}) as
      | { ok?: unknown; value?: { machine?: unknown } }
      | undefined
    if (result?.ok === true && typeof result.value?.machine === 'string') cachedMachine = result.value.machine
  } catch {
    // 拿不到就保持空：只复制编号，不带机器。
  }
}

function machineSuffix(): string {
  if (typeof location !== 'undefined' && location.protocol === 'dsh-app:') return ''
  return cachedMachine === '' ? '' : '#' + cachedMachine
}

/** 排在「用 IDE 打开」（order -10）左边。 */
const HEADER_ORDER = -20

export function apply(ctx: ClientContext): void {
  injectCss()
  void loadMachine(ctx)
  ctx.effect(() => ctx.slots.inject('conversation.session.header.utilities', () =>
    ctx.slots.register(
      { name: 'conversation.session.header.utilities', id: 'copy-session-id', order: HEADER_ORDER },
      CopySessionIdButton,
    ),
  ), 'session-ui: copy session id button')
}
