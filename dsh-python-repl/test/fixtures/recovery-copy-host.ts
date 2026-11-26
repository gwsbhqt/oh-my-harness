import { strict as assert } from 'node:assert'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { Config, PythonReplRuntime } from '../../src/index.ts'
import { mountAgents } from './agents.ts'

const [phase, root, python, copyId] = process.argv.slice(2)
assert.ok(root && python && phase)
const cwd = join(root, phase === 'repaired' ? 'with-module' : phase)
mkdirSync(cwd, { recursive: true })
if (phase === 'save' || phase === 'repaired') {
  writeFileSync(join(cwd, 'copy_meter.py'), 'class Meter:\n    reading = 23\n')
}
const ctx = new Context()
await mountAgents(ctx)
await ctx.plugin(PythonReplRuntime, Config({ python, skillRoots: [], projectSkillRoots: [],
  archiveAfterCells: 0, deleteAfterCells: 0 }))
await new Promise<void>((resolve) => setImmediate(resolve))
const runtime = ctx.get('ptcRuntime') as PythonReplRuntime
const key = phase === 'foreign' ? 'other-session' : 'fixture'
const session = runtime.sessionFor(key, cwd, python)
async function cell(code: string): Promise<string> {
  const result = await session.runCell(code, new Map())
  assert.equal(result.error, undefined, JSON.stringify(result))
  return result.logs.join('\n')
}

try {
  const first = await cell('pass')
  assert.equal((await runtime.panelState(key)).snapshotProtected, phase === 'save' || phase === 'missing')
  if (phase === 'save') {
    assert.match(first, /could not be restored.*old/)
    await cell(`assert await repl.list_copies() == []
assert {'save_copy', 'read_copy', 'list_copies'} <= {x['name'] for x in (await repl.describe('repl'))['methods']}
assert counter == 7
counter = 99
new_value = 42
_private_input = 11
business_input = 12
def add_inputs(number): return number + business_input + _private_input
class LocalReceipt:
    def total(self): return business_input + _private_input
local_receipt = LocalReceipt()
shared = []
box = {'items': shared, 'fn': add_inputs}
_file = Path(${JSON.stringify(join(root, 'handles.txt'))})
writer = _file.open('w')
writer.write('already written')
writer.flush()
closed_writer = _file.open('a')
closed_writer.close()
meter = __import__('copy_meter').Meter()
class Unsaveable:
    def __reduce__(self): raise ValueError('synthetic unserializable value')
bad = Unsaveable()
too_big = bytes(16 * 1024 * 1024 + 1)
class Interrupted:
    def __reduce__(self): raise asyncio.CancelledError()
try:
    interrupted = Interrupted()
    await repl.save_copy('counter', 'interrupted')
except asyncio.CancelledError:
    pass
else:
    raise AssertionError('unfinished copy was accepted')
assert await repl.list_copies() == []
all_skipped = await repl.save_copy('old', 'read_me', 'tools', 'bad')
assert all_skipped['copy_id'] is None and not all_skipped['saved']
assert await repl.list_copies() == []`)
    const received = await cell(`_selected_value = 5
receipt = await repl.save_copy('counter', 'new_value', 'add_inputs', 'shared', 'box', 'writer', 'closed_writer', 'meter', 'local_receipt', '_selected_value', 'old', 'read_me', 'repl', 'bad', 'too_big', 'new_value')
print(json.dumps(receipt))`)
    const receipt = JSON.parse(received)
    assert.match(receipt.copy_id, /^[a-f0-9]{32}$/)
    const skipped = Object.fromEntries(receipt.skipped.map((item: { name: string; reason: string }) => [item.name, item.reason]))
    assert.match(skipped.old, /not in this kernel/)
    assert.match(skipped.read_me, /archived/)
    assert.match(skipped.repl, /reserved/)
    assert.match(skipped.bad, /synthetic unserializable/)
    assert.match(skipped.too_big, /size cap/)
    assert.deepEqual(receipt.saved, ['_selected_value', 'add_inputs', 'box', 'closed_writer', 'counter', 'local_receipt', 'meter', 'new_value', 'shared', 'writer'])
    await cell(`second = await repl.save_copy('new_value')
assert second['copy_id'] != receipt['copy_id']
assert set(await repl.list_copies()) == {receipt['copy_id'], second['copy_id']}
ns_alias = globals()
assert (await repl.save_copy('ns_alias'))['copy_id'] is None
nested_namespace = [globals()]
nested_copy = await repl.save_copy('nested_namespace')
nested_read = await repl.read_copy(nested_copy['copy_id'])
assert not nested_read['values'] and nested_read['failed'][0]['name'] == 'nested_namespace'
assert 'live __main__ namespace' in nested_read['failed'][0]['reason']`)
    console.log(JSON.stringify(receipt))
  } else if (phase === 'foreign') {
    await cell(`assert await repl.list_copies() == []
try:
    await repl.read_copy(${JSON.stringify(copyId)})
except FileNotFoundError:
    pass
else:
    raise AssertionError('opened a different session copy')`)
  } else {
    assert.ok((phase === 'missing' || phase === 'repaired') && copyId)
    const checkMeter = phase === 'repaired'
      ? "assert not recovered['failed'] and values['meter'].reading == 23\nassert old.reading == 42 and read_me == ['A'] and pin_me == ['B'] and untouched == ['C'] and rebound == ['D']"
      : "assert 'meter' not in values and len(recovered['failed']) == 1\nassert recovered['failed'][0]['name'] == 'meter' and 'copy_meter' in recovered['failed'][0]['reason']"
    await cell(`assert counter == 7 and 'new_value' not in globals()
visible_copies = await repl.list_copies()
assert len(visible_copies) == 3 and ${JSON.stringify(copyId)} in visible_copies
for missing_copy in ['0' * 32, '1' * 32]:
    try:
        await repl.read_copy(missing_copy)
    except FileNotFoundError:
        continue
    raise AssertionError(missing_copy)
class LocalReceipt:
    def total(self): return 404
_private_input = 100
business_input = 200
recovered = await repl.read_copy(${JSON.stringify(copyId)})
values = recovered['values']
assert set(values) - {'meter'} == {'counter','new_value','_selected_value','add_inputs','shared','box','writer','closed_writer','local_receipt'}
assert (values['counter'], values['new_value'], values['_selected_value']) == (99, 42, 5)
assert counter == 7 and 'new_value' not in globals() and 'add_inputs' not in globals()
assert (business_input, _private_input) == (200, 100)
assert values['add_inputs'].__globals__ is not globals() and values['add_inputs'](2) == 25
assert values['shared'] is values['box']['items'] and values['add_inputs'] is values['box']['fn']
values['shared'].append('only in this read')
assert (await repl.read_copy(${JSON.stringify(copyId)}))['values']['shared'] == []
assert type(values['local_receipt']) is not LocalReceipt and values['local_receipt'].total() == 23
assert values['writer'].closed and values['closed_writer'].closed
assert Path(${JSON.stringify(join(root, 'handles.txt'))}).read_text() == 'already written'
assert {x['name'] for x in recovered['skipped']} == {'old', 'read_me', 'repl', 'bad', 'too_big'}
${checkMeter}
for invalid in ['../file.dill', '/', '', 'A' * 32]:
    try:
        await repl.read_copy(invalid)
    except ValueError:
        continue
    raise AssertionError(invalid)`)
    console.log(JSON.stringify({ phase, protection: (await runtime.panelState(key)).snapshotProtected }))
  }
} finally {
  await runtime.disposeAll()
}
