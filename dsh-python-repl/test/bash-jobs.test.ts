/**
 * bash as DSH jobs (src/bash-jobs.ts): same result shape, side by side when
 * gathered, stopped with a cancelled cell, and one notice for jobs that end
 * together. The job service is a fake with DSH's wait/read/remove/kill rules.
 */
import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { JobNotices, NOTICE_WINDOW_MS, foregroundResult, withJobBash, type JobView, type JobsService } from '../src/bash-jobs.ts'
import { ReplSession } from '../src/session.ts'
import type { BoundTool } from '../src/lease.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const SCHEMA = { name: 'bash', parameters: { properties: { command: {}, description: {}, timeoutMs: {}, run_in_background: {} } } } as never

/** Jobs that end after `ms`, writing `out`/`err`; waits resolve at settlement or timeout, like dsh-jobs-local. */
class FakeJobs implements JobsService {
  jobs = new Map<string, { view: JobView; chunks: Array<{ channel: string; text: string }>; waiters: Array<() => void>; removed: boolean }>()
  n = 0
  start(spec: Parameters<JobsService['start']>[0]): string {
    const id = `${spec.kind}-${++this.n}`
    const job = { view: { id, label: spec.label, status: 'running' } as JobView, chunks: [] as Array<{ channel: string; text: string }>, waiters: [] as Array<() => void>, removed: false }
    this.jobs.set(id, job)
    const hooks = spec.run({ id, append: (text) => job.chunks.push({ channel: 'stdout', text }), updateProgress: () => undefined })
    this.cancels.set(id, hooks.cancel)
    void hooks.done.then((outcome) => {
      job.view = { ...job.view, status: outcome.status, ...(outcome.detail === undefined ? {} : { detail: outcome.detail }) }
      for (const w of job.waiters.splice(0)) w()
    })
    return id
  }
  cancels = new Map<string, (reason?: string) => void>()
  spawn(command: string, ms: number, out = '', err = '', code = 0): string {
    const id = `bash-${++this.n}`
    const job = { view: { id, label: command, status: 'running' } as JobView, chunks: [] as Array<{ channel: string; text: string }>, waiters: [] as Array<() => void>, removed: false }
    this.jobs.set(id, job)
    setTimeout(() => this.settle(id, out, err, `exit code: ${code}`, 'completed'), ms)
    return id
  }
  settle(id: string, out: string, err: string, detail: string, status: string): void {
    const job = this.jobs.get(id)!
    if (job.view.status !== 'running') return
    if (out) job.chunks.push({ channel: 'stdout', text: out })
    if (err) job.chunks.push({ channel: 'stderr', text: err })
    job.view = { ...job.view, status, detail }
    for (const w of job.waiters.splice(0)) w()
  }
  async wait(id: string, timeoutMs: number, _caller: string, signal?: AbortSignal): Promise<JobView> {
    const job = this.jobs.get(id)
    if (job === undefined) throw new Error('unknown job')
    if (job.view.status !== 'running') return job.view
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, timeoutMs)
      job.waiters.push(() => { clearTimeout(timer); resolve() })
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
    })
    return job.view
  }
  read(id: string) { const job = this.jobs.get(id)!; return { chunks: job.chunks.splice(0), lossy: false, job: job.view } }
  remove(id: string) { this.jobs.get(id)!.removed = true }
  kill(id: string) { this.settle(id, '', '', 'signal: SIGTERM', 'killed') }
  list(_caller: string): JobView[] { return [...this.jobs.values()].map((job) => job.view) }
}

function harness(cap = 300) {
  const jobs = new FakeJobs()
  const sent: Array<{ owner: string; text: string }> = []
  const notices = new JobNotices(() => jobs, { deliver: (owner, text) => sent.push({ owner, text }) })
  const durations: Record<string, number> = { fast: 20, slow: 1_000, mid: 150 }
  const fn: BoundTool = async (args) => {
    const a = args as { command: string; run_in_background?: boolean }
    assert.equal(a.run_in_background, true, 'every call reaches DSH as a background start')
    return { kind: 'background', jobId: jobs.spawn(a.command, durations[a.command] ?? 20, `${a.command} out\n`, a.command === 'fast' ? '' : 'warn\n'), cwd: '/w' }
  }
  const fallback: BoundTool = async () => { throw new Error('fallback used') }
  return { jobs, sent, notices, bash: (signal?: AbortSignal) => withJobBash(fn, SCHEMA, cap, { jobs, owner: 'agent-1', notices }, signal, fallback) }
}

