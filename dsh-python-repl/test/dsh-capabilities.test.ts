/**
 * P4: DSH capabilities orchestrated from a cell.
 *
 * These use FIXTURE tools shaped like the real ones rather than booting a GUI:
 * the thing under test is the bridge's behaviour (can a cell await a
 * long-blocking question? does a background subagent's receipt differ from a
 * result?), not DSH's own implementations, which have their own tests.
 *
 * What a fixture CANNOT prove is called out in each test and in
 * isolated integration probes — no GUI window, no real model, no real MCP server.
 */

import { strict as assert } from 'node:assert'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ReplSession } from '../src/session.ts'
import type { BoundTool } from '../src/lease.ts'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const PYTHON = process.env['DSH_PY'] ?? 'python3'

const sessions: ReplSession[] = []
function newSession(): ReplSession {
  const session = new ReplSession({
    python: PYTHON,
    vendorRoot: join(root, 'vendor', 'prime'),
    pythonRoot: join(root, 'python'),
  })
  sessions.push(session)
  return session
}

after(async () => {
  await Promise.all(sessions.map((s) => s.dispose()))
})

describe('asking the user from a cell', () => {
  it('a cell can await a question that takes a long time to answer', async () => {
    // The real ask_user_question resolves only when a human replies. The
    // bridge must not impose its own timeout on that wait.
    const session = newSession()
    const tools = new Map<string, BoundTool>([
      ['ask_user_question', async () => {
        await new Promise((r) => setTimeout(r, 1_200))
        return { answers: [{ id: 'q1', selected: 'Option B' }] }
      }],
    ])
    const started = Date.now()
    const result = await session.runCell(
      'a = await tools.ask_user_question({"questions": [{"id": "q1", "question": "Which?"}]})\n'
      + 'a["answers"][0]["selected"]',
      tools,
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.ok(Date.now() - started >= 1_200, 'the cell really waited')
    assert.match(result.logs.join(''), /Option B/)
  })

  it('a fixed-choice answer can drive a branch in the SAME cell', async () => {
    // This is the payoff: a deterministic choice needs no extra model turn.
    const session = newSession()
    const tools = new Map<string, BoundTool>([
      ['ask_user_question', async () => ({ answers: [{ id: 'q', selected: 'yes' }] })],
      ['bash', async () => ({ stdout: 'ran the yes branch', exitCode: 0 })],
    ])
    const result = await session.runCell(
      'a = await tools.ask_user_question({"questions": [{"id": "q", "question": "Proceed?"}]})\n'
      + 'if a["answers"][0]["selected"] == "yes":\n'
      + '    out = (await bash({"command": "true"}))["stdout"]\n'
      + 'else:\n'
      + '    out = "skipped"\n'
      + 'out\n',
      tools,
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.match(result.logs.join(''), /ran the yes branch/)
  })

  it('a cancelled question does not leave the cell hanging', async () => {
    const session = newSession()
    const tools = new Map<string, BoundTool>([
      ['ask_user_question', async () => { throw new Error('question cancelled') }],
    ])
    const result = await session.runCell(
      'try:\n'
      + '    await tools.ask_user_question({"questions": []})\n'
      + 'except ToolCallError as e:\n'
      + '    print(f"handled: {e}")\n',
      tools,
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.match(result.logs.join(''), /handled: question cancelled/)
  })
})

describe('subagents from a cell', () => {
  it('a start returns an activation receipt, not the child result', async () => {
    // DSH 0.2.2's subagent tool is activation-only: the result arrives later
    // as a message; the cell must not treat the child id as an answer.
    const session = newSession()
    const tools = new Map<string, BoundTool>([
      ['subagent', async () => ({ kind: 'activation', subagentId: 'child-123' })],
    ])
    const result = await session.runCell(
      'r = await tools.subagent({"description": "x", "prompt": "y"})\n'
      + '(r["kind"], r["subagentId"], "result" in r)',
      tools,
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.match(result.logs.join(''), /\('activation', 'child-123', False\)/)
  })

  it('several independent subagents can start concurrently in one cell', async () => {
    const session = newSession()
    let peak = 0
    let live = 0
    const tools = new Map<string, BoundTool>([
      ['subagent', async (args) => {
        live += 1
        peak = Math.max(peak, live)
        await new Promise((r) => setTimeout(r, 200))
        live -= 1
        return { kind: 'activation', subagentId: `child-${(args as { prompt: string }).prompt}` }
      }],
    ])
    const started = Date.now()
    const result = await session.runCell(
      'import asyncio\n'
      + 'rs = await asyncio.gather(*[tools.subagent({"description": "d", "prompt": p}) for p in "abc"])\n'
      + '[r["subagentId"] for r in rs]\n',
      tools,
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.match(result.logs.join(''), /\['child-a', 'child-b', 'child-c'\]/)
    assert.equal(peak, 3, 'gather really overlapped the starts')
    assert.ok(Date.now() - started < 600, 'concurrent, not sequential')
  })
})

describe('plan approval from a cell', () => {
  it('an approval result is available to the cell', async () => {
    const session = newSession()
    const tools = new Map<string, BoundTool>([
      ['exit_plan_mode', async () => ({ approved: true })],
    ])
    const result = await session.runCell(
      '(await tools.exit_plan_mode({"plan": "# Plan\\nDo it."}))["approved"]',
      tools,
    )
    assert.match(result.logs.join(''), /True/)
  })

  it('a rejected plan surfaces as a catchable failure', async () => {
    const session = newSession()
    const tools = new Map<string, BoundTool>([
      ['exit_plan_mode', async () => { throw new Error('user rejected the plan') }],
    ])
    const result = await session.runCell(
      'try:\n'
      + '    await tools.exit_plan_mode({"plan": "x"})\n'
      + '    print("approved")\n'
      + 'except ToolCallError as e:\n'
      + '    print(f"not approved: {e}")\n',
      tools,
    )
    assert.match(result.logs.join(''), /not approved: user rejected the plan/)
  })
})

describe('skill instructions', () => {
  it('a skill tool returns text the model must READ, so the cell ends', async () => {
    // Storing instructions in a variable is not the same as the model having
    // read them. The cell should surface the content and stop.
    const session = newSession()
    const tools = new Map<string, BoundTool>([
      ['skill', async () => ({ name: 'deploy', content: 'Step 1: check the branch.' })],
    ])
    const result = await session.runCell(
      's = await tools.skill({"name": "deploy"})\ns["content"]',
      tools,
    )
    assert.match(result.logs.join(''), /Step 1: check the branch\./)
  })
})

describe('mutating vs read-only ordering', () => {
  it('sequential awaits stay in submission order', async () => {
    const session = newSession()
    const order: string[] = []
    const tools = new Map<string, BoundTool>([
      ['write', async (args) => {
        order.push(String((args as { path: string }).path))
        return { ok: true }
      }],
    ])
    const result = await session.runCell(
      'for p in ["first", "second", "third"]:\n    await tools.write({"path": p})\n',
      tools,
    )
    assert.equal(result.error, undefined, JSON.stringify(result))
    assert.deepEqual(order, ['first', 'second', 'third'])
  })
})
