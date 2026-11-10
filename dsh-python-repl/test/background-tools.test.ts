/**
 * `repl.background` work calling DSH tools after its cell ends
 * (src/background-tools.ts): through DSH's public pipeline, with the cell's
 * tool names only, until the job ends, is stopped, or its kernel goes away.
 */
import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolsService, { defineTool } from '@deepseek-ai/dsh-tools'
import { BackgroundGrant, loadPipeline, sharedPipeline, ToolLane, type PipelineLike } from '../src/background-tools.ts'
import { JobNotices, NOTICE_WINDOW_MS, type JobView, type JobsService } from '../src/bash-jobs.ts'
import { ReplSession } from '../src/session.ts'
import type { BoundTool } from '../src/lease.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function realTools(): Promise<{ app: Context; pipeline: PipelineLike; seen: string[] }> {
  const app = new Context()
  await app.plugin(SystemPrompt as never, {} as never)
  await app.plugin(ToolsService as never, {} as never)
  await new Promise<void>((resolve) => setImmediate(resolve))
  const seen: string[] = []
  ;(app as any).get('tools').register(defineTool({
    name: 'probe', description: 'probe', parameters: { x: { type: 'string', required: true } },
    output: { schema: { type: 'string' }, render: (_a: unknown, v: string) => [{ type: 'text', text: v }] },
    async execute(args: { x: string }, exec: { signal: AbortSignal }) {
      seen.push(`body:${args.x}`)
      if (args.x === 'slow') await new Promise((resolve) => exec.signal.addEventListener('abort', resolve, { once: true }))
      return `ok:${args.x}`
    },
  }) as never)
  ;(app as any).on('tools/pre-execute', (exec: any, next: any) => {
    seen.push(`pre:${exec.arguments.x}`)
    return exec.arguments.x === 'deny' ? Promise.resolve({ kind: 'deny', reason: 'policy said no' }) : next()
  })
  ;(app as any).get('tools').guard((exec: any) => exec.arguments.x === 'guarded' ? 'guard said no' : undefined)
  ;(app as any).on('tools/result', (exec: any, result: any) => { seen.push(`result:${exec.arguments.x}:${result.isError}`) })
  // As the runtime gets it: a plugin context that declared `tools`.
  let scoped: Context | undefined
  await app.plugin({ name: 'probe-consumer', apply: (ctx: Context) => { ctx.inject(['tools' as never], (s) => { scoped = s }) } } as never, {} as never)
  await new Promise<void>((resolve) => setImmediate(resolve))
  const pipeline = await loadPipeline(scoped)
  assert.ok(pipeline !== undefined, 'dsh-tools exports its pipeline')
  return { app, pipeline, seen }
}

