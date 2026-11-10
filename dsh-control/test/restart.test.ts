import { test } from 'node:test'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { createCli, type AppControl } from '../src/cli/core.ts'
import { appVersion, parseFeed } from '../src/cli/upgrade.ts'
import { startServer } from '../src/server.ts'
import { CommandFailure, UsageError } from '../src/gateway.ts'

const good = { ok: true, checks: [{ id: 'fixture', ok: true, message: '正常' }] }

interface Sent { session: string; text: string; via: 'notice' | 'send'; summary?: string; quiet?: boolean }

/**
 * 假 DSH：通信口真实监听（命令行走真 socket），会话状态由测试按调用次数编排。
 * App 换成假的：只记录被要求退出、打开、强杀了几次，绝不碰本机正在运行的 DSH。
 * 假 App 一开始「在运行」，收到退出就「退出」，start 看到通信口还在就算重启完成。
 */
async function fixture(runningByCall: (call: number) => string[], options: { openFails?: number; onOpen?: () => void; noticeReceiptOnly?: boolean; noticeWakeupUnconfirmed?: boolean; statusRunning?: boolean; sendFails?: (session: string) => boolean; noNotice?: boolean; jobs?: string[]; stubbornJobs?: boolean; notReadyFor?: number; quitExtra?: (call: number) => { running?: string[]; jobs?: string[] }; survivable?: string[]; parents?: Record<string, string>; quitFails?: boolean; quitTimeout?: boolean; goals?: Record<string, string>; resumeFails?: boolean; noHold?: boolean; queued?: string[]; quitCheckFails?: boolean; badHealth?: boolean; oldHealthBroken?: boolean; runningThrowsAfterPrepare?: boolean; sameInstance?: boolean; stuckKill?: boolean; startupUnavailable?: boolean; delayedNotice?: boolean; archived?: string[]; subagents?: string[]; refusedCancel?: string[]; queuedDetails?: { id: string; nextTurnCount: number; nextStepCount: number; nextStepSources: { kind: string; form?: string }[] }[]; queueDrained?: () => boolean; scheduled?: { sessionId: string; items: { id: string; label: string }[] }[]; dialog?: 'scheduled' | 'other'; busyAtDialog?: boolean; locked?: boolean; socketGone?: 'crashed' | 'plugin-broken'; jobCwd?: Record<string, string>; wakeOnKill?: boolean; monitorFails?: boolean; lost?: Record<string, { restored?: { target: string; preview: string }[]; otherAborted?: boolean; interruptedUser?: { text: string; at: number } }> } = {}) {
  const dir = mkdtempSync('/tmp/dshrs-')
  const bin = join(dir, 'profiles/desktop/node_modules/tooling')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(dir,'profiles/desktop/node_modules/dsh-control'), {recursive:true})
  writeFileSync(join(bin, 'doctor-cli.mjs'), `console.log(JSON.stringify(${JSON.stringify(good)}))`)
  const socketPath = join(dir, 'dsh-control/dsh.sock')
  const sent: Sent[] = []
  const cancelled: string[] = []
  let jobs = [...(options.jobs ?? [])]
  const killedJobs: string[] = []
  const monitors: Record<string, unknown>[] = []
  // 真实宿主不挂等待时：停掉任务会给闲着的主人发「任务结束」并开一轮，直到它被中止。
  const woke: string[] = []
  const prepared: string[] = []
  let aborted = 0
  const requeueCalls: { session: string; since: unknown }[] = []
  let healthCalls = 0
  let quitCalls = 0
  let notReady = options.notReadyFor ?? 0
  let stopped = false
  let dialogOpen = false
  const goals = new Map(Object.entries(options.goals ?? {}).map(([s, phase]) => [s, { id: `goal-${s}`, revision: 1, phase, activation: phase === 'active' ? 'armed' : 'disarmed' }]))
  const goalCalls: string[] = []
  let generation = 1
  const server = await startServer({ socketPath, commands: () => [], info: () => ({ pid: 1000 + generation, startedAt: generation }), log: () => {}, run: async (command, args, opts) => {
    if (command === 'health' && options.badHealth) throw new Error('会话状态读取失败')
    if (command === 'health' && options.oldHealthBroken && generation === 1) throw new Error("Cannot read properties of undefined (reading 'signal')")
    if (command === 'health' && generation > 1 && options.startupUnavailable) throw new Error('会话服务尚未就绪')
    if (command === 'health') return { text: 'ok', data: { running: stopped ? [] : runningByCall(healthCalls++) } }
    if (command === 'status') return { text: '', data: { running: options.statusRunning === true } }
    if (command === 'cancel') {
      if (options.refusedCancel?.includes(args[0]!)) throw new UsageError('该子代理不能由会话中止', 'subagent-owned')
      cancelled.push(args[0]!); return { text: '已中止' }
    }
    if (command === 'quit-check') {
      if (options.quitCheckFails) throw new Error('退出状态读取失败')
      const running = stopped ? [] : runningByCall(healthCalls)
      // 真实宿主：挂着进行中目标的会话被中止后会自动开下一轮；子代理要单独中止才停。
      if (cancelled.length > 0 && running.every((id) => cancelled.includes(id) && goals.get(id)?.phase !== 'active')) stopped = true
      const extra = options.quitExtra?.(quitCalls++) ?? {}
      const subs = (options.subagents ?? []).filter((id) => !cancelled.includes(id))
      const r = [...(stopped ? subs : [...running, ...(extra.running ?? []), ...subs]), ...woke.filter((id) => !cancelled.includes(id))]
      if (dialogOpen && options.busyAtDialog) r.push('session-late')
      const j = [...jobs, ...(extra.jobs ?? [])]
      const owners = options.parents ?? {}
      return { text: '', data: { running: r, queued: options.queueDrained?.() ? [] : options.queued ?? [], queuedDetails: options.queuedDetails, parents: options.parents ?? {}, jobs: j.map((id) => ({ id, label: 'x', owner: owners[id] ?? 's', ...(options.survivable?.includes(id) ? { survivable: true } : {}) })), clear: r.length === 0 && j.length === 0, ...(options.scheduled === undefined ? {} : { scheduled: options.scheduled }) } }
    }
    if (command === 'api' && args[0] === 'call' && args[1] === 'subagents/interruptByParent') {
      const body = JSON.parse(args[2]!) as { childSessionId: string; parentSessionId: string; mode: string }
      assert.equal(body.parentSessionId, options.parents?.[body.childSessionId])
      assert.equal(body.mode, 'continuable')
      if (options.refusedCancel?.includes(body.childSessionId)) throw new UsageError('该子代理不能由上级中止', 'subagent-owned')
      cancelled.push(body.childSessionId)
      return { text: '', data: { accepted: true } }
    }
    if (command === 'restart-prepare') {
      const items = jobs.filter((id) => options.survivable?.includes(id))
      prepared.push(...items)
      jobs = jobs.filter((id) => !items.includes(id))
      return { text: '', data: { suspended: items.map((id) => ({ id, label: '飞书监听', owner: 's' })) } }
    }
    if (command === 'api' && args[0] === 'call' && args[1]!.startsWith('goals/')) {
      const body = JSON.parse(args[2]!) as { agentId: string; ref?: { id: string; revision: number } }
      const g = goals.get(body.agentId)
      goalCalls.push(`${args[1]} ${body.agentId}`)
      if (args[1] === 'goals/get') return { text: '', data: g ?? null }
      if (g === undefined || body.ref?.revision !== g.revision) throw new CommandFailure('stale', 'GOAL_STALE_REVISION')
      if (args[1] === 'goals/resume' && options.resumeFails) throw new CommandFailure('恢复被拒', 'GOAL_RESUME_FAILED')
      g.revision++
      g.phase = args[1] === 'goals/pause' ? 'paused' : 'active'
      g.activation = args[1] === 'goals/pause' ? 'disarmed' : 'armed'
      // 真实宿主（goal-round-driver）：外部暂停在跑会话的目标，当场以「用户中止」打断这一轮。
      if (args[1] === 'goals/pause' && !stopped) cancelled.push(body.agentId)
      return { text: '', data: g }
    }
    if (command === 'goal' && args[1] === 'hold') {
      if (options.noHold) throw new UsageError('动作只能是 pause、resume、clear')
      const g = goals.get(args[0]!)!
      goalCalls.push(`goal hold ${args[0]}`)
      g.activation = 'disarmed'
      return { text: '', data: g }
    }
    if (command === 'requeue-lost') {
      requeueCalls.push({ session: args[0]!, since: opts['since'] })
      return { text: '', data: { sessionId: args[0], restored: [], otherAborted: false, ...options.lost?.[args[0]!] } }
    }
    if (command === 'restart-abort') { aborted++; return { text: '', data: { revived: prepared, failed: [] } } }
    if (command === 'kill-jobs') {
      killedJobs.push(...args)
      if (!options.stubbornJobs) jobs = []
      if (options.wakeOnKill) woke.push(...args.map((id) => options.parents?.[id] ?? 's'))
      return { text: '已请求停止', data: { killed: args.map((id) => ({ id, outcome: 'requested', ...(options.jobCwd?.[id] === undefined ? {} : { cwd: options.jobCwd[id] }) })) } }
    }
    if (command === 'monitor') {
      if (options.monitorFails) throw new CommandFailure('监听插件未确认服务及所属会话', 'monitor-unconfirmed')
      monitors.push({ owner: args[0], ...opts })
      return { text: '已挂上', data: { id: `monitor-new-${monitors.length}` } }
    }
    if (command === 'notice' && options.noNotice) throw new CommandFailure('这个 DSH 不支持插件通知，改用 send', 'notice-unsupported')
    if ((command === 'send' || command === 'notice') && notReady > 0) { notReady--; throw new UsageError('typert gateway: session/list: active Service "sessionController" is unavailable', 'gateway/service-unavailable') }
    if ((command === 'send' || command === 'notice') && options.archived?.includes(args[0]!)) throw new UsageError(`会话 ${args[0]} 已存档：宿主不会让存档的会话开新一轮，送进去也没人处理。`, 'session-archived')
    if (command === 'send' || command === 'notice') {
      if (options.delayedNotice && args[0] === 'aaaa1111') {
        assert.equal(readFileSync(join(dir, 'dsh-control/restart.lock'), 'utf8'), String(process.pid), '结果通知过程中执行锁必须仍属于执行者')
        const claim = join(dir, 'dsh-control/restart.lock.claim')
        writeFileSync(claim, String(process.pid))
        setTimeout(() => rmSync(claim, { force: true }), 30)
        await new Promise((resolve) => setTimeout(resolve, 5))
      }
      if (options.sendFails?.(args[0]!)) throw new Error('会话不存在')
      sent.push({ session: args[0]!, text: args[1]!, via: command, ...(typeof opts['summary'] === 'string' ? { summary: opts['summary'] } : {}), ...(opts['quiet'] === true ? { quiet: true } : {}) })
      if (options.noticeWakeupUnconfirmed) throw new CommandFailure('通知已记录，未确认调度', 'notice-wakeup-unconfirmed', { accepted: true, scheduled: false })
      return { text: '已发出', data: { since: 1, ...(options.noticeReceiptOnly ? {} : { scheduled: true }) } }
    }
    throw new Error(`没料到的命令 ${command}`)
  } })
  // 通信口文件挪走就是「找不到通信口」；crashed 时后台进程也不在，打开 App 才挪回来。
  if (options.socketGone) renameSync(socketPath, `${socketPath}.off`)
  let crashed = options.socketGone === 'crashed'
  const appCalls: string[] = []
  const quitStrategies: (string | undefined)[] = []
  let up = true
  const app: AppControl = {
    running: () => { if (options.runningThrowsAfterPrepare && prepared.length > 0 && up) throw new Error('pgrep 状态异常'); return up },
    quit: (strategy) => { quitStrategies.push(strategy); appCalls.push('quit'); if (options.quitTimeout) return { status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync osascript ETIMEDOUT'), { code: 'ETIMEDOUT' }), stderr: '真实超时输入形状', stage: 'apple-event' }; if (options.quitFails) return { status: 1, stderr: '退出被拒' }; if (options.dialog) { dialogOpen = true; return { status: 0, stderr: '' } } up = false; if (!options.sameInstance) generation++; return { status: 0, stderr: '' } },
    backendRunning: () => up && !crashed,
    open: () => { appCalls.push('open'); options.onOpen?.(); if ((options.openFails ?? 0) > 0) { options.openFails!--; return { status: 1, stderr: '新版启动即崩溃' } } up = true; if (crashed) { crashed = false; renameSync(`${socketPath}.off`, socketPath) } return { status: 0, stderr: '' } },
    kill: (signal) => { appCalls.push(`kill-${signal}`); if (!options.stuckKill) { up = false; generation++ } },
    confirmScheduledQuit: () => {
      appCalls.push('confirm')
      if (options.dialog !== 'scheduled') return 'other:当前正在运行的任务将会中断'
      dialogOpen = false; up = false; generation++
      return 'clicked'
    },
    screenLocked: () => options.locked === true,
  }
  let out = '', err = ''
  const spawned: { args: string[]; env: NodeJS.ProcessEnv; log: string }[] = []
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: dir, DSH_APP: join(dir, 'absent.app'), DSH_CONTROL_SOCKET: socketPath, DSH_CONTROL_POLL_MS: '5', DSH_CONTROL_WAIT_IDLE_GRACE_MS: '50', DSH_CONTROL_QUIT_WAIT_MS: '2500', DSH_CONTROL_QUIT_CLEAR_MS: '50' }
  // 默认模拟用户终端，不能继承运行测试的模型 shell 来源；会话用例通过 extra 显式传入。
  delete env['DSH_SESSION_ID']
  delete env['DSH_SHELL']
  const cli = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
    out = ''; err = ''
    return createCli({ ...env, ...extra }, (t) => { out += t }, (t) => { err += t }, (a, e, log) => { spawned.push({ args: a, env: e, log }); return 4242 }, app)(args)
  }
  return { dir, sent, spawned, appCalls, quitStrategies, goals, goalCalls, cancelled, killedJobs, monitors, prepared, requeueCalls, aborted: () => aborted, cli, out: () => out, err: () => err, health: () => healthCalls, close: async () => { await server.close(); rmSync(dir, { recursive: true, force: true }) } }
}






