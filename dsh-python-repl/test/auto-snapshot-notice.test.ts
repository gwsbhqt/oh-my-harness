import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { testKernelPython } from './fixtures/test-kernel.ts'

const run = promisify(execFile)
const host = fileURLToPath(new URL('./fixtures/auto-snapshot-host.ts', import.meta.url))

for (const [scenario, name] of [
  ['skipped', 'the next cell reports new or changed skipped names; a new kernel gets only its restore notice'],
  ['first-failure', 'a failed first autosave leaves no manifest and announces recovery once'],
  ['old-snapshot', 'a failed autosave leaves the previous successful snapshot intact and the kernel usable'],
  ['protected', 'a partial restore protects the saved files without announcing an autosave failure or recovery'],
  ['late-reply', 'a delayed acknowledgement publishes the real outcome even after the queue stops waiting'],
] as const) {
  it(name, { timeout: 120_000 }, async (t) => {
    const python = await testKernelPython()
    const root = await mkdtemp(join(tmpdir(), 'repl-auto-snapshot-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    const home = join(root, 'home')
    await mkdir(home)
    await run(process.execPath, [host, scenario, root, python], {
      env: { ...process.env, HOME: home, DSH_HOME: join(root, 'host'), PYTHONDONTWRITEBYTECODE: '1' },
    })
  })
}
