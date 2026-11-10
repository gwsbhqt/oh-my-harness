/**
 * The run_code row model (src/client/model.ts): state, code, summary, output —
 * what the Python-labelled card renders.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { codeRowModel } from '../src/client/model.ts'

const args = JSON.stringify({ code: 'x = 1\nx', description: 'Add one' })

describe('run_code row model', () => {
  it('a running call shows its code and description', () => {
    const m = codeRowModel({ callId: 'c1', argsRaw: args })
    assert.equal(m.state, 'running')
    assert.equal(m.code, 'x = 1\nx')
    assert.equal(m.summary, 'Add one')
    assert.equal(m.output, null)
  })

  it('arguments still streaming (not JSON yet) show as raw text', () => {
    const m = codeRowModel({ callId: 'c1', argsRaw: '{"code": "x = ' })
    assert.equal(m.code, '{"code": "x = ')
    assert.equal(m.summary, 'c1')
  })

  it('a finished call carries its output', () => {
    const m = codeRowModel({ kind: 'result', callId: 'c1', call: { argsRaw: args }, content: [{ type: 'text', text: '1' }] })
    assert.equal(m.state, 'ok')
    assert.equal(m.output, '1')
    assert.equal(m.errorSummary, null)
  })

  it('a failed call summarises its first error line', () => {
    const m = codeRowModel({
      kind: 'result', callId: 'c1', call: { argsRaw: args }, isError: true,
      content: [{ type: 'text', text: 'Error: code run failed (exception): NameError\nTraceback …' }],
    })
    assert.equal(m.state, 'error')
    assert.equal(m.errorSummary, 'Error: code run failed (exception): NameError')
  })

  it('an interrupted call is stopped, not failed', () => {
    const m = codeRowModel({ kind: 'result', callId: 'c1', call: { argsRaw: args }, isError: true, content: [], error: { name: 'ToolError', code: 'interrupted' } })
    assert.equal(m.state, 'stopped')
    assert.equal(m.output, 'ToolError: interrupted')
  })

  // A session recorded under 0.2.1: the durable result of a run_code the user
  // stopped mid-cell, verbatim from a real session log (2026-09-27). Its history
  // must still render as stopped; 0.2.2 carries ABORTED directly (tests below).
  const failedRun = (text: string) => codeRowModel({
    kind: 'tool-result', callId: 'c1', call: { argsRaw: args }, isError: true,
    content: [{ type: 'text', text }],
    error: { name: 'CodeRunFailedError', code: 'CODE_RUN_FAILED' },
  })

  it('a cell the user cancelled is stopped, not failed', () => {
    const m = failedRun('Error: code run failed (abort): cell was cancelled')
    assert.equal(m.state, 'stopped')
    assert.equal(m.errorSummary, null, 'a stop is not an error line')
    assert.equal(m.output, 'Error: code run failed (abort): cell was cancelled', 'what the cell printed stays visible')
  })

  it('a cancelled cell that had printed output is still stopped', () => {
    const m = failedRun('Error: code run failed (abort): cell was cancelled before it started\nCaptured output:\nstep 1')
    assert.equal(m.state, 'stopped')
  })

  for (const code of ['ABORTED', 'ABORTED_BEFORE_DISPATCH']) {
    it(`a 0.2.2 ${code} result is stopped, not failed`, () => {
      const m = codeRowModel({
        kind: 'tool-result', callId: 'c1', call: { argsRaw: args }, isError: true,
        content: [{ type: 'text', text: 'Error: tool call aborted' }],
        error: { name: 'AbortError', code },
      })
      assert.equal(m.state, 'stopped')
      assert.equal(m.errorSummary, null)
    })
  }

  it('an AbortError without a code is stopped', () => {
    const m = codeRowModel({
      kind: 'tool-result', callId: 'c1', call: { argsRaw: args }, isError: true,
      content: [{ type: 'text', text: 'Error: tool call aborted' }],
      error: { name: 'AbortError' },
    })
    assert.equal(m.state, 'stopped')
  })

  it('an exception, a dead kernel or a timeout is still a failure', () => {
    for (const kind of ['exception', 'worker-exit', 'timeout']) {
      assert.equal(failedRun(`Error: code run failed (${kind}): boom`).state, 'error', kind)
    }
  })

  it('a cell that merely PRINTED the abort text is a failure, not a stop', () => {
    const m = failedRun('Error: code run failed (exception): ValueError: x\nCaptured output:\nError: code run failed (abort): cell was cancelled')
    assert.equal(m.state, 'error')
  })

  it('the abort prefix counts only on the host run_code failure', () => {
    const m = codeRowModel({
      kind: 'tool-result', callId: 'c1', call: { argsRaw: args }, isError: true,
      content: [{ type: 'text', text: 'Error: code run failed (abort): cell was cancelled' }],
      error: { name: 'ToolArgsError', code: 'INVALID_ARGS' },
    })
    assert.equal(m.state, 'error')
  })
})