test('重启请求关联：后台 JSON 回执、精确状态、附着请求不串到下一次重启', async () => {
  const f = await fixture(() => [])
  try {
    assert.equal(await f.cli(['restart', '--detach', '--json']), 0, f.err())
    const queued = JSON.parse(f.out())
    assert.equal(queued.status, 'queued')
    assert.match(queued.data.requestId, /^[0-9a-f-]{36}$/)
    assert.equal(f.spawned[0]!.env.DSH_CONTROL_RESTART_REQUEST_ID, queued.data.requestId)
    assert.deepEqual(f.appCalls, [])
    const dir = join(f.dir, 'dsh-control/restart-requests')
    const original = queued.data.requestId
    writeFileSync(join(dir, `${original}.json`), JSON.stringify({ requestId: original, phase: 'completed', startedAt: 1, finishedAt: 2, marker: 'original' }))
    const next = 'bbbbbbbb-1111-2222-3333-444444444444'
    writeFileSync(join(f.dir, 'dsh-control/restart-state.json'), JSON.stringify({ requestId: next, phase: 'waiting', pid: process.ppid, startedAt: 3 }))
    assert.equal(await f.cli(['restart-status', '--request-id', original, '--json']), 0)
    assert.equal(JSON.parse(f.out()).data.marker, 'original')
    writeFileSync(join(dir, `${next}.json`), JSON.stringify({ requestId: next, phase: 'waiting', pid: process.ppid, startedAt: 3 }))
    writeFileSync(join(f.dir, 'dsh-control/restart.lock'), String(process.ppid))
    assert.equal(await f.cli(['restart', '--detach', '--json']), 0, f.err())
    const attached = JSON.parse(f.out())
    assert.equal(attached.status, 'attached')
    assert.equal(attached.data.executionRequestId, next)
    assert.notEqual(attached.data.requestId, next)
    writeFileSync(join(dir, `${next}.json`), JSON.stringify({ requestId: next, phase: 'failed', finishedAt: 4, message: '指定执行者失败' }))
    writeFileSync(join(f.dir, 'dsh-control/restart-state.json'), JSON.stringify({ requestId: original, phase: 'completed' }))
    assert.equal(await f.cli(['restart-status', '--request-id', attached.data.requestId, '--json']), 0)
    const result = JSON.parse(f.out())
    assert.equal(result.data.requestId, attached.data.requestId)
    assert.equal(result.data.executionRequestId, next)
    assert.equal(result.data.phase, 'failed')
    assert.equal(await f.cli(['restart-status', '--request-id', '../restart-state', '--json']), 2)
    assert.equal(await f.cli(['restart-status', '--request-id', 'aaaaaaaa-1111-2222-3333-444444444444', '--json']), 2)
    assert.equal(JSON.parse(f.out()).error.code, 'not-found')
  } finally { await f.close() }
})

test('重启精确记录：失联是 interrupted，未发布关联编号时拒绝登记，真实隔离执行写终态', async () => {
  const f = await fixture(() => [])
  try {
    writeFileSync(join(f.dir, 'dsh-control/restart.lock'), String(process.ppid))
    assert.equal(await f.cli(['restart', '--detach', '--json']), 2)
    assert.equal(JSON.parse(f.out()).error.code, 'restart-not-ready')
    rmSync(join(f.dir, 'dsh-control/restart.lock'))
    const id = 'cccccccc-1111-2222-3333-444444444444'
    assert.equal(await f.cli(['restart'], { DSH_CONTROL_RESTART_REQUEST_ID: id }), 0, f.err())
    const state = JSON.parse(readFileSync(join(f.dir, 'dsh-control/restart-requests', `${id}.json`), 'utf8'))
    assert.equal(state.requestId, id)
    assert.equal(state.phase, 'completed')
    state.phase = 'waiting'; state.pid = 2147483647
    writeFileSync(join(f.dir, 'dsh-control/restart-requests', `${id}.json`), JSON.stringify(state))
    assert.equal(await f.cli(['restart-status', '--request-id', id, '--json']), 0)
    assert.equal(JSON.parse(f.out()).data.phase, 'interrupted')
  } finally { await f.close() }
})



test('显式退出策略传后台和AppControl；默认兼容AppleEvent；旧执行者不吞新策略', async () => {
  const f = await fixture(() => [])
  try {
    assert.equal(await f.cli(['restart', '--detach', '--quit-via', 'menu', '--json']), 0, f.err())
    const receipt = JSON.parse(f.out())
    assert.equal(receipt.data.quitVia, 'menu')
    assert.ok(f.spawned[0]!.args.includes('--quit-via=menu'))
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'dsh-control/restart-requests', `${receipt.data.requestId}.json`), 'utf8')).quitVia, 'menu')
    const old = 'aaaaaaaa-1234-1234-1234-aaaaaaaaaaaa'
    const state = { requestId: old, phase: 'waiting', pid: process.ppid }
    writeFileSync(join(f.dir, 'dsh-control/restart.lock'), String(process.ppid))
    writeFileSync(join(f.dir, 'dsh-control/restart-state.json'), JSON.stringify(state))
    writeFileSync(join(f.dir, 'dsh-control/restart-requests', `${old}.json`), JSON.stringify(state))
    assert.equal(await f.cli(['restart', '--detach', '--quit-via', 'menu', '--json']), 2)
    assert.equal(JSON.parse(f.out()).error.code, 'restart-strategy-conflict')
    assert.equal(f.spawned.length, 1)
    assert.deepEqual(f.appCalls, [])
    rmSync(join(f.dir, 'dsh-control/restart.lock'))
    assert.equal(await f.cli(['restart', '--quit-via', 'menu']), 0, f.err())
    assert.deepEqual(f.quitStrategies, ['menu'])
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'dsh-control/restart-state.json'), 'utf8')).quitVia, 'menu')
  } finally { await f.close() }
  const defaults = await fixture(() => [])
  try { assert.equal(await defaults.cli(['restart']), 0); assert.deepEqual(defaults.quitStrategies, ['apple-event']) }
  finally { await defaults.close() }
})

