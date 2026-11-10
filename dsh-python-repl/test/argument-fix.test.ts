/**
 * An argument rejection carries the exact fix.
 *
 * Field case (session 9ca3a036, 2026-09-29): Gemini 3.8 Flash called
 * `tools.read_image({"image_path": ...})` 16 times. The host said only
 * `missing required property "file_path"`; the model never connected that to
 * its own `image_path` and never followed the pointer to `tools.describe`.
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { defineTool, validateArgs, ToolArgsError } from '@deepseek-ai/dsh-tools'
import { argumentFix } from '../src/catalog.ts'
import { ReplSession } from '../src/session.ts'
import type { BoundTool } from '../src/lease.ts'

/** The host's own parameter spec, compiled the way a real tool is. */
const IMAGE_SPEC = { file_path: { type: 'string', required: true, description: 'Image path.' } } as const
const READ_IMAGE = defineTool({
  name: 'read_image', description: 'Read an image.', parameters: IMAGE_SPEC,
  output: { schema: { type: 'null' }, render: () => [] }, execute: async () => null,
} as never).parameters as unknown
const READ = {
  type: 'object',
  properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } },
  required: ['file_path'],
}
const MISSING = 'invalid arguments: missing required property "file_path"'

describe('argumentFix', () => {
  it('reads an MCP server\'s pydantic "Field required" the same way (openviking read, 2026-11-03)', () => {
    const message = 'Error executing tool read: 1 validation error for readArguments\nuris\n  Field required [type=missing, input_value={\'uri\': \'viking://x\'}, input_type=dict]\n    For further information visit https://errors.pydantic.dev/2.12/v/missing'
    const schema = { type: 'object', properties: { uris: { type: 'array', items: { type: 'string' } } }, required: ['uris'] }
    const fix = argumentFix('mcp__openviking__read', message, { uri: 'viking://x' }, schema)
    assert.match(fix, /`uri` is not a parameter of mcp__openviking__read; it should be `uris`/)
    assert.equal(argumentFix('mcp__openviking__read', 'NOT_FOUND: File not found: viking://x', { uris: ['viking://x'] }, schema), '')
  })

  it('pairs the guessed name with the missing one and shows the corrected call', () => {
    const fix = argumentFix('read_image', MISSING, { image_path: '/tmp/fig.png' }, READ_IMAGE)
    assert.match(fix, /`image_path` is not a parameter of read_image; it should be `file_path`\./)
    assert.match(fix, /Corrected call: tools\.read_image\(\{"file_path":"\/tmp\/fig\.png"\}\)/)
  })

  it('keeps the arguments that were right', () => {
    const fix = argumentFix('read', MISSING, { path: 'a.txt', limit: 5 }, READ)
    assert.match(fix, /`path` is not a parameter of read; it should be `file_path`/)
    assert.match(fix, /read\(\{"file_path":"a\.txt","limit":5\}\)/)
  })

  it('pairs several by similarity, not by order', () => {
    const schema = {
      type: 'object',
      properties: { job_id: { type: 'string' }, timeout_ms: { type: 'number' } },
      required: ['job_id', 'timeout_ms'],
    }
    const message = 'invalid arguments: missing required property "job_id"; missing required property "timeout_ms"'
    const fix = argumentFix('job_output', message, { timeout: 5, id: 'j1' }, schema)
    assert.match(fix, /`id` is not a parameter of job_output; it should be `job_id`/)
    assert.match(fix, /`timeout` is not a parameter of job_output; it should be `timeout_ms`/)
  })

  it('lists an unknown name it cannot pair, with the real parameters', () => {
    const message = 'invalid arguments: missing required property "file_path"; missing required property "x"'
    const schema = { type: 'object', properties: { file_path: {}, x: {} }, required: ['file_path', 'x'] }
    const fix = argumentFix('t', message, { zzz: 1, qqq: 2 }, schema)
    assert.match(fix, /Not parameters of t: `zzz`, `qqq`\. Its parameters are: `file_path`, `x`\./)
    assert.doesNotMatch(fix, /Corrected call/)
  })

  it('does not advertise shortened text as a real path', () => {
    const fix = argumentFix('read_image', MISSING, { image_path: 'x'.repeat(2000) }, READ_IMAGE)
    assert.doesNotMatch(fix, /Corrected call/)
    assert.match(fix, /too long/)
  })

  it('never turns a scalar query into an array of queries', () => {
    const schema = { type: 'object', properties: {
      queries: { type: 'array', items: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    }, required: ['queries'] }
    const fix = argumentFix('web_search', 'invalid arguments: missing required property "queries"', { query: 'words' }, schema)
    assert.doesNotMatch(fix, /Corrected call/)
    assert.match(fix, /queries.*array/)
  })

  it('preserves nested values and emits executable Python literals', () => {
    const schema = { type: 'object', properties: { entries: { type: 'array', items: {} } }, required: ['entries'] }
    const fix = argumentFix('t', 'invalid arguments: missing required property "entries"', { entry: [true, null, { ok: false }] }, schema)
    assert.match(fix, /Corrected call: tools\.t\(\{"entries":\[True,None,\{"ok":False\}\]\}\)/)
    assert.doesNotMatch(fix, /"\[\.\.\.\]"|"\{\.\.\.\}"/)
  })

  it('validates every argument and all required fields before suggesting a call', () => {
    for (const [args, schema] of [
      [{ path: 'a', limit: 'five' }, READ],
      [{ path: 'a' }, { ...READ, required: ['file_path', 'limit'] }],
      [{ path: 123 }, READ],
      [{ path: 'a' }, { ...READ, properties: { file_path: { type: 'string', enum: ['b'] } } }],
      [{ path: 'a' }, { ...READ, properties: { file_path: { type: 'string', pattern: '^b$' } } }],
    ] as const) {
      assert.doesNotMatch(argumentFix('read', MISSING, args, schema), /Corrected call/)
    }
  })

  it('explains array/object failures without automatic wrapping or dropping fields', () => {
    const schema = { type: 'object', properties: { files: { type: 'array', items: {
      type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
    } } }, required: ['files'] }
    for (const args of [{ files: ['a.md'] }, { files: [{ path: 'a.md', id: 1 }] }]) {
      const fix = argumentFix('present', 'invalid arguments: files has invalid shape', args, schema)
      assert.doesNotMatch(fix, /Corrected call/)
      assert.match(fix, /files/)
      assert.match(fix, /not converted or dropped/)
    }
  })

  it('uses exact-one validation and refuses unsupported schemas', () => {
    const schema = { type: 'object', properties: { file_path: { oneOf: [{ type: 'string' }, {}] } }, required: ['file_path'] }
    assert.doesNotMatch(argumentFix('read', MISSING, { path: 'a' }, schema), /Corrected call/)
    assert.doesNotMatch(argumentFix('read', MISSING, { path: 'a' }, { ...READ, anyOf: [{ type: 'object' }] }), /Corrected call/)
  })

  it('points at the contract when there is no unknown name to explain', () => {
    const pointer = 'read the contract with: await tools.describe("read_image")'
    assert.equal(argumentFix('read_image', MISSING, {}, READ_IMAGE), pointer)
    assert.equal(argumentFix('read_image', 'invalid arguments: "file_path" must be a string', { file_path: 1 }, READ_IMAGE), pointer)
    assert.equal(argumentFix('read_image', MISSING, { image_path: 'a' }, undefined), pointer)
    assert.equal(argumentFix('read_image', 'ENOENT: no such file', { image_path: 'a' }, READ_IMAGE), '')
  })

  it('reads the message the real host validator produces', () => {
    // The host keeps the root object open, so `image_path` itself is NOT a
    // violation: the only text the model gets is the missing name.
    const violations = validateArgs(IMAGE_SPEC as never, { image_path: '/tmp/a.png' })
    assert.deepEqual(violations, ['missing required property "file_path"'])
    const message = new ToolArgsError(violations).message
    assert.match(argumentFix('read_image', message, { image_path: '/tmp/a.png' }, READ_IMAGE), /it should be `file_path`/)
  })

  it('counts every array separator against the length budget', () => {
    const schema = { type: 'object', properties: { entries: { type: 'array', items: { type: 'null' } } }, required: ['entries'] }
    const fix = argumentFix('bounded', 'invalid arguments: missing required property "entries"', { entry: Array(130).fill(null) }, schema)
    assert.doesNotMatch(fix, /Corrected call/)
    assert.match(fix, /too long/)
  })
})

describe('through a real kernel', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const root = join(here, '..')
  const session = new ReplSession({
    python: process.env['DSH_PY'] ?? 'python3',
    vendorRoot: join(root, 'vendor', 'prime'),
    pythonRoot: join(root, 'python'),
  })
  after(() => session.dispose())

  it('the cell sees the fix, keeps the host error class, and no longer only points at describe', async () => {
    const rejecting: BoundTool = async (args) => {
      const violations = validateArgs(IMAGE_SPEC as never, args)
      if (violations.length > 0) throw new ToolArgsError(violations)
      return null
    }
    const tools = new Map<string, BoundTool>([['read_image', rejecting]])
    const schemas = [{ name: 'read_image', description: 'Read an image.', parameters: READ_IMAGE }]
    const cell = await session.runCell(
      'try:\n    await tools.read_image({"image_path": "/tmp/fig.png"})\nexcept ToolCallError as e:\n    msg = str(e)\nmsg',
      tools,
      undefined,
      schemas,
    )
    assert.equal(cell.error, undefined, JSON.stringify(cell.error))
    const text = cell.logs.join('')
    assert.match(text, /missing required property/)
    assert.match(text, /it should be `file_path`/)
    assert.match(text, /Corrected call: tools\.read_image\(\{"file_path":"\/tmp\/fig\.png"\}\)/)
    assert.doesNotMatch(text, /read the contract with/)

    const fixed = await session.runCell('await tools.read_image({"file_path": "/tmp/fig.png"}) is None', tools, undefined, schemas)
    assert.match(fixed.logs.join(''), /True/)
  })

  it('without a schema the old pointer to describe stays', async () => {
    const tools = new Map<string, BoundTool>([['read_image', async () => { throw new ToolArgsError(['missing required property "file_path"']) }]])
    const cell = await session.runCell(
      'try:\n    await tools.read_image({"image_path": "x"})\nexcept ToolCallError as e:\n    msg = str(e)\nmsg',
      tools,
    )
    assert.match(cell.logs.join(''), /read the contract with: await tools\.describe\(\\?"read_image\\?"\)/)
  })
})
