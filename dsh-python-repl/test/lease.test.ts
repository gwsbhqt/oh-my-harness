/**
 * Unit tests for the run-lease authority model.
 *
 * These encode the invariants from AGENTS.md: a settled cell's authority is
 * gone, a stale task cannot borrow the next cell's bindings, and a reply from
 * a previous kernel generation is never honoured.
 */

import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { describeDenial, LeaseRegistry, type BoundTool } from '../src/lease.ts'

const echo: BoundTool = async (args) => args

function toolMap(...names: string[]): Map<string, BoundTool> {
  return new Map(names.map((name) => [name, echo]))
}

describe('LeaseRegistry', () => {
  it('resolves a tool for a live run', () => {
    const registry = new LeaseRegistry()
    registry.grant('run-1', 1, toolMap('bash'))
    const lookup = registry.resolve('run-1', 1, 'bash')
    assert.equal(lookup.ok, true)
  })

  it('refuses an unknown run instead of falling back to a current one', () => {
    const registry = new LeaseRegistry()
    registry.grant('run-1', 1, toolMap('bash'))
    const lookup = registry.resolve('run-2', 1, 'bash')
    assert.equal(lookup.ok, false)
    assert.equal(lookup.ok === false && lookup.denial.reason, 'unknown-run')
  })

  it('refuses a settled run — the stale-task invariant', () => {
    const registry = new LeaseRegistry()
    registry.grant('run-1', 1, toolMap('bash'))
    registry.revoke('run-1')
    const lookup = registry.resolve('run-1', 1, 'bash')
    assert.equal(lookup.ok, false)
    assert.equal(lookup.ok === false && lookup.denial.reason, 'unknown-run')
  })

  it('does not let a stale run borrow a later run’s bindings', () => {
    const registry = new LeaseRegistry()
    registry.grant('run-1', 1, toolMap('bash'))
    registry.revoke('run-1')
    registry.grant('run-2', 1, toolMap('bash'))
    // The leftover task still says run-1; run-2 being live must not save it.
    const lookup = registry.resolve('run-1', 1, 'bash')
    assert.equal(lookup.ok, false)
  })

  it('refuses a call tagged with a previous kernel generation', () => {
    const registry = new LeaseRegistry()
    registry.grant('run-1', 2, toolMap('bash'))
    const lookup = registry.resolve('run-1', 1, 'bash')
    assert.equal(lookup.ok, false)
    assert.equal(lookup.ok === false && lookup.denial.reason, 'stale-epoch')
  })

  it('refuses a tool the run was never granted', () => {
    const registry = new LeaseRegistry()
    registry.grant('run-1', 1, toolMap('bash'))
    const lookup = registry.resolve('run-1', 1, 'subagent')
    assert.equal(lookup.ok, false)
    assert.equal(lookup.ok === false && lookup.denial.reason, 'unknown-tool')
  })

  it('rejects duplicate run ids', () => {
    const registry = new LeaseRegistry()
    registry.grant('run-1', 1, toolMap('bash'))
    assert.throws(() => registry.grant('run-1', 1, toolMap('bash')), /duplicate run id/)
  })

  it('revoke is idempotent', () => {
    const registry = new LeaseRegistry()
    registry.grant('run-1', 1, toolMap('bash'))
    registry.revoke('run-1')
    registry.revoke('run-1')
    assert.equal(registry.resolve('run-1', 1, 'bash').ok, false)
  })

  it('revokeAll clears every lease', () => {
    const registry = new LeaseRegistry()
    registry.grant('run-1', 1, toolMap('bash'))
    registry.grant('run-2', 1, toolMap('bash'))
    registry.revokeAll()
    assert.equal(registry.resolve('run-1', 1, 'bash').ok, false)
    assert.equal(registry.resolve('run-2', 1, 'bash').ok, false)
  })

  it('each run sees only its OWN bound functions', async () => {
    const registry = new LeaseRegistry()
    const first: BoundTool = async () => 'from-run-1'
    const second: BoundTool = async () => 'from-run-2'
    registry.grant('run-1', 1, new Map([['bash', first]]))
    registry.grant('run-2', 1, new Map([['bash', second]]))
    const a = registry.resolve('run-1', 1, 'bash')
    const b = registry.resolve('run-2', 1, 'bash')
    assert.equal(a.ok && (await a.call(null)), 'from-run-1')
    assert.equal(b.ok && (await b.call(null)), 'from-run-2')
  })
})

describe('describeDenial', () => {
  it('explains a stale run in terms the model can act on', () => {
    const text = describeDenial({ reason: 'unknown-run', runId: 'run-1' })
    assert.match(text, /already settled/)
    assert.match(text, /background task/)
  })

  it('explains an epoch mismatch as a kernel restart', () => {
    const text = describeDenial({ reason: 'stale-epoch', runId: 'run-1', expected: 2, got: 1 })
    assert.match(text, /kernel restarted/)
  })

  it('names the unknown tool', () => {
    const text = describeDenial({ reason: 'unknown-tool', runId: 'run-1', tool: 'nope' })
    assert.match(text, /"nope"/)
  })
})