test('AppleEvent超时保留真实原因，改为结束进程再拉起', async () => {
  const f = await fixture(() => [], { quitTimeout: true })
  try {
    assert.equal(await f.cli(['restart']), 0, f.err())
    assert.match(f.out(), /"stage":"apple-event".*"signal":"SIGTERM".*"code":"ETIMEDOUT"/)
    assert.match(f.out(), /正常退出没走通.*改为结束 DSH 进程再拉起/)
    assert.deepEqual(f.appCalls, ['quit', 'kill-TERM', 'open'])
  } finally { await f.close() }
})

test('真实双进程抢失效执行锁：更新只执行一次，另一份明确拒绝', async () => {
  const f = await fixture(() => [])
  try {
    const log = join(f.dir, 'app-actions')
    const entry = join(f.dir, 'child.mjs')
    const module = fileURLToPath(new URL('../src/cli/core.ts', import.meta.url))
    writeFileSync(entry, `import {createCli} from ${JSON.stringify(module)};
import {appendFileSync} from 'node:fs';
const app={running:()=>false,quit:()=>{throw Error('unexpected quit')},open:()=>{throw Error('unexpected open')},kill:()=>{throw Error('unexpected kill')}};
createCli(process.env,()=>{},()=>{},undefined,app)(['restart','--notify',process.argv[2],'--before',${JSON.stringify(`printf update >> ${log}; sleep 0.2`)}]).then(c=>{process.exitCode=c});`)
    mkdirSync(join(f.dir, 'dsh-control'), { recursive: true })
    writeFileSync(join(f.dir, 'dsh-control/restart.lock'), '999999')
    const runChild = (id: string) => new Promise<number | null>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: f.dir, DSH_APP: join(f.dir, 'absent.app'), DSH_CONTROL_SOCKET: join(f.dir, 'dsh-control/dsh.sock') }
      delete env.DSH_SESSION_ID; delete env.DSH_SHELL
      const child = spawn(process.execPath, [entry, id], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let err = ''
      child.stderr.on('data', x => { err += x.toString() })
      child.on('error', reject)
      child.on('close', code => { assert.ok(code === 0 || code === 2, err); resolve(code) })
    })
    await Promise.all([runChild('aaaa1111'), runChild('bbbb2222')])
    assert.equal(readFileSync(log, 'utf8').split('update').length - 1, 1)
    assert.equal(f.sent.length, 1, '另一份更新被明确拒绝而非静默合并')
    assert.equal(existsSync(join(f.dir, 'dsh-control/restart.lock')), false)
  } finally { await f.close() }
})

test('通知与释放争用：执行者等登记完成，不丢等待者也不提前释放锁', async () => {
  const f = await fixture(() => [], { delayedNotice: true })
  try {
    mkdirSync(join(f.dir, 'dsh-control'), { recursive: true })
    writeFileSync(join(f.dir, `dsh-control/restart.waiters.${process.pid}`), 'bbbb2222\n')
    assert.equal(await f.cli(['restart', '--notify', 'aaaa1111']), 0)
    assert.deepEqual(f.sent.map((x) => x.session), ['aaaa1111', 'bbbb2222'])
    assert.equal(existsSync(join(f.dir, 'dsh-control/restart.lock')), false)
  } finally { await new Promise((resolve) => setTimeout(resolve, 40)); await f.close() }
})

test('短登记锁争用会等待，不伪造成功或遗留主锁', async () => {
  const f = await fixture(() => [])
  try {
    mkdirSync(join(f.dir, 'dsh-control'), { recursive: true })
    const claim = join(f.dir, 'dsh-control/restart.lock.claim')
    writeFileSync(claim, String(process.pid))
    setTimeout(() => rmSync(claim, { force: true }), 30)
    assert.equal(await f.cli(['restart']), 0)
    assert.equal(existsSync(join(f.dir, 'dsh-control/restart.lock')), false)
  } finally { await f.close() }
})

test('已有排队不能静默丢弃第二个更新命令', async () => {
  const f = await fixture(() => [])
  try {
    mkdirSync(join(f.dir, 'dsh-control'), { recursive: true })
    writeFileSync(join(f.dir, 'dsh-control/restart.lock'), String(process.ppid))
    const mark = join(f.dir, 'must-not-run')
    assert.equal(await f.cli(['restart', '--detach', '--before', `touch ${mark}`]), 2)
    assert.match(f.err(), /更新命令没有执行/)
    assert.equal(existsSync(mark), false)
    assert.equal(f.spawned.length, 0)
  } finally { await f.close() }
})

test('两个请求同时进入：只有一位执行者，结果通知完成前不释放锁', async () => {
  const f = await fixture(() => [])
  try {
    const first = f.cli(['restart', '--notify', 'aaaa1111'])
    const second = f.cli(['restart', '--notify', 'bbbb2222'])
    assert.deepEqual(await Promise.all([first, second]), [0, 0])
    assert.equal(f.appCalls.filter((x) => x === 'quit').length, 1)
    assert.deepEqual(f.sent.map((x) => x.session).sort(), ['aaaa1111', 'bbbb2222'])
    assert.ok(f.sent.every((x) => /restarted successfully/.test(x.text)))
    assert.equal(existsSync(join(f.dir, 'dsh-control/restart.lock')), false)
  } finally { await f.close() }
})

test('损坏空锁不冒充进程 -1 已排队', async () => {
  const f = await fixture(() => [])
  try {
    mkdirSync(join(f.dir, 'dsh-control'), { recursive: true })
    writeFileSync(join(f.dir, 'dsh-control/restart.lock'), '')
    assert.equal(await f.cli(['restart', '--notify', 'aaaa1111']), 2)
    assert.equal(existsSync(join(f.dir, 'dsh-control/restart.waiters.-1')), false)
    assert.deepEqual(f.appCalls, [])
  } finally { await f.close() }
})

test('状态读失败：不退出、不执行更新，并保存真实失败状态', async () => {
  for (const options of [{ quitCheckFails: true }, { badHealth: true, quitCheckFails: true }]) {
    const f = await fixture(() => [], options)
    try {
      const mark = join(f.dir, 'must-not-run')
      const args = options.quitCheckFails ? ['restart', '--notify', 'aaaa1111', '--before', `touch ${mark}`] : ['restart', '--notify', 'aaaa1111']
      assert.equal(await f.cli(args), 1)
      assert.deepEqual(f.appCalls, [])
      assert.equal(existsSync(mark), false)
      assert.ok(f.sent.some((x) => /did not restart/.test(x.text)))
      assert.equal(await f.cli(['restart-status', '--json']), 0)
      assert.equal(JSON.parse(f.out()).data.phase, 'failed')
    } finally { await f.close() }
  }
})

test('health 答不了但退出状态能答：按退出状态判断，照常重启', async () => {
  // 2026-10-17 升 0.2.1：旧插件的 health 报缺调用身份，quit-check 照常；不能因此卡死在「只有重启才能换新插件」
  const f = await fixture(() => [], { oldHealthBroken: true })
  try {
    assert.equal(await f.cli(['restart', '--notify', 'aaaa1111']), 0, f.err())
    assert.deepEqual(f.appCalls, ['quit', 'open'])
    assert.match(f.sent[0]!.text, /DSH restarted successfully/)
  } finally { await f.close() }
})

test('普通进程查询异常也回滚监听和通知，不丢锁', async () => {
  const f = await fixture(() => [], { jobs: ['monitor-3'], survivable: ['monitor-3'], runningThrowsAfterPrepare: true })
  try {
    assert.equal(await f.cli(['restart', '--notify', 'aaaa1111']), 1)
    assert.equal(f.aborted(), 1)
    assert.match(f.sent[0]!.text, /pgrep 状态异常/)
    assert.equal(existsSync(join(f.dir, 'dsh-control/restart.lock')), false)
  } finally { await f.close() }
})

test('只修改全局补丁也必须重新检查，失败不能退出', async () => {
  const f = await fixture(() => [])
  try {
    const doctor = join(f.dir, 'profiles/desktop/node_modules/tooling/doctor-cli.mjs')
    const before = `printf bad > ${join(f.dir, 'cordis.patch.yml')}; printf '%s' '${JSON.stringify("console.log(JSON.stringify({ok:false,checks:[{id:'bad',ok:false,message:'全局配置已变坏'}]}));process.exit(1)").slice(1,-1)}' > ${doctor}`
    assert.equal(await f.cli(['restart', '--notify', 'aaaa1111', '--before', before]), 1)
    assert.deepEqual(f.appCalls, [])
    assert.match(f.out(), /全局配置已变坏/)
  } finally { await f.close() }
})

test('旧通信口一直在或会话服务没就绪都不得宣布重启完成', async () => {
  for (const options of [{ sameInstance: true }, { startupUnavailable: true }, { stuckKill: true }]) {
    const f = await fixture(() => [], options)
    try {
      const code = await f.cli(['restart', ...(options.stuckKill ? ['--kill'] : []), '--notify', 'aaaa1111'], { DSH_CONTROL_START_TIMEOUT_MS: '30', DSH_CONTROL_EXIT_TIMEOUT_MS: '30' })
      assert.notEqual(code, 0)
      assert.ok(!f.sent.some((x) => x.summary === 'DSH restarted successfully'))
    } finally { await f.close() }
  }
})

test('重启状态区分真实完成与执行进程失联，不把排队当成功', async () => {
  const f = await fixture(() => [])
  try {
    assert.equal(await f.cli(['restart']), 0)
    await f.cli(['restart-status', '--json'])
    assert.equal(JSON.parse(f.out()).data.phase, 'completed')
    writeFileSync(join(f.dir, 'dsh-control/restart-state.json'), JSON.stringify({ phase: 'waiting', pid: 999999 }))
    await f.cli(['restart-status', '--json'])
    assert.equal(JSON.parse(f.out()).data.phase, 'interrupted')
  } finally { await f.close() }
})

