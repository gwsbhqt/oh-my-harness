import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addPreset, editPreset, movePreset, removePreset } from '../src/quick-reply/presets.ts'

test('添加：去首尾空白、拒绝空的和重复的（按归一化判重）', () => {
  assert.deepEqual(addPreset(['继续'], '  帮我提交推送 '), { ok: true, presets: ['继续', '帮我提交推送'] })
  assert.deepEqual(addPreset(['继续'], '   '), { ok: false, issue: 'empty' })
  assert.deepEqual(addPreset(['继续'], '继续。'), { ok: false, issue: 'duplicate' })
})

test('修改：改成自己（只改标点）可以，改成别的某条算重复', () => {
  assert.deepEqual(editPreset(['继续', '帮我提交推送'], 0, '继续。'), { ok: true, presets: ['继续。', '帮我提交推送'] })
  assert.deepEqual(editPreset(['继续', '帮我提交推送'], 0, '帮我提交推送'), { ok: false, issue: 'duplicate' })
  assert.deepEqual(editPreset(['继续'], 0, ''), { ok: false, issue: 'empty' })
})

test('删除与移动；到头不动', () => {
  assert.deepEqual(removePreset(['a', 'b', 'c'], 1), ['a', 'c'])
  assert.deepEqual(movePreset(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b'])
  assert.deepEqual(movePreset(['a', 'b', 'c'], 0, -1), ['a', 'b', 'c'])
  assert.deepEqual(movePreset(['a', 'b', 'c'], 2, 1), ['a', 'b', 'c'])
})
