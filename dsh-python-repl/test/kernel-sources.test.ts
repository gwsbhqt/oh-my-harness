import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readdir, rm, writeFile, mkdir, utimes } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyKernelSources } from '../src/kernel-sources.ts'
import { testKernelPython } from './fixtures/test-kernel.ts'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))

function importKernel(python: string, root: string) {
  const pythonPath = [join(root, 'vendor', 'prime'), join(root, 'python', 'compat'), join(root, 'python')].join(delimiter)
  return spawnSync(python, ['-c', 'import rlm.repl'], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, PYTHONPATH: pythonPath }, timeout: 30_000 })
}

test('a kernel still starts after the checkout it was copied from is moved away', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kernel-sources-'))
  try {
    const checkout = join(root, 'checkout')
    for (const dir of ['python', 'vendor']) await cp(join(packageRoot, dir), join(checkout, dir), { recursive: true })
    const copy = copyKernelSources(checkout, join(root, 'copies'))
    await rm(checkout, { recursive: true })
    const python = await testKernelPython()
    // The failure this guards: a kernel pointed at the moved checkout cannot find rlm.
    const stale = importKernel(python, checkout)
    assert.notEqual(stale.status, 0)
    assert.match(stale.stderr, /No module named 'rlm'/)
    const fresh = importKernel(python, copy)
    assert.equal(fresh.status, 0, fresh.stderr)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('same sources reuse one copy, changed sources get a new one, old copies are pruned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kernel-sources-'))
  try {
    const checkout = join(root, 'checkout')
    const copies = join(root, 'copies')
    await mkdir(join(checkout, 'python', '__pycache__'), { recursive: true })
    await mkdir(join(checkout, 'vendor'), { recursive: true })
    await writeFile(join(checkout, 'python', '__pycache__', 'x.pyc'), 'cache')
    await writeFile(join(checkout, 'vendor', 'v.py'), 'v = 1\n')
    const made: string[] = []
    for (let version = 0; version < 5; version++) {
      await writeFile(join(checkout, 'python', 'm.py'), `value = ${version}\n`)
      const first = copyKernelSources(checkout, copies)
      assert.equal(copyKernelSources(checkout, copies), first)
      assert.equal(existsSync(join(first, 'python', '__pycache__')), false)
      made.push(first)
      // Distinct modification times so pruning order does not depend on clock resolution.
      const at = new Date(Date.now() - (5 - version) * 60_000)
      await utimes(first, at, at)
    }
    const left = (await readdir(copies)).sort()
    assert.deepEqual(left, made.slice(-3).map((path) => path.split('/').pop()!).sort())
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
