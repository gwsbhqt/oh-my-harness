import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { executeOne, mountAgents, mountNativeTools } from './host.ts'
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { fakeWorkingDirectory } from './working-directory.ts'
import { apply, archiveRedirect, asarCopy, asarParts } from '../src/index.ts'

type Tree = { [name: string]: string | Tree | { unpacked: string } }
type Value = { matches: Array<{ path: string; lineNumber: number; line: string }>; asar?: { archive: string; copy: string } }

/** Writes an asar archive in Electron's format: pickled JSON header, then the packed file bytes. */
function writeAsar(path: string, tree: Tree): void {
  const chunks: Buffer[] = []
  let offset = 0
  const unpackedRoot = path + '.unpacked'
  const header = (node: Tree, dir: string): object => ({
    files: Object.fromEntries(Object.entries(node).map(([name, child]) => {
      if (typeof child === 'string') {
        const bytes = Buffer.from(child)
        chunks.push(bytes)
        const entry = { size: bytes.length, offset: String(offset) }
        offset += bytes.length
        return [name, entry]
      }
      if ('unpacked' in child && typeof child.unpacked === 'string') {
        const real = join(unpackedRoot, dir, name)
        mkdirSync(join(real, '..'), { recursive: true })
        writeFileSync(real, child.unpacked)
        return [name, { size: Buffer.byteLength(child.unpacked), unpacked: true }]
      }
      return [name, header(child as Tree, join(dir, name))]
    })),
  })
  const json = Buffer.from(JSON.stringify(header(tree, '')))
  const padded = Math.ceil(json.length / 4) * 4
  const head = Buffer.alloc(16 + padded)
  head.writeUInt32LE(4, 0)
  head.writeUInt32LE(8 + padded, 4)
  head.writeUInt32LE(4 + padded, 8)
  head.writeUInt32LE(json.length, 12)
  json.copy(head, 16)
  writeFileSync(path, Buffer.concat([head, ...chunks]))
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve))

async function harness(fn: (call: (args: Record<string, unknown>, name?: string) => Promise<{ isError: boolean; value?: unknown }>, dir: string, home: string) => Promise<void>) {
  const ctx = new Context()
  await mountAgents(ctx)
  await ctx.plugin(SystemPrompt)
  await mountNativeTools(ctx)
  await ctx.plugin(LocalSubprocessRuntime)
  ctx.provide('workingDirectory', fakeWorkingDirectory() as never)
  await tick()
  const dir = mkdtempSync(join(tmpdir(), 'grep-scope-asar-'))
  const home = join(dir, 'dsh-home')
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const agent = { id: 'asar-agent', sessionId: 'asar-agent' } as unknown as Agent
  const scope = createScope(ctx, agent)
  Object.defineProperty(agent, 'ctx', { value: scope.ctx })
  Object.defineProperty(agent, 'session', { value: { id: 'asar-agent', header: { id: 'asar-agent', cwd: dir } } })
  const stop = ctx.agents.register(agent)
  const plugin = await ctx.plugin({ apply, inject: ['tools', 'subprocess', 'systemPrompt', 'agents', 'workingDirectory'] })
  await tick()
  const registry = ctx.get('tools')!
  // Stand-ins for the host read/glob: they just echo the path they were given.
  for (const name of ['read', 'glob']) {
    registry.register(defineTool({
      name, description: `fake ${name}`,
      parameters: { file_path: { type: 'string' }, path: { type: 'string' }, pattern: { type: 'string' } },
      output: { schema: { type: 'object', additionalProperties: false, properties: { got: { type: 'string', required: true } } }, render: () => [] },
      execute: async (args) => ({ got: String(args.file_path ?? args.path) }),
    }))
  }
  let n = 0
  const call = (args: Record<string, unknown>, name = 'grep') => executeOne(registry, {
    callId: `asar-${n++}` as never, name, arguments: args, agent, signal: new AbortController().signal,
  }) as never
  try { await fn(call, dir, home) } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await plugin.dispose()
    stop()
    await scope.dispose()
    rmSync(dir, { recursive: true, force: true })
  }
}

