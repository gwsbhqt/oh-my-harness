import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { applyGlobTool } from '@deepseek-ai/dsh-tool-fs-search'
import { executeOne, mountAgents, mountNativeTools } from './host.ts'
import { fakeWorkingDirectory } from './working-directory.ts'
import { GLOB_CAPS, apply, completeRecords, makeGlobTool, skippedDirectories, withSkipGlobs } from '../src/index.ts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
const text = (result: unknown) => JSON.stringify(result)
type Call = (args: Record<string, unknown>, name?: string) => Promise<{ isError: boolean; value?: unknown; content?: unknown }>

/**
 * Synthetic project files beside a dependency tree. A single generated node_modules package emits
 * more than 20 MB of matches, exercising explicit dependency searches and output-budget handling.
 */
function dotfiles(dir: string): void {
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'a.txt'), 'scale_needle in my own code\n')
  mkdirSync(join(dir, 'node_modules', 'pkg'), { recursive: true })
  const line = `${'x'.repeat(1900)} scale_needle\n`
  writeFileSync(join(dir, 'node_modules', 'pkg', 'big.js'), line.repeat(Math.ceil(22_000_000 / line.length)))
  mkdirSync(join(dir, '.venv', 'lib'), { recursive: true })
  writeFileSync(join(dir, '.venv', 'lib', 'b.py'), 'scale_needle in a venv\n')
}