describe('bash runs as a job the cell waits on', () => {
  it('a finished command has the foreground shape and leaves the panel', async () => {
    const h = harness()
    const r = await h.bash()({ command: 'fast', description: 'd' }) as Record<string, any>
    assert.equal(r['kind'], 'foreground')
    assert.equal(r['exitCode'], 0)
    assert.deepEqual(r['stdout'], { text: 'fast out\n', truncated: false })
    assert.deepEqual(r['stderr'], { text: '', truncated: false })
    assert.equal(h.jobs.jobs.get('bash-1')!.removed, true)
  })

  it('gathered commands run side by side', async () => {
    const h = harness(2_000)
    const started = Date.now()
    await Promise.all([h.bash()({ command: 'mid', description: 'a' }), h.bash()({ command: 'mid', description: 'b' }), h.bash()({ command: 'mid', description: 'c' })])
    assert.ok(Date.now() - started < 400, `took ${Date.now() - started} ms`)
  })

  it('past the cap it hands back a promoted receipt and announces the end once', async () => {
    const h = harness(100)
    const r = await h.bash()({ command: 'slow', description: 'd' }) as Record<string, any>
    assert.equal(r['kind'], 'promoted')
    assert.equal(r['jobId'], 'bash-1')
    assert.equal(h.jobs.jobs.get('bash-1')!.removed, false, 'the model holds the id now')
    await sleep(1_000 + NOTICE_WINDOW_MS + 300)
    assert.equal(h.sent.length, 1)
    assert.match(h.sent[0]!.text, /^A background job finished:\n- bash-1 \(slow\): completed, exit code: 0/)
  })

  it('jobs ending close together share one notice; a collected one is left out', async () => {
    const h = harness(50)
    const a = await h.bash()({ command: 'slow', description: 'a' }) as Record<string, any>
    const b = await h.bash()({ command: 'slow', description: 'b' }) as Record<string, any>
    const c = await h.bash()({ command: 'slow', description: 'c' }) as Record<string, any>
    await sleep(1_100)
    h.notices.collected(b['jobId'])
    await sleep(NOTICE_WINDOW_MS + 200)
    assert.equal(h.sent.length, 1)
    assert.match(h.sent[0]!.text, /^2 background jobs finished:/)
    assert.match(h.sent[0]!.text, new RegExp(a['jobId']))
    assert.doesNotMatch(h.sent[0]!.text, new RegExp(`${b['jobId']} `))
    assert.match(h.sent[0]!.text, new RegExp(c['jobId']))
  })

  it('a cancelled cell stops the command and raises a cancellation', async () => {
    const h = harness(5_000)
    const controller = new AbortController()
    const pending = h.bash(controller.signal)({ command: 'slow', description: 'd' })
    await sleep(50)
    controller.abort()
    await assert.rejects(pending, (error: Error) => error.name === 'AbortError')
    assert.equal(h.jobs.jobs.get('bash-1')!.view.status, 'killed')
    assert.equal(h.jobs.jobs.get('bash-1')!.removed, true)
  })

  it('a wait that fails without a cancellation stays an ordinary tool error', async () => {
    const h = harness(5_000)
    h.jobs.wait = async () => { throw new Error('unknown job bash-1') }
    await assert.rejects(h.bash()({ command: 'slow', description: 'd' }), (error: Error) => error.name !== 'AbortError' && /unknown job/.test(error.message))
  })

  /** DSH's refusal at its per-owner cap, verbatim (dsh-jobs-local JOB_LIMIT_REACHED). */
  const refusal = (limit: number) => new Error(`background job limit reached for this owner (limit: ${limit}); use job_kill to stop an unneeded job, wait for it to finish, then retry`)
  function capped(limit: number, ms: number, cap: number) {
    const h = harness(cap)
    const fn: BoundTool = async (args) => {
      const a = args as { command: string }
      if ([...h.jobs.jobs.values()].filter((j) => j.view.status === 'running').length >= limit) throw refusal(limit)
      return { kind: 'background', jobId: h.jobs.spawn(a.command, ms, `${a.command} out\n`), cwd: '/w' }
    }
    return { ...h, bash: () => withJobBash(fn, SCHEMA, cap, { jobs: h.jobs, owner: 'agent-1', notices: h.notices }, undefined, async () => { throw new Error('fallback used') }) }
  }

  it('a gather larger than the job cap waits for slots instead of being refused', async () => {
    // Field shape 2026-11-05..11: a dozen commands gathered in one cell, the 11th and later refused at DSH's cap of 10.
    const h = capped(2, 100, 2_000)
    const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((c) => h.bash()({ command: c, description: c }))) as Array<Record<string, any>>
    assert.deepEqual(results.map((r) => [r['kind'], r['exitCode'], r['stdout'].text]), ['a', 'b', 'c', 'd', 'e'].map((c) => ['foreground', 0, `${c} out\n`]))
  })

  it('still refused when no slot frees within the cell wait', async () => {
    const h = capped(1, 5_000, 200)
    const first = h.bash()({ command: 'long', description: 'a' })
    const started = Date.now()
    await assert.rejects(h.bash()({ command: 'other', description: 'b' }), /background job limit reached.*limit: 1/)
    assert.ok(Date.now() - started >= 150, 'it waited for a slot first')
    assert.equal((await first as Record<string, any>)['kind'], 'promoted')
  })

  it('without a job list the refusal passes straight through', async () => {
    const h = capped(1, 5_000, 2_000)
    Object.defineProperty(h.jobs, 'list', { value: undefined })
    void h.bash()({ command: 'long', description: 'a' })
    const started = Date.now()
    await assert.rejects(h.bash()({ command: 'other', description: 'b' }), /background job limit reached/)
    assert.ok(Date.now() - started < 100)
  })

  it('reports a signal, and keeps DSH notes after the exit code', () => {
    const read = { chunks: [{ channel: 'stdout', text: 'x' }], lossy: true, job: { id: 'j', status: 'completed' } }
    const r = foregroundResult({ id: 'j', status: 'completed', detail: 'exit code: 1; sandbox denied a write', output: { spillPaths: ['/s'] } }, read, '/w', 5000)
    assert.equal(r['exitCode'], 1)
    assert.deepEqual(r['stdout'], { text: 'x', truncated: true, spillPath: '/s' })
    assert.match((r['stderr'] as { text: string }).text, /\[sandbox denied a write\]/)
  })
})