describe('DSH public pipeline, as background grants use it', () => {
  it('runs policy, guards, the body and result observers outside a model step', async () => {
    const { pipeline, seen } = await realTools()
    const grant = new BackgroundGrant({ jobId: 'python-1', runId: 'cell-1-1', epoch: 1, agent: undefined, names: new Set(['probe']), pipeline: Promise.resolve(pipeline), lane: new ToolLane() })
    assert.deepEqual(await grant.dispatch('probe', { x: 'a' }), { status: 'ok', result: 'ok:a' })
    assert.match((await grant.dispatch('probe', { x: 'deny' }) as { error: string }).error, /policy said no/)
    assert.match((await grant.dispatch('probe', { x: 'guarded' }) as { error: string }).error, /guard said no/)
    assert.deepEqual(seen, ['pre:a', 'body:a', 'result:a:false', 'pre:deny', 'result:deny:true', 'pre:guarded', 'result:guarded:true'])
  })

  it('refuses names the cell did not have, and everything once revoked; a call in flight is cancelled', async () => {
    const { pipeline, seen } = await realTools()
    const grant = new BackgroundGrant({ jobId: 'python-2', runId: 'cell-1-1', epoch: 1, agent: undefined, names: new Set(['probe']), pipeline: Promise.resolve(pipeline), lane: new ToolLane() })
    assert.match((await grant.dispatch('bash', { command: 'ls' }) as { error: string }).error, /was not available to the cell/)
    const slow = grant.dispatch('probe', { x: 'slow' })
    await sleep(50)
    grant.revoke('was stopped')
    const reply = await slow
    assert.equal(reply.status, 'error')
    assert.equal((reply as { cancelled?: true }).cancelled, true)
    assert.match((await grant.dispatch('probe', { x: 'b' }) as { error: string }).error, /python-2 was stopped; its tool access ended with it/)
    assert.ok(!seen.includes('body:b'))
  })

  it('without a tool registry, calls are refused with the reason', async () => {
    const grant = new BackgroundGrant({ jobId: 'python-3', runId: 'cell-1-1', epoch: 1, agent: undefined, names: new Set(['probe']), pipeline: Promise.resolve(undefined), lane: new ToolLane() })
    assert.match((await grant.dispatch('probe', { x: 'a' }) as { error: string }).error, /no tool registry loaded/)
  })

  it('exclusive calls run one at a time; parallel ones overlap', async () => {
    const lane = new ToolLane()
    let active = 0
    let peak = 0
    const work = (ms: number) => async () => { active += 1; peak = Math.max(peak, active); await sleep(ms); active -= 1 }
    await Promise.all([lane.run(true, work(30)), lane.run(true, work(30)), lane.run(true, work(30))])
    assert.equal(peak, 1)
    peak = 0
    await Promise.all([lane.run(false, work(30)), lane.run(false, work(30))])
    assert.equal(peak, 2)
  })
})

describe('pipeline loading and extra contexts', () => {
  it('any failure to load the pipeline rejects with the reason', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ERR_MODULE_NOT_FOUND' })
    await assert.rejects(loadPipeline({}, async () => { throw missing }), /could not load.*missing/)
    await assert.rejects(loadPipeline({}, async () => { throw new Error('broken') }), /could not load.*broken/)
    await assert.rejects(loadPipeline({}, async () => ({})), /does not export ToolExecutionPipeline/)
  })

  it('a failed shared load nobody awaits is reported, not left as an unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      const reported: unknown[] = []
      const pending = sharedPipeline({}, (error) => reported.push(error), async () => { throw new Error('broken') })
      await sleep(20)
      assert.equal(unhandled.length, 0)
      assert.equal(reported.length, 1)
      await assert.rejects(pending, /could not load.*broken/, 'a grant that awaits it still gets the error')
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('keeps additional contexts from a tool result', async () => {
    const contexts = [{ type: 'text', text: 'context' }]
    const pipeline: PipelineLike = {
      executionMode: () => ({ kind: 'exclusive' }),
      prepare: async () => ({ kind: 'dispatch', exec: {} }),
      dispatch: async () => ({ kind: 'post-result', result: { isError: false, value: 'ok', additionalContexts: contexts } }),
      complete: async (_exec: unknown, outcome: unknown) => (outcome as { result: never }).result,
    }
    const grant = new BackgroundGrant({ jobId: 'python-ctx', runId: 'cell-1-1', epoch: 1, agent: undefined, names: new Set(['probe']), pipeline: Promise.resolve(pipeline), lane: new ToolLane() })
    assert.deepEqual(await grant.dispatch('probe', {}), { status: 'ok', result: 'ok' })
    assert.deepEqual(grant.takeContexts(), contexts)
  })
})

