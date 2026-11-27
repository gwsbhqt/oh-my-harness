import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import fs, { type FSWatcher } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mock, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Context } from '@deepseek-ai/cordis'
import * as entry from '../src/index.ts'

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 3500
  while (!(await check()) && Date.now() < end) await delay(15)
  assert.ok(await check(), '等待文件监控的结果超时')
}

async function withProfile(run: (directory: string, file: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-patch-watcher-'))
  const directory = join(home, 'profiles', 'sample')
  const file = join(directory, 'cordis.patch.initial.yml')
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(file, 'model: "sample/initial"\n')
    await run(directory, file)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    await rm(home, { recursive: true, force: true })
  }
}

function trackWatchers() {
  const original = fs.watch
  const opened: FSWatcher[] = []
  const live = new Set<FSWatcher>()
  const spy = mock.method(fs, 'watch', ((...args: Parameters<typeof fs.watch>) => {
    const watcher = original(...args)
    opened.push(watcher)
    live.add(watcher)
    watcher.once('close', () => live.delete(watcher))
    return watcher
  }) as typeof fs.watch)
  return { opened, live, spy }
}

// The native backend has terminated; emitting an error on a still-open watcher would keep delivering writes.
async function terminate(watcher: FSWatcher): Promise<void> {
  const closed = new Promise<void>(resolve => watcher.once('close', resolve))
  watcher.close()
  watcher.emit('error', Object.assign(new Error('watch failed'), { code: 'EIO' }))
  await closed
}

function logged(ctx: Context, type: 'info' | 'warn', text: string, directory: string): boolean {
  return ctx.logger.buffer.some(row => row.type === type && row.args.includes(directory) && String(row.args[0]).includes(text))
}

test('终结后只恢复一次，补读监听间隙的新文件，并继续处理下一次真实写入', async () => {
  await withProfile(async (directory, initial) => {
    const { opened, live, spy } = trackWatchers()
    const ctx = new Context()
    const fiber = ctx.plugin({ name: entry.name, apply: entry.applyPatchWatcher })
    try {
      await waitFor(async () => (await readFile(initial, 'utf8')) === 'model: sample/initial\n')
      assert.equal(opened.length, 1)
      await terminate(opened[0]!)
      assert.equal(live.size, 0)
      assert.ok(logged(ctx, 'warn', '监听中断', directory))
      const created = join(directory, 'cordis.patch.external.yml')
      await writeFile(created, 'model: "sample/gap"\n')
      await waitFor(async () => (await readFile(created, 'utf8')) === 'model: sample/gap\n')
      assert.ok(logged(ctx, 'info', '监听已恢复', directory))
      await writeFile(created, 'model: "sample/next"\n')
      await waitFor(async () => (await readFile(created, 'utf8')) === 'model: sample/next\n')
      assert.equal(opened.length, 2)
      assert.equal(live.size, 1)
    } finally {
      await fiber.dispose()
      spy.mock.restore()
    }
    await waitFor(() => live.size === 0)
  })
})

test('目录暂时消失时不登记监控，目录回来后补读已有文件', async () => {
  await withProfile(async (directory, initial) => {
    const { opened, live, spy } = trackWatchers()
    const ctx = new Context()
    const fiber = ctx.plugin({ name: entry.name, apply: entry.applyPatchWatcher })
    try {
      await waitFor(async () => (await readFile(initial, 'utf8')) === 'model: sample/initial\n')
      const closed = once(opened[0]!, 'close')
      opened[0]!.close()
      await closed
      await rm(directory, { recursive: true })
      await delay(400)
      assert.equal(spy.mock.callCount(), 1)
      assert.equal(live.size, 0)
      await mkdir(directory)
      await writeFile(initial, 'model: "sample/recreated"\n')
      await waitFor(async () => (await readFile(initial, 'utf8')) === 'model: sample/recreated\n')
      assert.equal(opened.length, 2)
      assert.equal(live.size, 1)
    } finally {
      await fiber.dispose()
      spy.mock.restore()
    }
  })
})

test('卸载清除已收到的变更和待重建的监听', async () => {
  await withProfile(async (_directory, file) => {
    const { opened, live, spy } = trackWatchers()
    const ctx = new Context()
    const fiber = ctx.plugin({ name: entry.name, apply: entry.applyPatchWatcher })
    try {
      await waitFor(async () => (await readFile(file, 'utf8')) === 'model: sample/initial\n')
      const watcher = opened[0]!
      const changed = once(watcher, 'change')
      await writeFile(file, 'model: "sample/after-stop"\n')
      await changed
      await terminate(watcher)
      await fiber.dispose()
      await delay(400)
      assert.equal(await readFile(file, 'utf8'), 'model: "sample/after-stop"\n')
      assert.equal(opened.length, 1)
      assert.equal(live.size, 0)
    } finally {
      await fiber.dispose()
      spy.mock.restore()
    }
  })
})

test('持续不能注册时逐步延迟重试，并在停止后向宿主报告原因', async t => {
  await withProfile(async (directory, initial) => {
    const failure = Object.assign(new Error('watch unavailable'), { code: 'ENOSPC' })
    const spy = mock.method(fs, 'watch', () => { throw failure })
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const ctx = new Context()
    const fiber = ctx.plugin({ name: entry.name, apply: entry.applyPatchWatcher })
    try {
      await waitFor(async () => (await readFile(initial, 'utf8')) === 'model: sample/initial\n')
      assert.equal(spy.mock.callCount(), 1)
      let count = 1
      for (const interval of [250, 1000, 4000]) {
        t.mock.timers.tick(interval - 1)
        assert.equal(spy.mock.callCount(), count)
        t.mock.timers.tick(1)
        assert.equal(spy.mock.callCount(), ++count)
      }
      assert.ok(logged(ctx, 'warn', '已停止自动重试', directory))
      assert.ok(ctx.logger.buffer.some(row => row.type === 'warn' && row.args.includes(failure)))
      t.mock.timers.tick(60_000)
      assert.equal(spy.mock.callCount(), 4)
    } finally {
      await fiber.dispose()
      spy.mock.restore()
    }
  })
})

test('能登记却反复马上终止的监控也会用尽重试次数', async t => {
  await withProfile(async (directory, initial) => {
    const spy = mock.method(fs, 'watch', ((_path: fs.PathLike, _listener: unknown) => {
      const watcher = new EventEmitter() as FSWatcher
      watcher.close = () => { watcher.emit('close') }
      setTimeout(() => watcher.close(), 1)
      return watcher
    }) as typeof fs.watch)
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const ctx = new Context()
    const fiber = ctx.plugin({ name: entry.name, apply: entry.applyPatchWatcher })
    try {
      await waitFor(async () => (await readFile(initial, 'utf8')) === 'model: sample/initial\n')
      for (const interval of [250, 1000, 4000]) {
        t.mock.timers.tick(1)
        await Promise.resolve()
        t.mock.timers.tick(interval)
      }
      t.mock.timers.tick(1)
      await Promise.resolve()
      assert.ok(logged(ctx, 'warn', '已停止自动重试', directory))
      t.mock.timers.tick(60_000)
      assert.equal(spy.mock.callCount(), 4)
    } finally {
      await fiber.dispose()
      spy.mock.restore()
    }
  })
})
