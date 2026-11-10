import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { invokeCli } from './cli-fixture.ts'
import { startServer } from '../src/server.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appLaunchEnv, fromSsh, launchEnv, layeredDoctor, offlineDoctor, parseLaunchdEnvironment, reportText } from '../src/cli/doctor.ts'

const good = { ok: true, checks: [{ id: 'fixture', ok: true, message: '正常' }] }
const bad = { ok: false, checks: [{ id: 'fixture', ok: false, message: '坏 profile', fix: '修复 profile' }] }

test('两层都必须通过；离线不要求在线', async () => {
  let calls = 0
  assert.equal((await layeredDoctor(good, false, async () => { calls++; return bad })).ok, true)
  assert.equal(calls, 0)
  assert.equal((await layeredDoctor(bad, false, async () => good)).ok, false)
  assert.equal((await layeredDoctor(good, true, async () => bad)).ok, false)
  assert.equal((await layeredDoctor(bad, true, async () => good)).ok, false)
  assert.equal((await layeredDoctor(good, true, async () => good)).ok, true)
  assert.equal((await layeredDoctor(good, true, async () => { throw new Error('socket 断开') })).ok, false)
})

test('启动环境移除 ELECTRON_RUN_AS_NODE 和内核专属变量，不修改父进程', () => {
  const old = process.env['ELECTRON_RUN_AS_NODE']
  const oldOwner = process.env['PRIME_AGENT_KERNEL_OWNER_PID']
  process.env['ELECTRON_RUN_AS_NODE'] = '1'
  process.env['PRIME_AGENT_KERNEL_OWNER_PID'] = '19361'
  try {
    const env = launchEnv()
    assert.equal(env['ELECTRON_RUN_AS_NODE'], undefined)
    assert.equal(env['PRIME_AGENT_KERNEL_OWNER_PID'], undefined)
    assert.equal(process.env['ELECTRON_RUN_AS_NODE'], '1')
    assert.equal(process.env['PRIME_AGENT_KERNEL_OWNER_PID'], '19361')
  }
  finally {
    if (old === undefined) delete process.env['ELECTRON_RUN_AS_NODE']; else process.env['ELECTRON_RUN_AS_NODE'] = old
    if (oldOwner === undefined) delete process.env['PRIME_AGENT_KERNEL_OWNER_PID']; else process.env['PRIME_AGENT_KERNEL_OWNER_PID'] = oldOwner
  }
})

const GUI = 'gui/501 = {\n\ttype = login\n\tenvironment = {\n\t\tPATH => /opt/homebrew/bin:/usr/bin\n\t\tHTTPS_PROXY => http://127.0.0.1:7890\n\t\tSSH_AUTH_SOCK => /var/run/launchd/Listeners\n\t}\n\tsubmanager = {\n\t\tFOO => bar\n\t}\n}\n'

test('读图形会话环境只取 environment 段', () => {
  assert.deepEqual(parseLaunchdEnvironment(GUI), { PATH: '/opt/homebrew/bin:/usr/bin', HTTPS_PROXY: 'http://127.0.0.1:7890', SSH_AUTH_SOCK: '/var/run/launchd/Listeners' })
  assert.deepEqual(parseLaunchdEnvironment('gui/501 = {\n}\n'), {})
})

test('不在远程登录里：照当前环境打开，不去读图形会话', () => {
  const env = appLaunchEnv({ PATH: '/x', ELECTRON_RUN_AS_NODE: '1', PRIME_AGENT_KERNEL_OWNER_PID: '19361', HOME: '/h' }, () => { throw new Error('不该读') })
  assert.deepEqual(env, { PATH: '/x', HOME: '/h' })
})

test('在远程登录里：换成图形会话环境，不带任何 SSH 变量', () => {
  for (const ssh of [{ SSH_CONNECTION: '1.2.3.4 5 6.7.8.9 22' }, { SSH_TTY: '/dev/ttys001' }]) {
    const env = appLaunchEnv({ ...ssh, SSH_CLIENT: 'c', PATH: '/ssh/path', HOME: '/tmp/example-user', USER: 'm', LOGNAME: 'm', TMPDIR: '/t/', ELECTRON_RUN_AS_NODE: '1', PRIME_AGENT_KERNEL_OWNER_PID: '19361', FOO: 'ssh-only' }, () => GUI)
    assert.equal(fromSsh(env), false)
    assert.equal(env['PATH'], '/opt/homebrew/bin:/usr/bin')
    assert.equal(env['HTTPS_PROXY'], 'http://127.0.0.1:7890')
    assert.equal(env['HOME'], '/tmp/example-user')
    assert.equal(env['TMPDIR'], '/t/')
    assert.equal(env['SSH_CLIENT'], undefined)
    assert.equal(env['FOO'], undefined)
    assert.equal(env['ELECTRON_RUN_AS_NODE'], undefined)
    assert.equal(env['PRIME_AGENT_KERNEL_OWNER_PID'], undefined)
    assert.equal(env['SSH_AUTH_SOCK'], '/var/run/launchd/Listeners')
  }
})

test('在远程登录里读不到图形会话就拒绝打开，不退回 SSH 环境', () => {
  assert.throws(() => appLaunchEnv({ SSH_CONNECTION: 'x', PATH: '/p' }, () => 'gui/501 = {\n}\n'), /图形会话/)
  assert.throws(() => appLaunchEnv({ SSH_TTY: '/dev/ttys001' }, () => { throw new Error('launchctl 失败') }), /launchctl 失败/)
})

