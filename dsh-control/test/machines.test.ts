import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkLayout, MachinePage, machineRoutes, parseForward, parseListening, parseMachineState, reservedPorts, type Layout, type MachineDeps, type RunResult } from '../src/machines.ts'

const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: '' })

const LAYOUT: Layout = {
  machines: [
    { id: 'alpha', label: 'Alpha', hostname: 'ALPHA-HOST', slot: 0 },
    { id: 'beta', label: 'beta', hostname: 'BETA-HOST', slot: 1 },
    { id: 'gamma', label: 'gamma', hostname: 'GAMMA-HOST', slot: 2, secondary: true },
  ],
  services: [
    {
      id: 'dsh', label: 'DSH', port: 3080, check: ['dsh-control', 'health'], open: ['dsh-control', 'web-url', '--base', '{base}'],
      actions: [{ label: '立即重启', run: ['dsh-control', 'restart', '--detach'], confirm: true }],
    },
    { id: 'example', label: 'Example', port: 9119, on: ['alpha'], actions: [{ label: "重启 it's", run: ['example-service', 'restart'] }] },
  ],
}

function page(over: Partial<MachineDeps> = {}, calls: string[][] = [], layout: Layout = LAYOUT): MachinePage {
  const deps: MachineDeps = {
    localHostName: () => 'BETA-HOST',
    run: async (file, args) => { calls.push([file, ...args]); return ok('') },
    portOpen: async () => false,
    startTunnel: async () => ok(''),
    listeners: async () => [],
    sshListeners: async () => [],
    kill: () => {},
    open: async () => {},
    ...over,
  }
  return new MachinePage(deps, () => layout)
}

/** 交给 ssh 的最后一个参数：对面 fish 要跑的那一行。 */
const remoteLine = (call: string[]) => call.at(-1)

test('列表：本机按电脑名认出来不列；本机端口 = 服务端口 + 10000 + 机器编号；服务按 on 只出现在对应机器', () => {
  assert.deepEqual(page().list(), {
    self: 'beta',
    machines: [
      { id: 'alpha', label: 'Alpha', secondary: false, services: [
        { id: 'dsh', label: 'DSH', localPort: 13080, actions: [{ label: '立即重启', confirm: true }] },
        { id: 'example', label: 'Example', localPort: 19119, actions: [{ label: "重启 it's", confirm: false }] },
      ] },
      { id: 'gamma', label: 'gamma', secondary: true, services: [{ id: 'dsh', label: 'DSH', localPort: 13082, actions: [{ label: '立即重启', confirm: true }] }] },
    ],
  })
  assert.deepEqual(page({ localHostName: () => LAYOUT.machines[0]!.hostname.toLowerCase() }).list().machines.map((m) => m.id), ['beta', 'gamma'])
  assert.equal(page({ localHostName: () => 'other-host' }).list().self, undefined)
})

test('地址栏端口是本机某个服务的隧道端口，就是别的机器经隧道打开的', () => {
  // 本机 beta（编号 1）：别人打开它的 DSH 用 13081；自己打开用 3080，开 Alpha 的隧道是 13080，都不算
  assert.equal(page().list({ viewPort: 13081 }).viewedRemotely, true)
  assert.equal(page().list({ viewPort: 3080 }).viewedRemotely, undefined)
  assert.equal(page().list({ viewPort: 13080 }).viewedRemotely, undefined)
  assert.equal(page().list({}).viewedRemotely, undefined)
  assert.equal(page({ localHostName: () => 'other-host' }).list({ viewPort: 13081 }).viewedRemotely, undefined)
})

test('清单写错直接报错：编号重复、on 写了不存在的机器、本机端口撞上', () => {
  const dup = { ...LAYOUT, machines: [...LAYOUT.machines, { id: 'x', label: 'x', hostname: 'x', slot: 1 }] }
  assert.throws(() => checkLayout(dup), /机器编号 1 用了两次/)
  assert.throws(() => checkLayout({ ...LAYOUT, services: [{ id: 'a', label: 'A', port: 80, on: ['other-host'] }] }), /不存在的机器 other-host/)
  assert.throws(() => checkLayout({ ...LAYOUT, services: [...LAYOUT.services, { id: 'w', label: 'W', port: 3081 }] }), /本机端口 13081/)
  assert.throws(() => page({}, [], { ...LAYOUT, services: [{ id: 'a', label: 'A', port: 9119 }, { id: 'a', label: 'B', port: 1 }] }).list(), /服务 a 写了两次/)
})

