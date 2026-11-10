/**
 * Integration tests against a REAL Python kernel process.
 *
 * No stubs: these spawn the vendored kernel, run cells, call tools back
 * through the bridge, and assert the authority and lifecycle contracts.
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { ReplSession } from '../src/session.ts'
import { discoverSkills } from '../src/skill-discovery.ts'
import type { BoundTool } from '../src/lease.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const PYTHON = process.env['DSH_PY'] ?? 'python3'

function newSession(): ReplSession {
  return new ReplSession({
    python: PYTHON,
    vendorRoot: join(root, 'vendor', 'prime'),
    pythonRoot: join(root, 'python'),
  })
}

const sessions: ReplSession[] = []
const tempRoots: string[] = []
function track(session: ReplSession): ReplSession {
  sessions.push(session)
  return session
}

after(async () => {
  await Promise.all(sessions.map((s) => s.dispose()))
  await Promise.all(tempRoots.map((d) => rm(d, { recursive: true, force: true })))
})

/** A tool map whose `echo` records every call it receives. */
function recordingTools(calls: unknown[]): Map<string, BoundTool> {
  return new Map<string, BoundTool>([
    ['echo', async (args) => { calls.push(args); return { echoed: args } }],
    ['bash', async () => ({ stdout: 'fake', exitCode: 0 })],
  ])
}

describe('ReplSession: persistent cells', () => {
  it('keeps variables across cells', async () => {
    const session = track(newSession())
    const first = await session.runCell('rows = [1, 2, 3]\nlen(rows)', recordingTools([]))
    assert.equal(first.error, undefined, JSON.stringify(first))
    assert.ok(first.logs.join('').includes('3'), JSON.stringify(first.logs))

    const second = await session.runCell('sum(rows)', recordingTools([]))
    assert.equal(second.error, undefined)
    assert.ok(second.logs.join('').includes('6'), JSON.stringify(second.logs))
  })

  it('keeps functions and closures across cells', async () => {
    const session = track(newSession())
    await session.runCell(
      'base = 10\ndef bump(n):\n    return n + base\n',
      recordingTools([]),
    )
    const result = await session.runCell('bump(5)', recordingTools([]))
    assert.equal(result.error, undefined)
    assert.ok(result.logs.join('').includes('15'))
  })

  it('shows a non-None trailing expression but not an assignment', async () => {
    const session = track(newSession())
    const assigned = await session.runCell('x = 41', recordingTools([]))
    assert.equal(assigned.logs.join('').trim(), '')

    const expression = await session.runCell('x + 1', recordingTools([]))
    assert.ok(expression.logs.join('').includes('42'))
  })

  it('does not display a None trailing expression', async () => {
    const session = track(newSession())
    const result = await session.runCell('def nothing():\n    return None\nnothing()', recordingTools([]))
    assert.equal(result.error, undefined)
    assert.equal(result.logs.join('').trim(), '')
  })

  it('captures print output', async () => {
    const session = track(newSession())
    const result = await session.runCell('print("hello from python")', recordingTools([]))
    assert.ok(result.logs.join('').includes('hello from python'))
  })

  it('reports a top-level return as a Python syntax error (no AST emulation)', async () => {
    const session = track(newSession())
    const result = await session.runCell('return 5', recordingTools([]))
    assert.ok(result.error, 'top-level return must fail')
    assert.match(result.error?.message ?? '', /SyntaxError/)
  })

  it('reports an exception with its real type', async () => {
    const session = track(newSession())
    const result = await session.runCell('1 / 0', recordingTools([]))
    assert.equal(result.error?.kind, 'exception')
    assert.match(result.error?.message ?? '', /ZeroDivisionError/)
  })

  it('keeps state written before an error in the same cell', async () => {
    const session = track(newSession())
    await session.runCell('survivor = "kept"\nraise ValueError("boom")', recordingTools([]))
    const result = await session.runCell('survivor', recordingTools([]))
    assert.ok(result.logs.join('').includes('kept'), 'a failed cell does not roll back')
  })
})

describe('ReplSession: tool sync', () => {
  it('a sync that failed in the kernel is retried by the next cell with the same grant', { timeout: 120_000 }, async () => {
    const session = track(newSession())
    const echo: BoundTool = async () => 'echo'
    const other: BoundTool = async () => 'other'
    assert.equal((await session.runCell('import bootstrap\n_real = bootstrap._sync_tools\ndef _fail_once(*a):\n    bootstrap._sync_tools = _real\n    raise RuntimeError("sync broke")\nbootstrap._sync_tools = _fail_once', new Map([['echo', echo]]))).error, undefined)
    const wider = () => new Map([['echo', echo], ['other', other]])
    await session.runCell('pass', wider())
    const result = await session.runCell('await tools.other({})', wider())
    assert.equal(result.error, undefined, result.error?.message)
    assert.match(result.logs.join('\n'), /other/)
  })
})

