/**
 * The kernel venv the real-kernel tests share: built from uv's Python 3.14 the
 * way the plugin builds a session's kernel venv, but with only the packages
 * these tests need — `dill` for snapshots, `httpx` for the proxy regression
 * (kernel-owner.test.ts). One list for every test, because the venv marker
 * records it: two lists would reinstall on every alternate run.
 */
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { kernelEnvironment, probeInterpreter } from '../../src/index.ts'

export const TEST_KERNEL_PACKAGES = ['dill', 'httpx'] as const
const VENV = join(homedir(), '.cache', 'dsh-python-repl', 'test-kernel-venv')

let pending: Promise<string> | undefined

/** Path of the shared test kernel's python, building or topping up the venv on first call. */
export function testKernelPython(): Promise<string> {
  pending ??= (async () => {
    const base = process.env['DSH_SNAPSHOT_PY']
      ?? execFileSync('uv', ['python', 'find', '--managed-python', '3.14'], { encoding: 'utf8' }).trim()
    return (await kernelEnvironment({ python: base, ...await probeInterpreter(base) }, VENV, TEST_KERNEL_PACKAGES)).python
  })()
  return pending
}