describe('a still-running bash result in the kernel', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const session = new ReplSession({ python: process.env['DSH_PY'] ?? 'python3', vendorRoot: join(root, 'vendor', 'prime'), pythonRoot: join(root, 'python'), cellWaitMs: 400 })
  after(() => session.dispose())

  it('is awaitable and gives stdout and stderr like a finished call', async () => {
    let reads = 0
    const tools = new Map<string, BoundTool>([
      ['bash', async () => ({ kind: 'promoted', cwd: '/w', jobId: 'job-9', timeoutMs: 400, output: 'early\n' })],
      ['job_output', async () => { reads += 1; return reads < 2
        ? { text: '', job: { id: 'job-9', kind: 'bash', label: 'x', status: 'running', startedAt: 1 } }
        : { text: 'late\n[stderr]\noops\n', job: { id: 'job-9', kind: 'bash', label: 'x', status: 'completed', detail: 'exit code: 3', startedAt: 1 } } }],
    ])
    const cell = await session.runCell('r = await bash("make", "build")\nfirst = r["kind"]\ndone = await r\n(first, done["exitCode"], done["stdout"]["text"], done["stderr"]["text"])', tools)
    assert.equal(cell.error, undefined, JSON.stringify(cell))
    assert.match(cell.logs.join('\n'), /\('promoted', 3, 'early\\nlate\\n', 'oops\\n'\)/)
  })
})


