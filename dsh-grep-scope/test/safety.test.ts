import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { parseUnreadable, rootFailure, runScopedSearch } from '../src/index.ts'

const permission = 'rg: ./locked: Permission denied (os error 13)\n'
const match = './ok.txt\u00001:needle\n'

function simulated({ stdout = match, stderr = permission, stdoutLossy = false, stderrLossy = false, signal = null, abort = false, exitCode = 2 }: {
  stdout?: string; stderr?: string; stdoutLossy?: boolean; stderrLossy?: boolean;
  signal?: NodeJS.Signals | null; abort?: boolean; exitCode?: number;
} = {}) {
  const controller = new AbortController()
  const handle = {
    collected: {
      stdout: { readFrom: () => ({ text: stdout, lossy: stdoutLossy, nextOffset: Buffer.byteLength(stdout) }) },
      stderr: { readFrom: () => ({ text: stderr, lossy: stderrLossy, nextOffset: Buffer.byteLength(stderr) }) },
    },
    done: Promise.resolve({ exitCode, signal }).then(outcome => { if (abort) controller.abort(); return outcome }),
  } as unknown as SubprocessHandle
  let spawns = 0
  const ctx = { subprocess: { spawn: () => { spawns++; return handle } }, workingDirectory: { ensure: async () => '/tmp' } } as unknown as Context
  const exec = { signal: controller.signal, agent: { session: { header: { cwd: '/tmp' } } } } as unknown as ToolRunContext
  return { run: () => runScopedSearch(ctx, exec, { pattern: 'needle' }), spawns: () => spawns }
}

test('lossy stderr cannot certify that all diagnostics were path IO errors', async () => {
  assert.equal(parseUnreadable('partial diagnostic\n' + permission, true), undefined)
  const fake = simulated({ stderr: 'partial diagnostic\n' + permission, stderrLossy: true })
  await assert.rejects(fake.run, { code: 'SEARCH_FAILED' })
  assert.equal(fake.spawns(), 1, 'external execution is never replayed')
})

test('a complete path error list preserves matches but not a claim of full coverage', async () => {
  const fake = simulated()
  const value = await fake.run()
  assert.equal(value.matches.length, 1)
  assert.deepEqual(value.unreadable, [{ path: './locked', error: 'Permission denied (os error 13)' }])
  assert.equal(value.unreadableIncomplete, undefined)
})

test('raw stdout loss comes back marked incomplete; cancellation, termination and fatal diagnostics remain failures', async () => {
  const lossy = await simulated({ stdout: 'cut-off tail\n' + match, stdoutLossy: true }).run()
  assert.equal(lossy.outputCapped, true)
  assert.deepEqual(lossy.matches.map(row => row.path), ['./ok.txt'], 'the cut-off first record of the tail is dropped')
  await assert.rejects(simulated({ abort: true }).run, { code: 'SEARCH_ABORTED' })
  await assert.rejects(simulated({ signal: 'SIGTERM' }).run, { code: 'SEARCH_FAILED' })
  await assert.rejects(simulated({ stderr: 'fatal search error\n' + permission }).run, { code: 'SEARCH_FAILED' })
  await assert.rejects(simulated({ stderr: permission, exitCode: 3 }).run, { code: 'SEARCH_FAILED' })
})

test('ambiguous diagnostic boundaries do not certify a path error list', () => {
  assert.equal(parseUnreadable('rg: locked: IO error for operation on other: Permission denied (os error 13)\n'), undefined)
  assert.equal(parseUnreadable('rg: locked: fatal engine failure (os error 13)\n'), undefined)
  assert.equal(parseUnreadable('rg: locked: Permission denied (os error 2)\n'), undefined)
  assert.equal(parseUnreadable(permission, true), undefined)
  assert.equal(parseUnreadable('regex parse error:\n' + permission), undefined)
})

test('the search root is compared as a resolved path, including dot segments', () => {
  const rows = [{ path: './locked', error: 'Permission denied (os error 13)' }]
  assert.match(rootFailure('locked/', '/tmp', rows) ?? '', /无法读取搜索路径/)
})
