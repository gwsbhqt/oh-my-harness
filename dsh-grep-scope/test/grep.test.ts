import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { rgPath } from '@vscode/ripgrep'
import { grepArgv, parseClippedMatches, renderGrep, searchMeta, shouldSpill } from '../src/index.ts'

function fixture(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'grep-scope-'))
  try {
    mkdirSync(join(dir, '.hidden'))
    mkdirSync(join(dir, 'ignored'))
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.gitignore'), 'ignored/\n')
    for (const [path, line] of [
      ['visible.txt', 'scope_needle visible'],
      ['.hidden/secret.txt', 'scope_needle hidden'],
      ['ignored/cache.txt', 'scope_needle ignored'],
      ['.git/config', 'scope_needle vcs'],
    ]) writeFileSync(join(dir, path!), line + '\n')
    fn(dir)
  } finally { rmSync(dir, { force: true, recursive: true }) }
}

function realSearch(dir: string, args: Parameters<typeof grepArgv>[0]) {
  const run = spawnSync(rgPath, ['--no-config', ...grepArgv(args)], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(run.status, 0, run.stderr)
  return parseClippedMatches(run.stdout, [args.path ?? './']).matches.map(row => row.path.replace(/^\.\//, ''))
}

test('normal and all scope find distinct real files, excluding VCS metadata', () => fixture(dir => {
  assert.deepEqual(realSearch(dir, { pattern: 'scope_needle' }), ['visible.txt'])
  assert.deepEqual(realSearch(dir, { pattern: 'scope_needle', scope: 'all' }).sort(),
    ['.hidden/secret.txt', 'ignored/cache.txt', 'visible.txt'])
  assert.deepEqual(realSearch(dir, { pattern: 'scope_needle', scope: 'all', path: '.hidden' }),
    ['.hidden/secret.txt'])
  assert.deepEqual(realSearch(dir, { pattern: 'scope_needle', scope: 'all', include: '*.txt' }).sort(),
    ['.hidden/secret.txt', 'ignored/cache.txt', 'visible.txt'])
  // A catch-all include must not re-admit VCS metadata (ripgrep: the last matching glob wins).
  for (const include of ['*', '**', '**/*']) {
    assert.deepEqual(realSearch(dir, { pattern: 'scope_needle', scope: 'all', include }).sort(),
      ['.hidden/secret.txt', 'ignored/cache.txt', 'visible.txt'], include)
  }
  const vcs = spawnSync(rgPath, ['--no-config', ...grepArgv({ pattern: 'scope_needle', scope: 'all', path: '.git' })], { cwd: dir, encoding: 'utf8' })
  assert.equal(vcs.status, 1, vcs.stderr)
}))

test('实际搜索包含换行的相对和绝对路径时保留完整文件名', () => fixture(dir => {
  const file = 'odd\nname.txt'
  writeFileSync(join(dir, file), 'newline_needle\n')
  assert.deepEqual(realSearch(dir, { pattern: 'newline_needle', path: file }), [file])
  assert.deepEqual(realSearch(dir, { pattern: 'newline_needle', path: join(dir, file) }), [join(dir, file)])
}))

test('包含二进制提示文字的文件名仍完整保留', () => fixture(dir => {
  const file = ': binary file matches (found "\\0" byte around offset 5)\ntext.txt'
  writeFileSync(join(dir, file), 'special_needle\n')
  assert.deepEqual(realSearch(dir, { pattern: 'special_needle' }), [file])
}))

test('混合搜索二进制和带换行的文本文件时保留文本文件名', () => fixture(dir => {
  const binary = join(dir, 'binary')
  const text = join(dir, 'multi\nline.txt')
  writeFileSync(binary, Buffer.from('needle\0binary\n'))
  writeFileSync(text, 'needle\n')
  const roots = [binary, text]
  const run = spawnSync(rgPath, ['--no-config', ...grepArgv({ pattern: 'needle' }, roots)], { cwd: dir, encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.deepEqual(parseClippedMatches(run.stdout, roots).matches.map(match => match.path), [text])
}))

test('the text parser keeps names with colons or newlines, CRLF, binary notices and cut lines straight', () => {
  const out = './a:b.txt\u00003:x:1 needle\r\n' + './we\nird.txt\u00001:needle\n' + 'bin.dat: binary file matches (found "\\0" byte around offset 2)\n' + './long.txt\u00002:' + 'y'.repeat(2000) + ' [... omitted end of long line]\n'
  const { matches, clippedLines } = parseClippedMatches(out, ['bin.dat'])
  assert.deepEqual(matches.map(m => [m.path, m.lineNumber]), [['./a:b.txt', 3], ['./we\nird.txt', 1], ['./long.txt', 2]])
  assert.equal(matches[0]!.line, 'x:1 needle')
  assert.match(matches[2]!.line, /^y+ \(line truncated\)$/)
  assert.equal(clippedLines, true)
  assert.equal(parseClippedMatches('./a.txt\u00001:ok\n').clippedLines, undefined)
  assert.throws(() => parseClippedMatches('./a.txt\u0000no-number\n'), /malformed/)
})

test('scope is explicit in empty and capped output; input validation follows official grep', () => {
  assert.match(renderGrep({ pattern: 'scope_needle' }, { matches: [] }), /normal[^]*No matches found in the selected scope/)
  assert.match(renderGrep({ pattern: 'scope_needle', scope: 'all' }, { matches: [] }), /all.*hidden and ignored included/)
  const matches = Array.from({ length: 251 }, (_, i) => ({ path: 'file', lineNumber: i + 1, line: 'x' }))
  assert.match(renderGrep({ pattern: 'scope_needle', scope: 'all' }, { matches }), /Found 250 of 251 matches/)
  assert.deepEqual(searchMeta(matches).total, 251)
  assert.deepEqual(searchMeta(matches).truncated, true)
  assert.throws(() => grepArgv({ pattern: '' }), /non-empty/)
  assert.throws(() => grepArgv({ pattern: 'foo', include: '!*.txt' }), /positive glob/)
  assert.deepEqual(grepArgv({ pattern: '-foo', path: '-bar' }).slice(-2), ['--', '-bar'])
})

test('spill only applies to accepted direct call owned by replacement', () => {
  const tool = {}
  const ctx = { tools: { get: () => tool } }
  const exec = { name: 'grep', parent: undefined, agent: {} }
  const outcome = { isError: false }
  assert.equal(shouldSpill(ctx as never, tool, exec as never, outcome, { kind: 'accept' }), true)
  assert.equal(shouldSpill(ctx as never, tool, { ...exec, parent: Symbol() } as never, outcome, { kind: 'accept' }), false)
  assert.equal(shouldSpill(ctx as never, tool, exec as never, outcome, { kind: 'accept', content: [] }), false)
  assert.equal(shouldSpill(ctx as never, {}, exec as never, outcome, { kind: 'accept' }), false)
})
