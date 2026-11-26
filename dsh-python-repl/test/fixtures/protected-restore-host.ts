import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import { Config, PythonReplRuntime } from '../../src/index.ts'
import { mountAgents } from './agents.ts'

const [phase, root, python] = process.argv.slice(2)
assert.ok(phase && root && python)
const partial = phase === 'partial'
const cwd = join(root, partial ? 'missing-module' : 'with-module')
mkdirSync(cwd, { recursive: true })
const moduleSource = 'class Meter:\n    reading = 42\n'
if (phase === 'seed') writeFileSync(join(cwd, 'fixture_meter.py'), moduleSource)
const ctx = new Context()
await mountAgents(ctx)
await ctx.plugin(PythonReplRuntime, Config({ python, skillRoots: [], projectSkillRoots: [],
  archiveAfterCells: partial ? 1 : 0, deleteAfterCells: partial ? 2 : 0 }))
await new Promise<void>((resolve) => setImmediate(resolve))
const runtime = ctx.get('ptcRuntime') as PythonReplRuntime
const session = runtime.sessionFor('fixture', cwd, python)
const cell = async (code: string) => {
  const result = await session.runCell(code, new Map())
  assert.equal(result.error, undefined, JSON.stringify(result))
  return result.logs.join('\n')
}
try {
  if (phase === 'seed') {
    await cell("old = __import__('fixture_meter').Meter()\ncounter = 7\nread_me = ['A']\npin_me = ['B']\nuntouched = ['C']\nrebound = ['D']")
    for (const name of ['read_me', 'pin_me', 'untouched', 'rebound']) {
      assert.equal((await session.panelNameAction('archive', name)).ok, true)
    }
  } else if (partial) {
    const start = await session.panelControl('start')
    const first = await cell("assert counter == 7 and 'old' not in globals()")
    const context = await runtime.stateContext('fixture', cwd)
    assert.equal((await runtime.panelState('fixture')).snapshotProtected, true)
    const keep = await cell("new_value = 42\ncounter = 99\nawait repl.keep('new_value', 'pin_me')")
    const panelKeep = await session.panelNameAction('keep', 'counter')
    await cell("assert read_me == ['A'] and pin_me == ['B']\nrebound = ['changed']")
    const archive = await session.panelNameAction('archive', 'rebound')
    const next = await cell('42')
    // Give the debounce time to fire while the session is still live.
    await sleep(1900)
    const beforeClose = await cell("(counter, new_value, read_me, pin_me, rebound)")
    const stop = await session.panelControl('stop')
    writeFileSync(join(cwd, 'fixture_meter.py'), moduleSource)
    const retry = await session.runCell('await repl.restart()', new Map())
    console.log(JSON.stringify({ start, first, context, keep, panelKeep, archive, next, beforeClose, stop, retry }))
  } else {
    assert.equal(phase, 'reopen')
    const restored = await cell("(old.reading, counter, 'new_value' in globals(), read_me, pin_me, untouched, rebound)")
    assert.equal((await runtime.panelState('fixture')).snapshotProtected, false)
    const keep = await cell("await repl.keep('counter')")
    const archive = await session.panelNameAction('archive', 'rebound')
    console.log(JSON.stringify({ restored, keep, archive }))
  }
} finally {
  await runtime.disposeAll()
}
