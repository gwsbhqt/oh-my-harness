/**
 * What is still running at a compaction (listUnfinished in src/bash-jobs.ts):
 * DSH's summary drops the ids of running jobs and subagents.
 */
import { strict as assert } from 'node:assert'
import { after, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { listUnfinished, unfinishedNotice } from '../src/bash-jobs.ts'
import { ReplSession } from '../src/session.ts'
import type { BoundTool } from '../src/lease.ts'

it('lists running jobs of the owner and subagents that are not idle', () => {
  const jobs = { list: (caller: string) => caller === 'a1' ? [
    { id: 'bash-1', label: 'pnpm   run check', status: 'running' },
    { id: 'bash-2', label: 'done', status: 'completed' },
    { id: 'python-3', label: 'crunch', status: 'stopping' },
  ] : [] }
  const agents = { get: (id: string) => ({ s1: { status: 'running' }, s2: { status: 'idle' } } as Record<string, { status: string }>)[id] }
  const got = listUnfinished(jobs, agents, 'a1', [{ id: 's1', label: 'review' }, { id: 's2', label: 'old' }, { id: 's3', label: 'gone' }], 10)
  assert.deepEqual(got, { jobs: [{ id: 'bash-1', label: 'pnpm run check' }, { id: 'python-3', label: 'crunch' }], subagents: [{ id: 's1', label: 'review' }] })
  assert.equal(unfinishedNotice(got!), 'At the last context compaction this work was still running; its completion arrives as a notice, so do not start it again. '
    + 'Background jobs: bash-1 (pnpm run check), python-3 (crunch). Subagents: s1 (review).')
  assert.equal(listUnfinished(jobs, agents, 'other', [], 10), undefined)
})

it('a cell that starts a subagent is remembered by the session', async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const session = new ReplSession({ python: process.env['DSH_PY'] ?? 'python3', vendorRoot: join(root, 'vendor', 'prime'), pythonRoot: join(root, 'python') })
  after(() => session.dispose())
  const tools = new Map<string, BoundTool>([['subagent', async () => ({ subagentId: 'sub-9' })]])
  const cell = await session.runCell('await tools.subagent({"description": "check docs", "prompt": "x"})', tools)
  assert.equal(cell.error, undefined, JSON.stringify(cell))
  assert.deepEqual(session.subagentsStarted, [{ id: 'sub-9', label: 'check docs' }])
})