describe('ReplSession: tool bridge', () => {
  it('calls a DSH tool from Python and returns its canonical value', async () => {
    const session = track(newSession())
    const calls: unknown[] = []
    const result = await session.runCell(
      'r = await tools.echo({"text": "hi"})\nr["echoed"]["text"]',
      recordingTools(calls),
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.deepEqual(calls, [{ text: 'hi' }])
    assert.ok(result.logs.join('').includes('hi'))
  })

  it('exposes the six fixed tools at top level when granted', async () => {
    const session = track(newSession())
    const tools = new Map<string, BoundTool>([
      ['bash', async () => ({ stdout: 'ran', exitCode: 0 })],
      ['echo', async (a) => a],
    ])
    const result = await session.runCell('out = await bash({"command": "true"})\nout["stdout"]', tools)
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.ok(result.logs.join('').includes('ran'))
  })

  it('a persistent function calls tools using the CURRENT cell’s authority', async () => {
    const session = track(newSession())
    await session.runCell(
      'async def check():\n    return await tools.echo({"n": 1})\n',
      recordingTools([]),
    )
    const second: unknown[] = []
    const result = await session.runCell('(await check())["echoed"]["n"]', recordingTools(second))
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.deepEqual(second, [{ n: 1 }], 'the second cell’s bindings served the call')
  })

  it('surfaces a tool failure as ToolCallError with the tool name', async () => {
    const session = track(newSession())
    const tools = new Map<string, BoundTool>([
      ['boom', async () => { throw new Error('tool exploded') }],
    ])
    const result = await session.runCell(
      'try:\n'
      + '    await tools.boom({})\n'
      + 'except ToolCallError as e:\n'
      + '    print(f"caught {e.toolName}: {e}")\n',
      tools,
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.match(result.logs.join(''), /caught boom: tool exploded/)
  })

  it('refuses a tool the cell was not granted', async () => {
    const session = track(newSession())
    const result = await session.runCell(
      'try:\n'
      + '    await tools.echo({})\n'
      + 'except AttributeError as e:\n'
      + '    print("no such tool")\n',
      new Map<string, BoundTool>([['bash', async () => null]]),
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.match(result.logs.join(''), /no such tool/)
  })

  it('supports partial failure across independent items', async () => {
    const session = track(newSession())
    let n = 0
    const tools = new Map<string, BoundTool>([
      ['flaky', async () => {
        n += 1
        if (n === 3) throw new Error('item 3 failed')
        return { n }
      }],
    ])
    const result = await session.runCell(
      'ok, failed = [], []\n'
      + 'for i in range(5):\n'
      + '    try:\n'
      + '        ok.append(await tools.flaky({"i": i}))\n'
      + '    except ToolCallError as exc:\n'
      + '        failed.append({"i": i, "tool": exc.toolName})\n'
      + 'print(f"ok={len(ok)} failed={len(failed)}")\n',
      tools,
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.match(result.logs.join(''), /ok=4 failed=1/, 'completed work survives one failure')
  })
})

describe('ReplSession: lifecycle', () => {
  it('two sessions have independent namespaces', async () => {
    const a = track(newSession())
    const b = track(newSession())
    await a.runCell('secret = "a-only"', recordingTools([]))
    const result = await b.runCell(
      'try:\n    secret\nexcept NameError:\n    print("isolated")\n',
      recordingTools([]),
    )
    assert.match(result.logs.join(''), /isolated/)
  })

  it('serializes overlapping cells instead of interleaving them', async () => {
    const session = track(newSession())
    await session.runCell('order = []', recordingTools([]))
    const first = session.runCell('import asyncio\nawait asyncio.sleep(0.2)\norder.append("first")', recordingTools([]))
    const second = session.runCell('order.append("second")', recordingTools([]))
    await Promise.all([first, second])
    const result = await session.runCell('order', recordingTools([]))
    assert.match(result.logs.join(''), /\['first', 'second'\]/)
  })

  it('reports the kernel python version once started', async () => {
    const session = track(newSession())
    await session.runCell('1', recordingTools([]))
    assert.match(session.pythonVersion ?? '', /^3\.\d+\.\d+$/)
  })

  it('refuses to run after disposal instead of silently restarting', async () => {
    const session = newSession()
    await session.runCell('1', recordingTools([]))
    await session.dispose()
    const result = await session.runCell('1', recordingTools([]))
    assert.equal(result.error?.kind, 'worker-exit')
  })

  it('dispose is idempotent', async () => {
    const session = newSession()
    await session.runCell('1', recordingTools([]))
    await session.dispose()
    await session.dispose()
  })
})

describe('ReplSession: Python skills', () => {
  it('pre-imports a trusted skill and reports it, with no load step for the model', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-repl-skills-'))
    tempRoots.push(dir)
    const skill = join(dir, 'doubler')
    await mkdir(join(skill, 'src', 'doubler_skill'), { recursive: true })
    await writeFile(join(skill, 'SKILL.md'), '---\nname: doubler\ndescription: Doubles things.\n---\n')
    await writeFile(join(skill, 'src', 'doubler_skill', '__init__.py'), 'def run(n):\n    return n * 2\n')

    const session = track(
      new ReplSession({
        python: PYTHON,
        vendorRoot: join(root, 'vendor', 'prime'),
        pythonRoot: join(root, 'python'),
        skills: discoverSkills([dir]).skills,
      }),
    )

    // The very first user cell already sees it — no skills.load() anywhere.
    const result = await session.runCell('skills.doubler_skill.run(21)', recordingTools([]))
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.match(result.logs.join(''), /42/)

    assert.deepEqual(session.skillReport?.loaded, ['doubler_skill'])
  })

  it('reports a failing skill without blocking the working ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-repl-skills-'))
    tempRoots.push(dir)
    for (const [name, pkg, body] of [
      ['aaa-bad', 'bad_skill', "raise RuntimeError('nope')\n"],
      ['zzz-good', 'fine_skill', 'value = 7\n'],
    ] as const) {
      await mkdir(join(dir, name, 'src', pkg), { recursive: true })
      await writeFile(join(dir, name, 'SKILL.md'), `---\nname: ${name}\ndescription: x\n---\n`)
      await writeFile(join(dir, name, 'src', pkg, '__init__.py'), body)
    }

    const session = track(
      new ReplSession({
        python: PYTHON,
        vendorRoot: join(root, 'vendor', 'prime'),
        pythonRoot: join(root, 'python'),
        skills: discoverSkills([dir]).skills,
      }),
    )
    const result = await session.runCell('skills.fine_skill.value', recordingTools([]))
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.match(result.logs.join(''), /7/)
    assert.deepEqual(session.skillReport?.loaded, ['fine_skill'])
    assert.equal(session.skillReport?.failed.length, 1)
    assert.match(session.skillReport?.failed[0]?.reason ?? '', /RuntimeError/)
  })

  it('lets a skill reach DSH tools through the bridge module', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-repl-skills-'))
    tempRoots.push(dir)
    const pkg = join(dir, 'caller', 'src', 'caller_skill')
    await mkdir(pkg, { recursive: true })
    await writeFile(join(dir, 'caller', 'SKILL.md'), '---\nname: caller\ndescription: calls a tool\n---\n')
    await writeFile(
      join(pkg, '__init__.py'),
      'from dsh_kernel import call_tool\n\nasync def run(text):\n    return await call_tool("echo", {"text": text})\n',
    )

    const session = track(
      new ReplSession({
        python: PYTHON,
        vendorRoot: join(root, 'vendor', 'prime'),
        pythonRoot: join(root, 'python'),
        skills: discoverSkills([dir]).skills,
      }),
    )
    const calls: unknown[] = []
    const result = await session.runCell(
      '(await skills.caller_skill.run("via skill"))["echoed"]["text"]',
      recordingTools(calls),
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.deepEqual(calls, [{ text: 'via skill' }], 'the skill module reached the real tool')
  })
})

