import { strict as assert } from 'node:assert'
import { it } from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeTask, parseRunEvents, gradeTask, taskById, taskIds, summarizeRuns, runBenchmark, type BenchRun } from '../scripts/benchmark.ts'

const lines = (events: unknown[]) => events.map(event => JSON.stringify(event)).join('\n')
const ended = [{ type: 'status', phase: 'turn_end', reason: { kind: 'completed' } }, { type: 'final', text: '完成' }]

it('benchmark tasks use valid CSV, stable inputs and a hand-calculated answer', () => {
  const task = makeTask('total', 4)
  assert.deepEqual(task.expected, { samples: 4, cpu_seconds: 20 })
  assert.equal(task.files['records/part-1.csv']!.trim().split('\n').length, 5)
  assert.deepEqual(makeTask('total', 4), task)
  assert.equal(taskIds().length, 12)
  for (const id of taskIds()) assert.equal(taskById(id).id, id)
  assert.throws(() => taskById('../total-24'))
  assert.throws(() => makeTask('groups', 3))
})

it('benchmark counts committed usage with both cached and uncached input', () => {
  const parsed = parseRunEvents(lines([
    { type: 'session', sessionId: 'test' },
    { type: 'tool_call', tool: 'read' }, { type: 'tool_result', status: 'completed' },
    { type: 'status', phase: 'step_end', usage: { inputTokens: 2, outputTokens: 3, totalTokens: 105, cacheReadTokens: 100 } },
    { type: 'status', phase: 'step_end', usage: { inputTokens: 4, outputTokens: 5, totalTokens: 209, cacheReadTokens: 200 } }, ...ended,
  ]))
  assert.equal(parsed.complete, true)
  assert.equal(parsed.steps, 2)
  assert.equal(parsed.modelToolCalls, 1)
  assert.deepEqual(parsed.usage, { inputTokens: 6, outputTokens: 8, totalTokens: 314, cacheReadTokens: 300, cacheWriteTokens: null })
})

it('benchmark never fills absent or partially reported usage with zero', () => {
  const parsed = parseRunEvents(lines([{ type: 'session', sessionId: 'test' },
    { type: 'status', phase: 'step_end', usage: { totalTokens: 10 } },
    { type: 'status', phase: 'step_end' }, ...ended]))
  assert.equal(parsed.complete, true)
  for (const value of Object.values(parsed.usage)) assert.equal(value, null)
})

it('benchmark refuses failed, malformed, truncated and unterminated streams', () => {
  const opening = { type: 'session', sessionId: 'test' }
  assert.equal(parseRunEvents(lines([opening, { type: 'final', text: '完成' }])).complete, false)
  assert.equal(parseRunEvents(lines([opening, ...ended]) + '\n{').complete, false)
  assert.equal(parseRunEvents(lines([opening, ...ended, { type: 'final', text: '重复' }])).complete, false)
  assert.equal(parseRunEvents(lines([opening, { type: 'status', phase: 'turn_end', reason: { kind: 'error' } }, ended[1]])).complete, false)
  assert.equal(parseRunEvents(lines([opening, { ...ended[0], truncated: true }, ended[1]])).complete, false)
  assert.equal(parseRunEvents(lines([opening, { type: 'tool_result', status: 'error', result: 'sandbox mode workspace-write is requested but no sandbox backend is usable' }, ...ended])).complete, false)
})

it('benchmark excludes failed tasks from efficiency comparisons and rejects mismatched samples', () => {
  const metrics = parseRunEvents(lines([{ type: 'session', sessionId: 'test' }, { type: 'status', phase: 'step_end', usage: { totalTokens: 10 } }, ...ended]))
  const one: BenchRun = { task: 'a', mode: 'native', variant: 'current', provider: 'p', model: 'm', appBuild: 'app', inputHash: 'same', valid: true, passed: true, elapsedMs: 20, metrics }
  const two = { ...one, mode: 'ptc' }
  const failed = [{ ...one, task: 'b' }, { ...two, task: 'b', passed: false }]
  const summary = summarizeRuns([one, two, ...failed])
  assert.deepEqual(summary.jointlyPassedTasks, ['a'])
  assert.equal(summary.groups[0]!.totalTokensOnComparable, 10)
  assert.equal(summary.groups[0]!.attempted, 2)
  assert.throws(() => summarizeRuns([one, { ...two, inputHash: 'changed' }]), /输入不一致/)
  assert.throws(() => summarizeRuns([one, { ...two, model: 'other' }]), /不同模型/)
  assert.throws(() => summarizeRuns([one, one]), /任务重复/)
  assert.throws(() => summarizeRuns([]), /缺少实际运行记录/)
  assert.throws(() => summarizeRuns([{ task: 'prepared' } as BenchRun]), /缺少实际运行记录/)
  assert.throws(() => summarizeRuns([one, { ...two, appBuild: 'other' }]), /不同 App/)
  assert.throws(() => summarizeRuns([one, { ...two, isolation: 'changed' }]), /不同隔离配置/)
  assert.throws(() => summarizeRuns([two, { ...two, task: 'b', runtimeDigest: 'changed' }]), /运行代码发生了变化/)
})

