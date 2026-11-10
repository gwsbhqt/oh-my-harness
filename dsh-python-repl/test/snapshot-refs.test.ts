/**
 * The snapshot-by-name unit tests need dill, which a bare python3 lacks and
 * would skip. Run them in the shared test kernel venv, and fail on any skip.
 */
import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { testKernelPython } from './fixtures/test-kernel.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

it('snapshot-by-name unit tests pass with dill and skip nothing', { timeout: 300_000 }, async () => {
  const python = await testKernelPython()
  const { stderr } = await promisify(execFile)(python, ['-m', 'unittest', 'discover', '-s', 'test/python', '-p', 'test_snapshot_refs.py', '-v'], { cwd: root, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
  assert.match(stderr, /\nOK\n?$/, stderr)
  assert.doesNotMatch(stderr, /skipped/, stderr)
})
