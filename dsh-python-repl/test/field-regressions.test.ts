/**
 * Regressions from real GUI sessions.
 *
 * Each defect here lived in a seam the other tests do not cross:
 *
 * - The `export default` bug needed the cordis LOADER; tests import `apply`
 *   directly, so `apply()` always ran for them and never ran in production.
 * - The NaN hang needed a value that serializes to invalid JSON; fixtures
 *   only ever passed clean data.
 * - The catalog aliasing needed three namespaces compared side by side; each
 *   was only ever asserted on its own.
 *
 * The lesson these encode: a test that constructs the object under test by
 * hand cannot catch a bug in how the object gets constructed.
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ReplSession } from '../src/session.ts'
import { parseEvent } from '../src/protocol.ts'
import type { BoundTool } from '../src/lease.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const PYTHON = process.env['DSH_PY'] ?? 'python3'

const sessions: ReplSession[] = []
function newSession(extra: Partial<ConstructorParameters<typeof ReplSession>[0]> = {}): ReplSession {
  const session = new ReplSession({
    python: PYTHON,
    vendorRoot: join(root, 'vendor', 'prime'),
    pythonRoot: join(root, 'python'),
    ...extra,
  })
  sessions.push(session)
  return session
}

after(async () => {
  await Promise.all(sessions.map((s) => s.dispose()))
})

describe('the plugin module must be loadable the way cordis loads it', () => {
  it('has no default export, so `apply` is not shadowed', async () => {
    // cordis-plugin-loader unwraps with `exports.default ?? exports`. A
    // default export wins, the loader gets the class, news it, and apply()
    // never runs — silently. The runtime still registers, so cells work and
    // nothing looks broken, while the prompt rewrite, the Python version
    // assertion and Config resolution all quietly do not happen.
    const mod = (await import('../src/index.ts')) as Record<string, unknown>
    assert.equal(
      mod['default'],
      undefined,
      'a default export would make the cordis loader skip apply() with no error',
    )
  })

  it('exports what the loader actually needs', async () => {
    const mod = (await import('../src/index.ts')) as Record<string, unknown>
    assert.equal(typeof mod['apply'], 'function', 'the loader calls apply()')
    assert.ok(mod['Config'], 'cordis reads Config off the plugin callback for schema defaults')
    assert.equal(typeof mod['name'], 'string')
  })

  it('what the loader resolves is the apply function, not a class', async () => {
    // Reproduce the loader's own unwrap step.
    const mod = (await import('../src/index.ts')) as Record<string, unknown>
    const unwrapped = (mod['default'] ?? mod) as Record<string, unknown>
    assert.equal(
      typeof unwrapped['apply'],
      'function',
      'cordis resolves a plugin object via its `apply` member',
    )
    assert.ok(unwrapped['Config'], 'Config must survive the unwrap, or defaults are skipped')
  })

  it('preserves this module plugin shape in the built bundle', async () => {
    // Class/default plugins elsewhere are valid; this module needs apply + Config.
    const ours = await readFile(join(root, 'lib', 'index.js'), 'utf8').catch(() => '')
    if (ours === '') return // not built; the source-level assertions above still hold
    const exportLine = ours.split('\n').filter((l) => l.startsWith('export {')).pop() ?? ''
    assert.ok(!/as default/.test(exportLine), `built bundle must not export a default: ${exportLine}`)
  })
})

describe('a value that cannot be JSON-encoded must fail, never hang', () => {
  it('rejects NaN with a clear tool error instead of writing invalid JSON', async () => {
    // json.dumps defaults to allow_nan=True and writes bare `NaN`, which is
    // not valid JSON. The host then drops the frame and the cell waits
    // forever. This cost a real session ~8 minutes.
    const session = newSession()
    const tools = new Map<string, BoundTool>([['probe', async () => ({ ok: true })]])
    const result = await session.runCell(
      'try:\n'
      + '    await tools.probe({"n": float("nan")})\n'
      + '    print("SENT")\n'
      + 'except ToolCallError as e:\n'
      + '    print(f"REFUSED: {e}")\n',
      tools,
    )
    const text = result.logs.join('')
    assert.match(text, /REFUSED/, 'NaN must be refused before it reaches the wire')
    assert.match(text, /NaN and Infinity/, 'and the message must say how to fix it')
  })

  it('rejects Infinity the same way', async () => {
    const session = newSession()
    const tools = new Map<string, BoundTool>([['probe', async () => ({ ok: true })]])
    const result = await session.runCell(
      'try:\n'
      + '    await tools.probe({"v": float("inf")})\n'
      + 'except ToolCallError as e:\n'
      + '    print("REFUSED")\n',
      tools,
    )
    assert.match(result.logs.join(''), /REFUSED/)
  })

  it('still sends ordinary values, including legitimate floats', async () => {
    const session = newSession()
    const seen: unknown[] = []
    const tools = new Map<string, BoundTool>([
      ['probe', async (args) => { seen.push(args); return { ok: true } }],
    ])
    const result = await session.runCell('await tools.probe({"n": 1.5, "s": "x", "b": True})', tools)
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.deepEqual(seen, [{ n: 1.5, s: 'x', b: true }])
  })

  it('refuses arguments over the kernel frame cap as a tool error', async () => {
    const session = newSession()
    const tools = new Map<string, BoundTool>([['probe', async () => ({ ok: true })]])
    const result = await session.runCell(
      'try:\n'
      + '    await tools.probe({"s": "x" * (16 * 1024 * 1024 + 1)})\n'
      + '    print("SENT")\n'
      + 'except ToolCallError as e:\n'
      + '    print(f"REFUSED: {e}")\n',
      tools,
    )
    const text = result.logs.join('')
    assert.match(text, /REFUSED/, 'an oversized call must surface as ToolCallError, not a bare ValueError')
    assert.match(text, /pass its path/, 'and the message must say how to fix it')
  })

  it('reports an unserializable object without hanging either', async () => {
    const session = newSession()
    const tools = new Map<string, BoundTool>([['probe', async () => null]])
    const result = await session.runCell(
      'try:\n'
      + '    await tools.probe({"s": {1, 2}})\n'
      + 'except BaseException as e:\n'
      + '    print(f"REFUSED: {type(e).__name__}")\n',
      tools,
    )
    assert.match(result.logs.join(''), /REFUSED/)
  })
})

describe('a corrupt protocol frame must be visible', () => {
  it('rejects the exact shape NaN produces', () => {
    assert.equal(parseEvent('{"event":"host_request","id":"x","data":{"n":NaN}}'), undefined, 'it is not valid JSON')
  })

  it('rejects valid JSON that is not a protocol frame', () => {
    assert.equal(parseEvent('{"not":"an event"}'), undefined)
    assert.equal(parseEvent('[1,2,3]'), undefined)
  })
})

describe('each namespace answers for its own members', () => {
  it('skills.list does not return the DSH tool catalog', async () => {
    const session = newSession()
    const tools = new Map<string, BoundTool>([['bash', async () => null]])
    const schemas = [{ name: 'bash', description: 'Run a command.' }]
    const result = await session.runCell(
      '[i["name"] for i in (await skills.list())["items"]]',
      tools,
      undefined,
      schemas,
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.ok(
      !result.logs.join('').includes('bash'),
      'a DSH tool must not appear in the Python skills namespace',
    )
  })

  it('skills.describe does not answer with a tool-catalog miss', async () => {
    // It used to say "no tool named ...", conflating session skills with
    // Python skills — a confusing answer to a reasonable question.
    const session = newSession()
    const tools = new Map<string, BoundTool>([['bash', async () => null]])
    const result = await session.runCell(
      '(await skills.describe("anything"))["items"][0]["reason"]',
      tools,
      undefined,
      [{ name: 'bash', description: 'Run a command.' }],
    )
    assert.ok(!/no tool named/.test(result.logs.join('')), 'skills must not talk about tools')
  })
})

describe('meta queries accept the shape models actually reach for', () => {
  it('accepts tools.list({"cursor": ...}) like every other DSH tool', async () => {
    // Every other tool takes a single dict, so this is the first thing tried.
    // It used to surface a raw JS error: "options.query?.toLowerCase is not a
    // function" — an internal failure where a usage hint belongs.
    const session = newSession()
    const tools = new Map<string, BoundTool>(
      Array.from({ length: 25 }, (_, i) => [`tool_${String(i).padStart(2, '0')}`, async () => null]),
    )
    const result = await session.runCell(
      'page = await tools.list({"limit": 5})\n(len(page["items"]), page["next_cursor"] is not None)',
      tools,
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.match(result.logs.join(''), /\(5, True\)/)
  })

  it('pages correctly through the dict form', async () => {
    const session = newSession()
    const tools = new Map<string, BoundTool>(
      Array.from({ length: 25 }, (_, i) => [`t${String(i).padStart(2, '0')}`, async () => null]),
    )
    const result = await session.runCell(
      'first = await tools.list({"limit": 10})\n'
      + 'second = await tools.list({"limit": 10, "cursor": first["next_cursor"]})\n'
      + '[i["name"] for i in first["items"]][:1] + [i["name"] for i in second["items"]][:1]',
      tools,
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.ok(!/toLowerCase/.test(result.logs.join('')), 'no raw JS error may leak')
  })

  it('rejects an unknown option in words, not with an internal error', async () => {
    const session = newSession()
    const result = await session.runCell(
      'try:\n'
      + '    await tools.list({"limitt": 5})\n'
      + 'except TypeError as e:\n'
      + '    print(f"REFUSED: {e}")\n',
      new Map<string, BoundTool>([['x', async () => null]]),
    )
    const text = result.logs.join('')
    assert.match(text, /REFUSED/)
    assert.match(text, /limitt/, 'name the offending key')
    assert.match(text, /query, limit, cursor/, 'and say what IS accepted')
  })

  it('still supports the keyword form', async () => {
    const session = newSession()
    const tools = new Map<string, BoundTool>(
      Array.from({ length: 25 }, (_, i) => [`k${i}`, async () => null]),
    )
    const result = await session.runCell('len((await tools.list(limit=7))["items"])', tools)
    assert.match(result.logs.join(''), /7/)
  })
})

describe('a cell can reject incomplete bash output without replaying the command', () => {
  it('accepts a complete result and refuses truncated or stopped output', async () => {
    const session = newSession()
    let calls = 0
    const tools = new Map<string, BoundTool>([['bash', async () => {
      calls++
      return {
        kind: 'foreground', exitCode: 0, signal: null, timedOut: false, aborted: false,
        timeoutMs: 1000, stdout: { text: calls === 1 ? '{"ok":true}' : 'tail', truncated: calls === 2 },
        stderr: { text: '', truncated: false },
        ...(calls === 3 ? { stopped: 'executor interrupted' } : {}),
      }
    }]])
    const result = await session.runCell(
      'good = await bash({"command": "echo ok"})\n'
      + 'parsed = __import__("json").loads(await repl.require_complete(good))\n'
      + 'errors = []\n'
      + 'for _ in range(2):\n'
      + '    r = await bash({"command": "echo tail"})\n'
      + '    try:\n        await repl.require_complete(r, check_exit=False)\n'
      + '    except ValueError as exc:\n        errors.append(str(exc))\n'
      + '(parsed["ok"], "truncated" in errors[0], "did not finish normally" in errors[1])',
      tools,
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.match(result.logs.join(''), /\(True, True, True\)/)
    assert.equal(calls, 3, 'the check must never replay an executed command')
  })
})

