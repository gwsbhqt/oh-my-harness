import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fishQuote } from '../src/machines.ts'

for (const shell of ['bash', 'zsh', 'fish']) {
  test(`${shell} preserves remote command arguments literally`, () => {
    const args = ['', 'with space', "single'quote", 'double"quote', '$HOME', '; touch /tmp/never-run', 'back\\slash', '中文 参数', 'line\nbreak']
    const code = 'console.log(JSON.stringify(process.argv.slice(1)))'
    const command = [process.execPath, '-e', code, ...args].map(fishQuote).join(' ')
    const result = spawnSync(shell, ['-c', command], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), args)
  })
}
