/**
 * 同一步里的重复通知只留第一条。
 *
 * ## 现象
 *
 * 宿主的 `repeat-tool-reminder` 对每一次重复调用各发一份提醒：模型一步发一批相同的
 * 并发调用时，这一步会被塞进一堆一模一样的提醒。第二份起信息量为零。
 *
 * ## 做法
 *
 * `agent/pre-step` 整理时，通知消息（`source.form` 为 `notice`）按「角色 + 完整来源 + 全部内容」
 * 与已保留的通知比对，完全相同的不再留。只动通知消息；用户、助手消息一模一样也不动。
 * 先经「通知加框」再进这里，加框不改变相同性。`source` 原样保留。
 *
 * ## 删除条件
 *
 * 宿主在同一步内对相同通知去重时，删掉这一项（本文件、`index.ts` 里对应的一行和开关）。
 *
 * @module
 */

import { isDeepStrictEqual } from 'node:util'
import type { MessageLike } from './notice.ts'

/**
 * 把这一步消息列表里一模一样的通知去掉，只留第一条。
 *
 * @param messages - 这一步要进入对话的消息（已过完其他整理）
 * @returns 去掉重复通知后的新列表；没有重复时逐条原样
 */
export function dedupeNotices<M extends MessageLike>(messages: readonly M[]): M[] {
  const seen: M[] = []
  const out: M[] = []
  let dropped = false
  for (const m of messages) {
    if (m.source?.form === 'notice') {
      if (seen.some(previous => previous.role === m.role
        && isDeepStrictEqual(previous.source, m.source)
        && isDeepStrictEqual(previous.content, m.content))) {
        dropped = true
        continue
      }
      seen.push(m)
    }
    out.push(m)
  }
  return dropped ? out : [...messages]
}
