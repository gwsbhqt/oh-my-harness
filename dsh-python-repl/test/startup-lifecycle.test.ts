import { strict as assert } from 'node:assert'
import { it } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { ReplSession } from '../src/session.ts'
import { discoverSkills } from '../src/skill-discovery.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const python = process.env['DSH_PY'] ?? 'python3'
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}
async function pidFrom(file: string): Promise<number> {
  for (let i = 0; i < 250; i++) {
    if (existsSync(file)) {
      const text = await readFile(file, 'utf8')
      if (text.trim()) return Number(text)
    }
    await delay(20)
  }
  throw new Error(`fixture did not enter: ${file}`)
}
async function fixture(mode: 'handshake' | 'bootstrap' | 'both', extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-startup-boundary-'))
  const pidFile = join(dir, 'pid')
  const action = join(dir, 'user-action')
  let command = python
  let skillRoots: string[] = []
  if (mode !== 'bootstrap') {
    command = join(dir, 'python')
    const code = `import os,time; open(${JSON.stringify(pidFile)},'w').write(str(os.getpid())); time.sleep(1.5); os.execvp(${JSON.stringify(python)}, [${JSON.stringify(python)}, '-m', 'rlm.repl'])`
    await writeFile(command, `#!/bin/sh\nexec ${JSON.stringify(python)} -c ${JSON.stringify(code)}\n`)
    await chmod(command, 0o755)
  }
  if (mode !== 'handshake') {
    const skill = join(dir, 'skills', 'slow_start')
    await mkdir(join(skill, 'src', 'slow_start'), { recursive: true })
    await writeFile(join(skill, 'SKILL.md'), '---\nname: slow_start\ndescription: isolated finite bootstrap delay\n---\n')
    await writeFile(join(skill, 'src', 'slow_start', '__init__.py'),
      `import os,time\nopen(${JSON.stringify(pidFile)},'w').write(str(os.getpid()))\ntime.sleep(2)\n`)
    skillRoots = [join(dir, 'skills')]
  }
  const session = new ReplSession({ python: command, vendorRoot: join(root, 'vendor/prime'),
    pythonRoot: join(root, 'python'), cwd: dir, skills: discoverSkills(skillRoots).skills,
    startupTimeoutMs: 4000, interruptGraceMs: 100, teardownGraceMs: 100, ...extra })
  const controller = new AbortController()
  const running = session.runCell(`open(${JSON.stringify(action)}, 'w').write('ran')`, new Map(), controller.signal)
  const pid = await pidFrom(pidFile)
  return { session, controller, running, pid, action, dir }
}
async function cleanup(f: Awaited<ReturnType<typeof fixture>>) {
  if (alive(f.pid)) process.kill(f.pid, 'SIGKILL')
  await f.running
  await f.session.dispose()
  await rm(f.dir, { recursive: true, force: true })
}
for (const mode of ['handshake', 'bootstrap'] as const) {
  it(`dispose owns a process during ${mode}, blocks user code and joins repeated disposal`, { timeout: 10000 }, async () => {
    const f = await fixture(mode)
    try {
      const at = performance.now()
      await Promise.all([f.session.dispose(), f.session.dispose()])
      const result = await f.running
      assert.ok(result.error, JSON.stringify(result))
      assert.equal(existsSync(f.action), false)
      assert.equal(alive(f.pid), false, `pid ${f.pid} must really exit before dispose resolves`)
      assert.ok(performance.now() - at < 1000)
    } finally { await cleanup(f) }
  })
  it(`abort during ${mode} has a host deadline and never executes user code`, { timeout: 10000 }, async () => {
    const f = await fixture(mode)
    try {
      const at = performance.now()
      f.controller.abort()
      const result = await f.running
      assert.equal(result.error?.kind, 'abort', JSON.stringify(result))
      assert.ok(performance.now() - at < 1000, 'cancellation must not wait for the Python event loop')
      assert.equal(existsSync(f.action), false)
      assert.equal(alive(f.pid), false, `cancelled startup pid ${f.pid} must exit`)
    } finally { await cleanup(f) }
  })
}
it('the startup timeout includes bootstrap, not just ready', { timeout: 10000 }, async () => {
  const f = await fixture('bootstrap', { startupTimeoutMs: 1200 })
  try {
    const result = await f.running
    assert.equal(result.error?.kind, 'worker-exit')
    assert.match(result.error?.message ?? '', /startup.*timed out/)
    assert.equal(existsSync(f.action), false)
    assert.equal(alive(f.pid), false)
  } finally { await cleanup(f) }
})
it('handshake and bootstrap share one startup budget', { timeout: 10000 }, async () => {
  const f = await fixture('both', { startupTimeoutMs: 2600 })
  try {
    const at = performance.now()
    const result = await f.running
    assert.equal(result.error?.kind, 'worker-exit')
    assert.match(result.error?.message ?? '', /startup timed out after 2600ms/)
    assert.ok(performance.now() - at < 3100, 'handshake plus bootstrap must not consume two full startup budgets')
    assert.equal(alive(f.pid), false)
    assert.equal(existsSync(f.action), false)
  } finally { await cleanup(f) }
})
it('dispose and abort during startup join without resurrecting the kernel', { timeout: 10000 }, async () => {
  const f = await fixture('bootstrap')
  try {
    f.controller.abort()
    await f.session.dispose()
    assert.ok((await f.running).error)
    assert.equal(existsSync(f.action), false)
    assert.equal(alive(f.pid), false)
    assert.equal((await f.session.runCell('1', new Map())).error?.kind, 'worker-exit')
  } finally { await cleanup(f) }
})
