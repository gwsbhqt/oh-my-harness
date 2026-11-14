import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isRootAgent } from '../src/goal-guard.ts'

// 原故障：0.2.2-rc.2 的 ctx.agents 没有 roots()，判断顶层时抛 TypeError；改为只看 agent 自己的会话头。
test('顶层会话按会话头认出，不依赖 ctx.agents.roots', () => {
  assert.equal(isRootAgent({ session: { header: { origin: 'user' } } }), true)
  assert.equal(isRootAgent({ session: { header: {} } }), true)
})

test('子代理不算顶层', () => {
  assert.equal(isRootAgent({ session: { header: { origin: 'subagent' } } }), false)
  assert.equal(isRootAgent({ session: { header: { delegationDepth: 1 } } }), false)
})

test('拿不到会话头时不补位（null / undefined 也不抛）', () => {
  assert.equal(isRootAgent({}), false)
  assert.equal(isRootAgent(undefined), false)
  assert.equal(isRootAgent(null), false)
  assert.equal(isRootAgent({ session: null }), false)
})