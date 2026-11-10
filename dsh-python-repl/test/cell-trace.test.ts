/**
 * Waiting and failure reporting in a cell (src/cell-trace.ts, python/cell_errors.py):
 * a cell never waits long on one command or job, and a failed or cancelled
 * cell says which tool calls already happened and which lines never ran.
 */
import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ReplSession } from '../src/session.ts'
import { callsReport, pythonMs, traceNotes, withWaitCap, type TracedCall } from '../src/cell-trace.ts'
import type { BoundTool } from '../src/lease.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const sessions: ReplSession[] = []
function session(cellWaitMs?: number): ReplSession {
  const s = new ReplSession({ python: process.env['DSH_PY'] ?? 'python3', vendorRoot: join(root, 'vendor', 'prime'), pythonRoot: join(root, 'python'),
    ...(cellWaitMs === undefined ? {} : { cellWaitMs }) })
  sessions.push(s)
  return s
}
after(async () => { await Promise.all(sessions.map((s) => s.dispose())) })
const message = (cell: { error?: { message: string } }) => cell.error?.message ?? ''
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

describe('failed and cancelled cells', () => {
  it('list the calls already made, the last success, and the definitions that never ran', async () => {
    const s = session()
    const tools = new Map<string, BoundTool>([
      ['read', async () => ({ path: '/a.py', offset: 1, lines: [], totalLines: 0 })],
      ['edit', async () => { throw new Error('old_string was not found in "/a.py"') }],
    ])
    assert.equal(message(await s.runCell('rows = [1]', new Map())), '')
    const text = message(await s.runCell('r = await read({"file_path": "/a.py"})\nawait edit({"file_path": "/a.py", "old_string": "x", "new_string": "y"})\nrows = [2]\ndef helper():\n    return 1', tools))
    assert.match(text, /^ToolCallError: old_string was not found/)
    assert.match(text, /Tool calls this cell made before it stopped \(2\):\n  #1 read \/a\.py: ok\n  #2 edit \/a\.py: failed/)
    assert.match(text, /Last call that succeeded: #1 read\. Completed calls are not undone/)
    assert.match(text, /The cell stopped at line 2; lines 3-5 did not run, so not defined: helper; still the value from an earlier cell: rows\./)
  })

  it('say nothing extra for a cell that made no calls and had nothing after the failing line', async () => {
    const text = message(await session().runCell('x = 1\n{}["k"]', new Map()))
    assert.doesNotMatch(text, /Tool calls this cell made|did not run/)
  })

  it('a cancelled cell names the call still running', async () => {
    const s = session()
    const controller = new AbortController()
    const tools = new Map<string, BoundTool>([['bash', () => new Promise(() => undefined)]])
    const pending = s.runCell('await bash({"command": "sleep 100", "description": "wait"})', tools, controller.signal)
    await sleep(800)
    controller.abort()
    const text = message(await pending)
    assert.match(text, /cell was cancelled\nTool calls this cell made before it stopped \(1\):\n  #1 bash sleep 100: still running when the cell stopped; DSH cancels it/)
  })
})

describe('waiting in a cell', () => {
  it('await job stops after cellWaitMs and says DSH will wake the agent', async () => {
    const s = session(400)
    let reads = 0
    const tools = new Map<string, BoundTool>([
      ['bash', async () => ({ kind: 'background', jobId: 'job-1', cwd: '/' })],
      ['job_output', async () => { reads += 1; await sleep(50); return { text: '', job: { id: 'job-1', kind: 'bash', label: 'x', status: 'running', startedAt: 1 } } }],
    ])
    const started = Date.now()
    const text = message(await s.runCell('j = await bash.start("make", "build")\nawait j', tools))
    assert.ok(Date.now() - started < 5_000, 'the cell did not wait out a long job')
    assert.match(text, /JobStillRunning: bash job job-1 still running after 0\.4s; it keeps running\. DSH wakes you when it finishes/)
    assert.ok(reads >= 1)
  })

  it('never asks DSH for a zero wait when a job_output wait returns a hair early', async () => {
    // Field case 2026-11-04: the last wait rounded down to 0 ms and DSH refused it, failing `await r` with a ToolCallError.
    const s = session(300)
    const waits: number[] = []
    const tools = new Map<string, BoundTool>([
      ['bash', async () => ({ kind: 'background', jobId: 'job-2', cwd: '/' })],
      ['job_output', async (args) => {
        const ms = (args as { timeout_ms: number }).timeout_ms
        waits.push(ms)
        await sleep(Math.max(0, ms - 3))
        return { text: '', job: { id: 'job-2', kind: 'bash', label: 'x', status: 'running', startedAt: 1 } }
      }],
    ])
    const text = message(await s.runCell('j = await bash("make", "build", run_in_background=True)\nawait j', tools))
    assert.match(text, /JobStillRunning: bash job job-2 still running after 0\.3s/)
    assert.ok(waits.length >= 1 && waits.every((ms) => ms >= 1), `waits: ${waits.join(', ')}`)
  })

  it('caps bash only where DSH moves a timed-out command to the background, and caps job_output waits', async () => {
    const seen: unknown[] = []
    const fn: BoundTool = async (args) => { seen.push(args); return null }
    const promoting = { name: 'bash', parameters: { properties: { timeoutMs: { description: 'on expiry the command moves to the background as a job instead of being killed.' } } } }
    const killing = { name: 'bash', parameters: { properties: { timeoutMs: { description: 'kills the command on expiry.' } } } }
    await withWaitCap('bash', fn, promoting as never, 5000)({ command: 'x', description: 'd' })
    await withWaitCap('bash', fn, promoting as never, 5000)({ command: 'x', description: 'd', timeoutMs: 2000 })
    await withWaitCap('bash', fn, promoting as never, 5000)({ command: 'x', description: 'd', run_in_background: true })
    await withWaitCap('bash', fn, killing as never, 5000)({ command: 'x', description: 'd' })
    await withWaitCap('job_output', fn, undefined, 5000)({ job_id: 'j', wait: true, timeout_ms: 600000 })
    await withWaitCap('job_output', fn, undefined, 5000)({ job_id: 'j' })
    await withWaitCap('bash', fn, promoting as never, 0)({ command: 'x', description: 'd' })
    assert.deepEqual(seen, [
      { command: 'x', description: 'd', timeoutMs: 5000 },
      { command: 'x', description: 'd', timeoutMs: 2000 },
      { command: 'x', description: 'd', run_in_background: true },
      { command: 'x', description: 'd' },
      { job_id: 'j', wait: true, timeout_ms: 5000 },
      { job_id: 'j' },
      { command: 'x', description: 'd' },
    ])
  })
})

describe('cell-end notes from the trace', () => {
  const call = (n: number, tool: string, start: number, end: number | undefined, extra: Partial<TracedCall> = {}): TracedCall =>
    ({ n, tool, preview: '', status: 'ok', startedAt: start, ...(end === undefined ? {} : { endedAt: end }), background: false, ...extra })

  it('bash calls issued together get no note: they run as jobs side by side (src/bash-jobs.ts)', () => {
    assert.deepEqual(traceNotes({ calls: [call(1, 'bash', 0, 100), call(2, 'bash', 0, 200)], startedAt: 0, endedAt: 200 }), [])
  })

  it('counts Python time with tool waits taken out, and notes a long one', () => {
    assert.equal(pythonMs({ calls: [call(1, 'ask_user_question', 1000, 90_000)], startedAt: 0, endedAt: 91_000 }), 2000)
    assert.equal(pythonMs({ calls: [call(1, 'a', 0, 50), call(2, 'b', 25, 75)], startedAt: 0, endedAt: 100 }), 25)
    assert.deepEqual(traceNotes({ calls: [call(1, 'ask_user_question', 1000, 90_000)], startedAt: 0, endedAt: 91_000 }), [])
    assert.match(traceNotes({ calls: [], startedAt: 0, endedAt: 75_000 })[0]!, /spent 75s in Python itself \(tool waits not counted\)/)
  })

  it('a long report lists the last ten and summarises the rest', () => {
    const calls = Array.from({ length: 14 }, (_, i) => call(i + 1, 'read', 0, 1))
    calls[13]!.status = 'error'
    const text = callsReport(calls)
    assert.match(text, /\(14\):\n  #1-#4: 4 ok \(not listed\)\n  #5 read: ok/)
    assert.match(text, /#14 read: failed\nLast call that succeeded: #13 read\./)
    assert.equal(callsReport([]), '')
  })
})