test('restart：重启那一刻在跑的会话被记下，重启后逐个发「继续」；发起的会话只收一条结果', async () => {
  const f = await fixture(() => ['session-bbbb2222', 'session-cccc3333', 'session-aaaa1111'])
  try {
    const code = await f.cli(['restart', '--notify', 'aaaa1111'])
    assert.equal(code, 0, f.err())
    assert.match(f.out(), /打断 3 个在跑的会话/)
    assert.deepEqual(f.cancelled, ['session-bbbb2222', 'session-cccc3333', 'session-aaaa1111'], '退出前先中止，免得 App 弹确认框')
    assert.deepEqual(f.appCalls, ['quit', 'open'])
    const resumes = f.sent.filter((s) => s.summary === 'Previous turn interrupted by the system (not the user); continue')
    assert.deepEqual(resumes.map((s) => s.session), ['session-bbbb2222', 'session-cccc3333'])
    assert.ok(resumes.every((s) => s.via === 'notice' && /not stopped by the user/.test(s.text)), '继续消息走插件通知，不冒充用户')
    assert.ok(resumes.every((s) => /Continue the original work/.test(s.text) && /Do not explain this interruption/.test(s.text)), '被打断的会话不关心重启，只要知道接着做、别把中断当新任务汇报')
    assert.ok(f.sent.every((s) => !s.text.startsWith('【自动消息')), '通知本身已标明来源，正文不再加前缀')
    const report = f.sent.filter((s) => s.session === 'aaaa1111')
    assert.equal(report.length, 1)
    assert.match(report[0]!.text, /were told to continue: bbbb2222, cccc3333/)
    assert.match(report[0]!.text, /This turn was also interrupted by the restart \(not by the user\)/)
  } finally { await f.close() }
})

test('继续消息发不出去要如实报告，不能说都继续了', async () => {
  const f = await fixture(() => ['session-bbbb2222', 'session-dddd4444'], { sendFails: (s) => s === 'session-dddd4444' })
  try {
    const code = await f.cli(['restart', '--notify', 'aaaa1111'])
    assert.equal(code, 0, f.err())
    const report = f.sent.find((s) => s.session === 'aaaa1111')!
    assert.match(report.text, /were told to continue: bbbb2222/)
    assert.match(report.text, /1 other interrupted session\(s\) could not be told to continue: dddd4444/)
  } finally { await f.close() }
})

test('restart --kill：有会话在跑也直接结束进程再拉起', async () => {
  const f = await fixture(() => ['session-bbbb2222'])
  try {
    assert.equal(await f.cli(['restart', '--kill']), 0, f.err())
    assert.deepEqual(f.appCalls, ['kill-TERM', 'open'])
  } finally { await f.close() }
})

// 2026-10-21 后台启动失败、App 停在崩溃窗口上：通信口没了，restart 连 都拒绝，只能手动强杀。
test('后台崩了只剩崩溃窗口时直接结束再拉起；后台还在只是连不上照旧拒绝', async () => {
  for (const args of [['restart'], ['restart']]) {
    const f = await fixture(() => [], { socketGone: 'crashed' })
    try {
      assert.equal(await f.cli(args), 0, f.err())
      assert.deepEqual(f.appCalls, ['kill-TERM', 'open'])
      assert.match(f.out(), /后台已经停了/)
    } finally { await f.close() }
  }
  const g = await fixture(() => [], { socketGone: 'plugin-broken' })
  try {
    assert.equal(await g.cli(['restart'], { DSH_CONTROL_RELOAD_GRACE_MS: '50' }), 1)
    assert.match(g.err() + g.out(), /无法确认有没有会话在跑/)
    assert.deepEqual(g.appCalls, [])
  } finally { renameSync(join(g.dir, 'dsh-control/dsh.sock.off'), join(g.dir, 'dsh-control/dsh.sock')); await g.close() }
})
// 2026-10-21 --before 写 profile 触发热重载，本插件通信口重建要两秒多，restart 正好在空档里查会话，被当成通信口坏了拒绝。
test('通信口在热重载中暂时没了：等它回来再查会话，照常重启', async () => {
  const f = await fixture(() => [], { socketGone: 'plugin-broken' })
  try {
    const socket = join(f.dir, 'dsh-control/dsh.sock')
    setTimeout(() => renameSync(`${socket}.off`, socket), 300)
    assert.equal(await f.cli(['restart']), 0, f.err())
    assert.equal(f.appCalls.includes('open'), true)
    assert.doesNotMatch(f.err() + f.out(), /无法确认有没有会话在跑/)
  } finally { await f.close() }
})

test('DSH 不支持通知时退回普通消息', async () => {
  const f = await fixture(() => ['session-bbbb2222'], { noNotice: true })
  try {
    const code = await f.cli(['restart', '--notify', 'aaaa1111'])
    assert.equal(code, 0, f.err())
    assert.deepEqual(f.sent.map((s) => [s.session, s.via]), [['session-bbbb2222', 'send'], ['aaaa1111', 'send']])
  } finally { await f.close() }
})

test('刚起来时会话服务还没好：不到一秒内重试送达，不等 3 秒', async () => {
  const f = await fixture(() => [], { notReadyFor: 2 })
  try {
    const began = Date.now()
    assert.equal(await f.cli(['restart', '--notify', 'aaaa1111']), 0, f.err())
    assert.equal(f.sent.length, 1)
    assert.ok(Date.now() - began < 2000, `重试太慢：${Date.now() - began} 毫秒`)
  } finally { await f.close() }
})

