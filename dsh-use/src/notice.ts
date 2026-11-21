import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { reminderSummary, reminderText } from '../../tooling/runtime/notice.mjs'

export interface NoticeReceipt {
  accepted: true
  messageId?: string
  insertionSeq?: number
  scheduled: boolean
  delivery: 'followup' | 'steer' | 'inject'
  agentStatus: string
}
export interface NoticeAgent {
  readonly status: string
  readonly session?: { readonly seq: number }
  followup(message: unknown): void
  steer(message: unknown): void
  inject(message: unknown): void
}
export interface SessionControllerLike {
  resolveAgent(sessionId: string): Promise<{ agent: NoticeAgent } | { error: unknown }>
}

/**
 * 返回宿主已安排执行的证据；接收成功不代表模型已经回复。
 * quiet：只排进上下文，不唤醒闲着的会话，它下一轮开始时才看到。
 */
export async function deliverNotice(controller: SessionControllerLike, sessionId: string, text: string, summary: string, quiet = false): Promise<NoticeReceipt> {
  const found = await controller.resolveAgent(sessionId)
  if ('error' in found) throw found.error instanceof Error ? found.error : new Error(String(found.error))
  const agent = found.agent
  const delivery = quiet ? 'inject' : agent.status === 'running' ? 'steer' : 'followup'
  const title = summary.replace(/^dsh-use\s*[：:]\s*/, '')
  const message = createUserMessage({
    content: [{ type: 'text', text: reminderText('dsh-use', title, text) }],
    source: { kind: 'dsh-use', form: 'notice', summary: boundContextSummary(reminderSummary('dsh-use', title)) },
  })
  const insertionSeq = quiet ? agent.session?.seq : undefined
  agent[delivery](message)
  return { accepted: true, ...(quiet ? { messageId: message.id } : {}), ...(insertionSeq === undefined ? {} : { insertionSeq }), scheduled: agent.status === 'running', delivery, agentStatus: agent.status }
}