/** Records what reaches DSH; `slow` waits for the call's cancellation. */
class FakePipeline implements PipelineLike {
  calls: Array<{ name: string; callId: string; agent: unknown; args: unknown }> = []
  executionMode() { return { kind: 'exclusive' } }
  async prepare(input: any) { return { kind: 'dispatch', exec: input } }
  async dispatch(exec: any) {
    this.calls.push({ name: exec.name, callId: exec.callId, agent: exec.agent, args: exec.arguments })
    if (exec.name === 'read_image') {
      return { kind: 'post-result', result: { isError: false, value: { path: exec.arguments.file_path }, content: [{ type: 'text', text: 'image' }, { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }] } }
    }
    if (exec.name === 'late') {
      await sleep(400)
      return { kind: 'post-result', result: { isError: false, value: { via: 'grant' } } }
    }
    if (exec.name === 'slow') {
      await new Promise((resolve) => exec.signal.addEventListener('abort', resolve, { once: true }))
      return { kind: 'post-result', result: { isError: true, error: { message: 'tool call aborted', info: { name: 'AbortError', code: 'ABORTED' } } } }
    }
    return { kind: 'post-result', result: { isError: false, value: exec.name === 'read' ? { path: exec.arguments.file_path, offset: 1, lines: [{ number: 1, text: 'hi' }], totalLines: 1 } : { kind: 'foreground', exitCode: 0, stdout: { text: 'out\n', truncated: false }, stderr: { text: '', truncated: false } }, ...(exec.name === 'read' ? { additionalContexts: [{ type: 'text', text: 'CONTEXT' }] } : {}) } }
  }
  async complete(_exec: unknown, outcome: any) { return outcome.result }
}

/** DSH's job rules that matter here: wait resolves when the job settles or the timeout passes. */
class Jobs implements JobsService {
  jobs = new Map<string, { view: JobView; text: string; settled: Promise<void> }>()
  cancels = new Map<string, (reason?: string) => void>()
  progress = new Map<string, string[]>()
  n = 0
  start(spec: Parameters<JobsService['start']>[0]): string {
    const id = `${spec.kind}-${++this.n}`
    const job = { view: { id, label: spec.label, status: 'running' } as JobView, text: '', settled: Promise.resolve() }
    this.jobs.set(id, job)
    const progress: string[] = []
    this.progress.set(id, progress)
    const hooks = spec.run({ id, append: (text) => { job.text += text }, updateProgress: (line: string) => { progress.push(line); job.view = { ...job.view, detail: line } } })
    this.cancels.set(id, hooks.cancel)
    job.settled = hooks.done.then((outcome) => { job.view = { ...job.view, status: outcome.status, ...(outcome.detail === undefined ? {} : { detail: outcome.detail }) } })
    return id
  }
  async wait(id: string, timeoutMs: number): Promise<JobView> {
    const job = this.jobs.get(id)!
    let timer: NodeJS.Timeout | undefined
    await Promise.race([job.settled, new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref() })])
    clearTimeout(timer)
    return job.view
  }
  read() { return { chunks: [], lossy: false, job: { id: '', status: '' } } as never }
  remove() {}
  kill() {}
  list() { return [] }
}

