/**
 * The prompt must describe the runtime that actually runs.
 *
 * The official Python SDK preamble teaches an async function body with a
 * top-level `return`. Under persistent cells that is wrong, and leaving both
 * texts in the prompt is worse than either alone. These tests run against the
 * REAL renderer from the installed dsh-tools.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { CELL_INSTRUCTIONS, renderSkillCatalog, rewriteSdkSection } from '../src/prompt.ts'
// 0.2.2-rc.1 起这个函数原样挪进了 PTC 执行器包。
import { renderToolsSdkPy } from '@deepseek-ai/dsh-tool-executor-ptc'

const FIXTURE = [
  {
    name: 'lookup',
    description: 'Look a thing up.',
    parameters: {
      type: 'object' as const,
      properties: { id: { type: 'string' as const } },
      required: ['id'],
      additionalProperties: false as const,
    },
    output: {
      type: 'object' as const,
      properties: { found: { type: 'boolean' as const } },
      additionalProperties: false as const,
    },
  },
]

describe('rewriteSdkSection', () => {
  const official = renderToolsSdkPy(FIXTURE as never)

  it('replaces the official function-body preamble with the cell instructions', () => {
    const preamble = official.slice(0, official.indexOf('```')).trim()
    assert.ok(preamble.length > 0, 'the official section has a preamble to replace')
    const rewritten = rewriteSdkSection(official)
    assert.ok(rewritten.startsWith(CELL_INSTRUCTIONS))
    assert.ok(!rewritten.includes(preamble))
  })

  it('keeps the generated declarations verbatim', () => {
    const rewritten = rewriteSdkSection(official)
    const fence = official.slice(official.indexOf('```python'))
    assert.ok(rewritten.endsWith(fence), 'declaration block must survive untouched')
    assert.match(rewritten, /class ToolCallError\(Exception\)/)
    assert.match(rewritten, /async def lookup/)
  })

  it('states the cell rules the runtime actually enforces', () => {
    const rewritten = rewriteSdkSection(official)
    assert.match(rewritten, /No top-level `return`/)
    assert.match(rewritten, /trailing expression/)
    assert.match(rewritten, /persistent Python CELL/)
  })

  it('leaves an unrecognized section alone rather than corrupting it', () => {
    const odd = 'some other section with no fence'
    assert.equal(rewriteSdkSection(odd), odd)
  })
})

describe('renderSkillCatalog', () => {
  it('says nothing when there are no Python skills', () => {
    assert.equal(renderSkillCatalog([]), '')
    assert.equal(renderSkillCatalog([
      { skill: 'guide', description: 'Just instructions.', path: '/s/guide', instructions_file: 'SKILL.md', import_name: null, src: null, status: 'docs-only' },
    ]), '', 'a docs-only skill is never advertised as callable')
  })

  it('maps each Python skill to its kernel name and repeats a description only when the Python one differs', () => {
    const text = renderSkillCatalog([
      { skill: 'browser-use', description: 'Drive a browser.', path: '/s/browser-use', instructions_file: 'PYSKILL.md', import_name: 'browser_use', src: '/s/browser-use/src', status: 'discovered' },
      { skill: 'word-count', description: 'Count words in the kernel.', standard_description: 'Count words.', path: '/s/word-count', instructions_file: 'PYSKILL.md', import_name: 'word_count', src: '/s/word-count/src', status: 'discovered' },
    ])
    assert.match(text, /`skills\.browser_use` — browser-use \(PYSKILL\.md\)/)
    assert.doesNotMatch(text, /Drive a browser/, 'the host skill list already carries the same description')
    assert.match(text, /`skills\.word_count` — word-count: Count words in the kernel\. \(PYSKILL\.md\)/)
  })
})
