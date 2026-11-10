/**
 * A kernel that never finishes its handshake must not outlive the attempt.
 *
 * If `start()` rejected on a handshake timeout or a protocol mismatch but
 * left the child running, nothing would reference it any more — the session
 * only keeps a kernel that started — so each retrying cell would leak one
 * more Python process that no dispose could reach.
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PythonKernel } from '../src/kernel.ts'
import { ReplSession } from '../src/session.ts'

const PYTHON = process.env['DSH_PY'] ?? 'python3'
const temps: string[] = []
after(async () => {
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })))
})

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function exitWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !processAlive(pid)
}

/** A fake kernel that records its pid, optionally sends one frame, then waits forever. */
function silentKernel(pidFile: string, firstFrame?: object): string[] {
  const frame = firstFrame === undefined ? '' : `sys.stdout.write(${JSON.stringify(JSON.stringify(firstFrame))} + "\\n"); sys.stdout.flush(); `
  return ['-c', `import os, sys, time; open(${JSON.stringify(pidFile)}, "w").write(str(os.getpid())); ${frame}time.sleep(120)`]
}

async function pidFrom(file: string): Promise<number> {
  for (let i = 0; i < 100; i += 1) {
    try {
      const text = (await readFile(file, 'utf8')).trim()
      if (text !== '') return Number(text)
    } catch {
      // not written yet
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`fake kernel never wrote ${file}`)
}

describe('a failed kernel handshake releases the process it started', () => {
  it('kills the child when the handshake times out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-repl-handshake-'))
    temps.push(dir)
    const pidFile = join(dir, 'pid')
    const kernel = new PythonKernel({ python: PYTHON, pythonPath: [], moduleArgs: silentKernel(pidFile), onHostRequest: () => {} }, 1)
    await assert.rejects(kernel.start(800), /handshake timed out/)
    const pid = await pidFrom(pidFile)
    assert.ok(await exitWithin(pid, 3_000), `the half-started kernel ${pid} must be killed`)
  })

  it('kills the child when it speaks another protocol version', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-repl-handshake-'))
    temps.push(dir)
    const pidFile = join(dir, 'pid')
    const kernel = new PythonKernel({
      python: PYTHON,
      pythonPath: [],
      moduleArgs: silentKernel(pidFile, { event: 'ready', protocol: 999, python: '3.12.0-fake' }),
      onHostRequest: () => {},
    }, 1)
    await assert.rejects(kernel.start(10_000), /protocol 999/)
    const pid = await pidFrom(pidFile)
    assert.ok(await exitWithin(pid, 3_000), `the mismatched kernel ${pid} must be killed`)
  })

  it('returns promptly when the interpreter does not exist at all', async () => {
    // No process means no 'exit' event: releasing it must not wait for one.
    const kernel = new PythonKernel({ python: '/nonexistent/python-for-handshake-test', pythonPath: [], onHostRequest: () => {} }, 1)
    const outcome = await Promise.race([
      kernel.start(5_000).then(() => 'started', (error: Error) => error.message),
      new Promise<string>((r) => setTimeout(() => r('hung'), 3_000)),
    ])
    assert.match(outcome, /cannot start the Python kernel/)
    assert.equal(await Promise.race([
      kernel.terminate('again').then(() => 'done'),
      new Promise<string>((r) => setTimeout(() => r('hung'), 1_000)),
    ]), 'done')
  })

  it('a session whose kernel never answers leaks no process across retries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-repl-handshake-'))
    temps.push(dir)
    // The session builds its own kernel command line, so give it an
    // interpreter that ignores `-m rlm.repl` and never sends `ready`. The
    // marker argument makes its processes findable, and the sleep is the
    // handshake that never comes.
    const marker = `dsh-handshake-leak-${process.pid}-${Date.now()}`
    const wrapper = join(dir, 'python')
    const { writeFile, chmod } = await import('node:fs/promises')
    await writeFile(wrapper, `#!/bin/sh\nexec ${JSON.stringify(PYTHON)} -c 'import time; time.sleep(120)' ${marker}\n`)
    await chmod(wrapper, 0o755)
    const session = new ReplSession({ python: wrapper, vendorRoot: dir, pythonRoot: dir, startupTimeoutMs: 600 })
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = await session.runCell('1', new Map())
        assert.equal(result.error?.kind, 'worker-exit', JSON.stringify(result))
        assert.match(result.error?.message ?? '', /handshake timed out/)
      }
      const { execFileSync } = await import('node:child_process')
      let left = ''
      for (let i = 0; i < 60; i += 1) {
        try {
          left = execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim()
        } catch {
          left = '' // pgrep exits 1 when nothing matches
        }
        if (left === '') break
        await new Promise((r) => setTimeout(r, 50))
      }
      assert.equal(left, '', `retries left kernel processes running: ${left}`)
    } finally {
      await session.dispose()
    }
  })
})
