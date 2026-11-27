import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { COMMANDS } from '../src/commands.ts'
import { createCli, type AppControl } from '../src/cli/core.ts'
import { CommandFailure, UsageError } from '../src/gateway.ts'
import { startServer } from '../src/server.ts'

const goodDoctor = { ok: true, checks: [{ id: 'fixture', ok: true, message: '正常' }] }

async function withTellFixture(
  onNotice: (call: number, session: string, signal: AbortSignal) => Promise<{ text: string; data?: Record<string, unknown> }>,
  options: {
    commands?: () => typeof COMMANDS
    onStatus?: (signal: AbortSignal) => Promise<{ text: string; data: { running: boolean } }>
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-use-tell-'))
  const bin = join(dir, 'profiles/desktop/node_modules/tooling')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(dir, 'profiles/desktop/node_modules/dsh-use'), { recursive: true })
  writeFileSync(join(bin, 'doctor-cli.mjs'), `console.log(JSON.stringify(${JSON.stringify(goodDoctor)}))`)
  const socketPath = join(dir, 'dsh-use/dsh.sock')
  const calls: string[] = []
  let noticeCalls = 0
  let generation = 1
  let up = true
  const server = await startServer({
    socketPath,
    commands: () => {
      calls.push('commands')
      return options.commands?.() ?? COMMANDS
    },
    info: () => ({ pid: 2000 + generation, startedAt: generation }),
    log: () => {},
    run: async (command, args, _params, signal) => {
      if (command === 'health') return { text: 'ok', data: { running: [] } }
      if (command === 'quit-check') return { text: '', data: { running: [], queued: [], parents: {}, jobs: [], clear: true } }
      calls.push(command)
      if (command === 'notice') return onNotice(++noticeCalls, args[0]!, signal)
      if (command === 'send') return { text: '已收取', data: { scheduled: true } }
      if (command === 'status' && options.onStatus) return options.onStatus(signal)
      throw new Error(`unexpected command: ${command}`)
    },
  })
  const app: AppControl = {
    running: () => up,
    quit: () => { up = false; generation++; return { status: 0, stderr: '' } },
    backendRunning: () => up,
    open: () => { up = true; return { status: 0, stderr: '' } },
    kill: () => { up = false; generation++ },
    confirmScheduledQuit: () => 'other:none',
    screenLocked: () => false,
  }
  const runRestart = async (extraEnv: NodeJS.ProcessEnv = {}) => {
    let out = '', err = ''
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DSH_HOME: dir,
      DSH_APP: join(dir, 'absent.app'),
      DSH_USE_SOCKET: socketPath,
      DSH_USE_POLL_MS: '5',
      DSH_USE_WAIT_IDLE_GRACE_MS: '50',
      DSH_USE_QUIT_WAIT_MS: '2500',
      DSH_USE_QUIT_CLEAR_MS: '50',
      ...extraEnv,
    }
    delete env['DSH_SESSION_ID']
    delete env['DSH_SHELL']
    const code = await createCli(env, (t) => { out += t }, (t) => { err += t }, () => 4242, app)(['restart', '--notify', 'missing11'])
    const logMatch = /Log: ([^\s.]+\.log)/.exec(out) ?? /([^\s]+restart-[^\s]+\.log)/.exec(out)
    const logText = logMatch ? readFileSync(logMatch[1]!, 'utf8') : ''
    return { code, out, err, logText }
  }
  return {
    calls,
    noticeCalls: () => noticeCalls,
    runRestart,
    close: async () => {
      await server.close()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test('tell 遇 not-found（HTTP 400 与 HTTP 500）立即判定被拒，不再重试等待 30 秒', async () => {
  for (const makeError of [
    () => new UsageError('找不到会话 missing11', 'not-found'),
    () => new CommandFailure('会话 missing11 已不存在', 'not-found'),
  ]) {
    const f = await withTellFixture(async () => { throw makeError() })
    try {
      const started = Date.now()
      const res = await f.runRestart()
      const elapsed = Date.now() - started
      assert.equal(res.code, 0, res.err)
      assert.equal(f.noticeCalls(), 1, 'not-found 不应重试')
      assert.ok(elapsed < 2_000, `not-found 应快速失败，实际耗时 ${elapsed}ms`)
      assert.match(res.out + res.logText, /送消息被拒/)
    } finally {
      await f.close()
    }
  }
})

test('tell 支持 DSH_USE_TELL_TIMEOUT_MS 覆盖重试上限，非法值回退默认 30 秒', async () => {
  const shortTimeout = await withTellFixture(async () => {
    throw new CommandFailure('active Service "sessionController" is unavailable', 'gateway/service-unavailable')
  })
  try {
    const started = Date.now()
    const res = await shortTimeout.runRestart({ DSH_USE_TELL_TIMEOUT_MS: '450' })
    const elapsed = Date.now() - started
    assert.equal(res.code, 0, res.err)
    assert.ok(shortTimeout.noticeCalls() >= 2, `短超时内仍应重试，实际次数 ${shortTimeout.noticeCalls()}`)
    assert.ok(elapsed >= 350 && elapsed < 2_000, `应按 DSH_USE_TELL_TIMEOUT_MS 结束重试，实际耗时 ${elapsed}ms`)
    assert.match(res.out + res.logText, /送消息一直不成/)
  } finally {
    await shortTimeout.close()
  }

  for (const invalid of ['0', '-100', 'NaN', 'Infinity', 'not-a-number']) {
    const fallback = await withTellFixture(async (call) => {
      if (call < 3) throw new CommandFailure('active Service "sessionController" is unavailable', 'gateway/service-unavailable')
      return { text: '已发出', data: { scheduled: true } }
    })
    try {
      const res = await fallback.runRestart({ DSH_USE_TELL_TIMEOUT_MS: invalid })
      assert.equal(res.code, 0, res.err)
      assert.equal(fallback.noticeCalls(), 3, `非法值 ${invalid} 应回退默认 30 秒并重试成功`)
      assert.match(res.out + res.logText, /已给会话 .* 送通知并确认已安排执行/)
    } finally {
      await fallback.close()
    }
  }
})

const quotedCommand = '没有命令 "notice"。dsh-use help 看全部'
const temporary = () => new CommandFailure('会话服务正在启动', 'gateway/service-unavailable')

for (const [code, message] of [
  ['not-found', `找不到会话：${quotedCommand}`],
  ['read-only', '配置只读；备注 unavailable'],
] as const) {
  test(`终态错误 ${code} 中的文字不能改变下一次请求`, async () => {
    const f = await withTellFixture(async () => { throw new UsageError(message, code) })
    try {
      const res = await f.runRestart({ DSH_USE_TELL_TIMEOUT_MS: '100' })
      assert.deepEqual(f.calls, ['notice'])
      assert.ok((res.out + res.logText).includes(message))
    } finally { await f.close() }
  })
}

for (const { label, commands, expected } of [
  { label: '旧宿主只登记普通消息', commands: () => COMMANDS.filter((cmd) => cmd.name === 'send'), expected: ['notice', 'commands', 'send'] },
  { label: '宿主已登记通知命令', commands: () => COMMANDS, expected: ['notice', 'commands'] },
  { label: '宿主未登记两种命令', commands: () => [], expected: ['notice', 'commands'] },
  { label: '读取命令目录失败', commands: () => { throw new Error('目录读取失败') }, expected: ['notice', 'commands'] },
]) {
  test(`旧版通用用法错误须核实命令目录：${label}`, async () => {
    const f = await withTellFixture(async () => { throw new UsageError(quotedCommand) }, { commands })
    try {
      const res = await f.runRestart({ DSH_USE_TELL_TIMEOUT_MS: '1000' })
      assert.deepEqual(f.calls, expected)
      if (expected.includes('send')) assert.match(res.out + res.logText, /确认已安排执行/)
      else assert.ok((res.out + res.logText).includes(quotedCommand), '应显示第一次投递的错误')
    } finally { await f.close() }
  })
}

test('结果不明时保留首个错误，已接收的写请求只出现一次', async () => {
  const received: string[] = []
  const f = await withTellFixture(async (_, session) => {
    received.push(session)
    throw new CommandFailure(`已接收第 ${received.length} 次，回执异常`, 'send-unconfirmed')
  })
  try {
    const res = await f.runRestart({ DSH_USE_TELL_TIMEOUT_MS: '100' })
    assert.deepEqual(received, ['missing11'])
    assert.deepEqual(f.calls, ['notice'])
    assert.match(res.out + res.logText, /已接收第 1 次，回执异常/)
  } finally { await f.close() }
})

test('100 毫秒预算不能在 300 毫秒后开始下一次通知', async () => {
  const f = await withTellFixture(async (call) => {
    if (call === 1) throw temporary()
    return { text: '已收取', data: { scheduled: true } }
  })
  try {
    const res = await f.runRestart({ DSH_USE_TELL_TIMEOUT_MS: '100' })
    assert.deepEqual(f.calls, ['notice'])
    assert.match(res.out + res.logText, /送消息一直不成.*会话服务正在启动/)
  } finally { await f.close() }
})

test('第二次投递只使用剩余预算，超时后保留这次投递的不确定状态', async () => {
  const f = await withTellFixture(async (call, _session, signal) => {
    if (call === 1) throw temporary()
    await delay(350, undefined, { signal })
    return { text: '已收取', data: { scheduled: true } }
  })
  try {
    const res = await f.runRestart({ DSH_USE_TELL_TIMEOUT_MS: '500' })
    assert.deepEqual(f.calls, ['notice', 'notice'])
    assert.doesNotMatch(res.out + res.logText, /确认已安排执行/)
  } finally { await f.close() }
})

test('旧回执的只读确认也在同一截止时间结束', async () => {
  const f = await withTellFixture(async () => ({ text: '已记录', data: { accepted: true } }), {
    onStatus: async (signal) => {
      await delay(350, undefined, { signal })
      return { text: '已运行', data: { running: true } }
    },
  })
  try {
    const res = await f.runRestart({ DSH_USE_TELL_TIMEOUT_MS: '100' })
    assert.deepEqual(f.calls, ['notice', 'status'])
    assert.match(res.out + res.logText, /已记录，但未确认安排执行/)
  } finally { await f.close() }
})
