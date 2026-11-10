import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { labelNotice, type MessageLike } from '../src/notice.ts'

const APP_ASAR = process.env.DSH_APP_ASAR ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const require = createRequire(import.meta.url)
interface Entry { files?: Record<string, Entry>; size?: number; offset?: string; unpacked?: boolean }

function appFile(parts: readonly string[]): string {
  const bytes = readFileSync(APP_ASAR)
  let entry = JSON.parse(bytes.subarray(16, 16 + bytes.readUInt32LE(12)).toString('utf8')) as Entry
  for (const part of parts) {
    const child = entry.files?.[part]
    assert.ok(child, `App archive entry missing: ${parts.join('/')}`)
    entry = child
  }
  if (entry.unpacked) return readFileSync(join(`${APP_ASAR}.unpacked`, ...parts), 'utf8')
  assert.ok(entry.offset !== undefined && entry.size !== undefined)
  const start = 8 + bytes.readUInt32LE(4) + Number(entry.offset)
  return bytes.subarray(start, start + entry.size).toString('utf8')
}

interface Decision { kind: string; feedback?: unknown; additionalContexts?: MessageLike[] }
interface HostGuard {
  Config: (input: Record<string, unknown>) => { thresholds: number[]; exclude: string[] }
  apply: (ctx: Context, config: unknown) => void
}

test('App public repeat guard excludes read/glob/grep at the counter while job_output still warns', async (t) => {
  if (!existsSync(APP_ASAR)) {
    t.skip(`App not installed at ${APP_ASAR}; set DSH_APP_ASAR to test another install`)
    return
  }
  const packagePath = ['dsh', 'node_modules', '@deepseek-ai', 'dsh-repeat-tool-reminder']
  const packageJson = appFile([...packagePath, 'package.json'])
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), 'message-tidy-app-repeat-')))
  mkdirSync(join(fixture, 'lib'))
  writeFileSync(join(fixture, 'package.json'), packageJson)
  const modulePath = join(fixture, 'lib', 'index.mjs')
  writeFileSync(modulePath, appFile([...packagePath, 'lib', 'index.js']))
  const moduleUrl = pathToFileURL(modulePath).href
  // Node cannot import from asar directly. Keep App code unchanged and resolve only its public dependencies here.
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL === moduleUrl && !specifier.startsWith('node:') && !specifier.startsWith('.')) {
      return next(pathToFileURL(require.resolve(specifier)).href, context)
    }
    return next(specifier, context)
  } })
  try {
    const guard = await import(moduleUrl) as HostGuard
    t.diagnostic(`App repeat-tool-reminder ${JSON.parse(packageJson).version}; unchanged public apply/Config`)
    const observe = (exclude: string[]) => {
      const ctx = new Context()
      const config = guard.Config({ exclude })
      assert.deepEqual(config.thresholds, [3, 5, 8])
      guard.apply(ctx, config)
      return async (agent: object, name: string, args: unknown, downstream: Decision = { kind: 'allow' }) => {
        const api = ctx as unknown as { waterfall: (...args: unknown[]) => Promise<Decision> }
        return api.waterfall('tools/post-execute', { agent, name, arguments: args }, { isError: false }, async () => downstream)
      }
    }
    const unconfigured = observe([])
    const scoped = observe(['read', 'glob', 'grep'])
    for (const name of ['read', 'glob', 'grep']) {
      const agent = {}
      const args = { file_path: 'same-file', pattern: 'same-pattern' }
      const bad: number[] = []
      const good: number[] = []
      for (let count = 1; count <= 8; count++) {
        if ((await unconfigured(agent, name, args)).additionalContexts?.length) bad.push(count)
        if ((await scoped(agent, name, args)).additionalContexts?.length) good.push(count)
      }
      assert.deepEqual(bad, [3, 5, 8], `${name}: default counter generates real App notices`)
      assert.deepEqual(good, [], `${name}: public exclusion generates no notice at source`)
    }
    const agent = {}
    const polls: number[] = []
    for (let count = 1; count <= 8; count++) {
      await scoped(agent, 'read', { file_path: 'same-file' })
      const result = await scoped(agent, 'job_output', { job_id: 'fixture-job' })
      const notice = result.additionalContexts?.[0]
      if (notice) {
        polls.push(count)
        assert.deepEqual(Object.keys(notice.source!).sort(), ['form', 'kind', 'summary'])
        assert.equal(notice.source!.kind, 'repeat-tool-reminder')
        assert.equal(notice.source!.summary, `job_output × ${count}`)
        const framed = labelNotice(notice, ['repeat-tool-reminder'])
        assert.equal(framed.source, notice.source)
        assert.equal(framed.role, notice.role)
        assert.equal(labelNotice(framed, ['repeat-tool-reminder']), framed)
        assert.ok(framed.content[0]!.text!.includes(notice.content[0]!.text!))
      }
    }
    assert.deepEqual(polls, [3, 5, 8], 'excluded reads cannot hide repeated polling')
    assert.equal((await scoped({}, 'job_output', { job_id: 'fixture-job' })).additionalContexts, undefined)
    const blockedAgent = {}
    const downstream = { kind: 'block', feedback: 'denied' }
    await scoped(blockedAgent, 'job_output', {}, downstream)
    await scoped(blockedAgent, 'job_output', {}, downstream)
    const blocked = await scoped(blockedAgent, 'job_output', {}, downstream)
    assert.equal(blocked.kind, 'block')
    assert.equal(blocked.feedback, downstream.feedback)
    assert.equal(blocked.additionalContexts?.length, 1)
  } finally {
    hooks.deregister()
    rmSync(fixture, { recursive: true, force: true })
  }
})