describe('ReplSession: capability catalog', () => {
  it('lists the tools this cell may actually call', async () => {
    const session = track(newSession())
    const result = await session.runCell(
      'r = await tools.list()\n[i["name"] for i in r["items"]]',
      recordingTools([]),
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    const text = result.logs.join('')
    assert.match(text, /echo/)
    assert.ok(!text.includes('__catalog_'), 'internal meta entry points must stay hidden')
  })

  it('describes a tool using the host schema', async () => {
    const session = track(newSession())
    const schemas = [
      { name: 'echo', description: 'Echo text back.', parameters: { type: 'object', properties: { text: { type: 'string' } } } },
    ]
    const result = await session.runCell(
      'd = await tools.describe("echo")\n(d["items"][0]["status"], d["items"][0]["description"])',
      recordingTools([]),
      undefined,
      schemas,
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.match(result.logs.join(''), /available/)
    assert.match(result.logs.join(''), /Echo text back\./)
  })
})

describe('ReplSession: tool results display as readable views', () => {
  const foreground = {
    kind: 'foreground', exitCode: 2, signal: null, timedOut: false, aborted: false, timeoutMs: 120000,
    stdout: { text: 'first\nsecond\n', truncated: true, spillPath: '/spill/out.txt' },
    stderr: { text: 'grep: nope\n', truncated: false },
  }
  const tools = () => new Map<string, BoundTool>([['bash', async () => structuredClone(foreground)]])

  it('a trailing bash result shows exit status, both streams and the spill path', async () => {
    const session = track(newSession())
    const result = await session.runCell('await bash({"command": "x", "description": "y"})', tools())
    assert.equal(result.error, undefined, JSON.stringify(result))
    const text = result.logs.join('')
    assert.match(text, /bash · exitCode=2 \(view of a dict\)/)
    assert.match(text, /first\nsecond/)
    assert.match(text, /\[stderr\]\ngrep: nope/)
    assert.match(text, /full output: \/spill\/out\.txt/)
  })

  it('the value is still the canonical JSON the host sent', async () => {
    const session = track(newSession())
    const result = await session.runCell(
      'import json\nr = await bash({"command": "x", "description": "y"})\njson.loads(json.dumps(r)) == r and isinstance(r, dict) and r["stdout"]["text"]',
      tools(),
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.match(result.logs.join(''), /'first\\nsecond\\n'/)
  })
})
