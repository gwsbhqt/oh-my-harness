import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import { reminderSummary, reminderText } from '../../tooling/runtime/notice.mjs'

export interface NoticeReceipt {
  accepted: true
  scheduled: boolean
  delivery: 'followup' | 'steer' | 'inject'
  agentStatus: string
}
export interface NoticeAgent {
  readonly status: string
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
  const title = summary.replace(/^dsh-control\s*[：:]\s*/, '')
  agent[delivery](createUserMessage({
    content: [{ type: 'text', text: reminderText('dsh-control', title, text) }],
    source: { kind: 'dsh-control', form: 'notice', summary: boundContextSummary(reminderSummary('dsh-control', title)) },
  }))
  return { accepted: true, scheduled: agent.status === 'running', delivery, agentStatus: agent.status }
}