async function harness(fn: (call: Call, dir: string, ctx: Context, agent: Agent) => Promise<void>, withPlugin = true) {
  const ctx = new Context()
  await mountAgents(ctx)
  await ctx.plugin(SystemPrompt)
  await mountNativeTools(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  ctx.provide('workingDirectory', fakeWorkingDirectory() as never)
  await tick()
  const dir = mkdtempSync(join(tmpdir(), 'grep-scope-scale-'))
  const agent = { id: 'scale-agent', sessionId: 'scale-agent' } as unknown as Agent
  const scope = createScope(ctx, agent)
  Object.defineProperty(agent, 'ctx', { value: scope.ctx })
  Object.defineProperty(agent, 'session', { value: { id: 'scale-agent', header: { id: 'scale-agent', cwd: dir } } })
  const stop = ctx.agents.register(agent)
  const plugin = withPlugin ? await ctx.plugin({ apply, inject: ['tools', 'subprocess', 'systemPrompt', 'agents', 'workingDirectory'] }) : undefined
  await tick()
  const registry = ctx.get('tools')!
  let n = 0
  const call: Call = (args, name = 'grep') => executeOne(registry, {
    callId: `scale-${n++}` as never, name, arguments: args, agent, signal: new AbortController().signal,
  }) as never
  try { await fn(call, dir, ctx, agent) } finally {
    await plugin?.dispose()
    stop()
    await scope.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}

test('a whole-tree scope all grep skips dependency directories instead of overflowing', { timeout: 60_000 }, () => harness(async (call, dir) => {
  dotfiles(dir)
  const result = await call({ pattern: 'scale_needle', scope: 'all' })
  assert.equal(result.isError, false, text(result).slice(0, 2000))
  const value = result.value as { matches: Array<{ path: string }>; skippedDirectories?: string[]; outputCapped?: true }
  assert.deepEqual(value.matches.map(m => m.path), ['./src/a.txt'])
  assert.ok(value.skippedDirectories?.includes('node_modules') && value.skippedDirectories.includes('.venv'))
  assert.equal(value.outputCapped, undefined)
  assert.match(text(result), /Skipped dependency and cache directories \(node_modules/)
  const venv = await call({ pattern: 'scale_needle', scope: 'all', path: '.venv' })
  assert.deepEqual((venv.value as { matches: Array<{ path: string }> }).matches.map(m => m.path), ['.venv/lib/b.py'], 'a path naming the directory searches it')
  const included = await call({ pattern: 'scale_needle', scope: 'all', include: '**/.venv/**' })
  assert.deepEqual((included.value as { matches: Array<{ path: string }> }).matches.map(m => m.path), ['./.venv/lib/b.py'])
}))

test('a grep printing more than the early-stop budget returns the matches so far, marked incomplete, not an error', { timeout: 60_000 }, () => harness(async (call, dir) => {
  dotfiles(dir)
  const started = Date.now()
  const result = await call({ pattern: 'scale_needle', path: 'node_modules' })
  assert.equal(result.isError, false, text(result).slice(0, 2000))
  const value = result.value as { matches: Array<{ path: string; line: string }>; outputCapped?: true; skippedDirectories?: string[] }
  assert.equal(value.outputCapped, true)
  assert.equal(value.skippedDirectories, undefined)
  assert.ok(value.matches.length > 1000, String(value.matches.length))
  assert.ok(value.matches.every(m => m.path === 'node_modules/pkg/big.js' && m.line.endsWith('scale_needle')), 'only whole records are kept')
  assert.match(text(result), /Incomplete: ripgrep printed more than 10 MB[^]*Most kept matches are under: node_modules\/pkg/)
  assert.ok(Date.now() - started < 30_000, 'well inside the 30 s tool budget')
}))

test('the official glob overflows on a dependency tree; the replacement skips it and still lists named ones', { timeout: 60_000 }, async () => {
  const caps = { ...GLOB_CAPS, rawOutputMaxBytes: 4096 }
  const tree = (dir: string) => {
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), '')
    for (let i = 0; i < 200; i++) {
      mkdirSync(join(dir, 'node_modules', `package-number-${i}`, 'lib'), { recursive: true })
      writeFileSync(join(dir, 'node_modules', `package-number-${i}`, 'lib', 'index.js'), '')
    }
  }
  await harness(async (call, dir, ctx) => {
    tree(dir)
    applyGlobTool(ctx as never, caps)
    const official = await call({ pattern: '**/*' }, 'glob')
    assert.equal(official.isError, true, 'the original failure: dependency paths blow the raw-output cap')
    assert.match(text(official), /raw output/)
  }, false)
  await harness(async (call, dir, ctx, agent) => {
    tree(dir)
    const glob = makeGlobTool(ctx, caps)
    const off = (agent as unknown as { ctx: Context }).ctx.get('tools')!.register(glob.tool)
    const stopPost = ctx.on('tools/post-execute', glob.postExecute as never)
    try {
      const listed = await call({ pattern: '**/*' }, 'glob')
      assert.equal(listed.isError, false, text(listed))
      assert.deepEqual((listed.value as { paths: string[] }).paths, ['src/a.ts'])
      assert.match(text(listed), /Skipped dependency and cache directories/)
      const named = await call({ pattern: '*.js', path: 'node_modules/package-number-7' }, 'glob')
      assert.deepEqual((named.value as { paths: string[] }).paths, ['node_modules/package-number-7/lib/index.js'])
      assert.doesNotMatch(text(named), /Skipped dependency/)
    } finally { stopPost(); off() }
  }, false)
})

test('skip decisions and argv placement', () => {
  assert.ok(skippedDirectories(undefined).includes('node_modules'))
  assert.deepEqual(skippedDirectories('pkg/node_modules/x'), [])
  assert.deepEqual(skippedDirectories(undefined, '**/node_modules/**/*.js'), [])
  assert.deepEqual(skippedDirectories('/Applications/X.app/Contents/Resources/app.asar/dsh'), [])
  assert.deepEqual(skippedDirectories('/Users/u/.dsh/plugins/grep-scope/asar/0123456789abcdef-1-2/dsh'), [])
  assert.deepEqual(skippedDirectories('/x/app.asar.unpacked/dsh'), [])
  assert.deepEqual(withSkipGlobs(['--files', '--', 'p'], ['node_modules']), ['--files', '--glob=!**/node_modules', '--glob=!**/node_modules/**', '--', 'p'])
  assert.deepEqual(withSkipGlobs(['--files'], ['a']), ['--files', '--glob=!**/a', '--glob=!**/a/**'])
  assert.equal(completeRecords('a\u00001:x\nb\u00002:y', false), 'a\u00001:x\n')
  assert.equal(completeRecords('ial\nb\u00002:y\nc', true), 'b\u00002:y\n')
  assert.equal(completeRecords('no newline', true), '')
})