const text = (result: unknown) => JSON.stringify(result)
const paths = (result: { value?: unknown }) => (result.value as Value).matches.map(m => m.path).sort()

test('asarParts splits archive and inner path, and refuses to climb out of the archive', () => {
  assert.deepEqual(asarParts('app.asar/dsh/lib/', '/w'), { archive: '/w/app.asar', inner: 'dsh/lib' })
  assert.deepEqual(asarParts('/x/app.asar', '/w'), { archive: '/x/app.asar', inner: '' })
  assert.deepEqual(asarParts('app.asar/./dsh//a.js', '/w'), { archive: '/w/app.asar', inner: 'dsh/a.js' })
  assert.equal(asarParts('app.asar/../etc', '/w'), undefined)
  assert.equal(asarParts('src/app.asar.unpacked/x', '/w'), undefined)
  assert.equal(asarParts('src/index.ts', '/w'), undefined)
})

test('a search path inside an asar archive finds packed and unpacked files and reports archive paths', () => harness(async (call, dir, home) => {
  writeAsar(join(dir, 'app.asar'), {
    'package.json': '{"name":"fixture"}\n',
    dsh: {
      lib: { 'a.js': 'const x = "asar_needle packed"\n', '.hidden.js': 'asar_needle hidden\n' },
      bin: { 'tool.js': { unpacked: 'asar_needle unpacked\n' } },
      'other.txt': 'nothing here\n',
    },
  })
  const result = await call({ pattern: 'asar_needle', path: 'app.asar/dsh' })
  assert.equal(result.isError, false, text(result))
  assert.deepEqual(paths(result), ['app.asar.unpacked/dsh/bin/tool.js', 'app.asar/dsh/lib/a.js'])
  const value = result.value as Value
  assert.equal(value.asar?.archive, join(dir, 'app.asar'))
  assert.ok(value.asar!.copy.startsWith(join(home, 'plugins', 'grep-scope', 'asar')), value.asar!.copy)
  assert.ok(existsSync(join(value.asar!.copy, 'dsh', 'lib', 'a.js')), 'the reported copy is readable at the mapped path')
  assert.match(text(result), /extracted copy/)
  const all = await call({ pattern: 'asar_needle', path: join(dir, 'app.asar') + '/', scope: 'all', include: '*.js' })
  assert.equal(all.isError, false, text(all))
  assert.deepEqual(paths(all), ['app.asar.unpacked/dsh/bin/tool.js', 'app.asar/dsh/lib/.hidden.js', 'app.asar/dsh/lib/a.js'])
  const file = await call({ pattern: 'packed', path: 'app.asar/dsh/lib/a.js' })
  assert.deepEqual(paths(file), ['app.asar/dsh/lib/a.js'])
  const none = await call({ pattern: 'absent_needle_xyz', path: 'app.asar/dsh' })
  assert.equal(none.isError, false, text(none))
  assert.deepEqual(paths(none), [])
  const missing = await call({ pattern: 'x', path: 'app.asar/no/such' })
  assert.equal(missing.isError, true)
  assert.match(text(missing), /路径不存在[^]*no\/such/)
}))

