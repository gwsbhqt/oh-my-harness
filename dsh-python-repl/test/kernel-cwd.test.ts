/**
 * The kernel must not run inside `vendor/`.
 *
 * Found in a real session (2026-09-22): `os.getcwd()` reported
 * `.../dsh-python-repl/vendor/prime`, so any `open("out.csv", "w")` a cell
 * wrote landed in the one directory this project says must stay byte-for-byte
 * upstream. It was not hypothetical — `vendor/prime/rlm/__pycache__/` was
 * already there, created by the kernel importing its own vendored module.
 *
 * Two separate failures made that possible and both are covered here:
 *
 * 1. `kernel.ts` defaulted `cwd` to `pythonPath[0]`, which is the vendor root,
 *    and nothing upstream ever passed an explicit cwd.
 * 2. The vendor-purity test only looked at `is_file()`, so a DIRECTORY like
 *    `__pycache__` slipped through the check that exists to catch exactly this.
 *
 * Only `.gitignore` kept it out of git. That is luck, not a design.
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { mkdtemp, realpath, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { ReplSession } from '../src/session.ts'
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

describe('the kernel never runs inside vendor/', () => {
  it('reports a cwd outside the vendored tree', async () => {
    const session = newSession()
    const result = await session.runCell('import os\nos.getcwd()', noTools())
    assert.equal(result.error, undefined, JSON.stringify(result))
    const cwd = result.logs.join('').replace(/['"\n]/g, '')
    assert.ok(
      !cwd.includes('/vendor/'),
      `the kernel must not sit in the vendored tree, got ${cwd}`,
    )
  })

  it('a relative write lands outside vendor', async () => {
    const session = newSession()
    const result = await session.runCell(
      'import os\nos.path.abspath("probe-relative-write.txt")',
      noTools(),
    )
    const target = result.logs.join('').replace(/['"\n]/g, '')
    assert.ok(
      !target.includes('/vendor/'),
      `a cell writing a relative path would corrupt vendor: ${target}`,
    )
  })

  it('honours an explicit cwd when one is given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-repl-cwd-'))
    temps.push(dir)
    const session = newSession({ cwd: dir })
    const result = await session.runCell('import os\nos.getcwd()', noTools())
    const cwd = result.logs.join('').replace(/['"\n]/g, '')
    // macOS reports /private/var for /var, so compare resolved real paths.
    assert.ok(
      cwd.endsWith(resolve(dir).split('/').pop() ?? ''),
      `expected the configured cwd, got ${cwd}`,
    )
  })

  it('leaves no __pycache__ inside the vendored package', async () => {
    // The kernel imports its own vendored module, so CPython wants to write
    // bytecode next to it. That is the exact mechanism that polluted vendor.
    const session = newSession()
    await session.runCell('1', noTools())
    await session.dispose()

    const entries = await readdir(join(root, 'vendor', 'prime', 'rlm'))
    assert.ok(
      !entries.includes('__pycache__'),
      'running a cell must not drop bytecode into the upstream tree',
    )
  })
})

describe('output that belongs to no cell must not vanish silently', () => {
  it('surfaces raw fd1 writes instead of discarding them', async () => {
    // `print()` goes through the kernel's stream wrapper and carries a cell id.
    // A raw `os.write(1, ...)` — and anything a subprocess inherits — does not,
    // so the frame arrives with `id: null`. The host used to drop those without
    // a word: the model saw a command produce nothing and concluded it had no
    // output (found 2026-09-22).
    const session = newSession()
    const result = await session.runCell(
      'import os, time\nos.write(1, b"RAW-FD1-OUTPUT\\n")\ntime.sleep(0.3)\n"done"',
      noTools(),
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    const text = result.logs.join('')
    assert.ok(
      /RAW-FD1-OUTPUT/.test(text) || /unattributed|discarded|直接写/i.test(text),
      `raw fd output must be delivered or explicitly reported, got: ${text}`,
    )
  })

  it('surfaces subprocess output that was never captured', async () => {
    const session = newSession()
    const result = await session.runCell(
      'import subprocess, time\n'
      + 'subprocess.run(["sh", "-c", "echo SUBPROC-SPEAKS"])\n'
      + 'time.sleep(0.3)\n"done"',
      noTools(),
    )
    const text = result.logs.join('')
    assert.ok(
      /SUBPROC-SPEAKS/.test(text) || /unattributed|discarded/i.test(text),
      `a subprocess writing to the inherited stdout must not be silently lost: ${text}`,
    )
  })

  it('shows an earlier cell thread output under the background heading, never as the next cell own output', async () => {
    const session = newSession()
    const first = await session.runCell(
      'import os, threading\n'
      + 'gate = threading.Event()\n'
      + 'def late_writer():\n'
      + '    gate.wait()\n'
      + '    os.write(1, b"OLD-CELL-RAW-OUTPUT\\n")\n'
      + 'worker = threading.Thread(target=late_writer, daemon=True)\n'
      + 'worker.start()',
      noTools(),
    )
    assert.equal(first.error, undefined, JSON.stringify(first))
    const next = await session.runCell('gate.set()\nworker.join()\n"new cell"', noTools())
    assert.equal(next.error, undefined, JSON.stringify(next))
    const background = next.logs.find((entry) => entry.startsWith('[background output (unattributed)]')) ?? ''
    assert.match(background, /OLD-CELL-RAW-OUTPUT/, 'shown, as Prime does, under its own heading')
    assert.ok(next.logs.some((entry) => /new cell/.test(entry) && !/OLD-CELL/.test(entry)), 'not mixed into the cell output')
    const clean = await session.runCell('"clean cell"', noTools())
    assert.doesNotMatch(clean.logs.join(''), /unattributed/i, 'not repeated without new output')
  })

  it('preserves explicitly captured subprocess output', async () => {
    const session = newSession()
    const result = await session.runCell(
      'import subprocess\n'
      + 'r = subprocess.run(["sh", "-c", "echo CAPTURED-OUTPUT"], capture_output=True, text=True)\n'
      + 'print(r.stdout)',
      noTools(),
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.match(result.logs.join(''), /CAPTURED-OUTPUT/)
    assert.doesNotMatch(result.logs.join(''), /unattributed/i)
  })

  it('still routes ordinary print output to its own cell', async () => {
    const session = newSession()
    const a = await session.runCell('print("cell A")\n"a"', noTools())
    const b = await session.runCell('print("cell B")\n"b"', noTools())
    assert.match(a.logs.join(''), /cell A/)
    assert.ok(!a.logs.join('').includes('cell B'), 'cells must not absorb each other output')
    assert.match(b.logs.join(''), /cell B/)
  })
})

describe('recovery advice must be a recipe that actually works', () => {
  it('does not tell you to use `repl` when `repl` is what you broke', async () => {
    const session = newSession()
    const result = await session.runCell('repl = "clobbered"', noTools())
    const text = result.logs.join('')
    assert.match(text, /system binding/, 'the shadowing must still be reported')
    assert.ok(
      !/await repl\.restore_binding\("repl"\)/.test(text),
      'that call cannot work: `repl` is a string now',
    )
    assert.match(text, /__import__\("bootstrap"\)/, 'offer a path that survives the clobbering')
  })

  it('the advised recipe really restores repl', async () => {
    const session = newSession()
    await session.runCell('repl = "clobbered"', noTools())
    const fixed = await session.runCell(
      'import bootstrap as _b\n'
      + 'repl = _b._ORIGINAL_BINDINGS["repl"]\n'
      + 'callable(getattr(repl, "restore_binding", None))',
      noTools(),
    )
    assert.equal(fixed.error, undefined, JSON.stringify(fixed))
    assert.match(fixed.logs.join(''), /True/, 'repl must be usable again after the documented fix')
  })

  it('keeps the normal advice for an ordinary tool name', async () => {
    const session = newSession()
    const tools = new Map<string, BoundTool>([['bash', async () => null]])
    await session.runCell('1', tools)
    const result = await session.runCell('bash = "not a tool"', tools)
    const text = result.logs.join('')
    assert.match(text, /restore_binding\("bash"\)/, 'the simple path still applies here')
  })
})

describe('the kernel shares the session workspace with bash', () => {
  it('uses the agent session cwd, not the host process directory', async () => {
    // Under the GUI, `process.cwd()` is the Electron host's directory ($HOME
    // in practice) — neither the workspace nor anywhere a cell should write.
    // A cell's `open("out.csv")` and a shell's `> out.csv` must agree.
    const { Context } = await import('@deepseek-ai/cordis')
    const { mountAgents } = await import('./fixtures/agents.ts')
    const { Config, PythonReplRuntime } = await import('../src/index.ts')
    const workspace = await mkdtemp(join(tmpdir(), 'dsh-repl-workspace-'))
    temps.push(workspace)

    const ctx = new Context()
    await mountAgents(ctx)
    await new Promise((r) => setTimeout(r, 0))
    await ctx.plugin(PythonReplRuntime, Config({
      python: PYTHON,
      startupTimeoutMs: 30_000,
      teardownGraceMs: 5_000,
      interruptGraceMs: 5_000,
      toolCallTimeoutMs: 0,
      residentTools: [],
      skillRoots: [],
    }))
    await new Promise((r) => setTimeout(r, 0))

    const runtime = ctx.get('ptcRuntime') as unknown as {
      run: (r: unknown) => Promise<{ logs: string[]; error?: unknown }>
      workspaceCwd: () => string
      disposeAll: () => Promise<void>
    }
    const agents = ctx.get('agents') as unknown as {
      withInitiator: <T>(a: unknown, op: () => T) => T
    }
    // Shaped like a real agent: session metadata carries the validated cwd.
    const agent = { id: 'a-cwd', sessionId: 's-cwd', meta: { cwd: workspace } }
    try {
      assert.equal(
        agents.withInitiator(agent, () => runtime.workspaceCwd()),
        workspace,
        'the workspace must come from the session, not the host process',
      )
      const result = await agents.withInitiator(agent, () =>
        runtime.run({ program: 'import os\nos.getcwd()', bindings: [], signal: new AbortController().signal }),
      )
      assert.equal(result.error, undefined, JSON.stringify(result))
      const reported = result.logs.join('').replace(/['"\n]/g, '')
      // macOS maps /var to /private/var, so compare the trailing segment.
      assert.ok(
        reported.endsWith(workspace.split('/').pop() ?? ''),
        `the kernel must run in the session workspace, got ${reported}`,
      )
    } finally {
      await runtime.disposeAll()
    }
  })

  it('falls back to the process cwd when no agent is in scope', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { mountAgents } = await import('./fixtures/agents.ts')
    const { Config, PythonReplRuntime } = await import('../src/index.ts')
    const ctx = new Context()
    await mountAgents(ctx)
    await new Promise((r) => setTimeout(r, 0))
    await ctx.plugin(PythonReplRuntime, Config({
      python: PYTHON,
      startupTimeoutMs: 30_000,
      teardownGraceMs: 5_000,
      interruptGraceMs: 5_000,
      toolCallTimeoutMs: 0,
      residentTools: [],
      skillRoots: [],
    }))
    await new Promise((r) => setTimeout(r, 0))
    const runtime = ctx.get('ptcRuntime') as unknown as {
      workspaceCwd: () => string
      disposeAll: () => Promise<void>
    }
    try {
      const fallback = runtime.workspaceCwd()
      assert.equal(fallback, process.cwd())
      assert.ok(!fallback.includes('/vendor/'), 'the fallback must never be the vendored tree')
    } finally {
      await runtime.disposeAll()
    }
  })
})

describe('repl.info states whether the cwd is the workspace', () => {
  it('reports agreement when they match', async () => {
    const session = newSession({ cwd: process.cwd() })
    const result = await session.runCell(
      '(await repl.info())["cwd_matches_workspace"]',
      noTools(),
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.match(result.logs.join(''), /True/)
  })

  it('reports disagreement instead of letting a cell guess', async () => {
    // A cell writing `open("out.csv")` must be able to find out that its
    // relative paths do NOT land where bash puts them.
    const dir = await mkdtemp(join(tmpdir(), 'dsh-repl-elsewhere-'))
    temps.push(dir)
    const session = newSession({ cwd: dir })
    const result = await session.runCell(
      'import os\n'
      + 'os.environ["DSH_PYTHON_REPL_WORKSPACE"] = "/definitely/not/here"\n'
      + '(await repl.info())["cwd_matches_workspace"]',
      noTools(),
    )
    assert.match(result.logs.join(''), /False/)
  })

  it('says None rather than guessing when the host did not declare one', async () => {
    const session = newSession()
    const result = await session.runCell(
      'import os\n'
      + 'os.environ.pop("DSH_PYTHON_REPL_WORKSPACE", None)\n'
      + '(await repl.info())["cwd_matches_workspace"] is None',
      noTools(),
    )
    assert.match(result.logs.join(''), /True/)
  })
})

describe('the kernel follows the session when it changes directory', () => {
  const where = async (session: ReplSession, cwd?: string): Promise<{ cwd: string; env: string }> => {
    const result = await session.runCell('import os, json\nprint(json.dumps([os.getcwd(), os.environ.get("DSH_PYTHON_REPL_WORKSPACE")]))', noTools(), undefined, [], cwd)
    assert.equal(result.error, undefined, JSON.stringify(result))
    const [got, env] = JSON.parse(result.logs.join('').trim()) as [string, string]
    return { cwd: got, env }
  }

  it('moves only when DSH reports a new directory, and a cell\'s own chdir survives until then', async () => {
    // Found 2026-10-17: after the session cd'd into a subdirectory, read() used the new
    // directory while Python stayed in the old one, so relative paths split between them.
    const first = await realpath(await mkdtemp(join(tmpdir(), 'dsh-repl-first-')))
    const second = await realpath(await mkdtemp(join(tmpdir(), 'dsh-repl-second-')))
    const own = await realpath(await mkdtemp(join(tmpdir(), 'dsh-repl-own-')))
    temps.push(first, second, own)
    const session = newSession({ cwd: first })
    assert.deepEqual(await where(session, first), { cwd: first, env: first })
    assert.deepEqual(await where(session, second), { cwd: second, env: second })
    const moved = await session.runCell(`import os\nos.chdir(${JSON.stringify(own)})`, noTools(), undefined, [], second)
    assert.equal(moved.error, undefined, JSON.stringify(moved))
    assert.equal((await where(session, second)).cwd, own)
    assert.equal((await where(session)).cwd, own)
    assert.deepEqual(await where(session, first), { cwd: first, env: first })
  })

  it('fails the cell instead of running it in the wrong place when the directory is gone', async () => {
    const first = await realpath(await mkdtemp(join(tmpdir(), 'dsh-repl-kept-')))
    temps.push(first)
    const session = newSession({ cwd: first })
    assert.equal((await where(session, first)).cwd, first)
    const gone = join(first, 'missing')
    const result = await session.runCell('print("ran")', noTools(), undefined, [], gone)
    assert.match(result.error?.message ?? '', /could not change into it/)
    assert.doesNotMatch(result.logs.join(''), /ran/)
    assert.equal((await where(session, first)).cwd, first)
  })

  it('reads the directory from DSH\'s working-directory service on every call', async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { mountAgents } = await import('./fixtures/agents.ts')
    const { Config, PythonReplRuntime } = await import('../src/index.ts')
    const start = await realpath(await mkdtemp(join(tmpdir(), 'dsh-repl-start-')))
    const later = await realpath(await mkdtemp(join(tmpdir(), 'dsh-repl-later-')))
    temps.push(start, later)
    const ctx = new Context()
    await mountAgents(ctx)
    let current = start
    const session = { header: { cwd: start } }
    ctx.provide('workingDirectory')
    ctx.set('workingDirectory', { get: (s: unknown) => { assert.equal(s, session); return current } })
    await new Promise((r) => setTimeout(r, 0))
    await ctx.plugin(PythonReplRuntime, Config({
      python: PYTHON, startupTimeoutMs: 30_000, teardownGraceMs: 5_000, interruptGraceMs: 5_000, toolCallTimeoutMs: 0, residentTools: [], skillRoots: [],
    }))
    await new Promise((r) => setTimeout(r, 0))
    const runtime = ctx.get('ptcRuntime') as unknown as { run: (r: unknown) => Promise<{ logs: string[]; error?: unknown }>; disposeAll: () => Promise<void> }
    const agents = ctx.get('agents') as unknown as { withInitiator: <T>(a: unknown, op: () => T) => T }
    const agent = { id: 'a-follow', sessionId: 's-follow', session, meta: { cwd: start } }
    const ask = async (): Promise<string> => {
      const result = await agents.withInitiator(agent, () => runtime.run({ program: 'import os\nprint(os.getcwd())', bindings: [], cwd: start, signal: new AbortController().signal }))
      assert.equal(result.error, undefined, JSON.stringify(result))
      return result.logs.join('').trim()
    }
    try {
      assert.equal(await ask(), start)
      current = later
      assert.equal(await ask(), later)
    } finally {
      await runtime.disposeAll()
    }
  })
})