describe('repl.background work calling tools on a real kernel', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const pipeline = new FakePipeline()
  const agent = { id: 'agent-1' }
  const session = new ReplSession({ python: process.env['DSH_PY'] ?? 'python3', vendorRoot: join(root, 'vendor', 'prime'), pythonRoot: join(root, 'python'), cellWaitMs: 300, backgroundPipeline: async () => pipeline })
  after(() => session.dispose())
  const jobs = new Jobs()
  const sent: Array<{ text: string; images: readonly unknown[]; contexts: readonly unknown[]; quiet: boolean }> = []
  const notices = new JobNotices(() => jobs as never, { deliver: (_owner, text, _summary, extras) => { sent.push({ text, images: extras?.images ?? [], contexts: extras?.contexts ?? [], quiet: extras?.quiet === true }) } })
  const host = { jobs: jobs as never, owner: 'agent-1', notices, agent }
  const cellTools = () => new Map<string, BoundTool>([
    ['read', async () => { throw new Error('the cell binding must not be used after the cell') }],
    ['bash', async () => { throw new Error('the cell binding must not be used after the cell') }],
    ['slow', async () => null],
    ['late', async () => { await sleep(400); return { via: 'cell' } }],
    ['read_image', async () => { throw new Error('the cell binding must not be used after the cell') }],
    ['job_output', async () => ({ text: '', job: { id: 'x', status: 'completed' } })],
  ])
  const run = (code: string, tools = cellTools()) => session.runCell(code, tools, undefined, [], undefined, host)
  const text = (cell: { logs: string[]; error?: { message: string } }) => [...cell.logs, cell.error?.message ?? ''].join('\n')
  const lastJob = () => [...jobs.jobs.keys()].filter((k) => k.startsWith('python-')).at(-1)!

  it('calls bash and read after its cell ended, in the agent scope, and the job lists them', async () => {
    const cell = await run('import asyncio\nasync def later():\n    await asyncio.sleep(0.4)\n    r = await read("/tmp/a.txt")\n    b = await bash("echo out", "say out")\n    return (r["lines"][0]["text"], b["stdout"]["text"])\njob = await repl.background(later(), label="later")')
    assert.equal(cell.error, undefined, text(cell))
    await sleep(1_200)
    const id = lastJob()
    const job = jobs.jobs.get(id)!
    assert.equal(job.view.status, 'completed', job.text)
    assert.match(job.text, /\[tool\] read ok\n\[tool\] bash ok\n/)
    assert.match(job.text, /\('hi', 'out\\n'\)/)
    assert.deepEqual(pipeline.calls.map((c) => [c.name, c.agent, c.callId]), [['read', agent, `python-repl:${id}:1`], ['bash', agent, `python-repl:${id}:2`]])
    assert.deepEqual(pipeline.calls[0]!.args, { file_path: '/tmp/a.txt' })
    await sleep(NOTICE_WINDOW_MS + 300)
    const notice = sent.find((n) => n.text.includes(id))!
    assert.deepEqual(notice.contexts, [{ type: 'text', text: 'CONTEXT' }])
  })

  it('a tool the cell did not have is refused; after the job ends a leftover task is refused', async () => {
    pipeline.calls = []
    const code = [
      'import asyncio, dsh_kernel',
      'left = {}',
      'async def leftover():',
      '    await asyncio.sleep(0.6)',
      '    try:',
      '        await read("/tmp/late.txt")',
      '    except Exception as e:',
      '        left["after"] = str(e)',
      'async def work():',
      '    await asyncio.sleep(0.2)',
      '    try:',
      '        await dsh_kernel.call_tool("web_search", {"queries": ["x"]})',
      '    except Exception as e:',
      '        left["missing"] = str(e)',
      '    asyncio.get_running_loop().create_task(leftover())',
      '    return "done"',
      'j2 = await repl.background(work(), label="ends early")',
    ].join('\n')
    const cell = await run(code)
    assert.equal(cell.error, undefined, text(cell))
    await sleep(1_400)
    const out = text(await run('left'))
    assert.match(out, /'missing': 'tool "web_search" was not available to the cell that started background job python-\d+'/)
    assert.match(out, /'after': 'background job python-\d+ is no longer running; its tool access ended with it'/)
    assert.equal(pipeline.calls.length, 0, 'neither refused call reached DSH')
  })

  it('a call the job starts while its cell still runs and that returns after the cell ended still reaches the job', async () => {
    // Field case 2026-11-06 (evolve I-074): repl.background(tools.doctor({})) was dispatched before its cell
    // settled; the cell's end dropped the pending reply and the job stayed "running" with nothing left to wait for.
    pipeline.calls = []
    const cell = await run('import asyncio\njl = await repl.background(tools.late({}), label="late")\nawait asyncio.sleep(0.15)')
    assert.equal(cell.error, undefined, text(cell))
    const id = lastJob()
    await sleep(900)
    const job = jobs.jobs.get(id)!
    assert.equal(job.view.status, 'completed', job.text)
    assert.match(job.text, /\[tool\] late ok\n/)
    assert.match(job.text, /'via': 'grant'/)
    assert.deepEqual(pipeline.calls.map((c) => c.name), ['late'])
  })

  it('job_kill revokes the grant: the call in flight is cancelled and reaches Python as CancelledError', async () => {
    pipeline.calls = []
    const cell = await run('import asyncio\nseen = {}\nasync def hang():\n    await asyncio.sleep(0.2)\n    try:\n        await tools.slow({})\n    except asyncio.CancelledError:\n        seen["cancelled"] = True\n        raise\n    except Exception as e:\n        seen["error"] = repr(e)\nj3 = await repl.background(hang(), label="hang")')
    assert.equal(cell.error, undefined, text(cell))
    await sleep(500)
    assert.equal(pipeline.calls.at(-1)?.name, 'slow', 'the call went through the grant, not the cell')
    const id = lastJob()
    jobs.cancels.get(id)!('killed by test')
    await sleep(800)
    assert.equal(jobs.jobs.get(id)!.view.status, 'killed')
    assert.match(text(await run('seen')), /'cancelled': True/)
  })
  it('repl.progress shows the latest step in the job status and keeps every step in its output', async () => {
    {
      const cell = await run([
        'import asyncio',
        'async def work():',
        '    repl.progress("step A")',
        '    repl.progress("step B")',
        '    await asyncio.sleep(0.3)',
        '    return "ok"',
        'j6 = await repl.background(work(), label="progress")',
      ].join('\n'))
      assert.equal(cell.error, undefined, text(cell))
      await sleep(120)
      const id = lastJob()
      assert.deepEqual(jobs.progress.get(id), ['step A', 'step B'])
      assert.equal(jobs.jobs.get(id)!.view.detail, 'step B', 'DSH shows only the latest step')
      // Field case 2026-11-05: with the status line alone, earlier steps were gone from job_output.
      assert.match(jobs.jobs.get(id)!.text, /\[progress\] step A\n\[progress\] step B\n/)
      await sleep(400)
    }
  })

  it('repl.progress adds lines to the job output from a coroutine and from a thread; in a cell it says to print', async () => {
    const code = [
      'import asyncio, time',
      'async def steps():',
      '    for i in range(3):',
      '        repl.progress(f"step {i + 1} of 3")',
      '        await asyncio.sleep(0.05)',
      '    await repl.progress("awaited works too")',
      '    return "ok"',
      'def threaded():',
      '    repl.progress("from a thread")',
      '    time.sleep(0.1)',
      '    return 1',
      'p1 = await repl.background(steps(), label="steps")',
      'p2 = await repl.background(threaded, label="thread")',
    ].join('\n')
    const cell = await run(code)
    assert.equal(cell.error, undefined, text(cell))
    await sleep(800)
    const ids = [...jobs.jobs.keys()].filter((k) => k.startsWith('python-')).slice(-2)
    assert.match(jobs.jobs.get(ids[0]!)!.text, /\[progress\] step 1 of 3\n\[progress\] step 2 of 3\n\[progress\] step 3 of 3\n\[progress\] awaited works too\n/)
    assert.match(jobs.jobs.get(ids[1]!)!.text, /\[progress\] from a thread\n/)
    assert.match(text(await run('repl.progress("x")')), /RuntimeError: repl\.progress\(\) reports from inside repl\.background work; in a cell, print instead/)
  })

  it("images from tool calls after the cell come back with the job's end notice", async () => {
    sent.length = 0
    const cell = await run('import asyncio\nasync def shot():\n    await asyncio.sleep(0.3)\n    await tools.read_image(file_path="/tmp/a.png")\n    return "done"\nj4 = await repl.background(shot(), label="shot")')
    assert.equal(cell.error, undefined, text(cell))
    await sleep(800 + NOTICE_WINDOW_MS + 300)
    const id = lastJob()
    const notice = sent.find((n) => n.text.includes(id))!
    assert.ok(notice, JSON.stringify(sent))
    assert.equal(notice.quiet, false)
    assert.deepEqual(notice.images, [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }])
    assert.match(notice.text, new RegExp(`Images from ${id}'s tool calls after its cell ended: 1`))
  })

  it('a job the model already collected sends its images alone, without waking the agent', async () => {
    sent.length = 0
    const cell = await run('import asyncio\nasync def shot2():\n    await asyncio.sleep(0.3)\n    await tools.read_image(file_path="/tmp/b.png")\nj5 = await repl.background(shot2(), label="shot2")')
    assert.equal(cell.error, undefined, text(cell))
    const id = lastJob()
    notices.collected(id)
    await sleep(800 + NOTICE_WINDOW_MS + 300)
    assert.equal(sent.length, 1, JSON.stringify(sent))
    assert.equal(sent[0]!.quiet, true)
    assert.equal(sent[0]!.images.length, 1)
    assert.doesNotMatch(sent[0]!.text, /finished/)
  })
})

