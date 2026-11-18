import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads'
import { discardStagedRelease, keepCheckedRelease, pruneUpgrade, stageRelease, swapBack, swapIn, type Exec, type FeedEntry } from '../src/cli/upgrade.ts'

const appName = 'DeepSeek Harness.app'
const team = 'Fixture-Publisher'
interface Bundle { version: string; signed: boolean; notarized: boolean; team: string; build?: string }
const bundle = (version: string): Bundle => ({ version, signed: true, notarized: true, team })
const plist = (app: string) => join(app, 'Contents', 'Info.plist')
const inspect = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Bundle
function createApp(path: string, contents: Bundle): string {
  mkdirSync(join(path, 'Contents'), { recursive: true })
  writeFileSync(plist(path), JSON.stringify(contents))
  return path
}

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'upgrade-files-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = join(root, 'upgrades')
  const installed = createApp(join(root, 'Apps', appName), bundle('1.0.0'))
  const options = { dir, installed, print: () => {} }
  function distribution(contents: Bundle, version = contents.version): FeedEntry {
    const bytes = Buffer.from(JSON.stringify(contents))
    const sha512 = createHash('sha512').update(bytes).digest('base64')
    const src = mkdtempSync(join(root, 'feed-'))
    const path = join(src, 'app.zip')
    writeFileSync(path, bytes)
    return { version, sha512, size: bytes.length, url: pathToFileURL(path).href }
  }
  return { dir, installed, options, distribution }
}

function fixtureExec(onPartial?: (path: string) => void): Exec {
  return (command, args) => {
    const ok = { status: 0, stdout: '', stderr: '' }
    const target = args.at(-1)!
    if (command === 'curl') {
      const zip = args[args.indexOf('-o') + 1]!
      const bytes = readFileSync(fileURLToPath(target))
      writeFileSync(zip, bytes.subarray(0, 1))
      onPartial?.(zip)
      appendFileSync(zip, bytes.subarray(1))
    } else if (command === 'ditto' && args[0] === '-x') {
      createApp(join(target, appName), inspect(args[2]!))
    } else if (command === 'ditto') {
      cpSync(args[0]!, target, { recursive: true })
    } else if (command === 'plutil') {
      return { ...ok, stdout: inspect(target).version }
    } else if (command === 'codesign' && args[0] === '-dv') {
      return { ...ok, stderr: `TeamIdentifier=${inspect(plist(target)).team}` }
    } else if (command === 'codesign') {
      return { ...ok, status: inspect(plist(target)).signed ? 0 : 1 }
    } else if (command === 'spctl') {
      return { ...ok, status: inspect(plist(target)).notarized ? 0 : 1 }
    } else throw new Error(`意外命令 ${command}`)
    return ok
  }
}