test('不认识的机器、本机、这台上没有的服务都拒绝', async () => {
  await assert.rejects(page().status({ id: 'beta' }), /不认识的机器/)
  await assert.rejects(page().status({ id: 'other-host' }), /不认识的机器/)
  await assert.rejects(page().open({ id: 'gamma', service: 'example' }), /gamma 上没有服务：example/)
})

test('检查：连不上不再问服务；连得上时有 check 就跑它，没有就看对面端口', async () => {
  const calls: string[][] = []
  const down = page({ run: async (file, args) => { calls.push([file, ...args]); return args[0] === '-G' ? ok('proxycommand nc\n') : { code: 255, stdout: '', stderr: 'ssh: connect to host x: Operation timed out\n' } } }, calls)
  assert.deepEqual(await down.status({ id: 'alpha' }), {
    id: 'alpha', reachable: false, state: 'offline', relayed: true, reason: 'ssh: connect to host x: Operation timed out',
    services: [{ id: 'dsh', tunnel: false, running: false, line: '' }, { id: 'example', tunnel: false, running: false, line: '' }],
  })
  assert.equal(calls.length, 2)

  const seen: string[][] = []
  const up = page({
    portOpen: async (port) => port === 19119,
    run: async (file, args) => {
      seen.push([file, ...args])
      const line = args.at(-1) ?? ''
      if (line.includes('health')) return ok('DSH 在线。会话 11 个\n在跑：\n')
      if (line.includes('CGSSessionScreenIsLocked')) return ok('console=sample-user\n"CGSSessionScreenIsLocked" = Yes\n"HIDIdleTime" = 374753340500\n')
      if (line.includes('/usr/bin/nc')) return { code: 1, stdout: '', stderr: '' }
      return ok('')
    },
  })
  const upStatus = await up.status({ id: 'alpha' })
  assert.deepEqual(upStatus.services, [
    { id: 'dsh', tunnel: false, running: true, line: 'DSH 在线。会话 11 个' },
    { id: 'example', tunnel: true, running: false, line: '端口 9119 没有服务在听' },
  ])
  assert.equal(upStatus.state, 'locked')
  assert.equal(upStatus.idleSeconds, 375)
  assert.ok(seen.some((c) => remoteLine(c) === "'dsh-control' 'health'"))
  assert.ok(seen.some((c) => remoteLine(c) === "'/usr/bin/nc' '-z' '-G' '2' '127.0.0.1' '9119'"))

  const dead = page({ run: async (_file, args) => (args.at(-1) ?? '').includes('health') ? { code: 1, stdout: '', stderr: '找不到通信口\n' } : ok('') })
  assert.deepEqual((await dead.status({ id: 'alpha' })).services[0], { id: 'dsh', tunnel: false, running: false, line: '找不到通信口' })
})

test('状态：活动、锁屏和空闲时间读得出来；空输出不乱猜', () => {
  assert.deepEqual(parseMachineState('console=sample-user\n"CGSSessionScreenIsLocked" = No\n"HIDIdleTime" = 120000000000\n'), { state: 'active', idleSeconds: 120 })
  assert.deepEqual(parseMachineState('console=sample-user\n"CGSSessionScreenIsLocked" = Yes\n"HIDIdleTime" = 374753340500\n'), { state: 'locked', idleSeconds: 375 })
  assert.deepEqual(parseMachineState('console=root\n'), { state: 'locked' })
  assert.deepEqual(parseMachineState(''), { state: 'online' })
  assert.deepEqual(parseMachineState('platform=Linux\n'), { state: 'online' })
})

test('检查：SSH 被拒绝说明机器有应答，只报在线不报睡眠离线', async () => {
  const p = page({ run: async (_file, args) => args[0] === '-G' ? ok('') : { code: 255, stdout: '', stderr: 'ssh: connect to host x port 22: Connection refused\n' } })
  const status = await p.status({ id: 'alpha' })
  assert.equal(status.reachable, false)
  assert.equal(status.state, 'online')
})

