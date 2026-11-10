/**
 * Invariants that were once violated, each pinned by a test that reproduced
 * the defect before it was fixed.
 *
 * Every group below states the rule and why breaking it matters, so the file
 * stands on its own: these are not "regressions for a report", they are the
 * behaviours the runtime must keep.
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ReplSession } from '../src/session.ts'
import { discoverSkills } from '../src/skill-discovery.ts'
import type { BoundTool } from '../src/lease.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const PYTHON = process.env['DSH_PY'] ?? 'python3'

const sessions: ReplSession[] = []
const temps: string[] = []

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

const noTools = (): Map<string, BoundTool> => new Map()

after(async () => {
  await Promise.all(sessions.map((s) => s.dispose()))
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })))
})

describe('a cell cancelled BEFORE it runs must not run', () => {
  it('does not execute a cell whose signal is already aborted', async () => {
    const session = newSession()
    await session.runCell('1', noTools()) // warm the kernel
    const controller = new AbortController()
    controller.abort() // cancelled while queued / starting

    const result = await session.runCell('pre_cancel_marker = 42\npre_cancel_marker', noTools(), controller.signal)
    assert.ok(result.error, 'an already-cancelled cell must not report success')
    assert.equal(result.error?.kind, 'abort')

    // Check the actual namespace: newer Python versions may add builtin names.
    const probe = await session.runCell(
      'print("EXECUTED" if "pre_cancel_marker" in globals() else "not executed")',
      noTools(),
    )
    assert.match(probe.logs.join(''), /not executed/, 'the cancelled cell must leave no state')
  })

  it('does not execute a pre-cancelled cell even on a cold kernel', async () => {
    const session = newSession()
    const controller = new AbortController()
    controller.abort()
    const result = await session.runCell('cold = 1', noTools(), controller.signal)
    assert.equal(result.error?.kind, 'abort')
  })

  it('reports cancellation, not success, when abort races the result', async () => {
    const session = newSession()
    await session.runCell('1', noTools())
    const controller = new AbortController()
    const pending = session.runCell('import asyncio\nawait asyncio.sleep(0.4)\n"done"', noTools(), controller.signal)
    setTimeout(() => controller.abort(), 50)
    const result = await pending
    assert.equal(result.error?.kind, 'abort', JSON.stringify(result))
  })
})

describe('tasks outlive their cell, as in Prime', () => {
  it('keeps running, and what it prints arrives as background output in a later cell', async () => {
    const session = newSession()
    const first = await session.runCell(
      'import asyncio\n'
      + 'async def later():\n'
      + '    await asyncio.sleep(0.2)\n'
      + '    print("LATE-TASK-OUTPUT")\n'
      + 't = asyncio.create_task(later())\n'
      + '"started"',
      noTools(),
    )
    assert.equal(first.error, undefined, JSON.stringify(first))
    assert.doesNotMatch(first.logs.join('\n'), /cancelled/i)

    const next = await session.runCell('import asyncio\nawait asyncio.sleep(0.4)\nt.done()', noTools())
    assert.equal(next.error, undefined, JSON.stringify(next))
    const text = next.logs.join('\n')
    assert.match(text, /True/, 'the task ran to completion after its cell')
    assert.match(text, /\[background output \(unattributed\)\]\nLATE-TASK-OUTPUT/, 'its output is shown, labelled')
  })

  it('does not retire the kernel for a task left running', async () => {
    const session = newSession()
    await session.runCell(
      'import asyncio\n'
      + 'async def idle():\n'
      + '    await asyncio.sleep(3600)\n'
      + 't = asyncio.create_task(idle())\n',
      noTools(),
    )
    const next = await session.runCell('t.done()', noTools())
    assert.equal(next.error, undefined, JSON.stringify(next))
    assert.match(next.logs.join(''), /False/)
  })

  it('names a background task that failed while nobody awaited it, once', async () => {
    // Field 2026-09-28: the task ended with an error and the cell reported plain success.
    const session = newSession()
    const result = await session.runCell(
      'import asyncio\n'
      + 'async def write_report():\n'
      + '    raise OSError("disk full while writing report.csv")\n'
      + 'job = asyncio.create_task(write_report())\n'
      + 'await asyncio.sleep(0.05)\n'
      + '"cell done"',
      noTools(),
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    const text = result.logs.join('\n')
    assert.match(text, /1 asyncio task\(s\) failed and nobody awaited them/, text)
    assert.match(text, /write_report\): OSError: disk full while writing report\.csv/)
    assert.match(text, /\.exception\(\)/, 'say how to get the full error')

    const next = await session.runCell('repr(job.exception())', noTools())
    assert.match(next.logs.join(''), /disk full/, 'the error is still there to inspect')
    assert.doesNotMatch(next.logs.join('\n'), /nobody awaited/, 'reported once')
  })

  it('does not report failures the cell already collected', async () => {
    const session = newSession()
    const result = await session.runCell(
      'import asyncio\n'
      + 'async def fail(n):\n'
      + '    raise ValueError(n)\n'
      + 'got = await asyncio.gather(*(fail(i) for i in range(3)), return_exceptions=True)\n'
      + 'len(got)',
      noTools(),
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.doesNotMatch(result.logs.join('\n'), /nobody awaited/, result.logs.join('\n'))
  })

  it('keeps the notice short when many tasks fail', async () => {
    const session = newSession()
    const result = await session.runCell(
      'import asyncio\n'
      + 'async def fail(n):\n'
      + '    raise ValueError(n)\n'
      + 'left = [asyncio.create_task(fail(i)) for i in range(50)]\n'
      + 'await asyncio.sleep(0.05)\n',
      noTools(),
    )
    const notice = result.logs.find((line) => /nobody awaited/.test(line)) ?? ''
    assert.match(notice, /50 asyncio task\(s\) failed/, JSON.stringify(result.logs))
    assert.match(notice, /and 40 more/)
    assert.ok(notice.length < 1500, `notice is ${notice.length} chars`)
  })
})

describe('host cancellation must not arrive as ToolCallError', () => {
  it('surfaces an aborted tool call as CancelledError, not a catchable tool error', async () => {
    const session = newSession()
    const tools = new Map<string, BoundTool>([
      ['stop', async () => {
        const error = new Error('The operation was aborted')
        error.name = 'AbortError'
        throw error
      }],
    ])
    const result = await session.runCell(
      'swallowed = False\n'
      + 'try:\n'
      + '    await tools.stop({})\n'
      + 'except ToolCallError:\n'
      + '    swallowed = True\n'
      + 'except asyncio.CancelledError:\n'
      + '    raise\n'
      + 'print("SWALLOWED" if swallowed else "propagated")\n',
      tools,
    )
    assert.ok(
      !result.logs.join('').includes('SWALLOWED'),
      'cancellation must not be catchable as a per-item tool failure',
    )
  })
})

describe('the catalog must show only what THIS cell may call', () => {
  it('does not list a tool the cell was not granted', async () => {
    const session = newSession()
    const granted = new Map<string, BoundTool>([['allowed', async () => null]])
    const schemas = [
      { name: 'allowed', description: 'Granted to this cell.' },
      { name: 'hidden', description: 'NOT granted to this cell.' },
    ]
    const result = await session.runCell(
      '[i["name"] for i in (await tools.list())["items"]]',
      granted,
      undefined,
      schemas,
    )
    const text = result.logs.join('')
    assert.match(text, /allowed/)
    assert.ok(!text.includes('hidden'), `an ungranted tool must not appear in the catalog: ${text}`)
  })

  it('does not describe an ungranted tool as available', async () => {
    const session = newSession()
    const granted = new Map<string, BoundTool>([['allowed', async () => null]])
    const schemas = [
      { name: 'allowed', description: 'Granted.' },
      { name: 'hidden', description: 'Not granted.' },
    ]
    const result = await session.runCell(
      '(await tools.describe("hidden"))["items"][0]["status"]',
      granted,
      undefined,
      schemas,
    )
    assert.match(result.logs.join(''), /unknown/, 'describe must not expose ungranted capability')
  })
})

describe('tool proxies must track each cell’s bindings', () => {
  it('exposes a tool granted only from the second cell onwards', async () => {
    const session = newSession()
    await session.runCell('1', new Map<string, BoundTool>([['first', async () => null]]))
    const later = new Map<string, BoundTool>([
      ['first', async () => null],
      ['new_tool', async () => ({ ok: true })],
    ])
    const result = await session.runCell('(await tools.new_tool({}))["ok"]', later)
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.match(result.logs.join(''), /True/)
  })

  it('stops offering a tool that is no longer granted', async () => {
    const session = newSession()
    await session.runCell('1', new Map<string, BoundTool>([
      ['temporary', async () => null],
      ['stable', async () => null],
    ]))
    const result = await session.runCell(
      '[i["name"] for i in (await tools.list())["items"]]',
      new Map<string, BoundTool>([['stable', async () => null]]),
    )
    const text = result.logs.join('')
    assert.match(text, /stable/)
    assert.ok(!text.includes('temporary'), 'a revoked tool must disappear from the catalog')
  })
})

describe('read-only inspection must not run user code', () => {
  it('does not call __len__ on a list subclass while describing', async () => {
    const session = newSession()
    await session.runCell(
      'effects = []\n'
      + 'class Sneaky(list):\n'
      + '    def __len__(self):\n'
      + '        effects.append("len")\n'
      + '        return 0\n'
      + 'trap = Sneaky()\n',
      noTools(),
    )
    await session.runCell('await repl.describe("trap")', noTools())
    await session.runCell('await repl.list()', noTools())
    const probe = await session.runCell('effects', noTools())
    assert.match(probe.logs.join(''), /\[\]/, 'a builtin SUBCLASS may override __len__')
  })

  it('does not call __repr__ on an int subclass while describing', async () => {
    const session = newSession()
    await session.runCell(
      'rep = []\n'
      + 'class Loud(int):\n'
      + '    def __repr__(self):\n'
      + '        rep.append("repr")\n'
      + '        return "0"\n'
      + 'noisy = Loud(1)\n',
      noTools(),
    )
    await session.runCell('await repl.describe("noisy")', noTools())
    const probe = await session.runCell('rep', noTools())
    assert.match(probe.logs.join(''), /\[\]/)
  })

  it('does not call repr on a default argument when formatting a signature', async () => {
    const session = newSession()
    await session.runCell(
      'seen = []\n'
      + 'class Arg:\n'
      + '    def __repr__(self):\n'
      + '        seen.append("default repr")\n'
      + '        return "Arg()"\n'
      + 'def fn(a=Arg()):\n'
      + '    return a\n',
      noTools(),
    )
    await session.runCell('await repl.describe("fn")', noTools())
    const probe = await session.runCell('seen', noTools())
    assert.match(probe.logs.join(''), /\[\]/)
  })
})

describe('the binding guard must catch replacement and deletion', () => {
  it('flags a system name rebound to a class object', async () => {
    const session = newSession()
    const result = await session.runCell('tools = int', noTools())
    assert.match(
      result.logs.join(''),
      /system binding/,
      'rebinding `tools` to a class must be reported, not accepted as "still a class"',
    )
  })

  it('flags a deleted system name', async () => {
    const session = newSession()
    const result = await session.runCell('del tools', noTools())
    assert.match(result.logs.join(''), /system binding|deleted|missing/i)
  })
})

describe('skill import must not bind an unrelated cached module', () => {
  it('refuses a skill whose import name collides with an already-imported module', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-repl-'))
    temps.push(dir)
    const { mkdir, writeFile } = await import('node:fs/promises')
    // `json` is imported by the kernel bootstrap long before skills load.
    await mkdir(join(dir, 'jsonish', 'src', 'json'), { recursive: true })
    await writeFile(join(dir, 'jsonish', 'SKILL.md'), '---\nname: jsonish\ndescription: collides\n---\n')
    await writeFile(join(dir, 'jsonish', 'src', 'json', '__init__.py'), 'MARKER = "from the skill"\n')

    const session = newSession({ skills: discoverSkills([dir]).skills })
    await session.runCell('1', noTools())
    const report = session.skillReport
    assert.ok(report, 'a skill report must exist')
    assert.ok(
      !report.loaded.includes('json'),
      'binding the stdlib json module while claiming the skill loaded is a silent lie',
    )
  })
})

describe('the documented skill call form must work', () => {
  it('supports await skills.name(...) when the module declares run', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-repl-'))
    temps.push(dir)
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(dir, 'callable', 'src', 'callable_skill'), { recursive: true })
    await writeFile(join(dir, 'callable', 'SKILL.md'), '---\nname: callable\ndescription: callable module\n---\n')
    await writeFile(
      join(dir, 'callable', 'src', 'callable_skill', '__init__.py'),
      'async def run(value):\n    return value * 2\n',
    )

    const session = newSession({ skills: discoverSkills([dir]).skills })
    const result = await session.runCell('await skills.callable_skill(21)', noTools())
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.match(result.logs.join(''), /42/)
  })
})

for (const withPythonDocument of [true, false]) {
  it(`uses the same selected ${withPythonDocument ? 'Python' : 'standard'} document through the real kernel SDK and tool bridge`, async () => {
    const directoryRoot = await mkdtemp(join(tmpdir(), 'dsh-repl-documents-'))
    temps.push(directoryRoot)
    const directory = join(directoryRoot, 'document-skill')
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(directory, 'src', 'document_skill'), { recursive: true })
    const standard = '---\nname: document-skill\ndescription: CLI summary\n---\nCLI workflow\n'
    const preferred = '---\nname: document-skill\ndescription: Python summary\n---\nPython workflow\n'
    await writeFile(join(directory, 'SKILL.md'), standard)
    await writeFile(join(directory, 'src', 'document_skill', '__init__.py'), 'VALUE = 7\n')
    if (withPythonDocument) await writeFile(join(directory, 'PYSKILL.md'), preferred)
    const discovery = discoverSkills([directoryRoot])
    const session = newSession({ skills: discovery.skills })
    let originalCalls = 0
    const original: BoundTool = async (args) => {
      assert.deepEqual(args, { name: 'document-skill' })
      originalCalls += 1
      return { name: 'document-skill', provider: 'filesystem', resourceBase: { kind: 'directory', path: directory }, content: 'original standard-tool body' }
    }
    const selectedFile = withPythonDocument ? 'PYSKILL.md' : 'SKILL.md'
    const result = await session.runCell([
      'selected = (await skills.describe("document_skill"))["items"][0]',
      'loaded = await tools.skill({"name": "document-skill"})',
      'assert selected["instructions"] == loaded["content"]',
      `assert selected["instructions_file"] == ${JSON.stringify(selectedFile)}`,
      `assert selected["description"] == ${JSON.stringify(withPythonDocument ? 'Python summary' : 'CLI summary')}`,
      'assert skills.document_skill.VALUE == 7',
      'print("consistent document and module")',
    ].join('\n'), new Map([['skill', original]]))
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.match(result.logs.join(''), /consistent document and module/)
    assert.equal(originalCalls, 1, 'the original host permission check runs exactly once')
  })
}
