import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session } from '@deepseek-ai/dsh-session'
import { apply, Config } from '../src/index.ts'
import { OUTPUT_LOOP_CODE } from '../src/guard.ts'

test('真实 Session：失败尝试不进入历史，纠错提示进入重试历史', async () => {
  const session = Session.create('session-output-guard-test' as never)
  session.append('user/message', createUserMessage({
    source: { kind: 'user' },
    content: [{ type: 'text', text: '完成当前任务' }],
  }), { surfaceOp: 'append' })
  session.append('assistant/attempt', { turn: 1, step: 1, stream: [] })
  assert.equal(session.deriveMessages().length, 1)

  let requestError: ((payload: never, next: () => Promise<string>) => Promise<unknown>) | undefined
  const ctx = { on(event: string, listener: never) {
    if (event === 'agent/request-error') requestError = listener
    return () => undefined
  } }
  apply(ctx as never, Config({}))
  const agent = { id: session.id, session } as unknown as Agent
  const result = await requestError!({
    agent, turn: 1, step: 1, failure: { code: OUTPUT_LOOP_CODE, message: 'loop' },
  } as never, async () => 'terminal')
  assert.deepEqual(result, { kind: 'retry' })

  const messages = session.deriveMessages()
  assert.equal(messages.length, 2, '重试应读到原用户消息和一条纠错提示')
  assert.equal(messages[1]!.source.kind, 'output-guard')
  const content = messages[1]!.content[0]
  assert.ok(content?.type === 'text')
  assert.match(content.text, /Return to the user's latest request/)
})