describe('repl.background on a real kernel', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const session = new ReplSession({ python: process.env['DSH_PY'] ?? 'python3', vendorRoot: join(root, 'vendor', 'prime'), pythonRoot: join(root, 'python'), cellWaitMs: 300 })
  after(() => session.dispose())
  const jobs = new FakeJobs()
  const sent: string[] = []
  const notices = new JobNotices(() => jobs, { deliver: (_owner, text) => sent.push(text) })
  const host = { jobs, owner: 'agent-1', notices }
  const run = (code: string, tools = new Map<string, BoundTool>()) => session.runCell(code, tools, undefined, [], undefined, host)
  const text = (cell: { logs: string[]; error?: { message: string } }) => [...cell.logs, cell.error?.message ?? ''].join('\n')

  it('the cell ends at once; the job ends with the value, one notice, and await gives the value', async () => {
    const started = Date.now()
    const cell = await run('import asyncio\nasync def work():\n    await asyncio.sleep(1)\n    return {"rows": 3}\njob = await repl.background(work(), label="crunch")\njob.id')
    assert.equal(cell.error, undefined, text(cell))
    assert.ok(Date.now() - started < 900, `cell took ${Date.now() - started} ms`)
    const id = [...jobs.jobs.keys()].find((k) => k.startsWith('python-'))!
    assert.equal(jobs.jobs.get(id)!.view.label, 'crunch')
    await sleep(1_300 + NOTICE_WINDOW_MS)
    const job = jobs.jobs.get(id)!
    assert.equal(job.view.status, 'completed')
    assert.match(job.chunks.map((c) => c.text).join(''), /\{'rows': 3\}/)
    assert.equal(sent.length, 1)
    assert.match(sent[0]!, new RegExp(`${id} \\(crunch\\): completed`))
    assert.match(text(await run('(await job)["rows"]')), /\b3\b/)
  })

  it('await before it ends stops at the cell wait; job_kill cancels it', async () => {
    const cell = await run('import asyncio\nslow = await repl.background(asyncio.sleep(60), label="slow")\nawait slow')
    assert.match(text(cell), /JobStillRunning: background job python-\d+ still running after 0\.3s/)
    const id = [...jobs.jobs.keys()].filter((k) => k.startsWith('python-')).at(-1)!
    jobs.cancels.get(id)!('killed by test')
    await sleep(800)
    assert.equal(jobs.jobs.get(id)!.view.status, 'killed')
    assert.match(text(await run('repr(slow)')), /cancelled/)
  })

  it('work that outlives its cell cannot call DSH tools, and the job says so', async () => {
    const tools = new Map<string, BoundTool>([['read', async () => ({ path: '/a', offset: 1, lines: [], totalLines: 0 })]])
    assert.equal((await run('import asyncio\nasync def later():\n    await asyncio.sleep(0.5)\n    return await read("/a")\nlate = await repl.background(later())', tools)).error, undefined)
    await sleep(1_200)
    const id = [...jobs.jobs.keys()].filter((k) => k.startsWith('python-')).at(-1)!
    assert.equal(jobs.jobs.get(id)!.view.status, 'failed')
    assert.match(jobs.jobs.get(id)!.view.detail ?? '', /ToolCallError/)
  })

  it('a function that returns a coroutine fails rather than claiming the work completed', async () => {
    const cell = await run('async def actual_work():\n    return 123\nwrong = await repl.background(lambda: actual_work())\ntry:\n    await wrong\nexcept Exception as e:\n    print(type(e).__name__, str(e))')
    assert.match(text(cell), /TypeError.*returned a coroutine/)
    const id = [...jobs.jobs.keys()].filter((k) => k.startsWith('python-')).at(-1)!
    assert.equal(jobs.jobs.get(id)!.view.status, 'failed')
  })

  it('a plain function runs in a thread and does not hold the kernel', async () => {
    const started = Date.now()
    assert.equal((await run('import time\ndef heavy():\n    time.sleep(1)\n    return 42\nh = await repl.background(heavy)')).error, undefined)
    assert.equal((await run('x = 1 + 1')).error, undefined)
    assert.ok(Date.now() - started < 900, 'the next cell ran while the function was still working')
    await sleep(1_300)
    assert.match(text(await run('await h')), /\b42\b/)
  })
})
