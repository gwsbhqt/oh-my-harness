/**
 * 任务改名：后台任务的完成通知用 description 当名字，不再塞整条命令。
 *
 * ## 现象
 *
 * `bash` 以 `run_in_background` 启动时，宿主把**整条命令**当作任务名
 * （`dsh-tool-bash`：`label: args.command`），完成通知照抄它：
 *
 *   background job bash-4 (bash: ssh -o BatchMode=yes example-host 'echo ZXhhbXBsZQ==…
 *   …几百到上千个字符… | base64 -d | bash -l' 2>&1) finished [status: completed, exit code: 0]
 *
 * 多条这样的通知重复携带完整命令。
 * 模型明明给了 `description`（「Run example task」），通知里却用不上。
 *
 * ## 做法
 *
 * - `tools/result`：一次 `bash` 后台调用成功返回 `{kind:'background', jobId}`，或超时晋级返回 `{kind:'promoted', jobId}` 时，
 *   按 agent 记下 `jobId → description`（同一个 id 在不同会话里会重复）。
 *   PTC 代码格里的子调用同样经过这里。
 * - `agent/pre-step`（最外层）：`tool-jobs` 发来的完成通知里，把
 *   `(bash: <整条命令>)` 换成 `(bash: <description>)`，`summary` 同步换掉。
 *   其余字段原样保留；没记录到 description 的通知不动。
 *
 * ## 删除条件
 *
 * 上游让任务名取 `description`（或让调用方指定任务名）时，删掉这一项（本文件、`index.ts` 里对应的一行和开关）。
 *
 * @module
 */

/** 进入一步的消息里本插件关心的那部分形状。 */
export interface MessageLike {
  readonly role: string
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>
  readonly source?: { readonly kind?: string; readonly plugin?: string; readonly summary?: string } & Record<string, unknown>
  readonly [key: string]: unknown
}

/** 一次工具调用里本插件关心的部分。 */
export interface CallLike {
  readonly name: string
  readonly arguments: unknown
}

/** 一次工具结果里本插件关心的部分。 */
export interface ResultLike {
  readonly isError: boolean
  readonly value?: unknown
}

/**
 * 一次调用是不是「带 description 的后台 bash」，是的话给出任务 id 与名字。
 *
 * @returns `[jobId, description]`，不相关的调用返回 undefined
 */
export function backgroundJob(exec: CallLike, result: ResultLike): [string, string] | undefined {
  if (exec.name !== 'bash' || result.isError) return undefined
  const args = exec.arguments as { run_in_background?: unknown; description?: unknown } | null
  const value = result.value as { kind?: unknown; jobId?: unknown } | null
  if (args === null || typeof args !== 'object') return undefined
  if (value === null || typeof value !== 'object' || typeof value.jobId !== 'string') return undefined
  if (value.kind !== 'promoted' && (value.kind !== 'background' || args.run_in_background !== true)) return undefined
  const description = typeof args.description === 'string' ? args.description.trim().replace(/\s+/g, ' ') : ''
  return description.length > 0 ? [value.jobId, description] : undefined
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

// Not anchored: the notice framing (notice.ts) may already have wrapped the text.
const NOTICE = /background job (\S+) \((\w+): /

/**
 * 把一条完成通知里的任务名换成 description。
 *
 * 结束边界用**最后一个** `) finished [status:`：命令里自己可能出现括号，
 * 状态行才是宿主固定写在名字后面的那一段。0.2.2-rc.1 起通知在 `. Output:` 后接上命令输出，
 * 输出里也可能有这串字，所以只在它之前找。
 *
 * @param message - 这一步要进入对话的一条消息
 * @param names - 这个 agent 的 `jobId → description`
 * @param max - 名字最多保留的字符数
 * @returns 改好的新消息；不是完成通知、或没有记录时原样返回
 */
export function relabel<M extends MessageLike>(message: M, names: ReadonlyMap<string, string>, max: number): M {
  if (message.role !== 'user' || message.source?.kind !== 'tool-jobs' || message.source.form !== 'notice') return message
  let changed = false
  let kindSeen = ''
  let label = ''
  const content = message.content.map((block) => {
    if (block.type !== 'text' || block.text === undefined) return block
    const text = block.text
    const head = NOTICE.exec(text)
    const output = text.indexOf('. Output:\n', head?.index ?? 0)
    const end = (output < 0 ? text : text.slice(0, output)).lastIndexOf(') finished [status:')
    if (head === null || end < head.index + head[0].length) return block
    const name = names.get(head[1]!)
    if (name === undefined) return block
    changed = true
    kindSeen = head[2]!
    label = clip(name, max)
    return { ...block, text: `${text.slice(0, head.index)}${head[0]}${label}${text.slice(end)}` }
  })
  if (!changed) return message
  const summary = message.source.summary
  const status = typeof summary === 'string' ? /\[status:[^\]]*\]$/.exec(summary)?.[0] : undefined
  return {
    ...message,
    content,
    source: { ...message.source, summary: `${kindSeen} ${label}${status === undefined ? '' : ` ${status}`}` },
  }
}
