/**
 * 通知加框：把插件发的通知标成「系统提醒」，别让模型当成用户说的话。
 *
 * ## 现象
 *
 * `repeat-tool-reminder` 的「You are repeating the exact same tool call…」、
 * `tool-jobs` 的「background job bash-4 … finished」都以 **user 角色**进入对话，
 * 正文里没有任何「这是系统发的」的标记，模型难以区分用户消息与插件通知。
 *
 * ## 做法
 *
 * 在 `agent/pre-step` 的最外层（`prepend`）看这一步要进来的消息：通知（`source.form` 为
 * `notice`）的 `source.kind` 在名单里的，正文包进统一的 `<system-reminder>` 外框，
 * 第一行用英文写明来源和「不是用户说的」。默认名单是 `*`，覆盖所有插件通知。
 * `source` 原样保留——宿主和其他插件靠它识别消息，改了会让它们认不出自己发的东西。
 *
 * ## 删除条件
 *
 * 上游让这些通知以系统消息（或自带明确标记）的形式进入对话时，删掉这一项（本文件、`index.ts` 里对应的一行和开关）。
 *
 * @module
 */

import { reminderText } from '../../tooling/runtime/notice.mjs'

const OPEN = '<system-reminder>'

/** 进入一步的消息里本插件关心的那部分形状。 */
export interface MessageLike {
  readonly role: string
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>
  readonly source?: { readonly kind?: string; readonly form?: string } & Record<string, unknown>
  readonly [key: string]: unknown
}

/**
 * 给一条插件通知加上系统提醒的外框；不在名单里、或已经带框的原样返回。
 *
 * @param message - 这一步要进入对话的一条消息
 * @param sources - 需要标记的通知来源名单（`source.kind`）
 * @returns 标好的新消息（原消息可能被冻结，不就地修改）
 */
export function labelNotice<M extends MessageLike>(message: M, sources: readonly string[]): M {
  // 0.1.7 的插件通知：`source` 是 `{ kind: <插件名>, form: 'notice' }`（如 repeat-tool-reminder、tool-jobs）。
  const plugin = message.source?.form === 'notice' && typeof message.source.kind === 'string' ? message.source.kind : undefined
  if (message.role !== 'user' || plugin === undefined || !(sources.includes('*') || sources.includes(plugin))) return message
  const firstText = message.content.find((block) => block.type === 'text')
  if (firstText === undefined || (firstText.text ?? '').trimStart().startsWith(OPEN)) return message
  let framed = false
  const content = message.content.map((block) => {
    if (block.type !== 'text' || framed) return block
    framed = true
    return { ...block, text: reminderText(plugin, 'Automatic system notice (the user did not write this)', block.text ?? '') }
  })
  return { ...message, content }
}
