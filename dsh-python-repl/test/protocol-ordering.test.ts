/**
 * Deterministic regression for the window between `done` and the lease revoke.
 *
 * A test built on a real kernel cannot pin this: whether `done` and a
 * trailing `host_request` land in the same pipe read is a scheduling
 * accident. A test that depends on
 * an accident proves nothing on the runs where the accident does not happen.
 *
 * So this drives `PythonKernel` directly against a fixture kernel that emits
 * both frames in ONE `os.write`. The dispatch loop is then guaranteed to parse
 * them inside a single chunk with no yield in between — which is exactly the
 * window where revoking in a promise continuation (a microtask) would be too
 * late.
 *
 * Deleting the synchronous `onCellSettled` call in src/kernel.ts must make
 * `refuses a tool call batched behind done` fail. That is the contract this
 * file exists to hold — the third test below proves the file is sensitive to
 * it.
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PythonKernel } from '../src/kernel.ts'
import { asToolRequest } from '../src/protocol.ts'
import { LeaseRegistry, describeDenial, type BoundTool } from '../src/lease.ts'

const here = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(here, 'fixtures')
const PYTHON = process.env['DSH_PY'] ?? 'python3'

const kernels: PythonKernel[] = []
after(async () => {
  await Promise.all(kernels.map((k) => k.dispose()))
})

interface Harness {
  kernel: PythonKernel
  leases: LeaseRegistry
  served: unknown[]
  denials: string[]
}

/**
 * Wire a kernel to a lease table exactly as ReplSession does.
 * @param synchronousRevoke - when false, emulate the OLD behaviour (revoke in
 *   a microtask) so the test can prove it actually catches the regression.
 */
async function boot(synchronousRevoke: boolean): Promise<Harness> {
  const leases = new LeaseRegistry()
  const served: unknown[] = []
  const denials: string[] = []

  const kernel = new PythonKernel(
    {
      python: PYTHON,
      pythonPath: [FIXTURE],
      cwd: FIXTURE,
      env: { DSH_FIXTURE: '1' },
      onHostRequest: (id, data) => {
        const request = asToolRequest(data)
        if (request === undefined) return
        const lookup = leases.resolve(request.runId, request.epoch, request.tool)
        if (!lookup.ok) {
          denials.push(describeDenial(lookup.denial))
          kernel.reply(id, { status: 'error', error: 'denied' })
          return
        }
        void lookup.call(request.args).then(() => {
          kernel.reply(id, { status: 'ok', result: null })
        })
      },
      moduleArgs: ['batched_kernel.py'],
      ...(synchronousRevoke ? { onCellSettled: (runId: string) => leases.revoke(runId) } : {}),
    },
    1,
  )
  kernels.push(kernel)
  await kernel.start(15_000)

  const tools = new Map<string, BoundTool>([
    ['late', async (args) => { served.push(args); return null }],
  ])
  leases.grant('run-1', 1, tools)
  return { kernel, leases, served, denials }
}

describe('protocol ordering: done and a trailing host_request in one chunk', () => {
  it('refuses a tool call batched behind done', async () => {
    const h = await boot(true)
    await h.kernel.execute('run-1', 'anything')
    // Give the dispatch loop a turn to process the trailing frame.
    await new Promise((r) => setTimeout(r, 120))

    assert.deepEqual(
      h.served,
      [],
      'a request parsed after `done` in the SAME chunk must not reach the binding',
    )
    assert.equal(h.denials.length, 1, 'and it must be explicitly denied, not silently dropped')
    assert.match(h.denials[0] ?? '', /already settled|not active/)
  })

  it('the lease is gone the instant done is parsed', async () => {
    const h = await boot(true)
    await h.kernel.execute('run-1', 'anything')
    assert.equal(h.leases.resolve('run-1', 1, 'echo').ok, false)
  })

  it('WITHOUT the synchronous revoke the same batch gets served (guard proof)', async () => {
    // Proves the test is actually sensitive to the fix: with revocation left to
    // the caller's continuation, the batched request slips through.
    const h = await boot(false)
    await h.kernel.execute('run-1', 'anything')
    await new Promise((r) => setTimeout(r, 120))

    assert.equal(
      h.served.length,
      1,
      'this assertion documents the OLD defect; if it fails, the fixture no longer '
        + 'reproduces the window and the positive test above has stopped being meaningful',
    )
  })
})
