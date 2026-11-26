import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { kernelEnvironment, probeInterpreter } from '../src/index.ts'
import { ReplSession } from '../src/session.ts'
import { discoverSkills } from '../src/skill-discovery.ts'

it('installs a local dependency and finishes the skill analysis in the original kernel', async (t) => {
  const root = fileURLToPath(new URL('../', import.meta.url))
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-skill-install-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const trusted = join(scratch, 'trusted')
  const skill = join(trusted, 'report-reader')
  const source = join(skill, 'src', 'report_reader')
  mkdirSync(source, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), '---\nname: report-reader\ndescription: Process sample values\n---\n')
  writeFileSync(join(source, '__init__.py'), 'from sample_library_q import VALUE\ndef measure(values): return sum(values) * int(VALUE)\n')
  const document = join(trusted, 'report_reader')
  mkdirSync(document)
  writeFileSync(join(document, 'SKILL.md'), '---\nname: report_reader\ndescription: Instructions only\n---\n')
  const python = process.env['DSH_PY'] ?? 'python3'
  const wheel = execFileSync(python, ['-c',
    'import sys, pathlib; sys.path.insert(0, sys.argv[1]); from test_packages import make_wheel; '
    + 'print(make_wheel(pathlib.Path(sys.argv[2]), "sample_library_q", "1.0", "3"))',
    join(root, 'test', 'python'), scratch,
  ], { encoding: 'utf8' }).trim()
  const environment = await kernelEnvironment({ python, ...await probeInterpreter(python) }, join(scratch, 'venv'), [])
  const session = new ReplSession({
    python: environment.python, vendorRoot: join(root, 'vendor', 'prime'), pythonRoot: join(root, 'python'),
    cwd: scratch, skills: discoverSkills([trusted]).skills,
  })
  try {
    const first = await session.runCell([
      'import os', 'records = [2, 5, 7]', 'original_pid = os.getpid()',
      'status = (await skills.describe("report-reader"))["items"][0]',
      'assert status["retryable"] and "sample_library_q" in status["reason"]',
    ].join('\n'), new Map())
    assert.equal(first.error, undefined, JSON.stringify(first.error))
    const installed = await session.runCell([
      `receipt = await repl.install(${JSON.stringify(wheel)})`,
      'assert receipt["importable_now"] == ["sample_library_q"]',
      'retry = await skills.retry("report_reader")',
      'assert retry == {"status": "loaded", "import_name": "report_reader"}',
      'assert os.getpid() == original_pid',
      'print(skills.report_reader.measure(records))',
    ].join('\n'), new Map())
    assert.equal(installed.error, undefined, JSON.stringify(installed.error))
    assert.equal(installed.logs.join('').trim(), '42')
    const later = await session.runCell([
      'status = (await skills.describe("report-reader"))["items"][0]',
      'assert status["status"] == "available" and status["reason"] is None',
      'assert (await skills.retry("report-reader"))["status"] == "already_loaded"',
      'overlap = (await skills.describe("report_reader"))["items"][0]',
      'assert overlap["status"] == "unavailable" and "instructions" not in overlap',
      'assert any(r["name"] == "report_reader" and r["status"] == "docs-only" for r in (await skills.list())["items"])',
      'records.append(1)', 'print(skills.report_reader.measure(records))',
    ].join('\n'), new Map())
    assert.equal(later.error, undefined, JSON.stringify(later.error))
    assert.equal(later.logs.join('').trim(), '45')
  } finally {
    await session.dispose()
  }
})
