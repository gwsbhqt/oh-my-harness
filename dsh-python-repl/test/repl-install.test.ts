/**
 * `repl.install` / `repl.restart` through a real kernel.
 *
 * The defect this answers (2026-09-29): with no way to add a library to the
 * kernel, a session ran 29 cells as `fish -lc 'uv run --with pymupdf python -'`
 * — a fresh interpreter per cell, so nothing it built could stay in the
 * namespace the REPL exists to keep.
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { ReplSession } from '../src/session.ts'
import { kernelEnvironment, probeInterpreter } from '../src/index.ts'
import type { BoundTool } from '../src/lease.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const PYTHON = process.env['DSH_PY'] ?? 'python3'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-install-'))
/** The kernel venv, built by the plugin's own code with no packages so the test needs no index. */
let venvPython = ''
const sessions: ReplSession[] = []
function newSession(): ReplSession {
  const session = new ReplSession({
    python: venvPython,
    vendorRoot: join(root, 'vendor', 'prime'),
    pythonRoot: join(root, 'python'),
    cwd: scratch,
  })
  sessions.push(session)
  return session
}
const noTools = (): Map<string, BoundTool> => new Map()
const text = (r: { logs: string[] }): string => r.logs.join('')

/** Build one local wheel with the test's own helper, so no package index is involved. */
function wheel(name: string, version: string, value: string): string {
  const script = 'import sys, pathlib; sys.path.insert(0, sys.argv[1]); '
    + 'from test_packages import make_wheel; '
    + 'print(make_wheel(pathlib.Path(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5]))'
  return execFileSync(PYTHON, ['-c', script, join(root, 'test', 'python'), scratch, name, version, value], {
    env: { ...process.env, PYTHONPATH: join(root, 'python') },
    encoding: 'utf8',
  }).trim()
}

let v1 = ''
let v2 = ''
before(async () => {
  v1 = wheel('dshprobe_kernel', '1.0', 'one')
  v2 = wheel('dshprobe_kernel', '2.0', 'two')
  venvPython = (await kernelEnvironment({ python: PYTHON, ...await probeInterpreter(PYTHON) }, join(scratch, 'venv'), [])).python
})
after(async () => {
  await Promise.all(sessions.map((s) => s.dispose()))
  rmSync(scratch, { recursive: true, force: true })
})

