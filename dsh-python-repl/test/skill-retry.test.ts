import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { it } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply, Config, kernelEnvironment, probeInterpreter, PythonReplRuntime } from '../src/index.ts'
import { mountAgents } from './fixtures/agents.ts'

async function waitForFile(path: string) {
  const deadline = performance.now() + 10_000
  while (!existsSync(path)) {
    assert.ok(performance.now() < deadline, `Timed out waiting for ${path}`)
    await sleep(10)
  }
}

it('keeps each live kernel, its panel and its model context in sync across retries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-skill-retry-'))
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const skills = join(dir, 'skills')
  const module = join(skills, 'report-reader', 'src', 'report_reader')
  const ready = join(dir, 'data-ready')
  const pause = join(dir, 'wait')
  const entered = join(dir, 'import-entered')
  const trigger = join(dir, 'retry-now')
  const complete = join(dir, 'retry-done')
  const dep = 'dshprobe_report_inputs'
  let runtime: PythonReplRuntime | undefined
  try {
    mkdirSync(module, { recursive: true })
    writeFileSync(join(skills, 'report-reader', 'SKILL.md'), '---\nname: report-reader\ndescription: Read a sample report\n---\n')
    writeFileSync(join(module, '__init__.py'), [
      `from ${dep} import VALUE`, 'from pathlib import Path', 'import time',
      `if Path(${JSON.stringify(pause)}).exists():`, `    Path(${JSON.stringify(entered)}).touch()`,
      `    while Path(${JSON.stringify(pause)}).exists(): time.sleep(0.01)`,
      `if not Path(${JSON.stringify(ready)}).exists(): raise RuntimeError('sample table is missing')`,
    ].join('\n'))
    mkdirSync(join(skills, 'guide'))
    writeFileSync(join(skills, 'guide', 'SKILL.md'), '---\nname: report_reader\ndescription: Instructions with the same name as a Python module\n---\n')
    const unsupported = join(skills, 'z-host-only', 'src', 'host_only')
    mkdirSync(unsupported, { recursive: true })
    writeFileSync(join(skills, 'z-host-only', 'SKILL.md'), '---\nname: z-host-only\ndescription: Uses the upstream host\n---\n')
    writeFileSync(join(unsupported, '__init__.py'), 'from rlm import unsupported\n')
    const base = process.env['DSH_PY'] ?? 'python3'
    const python = (await kernelEnvironment({ python: base, ...await probeInterpreter(base) }, join(dir, 'venv'), [])).python
    const wheel = execFileSync(base, ['-c',
      'import pathlib, sys; sys.path.insert(0, sys.argv[1]); from test_packages import make_wheel; '
      + 'print(make_wheel(pathlib.Path(sys.argv[2]), sys.argv[3], "1.0", "ready"))', join(root, 'test', 'python'), dir, dep],
    { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }).trim()
    const ctx = new Context()
    await mountAgents(ctx)
    await ctx.plugin({ apply, Config }, { python, skillRoots: [skills], projectSkillRoots: [] })
    await ctx.plugin(SystemPrompt)
    await new Promise<void>(resolve => setImmediate(resolve))
    const host = ctx.get('ptcRuntime') as PythonReplRuntime
    runtime = host
    const key = join(dir, 'first')
    const otherKey = join(dir, 'second')
    const one = host.sessionFor(key, dir, python)
    const two = host.sessionFor(otherKey, dir, python)
    const panel = () => host.panelState(key)
    const scope = { id: 'sample-agent', sessionId: key } as unknown as Agent
    const context = async () => (await ctx.get('systemPrompt')!.assemble({ scope }))
      .contexts.find(item => item.name === 'python-repl:state')!.text
    const cell = (code: string, signal?: AbortSignal) => one.runCell(code, new Map(), signal)
    const retry = 'await skills.retry("report_reader")'
    assert.equal((await cell('import os\nfrom pathlib import Path\noriginal_pid = os.getpid()\nrows = [19, 23]')).error, undefined)
    assert.equal((await two.runCell('1', new Map())).error, undefined)
    const epoch = one.epoch
    const initial = (await panel()).skillReport!
    assert.match(initial.failed[0]!.reason, /No module named 'dshprobe_report_inputs'/)
    assert.equal(initial.skills.find(s => s.skill === 'report-reader')?.retryable, true)
    const retryHint = (await context()).split('\n').find(line => line.includes('await skills.retry'))!
    assert.match(retryHint, /await skills\.retry\("report_reader"\)/)
    assert.doesNotMatch(retryHint, /host_only/)

    // Ordinary displays and ineligible names cannot alter the import catalog.
    const display = await cell([
      'from rlm.repl import emit', 'emit({"text/plain": "ordinary display"})',
      'for skill, name in [("report_reader", "report_reader"), ("z-host-only", "host_only"), ("report-reader", "wrong_name"), ("unknown", "unknown")]:',
      '    emit({"application/vnd.dsh.skill-import+json": {"skill": skill, "import_name": name, "status": "available", "retryable": False}})',
      'print("ordinary stdout")',
    ].join('\n'))
    assert.equal(display.error, undefined)
    assert.match(display.logs.join(''), /ordinary stdout/)
    assert.deepEqual((await panel()).skillReport?.loaded, [])

    assert.equal((await cell(`await repl.install(${JSON.stringify(wheel)})`)).error, undefined)
    assert.match((await panel()).skillReport!.failed[0]!.reason, /No module named/)
    const failed = await cell(retry)
    assert.match(failed.error!.message, /sample table is missing/)
    const failure = (await panel()).skillReport!
    assert.equal(failure.skills.find(s => s.skill === 'report-reader')?.reason, 'RuntimeError: sample table is missing')
    assert.equal(failure.failed[0]?.reason, 'RuntimeError: sample table is missing')
    assert.match(initial.failed[0]!.reason, /No module named/)
    assert.match(await context(), /sample table is missing/)
    assert.doesNotMatch(await context(), /No module named 'dshprobe_report_inputs'/)

    writeFileSync(pause, '')
    const controller = new AbortController()
    const interrupted = cell(retry, controller.signal)
    await waitForFile(entered)
    controller.abort()
    assert.equal((await interrupted).error?.kind, 'abort')
    rmSync(pause)
    assert.equal((await panel()).skillReport!.failed[0]?.reason, 'RuntimeError: sample table is missing')

    writeFileSync(ready, '')
    const scheduled = await cell([
      'async def finish_import():', `    while not Path(${JSON.stringify(trigger)}).exists(): await asyncio.sleep(0.01)`,
      `    ${retry}`, `    Path(${JSON.stringify(complete)}).touch()`, 'worker = asyncio.create_task(finish_import())',
    ].join('\n'))
    assert.equal(scheduled.error, undefined)
    writeFileSync(trigger, '')
    await waitForFile(complete)
    const recovered = (await panel()).skillReport!
    assert.deepEqual(recovered.loaded, ['report_reader'])
    assert.deepEqual(recovered.failed.map(s => s.skill), ['z-host-only'])
    assert.equal(recovered.skills.find(s => s.skill === 'report-reader')?.reason, undefined)
    assert.match(await context(), /Skill imports in this kernel: \["report_reader"\]/)
    assert.doesNotMatch(await context(), /sample table is missing|await skills\.retry/)
    const analysis = await cell('assert os.getpid() == original_pid\n[sum(rows), skills.report_reader.VALUE]')
    assert.equal(analysis.error, undefined)
    assert.match(analysis.logs.join(''), /\[42, 'ready'\]/)
    assert.equal(one.epoch, epoch)
    assert.match((await host.panelState(otherKey)).skillReport!.failed[0]!.reason, /No module named/)
    assert.match(await host.stateContext(otherKey, dir), /No module named/)

    // Cancelling the rest of a cell keeps an import that already finished.
    const secondReady = join(dir, 'second-imported')
    const afterImport = new AbortController()
    const later = two.runCell([retry, `Path(${JSON.stringify(secondReady)}).touch()`, 'await asyncio.sleep(30)'].join('\n'), new Map(), afterImport.signal)
    await waitForFile(secondReady)
    afterImport.abort()
    assert.equal((await later).error?.kind, 'abort')
    assert.deepEqual((await host.panelState(otherKey)).skillReport?.loaded, ['report_reader'])
    assert.equal((await two.runCell('skills.report_reader.VALUE', new Map())).error, undefined)

    // A replacement kernel begins with its own imports, even if an old cell ID is replayed.
    assert.equal((await cell('os._exit(3)')).error?.kind, 'worker-exit')
    assert.equal((await panel()).skillReport, null)
    rmSync(ready)
    assert.equal((await one.panelControl('start')).ok, true)
    assert.ok(one.epoch > epoch)
    const obsolete = await cell([
      'from rlm.repl import _current_cell, emit', `token = _current_cell.set("cell-${epoch}-1")`, 'try:',
      '    emit({"application/vnd.dsh.skill-import+json": {"skill": "report-reader", "import_name": "report_reader", "status": "available", "retryable": False}})',
      'finally: _current_cell.reset(token)',
    ].join('\n'))
    assert.equal(obsolete.error, undefined)
    assert.match((await panel()).skillReport!.failed[0]!.reason, /sample table is missing/)
    assert.match(await context(), /await skills\.retry/)
  } finally {
    rmSync(pause, { force: true })
    await runtime?.disposeAll()
    rmSync(dir, { recursive: true, force: true })
  }
})