test('read aimed inside an asar archive is stopped with the readable copy path, glob lists the copy, other paths pass through', () => harness(async (call, dir, home) => {
  writeAsar(join(dir, 'app.asar'), {
    dsh: { lib: { 'a.js': 'packed\n' }, bin: { 'tool.js': { unpacked: 'unpacked\n' } } },
  })
  const packed = await call({ file_path: 'app.asar/dsh/lib/a.js' }, 'read')
  assert.equal(packed.isError, true)
  const copy = text(packed).match(/只读副本[^:：]*[:：](\S+?)(?:\\n|")/)?.[1]
  assert.ok(copy !== undefined && copy.startsWith(join(home, 'plugins', 'grep-scope', 'asar')), text(packed))
  assert.ok(copy.endsWith(join('dsh', 'lib', 'a.js')) && existsSync(copy), copy)
  const listed = await call({ pattern: '**/*.js', path: join(dir, 'app.asar', 'dsh') }, 'glob')
  assert.equal(listed.isError, false, text(listed))
  const globbed = (listed.value as { paths: string[] }).paths.map(path => resolve(dir, path))
  assert.ok(globbed.some(path => path.startsWith(join(home, 'plugins', 'grep-scope', 'asar')) && path.endsWith(join('dsh', 'lib', 'a.js')) && existsSync(path)), text(listed))
  assert.ok(globbed.includes(join(dir, 'app.asar.unpacked', 'dsh', 'bin', 'tool.js')), text(listed))
  const globMissing = await call({ pattern: '*', path: 'app.asar/no/such' }, 'glob')
  assert.equal(globMissing.isError, true)
  assert.match(text(globMissing), /glob 路径不存在[^]*no\/such/)
  const unpacked = await call({ file_path: 'app.asar/dsh/bin/tool.js' }, 'read')
  assert.match(text(unpacked), new RegExp(`${join(dir, 'app.asar.unpacked', 'dsh', 'bin', 'tool.js').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  const missing = await call({ file_path: 'app.asar/dsh/nope.js' }, 'read')
  assert.equal(missing.isError, true)
  assert.match(text(missing), /read 路径不存在[^]*dsh\/nope\.js/)
  writeFileSync(join(dir, 'plain.txt'), 'hello\n')
  const plain = await call({ file_path: 'plain.txt' }, 'read')
  assert.equal(plain.isError, false, text(plain))
  assert.equal((plain.value as { got: string }).got, 'plain.txt')
  const archiveItself = await call({ pattern: '*', path: dir }, 'glob')
  assert.equal(archiveItself.isError, false, 'a directory that merely contains an archive is untouched')
}))

test('a copy path left over from before an App update is moved to the current copy', () => harness(async (call, dir, home) => {
  const archive = join(dir, 'app.asar')
  writeAsar(archive, { dsh: { 'a.js': 'stale_needle one\n' } })
  const first = await call({ pattern: 'stale_needle', path: 'app.asar/dsh' })
  const old = (first.value as Value).asar!.copy
  writeAsar(archive, { dsh: { 'a.js': 'stale_needle one, now longer\n' } })
  const second = await call({ pattern: 'stale_needle', path: 'app.asar/dsh' })
  const fresh = (second.value as Value).asar!.copy
  assert.notEqual(fresh, old)
  assert.equal(existsSync(old), false, 'the old copy is gone, as after a real App update')
  const grepOld = await call({ pattern: 'now longer', path: join(old, 'dsh') })
  assert.equal(grepOld.isError, false, text(grepOld))
  assert.equal((grepOld.value as Value).matches.length, 1)
  const globOld = await call({ pattern: '*.js', path: join(old, 'dsh') }, 'glob')
  assert.equal(globOld.isError, false, text(globOld))
  assert.deepEqual((globOld.value as { paths: string[] }).paths.map(path => resolve(dir, path)), [join(fresh, 'dsh', 'a.js')])
  const readOld = await call({ file_path: join(old, 'dsh', 'a.js') }, 'read')
  assert.equal(readOld.isError, true)
  assert.match(text(readOld), new RegExp(`已随 App 更新[^]*${join(fresh, 'dsh', 'a.js').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
  assert.ok(home.length > 0)
}))

test('archiveRedirect ignores other tools, other arguments and non-archive .asar files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grep-scope-redirect-'))
  try {
    writeFileSync(join(dir, 'fake.asar'), 'not an archive\n')
    assert.equal(await archiveRedirect('write', { file_path: 'x.asar/a' }, dir), undefined)
    assert.equal(await archiveRedirect('read', { path: 'x.asar/a' }, dir), undefined)
    assert.equal(await archiveRedirect('read', { file_path: 'fake.asar/a' }, dir), undefined, 'leave the host error for a file that is not an archive')
    assert.equal(await archiveRedirect('read', { file_path: 'fake.asar' }, dir), undefined)
    assert.equal(await archiveRedirect('read', undefined, dir), undefined)
    assert.equal(await archiveRedirect('glob', { path: 'x.asar/a' }, dir), undefined, 'glob is replaced, not redirected')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a file named .asar that is not an archive is reported, not silently treated as empty', () => harness(async (call, dir) => {
  writeFileSync(join(dir, 'app.asar'), 'not a directory\n')
  const inner = await call({ pattern: 'x', path: 'app.asar/dsh' })
  assert.equal(inner.isError, true)
  assert.match(text(inner), /不是可识别的 Electron 打包文件/)
  const plain = await call({ pattern: 'directory', path: 'app.asar' })
  assert.equal(plain.isError, false, 'the file itself is still searchable as a file')
  assert.deepEqual(paths(plain), ['app.asar'])
}))

test('the copy is rebuilt when the archive size or mtime changes, and the old copy is removed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'grep-scope-asar-key-'))
  const cache = join(dir, 'cache')
  const archive = join(dir, 'app.asar')
  try {
    writeAsar(archive, { 'a.txt': 'version one\n' })
    const first = await asarCopy(archive, cache)
    assert.equal(first?.built, true)
    const again = await asarCopy(archive, cache)
    assert.deepEqual(again, { copy: first!.copy, built: false })
    const [one, two] = await Promise.all([asarCopy(join(dir, 'other.asar'), cache).catch(() => 'missing'), asarCopy(archive, cache)])
    assert.equal(one, 'missing')
    assert.equal(two?.built, false)
    writeAsar(archive, { 'a.txt': 'version two, longer\n' })
    const second = await asarCopy(archive, cache)
    assert.equal(second?.built, true)
    assert.notEqual(second!.copy, first!.copy)
    assert.equal(existsSync(first!.copy), false, 'the copy of the replaced archive is cleaned up')
    const size = statSync(archive).size
    writeAsar(archive, { 'a.txt': 'version six, longer\n' })
    assert.equal(statSync(archive).size, size)
    utimesSync(archive, new Date(), new Date(Date.now() + 5000))
    const third = await asarCopy(archive, cache)
    assert.equal(third?.built, true, 'same size, new mtime still rebuilds')
    assert.deepEqual(readdirSync(cache), [third!.copy.slice(cache.length + 1)])
    const concurrent = await Promise.all([1, 2, 3].map(() => asarCopy(archive, cache)))
    assert.ok(concurrent.every(row => row?.copy === third!.copy))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

const appArchive = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

test('the real DeepSeek Harness app.asar is searchable for a known string', { skip: !existsSync(appArchive), timeout: 300_000 }, () => harness(async (call) => {
  const started = Date.now()
  const result = await call({ pattern: 'old_string was not found in', path: appArchive + '/dsh/node_modules/@deepseek-ai/dsh-fs-local' })
  const cold = Date.now() - started
  assert.equal(result.isError, false, text(result))
  const hits = paths(result)
  assert.ok(hits.includes(appArchive + '/dsh/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js'), hits.join('\n'))
  const warmStart = Date.now()
  const warm = await call({ pattern: 'old_string was not found in', path: appArchive + '/dsh' })
  const hot = Date.now() - warmStart
  assert.equal(warm.isError, false, text(warm))
  assert.ok(paths(warm).length >= hits.length)
  console.log(`real app.asar: first search ${cold} ms (includes extraction), cached search of dsh/ ${hot} ms, ${paths(warm).length} matches`)
}))
