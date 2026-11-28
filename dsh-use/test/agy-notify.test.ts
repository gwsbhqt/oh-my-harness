import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgyDeliveryError, createAgyNotifier, formatNotifyTarget, parseAgyNotifyTarget } from '../src/agy-notify.ts'
import { DoneWatcher, type DoneWatchRecord } from '../src/done-watch.ts'
import { createCli } from '../src/cli/core.ts'
import { RemoteService, type CommandResult } from '../src/service.ts'
import { fromShared } from '../src/models.ts'

test('parseAgyNotifyTarget 与 formatNotifyTarget：识别 agy: 前缀并保留普通 DSH 会话', () => {
  assert.equal(parseAgyNotifyTarget('session-aaaa1111'), undefined)
  assert.equal(parseAgyNotifyTarget('agy:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  assert.equal(parseAgyNotifyTarget('  AGY:aaaaaaaa  '), 'aaaaaaaa')
  assert.equal(parseAgyNotifyTarget('agy:   '), '')
  assert.equal(formatNotifyTarget('agy:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), 'Antigravity 会话 aaaaaaaa')
  assert.equal(formatNotifyTarget('session-bbbb2222-0000'), '会话 bbbb2222')
})

test('agy-use 命令只从已知安装位置或 PATH 查找', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-use-agy-bin-'))
  try {
    const binDir = join(dir, '.local', 'bin')
    mkdirSync(binDir, { recursive: true })
    const installed = join(binDir, 'agy-use')
    writeFileSync(installed, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const commands: string[] = []
    for (const HOME of [dir, join(dir, 'absent')]) {
      const notifier = createAgyNotifier({
        env: { HOME, AGY_USE_BIN: '/custom/agy-use' },
        run: async (command) => {
          commands.push(command)
          return { code: 69, stdout: '', stderr: '' }
        },
      })
      await assert.rejects(notifier.resolve('1234'), /没有发送消息/)
    }
    assert.deepEqual(commands, [installed, 'agy-use'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('createAgyNotifier.resolve：核对并规范化前缀、拒绝已归档/未初始化空白会话与不存在目标，不读任何密钥', async () => {
  const calls: string[][] = []
  const notifier = createAgyNotifier({
    command: '/fake/agy-use',
    socketPath: '/tmp/fake-bridge.sock',
    run: async (_cmd, args) => {
      calls.push([...args])
      const target = args[1]
      if (target === 'aaaaaaaa') {
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            ok: true,
            conversation_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            conversation: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', archived: false },
            transcript: { exists: true, total_steps: 2, last_step_index: 1 },
          }),
        }
      }
      if (target === 'blank1') {
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            ok: true,
            conversation_id: 'blank1-0000-0000-0000-000000000001',
            conversation: { id: 'blank1-0000-0000-0000-000000000001', archived: false },
            transcript: { exists: false, total_steps: 0 },
          }),
        }
      }
      if (target === 'archived1') {
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            ok: true,
            conversation_id: 'archived1-0000-0000-0000-000000000001',
            conversation: { id: 'archived1-0000-0000-0000-000000000001', archived: true },
            transcript: { exists: true, total_steps: 2, last_step_index: 1 },
          }),
        }
      }
      if (target === 'missing1') {
        return {
          code: 2,
          stderr: '',
          stdout: JSON.stringify({ ok: false, error_code: 'target-not-found', error: '未找到会话' }),
        }
      }
      return {
        code: 69,
        stderr: '',
        stdout: JSON.stringify({ ok: false, error_code: 'sidecar-unavailable', error: 'Sidecar 未启动' }),
      }
    },
  })

  const canonical = await notifier.resolve('aaaaaaaa')
  assert.equal(canonical, 'agy:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  assert.deepEqual(calls[0], ['get', 'aaaaaaaa', '--active-only', '--no-metadata', '--socket', '/tmp/fake-bridge.sock'])

  await assert.rejects(notifier.resolve('blank1'), /尚未开始首轮对话/)
  await assert.rejects(notifier.resolve('archived1'), /已归档/)
  await assert.rejects(notifier.resolve('missing1'), /未找到会话/)
  await assert.rejects(notifier.resolve('down1'), /Sidecar 未启动/)
  await assert.rejects(notifier.resolve('--bad-flag'), /格式无效/)
})

const agyId = '11112222-bbbb-0000-0000-000000000002'

test('get 回执没有已开始的转录证据时拒绝登记通知', async () => {
  for (const transcript of [
    undefined, {}, { total_steps: 3, last_step_index: 2 },
    { exists: true, total_steps: 3 }, { exists: true, total_steps: 3, last_step_index: -1 },
  ]) {
    const notifier = createAgyNotifier({
      run: async () => ({
        code: 0, stderr: '', stdout: JSON.stringify({ ok: true, conversation_id: agyId, conversation: { archived: false }, transcript }),
      }),
    })
    await assert.rejects(notifier.resolve(agyId), /无法核实.*没有发送消息/)
  }
})
const confirmed = {
  ok: true, timed_out: false, status: 'received', sent: true, receipt_confirmed: true,
  conversation_id: agyId, since_step: 6, receipt_step_index: 7, last_step_index: 7,
  run_state: 'RUN_STATE_RUNNING', update_time: '2026-01-01T00:00:05.000000Z',
}

function assertDeliveryError(promise: Promise<unknown>, unconfirmed: boolean, permanent = false) {
  return assert.rejects(promise, (error: unknown) => error instanceof AgyDeliveryError
    && error.unconfirmed === unconfirmed && error.permanent === permanent)
}

test('投递仅接受实际发送基线之后的完整 AGY 回执', async () => {
  const calls: string[][] = []
  let payload: Record<string, unknown>
  let exitCode = 0
  const notifier = createAgyNotifier({
    command: '/fake/agy-use',
    run: async (_cmd, args) => {
      calls.push([...args])
      return { code: exitCode, stdout: JSON.stringify(payload), stderr: '' }
    },
  })
  for (const fields of [
    {},
    { since_step: undefined, baseline: { last_step_index: 6, total_steps: 7 } },
    { baseline: { last_step_index: 6 } },
    { since_step: -1, receipt_step_index: 0, last_step_index: 0 },
  ]) {
    payload = { ...confirmed, ...fields }
    assert.deepEqual(await notifier.deliver(agyId, 'notice', 'summary'), { conversationId: agyId })
  }
  assert.deepEqual(calls[0], ['send', '--wait-receipt', '--timeout=20', '--', agyId, 'notice'])
  for (const fields of [
    { since_step: undefined }, { since_step: -2 }, { since_step: 4.5 }, { since_step: '4' },
    { since_step: 7 }, { since_step: 8 }, { baseline: { last_step_index: 5 } },
    { baseline: { last_step_index: 6.5 } }, { since_step: null, baseline: { last_step_index: 6 } },
    { receipt_step_index: undefined }, { receipt_step_index: -1 }, { receipt_step_index: 7.5 },
    { receipt_step_index: '7' }, { receipt_step_index: Number.MAX_SAFE_INTEGER + 1 },
    { last_step_index: undefined }, { last_step_index: 6 }, { last_step_index: 7.5 },
    { receipt_confirmed: false }, { conversation_id: 'different-target' }, { uncertain: true },
    { status: 'sent' }, { status: undefined }, { timed_out: true }, { cancelled: true },
    { error: 'transport failure' }, { error_code: 'receipt-failed' },
  ]) {
    payload = { ...confirmed, ...fields }
    await assertDeliveryError(notifier.deliver(agyId, 'notice', 'summary'), true)
  }
  payload = confirmed
  for (const code of [1, 2, 69]) {
    exitCode = code
    await assertDeliveryError(notifier.deliver(agyId, 'notice', 'summary'), true)
  }
})

test('无有效回执时退出码或 spawnError 不能证明未提交', async () => {
  for (const result of [
    { code: 0, stdout: 'not-json', stderr: '' },
    { code: 69, stdout: '', stderr: 'bridge disconnected' },
    { code: 2, stdout: '{', stderr: '' },
    { code: null, stdout: '{', stderr: '', spawnError: 'stdout maxBuffer length exceeded' },
    { code: null, stdout: '', stderr: '', timedOut: true },
    { code: 1, stdout: JSON.stringify({ ok: false, sent: null, uncertain: true }), stderr: '' },
    { code: 1, stdout: JSON.stringify({ ok: false, sent: 'false' }), stderr: '' },
    { code: 1, stdout: JSON.stringify({ ok: false, sent: false, uncertain: true }), stderr: '' },
  ]) {
    const notifier = createAgyNotifier({ run: async () => result })
    await assertDeliveryError(notifier.deliver(agyId, 'notice', 'summary'), true)
  }
  for (const [errorCode, permanent] of [['sidecar-unavailable', false], ['invalid-baseline', false], ['target-not-found', true], ['target-mismatch', true]] as const) {
    const notifier = createAgyNotifier({
      run: async () => ({ code: 69, stdout: JSON.stringify({ ok: false, sent: false, error_code: errorCode }), stderr: '' }),
    })
    await assertDeliveryError(notifier.deliver(agyId, 'notice', 'summary'), false, permanent)
  }
})

test('默认执行器区分未启动的程序和启动后输出超过上限', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-use-agy-exec-'))
  try {
    const command = join(dir, 'agy-use')
    const notifier = createAgyNotifier({ command })
    await assertDeliveryError(notifier.deliver(agyId, 'notice', 'summary'), false)
    const marker = join(dir, 'submitted')
    writeFileSync(command, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'submitted')\nprocess.stdout.write('x'.repeat(3 * 1024 * 1024))\n`, { mode: 0o755 })
    await assertDeliveryError(notifier.deliver(agyId, 'notice', 'summary'), true)
    assert.equal(readFileSync(marker, 'utf8'), 'submitted')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

const waitingOutcome: CommandResult = {
  text: '等待选择', status: 'waiting-input', data: { questions: [{ callId: 'call-choice', question: '选哪项？' }] },
}
const doneOutcome: CommandResult = { text: '完成', status: 'ok' }
const watchInput = { target: 'session-task', notify: `agy:${agyId}`, since: 1 }

function savedWatch(watcher: DoneWatcher, id: string): DoneWatchRecord {
  return JSON.parse(readFileSync(watcher.path(id), 'utf8')) as DoneWatchRecord
}

test('DSH 进程在 AGY 已接收但未返回回执时退出，恢复只投递尚未发过的最终通知', async () => {
  for (const phase of ['question', 'final'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-use-agy-crash-'))
    try {
      const moduleUrl = new URL('../src/done-watch.ts', import.meta.url).href
      const script = String.raw`
        import { appendFileSync } from 'node:fs'
        import { join } from 'node:path'
        import { DoneWatcher } from ${JSON.stringify(moduleUrl)}
        const dir = ${JSON.stringify(dir)}
        const watcher = new DoneWatcher({
          dir, check: async () => (${JSON.stringify(phase === 'question' ? waitingOutcome : doneOutcome)}),
          deliver: async (_session, text) => {
            appendFileSync(join(dir, 'external-receipts.txt'), text + '\n')
            process.exit(75)
          },
          onStatus: () => () => {}, log: () => {},
        })
        watcher.stop()
        const record = await watcher.add(${JSON.stringify(watchInput)})
        appendFileSync(join(dir, 'watch-id.txt'), record.id)
        await watcher.step(record)
      `
      const crash = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 5000 })
      assert.equal(crash.status, 75, crash.stderr || crash.error?.message)
      const id = readFileSync(join(dir, 'watch-id.txt'), 'utf8')
      const delivered = readFileSync(join(dir, 'external-receipts.txt'), 'utf8').trim().split('\n')
      let outcome = phase === 'question' ? waitingOutcome : doneOutcome
      const watcher = new DoneWatcher({
        dir, check: async () => outcome,
        deliver: async (_session, text) => { delivered.push(text) },
        onStatus: () => () => {}, log: () => {},
      })
      watcher.stop()
      const before = savedWatch(watcher, id)
      assert.equal(before.state, phase === 'question' ? 'watching' : 'delivering')
      if (phase === 'question') assert.deepEqual(before.asked, ['call-choice'])
      await watcher.start()
      if (phase === 'question') {
        const [record] = watcher.list()
        assert.ok(record)
        assert.equal(await watcher.step(record), false)
        assert.equal(delivered.length, 1)
        outcome = doneOutcome
        assert.equal(await watcher.step(record), true)
        assert.deepEqual(delivered.map((text) => text.match(/state=([^ ]+)/)?.[1]), ['waiting-input', 'completed'])
      } else {
        assert.equal(delivered.length, 1)
        assert.deepEqual(watcher.list(), [])
      }
      assert.equal(savedWatch(watcher, id).state, phase === 'question' ? 'delivered' : 'unconfirmed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('AGY 提问只在确认未提交且可重试时释放已落盘编号，永久拒绝仍保留最终监听', async () => {
  for (const kind of ['retryable', 'permanent', 'unknown'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-use-agy-question-'))
    try {
      let outcome = waitingOutcome
      const delivered: string[] = []
      const watcher = new DoneWatcher({
        dir, check: async () => outcome,
        deliver: async (_session, text) => {
          delivered.push(text)
          if (delivered.length !== 1) return
          if (kind === 'unknown') throw new Error('unexpected transport failure')
          throw new AgyDeliveryError('not sent', { permanent: kind === 'permanent' })
        },
        onStatus: () => () => {}, log: () => {},
      })
      watcher.stop()
      const record = await watcher.add(watchInput)
      const step = watcher.step(record)
      if (kind === 'retryable') await assert.rejects(step, /not sent/)
      else assert.equal(await step, false)
      assert.deepEqual(savedWatch(watcher, record.id).asked, kind === 'retryable' ? [] : ['call-choice'])
      assert.equal(await watcher.step(record), false)
      assert.equal(delivered.length, kind === 'retryable' ? 2 : 1)
      outcome = doneOutcome
      assert.equal(await watcher.step(record), true)
      assert.match(delivered.at(-1) ?? '', /state=completed/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('最终结果落盘失败后，内存中的后续轮次只补写状态', async () => {
  for (const kind of ['delivered', 'unconfirmed', 'failed'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'dsh-use-agy-persist-'))
    const dir = join(root, 'done-watches')
    const savedDir = join(root, 'saved')
    let attempts = 0
    try {
      const watcher = new DoneWatcher({
        dir, check: async () => doneOutcome,
        deliver: async () => {
          attempts++
          if (attempts !== 1) return
          renameSync(dir, savedDir)
          writeFileSync(dir, 'blocked')
          if (kind === 'unconfirmed') throw new Error('bridge disconnected')
          if (kind === 'failed') throw new AgyDeliveryError('target removed', { permanent: true })
        },
        onStatus: () => () => {}, log: () => {},
      })
      watcher.stop()
      const record = await watcher.add(watchInput)
      await assert.rejects(watcher.step(record), { code: 'ENOTDIR' })
      assert.equal(record.state, kind)
      await assert.rejects(watcher.step(record), { code: 'ENOTDIR' })
      assert.equal(attempts, 1)
      rmSync(dir)
      renameSync(savedDir, dir)
      assert.equal(savedWatch(watcher, record.id).state, 'delivering')
      assert.equal(await watcher.step(record), true)
      assert.equal(savedWatch(watcher, record.id).state, kind)
      assert.equal(attempts, 1)
      assert.deepEqual(watcher.list(), [])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
})

test('旧任务写发送意图和等收件时，新任务独立登记并在旧通知送完后继续监听', { timeout: 5000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-use-agy-overlap-'))
  const enteringSave = Promise.withResolvers<void>()
  const continueSave = Promise.withResolvers<void>()
  const enteringDelivery = Promise.withResolvers<void>()
  const continueDelivery = Promise.withResolvers<void>()
  const delivered: string[] = []
  let firstStep: Promise<boolean> | undefined
  try {
    let newTaskDone = false
    const watcher = new DoneWatcher({
      dir, check: async (_target, since) => (since === 1 || newTaskDone ? doneOutcome : undefined),
      deliver: async (_session, text) => {
        delivered.push(text)
        if (delivered.length !== 1) return
        enteringDelivery.resolve()
        await continueDelivery.promise
      },
      onStatus: () => () => {}, log: () => {},
    })
    watcher.stop()
    const first = await watcher.add(watchInput)
    const persistence = watcher as unknown as { save(record: DoneWatchRecord): Promise<void> }
    const save = persistence.save.bind(watcher)
    persistence.save = async (record) => {
      if (record.id === first.id && record.state === 'delivering') {
        enteringSave.resolve()
        await continueSave.promise
      }
      await save(record)
    }

    firstStep = watcher.step(first)
    await enteringSave.promise
    assert.equal(savedWatch(watcher, first.id).state, 'watching')
    const second = await watcher.add({ ...watchInput, since: 2 })
    assert.notEqual(second.id, first.id)
    assert.equal(savedWatch(watcher, second.id).since, 2)
    continueSave.resolve()
    await enteringDelivery.promise
    assert.equal(savedWatch(watcher, first.id).state, 'delivering')
    const reused = await watcher.add({ ...watchInput, since: 3 })
    assert.equal(reused.id, second.id)
    assert.equal(reused.reused, true)
    continueDelivery.resolve()

    assert.equal(await firstStep, true)
    assert.deepEqual(watcher.list().map(({ id }) => id), [second.id])
    assert.equal(savedWatch(watcher, first.id).state, 'delivered')
    assert.equal(await watcher.step(second), false)
    assert.equal(delivered.length, 1)
    newTaskDone = true
    assert.equal(await watcher.step(second), true)
    assert.deepEqual(delivered.map((text) => text.split(' watch=')[1]), [first.id, second.id])
  } finally {
    continueSave.resolve()
    continueDelivery.resolve()
    await firstStep?.catch(() => {})
    rmSync(dir, { recursive: true, force: true })
  }
})

test('启动合并旧 watching 记录时保存两边已提示题号，恢复同一问题不多发', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-use-agy-merge-asked-'))
  const delivered: string[] = []
  try {
    const create = () => {
      const watcher = new DoneWatcher({
        dir, check: async () => waitingOutcome,
        deliver: async (_session, text) => { delivered.push(text) },
        onStatus: () => () => {}, log: () => {},
      })
      watcher.stop()
      return watcher
    }
    const watcher = create()
    const old: DoneWatchRecord = {
      ...watchInput, id: 'old', state: 'watching', createdAt: 1000, asked: ['earlier', 'earlier'], attempts: 0,
    }
    const duplicate: DoneWatchRecord = { ...old, id: 'duplicate', since: 2, createdAt: 2000, asked: ['call-choice'] }
    for (const record of [old, duplicate]) writeFileSync(watcher.path(record.id), JSON.stringify(record))
    const starting = watcher.start()
    const addedWhileStarting = watcher.add({ ...watchInput, since: 3 })
    await starting
    const reused = await addedWhileStarting
    assert.equal(reused.id, old.id)
    assert.equal(reused.reused, true)
    assert.deepEqual(savedWatch(watcher, old.id).asked, ['earlier', 'call-choice'])
    assert.equal(savedWatch(watcher, duplicate.id).state, 'merged')
    assert.deepEqual(watcher.list().map(({ id }) => id), [old.id])

    const restarted = create()
    await restarted.start()
    const [record] = restarted.list()
    assert.ok(record)
    assert.equal(await restarted.step(record), false)
    assert.deepEqual(delivered, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('DoneWatcher：未确认收件标 unconfirmed 且重启不重发、不误标 delivered；永久失败标 failed', async () => {
  for (const kind of ['unconfirmed', 'permanent'] as const) {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-use-agy-watch-'))
    let attempts = 0
    try {
      const done: CommandResult = { text: 'done', status: 'ok', data: { turns: [{ turn: 1, ended: 'completed', detail: null, reply: '完成' }] } }
      const watcher = new DoneWatcher({
        dir,
        check: async () => done,
        deliver: async () => {
          attempts++
          throw new AgyDeliveryError(kind === 'unconfirmed' ? '已提交，收件未确认' : '会话已删除', kind === 'unconfirmed' ? { unconfirmed: true } : { permanent: true })
        },
        onStatus: () => () => {},
        log: () => {},
      })
      watcher.stop()
      const record = await watcher.add({ target: 'session-aaaa', notify: 'agy:11112222-bbbb-0000-0000-000000000002', since: 1 })
      assert.equal(await watcher.step(record), true)
      assert.equal(attempts, 1)
      const saved = JSON.parse(readFileSync(watcher.path(record.id), 'utf8')) as DoneWatchRecord
      assert.equal(saved.state, kind === 'unconfirmed' ? 'unconfirmed' : 'failed')
      assert.equal(watcher.list().length, 0)

      // 重启读回后既不重发，也不覆盖 unconfirmed 状态。
      const reloaded = new DoneWatcher({
        dir,
        check: async () => done,
        deliver: async () => { attempts++ },
        onStatus: () => () => {},
        log: () => {},
      })
      await reloaded.start()
      reloaded.stop()
      assert.equal(attempts, 1)
      assert.equal(reloaded.list().length, 0)
      const afterReload = JSON.parse(readFileSync(watcher.path(record.id), 'utf8')) as DoneWatchRecord
      assert.equal(afterReload.state, kind === 'unconfirmed' ? 'unconfirmed' : 'failed')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('DoneWatcher：跨宿主 agy 通知只含任务编号、明确状态和 watch ID，不透传标题/路径/正文/命令；DSH 本地保留详尽正文', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-use-agy-privacy-'))
  const agyDelivered: string[] = []
  const dshDelivered: string[] = []
  let titleLookups = 0
  try {
    let phase: 'waiting' | 'aborted' | 'ok' = 'waiting'
    const makeOutcome = (): CommandResult => {
      if (phase === 'waiting') {
        return {
          text: 'PRIVATE_QUESTION /Users/alice/secret.env',
          status: 'waiting-input',
          data: { questions: [{ callId: 'q-1' }] },
        }
      }
      if (phase === 'aborted') {
        return {
          text: 'aborted',
          status: 'aborted',
          data: { turns: [{ turn: 1, ended: 'cancelled', detail: 'CSRF_ERROR /tmp/secret', reply: 'PRIVATE_REPLY /Users/alice/token.json' }] },
        }
      }
      return {
        text: 'ok',
        status: 'ok',
        data: { turns: [{ turn: 2, ended: 'completed', detail: null, reply: 'PRIVATE_FINAL_REPLY /private/repo' }] },
      }
    }

    const watcher = new DoneWatcher({
      dir,
      check: async () => makeOutcome(),
      title: async () => {
        titleLookups++
        return 'SECRET_TITLE /private/repo'
      },
      deliver: async (notify, text) => {
        if (notify.startsWith('agy:')) agyDelivered.push(text)
        else dshDelivered.push(text)
      },
      onStatus: () => () => {},
      log: () => {},
    })
    watcher.stop()

    const wAbort = await watcher.add({ target: 'session-aaaa1111-0000', notify: 'agy:11112222-bbbb-0000-0000-000000000002', since: 1 })
    assert.equal(await watcher.step(wAbort), false)
    phase = 'aborted'
    assert.equal(await watcher.step(wAbort), true)

    const wOk = await watcher.add({ target: 'session-bbbb2222-0000', notify: 'agy:11112222-bbbb-0000-0000-000000000002', since: 2 })
    phase = 'ok'
    assert.equal(await watcher.step(wOk), true)
    assert.equal(titleLookups, 0, '跨宿主 agy 通知不应读取 DSH 会话标题')

    assert.equal(agyDelivered.length, 3)
    assert.equal(agyDelivered[0], `dsh-use notice: task=session-aaaa1111-0000 state=waiting-input watch=${wAbort.id}`)
    assert.equal(agyDelivered[1], `dsh-use notice: task=session-aaaa1111-0000 state=aborted watch=${wAbort.id}`)
    assert.equal(agyDelivered[2], `dsh-use notice: task=session-bbbb2222-0000 state=completed watch=${wOk.id}`)
    for (const msg of agyDelivered) {
      for (const secret of ['SECRET_TITLE', '/private/repo', 'PRIVATE_QUESTION', 'PRIVATE_REPLY', 'PRIVATE_FINAL_REPLY', 'CSRF_ERROR', 'dsh-use last']) {
        assert.equal(msg.includes(secret), false, `不应泄露 ${secret}: ${msg}`)
      }
    }

    // DSH 本地通知行为保持不变：包含标题、回复开头与读全文命令。
    const wLocal = await watcher.add({ target: 'session-cccc3333-0000', notify: 'session-9999', since: 1 })
    assert.equal(await watcher.step(wLocal), true)
    assert.equal(titleLookups, 1)
    assert.match(dshDelivered[0] ?? '', /SECRET_TITLE/)
    assert.match(dshDelivered[0] ?? '', /PRIVATE_FINAL_REPLY/)
    assert.match(dshDelivered[0] ?? '', /dsh-use last session-cccc3333-0000/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('RemoteService send/new：--notify agy:<前缀> 发出前核对、规范化后防重复监听，失败不发 DSH 消息', async () => {
  const prompts: unknown[] = []
  const dir = mkdtempSync(join(tmpdir(), 'dsh-use-agy-svc-'))
  const tiers = fromShared({
    tiers: { main: [{ provider: 'p', model: 'm' }], light: [{ provider: 'p', model: 'f' }] },
    quotas: { p: { quota: 'p', windows: { '7d': 1 } } },
    reservePercent: 10,
  })
  try {
    const delivered: { session: string; text: string; summary: string }[] = []
    let watcher: DoneWatcher
    const service = new RemoteService({
      gateway: {
        invoke: async ({ namespace, method, args }) => {
          const endpoint = `${namespace}/${method}`
          if (endpoint === 'session/list') {
            return { items: [{ sessionId: 'session-aaaa1111-0000', running: false, blank: false, agentAvailable: true, cwd: '/tmp/p', updatedAt: 1, projections: { values: { title: '合成任务' } } }] }
          }
          if (endpoint === 'session/prompt') {
            prompts.push(args)
            return { accepted: true }
          }
          if (endpoint === 'session/create') return { sessionId: 'session-new-0001' }
          if (endpoint === 'session/selectModel') return { selected: {} }
          return {}
        },
        stream: async () => (async function* () {})(),
      },
      typert: { list: () => [], get: () => undefined },
      query: {
        readSession: async (id) => ({
          session: { id },
          events: [
            { type: 'turn/start', seq: 1, time: 10, data: { turn: 1 } },
            { type: 'turn/end', seq: 2, time: 20, data: { turn: 1, reason: { kind: 'completed' } } },
          ],
        }),
      },
      usage: async () => undefined,
      onStatus: () => () => {},
      config: () => ({ readOnly: false, denyNamespaces: [], reservePercent: 10, waitSliceMs: 1000, tiers, paused: new Map() }),
      log: () => {},
      watchDone: async (req) => {
        const rec = await watcher.add(req)
        return { id: rec.id, path: watcher.path(rec.id), ...(rec.reused === true ? { reused: true } : {}) }
      },
      agyNotify: {
        resolve: async (target) => {
          if (target === 'aaaaaaaa' || target === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') {
            return 'agy:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
          }
          throw Object.assign(new Error('not found'), { code: 'target-not-found' })
        },
      },
    })
    watcher = new DoneWatcher({
      dir,
      check: async () => undefined,
      deliver: async (session, text, summary) => { delivered.push({ session, text, summary }) },
      onStatus: () => () => {},
      log: () => {},
    })
    watcher.stop()

    await assert.rejects(service.send('aaaa1111', '合成任务', { notify: 'agy:missing' }), /not found/)
    assert.equal(prompts.length, 0, 'AGY 目标核对失败时绝不发往 DSH')

    const first = await service.send('aaaa1111', '合成任务1', { notify: 'agy:aaaaaaaa' })
    const second = await service.send('aaaa1111', '合成任务2', { notify: 'agy:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
    assert.equal(prompts.length, 2)
    assert.equal((first.data as { notify: { session: string } }).notify.session, 'agy:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    assert.equal((second.data as { notify: { reused?: boolean } }).notify.reused, true)
    assert.equal(watcher.list().length, 1, '前缀与完整 UUID 规范化为同一目标，只留一条监听')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cli resolveNotifySelf：DSH 环境用 DSH_SESSION_ID，AGY 终端用 ANTIGRAVITY_CONVERSATION_ID，缺省报错', async () => {
  const dir = mkdtempSync(join('/tmp', 'dsh-agy-cli-'))
  const sock = join(dir, 'dsh.sock')
  const captured: unknown[] = []
  const srv = createServer((req, res) => {
    if (req.url === '/v1/health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, tool: 'dsh-use', protocol: 1, features: ['task-outcomes', 'send-receipts', 'done-notify'] }))
      return
    }
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      captured.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, status: 'ok', data: { sent: true, sessionId: 'session-aaaa1111', since: 1, requestId: 'req-1' } }))
    })
  })
  await new Promise<void>((resolve) => srv.listen(sock, resolve))
  try {
    const out: string[] = []
    const err: string[] = []
    const runWith = (env: NodeJS.ProcessEnv) => createCli({ DSH_HOME: dir, DSH_USE_SOCKET: sock, ...env }, (s) => out.push(s), (s) => err.push(s))

    const codeMissing = await runWith({})(['send', 'aaaa1111', 'hi', '--notify', 'self', '--json'])
    assert.equal(codeMissing, 2)
    assert.match(out.join(''), /notify-self-unavailable/)
    assert.equal(captured.length, 0)
    out.length = 0

    const codeAgy = await runWith({ ANTIGRAVITY_CONVERSATION_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })(['send', 'aaaa1111', 'hi', '--notify', 'self', '--json'])
    assert.equal(codeAgy, 0, err.join(''))
    assert.equal((captured.at(-1) as { options: { notify: string } }).options.notify, 'agy:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')

    const codeDsh = await runWith({ DSH_SESSION_ID: 'session-9999', ANTIGRAVITY_CONVERSATION_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })(['send', 'aaaa1111', 'hi', '--notify', 'self', '--json'])
    assert.equal(codeDsh, 0, err.join(''))
    assert.equal((captured.at(-1) as { options: { notify: string } }).options.notify, 'session-9999')
  } finally {
    await new Promise<void>((resolve) => srv.close(() => resolve()))
    rmSync(dir, { recursive: true, force: true })
  }
})
