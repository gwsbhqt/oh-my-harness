import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyLoginEnv, dropLauncherProxies, launchdProxies, parseLoginEnv, patchSnapshot, proxyEnvironment, readLoginEnv, reportingDisposer } from '../src/index.ts'

const MARK = Buffer.from('__DSH_LOGIN_ENV__\0')
const nul = (...entries: string[]): Buffer => Buffer.from(entries.map(entry => `${entry}\0`).join(''))

test('parseLoginEnv reads NUL-separated pairs after the marker and ignores shell chatter before it', () => {
  const output = Buffer.concat([Buffer.from('welcome\n'), MARK, nul('PATH=/a:/b', 'MULTI=line1\nline2', 'EMPTY=', 'EQ=a=b')])
  assert.deepEqual(parseLoginEnv(output), { PATH: '/a:/b', MULTI: 'line1\nline2', EMPTY: '', EQ: 'a=b' })
})

test('parseLoginEnv refuses output without the marker instead of applying garbage', () => {
  assert.throws(() => parseLoginEnv(Buffer.from('PATH=/x\0')), /marker/)
})

test('applyLoginEnv fills missing names, overrides different ones, and leaves harness-owned names alone', () => {
  const target: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', HOME: '/h', DSH_HOME: '/dsh', ELECTRON_RUN_AS_NODE: '1', LAUNCHER_ONLY: 'x' }
  const changed = applyLoginEnv({
    PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: '/h', KIMI_API_KEY: 'k',
    DSH_HOME: '/elsewhere', ELECTRON_RUN_AS_NODE: '0', PWD: '/tmp', SHLVL: '2', _: '/usr/bin/env',
  }, target)
  assert.deepEqual(changed, { PATH: '/opt/homebrew/bin:/usr/bin:/bin', KIMI_API_KEY: 'k' })
  assert.deepEqual(target, {
    PATH: '/opt/homebrew/bin:/usr/bin:/bin', HOME: '/h', KIMI_API_KEY: 'k',
    DSH_HOME: '/dsh', ELECTRON_RUN_AS_NODE: '1', LAUNCHER_ONLY: 'x',
  })
})

test('patchSnapshot answers the inherited layer from the login values and restores the original methods', () => {
  const base = new Map<string, { value: string, source: 'process' | 'user-env' }>([
    ['PATH', { value: '/usr/bin', source: 'process' }],
    ['FROM_FILE', { value: 'f', source: 'user-env' }],
  ])
  const snapshot = {
    getFrom: (key: string, sources: readonly string[]) => {
      const hit = base.get(key)
      return hit !== undefined && sources.includes(hit.source) ? hit : undefined
    },
    get(key: string) { return this.getFrom(key, ['process', 'project-env', 'user-env']) },
  }
  const { get, getFrom } = snapshot
  const restore = patchSnapshot(snapshot, { PATH: '/opt/homebrew/bin:/usr/bin', KIMI_API_KEY: 'k', PWD: '/tmp' })
  assert.ok(restore)
  assert.deepEqual(snapshot.get('PATH'), { value: '/opt/homebrew/bin:/usr/bin', source: 'process' })
  assert.deepEqual(snapshot.getFrom('KIMI_API_KEY', ['process']), { value: 'k', source: 'process' })
  assert.equal(snapshot.getFrom('KIMI_API_KEY', ['project-env', 'user-env']), undefined, 'file layers are not rewritten')
  assert.deepEqual(snapshot.get('FROM_FILE'), { value: 'f', source: 'user-env' })
  assert.equal(snapshot.get('PWD'), undefined, 'probe-shell names are not published')
  restore()
  assert.equal(snapshot.get, get)
  assert.equal(snapshot.getFrom, getFrom)
})

test('patchSnapshot keeps a layer wrapped over it on restore and then only forwards', () => {
  const snapshot = {
    getFrom: (key: string, sources: readonly string[]) =>
      key === 'PATH' && sources.includes('process') ? { value: '/usr/bin', source: 'process' as const } : undefined,
    get(key: string) { return this.getFrom(key, ['process', 'project-env', 'user-env']) },
  }
  const restore = patchSnapshot(snapshot, { PATH: '/login/bin' })
  assert.ok(restore)
  const ours = snapshot.getFrom
  const outer = (key: string, sources: readonly string[]) => key === 'OUTER' ? { value: 'o', source: 'process' as const } : ours(key, sources)
  snapshot.getFrom = outer
  restore()
  assert.equal(snapshot.getFrom, outer, 'the later layer stays installed')
  assert.deepEqual(snapshot.getFrom('PATH', ['process']), { value: '/usr/bin', source: 'process' }, 'our layer no longer answers')
  assert.deepEqual(snapshot.get('PATH'), { value: '/usr/bin', source: 'process' })
  assert.deepEqual(snapshot.get('OUTER'), { value: 'o', source: 'process' })
})

