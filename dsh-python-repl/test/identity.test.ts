/**
 * Session identity: which kernel a cell lands in.
 *
 * A persistent kernel holds one session's variables, so mis-routing is a data
 * leak, not a performance bug. These tests use the REAL AgentRegistry and the
 * real initiator boundary the agent loop establishes.
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { mountAgents } from './fixtures/agents.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Config, PythonReplRuntime } from '../src/index.ts'

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** A stand-in for a live Agent: identity carrier only, never authorization. */
function fakeAgent(id: string, sessionId?: string): Agent {
  return { id, ...(sessionId === undefined ? {} : { sessionId }) } as unknown as Agent
}

async function boot(): Promise<{ ctx: Context; runtime: PythonReplRuntime }> {
  const ctx = new Context()
  await mountAgents(ctx)
  await tick()
  await ctx.plugin(PythonReplRuntime, Config({ python: process.env['DSH_PY'] ?? 'python3', startupTimeoutMs: 30_000, teardownGraceMs: 5_000, interruptGraceMs: 5_000, toolCallTimeoutMs: 0, residentTools: [], skillRoots: [] }))
  await tick()
  const runtime = ctx.get('ptcRuntime') as unknown as PythonReplRuntime
  return { ctx, runtime }
}

const started: PythonReplRuntime[] = []
after(async () => {
  await Promise.all(started.map((r) => r.disposeAll()))
})

describe('session identity', () => {
  it('refuses an unattributed call instead of joining a shared kernel', async () => {
    const { runtime } = await boot()
    started.push(runtime)
    const identity = runtime.resolveIdentity()
    assert.equal(identity.kind, 'denied')
    assert.match(
      identity.kind === 'denied' ? identity.message : '',
      /no initiating agent/,
    )
  })

  it('keys by session id inside an initiator boundary', async () => {
    const { ctx, runtime } = await boot()
    started.push(runtime)
    const agents = ctx.get('agents')
    assert.ok(agents)
    const identity = agents.withInitiator(fakeAgent('agent-1', 'session-A'), () =>
      runtime.resolveIdentity(),
    )
    assert.deepEqual(identity, { kind: 'ok', key: 'session-A' })
  })

  it('falls back to agent id when the agent has no session id', async () => {
    const { ctx, runtime } = await boot()
    started.push(runtime)
    const agents = ctx.get('agents')
    assert.ok(agents)
    const identity = agents.withInitiator(fakeAgent('agent-lonely'), () => runtime.resolveIdentity())
    assert.deepEqual(identity, { kind: 'ok', key: 'agent-lonely' })
  })

  it('gives two sessions two different kernels', async () => {
    const { ctx, runtime } = await boot()
    started.push(runtime)
    const agents = ctx.get('agents')
    assert.ok(agents)
    const a = agents.withInitiator(fakeAgent('a', 'session-A'), () => runtime.resolveIdentity())
    const b = agents.withInitiator(fakeAgent('b', 'session-B'), () => runtime.resolveIdentity())
    assert.notEqual(
      a.kind === 'ok' ? a.key : '',
      b.kind === 'ok' ? b.key : '',
    )
    const sessionA = runtime.sessionFor('session-A')
    const sessionB = runtime.sessionFor('session-B')
    assert.notEqual(sessionA, sessionB, 'distinct sessions must not share a ReplSession')
  })

  it('routes two agents on the SAME session to one kernel', async () => {
    const { ctx, runtime } = await boot()
    started.push(runtime)
    const agents = ctx.get('agents')
    assert.ok(agents)
    // A fork/subagent on the same session is the same conversation to the user.
    const parent = agents.withInitiator(fakeAgent('parent', 'session-S'), () => runtime.resolveIdentity())
    const child = agents.withInitiator(fakeAgent('child', 'session-S'), () => runtime.resolveIdentity())
    assert.deepEqual(parent, child)
    assert.equal(runtime.sessionFor('session-S'), runtime.sessionFor('session-S'))
  })

  it('actually isolates variables between two sessions end to end', async () => {
    const { ctx, runtime } = await boot()
    started.push(runtime)
    const agents = ctx.get('agents')
    assert.ok(agents)
    const bindings = { bindings: [], signal: undefined }

    const first = await agents.withInitiator(fakeAgent('a', 'session-A'), () =>
      runtime.run({ program: 'leaked = "from-A"\n1', ...bindings } as never),
    )
    assert.equal(first.error, undefined, JSON.stringify(first))

    const second = await agents.withInitiator(fakeAgent('b', 'session-B'), () =>
      runtime.run({
        program: 'try:\n    leaked\nexcept NameError:\n    print("isolated")\n',
        ...bindings,
      } as never),
    )
    assert.equal(second.error, undefined, JSON.stringify(second))
    assert.match(second.logs.join(''), /isolated/, 'session B must not see session A state')
  })

  it('keeps variables across cells within one session', async () => {
    const { ctx, runtime } = await boot()
    started.push(runtime)
    const agents = ctx.get('agents')
    assert.ok(agents)
    const bindings = { bindings: [], signal: undefined }
    const agent = fakeAgent('a', 'session-persist')

    await agents.withInitiator(agent, () =>
      runtime.run({ program: 'kept = 21', ...bindings } as never),
    )
    const second = await agents.withInitiator(agent, () =>
      runtime.run({ program: 'kept * 2', ...bindings } as never),
    )
    assert.match(second.logs.join(''), /42/)
  })
})

