/**
 * A namespace of ten thousand names (Prime discussion #3745: a name list that
 * grows with every compaction) must not flood the model. Real kernel, real
 * snapshot: the restore note stays short, and lists of lost names are capped.
 */
import { strict as assert } from 'node:assert'
import { after, before, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { ReplSession } from '../src/session.ts'
import { restoreNotice } from '../src/snapshot.ts'
import { testKernelPython } from './fixtures/test-kernel.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-many-names-'))
let python = ''
before(async () => { python = await testKernelPython() })
const sessions: ReplSession[] = []
after(async () => { await Promise.all(sessions.map((s) => s.dispose())); rmSync(scratch, { recursive: true, force: true }) })

it('ten thousand names come back with a restore note of bounded size', { timeout: 180_000 }, async () => {
  const session = new ReplSession({ python, vendorRoot: join(root, 'vendor', 'prime'), pythonRoot: join(root, 'python'),
    cwd: scratch, startupTimeoutMs: 60_000, statePath: join(scratch, 'state') })
  sessions.push(session)
  const made = await session.runCell('for i in range(10_000):\n    globals()[f"v{i}"] = i\nlen([k for k in globals() if k.startswith("v")])', new Map())
  assert.equal(made.error, undefined, JSON.stringify(made))
  assert.equal((await session.runCell('await repl.restart()', new Map())).error, undefined)
  const started = Date.now()
  const back = await session.runCell('assert v9999 == 9999', new Map())
  assert.equal(back.error, undefined, JSON.stringify(back.error))
  const note = back.logs.find((line) => line.startsWith('[python-state-restored]')) ?? ''
  assert.match(note, /10001 names are back/, 'v0..v9999 plus the loop variable i')
  assert.match(note, /\(\+\d+ more\)/)
  assert.ok(note.length < 2_000, `restore note is ${note.length} characters`)
  assert.ok(Date.now() - started < 60_000)
})

it('lost names are listed by name, but no more than fifty', () => {
  const failed = Array.from({ length: 10_000 }, (_, i) => `gone${i}`)
  const notice = restoreNotice({ restored: [], failed, unsaved: failed })
  assert.match(notice, /could not be restored[^\n]*gone0, gone1,[^\n]*gone49 \(\+9950 more\)\./)
  assert.match(notice, /never saved[^\n]*\(\+9950 more\)\./)
  assert.ok(notice.length < 3_000)
})