test('reportingDisposer waits for the host proxy disposer and reports its failure instead of rejecting', async () => {
  const reported: unknown[] = []
  const failure = new Error('close failed')
  let finished = false
  const dispose = reportingDisposer(async () => {
    await new Promise(resolve => setTimeout(resolve, 5))
    finished = true
    throw failure
  }, error => reported.push(error))
  await dispose()
  assert.equal(finished, true)
  assert.deepEqual(reported, [failure])
})

test('patchSnapshot leaves an unknown host shape alone', () => {
  assert.equal(patchSnapshot(undefined, { PATH: '/x' }), undefined)
  assert.equal(patchSnapshot({ get: 1 }, { PATH: '/x' }), undefined)
})

test('readLoginEnv runs the shell as a login shell from a clean base, whatever the launcher passed', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-env-'))
  try {
    // A stand-in login shell: records its argv and the PATH it was given, then emits an environment.
    const shell = join(dir, 'fakesh')
    writeFileSync(shell, `#!/bin/sh
printf 'rc noise\\n'
printf '%s\\0' __DSH_LOGIN_ENV__
printf 'GOT_ARGS=%s|%s\\0' "$1" "$2"
printf 'GOT_PATH=%s\\0' "$PATH"
printf 'GOT_STRAY=%s\\0' "$STRAY"
printf 'PATH=/login/bin:/usr/bin\\0'
`)
    chmodSync(shell, 0o755)
    const env = readLoginEnv(shell, { HOME: dir, USER: 'me', PATH: '/launcher/weird', STRAY: 'leaked' }, undefined, {})
    assert.equal(env.GOT_ARGS, '-l|-c')
    assert.equal(env.GOT_PATH, '/usr/bin:/bin:/usr/sbin:/sbin')
    assert.equal(env.GOT_STRAY, '')
    assert.equal(env.PATH, '/login/bin:/usr/bin')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readLoginEnv hands the launchd session proxies to the shell, and the shell config still wins', { skip: process.platform === 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'login-env-'))
  try {
    const shell = join(dir, 'fakesh')
    writeFileSync(shell, `#!/bin/sh
printf '%s\\0' __DSH_LOGIN_ENV__
printf 'https_proxy=%s\\0' "$https_proxy"
printf 'NO_PROXY=override\\0'
`)
    chmodSync(shell, 0o755)
    const env = readLoginEnv(shell, { HOME: dir, USER: 'me', https_proxy: 'http://launcher:1' }, undefined,
      { https_proxy: 'http://127.0.0.1:7890', NO_PROXY: 'from-launchd' })
    assert.equal(env.https_proxy, 'http://127.0.0.1:7890', 'the launchd value reaches the shell, not the launcher one')
    assert.equal(env.NO_PROXY, 'override')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('launchdProxies collects only the proxy names launchd holds', () => {
  const held: Record<string, string> = { HTTPS_PROXY: 'http://127.0.0.1:7890', no_proxy: 'x', PATH: '/nope' }
  assert.deepEqual(launchdProxies(name => held[name]), { HTTPS_PROXY: 'http://127.0.0.1:7890', no_proxy: 'x' })
})

test('readLoginEnv reads the real account shell end to end', { skip: process.platform === 'win32' || process.env.SHELL === undefined }, () => {
  const env = readLoginEnv(process.env.SHELL!)
  assert.ok((env.PATH ?? '').split(':').length > 4, `login PATH looks empty: ${env.PATH}`)
})

test('dropLauncherProxies removes proxy names the login shell does not export and keeps the rest', () => {
  const target: NodeJS.ProcessEnv = { HTTPS_PROXY: 'http://launcher:1', https_proxy: 'http://launcher:1', NO_PROXY: 'x', PATH: '/p' }
  const dropped = dropLauncherProxies({ NO_PROXY: 'login' }, target)
  assert.deepEqual(dropped.sort(), ['HTTPS_PROXY', 'https_proxy'])
  assert.deepEqual(target, { NO_PROXY: 'x', PATH: '/p' })
})

test('proxyEnvironment answers from the login shell, falls back to the .env layers, and never the launcher', () => {
  const files = {
    getFrom: (key: string, sources: readonly string[]) =>
      key === 'ALL_PROXY' && sources.includes('user-env') ? { value: 'http://file:3', source: 'user-env' as const } : undefined,
  }
  const env = proxyEnvironment({ https_proxy: 'http://127.0.0.1:7890' }, files)
  assert.equal(env.get('https_proxy')?.value, 'http://127.0.0.1:7890')
  assert.equal(env.get('ALL_PROXY')?.value, 'http://file:3')
  assert.equal(env.get('HTTP_PROXY'), undefined)
})