test('检查：连过一次后完全没响应，带上上次在线时间', async () => {
  let up = true
  const p = page({
    run: async (_file, args) => {
      if (args[0] === '-G') return ok('')
      if (up && (args.at(-1) ?? '').includes('CGSSessionScreenIsLocked')) return ok('console=sample-user\n"CGSSessionScreenIsLocked" = Yes\n')
      if (!up) return { code: 255, stdout: '', stderr: 'ssh: connect to host x: Operation timed out\n' }
      return ok('')
    },
  })
  const first = await p.status({ id: 'gamma' })
  assert.equal(first.state, 'locked')
  up = false
  const second = await p.status({ id: 'gamma' })
  assert.equal(second.reachable, false)
  assert.equal(second.state, 'offline')
  assert.equal(second.lastSeen?.state, 'locked')
  assert.ok((second.lastSeen?.at ?? 0) > 0)
})

test('打开：先拉隧道，再在对面跑 open 命令，只取以这条隧道地址开头的网址，网址不回给页面', async () => {
  const calls: string[][] = []
  const opened: string[] = []
  let up = false
  const p = page({
    portOpen: async () => up,
    startTunnel: async (machine, local, remote) => { calls.push(['tunnel', machine, String(local), String(remote)]); up = true; return ok('') },
    run: async (file, args) => { calls.push([file, ...args]); return ok('http://127.0.0.1:13082/?token=secret\n别外传\n') },
    open: async (url) => { opened.push(url) },
  }, calls)
  const result = await p.open({ id: 'gamma', service: 'dsh' })
  assert.deepEqual(result, { opened: true, localPort: 13082 })
  assert.equal(JSON.stringify(result).includes('secret'), false)
  assert.deepEqual(calls[0], ['tunnel', 'gamma', '13082', '3080'])
  assert.equal(remoteLine(calls[1]!), "'dsh-control' 'web-url' '--base' 'http://127.0.0.1:13082'")
  assert.deepEqual(opened, ['http://127.0.0.1:13082/?token=secret'])

  // 13080 不能当成 1308 的前缀，别的端口的网址一律拒绝
  const wrong = page({ portOpen: async () => true, run: async () => ok('http://127.0.0.1:130820/?token=x\n') })
  await assert.rejects(wrong.open({ id: 'alpha', service: 'dsh' }), /不是这条隧道的网址/)
  const failed = page({ portOpen: async () => true, run: async () => ({ code: 2, stdout: '', stderr: '没有命令 "web-url"\n' }) })
  await assert.rejects(failed.open({ id: 'alpha', service: 'dsh' }), /没取到 DSH 的网址：没有命令 "web-url"/)

  // 没写 open 的服务直接打开隧道地址
  const plainOpened: string[] = []
  await page({ portOpen: async () => true, open: async (url) => { plainOpened.push(url) } }).open({ id: 'alpha', service: 'example' })
  assert.deepEqual(plainOpened, ['http://127.0.0.1:19119'])
})

test('拉隧道：端口已开不重复起；起不来报 ssh 的原因', async () => {
  let started = 0
  assert.equal((await page({ portOpen: async () => true, startTunnel: async () => { started += 1; return ok('') } }).tunnel({ id: 'alpha', service: 'dsh' })).already, true)
  assert.equal(started, 0)
  await assert.rejects(
    page({ startTunnel: async () => ({ code: 255, stdout: '', stderr: 'bind [127.0.0.1]:13080: Address already in use\n' }) }).tunnel({ id: 'alpha', service: 'dsh' }),
    /隧道没起来：bind \[127\.0\.0\.1\]:13080: Address already in use/,
  )
})

test('关隧道：只停在本机端口上监听的 ssh；别的程序占着就不动', async () => {
  const killed: number[] = []
  let open = true
  const p = page({ listeners: async () => [{ pid: 42, command: 'ssh' }], kill: (pid) => { killed.push(pid); open = false }, portOpen: async () => open })
  assert.deepEqual(await p.close({ id: 'alpha', service: 'example' }), { closed: true, localPort: 19119 })
  assert.deepEqual(killed, [42])
  assert.deepEqual(await page().close({ id: 'alpha', service: 'dsh' }), { closed: false, localPort: 13080 })
  const stranger = page({ listeners: async () => [{ pid: 7, command: 'node' }], kill: () => { throw new Error('不该停') } })
  await assert.rejects(stranger.close({ id: 'alpha', service: 'dsh' }), /被别的程序占着（node）/)
})

