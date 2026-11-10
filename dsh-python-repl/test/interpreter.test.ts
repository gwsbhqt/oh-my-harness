import { strict as assert } from 'node:assert'
import { it } from 'node:test'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { expandHome, probeInterpreter, pythonCommand, resolvePythonInterpreter } from '../src/index.ts'

it('bounds a stuck interpreter probe and kills only its own process', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-repl-probe-'))
  const executable = join(dir, 'stuck')
  const pidFile = join(dir, 'pid')
  writeFileSync(executable, `#!/bin/sh\necho $$ > '${pidFile}'\ntrap '' TERM\nwhile :; do :; done\n`)
  chmodSync(executable, 0o700)
  let pid: number | undefined
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    const started = Date.now()
    const boundedProbe = probeInterpreter as (python: string, options?: { timeoutMs: number }) => Promise<{ version: string }>
    await assert.rejects(Promise.race([
      boundedProbe(executable, { timeoutMs: 750 }),
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('test guard: probe remained unbounded')), 3500) }),
    ]), (error: Error) => {
      assert.match(error.message, /timed out|timeout|SIGKILL/i)
      const match = /probe pid: (\d+)/.exec(error.message)
      assert.ok(match, 'host must identify its own spawned probe even before the script writes')
      pid = Number(match[1])
      return true
    })
    assert.ok(Date.now() - started < 3000)
    assert.throws(() => process.kill(pid!, 0), /ESRCH/)
  } finally {
    clearTimeout(deadline)
    try { pid ??= Number(readFileSync(pidFile, 'utf8').trim()); process.kill(pid, 'SIGKILL') } catch {}
    rmSync(dir, { recursive: true, force: true })
  }
})

const HOME = '/Users/someone'
const TOO_OLD = () => Promise.reject(new Error('dsh-python-repl: Python 3.11+ required, found 3.9.6.'))

it('expands a leading ~ and leaves every other tilde alone', () => {
  assert.equal(expandHome('~', HOME), HOME)
  assert.equal(expandHome('~/py/bin', HOME), join(HOME, 'py/bin'))
  // 只有开头的 `~` 是家目录：`/a/~/b` 和 `~别人/x` 都不是，别把拼错悄悄变成家目录下的路径。
  assert.equal(expandHome('/a/~/b', HOME), '/a/~/b')
  assert.equal(expandHome('~other/x', HOME), '~other/x')
})

it('runs a bare name from PATH and an explicit path verbatim, with no built-in guesses', () => {
  assert.equal(pythonCommand('python3', HOME), 'python3')
  assert.equal(pythonCommand('  ', HOME), 'python3')
  assert.equal(pythonCommand('~/py/bin/python3', HOME), join(HOME, 'py/bin/python3'))
  assert.equal(pythonCommand('/opt/x/python3', HOME), '/opt/x/python3')
})

it('probes only the configured interpreter and never substitutes another one', async () => {
  const tried: string[] = []
  const picked = await resolvePythonInterpreter('python3', async (candidate) => {
    tried.push(candidate)
    return { version: '3.14.7' }
  })
  assert.deepEqual(picked, { python: 'python3', version: '3.14.7' })
  assert.deepEqual(tried, ['python3'])
})

it('tells the user to check the terminal and restart DSH when a bare name does not qualify', async () => {
  await assert.rejects(resolvePythonInterpreter('python3', TOO_OLD), (error: Error) => {
    assert.match(error.message, /试过 python3/)
    assert.match(error.message, /found 3\.9\.6/)
    // 用户看到的只有这条报错，所以修法必须写在里面。
    assert.match(error.message, /uv python install/)
    assert.match(error.message, /终端里确认 python3 --version/)
    assert.match(error.message, /重启 DSH/)
    return true
  })
})

it('does not suggest the terminal for an explicit path: that pin is the problem', async () => {
  await assert.rejects(resolvePythonInterpreter('/opt/x/python3', TOO_OLD), (error: Error) => {
    assert.match(error.message, /试过 \/opt\/x\/python3/)
    assert.doesNotMatch(error.message, /终端里确认/)
    return true
  })
})

it('resolves a real interpreter that satisfies the floor on this machine', async (t) => {
  let picked: { python: string; version: string }
  try {
    picked = await resolvePythonInterpreter(process.env['DSH_PY'] ?? 'python3')
  } catch (error) {
    // 本机确实没有 3.11+ 的 Python 时跳过，而不是假装通过。
    t.skip(`本机没有可用的 Python：${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
    return
  }
  const { version } = await probeInterpreter(picked.python)
  const [major = 0, minor = 0] = version.split('.').map(Number)
  assert.ok(major > 3 || (major === 3 && minor >= 12), `选中的 ${picked.python} 是 ${version}`)
})
