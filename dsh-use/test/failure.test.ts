import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FailureReasonCollector } from '../src/cli/failure.ts'

test('真实 doctor 单行失败优先于随后回滚失败和 warning，兼容无 details 旧报告', () => {
  const collector = new FailureReasonCollector()
  const check = { id: 'link-build-freshness', ok: false, message: '多项正常; dsh-example: 构建内容已变化: inputs: core/doctor.mjs' }
  collector.push(JSON.stringify({ ok: false, checks: [check] }) + '\n')
  collector.push(JSON.stringify({ event: '部署未完成，已恢复本轮写入', reason: 'Command ... exited1' }) + '\n')
  collector.push('WARN external/noExternal 已弃用\n'.repeat(10))
  assert.match(collector.reason(), /link-build-freshness.*dsh-example.*core\/doctor\.mjs/)
  assert.doesNotMatch(collector.reason(), /WARN|Command/)
})

test('详细检查只选失败项；构建报告只取失败插件和 errors，不读正常构建输出', () => {
  const checks = new FailureReasonCollector()
  checks.push(JSON.stringify({ ok: false, checks: [{ id: 'link-build-freshness', ok: false, message: '正常'.repeat(10000), details: [{ name: 'normal', ok: true, message: '正常' }, { name: 'dsh-example', ok: false, message: 'inputs: core/doctor.mjs' }] }] }))
  assert.equal(checks.reason(), 'link-build-freshness: dsh-example: inputs: core/doctor.mjs')
  const builds = new FailureReasonCollector()
  builds.push(JSON.stringify({ schemaVersion: 1, ok: false, plugins: [{ name: 'normal', action: 'verified', build: { stdout: 'success' } }, { name: 'broken', action: 'failed', error: '构建出错', build: { stdout: '正常输出', stderr: 'WARN external 已弃用' } }], errors: ['第二个错误'], summary: {} }))
  assert.equal(builds.reason(), 'broken: 构建出错；第二个错误')
})

test('超大单行 JSON 的末尾失败检查仍能提取，不因选因缓冲上限丢失', () => {
  const collector = new FailureReasonCollector()
  const report = JSON.stringify({ ok: false, padding: '正常'.repeat(2 * 1024 * 1024), checks: [{ id: 'large-check', ok: false, message: '末尾真实失败' }] })
  for (let index = 0; index < report.length; index += 65536) collector.push(report.slice(index, index + 65536))
  assert.equal(collector.reason(), 'large-check: 末尾真实失败')
})

test('结构化错误保留阶段；普通错误、仅警告和超长行仍可选取真实原因', () => {
  const stage = new FailureReasonCollector()
  stage.push(JSON.stringify({ ok: false, error: { code: 'failed', stage: 'verify-startup', message: '插件没有加载' } }))
  assert.deepEqual(stage.result(), { priority: 1, stage: 'verify-startup', reason: '插件没有加载' })
  const plain = new FailureReasonCollector()
  plain.push('输出'.repeat(2 * 1024 * 1024))
  plain.push('\nError: permission denied\nWARN external 已弃用\n')
  assert.equal(plain.reason(), 'Error: permission denied')
  const warning = new FailureReasonCollector()
  warning.push('WARN external/noExternal 已弃用\n')
  assert.equal(warning.reason(), '')
})