test('按钮：按序号跑清单里的命令，单引号转义给 fish；失败带上报错', async () => {
  const calls: string[][] = []
  const p = page({ run: async (file, args) => { calls.push([file, ...args]); return ok('已排队\n日志：x\n') } }, calls)
  assert.deepEqual(await p.action({ id: 'alpha', service: 'dsh', action: 0 }), { ok: true, line: '已排队' })
  assert.deepEqual(calls[0]!.slice(0, 6), ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', 'alpha'])
  assert.equal(remoteLine(calls[0]!), "'dsh-control' 'restart' '--detach'")
  await assert.rejects(p.action({ id: 'alpha', service: 'dsh', action: 5 }), /没有这个按钮/)
  await assert.rejects(p.action({ id: 'alpha', service: 'dsh', action: '0' }), /没有这个按钮/)

  const quoted: string[][] = []
  const layout: Layout = { ...LAYOUT, services: [{ id: 'x', label: 'X', port: 1000, actions: [{ label: 'q', run: ['echo', "it's", 'a\\b'] }] }] }
  await page({ run: async (file, args) => { quoted.push([file, ...args]); return ok('') } }, [], layout).action({ id: 'alpha', service: 'x', action: 0 })
  assert.equal(remoteLine(quoted[0]!), `'echo' 'it'"'"'s' 'a\\b'`)

  const bad = page({ run: async () => ({ code: 2, stdout: '', stderr: '拒绝：有会话在跑\n' }) })
  await assert.rejects(bad.action({ id: 'alpha', service: 'dsh', action: 0 }), /立即重启没成：拒绝：有会话在跑/)
})

test('路由：信封错了回失败，业务错误带插件前缀', async () => {
  const route = machineRoutes(page()).find((r) => r.path === '/api/dsh-control.status')!
  const send = (body: unknown) => route.fetch(new Request('http://x/api/dsh-control.status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  const bad = await (await send({ type: 'client-request', rpcId: '1', method: 'status', payload: { id: 'nope' } })).json() as { result: { ok: boolean; error: { code: string } } }
  assert.equal(bad.result.ok, false)
  assert.equal(bad.result.error.code, 'dsh-control/invalid-request')
  const listRoute = machineRoutes(page()).find((r) => r.path === '/api/dsh-control.list')!
  const res = await listRoute.fetch(new Request('http://x/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: '2', method: 'list' }) }))
  assert.deepEqual(((await res.json()) as { rpcId: string }).rpcId, '2')
  assert.deepEqual(machineRoutes(page()).map((r) => r.path.split('.').at(-1)), ['list', 'status', 'tunnel', 'open', 'close', 'action', 'temps', 'scan', 'tempOpen', 'tempBrowse', 'tempClose'])
})

/** 本插件拉隧道时 ssh 的启动参数。 */
const sshArgs = (local: number, remote: number, machine: string) =>
  `ssh -f -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o ControlMaster=no -o ControlPath=none -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -L 127.0.0.1:${String(local)}:127.0.0.1:${String(remote)} ${machine}`

test('扫描结果：只留经 127.0.0.1 连得到的监听，按端口合并进程名', () => {
  const text = ['p1', 'cpython3.15', 'f3', 'n127.0.0.1:8766', 'p2', 'cnode', 'f20', 'n*:3080', 'f21', 'n[::1]:3080', 'p3', 'cGoogle Chrome He', 'f9', 'n[::1]:9222', 'p4', 'cnginx', 'f5', 'n203.0.113.3:80', 'p5', 'cnode', 'f6', 'n*:3080', ''].join('\n')
  assert.deepEqual(parseListening(text), [{ port: 3080, processes: ['node'] }, { port: 8766, processes: ['python3.15'] }])
})

test('认隧道：只认本插件的形状，机器是最后一个参数', () => {
  assert.deepEqual(parseForward(sshArgs(18766, 8766, 'alpha')), { localPort: 18766, remotePort: 8766, machine: 'alpha' })
  assert.deepEqual(parseForward(`/usr/bin/${sshArgs(18767, 8766, 'beta')}`), { localPort: 18767, remotePort: 8766, machine: 'beta' })
  assert.equal(parseForward('ssh -L 8080:example.com:80 alpha'), undefined)
  assert.equal(parseForward('ssh -L 127.0.0.1:1:127.0.0.1:2 -L 127.0.0.1:3:127.0.0.1:4 alpha'), undefined)
  assert.equal(parseForward('ssh -N -L 127.0.0.1:1:127.0.0.1:2'), undefined)
  assert.equal(parseForward('sshd: zhou@ttys001'), undefined)
})

test('临时隧道：从本机 ssh 监听反推；清单服务的隧道、对不上端口的、不认识的机器、本机都不算', async () => {
  const p = page({
    sshListeners: async () => [
      { pid: 1, port: 13080, args: sshArgs(13080, 3080, 'alpha') },
      { pid: 2, port: 18766, args: sshArgs(18766, 8766, 'alpha') },
      { pid: 3, port: 15000, args: sshArgs(15000, 5000, 'alpha') },
      { pid: 4, port: 18768, args: sshArgs(18768, 8766, 'gamma') },
      { pid: 5, port: 19999, args: sshArgs(18000, 8000, 'alpha') },
      { pid: 6, port: 18001, args: sshArgs(18001, 8000, 'other-host') },
      { pid: 7, port: 18767, args: sshArgs(18767, 8766, 'beta') },
    ],
  })
  assert.deepEqual(await p.temps(), {
    alpha: [{ port: 5000, localPort: 15000 }, { port: 8766, localPort: 18766 }],
    'gamma': [{ port: 8766, localPort: 18768 }],
  })
})

test('清单服务占用的入口端口：所有机器所有服务的隧道端口都算，临时端口不能抢', () => {
  assert.deepEqual([...reservedPorts(LAYOUT)].sort((a, b) => a - b), [13080, 13081, 13082, 19119])
})

test('算本机端口：本机就用对面同一个号；被占往上 +1；清单服务的隧道端口跳过；已开着就报开着', async () => {
  assert.deepEqual(await page().plan({ id: 'alpha', port: 8766 }), { port: 8766, preferred: 8766, localPort: 8766, open: false })
  const busy = page({ portOpen: async (port) => port === 8766 || port === 8767 })
  assert.deepEqual(await busy.plan({ id: 'alpha', port: 8766 }), { port: 8766, preferred: 8766, localPort: 8768, taken: 'busy', open: false })
  // 13081 是 beta 的 DSH 隧道，13082 是 gamma 的；Alpha 要开 13081 就跳到 13083
  assert.deepEqual(await page().plan({ id: 'alpha', port: 13081 }), { port: 13081, preferred: 13081, localPort: 13083, taken: 'reserved', open: false })
  const opened = page({ sshListeners: async () => [{ pid: 2, port: 8767, args: sshArgs(8767, 8766, 'alpha') }], portOpen: async () => true })
  assert.deepEqual(await opened.plan({ id: 'alpha', port: 8766 }), { port: 8766, preferred: 8766, localPort: 8767, open: true })
  await assert.rejects(page().plan({ id: 'alpha', port: 3080 }), /3080 是 DSH，用上面 DSH 那行/)
  await assert.rejects(page().plan({ id: 'alpha', port: '8766' }), /端口要是 1 到 65535 的整数/)
  await assert.rejects(page().plan({ id: 'beta', port: 8766 }), /不认识的机器/)
  await assert.rejects(page({ portOpen: async () => true }).plan({ id: 'alpha', port: 8766 }), /8766 往上 100 个端口都被占了/)
})

test('拉起临时端口：用算好的端口起 ssh、不留日志；已开着不重复起', async () => {
  const started: unknown[][] = []
  let up = false
  const p = page({
    portOpen: async (port) => port === 8766 || (up && port === 8767),
    startTunnel: async (...args) => { started.push(args); up = true; return ok('') },
  })
  assert.deepEqual(await p.tempOpen({ id: 'alpha', port: 8766 }), { port: 8766, preferred: 8766, localPort: 8767, taken: 'busy', open: true, already: false })
  assert.deepEqual(started, [['alpha', 8767, 8766, undefined]])
  const again = page({ sshListeners: async () => [{ pid: 2, port: 8766, args: sshArgs(8766, 8766, 'alpha') }], startTunnel: async () => { throw new Error('不该起') } })
  assert.equal((await again.tempOpen({ id: 'alpha', port: 8766 })).already, true)
  await assert.rejects(
    page({ startTunnel: async () => ({ code: 255, stdout: '', stderr: 'channel_setup_fwd_listener_tcpip: cannot listen to port: 8766\n' }) }).tempOpen({ id: 'alpha', port: 8766 }),
    /隧道没起来：channel_setup_fwd_listener_tcpip/,
  )
})

test('打开临时端口：拉起后在本机浏览器打开隧道地址；早就开着也照样打开', async () => {
  const opened: string[] = []
  let up = false
  const p = page({ startTunnel: async () => { up = true; return ok('') }, portOpen: async (port) => up && port === 8766, open: async (url) => { opened.push(url) } })
  assert.deepEqual(await p.tempBrowse({ id: 'alpha', port: 8766 }), { port: 8766, preferred: 8766, localPort: 8766, open: true, already: false, url: 'http://127.0.0.1:8766' })
  const again = page({ sshListeners: async () => [{ pid: 3, port: 8766, args: sshArgs(8766, 8766, 'alpha') }], portOpen: async () => true, startTunnel: async () => { throw new Error('不该起') }, open: async (url) => { opened.push(url) } })
  assert.equal((await again.tempBrowse({ id: 'alpha', port: 8766 })).already, true)
  assert.deepEqual(opened, ['http://127.0.0.1:8766', 'http://127.0.0.1:8766'])
})

test('关掉临时端口：只停这台这个端口的那条 ssh；没开着就说没开', async () => {
  const killed: number[] = []
  let open = true
  const p = page({
    sshListeners: async () => open ? [{ pid: 9, port: 8767, args: sshArgs(8767, 8766, 'alpha') }, { pid: 10, port: 8768, args: sshArgs(8768, 8766, 'gamma') }] : [],
    listeners: async (port) => port === 8767 ? [{ pid: 9, command: 'ssh' }] : [],
    kill: (pid) => { killed.push(pid); open = false },
    portOpen: async () => open,
  })
  assert.deepEqual(await p.tempClose({ id: 'alpha', port: 8766 }), { closed: true, port: 8766, localPort: 8767 })
  assert.deepEqual(killed, [9])
  assert.deepEqual(await page().tempClose({ id: 'alpha', port: 8766 }), { closed: false, port: 8766 })
})

test('扫描：在对面跑 lsof 只要 TCP 监听；清单里的服务标出原因；ssh 失败报原因', async () => {
  const calls: string[][] = []
  const p = page({ run: async (file, args) => { calls.push([file, ...args]); return ok(['p1', 'cnode', 'f3', 'n*:3080', 'p2', 'cpython3.15', 'f4', 'n127.0.0.1:8766', 'p3', 'crapportd', 'f5', 'n*:60000', ''].join('\n')) } }, calls)
  assert.deepEqual(await p.scan({ id: 'alpha' }), { ports: [
    { port: 3080, processes: ['node'], note: '3080 是 DSH，用上面 DSH 那行' },
    { port: 8766, processes: ['python3.15'] },
    { port: 60000, processes: ['rapportd'] },
  ] })
  assert.equal(remoteLine(calls[0]!), "'/usr/sbin/lsof' '-nP' '-iTCP' '-sTCP:LISTEN' '-Fcn' '+c' '0'")
  assert.deepEqual(await page({ run: async () => ({ code: 1, stdout: '', stderr: '' }) }).scan({ id: 'alpha' }), { ports: [] })
  await assert.rejects(page({ run: async () => ({ code: 255, stdout: '', stderr: 'ssh: connect to host x: Operation timed out\n' }) }).scan({ id: 'alpha' }), /扫描 Alpha 没成：ssh: connect to host x: Operation timed out/)
})