test('--detach：每次重启一份带时间戳的日志，只留最近 20 份', async () => {
  const f = await fixture(() => [])
  try {
    const logs = join(f.dir, 'dsh-control/restart-logs')
    mkdirSync(logs, { recursive: true })
    for (let i = 0; i < 25; i++) writeFileSync(join(logs, `restart-20260101-0000${String(i).padStart(2, '0')}-1.log`), 'old')
    writeFileSync(join(logs, 'notes.txt'), '不是重启日志，不能删')
    assert.equal(await f.cli(['restart', '--detach']), 0, f.err())
    const child = f.spawned[0]!
    assert.match(child.log, /restart-logs\/restart-\d{8}-\d{6}-\d+\.log$/)
    assert.equal(child.env['DSH_CONTROL_RESTART_LOG'], child.log, '后台进程要知道自己的日志路径，通知里写的才是这一份')
    assert.match(f.out(), new RegExp(`过程记在 ${child.log.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    const left = readdirSync(logs)
    assert.equal(left.filter((n) => n.startsWith('restart-')).length, 19, '加上这次新的一份正好 20 份')
    assert.ok(left.includes('notes.txt'))
    assert.ok(!left.includes('restart-20260101-000000-1.log'), '删最老的')
  } finally { await f.close() }
})

test('强制重启 先停后台任务再退出；停不掉就结束 DSH 进程再拉起', async () => {
  const ok = await fixture(() => [], { jobs: ['bash-3', 'monitor-1'] })
  try {
    assert.equal(await ok.cli(['restart']), 0, ok.err())
    assert.deepEqual(ok.killedJobs, ['bash-3', 'monitor-1'])
    assert.deepEqual(ok.appCalls, ['quit', 'open'])
  } finally { await ok.close() }
  const stuck = await fixture(() => [], { jobs: ['bash-3'], stubbornJobs: true })
  try {
    assert.equal(await stuck.cli(['restart']), 0, stuck.err())
    assert.deepEqual(stuck.appCalls, ['kill-TERM', 'open'])
    assert.match(stuck.out() + stuck.err(), /1 个后台任务还在跑[\s\S]*结束 DSH 进程再拉起/)
  } finally { await stuck.close() }
})

test('登记过结果的会话被强制重启中止：重启结果和「继续」合成一条，不连发', async () => {
  const f = await fixture(() => ['session-bbbb2222'])
  try {
    mkdirSync(join(f.dir, 'dsh-control'), { recursive: true })
    writeFileSync(join(f.dir, `dsh-control/restart.waiters.${process.pid}`), 'session-bbbb2222\n')
    assert.equal(await f.cli(['restart', '--notify', 'aaaa1111']), 0, f.err())
    const toB = f.sent.filter((s) => s.session === 'session-bbbb2222')
    assert.equal(toB.length, 1, toB.map((s) => s.text).join('\n---\n'))
    assert.match(toB[0]!.text, /DSH restarted successfully[\s\S]*Continue the original work/)
  } finally { await f.close() }
})

test('--detach：转后台时去掉会话专属变量、默认通知发起的会话、参数原样带过去', async () => {
  const f = await fixture(() => [])
  try {
    const code = await f.cli(['restart', '--detach'], { DSH_SESSION_ID: 'session-eeee5555', DSH_SHELL: '1' })
    assert.equal(code, 0, f.err())
    assert.equal(f.spawned.length, 1)
    const child = f.spawned[0]!
    assert.deepEqual(child.args, ['restart', '--notify=session-eeee5555'])
    assert.equal(child.env['DSH_SESSION_ID'], undefined)
    assert.equal(child.env['DSH_SHELL'], undefined)
    assert.equal(child.env['DSH_CONTROL_DETACHED'], '1')
    assert.match(child.log, /dsh-control\/restart-logs\/restart-\d{8}-\d{6}-\d+\.log$/)
    assert.match(f.out(), /进程 4242/)
    assert.match(f.out(), /尚未重启/)
    assert.match(f.out(), /会给会话 eeee5555 发消息/)
    assert.equal(f.sent.length, 0, '转后台的这一步本身不发消息')
  } finally { await f.close() }
})

test('启动前检查不过：不重启，原因转告发起的会话', async () => {
  const f = await fixture(() => [])
  try {
    writeFileSync(join(f.dir, 'profiles/desktop/node_modules/tooling/doctor-cli.mjs'), `console.log(JSON.stringify({ok:false,checks:[{id:'x',ok:false,message:'坏 profile'}]}));process.exit(1)`)
    const code = await f.cli(['restart', '--notify', 'aaaa1111'])
    assert.equal(code, 1)
    assert.equal(f.sent.length, 1)
    assert.match(f.sent[0]!.text, /did not restart/)
  } finally { await f.close() }
})


test('只剩开着的监听：退出前先暂停，重启后由插件接回', async () => {
  // 2026-10-09：开着一条飞书监听，等空闲重启一定 5 分钟后放弃，最后只能手动重启
  const f = await fixture(() => [], { jobs: ['monitor-3'], survivable: ['monitor-3'] })
  try {
    const code = await f.cli(['restart', '--notify', 'aaaa1111'], { DSH_CONTROL_JOB_GRACE_MS: '600000' })
    assert.equal(code, 0, f.err())
    assert.deepEqual(f.prepared, ['monitor-3'], '退出前让插件记下并暂停')
    assert.deepEqual(f.killedJobs, [], '监听不是被强停的')
    assert.deepEqual(f.appCalls, ['quit', 'open'])
    assert.equal(f.aborted(), 0)
    assert.match(f.out(), /暂停了 1 条监听，重启后自动接回/)
    const report = f.sent.find((s) => s.session === 'aaaa1111')!
    assert.match(report.text, /1 open monitor\(s\) \(飞书监听\) were paused before the restart; they will be relaunched automatically/)
  } finally { await f.close() }
})

test('正常退出没走通也继续强制重启，暂停的监听交给新进程接回', async () => {
  const f = await fixture(() => [], { jobs: ['monitor-3'], survivable: ['monitor-3'], quitFails: true })
  try {
    const code = await f.cli(['restart', '--notify', 'aaaa1111'])
    assert.equal(code, 0, f.err())
    assert.deepEqual(f.prepared, ['monitor-3'])
    assert.equal(f.aborted(), 0, '继续重启时不提前接回')
    assert.deepEqual(f.appCalls, ['quit', 'kill-TERM', 'open'])
  } finally { await f.close() }
})

test('强制重启：会话挂着自动续跑的目标，先暂停目标再中止，重启后恢复目标', async () => {
  const f = await fixture(() => ['session-bbbb2222'], { goals: { 'session-bbbb2222': 'active' } })
  try {
    const code = await f.cli(['restart'])
    assert.equal(code, 0, f.err())
    assert.deepEqual(f.appCalls, ['quit', 'open'])
    assert.ok(f.goalCalls.indexOf('goals/pause session-bbbb2222') >= 0, '中止前暂停目标，免得它又开下一轮')
    assert.ok(f.goalCalls.indexOf('goals/resume session-bbbb2222') > f.goalCalls.indexOf('goals/pause session-bbbb2222'))
    assert.equal(f.goals.get('session-bbbb2222')?.phase, 'active')
  } finally { await f.close() }
})

test('强制重启：子代理没跟着上级停下，也要中止它，不等满 5 秒后放弃', async () => {
  const f = await fixture(() => ['session-bbbb2222'], { subagents: ['session-sub00001'], parents: { 'session-sub00001': 'session-bbbb2222' } })
  try {
    const code = await f.cli(['restart'])
    assert.equal(code, 0, f.err())
    assert.ok(f.cancelled.includes('session-sub00001'))
    assert.deepEqual(f.appCalls, ['quit', 'open'])
  } finally { await f.close() }
})

test('强制重启停掉的后台任务和子代理：子代理的上级被唤醒接着做，闲着的任务主人只收到不唤醒的说明', async () => {
  const f = await fixture(() => ['session-bbbb2222'], {
    jobs: ['bash-9'],
    parents: { 'session-sub00001': 'session-cccc3333', 'bash-9': 'session-dddd4444' },
    quitExtra: (n) => (n < 1 ? { running: ['session-sub00001'] } : {}),
  })
  try {
    const code = await f.cli(['restart', '--notify', 'aaaa1111'])
    assert.equal(code, 0, f.err())
    assert.deepEqual(f.killedJobs, ['bash-9'])
    const sub = f.sent.find((s) => s.session === 'session-cccc3333')!
    assert.ok(sub !== undefined, '子代理的上级会话要收到说明')
    assert.equal(sub.via, 'notice')
    assert.equal(sub.quiet, undefined, '上级在等子代理的结果，要唤醒它')
    assert.match(sub.text, /Your subagent\(s\) sub00001 were interrupted during the restart; their results will not arrive\. Use send_message to let them continue, or start them again\./)
    assert.match(sub.text, /not stopped by the user/)
    const job = f.sent.filter((s) => s.session === 'session-dddd4444')
    assert.equal(job.length, 1)
    assert.equal(job[0]!.quiet, true, '闲着的任务主人不唤醒')
    assert.match(job[0]!.text, /Your background job\(s\) bash-9 \(x, 查不到它启动时的目录\) were stopped and could not be relaunched/)
    assert.deepEqual(f.monitors, [], '查不到目录就不拉起')
    const report = f.sent.find((s) => s.session === 'aaaa1111')!
    assert.match(report.text, /Background jobs left by idle sessions.*dddd4444: x \(not relaunched: 查不到它启动时的目录\)/)
  } finally { await f.close() }
})

test('强制重启：后台任务在原会话里用原命令原目录重新拉起；主人闲着不唤醒，主人在跑的照常继续', async () => {
  const f = await fixture(() => ['session-bbbb2222'], {
    jobs: ['bash-8', 'bash-9'],
    parents: { 'bash-8': 'session-bbbb2222', 'bash-9': 'session-dddd4444' },
    jobCwd: { 'bash-8': '/tmp/a', 'bash-9': '/tmp/b' },
  })
  try {
    assert.equal(await f.cli(['restart', '--notify', 'aaaa1111']), 0, f.err())
    assert.deepEqual(f.monitors, [
      { owner: 'session-bbbb2222', command: 'x', cwd: '/tmp/a', label: 'x', restart: 'never', quiet: true },
      { owner: 'session-dddd4444', command: 'x', cwd: '/tmp/b', label: 'x', restart: 'never', quiet: true },
    ])
    const idle = f.sent.filter((s) => s.session === 'session-dddd4444')
    assert.equal(idle.length, 1)
    assert.equal(idle[0]!.quiet, true)
    assert.match(idle[0]!.text, /Your background job\(s\) bash-9 \(x\) were relaunched.*new ids: monitor-new-2/)
    const busy = f.sent.filter((s) => s.session === 'session-bbbb2222')
    assert.deepEqual(busy.map((s) => s.quiet), [undefined], '在跑的主人：「继续」和任务说明合成一条')
    assert.match(busy[0]!.text, /Continue the original work[\s\S]*bash-8 \(x\) were relaunched in the original directory with the original command; new ids: monitor-new-1/)
    assert.match(f.sent.find((s) => s.session === 'aaaa1111')!.text, /Background jobs left by idle sessions.*dddd4444: x \(new id monitor-new-2\)/)
  } finally { await f.close() }
})

test('强制重启：停任务把闲着的主人叫醒了，它被中止后不算被打断，重启后不叫它继续', async () => {
  const f = await fixture(() => ['session-bbbb2222'], {
    jobs: ['bash-9'], parents: { 'bash-9': 'session-dddd4444' }, jobCwd: { 'bash-9': '/tmp/b' }, wakeOnKill: true,
  })
  try {
    assert.equal(await f.cli(['restart', '--notify', 'aaaa1111']), 0, f.err())
    assert.ok(f.cancelled.includes('session-dddd4444'), '清场时照样中止')
    const toOwner = f.sent.filter((s) => s.session === 'session-dddd4444')
    assert.deepEqual(toOwner.map((s) => s.quiet), [true], '只收一条不唤醒的说明，没有「继续」')
    assert.equal(f.monitors.length, 1)
  } finally { await f.close() }
})

test('强制重启：给闲主人放说明失败时，原因写进日志和发起者的报告', async () => {
  const f = await fixture(() => ['session-bbbb2222'], {
    jobs: ['bash-9'], parents: { 'bash-9': 'session-dddd4444' }, jobCwd: { 'bash-9': '/tmp/b' }, archived: ['session-dddd4444'],
  })
  try {
    assert.equal(await f.cli(['restart', '--notify', 'aaaa1111']), 0, f.err())
    assert.match(f.sent.find((s) => s.session === 'aaaa1111')!.text, /dddd4444: x \(new id monitor-new-1\) \[notice not delivered:/)
  } finally { await f.close() }
})

test('强制重启：拉起失败如实告诉主人和发起者', async () => {
  const f = await fixture(() => ['session-bbbb2222'], {
    jobs: ['bash-9'], parents: { 'bash-9': 'session-dddd4444' }, jobCwd: { 'bash-9': '/tmp/b' }, monitorFails: true,
  })
  try {
    assert.equal(await f.cli(['restart', '--notify', 'aaaa1111']), 0, f.err())
    assert.match(f.sent.find((s) => s.session === 'session-dddd4444')!.text, /Your background job\(s\) bash-9 \(x, 监听插件未确认服务及所属会话\) were stopped and could not be relaunched/)
    assert.match(f.sent.find((s) => s.session === 'aaaa1111')!.text, /dddd4444: x \(not relaunched: 监听插件未确认服务及所属会话\)/)
  } finally { await f.close() }
})

test('强制重启：清场途中才开跑的会话也被中止，重启后同样让它继续', async () => {
  const f = await fixture(() => ['session-bbbb2222'], { quitExtra: (n) => (n < 1 ? { running: ['session-eeee5555'] } : {}) })
  try {
    assert.equal(await f.cli(['restart', '--notify', 'aaaa1111']), 0, f.err())
    assert.ok(f.cancelled.includes('session-eeee5555'))
    const resumes = f.sent.filter((s) => s.summary === 'Previous turn interrupted by the system (not the user); continue').map((s) => s.session)
    assert.deepEqual(resumes, ['session-bbbb2222', 'session-eeee5555'])
  } finally { await f.close() }
})

test('强制重启：被中止吞掉的消息先原样放回；只中止了它开启的那一轮就不另发「继续」，原来的活也被打断的照发', async () => {
  // 真实故障（2026-11-03 19:37）：清场途中你刚发的消息开了一轮，宿主已从排队区取走、还没写进记录就被中止。
  const lost = {
    'session-eeee5555': { restored: [{ target: 'next-turn', preview: '我批注了以下内容' }], otherAborted: false },
    // 原来在做的那一轮先被中止，排着的消息接着开了一轮又被中止：两件事都没做完。
    'session-bbbb2222': { restored: [{ target: 'next-turn', preview: '顺便改一下' }], otherAborted: true },
  }
  const f = await fixture(() => ['session-bbbb2222'], { lost, quitExtra: (n) => (n < 1 ? { running: ['session-eeee5555'] } : {}) })
  try {
    const before = Date.now()
    assert.equal(await f.cli(['restart', '--notify', 'aaaa1111']), 0, f.err())
    assert.deepEqual(f.requeueCalls.map((c) => c.session).sort(), ['session-bbbb2222', 'session-eeee5555'])
    for (const c of f.requeueCalls) assert.ok(Number(c.since) <= before + 1000 && Number(c.since) >= before - 60_000, '只找这次重启开始之后被中止的')
    const resumes = f.sent.filter((s) => s.summary === 'Previous turn interrupted by the system (not the user); continue').map((s) => s.session)
    assert.deepEqual(resumes, ['session-bbbb2222'], '只中止了吞消息那一轮的，放回去它自己会跑')
    const result = f.sent.find((s) => s.session === 'aaaa1111')!
    assert.match(result.text, /User messages that were swallowed.*eeee5555 \(1 message\(s\)\)/)
    assert.match(result.text, /were told to continue: .*eeee5555/, '放回消息也算让它接着做，不报没发出去')
  } finally { await f.close() }
})

test('强制重启：排队消息清不掉时最多等 5 秒，随后自动结束进程再拉起', async () => {
  const f = await fixture(() => [], { queued: ['session-queued01'] })
  try {
    const startedAt = Date.now()
    assert.equal(await f.cli(['restart'], { DSH_CONTROL_QUIT_CLEAR_MS: '5000' }), 0, f.err())
    assert.ok(Date.now() - startedAt < 15_000, '不能退回原来的 20 秒等待')
    assert.deepEqual(f.appCalls, ['kill-TERM', 'open'], '清不干净时不弹出需要人工确认的退出框')
    assert.match(f.out(), /等了 5 秒，退出仍会弹确认框：1 个会话还有排队消息/)
  } finally { await f.close() }
})

test('强制重启 已中止会话、退出命令没生效：改为结束 DSH 进程再拉起，照常重启', async () => {
  const f = await fixture(() => ['session-bbbb2222'], { quitFails: true })
  try {
    assert.equal(await f.cli(['restart', '--notify', 'aaaa1111']), 0, f.err())
    assert.deepEqual(f.appCalls, ['quit', 'kill-TERM', 'open'])
    assert.match(f.out() + f.err(), /结束 DSH 进程再拉起/)
    assert.match(f.sent.find((s) => s.session === 'session-bbbb2222')!.text, /Continue the original work/)
  } finally { await f.close() }
})

test('强制重启 已中止会话、连进程都结束不掉：被中止的会话照样收到「继续」，任务主人收到说明', async () => {
  const f = await fixture(() => ['session-bbbb2222', 'session-aaaa1111'], { quitFails: true, stuckKill: true, jobs: ['bash-9'], parents: { 'bash-9': 'session-dddd4444' } })
  try {
    assert.equal(await f.cli(['restart', '--notify', 'aaaa1111'], { DSH_CONTROL_EXIT_TIMEOUT_MS: '30' }), 1)
    assert.deepEqual(f.appCalls, ['quit', 'kill-TERM', 'kill-KILL'])
    const resume = f.sent.find((s) => s.session === 'session-bbbb2222')!
    assert.match(resume.text, /Continue the original work/)
    const owner = f.sent.find((s) => s.session === 'session-dddd4444')!
    assert.equal(owner.quiet, true)
    assert.match(owner.text, /Your background job\(s\) bash-9 \(x, 查不到它启动时的目录\) were stopped and could not be relaunched/)
    const report = f.sent.filter((s) => s.session === 'aaaa1111')
    assert.equal(report.length, 1, '发起的会话只收一条结果')
    assert.match(report[0]!.text, /DSH did not restart/)
    assert.match(report[0]!.text, /This turn was interrupted before the restart/)
    assert.match(report[0]!.text, /were told to continue: bbbb2222/)
  } finally { await f.close() }
})

test('--before：用上级身份中止子代理，保留后台通知并执行更新', async () => {
  const parent = 'session-parent01'
  const child = 'session-child001'
  const quiet = 'session-quiet001'
  let mark = ''
  const f = await fixture(() => [parent], {
    subagents: [child], parents: { [child]: parent }, queued: [quiet],
    queuedDetails: [{ id: quiet, nextTurnCount: 0, nextStepCount: 1, nextStepSources: [{ kind: 'dsh-monitor', form: 'notice' }] }],
    queueDrained: () => mark !== '' && existsSync(mark),
  })
  try {
    mark = join(f.dir, 'before-ran')
    const code = await f.cli(['restart', '--notify', 'aaaa1111', '--before', `touch ${mark}`])
    assert.equal(code, 0, f.err())
    assert.equal(existsSync(mark), true)
    assert.ok(f.cancelled.includes(child))
    assert.deepEqual(f.appCalls, ['quit', 'open'])
  } finally { await f.close() }
})

test('--before：用户排队消息仍会阻止更新，不会被当成后台通知', async () => {
  const id = 'session-queued01'
  const f = await fixture(() => [], {
    queued: [id], queuedDetails: [{ id, nextTurnCount: 1, nextStepCount: 1, nextStepSources: [{ kind: 'dsh-monitor', form: 'notice' }] }],
  })
  try {
    const mark = join(f.dir, 'before-must-not-run')
    const code = await f.cli(['restart', '--before', `touch ${mark}`])
    assert.equal(code, 1, f.err())
    assert.equal(existsSync(mark), false)
    assert.deepEqual(f.appCalls, [])
    assert.match(f.out(), /更新命令未执行，本次没有重启/)
  } finally { await f.close() }
})

test('--before 遇到无法中止的子代理：不执行更新、不重启，也不报成功', async () => {
  const subagent = 'session-sub00001'
  const f = await fixture(() => ['session-bbbb2222'], { subagents: [subagent], refusedCancel: [subagent], parents: { [subagent]: 'session-bbbb2222' } })
  try {
    const mark = join(f.dir, 'before-must-not-run')
    const code = await f.cli(['restart', '--notify', 'aaaa1111', '--before', `touch ${mark}`])
    assert.equal(code, 1, f.err())
    assert.equal(existsSync(mark), false)
    assert.deepEqual(f.appCalls, [])
    const notice = f.sent.find((s) => s.session === 'aaaa1111')!
    assert.match(notice.text, /更新命令未执行，本次没有重启/)
    assert.doesNotMatch(notice.text, /DSH restarted successfully/)
    await f.cli(['restart-status', '--json'])
    const state = JSON.parse(f.out()).data
    assert.equal(state.phase, 'failed')
    assert.equal(state.failure.stage, 'before')
    assert.equal(state.failure.executed, false)
  } finally { await f.close() }
})

test('--before 遇到后台崩溃：不跳过更新直接报告重启成功', async () => {
  const f = await fixture(() => [], { socketGone: 'crashed' })
  try {
    const mark = join(f.dir, 'before-must-not-run')
    const code = await f.cli(['restart', '--before', `touch ${mark}`])
    assert.equal(code, 1, f.err())
    assert.equal(existsSync(mark), false)
    assert.deepEqual(f.appCalls, [])
    assert.match(f.out() + f.err(), /更新命令未执行，本次没有重启/)
  } finally { await f.close() }
})

test('--before：先中止会话再跑命令，重跑离线检查后退出；--kill 仍拒绝', async () => {
  const f = await fixture(() => ['session-bbbb2222'])
  try {
    const mark = join(f.dir, 'before-ran')
    const code = await f.cli(['restart', '--notify', 'aaaa1111', '--before', `touch ${mark}`])
    assert.equal(code, 0, f.err())
    assert.ok(existsSync(mark))
    assert.deepEqual(f.cancelled, ['session-bbbb2222'])
    assert.equal((f.out().match(/通过 \[fixture\]/g) ?? []).length, 2, '跑完命令后重跑离线检查')
    assert.deepEqual(f.appCalls, ['quit', 'open'])
    assert.ok(f.sent.some((s) => s.session === 'session-bbbb2222' && /Continue the original work/.test(s.text)))
    assert.equal(await f.cli(['restart', '--before', 'true']), 0, f.err())
    assert.deepEqual(f.appCalls, ['quit', 'open', 'quit', 'open'])
    assert.equal(await f.cli(['restart', '--kill', '--before', 'true']), 2)
    assert.match(f.err(), /--before 不能和 --kill 同用/)
  } finally { await f.close() }
  const bad = await fixture(() => ['session-bbbb2222'])
  try {
    assert.equal(await bad.cli(['restart', '--notify', 'aaaa1111', '--before', 'exit 3']), 1)
    assert.deepEqual(bad.appCalls, [], '命令没做成就不退出')
    assert.ok(bad.sent.some((s) => s.session === 'session-bbbb2222' && /Continue the original work/.test(s.text)), '已中止的会话要接着做')
    assert.match(bad.sent.find((s) => s.session === 'aaaa1111')!.text, /重启前要做的事没做成/)
  } finally { await bad.close() }
})

test('--before 失败就不重启，原因转告发起的会话；默认可以直接使用', async () => {
  const f = await fixture(() => [])
  try {
    const code = await f.cli(['restart', '--notify', 'aaaa1111', '--before', 'echo 装依赖出错 >&2; exit 3'])
    assert.equal(code, 1)
    assert.deepEqual(f.appCalls, [], '重启前的事没做成就不能退出 DSH')
    assert.match(f.sent[0]!.text, /重启前要做的事没做成（阶段 before，退出码 3）[^]*装依赖出错/)
    assert.equal(await f.cli(['restart', '--before', 'true']), 0, f.err())
    assert.deepEqual(f.appCalls, ['quit', 'open'])
  } finally { await f.close() }
})

test('只剩定时提醒的退出框：确认没有会话在跑后替用户点「退出」，照常重启', async () => {
  // 2026-10-17 真实故障：会话都空闲，只剩一条测试提醒，App 退出弹「应用关闭期间，定时任务不会运行」，命令干等 30 秒。
  const scheduled = [{ sessionId: 'session-424e24d6-e0f0', items: [{ id: 'schedule-de8631b1-0ae6', label: 'dsh-control 验收测试提醒' }] }]
  const f = await fixture(() => [], { scheduled, dialog: 'scheduled' })
  try {
    assert.equal(await f.cli(['restart']), 0, f.err())
    assert.deepEqual(f.appCalls, ['quit', 'confirm', 'open'])
    assert.match(f.out(), /「dsh-control 验收测试提醒」（de8631b1，会话 424e24d6）/)
    assert.match(f.out(), /已替你点「退出」/)
  } finally { await f.close() }
  const g = await fixture(() => [], { scheduled: [] })
  try {
    assert.equal(await g.cli(['restart']), 0, g.err())
    assert.deepEqual(g.appCalls, ['quit', 'open'])
  } finally { await g.close() }
})

test('屏幕锁着：只剩提醒时直接结束进程；其他退出框超时后也结束进程再拉起', async () => {
  // 锁屏故障回归：屏幕睡眠后要求密码，辅助功能看不到窗口，提醒框没点到，干等 30 秒失败，日志也没写原因。
  const scheduled = [{ sessionId: 'session-d64eaf98-18c5-4f20-9eda-88ded280feab', items: [{ id: 'schedule-2b58e23f-f44f-4716-bd23-0b09504f2ed5', label: '清理 Sub-Store 相关命令、文件和规则' }] }]
  const f = await fixture(() => [], { scheduled, dialog: 'scheduled', locked: true })
  try {
    assert.equal(await f.cli(['restart']), 0, f.err())
    assert.deepEqual(f.appCalls, ['kill-TERM', 'open'])
    assert.match(f.out(), /屏幕锁着.*改为结束进程再拉起/)
  } finally { await f.close() }
  const g = await fixture(() => [], { scheduled: [], locked: true })
  try {
    assert.equal(await g.cli(['restart']), 0, g.err())
    assert.deepEqual(g.appCalls, ['quit', 'open'])
  } finally { await g.close() }
  const h = await fixture(() => [], { scheduled: [], dialog: 'other', locked: true })
  try {
    assert.equal(await h.cli(['restart']), 0, h.err())
    assert.deepEqual(h.appCalls, ['quit', 'confirm', 'kill-TERM', 'open'])
    assert.match(h.out(), /屏幕锁着.*改为结束 DSH 进程再拉起/)
  } finally { await h.close() }
})

test('退出框有任务警告或又有会话开跑：不替你点，结束进程再拉起', async () => {
  const scheduled = [{ sessionId: 'session-424e24d6-e0f0', items: [{ id: 'schedule-de8631b1-0ae6', label: '提醒' }] }]
  const f = await fixture(() => [], { scheduled, dialog: 'other' })
  try {
    assert.equal(await f.cli(['restart']), 0, f.err())
    assert.deepEqual(f.appCalls, ['quit', 'confirm', 'kill-TERM', 'open'])
    assert.match(f.out(), /other:当前正在运行的任务将会中断/)
    assert.match(f.out(), /改为结束 DSH 进程再拉起/)
  } finally { await f.close() }
  const g = await fixture(() => [], { scheduled, dialog: 'scheduled', busyAtDialog: true })
  try {
    assert.equal(await g.cli(['restart']), 0, g.err())
    assert.deepEqual(g.appCalls, ['quit', 'kill-TERM', 'open'])
    assert.match(g.out(), /session-late|会话/)
  } finally { await g.close() }
})

test('--before 真实故障形状：doctor 根因优先，通知与状态一致，完整日志保留 warning，只执行一次', async () => {
  const f = await fixture(() => [])
  try {
    const script = join(f.dir, 'failure.mjs')
    const mark = join(f.dir, 'count')
    const report = { ok: false, checks: [{ id: 'link-build-freshness', ok: false, message: '多项正常; dsh-example: 构建内容已变化: inputs: core/doctor.mjs' }] }
    writeFileSync(script, `import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(mark)},'once\\n');console.log(${JSON.stringify(JSON.stringify(report))});console.log(JSON.stringify({event:'部署未完成，已恢复本轮写入',reason:'Command ... exited1'}));console.error('WARN external/noExternal 已弃用\\n'.repeat(10));process.exitCode=1`)
    assert.equal(await f.cli(['restart', '--notify', 'aaaa1111', '--before', `exec '${process.execPath}' '${script}'`]), 1)
    assert.deepEqual(f.appCalls, [])
    assert.equal(readFileSync(mark, 'utf8'), 'once\n')
    const state = JSON.parse(readFileSync(join(f.dir, 'dsh-control/restart-state.json'), 'utf8'))
    assert.equal(state.phase, 'failed')
    assert.equal(state.exitCode, 1)
    assert.equal(state.failedStage, 'before')
    assert.equal(state.failure.exitCode, 1)
    assert.match(state.message, /link-build-freshness.*dsh-example.*core\/doctor\.mjs/)
    assert.doesNotMatch(state.failure.reason, /WARN|Command/)
    assert.match(readFileSync(state.failure.stderrLog, 'utf8'), /WARN external/)
    assert.match(readFileSync(state.failure.stdoutLog, 'utf8'), /部署未完成/)
    assert.ok(f.sent[0]!.text.includes(state.message))
    assert.equal(state.notification, 'scheduled')
    assert.equal(await f.cli(['restart-status', '--json']), 0)
    assert.deepEqual(JSON.parse(f.out()).data.failure, state.failure)
  } finally { await f.close() }
})

test('--before 大输出和无 JSON 错误不触发缓冲中断，stdout/stderr完整保存', async () => {
  const f = await fixture(() => [])
  try {
    const script = join(f.dir, 'large.mjs')
    const normal = '中文输出\n'.repeat(300000)
    writeFileSync(script, `process.stdout.write(${JSON.stringify(normal)});process.stderr.write('Error: permission denied\\nWARN external/noExternal 已弃用\\n');process.exitCode=2`)
    assert.equal(await f.cli(['restart', '--notify', 'aaaa1111', '--before', `exec '${process.execPath}' '${script}'`]), 1)
    const state = JSON.parse(readFileSync(join(f.dir, 'dsh-control/restart-state.json'), 'utf8'))
    assert.equal(state.failure.exitCode, 2)
    assert.equal(state.failure.signal, null)
    assert.equal(state.failure.reason, 'Error: permission denied')
    assert.equal(readFileSync(state.failure.stdoutLog, 'utf8'), normal)
    assert.deepEqual(f.appCalls, [])
  } finally { await f.close() }
})

test('--before 结构化错误阶段优先于后续 rollback 阶段，通知保留实际退出码', async () => {
  const f = await fixture(() => [])
  try {
    const script = join(f.dir, 'stage.mjs')
    writeFileSync(script, `console.log(JSON.stringify({ok:false,error:{code:'deployment-failed',stage:'verify-startup',message:'插件未加载'}}));console.log(JSON.stringify({stage:'rollback',event:'部署未完成，已恢复本轮写入',reason:'Command exited7'}));process.exitCode=7`)
    assert.equal(await f.cli(['restart', '--notify', 'aaaa1111', '--before', `exec '${process.execPath}' '${script}'`]), 1)
    const state = JSON.parse(readFileSync(join(f.dir, 'dsh-control/restart-state.json'), 'utf8'))
    assert.equal(state.failure.commandStage, 'verify-startup')
    assert.equal(state.failure.exitCode, 7)
    assert.match(f.sent[0]!.text, /before\/verify-startup.*退出码 7.*插件未加载/)
    assert.deepEqual(f.appCalls, [])
  } finally { await f.close() }
})

test('--before 被信号停止：保留 signal，不重启不重放', async () => {
  const f = await fixture(() => [])
  try {
    assert.equal(await f.cli(['restart', '--notify', 'aaaa1111', '--before', 'kill -TERM $$']), 1)
    const state = JSON.parse(readFileSync(join(f.dir, 'dsh-control/restart-state.json'), 'utf8'))
    assert.equal(state.failure.signal, 'SIGTERM')
    assert.equal(state.failure.exitCode, null)
    assert.match(f.sent[0]!.text, /SIGTERM/)
    assert.deepEqual(f.appCalls, [])
  } finally { await f.close() }
})

test('通知只记录或宿主未调度时不写已唤醒，也不重复发送；旧成功回执可经公开状态确认', async () => {
  for (const options of [{ noticeReceiptOnly: true }, { noticeWakeupUnconfirmed: true }, { noticeReceiptOnly: true, statusRunning: true }]) {
    const f = await fixture(() => [], options)
    try {
      assert.equal(await f.cli(['restart', '--notify', 'aaaa1111']), 0)
      assert.equal(f.sent.length, 1)
      const state = JSON.parse(readFileSync(join(f.dir, 'dsh-control/restart-state.json'), 'utf8'))
      assert.equal(state.phase, 'completed')
      assert.equal(state.notification, options.statusRunning ? 'scheduled' : 'recorded-unconfirmed')
    } finally { await f.close() }
  }
})

test('旧执行者跨升级完成保留真实终态，旧 delivered 不证明已调度；新记录严格校验证据', async () => {
  const f = await fixture(() => [])
  try {
    writeFileSync(join(f.dir, 'dsh-control/restart-state.json'), JSON.stringify({ phase: 'completed', notification: 'delivered', exitCode: 0, message: '旧记录' }))
    assert.equal(await f.cli(['restart-status', '--json']), 0)
    const state = JSON.parse(f.out()).data
    assert.equal(state.phase, 'completed')
    assert.equal(state.readinessConfirmed, false)
    assert.equal(state.completionEvidence, 'legacy-unverified')
    assert.equal(state.recordedNotification, 'delivered')
    assert.equal(state.notification, 'recorded-unconfirmed')
    assert.equal(state.message, '旧记录')
    assert.deepEqual(f.sent, [])
    writeFileSync(join(f.dir, 'dsh-control/restart-state.json'), JSON.stringify({ schemaVersion: 2, phase: 'completed', exitCode: 0 }))
    assert.equal(await f.cli(['restart-status', '--json']), 1)
    assert.match(f.out(), /新版完成记录没有有效的实例与会话服务验收证据/)
  } finally { await f.close() }
})

test('失败记录不沿用排队时的旧阻碍', async () => {
  const f = await fixture((call) => call < 2 ? ['session-busy'] : [], { quitFails: true, stuckKill: true })
  try {
    assert.equal(await f.cli(['restart']), 1)
    const state = JSON.parse(readFileSync(join(f.dir, 'dsh-control/restart-state.json'), 'utf8'))
    assert.equal(state.phase, 'failed')
    assert.equal(state.blockers, undefined)
  } finally { await f.close() }
})

test('restart：被中止时用户的话还没回应完，「继续」通知带上原话、让它先回应，不再说「不用向用户解释」', async () => {
  const f = await fixture(() => ['session-bbbb2222', 'session-cccc3333'], { lost: { 'session-bbbb2222': { interruptedUser: { text: '你是不是不会在目标达成的时候主动停止目标？', at: 1 } } } })
  try {
    assert.equal(await f.cli(['restart']), 0, f.err())
    const asked = f.sent.filter((s) => s.session === 'session-bbbb2222')
    assert.equal(asked.length, 1)
    assert.equal(asked[0]!.summary, 'Previous turn interrupted; the user message was not answered; answer it first')
    assert.match(asked[0]!.text, /"你是不是不会在目标达成的时候主动停止目标？"/)
    assert.match(asked[0]!.text, /Answer it first/)
    assert.doesNotMatch(asked[0]!.text, /Do not explain this interruption/)
    const plain = f.sent.filter((s) => s.session === 'session-cccc3333')
    assert.equal(plain[0]!.summary, 'Previous turn interrupted by the system (not the user); continue', '没有待回应的话照旧')
  } finally { await f.close() }
})

test('强制重启：等待途中才看到在跑的子代理，停下后也要告诉派它的会话（evolve I-054，11-04 01:00 重启）', async () => {
  const f = await fixture(() => [], {
    parents: { 'session-sub00002': 'session-cccc3333' },
    quitExtra: (n) => (n === 1 ? { running: ['session-sub00002'] } : {}),
  })
  try {
    const code = await f.cli(['restart'])
    assert.equal(code, 0, f.err())
    assert.ok(f.cancelled.includes('session-sub00002'), '子代理要用上级身份中止')
    const told = f.sent.find((s) => s.session === 'session-cccc3333')
    assert.ok(told !== undefined, '派子代理的会话要收到说明')
    assert.match(told.text, /Your subagent\(s\) sub00002 were interrupted during the restart/)
  } finally { await f.close() }
})

test('强制重启停掉子代理名下的后台任务：说明送给它的上级，不发给宿主不收的子代理（evolve I-054）', async () => {
  const f = await fixture(() => [], {
    jobs: ['bash-7'],
    wakeOnKill: true,
    parents: { 'bash-7': 'session-sub00003', 'session-sub00003': 'session-eeee5555' },
    sendFails: (session) => session === 'session-sub00003',
  })
  try {
    const code = await f.cli(['restart'])
    assert.equal(code, 0, f.err())
    assert.deepEqual(f.killedJobs, ['bash-7'])
    assert.equal(f.sent.some((s) => s.session === 'session-sub00003'), false)
    const told = f.sent.find((s) => s.session === 'session-eeee5555')
    assert.ok(told !== undefined, '子代理的上级要收到说明')
    assert.equal(told.quiet, true, '子代理闲着只留了任务，上级不用被唤醒')
    assert.match(told.text, /bash-7 \(owned by subagent sub00003\)/)
    assert.doesNotMatch(told.text, /Your subagent/, '只因任务被停才被叫醒的子代理不算被打断')
  } finally { await f.close() }
})

/** 只有 Info.plist 的假 App，够 plutil 读版本、够重启流程搬动。 */
function fakeApp(path: string, version: string): string {
  mkdirSync(join(path, 'Contents'), { recursive: true })
  writeFileSync(join(path, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>\n`)
  return path
}

test('restart --install-app：旧 App 退出后才换，拉起的是新版；旧版留备份，upgrade --rollback 能换回', async () => {
  let atOpen: string[] = []
  const f = await fixture(() => [], { onOpen: () => { atOpen.push(appVersion(join(f.dir, 'Apps/DeepSeek Harness.app'))) } })
  try {
    const target = fakeApp(join(f.dir, 'Apps/DeepSeek Harness.app'), '0.2.1-rc.5')
    const staged = fakeApp(join(f.dir, 'stage/DeepSeek Harness.app'), '0.2.2-rc.1')
    const extra = { DSH_APP: target, DSH_CONTROL_UPGRADE_DIR: join(f.dir, 'upgrade') }
    assert.equal(await f.cli(['restart', '--install-app', staged], extra), 0, f.err())
    assert.deepEqual(f.appCalls, ['quit', 'open'])
    assert.deepEqual(atOpen, ['0.2.2-rc.1'], '拉起时已经是新版')
    assert.equal(appVersion(target), '0.2.2-rc.1')
    assert.equal(existsSync(staged), false)
    const backup = join(f.dir, 'upgrade/backups/DeepSeek Harness 0.2.1-rc.5.app')
    assert.equal(appVersion(backup), '0.2.1-rc.5')
    atOpen = []
    assert.equal(await f.cli(['upgrade', '--rollback'], extra), 0, f.err())
    assert.match(f.out(), /换回 0\.2\.1-rc\.5/)
    assert.deepEqual(atOpen, ['0.2.1-rc.5'])
    assert.equal(appVersion(target), '0.2.1-rc.5')
    assert.deepEqual(readdirSync(join(f.dir, 'upgrade/backups')), ['DeepSeek Harness 0.2.2-rc.1.app'], '只留刚换下来的那一份')
  } finally { await f.close() }
})

test('restart --install-app：新版拉不起来就结束它、换回旧版再拉起，并按失败报告', async () => {
  const f = await fixture(() => [], { openFails: 1 })
  try {
    const target = fakeApp(join(f.dir, 'Apps/DeepSeek Harness.app'), '0.2.1-rc.5')
    const staged = fakeApp(join(f.dir, 'stage/DeepSeek Harness.app'), '0.2.2-rc.1')
    assert.equal(await f.cli(['restart', '--install-app', staged], { DSH_APP: target, DSH_CONTROL_UPGRADE_DIR: join(f.dir, 'upgrade') }), 1)
    assert.match(f.err(), /新版 0\.2\.2-rc\.1 没起来.*已换回 0\.2\.1-rc\.5/)
    assert.equal(appVersion(target), '0.2.1-rc.5')
    assert.equal(appVersion(join(f.dir, 'upgrade/failed/DeepSeek Harness 0.2.2-rc.1.app')), '0.2.2-rc.1')
    assert.deepEqual(f.appCalls.filter((c) => c === 'open').length, 2)
    const state = JSON.parse(readFileSync(join(f.dir, 'dsh-control/restart-state.json'), 'utf8'))
    assert.equal(state.phase, 'failed')
  } finally { await f.close() }
})

test('upgrade：安装包 sha512 和更新源对不上就删包、不退出 DSH；--install-app 路径不对直接拒绝', async () => {
  const f = await fixture(() => [])
  try {
    const target = fakeApp(join(f.dir, 'Apps/DeepSeek Harness.app'), '0.2.1-rc.5')
    mkdirSync(join(f.dir, 'feed'))
    writeFileSync(join(f.dir, 'feed/app.zip'), 'not the real package')
    writeFileSync(join(f.dir, 'feed/latest.yml'), `version: 0.2.2-rc.1\nfiles:\n  - url: >-\n      app.zip\n    sha512: >-\n      ${Buffer.from('x'.repeat(64)).toString('base64')}\n    size: 20\npath: app.zip\nsha512: abc=\n`)
    const extra = { DSH_APP: target, DSH_CONTROL_UPGRADE_DIR: join(f.dir, 'upgrade') }
    assert.equal(await f.cli(['upgrade', '--feed', `file://${join(f.dir, 'feed/latest.yml')}`], extra), 1)
    assert.match(f.err(), /sha512 与更新源不符/)
    assert.equal(existsSync(join(f.dir, 'upgrade/0.2.2-rc.1/app.zip')), false)
    assert.deepEqual(f.appCalls, [])
    assert.equal(appVersion(target), '0.2.1-rc.5')
    assert.equal(await f.cli(['restart', '--install-app', 'relative.app'], extra), 2)
    assert.deepEqual(f.appCalls, [])
  } finally { await f.close() }
})

test('parseFeed：读 electron-builder 清单的折叠写法，相对地址按清单网址补全', () => {
  const feed = "version: 0.2.2-rc.1\nfiles:\n  - url: >-\n      https://download.example.com/bin/app-0.2.2-rc.1.zip\n    sha512: >-\n      mHn+lwXZ==\n    size: 353501474\npath: >-\n  https://download.example.com/bin/app-0.2.2-rc.1.zip\nsha512: >-\n  mHn+lwXZ==\nreleaseDate: '2026-11-04T09:24:35.800Z'\nstagingPercentage: 10\n"
  assert.deepEqual(parseFeed(feed, 'https://download.example.com/feeds/nightly-mac.yml'), { version: '0.2.2-rc.1', url: 'https://download.example.com/bin/app-0.2.2-rc.1.zip', sha512: 'mHn+lwXZ==', size: 353501474, releaseDate: '2026-11-04T09:24:35.800Z' })
  assert.equal(parseFeed('version: 1.0.0\npath: app.zip\nsha512: abc=\n', 'https://x.example/feeds/a.yml').url, 'https://x.example/feeds/app.zip')
  assert.throws(() => parseFeed('version: 1.0.0\n', 'https://x.example/a.yml'), /缺少/)
})
