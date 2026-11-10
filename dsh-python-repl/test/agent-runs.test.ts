/**
 * `repl.agent` (src/agent-runs.ts, python/agents.py): start a subagent through
 * DSH's subagent service with the result returned to the caller, wait for it,
 * always dispose it, and stop it when its owning cell or job ends.
 * The subagent service is a stand-in with the real service's start/result/dispose contract.
 */
import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { AgentRuns, type ActivationLike, type SubagentsLike } from '../src/agent-runs.ts'
import { JobNotices, type JobView, type JobsService } from '../src/bash-jobs.ts'
import { ReplSession } from '../src/session.ts'
import type { BoundTool } from '../src/lease.ts'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Prompts drive the outcome: `slow…` waits until disposed, `fail…` ends in error, a schema gets `{ n: <length> }`. */
class FakeSubagents implements SubagentsLike {
  started: Array<{ label: string; prompt: string; parent: unknown; schema?: unknown; options?: unknown; delivery: string; provider: string }> = []
  disposed: string[] = []
  limit = Infinity
  live = 0
  n = 0
  async startActivation(spec: Parameters<SubagentsLike['startActivation']>[0]): Promise<ActivationLike> {
    if (this.live >= this.limit) throw Object.assign(new Error('activation limit reached'), { code: 'ACTIVATION_LIMIT_REACHED' })
    const prompt = ((spec.request['prompt'] as Array<{ text: string }>)[0]!).text
    this.started.push({ label: spec.label, prompt, parent: spec.request['parent'], schema: spec.request['outputSchema'], options: spec.request['agentOptions'], delivery: spec.delivery, provider: spec.provider })
    const childId = `child-${++this.n}`
    this.live += 1
    let finish!: (value: { output: Array<{ type: string; text: string }>; stopReason: string; structured?: unknown }) => void
    const result = new Promise<{ output: Array<{ type: string; text: string }>; stopReason: string; structured?: unknown }>((resolve) => { finish = resolve })
    const slow = prompt.startsWith('slow')
    if (!slow) {
      setTimeout(() => finish(prompt.startsWith('fail')
        ? { output: [], stopReason: 'error' }
        : { output: [{ type: 'text', text: `done: ${prompt}` }], stopReason: 'completed', ...(spec.request['outputSchema'] === undefined ? {} : { structured: { n: prompt.length } }) }),
      prompt.startsWith('wait') ? 200 : 20)
    }
    let disposed = false
    return {
      childId,
      result,
      dispose: async () => {
        if (disposed) return
        disposed = true
        this.disposed.push(childId)
        this.live -= 1
        finish({ output: [], stopReason: 'aborted' })
      },
    }
  }
}

describe('AgentRuns', () => {
  it('returns the text, starts with the caller delivery, and always disposes', async () => {
    const service = new FakeSubagents()
    const runs = new AgentRuns(() => service)
    const outcome = await runs.run('c1', 'cell:1', { parent: { id: 'a' }, prompt: 'hello', label: 'hi', model: 'm', provider: 'p' })
    assert.deepEqual(outcome, { childId: 'child-1', stopReason: 'completed', text: 'done: hello' })
    assert.equal(service.started[0]!.delivery, 'caller')
    assert.equal(service.started[0]!.provider, 'spawn')
    assert.deepEqual(service.started[0]!.options, { provider: 'p', model: 'm' })
    assert.deepEqual(service.disposed, ['child-1'])
    assert.equal(runs.size, 0)
  })

  it('stopping the owner disposes its children and fails their calls as AbortError; other owners are untouched', async () => {
    const service = new FakeSubagents()
    const runs = new AgentRuns(() => service)
    const mine = runs.run('c1', 'job:a', { parent: {}, prompt: 'slow one', label: 'x' })
    const theirs = runs.run('c2', 'job:b', { parent: {}, prompt: 'slow two', label: 'y' })
    await sleep(20)
    await runs.stopOwner('job:a')
    await assert.rejects(mine, (error: Error) => error.name === 'AbortError')
    assert.deepEqual(service.disposed, ['child-1'])
    runs.cancel('c2')
    await assert.rejects(theirs, (error: Error) => error.name === 'AbortError')
    assert.deepEqual(service.disposed, ['child-1', 'child-2'])
  })

  it("past DSH's cap a start waits for one of this session's children, and fails when none is running", async () => {
    const service = new FakeSubagents()
    service.limit = 1
    const runs = new AgentRuns(() => service)
    const started = Date.now()
    const [a, b] = await Promise.all([
      runs.run('c1', 'cell:1', { parent: {}, prompt: 'wait a', label: 'a' }),
      runs.run('c2', 'cell:1', { parent: {}, prompt: 'wait b', label: 'b' }),
    ])
    assert.equal(a.text, 'done: wait a')
    assert.equal(b.text, 'done: wait b')
    assert.ok(Date.now() - started >= 350, 'the second waited for the first')
    service.limit = 0
    await assert.rejects(runs.run('c3', 'cell:1', { parent: {}, prompt: 'x', label: 'x' }), /activation limit reached/)
  })

  it('without a subagent service it says so', async () => {
    await assert.rejects(new AgentRuns(() => undefined).run('c', 'cell:1', { parent: {}, prompt: 'x', label: 'x' }), /no subagent service/)
  })
})

