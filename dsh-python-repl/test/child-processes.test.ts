/**
 * Programs a cell starts end with the kernel unless the cell detached them.
 *
 * Field 2026-10-13: a cell's `subprocess.Popen` started a headless Chrome for
 * a benchmark and never stopped it. DSH restarted, the kernel went away, and
 * the browser plus a local http server kept running for 22 hours.
 *
 * Real Python kernels and real child processes throughout; every wait is
 * bounded, so a regression fails instead of hanging the suite.
 */
import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ReplSession } from '../src/session.ts'
import type { BoundTool } from '../src/lease.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PYTHON = process.env['DSH_PY'] ?? 'python3'
const noTools = (): Map<string, BoundTool> => new Map()
const posix = process.platform !== 'win32'

const sessions: ReplSession[] = []
const strays: number[] = []
function newSession(): ReplSession {
  const session = new ReplSession({
    python: PYTHON,
    vendorRoot: join(root, 'vendor', 'prime'),
    pythonRoot: join(root, 'python'),
    teardownGraceMs: 2_000,
  })
  sessions.push(session)
  return session
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

async function gone(pid: number, ms = 5_000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  return !alive(pid)
}

/** Start `sleep` from inside the kernel and return its pid. */
async function startChild(session: ReplSession, extra = ''): Promise<number> {
  const result = await session.runCell(
    `import subprocess as _sp\n_child = _sp.Popen(["sleep", "300"]${extra})\nprint(_child.pid)`, noTools())
  assert.equal(result.error, undefined, JSON.stringify(result))
  const pid = Number((result.logs[0] ?? '').trim())
  assert.ok(Number.isSafeInteger(pid) && pid > 0, `child pid from ${JSON.stringify(result.logs)}`)
  strays.push(pid)
  return pid
}

after(async () => {
  await Promise.allSettled(sessions.map((s) => s.dispose()))
  for (const pid of strays) { try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ } }
})

describe('programs a cell starts', { skip: !posix && 'process groups are POSIX-only' }, () => {
  it('stop when the session closes', async () => {
    const session = newSession()
    const pid = await startChild(session)
    assert.ok(alive(pid))
    await session.dispose()
    assert.ok(await gone(pid), `child ${pid} outlived the closed session`)
  })

  it('stop when the kernel is restarted', async () => {
    const session = newSession()
    const pid = await startChild(session)
    const result = await session.runCell('await repl.restart("test")', noTools())
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.ok(await gone(pid), `child ${pid} outlived the replaced kernel`)
  })

  it('stop when the kernel dies on its own', async () => {
    const session = newSession()
    const pid = await startChild(session)
    await session.runCell('import os, signal\nos.kill(os.getpid(), signal.SIGKILL)', noTools())
    assert.ok(await gone(pid), `child ${pid} outlived a killed kernel`)
  })

  it('a grandchild that ignores SIGTERM is killed after the grace period', async () => {
    const session = newSession()
    const result = await session.runCell(
      'import subprocess as _sp\n'
      + '_c = _sp.Popen(["/bin/sh", "-c", "trap \'\' TERM; sleep 300 & echo $!; wait"], stdout=_sp.PIPE, text=True)\n'
      + 'print(_c.stdout.readline().strip())', noTools())
    assert.equal(result.error, undefined, JSON.stringify(result))
    const pid = Number((result.logs[0] ?? '').trim())
    strays.push(pid)
    await session.dispose()
    assert.ok(await gone(pid), `grandchild ${pid} survived`)
  })

  it('keep running when the cell explicitly detached them', async () => {
    const session = newSession()
    const pid = await startChild(session, ', start_new_session=True')
    await session.dispose()
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    assert.ok(alive(pid), 'a start_new_session child is the cell\'s own responsibility and must survive')
    process.kill(pid, 'SIGKILL')
  })

  it('stop when the host process disappears without cleaning up', async () => {
    // A stand-in host: it starts a kernel, the kernel starts a child, then the
    // host is SIGKILLed so none of its own teardown runs. Only the kernel's
    // owner watchdog is left to clean up.
    const script = `
      import { ReplSession } from ${JSON.stringify(join(root, 'src', 'session.ts'))}
      const s = new ReplSession({ python: ${JSON.stringify(PYTHON)}, vendorRoot: ${JSON.stringify(join(root, 'vendor', 'prime'))}, pythonRoot: ${JSON.stringify(join(root, 'python'))} })
      const r = await s.runCell('import subprocess as _sp\\n_c = _sp.Popen(["sleep", "300"])\\nprint(_c.pid)', new Map())
      process.stdout.write(r.logs.join('').trim() + '\\n')
      setInterval(() => {}, 1000)
    `
    const host = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
    const pid = await new Promise<number>((resolve, reject) => {
      let text = ''
      const timer = setTimeout(() => reject(new Error(`host printed no pid: ${text}`)), 20_000)
      host.stdout.setEncoding('utf8')
      host.stdout.on('data', (chunk: string) => {
        text += chunk
        const line = text.split('\n')[0]!.trim()
        if (text.includes('\n') && /^\d+$/.test(line)) { clearTimeout(timer); resolve(Number(line)) }
      })
    })
    strays.push(pid)
    assert.ok(alive(pid))
    host.kill('SIGKILL')
    assert.ok(await gone(pid, 8_000), `child ${pid} outlived its host`)
  })
})