describe('steering away from a second interpreter', () => {
  it('a missing module names the install call, with the real package name', async () => {
    const cell = await newSession().runCell('import fitz', noTools())
    assert.ok(cell.error)
    assert.match(cell.error.message, /await repl\.install\("pymupdf"\)/)
    assert.match(cell.error.message, /project's environment/, 'a project package belongs in the project environment')
  })

  it('a cell that pipes library code into another Python is told once', async () => {
    const session = newSession()
    const calls: string[] = []
    const tools = new Map<string, BoundTool>([['bash', async (args) => {
      calls.push(String((args as { command?: string }).command))
      return { kind: 'foreground', exitCode: 0, stdout: { text: '', truncated: false }, stderr: { text: '', truncated: false } }
    }]])
    const detour = 'script = "import pymupdf\\nprint(1)"\n'
      + 'await bash({"command": "uv run --with pymupdf python -", "stdin": script, "description": "x"})\n'
    const first = await session.runCell(detour, tools)
    assert.equal(first.error, undefined, JSON.stringify(first.error))
    assert.match(text(first), /pulled in pymupdf through a separate Python in bash/)
    assert.match(text(first), /repl\.install\("pymupdf"\)/)
    const second = await session.runCell(detour, tools)
    assert.doesNotMatch(text(second), /separate Python/, 'one reminder per kernel, not a nag')
    assert.equal(calls.length, 2, 'the notice never blocks the command itself')
  })
})

describe('repl.install in a live kernel', () => {
  it('installs, imports in the same cell, and keeps every variable', async () => {
    const session = newSession()
    await session.runCell('kept = 41', noTools())
    const cell = await session.runCell(
      `r = await repl.install(${JSON.stringify(v1)})\n`
        + 'import dshprobe_kernel\n'
        + '(dshprobe_kernel.VALUE, kept + 1, r["importable_now"])',
      noTools(),
    )
    assert.equal(cell.error, undefined, JSON.stringify(cell.error))
    assert.match(text(cell), /'one', 42, \['dshprobe_kernel'\]/)
  })

  it('restart replaces the kernel after the cell; packages survive, variables do not', async () => {
    const session = newSession()
    await session.runCell('import dshprobe_kernel\nmarker = 1', noTools())
    const upgraded = await session.runCell(
      `r = await repl.install(${JSON.stringify(v2)}, upgrade=True)\nr["stale"]`,
      noTools(),
    )
    assert.match(text(upgraded), /\['dshprobe_kernel'\]/, 'an already-imported module must be reported stale')

    const epoch = session.epoch
    const asked = await session.runCell('await repl.restart("new dshprobe_kernel")', noTools())
    assert.equal(asked.error, undefined, JSON.stringify(asked.error))
    assert.match(text(asked), /Kernel restarted as requested \(new dshprobe_kernel\)/)

    const fresh = await session.runCell(
      'import dshprobe_kernel\n(dshprobe_kernel.VALUE, "marker" in globals())',
      noTools(),
    )
    assert.equal(fresh.error, undefined, JSON.stringify(fresh.error))
    assert.equal(session.epoch, epoch + 1)
    assert.match(text(fresh), /\('two', False\)/)
    assert.doesNotMatch(text(fresh), /GONE/, 'a restart the cell asked for is not an unexpected state loss')
  })

  it('a new session kernel finds packages installed by an earlier one', async () => {
    const cell = await newSession().runCell('import dshprobe_kernel\n(await repl.info())["packages"] is not None', noTools())
    assert.equal(cell.error, undefined, JSON.stringify(cell.error))
    assert.match(text(cell), /True/)
  })

  it('reinstalling the installed version changes nothing, and a failed install says why', async () => {
    const session = newSession()
    const again = await session.runCell(`await repl.install(${JSON.stringify(v2)})`, noTools())
    assert.match(text(again), /nothing changed/)
    const failed = await session.runCell(`await repl.install(${JSON.stringify(join(scratch, 'missing-1.0-py3-none-any.whl'))})`, noTools())
    assert.match(failed.error?.message ?? '', /uv failed \(exit/)
  })
})

describe('the kernel venv', () => {
  it('a fresh default environment can open the browser skill WebSocket connection', { timeout: 180_000 }, async () => {
    const base = { python: PYTHON, ...await probeInterpreter(PYTHON) }
    const built = await kernelEnvironment(base, join(scratch, 'default-env'))
    const script = [
      'from threading import Thread',
      'from websockets.sync.client import connect',
      'from websockets.sync.server import serve',
      'def echo(socket):',
      '    socket.send(socket.recv())',
      'with serve(echo, "127.0.0.1", 0) as server:',
      '    thread = Thread(target=server.serve_forever, daemon=True)',
      '    thread.start()',
      '    try:',
      '        with connect(f"ws://127.0.0.1:{server.socket.getsockname()[1]}", open_timeout=5) as socket:',
      '            socket.send("browser-ready")',
      '            assert socket.recv(timeout=5) == "browser-ready"',
      '    finally:',
      '        server.shutdown()',
      '        thread.join(timeout=5)',
      'print("browser-ready")',
    ].join('\n')
    assert.match(execFileSync(built.python, ['-I', '-c', script], {
      encoding: 'utf8', timeout: 15_000,
    }), /browser-ready/)
  })

  it('reuses a matching venv, installs a changed package list in place, and rebuilds for another Python', async () => {
    const base = { python: PYTHON, ...await probeInterpreter(PYTHON) }
    const dir = join(scratch, 'env-under-test')
    const built = await kernelEnvironment(base, dir, [])
    const planted = join(dir, 'planted')
    writeFileSync(planted, '')
    const marker = join(dir, '.dsh-kernel-env.json')
    const stamp = statSync(marker).mtimeMs

    assert.deepEqual(await kernelEnvironment(base, dir, []), built)
    assert.equal(statSync(marker).mtimeMs, stamp, 'a matching marker means no work')

    await kernelEnvironment(base, dir, [v1])
    assert.ok(existsSync(planted), 'a new package list installs without rebuilding')
    assert.match(execFileSync(built.python, ['-c', 'import dshprobe_kernel; print(dshprobe_kernel.VALUE)'], { encoding: 'utf8' }), /one/)

    await kernelEnvironment({ ...base, version: '3.0.0' }, dir, [v1])
    assert.ok(!existsSync(planted), 'another base interpreter rebuilds the venv')
    assert.match(readFileSync(marker, 'utf8'), /"3\.0\.0"/)
  })
})
