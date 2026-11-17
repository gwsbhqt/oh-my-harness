import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { executeOne, mountAgents, mountNativeTools } from './host.ts'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { fakeWorkingDirectory } from './working-directory.ts'
import { apply } from '../src/index.ts'

const tick = () => new Promise<void>(resolve => setImmediate(resolve))
type GrepValue = { matches: Array<{ path: string }>; unreadable?: Array<{ path: string; error: string }> }

async function harness(fn: (call: (args: Record<string, unknown>) => Promise<{ isError: boolean; value?: unknown; content?: unknown }>, dir: string) => Promise<void>, linkedCwd = false) {
  const ctx = new Context()
  await mountAgents(ctx)
  await ctx.plugin(SystemPrompt)
  await mountNativeTools(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  ctx.provide('workingDirectory', fakeWorkingDirectory() as never)
  await tick()
  const dir = mkdtempSync(join(tmpdir(), 'grep-scope-partial-'))
  if (linkedCwd) symlinkSync(dir, join(dir, 'cwd-link'))
  const cwd = linkedCwd ? join(dir, 'cwd-link') : dir
  const agent = { id: 'partial-agent', sessionId: 'partial-agent' } as unknown as Agent
  const scope = createScope(ctx, agent)
  Object.defineProperty(agent, 'ctx', { value: scope.ctx })
  Object.defineProperty(agent, 'session', { value: { id: 'partial-agent', header: { id: 'partial-agent', cwd } } })
  const stop = ctx.agents.register(agent)
  const plugin = await ctx.plugin({ apply, inject: ['tools', 'subprocess', 'systemPrompt', 'agents', 'workingDirectory'] })
  await tick()
  const registry = ctx.get('tools')!
  let n = 0
  const call = (args: Record<string, unknown>) => executeOne(registry, {
    callId: `grep-${n++}` as never, name: 'grep', arguments: args, agent, signal: new AbortController().signal,
  }) as never
  try { await fn(call, dir) } finally {
    await plugin.dispose()
    stop()
    await scope.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}

const text = (result: { content?: unknown; value?: unknown }) => JSON.stringify(result)

test('an unreadable subdirectory keeps the other matches and names the skipped path', { skip: process.getuid?.() === 0 }, () => harness(async (call, dir) => {
  mkdirSync(join(dir, 'ok'))
  mkdirSync(join(dir, 'locked', 'inner'), { recursive: true })
  writeFileSync(join(dir, 'ok', 'a.txt'), 'partial_needle\n')
  writeFileSync(join(dir, 'top.txt'), 'partial_needle\n')
  writeFileSync(join(dir, 'locked', 'inner', 'b.txt'), 'partial_needle\n')
  chmodSync(join(dir, 'locked'), 0o000)
  try {
    const result = await call({ pattern: 'partial_needle' })
    assert.equal(result.isError, false, text(result))
    const value = result.value as GrepValue
    assert.deepEqual(value.matches.map(m => m.path.replace(/^\.\//, '')).sort(), ['ok/a.txt', 'top.txt'])
    assert.deepEqual(value.unreadable?.map(u => u.path.replace(/^\.\//, '')), ['locked'])
    assert.match(value.unreadable![0]!.error, /Permission denied/)
    assert.match(text(result), /Unreadable[^]*locked/, 'the native text must say the result is incomplete')
    const clean = await call({ pattern: 'partial_needle', path: 'ok' })
    assert.equal(clean.isError, false, text(clean))
    assert.equal('unreadable' in (clean.value as object), false, 'complete results keep the official {matches} shape')
    const none = await call({ pattern: 'absent_needle_xyz' })
    assert.equal(none.isError, false, text(none))
    assert.deepEqual((none.value as GrepValue).matches, [])
    assert.deepEqual((none.value as GrepValue).unreadable?.map(u => u.path.replace(/^\.\//, '')), ['locked'])
    assert.match(text(none), /readable part of the selected scope[^]*Incomplete/)
    const invalid = await call({ pattern: '(' })
    assert.equal(invalid.isError, true)
    assert.match(text(invalid), /pattern rejected by ripgrep/)
  } finally { chmodSync(join(dir, 'locked'), 0o755) }
}))

test('a missing path reports that the path does not exist', () => harness(async (call) => {
  const result = await call({ pattern: 'x', path: 'no/such/dir' })
  assert.equal(result.isError, true)
  assert.match(text(result), /路径不存在[^]*no\/such\/dir/)
  assert.doesNotMatch(text(result), /search failed \(exit 2\)/)
}))

test('a symlink cwd keeps root failures and relative matches correctly located', { skip: process.getuid?.() === 0 }, () => harness(async (call, dir) => {
  mkdirSync(join(dir, 'locked'))
  writeFileSync(join(dir, 'ok.txt'), 'needle\n')
  chmodSync(join(dir, 'locked'), 0o000)
  try {
    const bad = await call({ pattern: 'needle', path: './locked/' })
    assert.equal(bad.isError, true, text(bad))
    assert.match(text(bad), /无法读取搜索路径/)
    const partial = await call({ pattern: 'needle' })
    assert.equal(partial.isError, false, text(partial))
    assert.deepEqual((partial.value as GrepValue).matches.map(m => m.path.replace(/^\.\//, '')), ['ok.txt'])
    const missing = await call({ pattern: 'needle', path: './missing/' })
    assert.equal(missing.isError, true)
    assert.match(text(missing), /路径不存在/)
  } finally { chmodSync(join(dir, 'locked'), 0o755) }
}, true))

test('a malformed regex is still reported as a rejected pattern', () => harness(async (call) => {
  const result = await call({ pattern: '(' })
  assert.equal(result.isError, true)
  assert.match(text(result), /pattern rejected by ripgrep/)
}))

test('a one-line file bigger than the raw cap still returns every match, with long lines cut', () => harness(async (call, dir) => {
  // Synthetic long lines exceed the raw cap without clipping; every matching file must remain visible.
  const huge = 'x'.repeat(3_000_000)
  mkdirSync(join(dir, 'cache'))
  for (let i = 0; i < 8; i++) writeFileSync(join(dir, 'cache', `blob${i}.json`), `${huge} clip_needle ${huge}\n`)
  writeFileSync(join(dir, 'small.txt'), 'first clip_needle\r\nnothing here\nsecond clip_needle\n')
  writeFileSync(join(dir, 'odd:name.txt'), 'clip_needle 1:2:3\n')
  writeFileSync(join(dir, 'bin.dat'), Buffer.from('clip_needle\0binary\n'))
  writeFileSync(join(dir, 'cache', 'cjk.md'), `${'中'.repeat(1990)} clip_needle ${'文'.repeat(5000)}\n`)
  const result = await call({ pattern: 'clip_needle' })
  assert.equal(result.isError, false, text(result).slice(0, 500))
  const value = result.value as { clippedLines?: boolean; matches: Array<{ path: string; lineNumber: number; line: string }> }
  assert.equal(value.clippedLines, true)
  const rows = value.matches.map(m => ({ ...m, path: m.path.replace(/^\.\//, '') })).sort((a, b) => a.path.localeCompare(b.path) || a.lineNumber - b.lineNumber)
  assert.deepEqual(rows.map(m => `${m.path}:${m.lineNumber}`), [
    ...Array.from({ length: 8 }, (_, i) => `cache/blob${i}.json:1`), 'cache/cjk.md:1', 'odd:name.txt:1', 'small.txt:1', 'small.txt:3'])
  for (const m of rows.filter(m => m.path.startsWith('cache/'))) {
    assert.ok(Buffer.byteLength(m.line) <= 2000 + ' (line truncated)'.length, `${m.path} line stays within the 2000-byte preview`)
    assert.match(m.line, /\(line truncated\)$/)
  }
  assert.equal(rows.find(m => m.path === 'small.txt' && m.lineNumber === 1)!.line, 'first clip_needle', 'CRLF is stripped like the JSON path')
  assert.equal(rows.find(m => m.path === 'odd:name.txt')!.line, 'clip_needle 1:2:3', 'colons in the name and the line survive')
  assert.match(text(result), /longer than 2000 bytes and are cut/)
  const normal = await call({ pattern: 'clip_needle', path: 'small.txt' })
  assert.equal(normal.isError, false)
  assert.equal('clippedLines' in (normal.value as object), false, 'searches under the cap keep the official shape')
}))