interface PausedDownload { dir: string; installed: string; entry: FeedEntry; gate: SharedArrayBuffer }
if (!isMainThread) {
  const { dir, installed, entry, gate } = workerData as PausedDownload
  const exec = fixtureExec((partial) => {
    parentPort!.postMessage(partial)
    if (Atomics.wait(new Int32Array(gate), 0, 0, 30_000) === 'timed-out') throw new Error('等待测试放行下载超时')
  })
  const app = await stageRelease(entry, { dir, installed, print: () => {}, exec })
  parentPort!.postMessage(app)
} else {
  test('同版与另一版可同时下载；一个安装就绪仅回收自己的文件', async (t) => {
    const f = fixture(t)
    const next = f.distribution(bundle('1.1.0'))
    const later = f.distribution(bundle('1.2.0'))
    const paused = await Promise.all([next, later].map(async (entry) => {
      const gate = new Int32Array(new SharedArrayBuffer(4))
      const worker = new Worker(new URL(import.meta.url), { workerData: { entry, dir: f.dir, installed: f.installed, gate: gate.buffer } })
      t.after(async () => { await worker.terminate() })
      const [partial] = await once(worker, 'message') as [string]
      async function resume() {
        const completion = once(worker, 'message')
        const exit = once(worker, 'exit')
        Atomics.store(gate, 0, 1)
        Atomics.notify(gate, 0)
        const [app] = await completion as [string]
        assert.deepEqual(await exit, [0])
        return app
      }
      return { partial, entry, resume }
    }))
    const exec = fixtureExec()
    const staged = await stageRelease(next, { ...f.options, exec })
    const queued = await stageRelease(next, { ...f.options, exec })
    const rebuilt = { ...bundle(next.version), build: 'reissued' }
    const otherPackage = keepCheckedRelease(f.dir, await stageRelease(f.distribution(rebuilt), { ...f.options, exec }), exec)
    assert.notEqual(staged, queued)
    const swap = swapIn(staged, f.installed, join(f.dir, 'backups'), exec)
    assert.equal(inspect(plist(swap.backup)).version, '1.0.0')
    pruneUpgrade(f.dir, swap)
    assert.equal(existsSync(swap.backup), false)
    assert.equal(inspect(plist(f.installed)).version, next.version)
    assert.equal(inspect(plist(queued)).version, next.version)
    assert.deepEqual(inspect(plist(otherPackage)), rebuilt)
    for (const { partial } of paused) assert.equal(readFileSync(partial).length, 1)
    const completed = await Promise.all(paused.map((job) => job.resume()))
    for (const [i, app] of completed.entries()) {
      assert.equal(inspect(plist(app)).version, paused[i]!.entry.version)
      discardStagedRelease(f.dir, app)
    }
    discardStagedRelease(f.dir, queued)
    assert.equal(readdirSync(f.dir, { recursive: true }).some((name) => String(name).endsWith('.part')), false)
  })

  test('重复 --check 复用下载且只留一份 App，复查期间已有的 App 仍能使用', async (t) => {
    const f = fixture(t)
    const entry = f.distribution(bundle('2.0.0'))
    const downloads: string[] = []
    const exec = fixtureExec((path) => downloads.push(path))
    const stage = () => stageRelease(entry, { ...f.options, exec })
    const first = keepCheckedRelease(f.dir, await stage(), exec)
    const inProgress = await stage()
    assert.equal(inspect(plist(first)).version, entry.version)
    const second = keepCheckedRelease(f.dir, inProgress, exec)
    assert.equal(second, first)
    assert.equal(existsSync(inProgress), false)
    discardStagedRelease(f.dir, inProgress)
    discardStagedRelease(f.dir, second)
    discardStagedRelease(f.dir, f.installed)
    assert.ok(existsSync(plist(first)))
    assert.equal(downloads.length, 1)
    const files = readdirSync(f.dir, { recursive: true }).map(String)
    assert.equal(files.filter((name) => basename(name) === 'Info.plist').length, 1)
    assert.equal(files.filter((name) => name.endsWith('.zip')).length, 1)
    const partialCopy: Exec = (command, args) => {
      if (command !== 'ditto' || args[0] !== first) return exec(command, args)
      mkdirSync(args[1]!)
      writeFileSync(join(args[1]!, 'incomplete'), 'partial')
      return { status: 1, stdout: '', stderr: '模拟复制中断' }
    }
    assert.throws(() => swapIn(first, f.installed, join(f.dir, 'backups'), partialCopy), /模拟复制中断/)
    assert.equal(inspect(plist(f.installed)).version, '1.0.0')
    const swap = swapIn(first, f.installed, join(f.dir, 'backups'), exec)
    assert.ok(existsSync(plist(first)))
    pruneUpgrade(f.dir, swap)
    assert.deepEqual(readdirSync(f.dir), [])
  })

  test('缺文件或签名损坏的已检查结果能自愈；并发修复只保留一份健康 App', async (t) => {
    const f = fixture(t)
    const good = bundle('2.0.0')
    const entry = f.distribution(good)
    let downloads = 0
    const exec = fixtureExec(() => { downloads++ })
    const stage = () => stageRelease(entry, { ...f.options, exec })
    const original = keepCheckedRelease(f.dir, await stage(), exec)
    const queued = await stage()
    const first = await stage()
    const second = await stage()
    createApp(original, { ...good, signed: false })
    let repaired: string | undefined
    const overlapping: Exec = (command, args) => {
      const result = exec(command, args)
      if (command === 'codesign' && args[0] === '--verify' && args.at(-1) === original) {
        repaired = keepCheckedRelease(f.dir, second, exec)
      }
      return result
    }
    assert.equal(keepCheckedRelease(f.dir, first, overlapping), repaired)
    assert.ok(repaired)
    assert.notEqual(repaired, original)
    assert.equal(existsSync(plist(original)), false)
    assert.deepEqual(inspect(plist(repaired)), good)
    assert.deepEqual(inspect(plist(queued)), good)

    const brokenVerifier: Exec = (cmd, args) => cmd === 'codesign' && args[0] === '--verify'
      ? { status: 1, stdout: '', stderr: '模拟校验工具不可用' } : exec(cmd, args)
    const fresh = await stage()
    assert.throws(() => keepCheckedRelease(f.dir, fresh, brokenVerifier), /模拟校验工具不可用/)
    assert.deepEqual(inspect(plist(repaired)), good)
    rmSync(plist(repaired))
    const complete = keepCheckedRelease(f.dir, await stage(), exec)
    assert.deepEqual(inspect(plist(complete)), good)
    assert.equal(keepCheckedRelease(f.dir, await stage(), exec), complete)
    discardStagedRelease(f.dir, queued)
    const files = readdirSync(f.dir, { recursive: true }).map(String)
    assert.equal(files.filter((name) => basename(name) === 'Info.plist').length, 1)
    assert.equal(downloads, 1)
    pruneUpgrade(f.dir, swapIn(complete, f.installed, join(f.dir, 'backups'), exec))
    assert.deepEqual(readdirSync(f.dir), [])
  })

  test('旧版已校验的下载可复用；安装失败时仍能用真实的备份换回', async (t) => {
    const f = fixture(t)
    const entry = f.distribution(bundle('1.1.0'))
    const previous = join(f.dir, entry.version)
    mkdirSync(previous, { recursive: true })
    cpSync(fileURLToPath(entry.url), join(previous, 'app.zip'))
    const exec = fixtureExec(() => assert.fail('应复用旧版已下载的包'))
    const staged = await stageRelease(entry, { ...f.options, exec })
    const swap = swapIn(staged, f.installed, join(f.dir, 'backups'), exec)
    swapBack(swap, exec)
    assert.equal(inspect(plist(f.installed)).version, '1.0.0')
    const failed = join(f.dir, 'failed', `DeepSeek Harness ${entry.version}.app`)
    assert.equal(inspect(plist(failed)).version, entry.version)
    discardStagedRelease(f.dir, staged)
    const retry = await stageRelease(entry, { ...f.options, exec })
    pruneUpgrade(f.dir, swapIn(retry, f.installed, join(f.dir, 'backups'), exec))
    assert.equal(existsSync(failed), false)
    assert.equal(inspect(plist(f.installed)).version, entry.version)
  })

  test('下载中断、摘要或认证失败只回收当前请求的文件', async (t) => {
    const f = fixture(t)
    const good = bundle('1.1.0')
    const entry = f.distribution(good)
    const interrupted = fixtureExec(() => { throw new Error('模拟连接中断') })
    await assert.rejects(stageRelease(entry, { ...f.options, exec: interrupted }), /模拟连接中断/)
    const invalid: [FeedEntry, RegExp][] = [
      [{ ...entry, size: entry.size! + 1 }, /大小/],
      [{ ...entry, sha512: 'YQ==' }, /sha512/],
      [f.distribution({ ...good, signed: false }), /核对签名/],
      [f.distribution({ ...good, notarized: false }), /核对公证/],
      [f.distribution({ ...good, team: 'Other-Publisher' }), /开发者/],
      [f.distribution(good, '1.2.0'), /安装包里的版本/],
    ]
    for (const [bad, error] of invalid) await assert.rejects(stageRelease(bad, { ...f.options, exec: fixtureExec() }), error)
    assert.deepEqual(readdirSync(f.dir), [])
    assert.equal(inspect(plist(f.installed)).version, '1.0.0')
  })
}
