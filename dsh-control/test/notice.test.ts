import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deliverNotice, type NoticeAgent } from '../src/notice.ts'

function fixture(status = 'idle', wakes = true) {
  const messages: { delivery: string; message: unknown }[] = []
  const agent = {
    status,
    followup(message: unknown) { messages.push({ delivery: 'followup', message }); if (wakes) this.status = 'running' },
    steer(message: unknown) { messages.push({ delivery: 'steer', message }); if (wakes) this.status = 'running' },
    inject(message: unknown) { messages.push({ delivery: 'inject', message }) },
  }
  const checked: NoticeAgent = agent
  const loaded: string[] = []
  const controller = { resolveAgent: async (id: string) => { loaded.push(id); return { agent: checked } } }
  return { agent, controller, messages, loaded }
}

test('通知加载空闲会话，用公开 followup 安排下一轮并保留插件来源', async () => {
  const f = fixture()
  const receipt = await deliverNotice(f.controller, 'fixture-idle', 'continue verification', 'restart result')
  assert.deepEqual(f.loaded, ['fixture-idle'])
  assert.deepEqual(receipt, { accepted: true, scheduled: true, delivery: 'followup', agentStatus: 'running' })
  assert.equal(f.messages.length, 1)
  assert.equal(f.messages[0]!.delivery, 'followup')
  assert.deepEqual((f.messages[0]!.message as { source: unknown }).source, { kind: 'dsh-control', form: 'notice', summary: '[dsh-control] restart result' })
})

test('运行中通知用 steer；仅记录不调度必须如实返回未确认', async () => {
  const running = fixture('running')
  assert.equal((await deliverNotice(running.controller, 'fixture-running', '继续', '结果')).delivery, 'steer')
  const idle = fixture('idle', false)
  assert.deepEqual(await deliverNotice(idle.controller, 'fixture-idle', '继续', '结果'), { accepted: true, scheduled: false, delivery: 'followup', agentStatus: 'idle' })
  assert.equal(idle.messages.length, 1)
})

test('quiet 通知只排进上下文，不唤醒闲着的会话', async () => {
  const f = fixture()
  assert.deepEqual(await deliverNotice(f.controller, 'fixture-idle', '任务已重新拉起', '重启', true), { accepted: true, scheduled: false, delivery: 'inject', agentStatus: 'idle' })
  assert.deepEqual(f.messages.map((m) => m.delivery), ['inject'])
})

test('加载失败不投递，不虚构调度成功', async () => {
  await assert.rejects(deliverNotice({ resolveAgent: async () => ({ error: new Error('session/not-found') }) }, 'fixture-missing', '继续', '结果'), /session\/not-found/)
})
