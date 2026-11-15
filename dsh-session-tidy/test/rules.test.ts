import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isJunkTitle } from '../src/rules.ts'

test('isJunkTitle 认得测试/临时会话模板标题', () => {
  assert.equal(isJunkTitle('运行慢查询并汇总结果'), true)
  assert.equal(isJunkTitle('验证后台命令结果读取'), true)
  assert.equal(isJunkTitle('统计目录文件数量及首个文件名'), true)
  assert.equal(isJunkTitle(''), true)
  assert.equal(isJunkTitle('   '), true)
})

test('isJunkTitle 不误判真实工作会话', () => {
  assert.equal(isJunkTitle('插件梳理与合并评估'), false)
  assert.equal(isJunkTitle('dsh-guard 合并迁移准备'), false)
  assert.equal(isJunkTitle('现在的inkbridge怎么样了，打开'), false)
})
