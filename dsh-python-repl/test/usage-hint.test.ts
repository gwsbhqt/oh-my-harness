/**
 * A successful cell can still use the session wrongly: detach a process or
 * re-import a name the kernel already binds. One short note at the cell boundary is cheaper than another
 * paragraph in the system prompt.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { usageHint } from '../src/hints.ts'

describe('usage hint', () => {
  it('points an obvious repl assignment at another name', () => {
    assert.match(usageHint('repl = 1'), /reserved system binding/)
  })

  it('leaves subprocess and file writes to the kernel, which reads the syntax tree', () => {
    assert.equal(usageHint('import subprocess\nsubprocess.Popen(["x"])'), '')
  })

  it('stays silent for a normal cell', () => {
    assert.equal(usageHint('x = 1 + 1'), '')
  })

  it('does not nudge a preloaded import (it would pollute cell logs)', () => {
    assert.equal(usageHint('import json\nx = json.dumps({})'), '')
  })

  it('does not match a preloaded name inside a string', () => {
    assert.equal(usageHint('s = "import json"'), '')
  })
})
