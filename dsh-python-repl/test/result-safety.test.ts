import { strict as assert } from 'node:assert'
import { after, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ReplSession } from '../src/session.ts'
import type { BoundTool } from '../src/lease.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const session = new ReplSession({ python: process.env['DSH_PY'] ?? 'python3', vendorRoot: join(root, 'vendor', 'prime'), pythonRoot: join(root, 'python') })
after(() => session.dispose())

it('public read_window validates cursor, rejects known truncation, never claims losslessness', async () => {
  const tools = new Map<string, BoundTool>([['read', async () => ({ path: '/fixture', offset: 1, totalLines: 3,
    lines: [{ number: 1, text: 'a' }, { number: 2, text: 'b' }] })]])
  const cell = await session.runCell(`r = await read({"file_path": "/fixture"})
w = await repl.read_window(r, offset=1, limit=2000)
assert w["next_offset"] == 3 and w["byte_completeness"] == "unknown"
try:
    await repl.require_complete(r)
except ValueError as exc:
    assert "byte completeness" in str(exc)
else:
    raise AssertionError("read completeness was accepted")
r["lines"][1]["text"] = "b... (line truncated to 2000 chars)"
try:
    await repl.read_window(r)
except ValueError as exc:
    assert "truncation marker" in str(exc)
else:
    raise AssertionError("known truncation was accepted")
True`, tools)
  assert.equal(cell.error, undefined, JSON.stringify(cell.error))
  assert.match(cell.logs.join(''), /True/)
})

it('a bash receipt retains direct job_output reads across cells and caches terminal reads', async () => {
  for (const [kind, finalRead] of [['background', 'wait'], ['background', 'direct'], ['promoted', 'peek']] as const) {
    const id = `fixture-${kind}-${finalRead}`
    const initial = kind === 'promoted' ? 'before promotion\n' : ''
    const outputs = ['direct\n', 'preview\n', 'last\n']
    let reads = 0
    const tools = new Map<string, BoundTool>([
      ['bash', async (args) => {
        assert.equal((args as { run_in_background?: boolean }).run_in_background === true, kind === 'background')
        return kind === 'background' ? { kind, jobId: id } : { kind, jobId: id, output: initial, truncated: true, spillPaths: ['/fixture/output.log'] }
      }],
      ['job_output', async (args) => {
        assert.equal((args as { job_id: string }).job_id, id)
        assert.ok(reads < outputs.length, 'the terminal read is already cached')
        const text = outputs[reads++]
        return { text, job: { id, status: reads === outputs.length ? 'completed' : 'running', detail: 'exit code: 7' } }
      }],
    ])
    const receipt = await session.runCell(`r = await bash("fixture", "collect output"${kind === 'background' ? ', run_in_background=True' : ''})
chunk = await tools.job_output(job_id=r.jobId)
assert chunk.text == "direct\\n"`, tools)
    assert.equal(receipt.error, undefined, JSON.stringify(receipt.error))
    const result = await session.runCell(`prefix = ${JSON.stringify(initial)}
final_read = ${JSON.stringify(finalRead)}
if final_read != "wait":
    assert await r.peek() == prefix + "direct\\npreview\\n"
    if final_read == "direct":
        assert (await tools.job_output(job_id=r.jobId, wait=True)).text == "last\\n"
    else:
        assert (await r.peek()).endswith("last\\n")
done = await r
assert done.text == prefix + "direct\\npreview\\nlast\\n"
assert done.stdout.text == done.text and done.exitCode == 7
assert done.stdout.truncated is ${kind === 'promoted' ? 'True' : 'None'}
assert done.spillPaths == ${kind === 'promoted' ? '["/fixture/output.log"]' : '[]'}
assert (await r) is done and (await r.peek()) == done.text`, tools)
    assert.equal(result.error, undefined, JSON.stringify(result.error))
    assert.equal(reads, 3)
  }
})

it('real kernel displays short write/edit values while preserving full data across cells', async () => {
  const value = { path: '/fixture', before: 'OLD'.repeat(400000), after: 'NEW'.repeat(400000) }
  const tools = new Map<string, BoundTool>([['write', async () => value], ['edit', async () => value]])
  for (const tool of ['write', 'edit']) {
    const cell = await session.runCell(`saved = await ${tool}({"file_path": "/fixture"})
print(saved)
saved`, tools)
    assert.equal(cell.error, undefined)
    assert.ok(cell.logs.join('').length < 2500)
    assert.doesNotMatch(cell.logs.join(''), /OLDOLD|NEWNEW/)
    const next = await session.runCell('len(saved["after"]), len(_["before"])', tools)
    assert.equal(next.error, undefined)
    assert.match(next.logs.join(''), /1200000/)
  }
})
