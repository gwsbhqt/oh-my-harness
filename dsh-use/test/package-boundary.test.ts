import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const required = [
  'package.json', 'LICENSE', 'AGENTS.md', 'README.md', 'README.en.md', 'cordis.patch.yml',
  'bin/dsh-use', 'lib/index.js', 'lib/client.js', 'lib/dsh-use.js', 'lib/dsh-use-mcp.js',
  'skills/dsh-use/SKILL.md', 'skills/dsh-use/PYSKILL.md', 'skills/dsh-use/pyproject.toml',
  'skills/dsh-use/src/dsh_use/__init__.py',
  'skills/dsh-use/references/common.md', 'skills/dsh-use/references/cli.md', 'skills/dsh-use/references/raycast.md',
  'skills/dsh-supervise/SKILL.md', 'skills/dsh-supervise/references/brief-template.md',
  'skills/dsh-supervise/scripts/watchdog.py', 'skills/dsh-supervise/scripts/test_watchdog.py',
]

function packFiles(cwd: string, cache: string): Set<string> {
  const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--offline'], {
    cwd, encoding: 'utf8', maxBuffer: 1024 * 1024,
    env: { ...process.env, npm_config_cache: cache, npm_config_update_notifier: 'false' },
  })
  const packages = JSON.parse(output) as Array<{ files: Array<{ path: string }> }>
  assert.equal(packages.length, 1)
  return new Set(packages[0]!.files.map(file => file.path))
}

function assertBoundary(files: Set<string>) {
  for (const name of required) assert.ok(files.has(name), `发布包缺少入口或文档：${name}`)
  assert.deepEqual([...files].filter(name => /(?:^|\/)(?:__pycache__|\.venv)(?:\/|$)|\.py[co]$|\.egg-info(?:\/|$)/.test(name)), [], '本机 Python 产物不得发布')
}

test('实际 npm 发布清单保留运行入口和技能说明，排除本机 Python 产物', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-use-pack-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assertBoundary(packFiles(packageRoot, join(root, 'npm-cache')))
})

test('未跟踪的虚构缓存存在时，真实 npm pack 仍只发布所需文件', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-use-pack-fixture-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const directory = join(root, 'package')
  const generated = [
    'skills/dsh-use/src/dsh_use/__pycache__/__init__.cpython-314.pyc',
    'skills/dsh-supervise/scripts/__pycache__/watchdog.cpython-314.pyc',
    'skills/dsh-supervise/scripts/__pycache__/test_watchdog.cpython-314.pyc',
    'skills/dsh-use/src/dsh_use/legacy.pyc', 'skills/dsh-use/src/dsh_use/legacy.pyo',
    'skills/dsh-use/src/dsh_use.egg-info/PKG-INFO', 'skills/dsh-use/src/dsh_use.egg-info/SOURCES.txt',
    'skills/dsh-use/.venv/lib/example.py', 'skills/dsh-use/.venv/README.md',
  ]
  const generatedContent = 'fictional build artifact from /workspace/example/skill.py\n'
  for (const name of [...required, ...generated]) {
    const file = join(directory, name)
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, name === 'package.json' ? readFileSync(join(packageRoot, name)) : generated.includes(name) ? generatedContent : 'fictional fixture\n')
  }
  const files = packFiles(directory, join(root, 'npm-cache'))
  assertBoundary(files)
  assert.deepEqual([...files].sort(), [...required].sort())
  for (const name of generated) assert.equal(readFileSync(join(directory, name), 'utf8'), generatedContent, '检查不得靠删除缓存通过')
})
