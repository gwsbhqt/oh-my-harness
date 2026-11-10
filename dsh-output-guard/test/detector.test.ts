import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findRepeatedSuffix, normalizeForComparison, RepetitionDetector, type LoopRules } from '../src/detector.ts'

const rules: LoopRules = {
  repeatCount: 8,
  minCycleChars: 4,
  maxCycleChars: 160,
  minRepeatedChars: 64,
  windowChars: 1000,
}
const sampleCycle = '\n\n**测试。**\n\n**好。**\n\n好。'

test('虚构短句循环能在尾部识别', () => {
  const match = findRepeatedSuffix(normalizeForComparison('先检查现状。' + sampleCycle.repeat(20)), rules)
  assert.ok(match)
  assert.equal(match.cycleChars, normalizeForComparison(sampleCycle).length)
  assert.equal(match.repeats, Math.ceil(64 / match.cycleChars), 'a 7-char unit needs 10 repeats to cover 64 chars')
})

test('任意分片与 Markdown 空白差异不会躲过检测', () => {
  const detector = new RepetitionDetector(rules)
  const variants = ['\n\n**测试。**\n\n**好。**\n\n好。', '\n测试。\n好。\n好。\n', '\n__测试。__\n**好。**\n好。']
  let match
  for (let index = 0; index < 36; index++) {
    const text = variants[index % variants.length]!
    for (const char of text) match = detector.push(char) ?? match
  }
  assert.ok(match)
})

test('普通分析、短重复与不同结尾不报警', () => {
  assert.equal(findRepeatedSuffix('先读取配置，再核对实际调用链，最后验证结果。', rules), undefined)
  assert.equal(findRepeatedSuffix(sampleCycle.repeat(7), rules), undefined)
  assert.equal(findRepeatedSuffix(sampleCycle.repeat(12) + '现在执行检查。', rules), undefined)
})

test('正常 Markdown 表格分隔行不算文字循环', () => {
  const header = '| Index | Item | Category | Status | Owner | Group | Count | Flag | Notes |\n'
  assert.equal(findRepeatedSuffix(normalizeForComparison(header + '|---|---|---|---|---|---|---|---|---|'), rules), undefined)
  assert.equal(findRepeatedSuffix(normalizeForComparison(header + '|---'.repeat(20)), rules), undefined)
})

test('重复段本身不足 minRepeatedChars 时不报警', () => {
  const prefix = '这是一段很长的正常分析内容和结论说明。'
  assert.equal(findRepeatedSuffix(normalizeForComparison(prefix + '测试单元'.repeat(8)), rules), undefined)
  const match = findRepeatedSuffix(normalizeForComparison(prefix + '测试单元'.repeat(16)), rules)
  assert.ok(match)
  assert.deepEqual(match, { cycleChars: 4, repeats: 16 }, 'a short unit reports the repeats it actually needed, not repeatCount')
})

test('纯数字与标点组成的列表不算文字循环', () => {
  assert.equal(findRepeatedSuffix(normalizeForComparison('统计结果如下：' + '","0'.repeat(20)), rules), undefined)
})