/**
 * Closing a conversation must end its kernel.
 *
 * If the runtime only ever added to `sessions`, every session that once ran a
 * cell would keep a live Python process — and every value it held — until the
 * plugin unloaded. `agent/disposed` is the host's
 * "this agent is gone" edge; a parent and its fork share one session key, so
 * the kernel may only go when the LAST agent on that key has left.
 */
describe('a closed session releases its kernel', () => {
  /** A registry-shaped agent: `enter` requires id === session.id. */
  function liveAgent(id: string, sessionId?: string): Agent {
    return { id, ...(sessionId === undefined ? {} : { sessionId }), session: { id } } as unknown as Agent
  }

  function processAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async function exitWithin(pid: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (!processAlive(pid)) return true
      await new Promise((r) => setTimeout(r, 50))
    }
    return !processAlive(pid)
  }

  async function enterAndAnnounce(agents: NonNullable<ReturnType<Context['get']>>, agent: Agent): Promise<() => void> {
    const registry = agents as unknown as {
      enter: (a: Agent, owner: Agent | undefined) => () => void
      announce: (a: Agent, source: string) => Promise<void>
    }
    const detach = registry.enter(agent, undefined)
    await registry.announce(agent, 'startup')
    return detach
  }

  it('kills the kernel and forgets the session when its last agent is disposed', async () => {
    const { ctx, runtime } = await boot()
    started.push(runtime)
    const agents = ctx.get('agents')
    assert.ok(agents)
    const agent = liveAgent('session-closed')
    const detach = await enterAndAnnounce(agents, agent)
    const ran = await agents.withInitiator(agent, () =>
      runtime.run({ program: 'big = list(range(10))\nimport os; os.getpid()', bindings: [], signal: undefined } as never),
    )
    assert.equal(ran.error, undefined, JSON.stringify(ran))
    const pid = Number(ran.logs.join('').trim())
    assert.ok(processAlive(pid), 'the session has a live kernel before it closes')

    detach()

    assert.equal(runtime.sessions.has('session-closed'), false, 'a closed session must leave the table')
    assert.ok(await exitWithin(pid, 5_000), `kernel ${pid} must exit once its session closed`)
  })

  it('keeps the kernel while another agent still uses the same session', async () => {
    const { ctx, runtime } = await boot()
    started.push(runtime)
    const agents = ctx.get('agents')
    assert.ok(agents)
    // Two live agents that resolve to one kernel key: the plugin keys by
    // `sessionId ?? id`, so a second agent carrying the same sessionId is how
    // a parent and its fork look to it.
    const parent = liveAgent('shared-session')
    const child = liveAgent('child-agent', 'shared-session')
    await enterAndAnnounce(agents, parent)
    const detachChild = await enterAndAnnounce(agents, child)
    await agents.withInitiator(parent, () =>
      runtime.run({ program: 'kept = 7', bindings: [], signal: undefined } as never),
    )

    detachChild()

    assert.equal(runtime.sessions.has('shared-session'), true, 'the parent still needs its variables')
    const after = await agents.withInitiator(parent, () =>
      runtime.run({ program: 'kept * 6', bindings: [], signal: undefined } as never),
    )
    assert.match(after.logs.join(''), /42/, 'the surviving agent keeps the same kernel')
  })

  it('gives a reopened session its variables back', async () => {
    const { ctx, runtime } = await boot()
    started.push(runtime)
    const agents = ctx.get('agents')
    assert.ok(agents)
    const first = liveAgent('session-reopened')
    const detach = await enterAndAnnounce(agents, first)
    await agents.withInitiator(first, () =>
      runtime.run({ program: 'kept = list(range(1))', bindings: [], signal: undefined } as never),
    )
    detach()

    const again = liveAgent('session-reopened')
    await enterAndAnnounce(agents, again)
    const probe = 'try:\n    kept\n    print("SURVIVED")\nexcept NameError:\n    print("fresh")\n'
    const reopened = await agents.withInitiator(again, () =>
      runtime.run({ program: probe, bindings: [], signal: undefined } as never),
    )
    const text = reopened.logs.join('\n')
    assert.match(text, /SURVIVED/)
    assert.match(text, /1 name is back\.\nVariables[^\n]*: kept\./, 'the model is told what came back')
    const later = await agents.withInitiator(again, () =>
      runtime.run({ program: '"third"', bindings: [], signal: undefined } as never),
    )
    assert.doesNotMatch(later.logs.join('\n'), /python-state-restored/, 'said once, not on every cell')
  })

  it('ignores the disposal of an agent that never ran a cell', async () => {
    const { ctx, runtime } = await boot()
    started.push(runtime)
    const agents = ctx.get('agents')
    assert.ok(agents)
    const detach = await enterAndAnnounce(agents, liveAgent('never-ran'))
    detach()
    assert.equal(runtime.sessions.size, 0)
  })
})

