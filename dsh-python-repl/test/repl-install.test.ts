/**
 * `repl.install` / `repl.restart` through a real kernel.
 *
 * An analysis library installed into a separate interpreter cannot preserve
 * values in this kernel. Exercise installation and restart here so later
 * cells use the same persistent environment.
 */

import { strict as assert } from 'node:assert'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { execFileSync, spawnSync } from 'node:child_process'
import { ReplSession } from '../src/session.ts'
import { kernelEnvironment, probeInterpreter } from '../src/index.ts'
import { copyKernelSources } from '../src/kernel-sources.ts'
import type { BoundTool } from '../src/lease.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const PYTHON = process.env['DSH_PY'] ?? 'python3'

const scratch = mkdtempSync(join(tmpdir(), 'dsh-install-'))
/** The kernel venv, built by the plugin's own code with no packages so the test needs no index. */
let venvPython = ''
const sessions: ReplSession[] = []
function newSession(cwd = scratch): ReplSession {
  const session = new ReplSession({
    python: venvPython,
    vendorRoot: join(root, 'vendor', 'prime'),
    pythonRoot: join(root, 'python'),
    cwd,
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

  it('installs in the kernel when the project config sets a different pip target', async () => {
    const project = mkdtempSync(join(scratch, 'project-'))
    const target = join(project, 'packages')
    writeFileSync(join(project, 'uv.toml'), `[pip]\ntarget = ${JSON.stringify(target)}\n`)
    const session = newSession(project)
    const localWheel = wheel('dshprobe_project', '1.0', 'kernel')
    const installed = await session.runCell(`await repl.install(${JSON.stringify(localWheel)})`, noTools())
    assert.equal(installed.error, undefined, JSON.stringify(installed.error))
    assert.equal(existsSync(join(target, 'dshprobe_project')), false, 'analysis libraries belong in the kernel venv')
    const imported = await session.runCell(
      'import dshprobe_project, sys\n(dshprobe_project.VALUE, Path(dshprobe_project.__file__).is_relative_to(sys.prefix))',
      noTools(),
    )
    assert.equal(imported.error, undefined, JSON.stringify(imported.error))
    assert.match(text(imported), /\('kernel', True\)/)
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

  it('uses the user wheel source on first install and retries a rejected explicit target', () => {
    const project = mkdtempSync(join(scratch, 'bootstrap-'))
    const configHome = join(project, 'config')
    const userConfig = join(configHome, 'uv', 'uv.toml')
    const target = join(project, 'outside-kernel')
    mkdirSync(dirname(userConfig), { recursive: true })
    const sources = `[pip]\nfind-links = [${JSON.stringify(scratch)}]\n`
    const redirect = `[pip]\ntarget = ${JSON.stringify(target)}\n`
    writeFileSync(userConfig, sources)
    writeFileSync(join(project, 'uv.toml'), redirect)
    const kernelRoot = copyKernelSources(root, join(project, 'kernel-sources'))
    const entryUrl = new URL('../src/index.ts', import.meta.url).href
    const entry = `import { kernelEnvironment, probeInterpreter } from ${JSON.stringify(entryUrl)}
      const [python, dir, sources, ...packages] = process.argv.slice(1)
      await kernelEnvironment({ python, ...await probeInterpreter(python) }, dir, packages, sources)`
    function build(dir: string, explicit?: string) {
      return spawnSync(process.execPath, ['--input-type=module', '-e', entry, PYTHON, dir, kernelRoot, 'dshprobe_kernel==1.0'], {
        cwd: project, encoding: 'utf8', timeout: 30_000,
        env: {
          PATH: process.env['PATH'], HOME: project, XDG_CONFIG_HOME: configHome, APPDATA: configHome,
          UV_OFFLINE: 'true', UV_NO_INDEX: 'true', UV_CACHE_DIR: join(project, 'cache'), UV_PYTHON_DOWNLOADS: 'never',
          ...(explicit && { UV_CONFIG_FILE: explicit }),
        },
      })
    }
    function value(dir: string): string {
      return execFileSync(join(dir, 'bin', 'python'), ['-I', '-c', 'import dshprobe_kernel; print(dshprobe_kernel.VALUE)'], { encoding: 'utf8' }).trim()
    }
    const fromUser = join(project, 'from-user-config')
    const installed = build(fromUser)
    assert.equal(installed.status, 0, installed.stderr)
    assert.equal(value(fromUser), 'one')
    assert.ok(!existsSync(target))

    const fromExplicit = join(project, 'from-explicit-config')
    const explicit = join(project, 'explicit.toml')
    writeFileSync(explicit, redirect)
    const failed = build(fromExplicit, explicit)
    assert.notEqual(failed.status, 0)
    assert.match(failed.stderr, /\[pip\]\.target/)
    assert.ok(!existsSync(join(fromExplicit, '.dsh-kernel-env.json')))
    assert.ok(!existsSync(target))

    writeFileSync(explicit, sources)
    const retried = build(fromExplicit, explicit)
    assert.equal(retried.status, 0, retried.stderr)
    assert.equal(value(fromExplicit), 'one')
  })

  it('repairs a legacy success marker once and keeps packages the user added', async () => {
    const base = { python: PYTHON, ...await probeInterpreter(PYTHON) }
    const dir = join(scratch, 'legacy-env')
    const extra = wheel('dshprobe_extra', '1.0', 'extra')
    const built = await kernelEnvironment(base, dir, [extra])
    const marker = join(dir, '.dsh-kernel-env.json')
    const legacy = JSON.stringify({ base: base.python, version: base.version, packages: [v1] })
    writeFileSync(marker, legacy)

    await kernelEnvironment(base, dir, [v1])
    const imported = 'import dshprobe_kernel, dshprobe_extra; print(dshprobe_kernel.VALUE, dshprobe_extra.VALUE)'
    assert.equal(execFileSync(built.python, ['-I', '-c', imported], { encoding: 'utf8' }).trim(), 'one extra')
    assert.notEqual(readFileSync(marker, 'utf8'), legacy)
    const stamp = statSync(marker).mtimeMs
    assert.deepEqual(await kernelEnvironment(base, dir, [v1], join(scratch, 'unavailable-sources')), built)
    assert.equal(statSync(marker).mtimeMs, stamp)
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
