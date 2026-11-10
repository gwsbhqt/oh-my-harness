/** Capability catalog: what the model can discover. */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import {
  accessPath,
  describeTools,
  listTools,
  summarize,
  type ToolSchemaLike,
} from '../src/catalog.ts'

const SCHEMAS: ToolSchemaLike[] = [
  { name: 'bash', description: 'Run a shell command. Long detail follows.' },
  { name: 'subagent', description: 'Delegate a task.' },
  { name: 'ask_user_question', description: 'Ask the user something.' },
  { name: 'list', description: 'A tool that is unfortunately named list.' },
  { name: 'my-tool', description: 'Not a Python identifier.' },
  { name: 'mcp__github__search_issues', description: 'Search issues.' },
]

describe('accessPath', () => {
  it('uses a bare call for the six top-level tools', () => {
    assert.equal(accessPath('bash'), 'bash(...)')
    assert.equal(accessPath('glob'), 'glob(...)')
  })

  it('uses dotted access for ordinary tools', () => {
    assert.equal(accessPath('subagent'), 'tools.subagent(...)')
  })

  it('uses subscript when the name collides with a meta method', () => {
    assert.equal(accessPath('list'), 'tools["list"](...)')
    assert.equal(accessPath('describe'), 'tools["describe"](...)')
  })

  it('uses subscript for non-identifier names', () => {
    assert.equal(accessPath('my-tool'), 'tools["my-tool"](...)')
  })
})

describe('summarize', () => {
  it('keeps the first sentence only', () => {
    assert.equal(summarize('Run a shell command. Long detail follows.'), 'Run a shell command.')
  })

  it('returns empty for a missing description rather than inventing one', () => {
    assert.equal(summarize(undefined), '')
  })
})

describe('listTools', () => {
  it('lists every visible tool with a copyable access path', () => {
    const result = listTools(SCHEMAS)
    assert.equal(result.total, SCHEMAS.length)
    const subagent = result.items.find((i) => i.name === 'subagent')
    assert.equal(subagent?.access, 'tools.subagent(...)')
  })

  it('is deterministic (lexicographic), so repeated assemblies match', () => {
    const a = listTools(SCHEMAS).items.map((i) => i.name)
    const b = listTools([...SCHEMAS].reverse()).items.map((i) => i.name)
    assert.deepEqual(a, b)
  })

  it('filters by query over name and description', () => {
    assert.equal(listTools(SCHEMAS, { query: 'issues' }).items[0]?.name, 'mcp__github__search_issues')
    assert.equal(listTools(SCHEMAS, { query: 'delegate' }).items[0]?.name, 'subagent')
  })

  it('reports no match as an empty page, not an error', () => {
    const result = listTools(SCHEMAS, { query: 'definitely-not-here' })
    assert.deepEqual(result.items, [])
    assert.equal(result.next_cursor, null)
  })

  it('signals more results instead of silently truncating', () => {
    const result = listTools(SCHEMAS, { limit: 2 })
    assert.equal(result.items.length, 2)
    assert.notEqual(result.next_cursor, null)
    assert.equal(result.total, SCHEMAS.length)
  })
})

describe('describeTools', () => {
  it('returns the full contract from the host schema', () => {
    const schemas: ToolSchemaLike[] = [
      {
        name: 'echo',
        description: 'Echo text.',
        parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        output: { type: 'object', properties: { text: { type: 'string' } } },
      },
    ]
    const item = describeTools(schemas, ['echo']).items[0]
    assert.equal(item?.['status'], 'available')
    assert.deepEqual((item?.['parameters'] as { required: string[] }).required, ['text'])
    assert.ok(item?.['returns'], 'the output shape must be described, not dropped')
  })

  it('marks an unknown target without failing the whole batch', () => {
    const items = describeTools(SCHEMAS, ['bash', 'nope']).items
    assert.equal(items[0]?.['status'], 'available')
    assert.equal(items[1]?.['status'], 'unknown')
  })

  it('does not invent a schema when the host supplied none', () => {
    const item = describeTools([{ name: 'bare' }], ['bare']).items[0]
    assert.equal(item?.['parameters'], null)
    assert.equal(item?.['returns'], null)
    assert.equal(item?.['metadata_status'], 'incomplete')
    assert.match(String(item?.['reason']), /do not guess/)
  })
})

describe('listTools pagination', () => {
  const many: ToolSchemaLike[] = Array.from({ length: 25 }, (_, i) => ({
    name: `tool_${String(i).padStart(2, '0')}`,
    description: `Tool number ${i}.`,
  }))

  it('walks pages instead of repeating the first one', () => {
    const first = listTools(many, { limit: 10 })
    assert.equal(first.items.length, 10)
    assert.equal(first.next_cursor, '10')

    const second = listTools(many, { limit: 10, cursor: first.next_cursor })
    assert.equal(second.items.length, 10)
    assert.notDeepEqual(
      second.items.map((i) => i.name),
      first.items.map((i) => i.name),
      'a cursor that is ignored would loop the model on page one',
    )

    const third = listTools(many, { limit: 10, cursor: second.next_cursor })
    assert.equal(third.items.length, 5)
    assert.equal(third.next_cursor, null, 'the last page must end the walk')
  })

  it('covers every item exactly once across pages', () => {
    const seen: string[] = []
    let cursor: string | null = null
    do {
      const page = listTools(many, { limit: 7, cursor })
      seen.push(...page.items.map((i) => i.name))
      cursor = page.next_cursor
    } while (cursor !== null)
    assert.equal(seen.length, many.length)
    assert.equal(new Set(seen).size, many.length, 'no duplicates, no gaps')
  })

  it('keeps the filter applied while paging', () => {
    const page = listTools(many, { query: 'number 1', limit: 5 })
    assert.ok(page.items.every((i) => /Tool number 1/.test(i.summary)))
  })

  it('rejects a malformed cursor instead of starting over at page one', () => {
    assert.throws(() => listTools(many, { limit: 5, cursor: 'not-a-number' }), /invalid cursor/)
    assert.deepEqual(listTools(many, { cursor: '999' }).items, [])
  })
})