test('离线 CLI 使用独立进程并传修复权限开关，非零退出不能放行', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-control-doctor-test-'))
  const entry = join(dir, 'doctor.mjs')
  try {
    writeFileSync(entry, `console.log(JSON.stringify({ok:process.argv.includes('--repair-credentials'),checks:[{id:'credentials',ok:process.argv.includes('--repair-credentials'),message:'test'}]}));process.exit(process.argv.includes('--repair-credentials')?0:1)`)
    assert.equal((await offlineDoctor({ home: dir, app: dir, entry })).ok, false)
    assert.equal((await offlineDoctor({ home: dir, app: dir, entry, repairCredentials: true })).ok, true)
    writeFileSync(entry, `console.log(JSON.stringify({ok:true,checks:[]}));process.exit(1)`)
    assert.equal((await offlineDoctor({ home: dir, app: dir, entry })).ok, false)
    writeFileSync(entry, `console.log(JSON.stringify({ok:true,checks:[{id:'broken',ok:false,message:'不通过'}]}))`)
    assert.equal((await offlineDoctor({ home: dir, app: dir, entry })).ok, false)
    writeFileSync(entry, `console.log('not JSON')`)
    assert.equal((await offlineDoctor({ home: dir, app: dir, entry })).ok, false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('命令行核心：离线/在线必须全过；工具未加载和启动前失败返回非零', async () => {
  const dir = mkdtempSync('/tmp/dshdoc-')
  const bin = join(dir, 'profiles/desktop/node_modules/tooling')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(dir,'profiles/desktop/node_modules/dsh-control'), {recursive:true})
  const entry = join(bin, 'doctor-cli.mjs')
  const socketPath = join(dir, 'dsh-control/dsh.sock')
  let onlineCalls = 0
  let liveOk = true
  const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: dir, DSH_APP: join(dir, 'absent.app'), DSH_CONTROL_SOCKET: socketPath }
  // 这里验证用户终端的启动保护，来源不应取决于是谁运行测试。
  delete env['DSH_SESSION_ID']
  delete env['DSH_SHELL']
  const cli = (args: string[]) => invokeCli(args, env)
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    writeFileSync(entry, `console.log(JSON.stringify(${JSON.stringify(good)}))`)
    const offline = await cli(['doctor', '--json'])
    assert.equal(offline.code, 0, offline.err)
    assert.equal(JSON.parse(offline.out).running, false)
    server = await startServer({ socketPath, commands: () => [], info: () => ({}), log: () => {}, run: async (command, args) => {
      if (command === 'health') return { text: '有会话在跑', data: { running: ['busy-session'] } }
      assert.equal(command, 'api')
      assert.equal(args[1], 'doctor/getReport')
      assert.equal(JSON.parse(args[2]!).options.full, false)
      onlineCalls++
      if (!liveOk) throw new Error('doctor 未加载')
      return { text: 'checked', data: good }
    } })
    const online = await cli(['doctor', '--full', '--json'])
    assert.equal(online.code, 0, online.err)
    assert.equal(JSON.parse(online.out).online.ok, true)
    assert.equal(onlineCalls, 1)
    const large = { ...good, checks: [{ id: 'large-diagnostic', ok: true, message: '完整日志'.repeat(100000) }] }
    writeFileSync(entry, `console.log(JSON.stringify(${JSON.stringify(large)}))`)
    const largeReport = await cli(['doctor', '--json'])
    assert.equal(largeReport.code, 0, largeReport.err)
    const largeMessage = JSON.parse(largeReport.out).offline.checks[0].message as string
    assert.equal(largeMessage.length, large.checks[0]!.message.length)
    assert.equal(largeMessage === large.checks[0]!.message, true)
    writeFileSync(entry, `console.log(JSON.stringify(${JSON.stringify(good)}))`)
    const ensured = await cli(['start'])
    assert.equal(ensured.code, 0, ensured.err)
    assert.match(ensured.out, /DSH 已经在运行/)
    assert.doesNotMatch(ensured.out, /正在启动/)
    const forcedRestart = await cli(['restart'])
    assert.equal(forcedRestart.code, 0, forcedRestart.err)
    liveOk = false
    const missing = await cli(['doctor', '--json'])
    assert.notEqual(missing.code, 0)
    assert.equal(JSON.parse(missing.out).offline.ok, true)
    assert.equal(JSON.parse(missing.out).online.ok, false)
    await server.close(); server = undefined
    writeFileSync(entry, `console.log(JSON.stringify(${JSON.stringify(bad)}));process.exit(1)`)
    for (const command of ['doctor', 'start', 'restart']) {
      const refused = await cli([command])
      assert.notEqual(refused.code, 0)
      assert.match(refused.out, /坏 profile/)
      assert.match(refused.out, /修复 profile/)
    }
  } finally { await server?.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('输出逐条带错误和修复办法', () => {
  assert.match(reportText('离线', bad), /失败.*坏 profile/)
  assert.match(reportText('离线', bad), /修复：修复 profile/)
  assert.match(reportText('离线', { ...good, unverified: ['远程政策'] }), /未验证：远程政策/)
})