describe('skill catalog must not merge sessions', () => {
  it('reports no skills for a session that has no kernel yet', async () => {
    const { runtime } = await boot()
    started.push(runtime)
    assert.deepEqual(runtime.knownSkills('session-never-started'), [])
  })

  it('returns nothing without an identity rather than borrowing another session', async () => {
    const { runtime } = await boot()
    started.push(runtime)
    assert.deepEqual(runtime.knownSkills(), [], 'no identity means no kernel to describe')
  })

  it('does not leak one session’s loaded skills into another', async () => {
    const { ctx, runtime } = await boot()
    started.push(runtime)
    const agents = ctx.get('agents')
    assert.ok(agents)

    // Give session A a kernel (and therefore a skill report).
    await agents.withInitiator(fakeAgent('a', 'session-A'), () =>
      runtime.run({ program: '1', bindings: [], signal: undefined } as never),
    )
    const forA = runtime.knownSkills('session-A')
    const forB = runtime.knownSkills('session-B')

    assert.deepEqual(forB, [], 'session B has its own kernel state, or none at all')
    assert.notEqual(
      runtime.sessions.get('session-A'),
      runtime.sessions.get('session-B'),
      'the two sessions must not share a ReplSession',
    )
    assert.ok(Array.isArray(forA))
  })
})