it('benchmark grades the produced file and preserves input integrity' , async () => {
  const work = await mkdtemp(join(tmpdir(), 'ptc-benchmark-grade-'))
  const task = makeTask('total', 4)
  try {
    for (const [name, content] of Object.entries(task.files)) {
      await mkdir(join(work, 'records'), { recursive: true })
      await writeFile(join(work, name), content)
    }
    assert.equal((await gradeTask(task, work)).passed, false)
    await writeFile(join(work, 'answer.json'), JSON.stringify(task.expected))
    assert.equal((await gradeTask(task, work)).passed, true)
    await writeFile(join(work, 'answer.json'), '{"samples":4,"cpu_seconds":21}')
    assert.equal((await gradeTask(task, work)).passed, false)
    await writeFile(join(work, 'answer.json'), JSON.stringify(task.expected))
    await writeFile(join(work, 'records/part-1.csv'), 'changed')
    assert.equal((await gradeTask(task, work)).passed, false)
  } finally { await rm(work, { recursive: true, force: true }) }
})

it('benchmark runs the real write boundary and grades a produced artifact without a model', { skip: process.platform !== 'darwin' }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'ptc-benchmark-boundary-'))
  const app = join(temp, 'Fixture.app')
  const cli = join(app, 'Contents/Resources/runtime/cli/bin/dsh')
  const sentinel = join(temp, 'keep.txt')
  try {
    await mkdir(join(app, 'Contents/Resources/runtime/cli/bin'), { recursive: true })
    await writeFile(join(app, 'Contents/Info.plist'), 'test application')
    await writeFile(sentinel, 'unchanged')
    await writeFile(cli, `#!/usr/bin/env node
const fs = require('node:fs');
let denied = false;
try { fs.writeFileSync(${JSON.stringify(sentinel)}, 'changed'); } catch { denied = true; }
if (!denied) process.exit(3);
const records = fs.readdirSync('records').flatMap(name => fs.readFileSync('records/' + name, 'utf8').trim().split('\\n').slice(1));
fs.writeFileSync('answer.json', JSON.stringify({samples: records.length, cpu_seconds: records.reduce((sum, row) => sum + Number(row.split(',')[5]), 0)}));
for (const event of [{type:'session', sessionId:'fixture'}, {type:'status', phase:'step_end', usage:{totalTokens:100}}, {type:'status', phase:'turn_end', reason:{kind:'completed'}}, {type:'final', text:'done'}]) console.log(JSON.stringify(event));
`)
    await chmod(cli, 0o700)
    const results = await runBenchmark({ output: join(temp, 'results'), app, credentials: join(temp, 'unused'), baseUrl: '', keyRef: '', provider: 'fixture', model: 'fixture', api: 'openai-completions', pluginRoot: '', kernelVenv: '', mode: 'native', variant: 'test', timeoutMs: 5000, tasks: ['total-24'], dryRun: false }) as BenchRun[]
    assert.equal(results[0]!.passed, true)
    assert.equal(await readFile(sentinel, 'utf8'), 'unchanged')
    const workingCli = await readFile(cli, 'utf8')
    for (const artifact of ['events.jsonl', 'stderr.txt', 'result.json']) {
      await writeFile(cli, workingCli + `\nfs.symlinkSync(${JSON.stringify(sentinel)}, ${JSON.stringify('../' + artifact)});\n`)
      await assert.rejects(runBenchmark({ output: join(temp, 'symlink-' + artifact), app, credentials: join(temp, 'unused'), baseUrl: '', keyRef: '', provider: 'fixture', model: 'fixture', api: 'openai-completions', pluginRoot: '', kernelVenv: '', mode: 'native', variant: 'test', timeoutMs: 5000, tasks: ['total-24'], dryRun: false }), /EEXIST|ELOOP/)
      assert.equal(await readFile(sentinel, 'utf8'), 'unchanged')
    }
    await writeFile(cli, '#!/usr/bin/env node\nconsole.error("dsh: warning: 1 entry did not activate");setTimeout(() => {}, 30000);\n')
    const failed = await runBenchmark({ output: join(temp, 'failed'), app, credentials: join(temp, 'unused'), baseUrl: '', keyRef: '', provider: 'fixture', model: 'fixture', api: 'openai-completions', pluginRoot: '', kernelVenv: '', mode: 'native', variant: 'test', timeoutMs: 5000, tasks: ['total-24', 'total-600'], dryRun: false }) as BenchRun[]
    assert.equal(failed.length, 1)
    assert.equal(failed[0]!.valid, false)
    assert.ok(failed[0]!.elapsedMs < 4000)
  } finally { await rm(temp, { recursive: true, force: true }) }
})