/** DSH's job rules that matter here: wait resolves when the job settles or the timeout passes. */
class Jobs implements JobsService {
  jobs = new Map<string, { view: JobView; text: string; settled: Promise<void> }>()
  cancels = new Map<string, (reason?: string) => void>()
  n = 0
  start(spec: Parameters<JobsService['start']>[0]): string {
    const id = `${spec.kind}-${++this.n}`
    const job = { view: { id, label: spec.label, status: 'running' } as JobView, text: '', settled: Promise.resolve() }
    this.jobs.set(id, job)
    const hooks = spec.run({ id, append: (text) => { job.text += text }, updateProgress: () => undefined })
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

describe('repl.agent on a real kernel', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const service = new FakeSubagents()
  const agent = { id: 'agent-1' }
  const session = new ReplSession({ python: process.env['DSH_PY'] ?? 'python3', vendorRoot: join(root, 'vendor', 'prime'), pythonRoot: join(root, 'python'), cellWaitMs: 300, subagents: () => service })
  after(() => session.dispose())
  const jobs = new Jobs()
  const notices = new JobNotices(() => jobs as never, { deliver: () => undefined })
  const host = { jobs: jobs as never, owner: 'agent-1', notices, agent }
  const withSubagent = () => new Map<string, BoundTool>([['subagent', async () => ({ kind: 'activation', subagentId: 'x' })]])
  const run = (code: string, tools = withSubagent()) => session.runCell(code, tools, undefined, [], undefined, host)
  const text = (cell: { logs: string[]; error?: { message: string } }) => [...cell.logs, cell.error?.message ?? ''].join('\n')
  const lastJob = () => [...jobs.jobs.keys()].filter((k) => k.startsWith('python-')).at(-1)!

  it('in a cell: text, a structured value with a schema, None on failure; the child belongs to this agent', async () => {
    const cell = await run([
      'a = await repl.agent("summarise x")',
      'b = await repl.agent("count", schema={"type": "object", "properties": {"n": {"type": "integer"}}})',
      'c = await repl.agent("fail please")',
      '(a, b, c)',
    ].join('\n'))
    assert.equal(cell.error, undefined, text(cell))
    assert.match(text(cell), /\('done: summarise x', \{'n': 5\}, None\)/)
    assert.equal(service.started.at(-3)!.parent, agent)
    assert.equal(service.started.at(-3)!.label, 'summarise x')
    assert.deepEqual(service.started.at(-2)!.schema, { type: 'object', properties: { n: { type: 'integer' } } })
  })

  it('a cell without the subagent tool is refused, and a bad schema is a TypeError', async () => {
    assert.match(text(await run('await repl.agent("x")', new Map())), /repl\.agent needs the subagent tool, and this cell does not have it/)
    assert.match(text(await run('await repl.agent("x", schema={"type": "string"})')), /TypeError: schema must be a JSON Schema for an object/)
  })

  it('in repl.background: children run side by side after the cell, and the job lists them', async () => {
    const before = service.started.length
    const cell = await run([
      'import asyncio',
      'async def fan():',
      '    await asyncio.sleep(0.3)',
      '    got = await asyncio.gather(*[repl.agent(f"wait {i}") for i in range(3)])',
      '    return got',
      'fj = await repl.background(fan(), label="fan out")',
    ].join('\n'))
    assert.equal(cell.error, undefined, text(cell))
    const started = Date.now()
    await sleep(1_000)
    const job = jobs.jobs.get(lastJob())!
    assert.equal(job.view.status, 'completed', job.text)
    assert.match(job.text, /\[agent\] wait 0: completed\n/)
    assert.match(job.text, /\['done: wait 0', 'done: wait 1', 'done: wait 2'\]/)
    assert.equal(service.started.length - before, 3)
    assert.ok(Date.now() - started < 2_000)
  })

  it('job_kill stops the children in flight and the work sees CancelledError', async () => {
    const cell = await run([
      'import asyncio',
      'seen = {}',
      'async def hang():',
      '    try:',
      '        await repl.agent("slow job child")',
      '    except asyncio.CancelledError:',
      '        seen["cancelled"] = True',
      '        raise',
      'kj = await repl.background(hang(), label="hang")',
    ].join('\n'))
    assert.equal(cell.error, undefined, text(cell))
    await sleep(300)
    const id = lastJob()
    const child = `child-${service.n}`
    assert.ok(!service.disposed.includes(child))
    jobs.cancels.get(id)!('killed by test')
    await sleep(800)
    assert.ok(service.disposed.includes(child), 'the child was disposed')
    assert.equal(jobs.jobs.get(id)!.view.status, 'killed')
    assert.match(text(await run('seen')), /'cancelled': True/)
  })

  it('a child a cell started without waiting is stopped when the cell ends', async () => {
    assert.equal((await run('import asyncio\nleft = asyncio.ensure_future(repl.agent("slow left behind"))\nawait asyncio.sleep(0.2)')).error, undefined)
    const child = `child-${service.n}`
    await sleep(300)
    assert.ok(service.disposed.includes(child))
    assert.match(text(await run('left.cancelled() or type(left.exception()).__name__')), /True|CancelledError|ToolCallError/)
  })

  it('cancelling the Python side (asyncio.wait_for) stops the child', async () => {
    const cell = await run('import asyncio\ntry:\n    await asyncio.wait_for(repl.agent("slow timed"), 0.3)\nexcept TimeoutError:\n    timed_out = True\ntimed_out')
    assert.equal(cell.error, undefined, text(cell))
    await sleep(300)
    assert.ok(service.disposed.includes(`child-${service.n}`))
  })
})
