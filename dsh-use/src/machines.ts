/**
 * 设置里「远程机器」一页的宿主半：列别的机器，每台下面列它上面的服务（DSH、Hermes……），
 * 检查连不连得上、服务在不在，给服务拉起隧道并在浏览器打开、关隧道、跑卡片上的按钮。
 *
 * 机器和服务都读本插件配置（`machines`、`services`，写在插件自带的 cordis.patch.yml），代码不认任何具体服务。
 * 每个服务不一样的地方都是在对面跑一条命令：`check` 检查、`open` 拿要打开的网址、`actions` 卡片按钮。
 * 命令经 `ssh <机器>` 交给对面的登录 shell（fish）跑，所以 fish 函数也能写。
 * 清单里的服务用固定入口：本机端口 = 服务端口 + 10000 + 机器编号，同时连好几台也不撞；每个服务一条 `ssh -f -N -L`。
 * `open` 拿回的网址只在宿主这边交给 `open`，不回给浏览器（DSH 的网址带登录口令）。
 * 临时端口用对面同一个端口号；本机这个端口被占就往上 +1 找空的，不加偏移。
 * 临时端口不进清单也不落盘：开着哪些靠本机 ssh 监听的启动参数反推，`ssh -f` 的进程不随 DSH 重启消失。
 *
 * 端点挂在共享 `/api` 通道上（`/api/dsh-use.<端点>`），自带浏览器登录校验。
 */
import { execFile, execFileSync, spawn } from 'node:child_process'
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface MachineSpec {
  id: string
  label: string
  /** `scutil --get LocalHostName` 的值，用来认出本机。 */
  hostname: string
  /** 机器编号 0–9，本机端口加上它：同时连好几台时隧道入口不撞。 */
  slot: number
  /** 很少远程的机器：页面上排在主机器后面，不另起分组。 */
  secondary?: boolean
}

export interface ActionSpec {
  label: string
  run: string[]
  confirm?: boolean
}

export interface ServiceSpec {
  id: string
  label: string
  /** 对面机器上这个服务开的端口（只开本机 127.0.0.1）。 */
  port: number
  /** 只在这几台上有；不写就是每台都有。 */
  on?: string[]
  /** 检查：退出码 0 算在跑，显示输出第一行。不写就看对面这个端口有没有服务在听。 */
  check?: string[]
  /** 打开：输出里第一行以隧道地址开头的网址交给浏览器。不写就直接打开隧道地址。 */
  open?: string[]
  actions?: ActionSpec[]
}

export interface Layout {
  machines: MachineSpec[]
  services: ServiceSpec[]
}

export interface RunResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface MachineDeps {
  /** 本机 `scutil --get LocalHostName`。`os.hostname()` 有时返回局域网地址，不适合识别机器。 */
  localHostName(): string
  /** 跑一条命令，退出码非 0 也正常返回。 */
  run(file: string, args: readonly string[], timeoutMs: number): Promise<RunResult>
  portOpen(port: number): Promise<boolean>
  /** 起一条后台隧道；`ssh -f` 等转发建好才退出，返回它的退出码和报错。不给 name 就不留日志。 */
  startTunnel(machine: string, localPort: number, remotePort: number, name?: string): Promise<RunResult>
  /** 本机在这个端口上监听的进程。 */
  listeners(port: number): Promise<{ pid: number; command: string }[]>
  /** 本机在 127.0.0.1 上监听的 ssh 和它们的启动参数。参数只在宿主里认隧道通到哪，不回给页面。 */
  sshListeners(): Promise<{ pid: number; port: number; args: string }[]>
  kill(pid: number): void
  open(url: string): Promise<void>
}

export class MachineError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

export interface ServiceStatus {
  id: string
  tunnel: boolean
  running: boolean
  line: string
}

/** 页面能看懂的状态：活动、锁屏、在线（SSH 通但读不到锁屏）、完全没响应。 */
export type MachineState = 'active' | 'locked' | 'online' | 'offline'

export interface MachineStatus {
  id: string
  reachable: boolean
  /** 活动、锁屏、在线、睡眠/离线。 */
  state: MachineState
  /** 屏幕是否锁着时都读到的「距最后一次输入」。只有 macOS 读得到。 */
  idleSeconds?: number
  /** 最近一次 SSH 真正连上的时间；完全没响应时用来回答「多久没见了」。 */
  lastSeen?: { at: number; state: MachineState }
  /** 经别的机器或代理绕过去（ssh 设置里有 ProxyCommand）还是直连。 */
  relayed?: boolean
  reason?: string
  services: ServiceStatus[]
}

export interface ServiceEntry {
  id: string
  label: string
  localPort: number
  actions: { label: string; confirm: boolean }[]
}

export interface MachineEntry {
  id: string
  label: string
  secondary: boolean
  services: ServiceEntry[]
}

/** 对面一个在听的端口。只给进程名，不给命令行：有的命令行里带口令。 */
export interface Listening {
  port: number
  processes: string[]
  /** 不能拉临时隧道的原因（是清单里的服务）；能拉就没有。 */
  note?: string
}

export interface TempTunnel {
  port: number
  localPort: number
}

export interface TempPlan extends TempTunnel {
  /** 对面端口号，也就是首选的本机端口；被占时 localPort 是往上找到的第一个空闲端口。 */
  preferred: number
  /** preferred 为什么不能用：被别的程序占着，或留给了清单里某台机器的服务。 */
  taken?: 'busy' | 'reserved'
  /** 这条临时隧道已经开着，localPort 就是它在用的端口。 */
  open: boolean
}

export function localPort(service: ServiceSpec, machine: MachineSpec): number {
  return service.port + 10000 + machine.slot
}

/** 清单里所有机器的服务隧道入口端口：临时端口不能占它们。 */
export function reservedPorts(layout: Layout): Set<number> {
  return new Set(layout.machines.flatMap((m) => layout.services.filter((s) => runsOn(s, m)).map((s) => localPort(s, m))))
}

/** 清单写错（重名、端口撞、`on` 写了不存在的机器）直接报错，不悄悄连错。 */
export function checkLayout(layout: Layout): void {
  const bad = (message: string): never => { throw new MachineError('bad-config', `dsh-use 的机器和服务设置有误：${message}`) }
  const machineIds = new Set<string>()
  const slots = new Set<number>()
  for (const m of layout.machines) {
    if (machineIds.has(m.id)) bad(`机器 ${m.id} 写了两次`)
    machineIds.add(m.id)
    if (!Number.isInteger(m.slot) || m.slot < 0 || m.slot > 9) bad(`机器 ${m.id} 的编号要是 0 到 9`)
    if (slots.has(m.slot)) bad(`机器编号 ${String(m.slot)} 用了两次`)
    slots.add(m.slot)
  }
  const serviceIds = new Set<string>()
  const ports = new Map<number, string>()
  for (const s of layout.services) {
    if (serviceIds.has(s.id)) bad(`服务 ${s.id} 写了两次`)
    serviceIds.add(s.id)
    if (!Number.isInteger(s.port) || s.port < 1 || s.port + 10009 > 65535) bad(`服务 ${s.id} 的端口 ${String(s.port)} 超出范围`)
    ports.set(s.port, `服务 ${s.id} 自己的端口`)
    for (const id of s.on ?? []) if (!machineIds.has(id)) bad(`服务 ${s.id} 的 on 里写了不存在的机器 ${id}`)
  }
  for (const s of layout.services) {
    for (const m of layout.machines.filter((m) => runsOn(s, m))) {
      const port = localPort(s, m)
      const taken = ports.get(port)
      if (taken !== undefined) bad(`${m.label} 的 ${s.label} 算出本机端口 ${String(port)}，和${taken}撞了`)
      ports.set(port, ` ${m.label} 的 ${s.label} 的隧道`)
    }
  }
}

function runsOn(service: ServiceSpec, machine: MachineSpec): boolean {
  return service.on === undefined || service.on.length === 0 || service.on.includes(machine.id)
}

/** Quote one literal argument for bash, zsh, and fish login shells. */
export function fishQuote(arg: string): string {
  return "'" + arg.replaceAll("'", `'"'"'`) + "'"
}

function firstLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? ''
}

function lastLine(text: string): string {
  return text.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('Pseudo-terminal')).at(-1) ?? ''
}

function failureLine(result: RunResult): string {
  return lastLine(result.stderr) || firstLine(result.stdout) || `退出码 ${String(result.code)}`
}

/** 在对面 macOS 上读锁屏标志、控制台用户和 HID 空闲时间；不是 macOS 就只说平台。 */
const MACHINE_STATE_SCRIPT = [
  'if [ "$(uname -s)" != "Darwin" ]; then',
  '  echo "platform=$(uname -s)"',
  '  exit 0',
  'fi',
  'console=$(/usr/bin/stat -f %Su /dev/console 2>/dev/null || true)',
  'echo "console=$console"',
  '/usr/sbin/ioreg -n Root -d1 2>/dev/null | /usr/bin/grep -E "CGSSessionScreenIsLocked|CGSSessionScreenLockedTime" | /usr/bin/head -2 || true',
  '/usr/sbin/ioreg -r -c IOHIDSystem -d 1 2>/dev/null | /usr/bin/grep "HIDIdleTime" | /usr/bin/head -1 || true',
].join('\n')

/** SSH 报错里能看出「机器其实有应答」的几种情况，剩下的都按完全没响应算。 */
function probeFailureState(reason: string): MachineState {
  return /permission denied|host key verification failed|connection refused|too many authentication failures|authentication failed/i.test(reason) ? 'online' : 'offline'
}

/** 解析状态探针输出。读不到锁屏标志时只说「在线」，不猜活动还是锁屏。 */
export function parseMachineState(text: string): { state: MachineState; idleSeconds?: number } {
  if (text.trim() === '') return { state: 'online' }
  const consoleUser = /^console=(.*)$/m.exec(text)?.[1]?.trim() ?? ''
  const lock = /"CGSSessionScreenIsLocked"\s*=\s*(Yes|No|true|false)/i.exec(text)
  const idle = /"HIDIdleTime"\s*=\s*(\d+)/.exec(text)
  const idleSeconds = idle === null ? undefined : Math.round(Number(idle[1]) / 1_000_000_000)
  const atLogin = consoleUser === 'root' || consoleUser === 'loginwindow' || consoleUser === '_mbsetupuser'
  if (lock !== null) {
    const locked = /^(yes|true)$/i.test(lock[1]!) || atLogin
    const state = locked ? 'locked' : consoleUser === '' ? 'online' : 'active'
    return { state, ...(idleSeconds === undefined ? {} : { idleSeconds }) }
  }
  return { state: atLogin ? 'locked' : 'online', ...(idleSeconds === undefined ? {} : { idleSeconds }) }
}

/** `lsof -F pcn` 的输出：只留经 127.0.0.1 连得到的监听（`*` 和 127.0.0.1），按端口合并进程名。 */
export function parseListening(text: string): Listening[] {
  const byPort = new Map<number, Set<string>>()
  let command = ''
  for (const line of text.split('\n')) {
    if (line.startsWith('p')) command = ''
    else if (line.startsWith('c')) command = line.slice(1)
    else if (line.startsWith('n')) {
      const at = line.lastIndexOf(':')
      const port = Number(line.slice(at + 1))
      if (!['*', '127.0.0.1'].includes(line.slice(1, at)) || !Number.isInteger(port) || port < 1) continue
      const names = byPort.get(port) ?? new Set<string>()
      if (command !== '') names.add(command)
      byPort.set(port, names)
    }
  }
  return [...byPort].sort(([a], [b]) => a - b).map(([port, names]) => ({ port, processes: [...names].sort() }))
}

/** 认出本插件拉的隧道：`ssh … -L 127.0.0.1:<本机>:127.0.0.1:<对面> <机器>`，只有一个 -L，机器是最后一个参数。 */
export function parseForward(args: string): { localPort: number; remotePort: number; machine: string } | undefined {
  const words = args.trim().split(/\s+/)
  if (!/(^|\/)ssh$/.test(words[0] ?? '')) return undefined
  const specs = words.filter((_, i) => words[i - 1] === '-L')
  const spec = specs.length === 1 ? /^127\.0\.0\.1:(\d+):127\.0\.0\.1:(\d+)$/.exec(specs[0]!) : null
  const machine = words.at(-1)
  if (spec === null || machine === undefined || machine.startsWith('-') || machine === specs[0]) return undefined
  return { localPort: Number(spec[1]), remotePort: Number(spec[2]), machine }
}

export class MachinePage {
  private readonly deps: MachineDeps
  private readonly layout: () => Layout
  /** 最近一次 SSH 真正连上的时间。页面重开还在；DSH 重启就清空。 */
  private readonly lastSeen = new Map<string, { at: number; state: MachineState }>()
  constructor(deps: MachineDeps, layout: () => Layout) {
    this.deps = deps
    this.layout = layout
  }

  private current(): Layout {
    const layout = this.layout()
    checkLayout(layout)
    return layout
  }

  private self(layout: Layout): MachineSpec | undefined {
    const name = this.deps.localHostName().toLowerCase()
    return layout.machines.find((m) => m.hostname.toLowerCase() === name)
  }

  /**
   * `viewPort` 是浏览器地址栏里的端口。它等于本机某个服务的隧道端口，说明这页是别的机器经隧道打开的：
   * 页面上的按钮都在本机执行，「打开」会在本机弹浏览器、隧道也拉在本机，坐在别的机器前的人用不上。
   */
  list(payload?: unknown): { self?: string; viewedRemotely?: true; machines: MachineEntry[] } {
    const layout = this.current()
    const self = this.self(layout)
    const viewPort = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>)['viewPort'] : undefined
    const remote = self !== undefined && typeof viewPort === 'number' && layout.services.some((s) => runsOn(s, self) && localPort(s, self) === viewPort)
    return {
      ...(self === undefined ? {} : { self: self.label }),
      ...(remote ? { viewedRemotely: true as const } : {}),
      machines: layout.machines.filter((m) => m !== self).map((m) => ({
        id: m.id,
        label: m.label,
        secondary: m.secondary === true,
        services: layout.services.filter((s) => runsOn(s, m)).map((s) => ({
          id: s.id,
          label: s.label,
          localPort: localPort(s, m),
          actions: (s.actions ?? []).map((a) => ({ label: a.label, confirm: a.confirm === true })),
        })),
      })),
    }
  }

  /** 页面和命令行送来的机器（和服务）；本机、不认识的、这台上没有的服务都拒绝。 */
  target(machineId: unknown, serviceId?: unknown): { machine: MachineSpec; service?: ServiceSpec; layout: Layout } {
    const layout = this.current()
    const machine = layout.machines.find((m) => m.id === machineId)
    if (machine === undefined || machine === this.self(layout)) throw new MachineError('invalid-request', `不认识的机器：${String(machineId)}`)
    if (serviceId === undefined) return { machine, layout }
    const service = layout.services.find((s) => s.id === serviceId && runsOn(s, machine))
    if (service === undefined) throw new MachineError('invalid-request', `${machine.label} 上没有服务：${String(serviceId)}`)
    return { machine, service, layout }
  }

  private fill(args: readonly string[], machine: MachineSpec, service: ServiceSpec): string[] {
    const port = localPort(service, machine)
    const values: Record<string, string> = { base: `http://127.0.0.1:${String(port)}`, port: String(service.port), localPort: String(port), machine: machine.id }
    return args.map((a) => a.replace(/\{(base|port|localPort|machine)\}/g, (_, key: string) => values[key] ?? ''))
  }

  private remote(machine: MachineSpec, command: readonly string[], timeoutMs: number): Promise<RunResult> {
    return this.deps.run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', machine.id, '--', command.map(fishQuote).join(' ')], timeoutMs)
  }

  private async serviceStatus(machine: MachineSpec, service: ServiceSpec): Promise<ServiceStatus> {
    const tunnel = this.deps.portOpen(localPort(service, machine))
    if (service.check !== undefined && service.check.length > 0) {
      const result = await this.remote(machine, this.fill(service.check, machine, service), 30_000)
      const running = result.code === 0
      return { id: service.id, tunnel: await tunnel, running, line: running ? firstLine(result.stdout) : failureLine(result) }
    }
    const result = await this.remote(machine, ['/usr/bin/nc', '-z', '-G', '2', '127.0.0.1', String(service.port)], 20_000)
    const running = result.code === 0
    return { id: service.id, tunnel: await tunnel, running, line: running ? `端口 ${String(service.port)} 有服务在听` : `端口 ${String(service.port)} 没有服务在听` }
  }

  /** SSH 已通时再读一次系统状态；读不到就保守地只说「在线」。 */
  private async machineState(machine: MachineSpec): Promise<{ state: MachineState; idleSeconds?: number }> {
    const result = await this.remote(machine, ['/bin/sh', '-c', MACHINE_STATE_SCRIPT], 10_000)
    if (result.code !== 0) return { state: 'online' }
    return parseMachineState(result.stdout)
  }

  async status(payload: unknown): Promise<MachineStatus> {
    const { machine, layout } = this.target((payload as { id?: unknown } | null)?.id)
    const services = layout.services.filter((s) => runsOn(s, machine))
    const [probe, config] = await Promise.all([
      this.deps.run('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', machine.id, 'true'], 25_000),
      this.deps.run('ssh', ['-G', machine.id], 10_000),
    ])
    const relayed = /^proxycommand /m.test(config.stdout)
    if (probe.code !== 0) {
      const reason = lastLine(probe.stderr) || '连不上'
      const tunnels = await Promise.all(services.map((s) => this.deps.portOpen(localPort(s, machine))))
      const lastSeen = this.lastSeen.get(machine.id)
      return {
        id: machine.id,
        reachable: false,
        state: probeFailureState(reason),
        ...(lastSeen === undefined ? {} : { lastSeen }),
        relayed,
        reason,
        services: services.map((s, i) => ({ id: s.id, tunnel: tunnels[i] === true, running: false, line: '' })),
      }
    }
    const observed = await this.machineState(machine)
    this.lastSeen.set(machine.id, { at: Date.now(), state: observed.state })
    return { id: machine.id, reachable: true, ...observed, relayed, services: await Promise.all(services.map((s) => this.serviceStatus(machine, s))) }
  }

  async tunnel(payload: unknown): Promise<{ tunnel: true; already: boolean; localPort: number }> {
    const { machine, service } = this.pick(payload)
    const port = localPort(service, machine)
    if (await this.deps.portOpen(port)) return { tunnel: true, already: true, localPort: port }
    await this.start(machine, port, service.port, `${machine.id}-${service.id}`)
    return { tunnel: true, already: false, localPort: port }
  }

  private async start(machine: MachineSpec, port: number, remotePort: number, logName?: string): Promise<void> {
    const started = await this.deps.startTunnel(machine.id, port, remotePort, logName)
    for (let i = 0; i < 10; i += 1) {
      if (await this.deps.portOpen(port)) return
      if (started.code !== 0) break
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    throw new MachineError('tunnel-failed', `隧道没起来：${lastLine(started.stderr) || `ssh 退出码 ${String(started.code)}`}`)
  }

  async open(payload: unknown): Promise<{ opened: true; localPort: number }> {
    const { machine, service } = this.pick(payload)
    const { localPort: port } = await this.tunnel(payload)
    const base = `http://127.0.0.1:${String(port)}`
    let url = base
    if (service.open !== undefined && service.open.length > 0) {
      const result = await this.remote(machine, this.fill(service.open, machine, service), 30_000)
      if (result.code !== 0) throw new MachineError('open-failed', `没取到 ${service.label} 的网址：${failureLine(result)}`)
      const found = result.stdout.split('\n').map((l) => l.trim()).find((l) => l === base || l.startsWith(`${base}/`) || l.startsWith(`${base}?`))
      if (found === undefined) throw new MachineError('open-failed', `${service.label} 给出的不是这条隧道的网址`)
      url = found
    }
    await this.deps.open(url)
    return { opened: true, localPort: port }
  }

  async close(payload: unknown): Promise<{ closed: boolean; localPort: number }> {
    const { machine, service } = this.pick(payload)
    const port = localPort(service, machine)
    return { closed: await this.stop(port), localPort: port }
  }

  /** 只停在这个本机端口上监听的 ssh；没人监听返回 false。 */
  private async stop(port: number): Promise<boolean> {
    const holders = await this.deps.listeners(port)
    if (holders.length === 0) return false
    const other = holders.find((h) => h.command !== 'ssh')
    if (other !== undefined) throw new MachineError('not-a-tunnel', `本机 ${String(port)} 被别的程序占着（${other.command}），不是隧道，没动它`)
    for (const h of holders) this.deps.kill(h.pid)
    for (let i = 0; i < 10; i += 1) {
      if (!(await this.deps.portOpen(port))) return true
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    throw new MachineError('close-failed', `隧道进程已通知退出，但本机 ${String(port)} 还开着`)
  }

  /** 本机开着的临时隧道（清单里服务的隧道不算），连同进程号和机器。 */
  private async forwards(layout: Layout): Promise<(TempTunnel & { pid: number; machine: string })[]> {
    const found: (TempTunnel & { pid: number; machine: string })[] = []
    for (const listener of await this.deps.sshListeners()) {
      const f = parseForward(listener.args)
      if (f === undefined || f.localPort !== listener.port) continue
      const machine = layout.machines.find((m) => m.id === f.machine)
      if (machine === undefined) continue
      if (layout.services.some((s) => runsOn(s, machine) && s.port === f.remotePort && localPort(s, machine) === f.localPort)) continue
      found.push({ pid: listener.pid, machine: machine.id, port: f.remotePort, localPort: f.localPort })
    }
    return found
  }

  /** 每台机器开着的临时隧道，按对面端口排。 */
  async temps(): Promise<Record<string, TempTunnel[]>> {
    const layout = this.current()
    const self = this.self(layout)
    const out: Record<string, TempTunnel[]> = {}
    for (const f of await this.forwards(layout)) {
      if (f.machine === self?.id) continue
      const list = out[f.machine] ?? []
      list.push({ port: f.port, localPort: f.localPort })
      out[f.machine] = list
    }
    for (const list of Object.values(out)) list.sort((a, b) => a.port - b.port)
    return out
  }

  /** 清单里的服务走它自己那行，不当临时端口拉。 */
  private tempRefusal(machine: MachineSpec, layout: Layout, port: number): string | undefined {
    const fixed = layout.services.find((s) => s.port === port && runsOn(s, machine))
    return fixed === undefined ? undefined : `${String(port)} 是 ${fixed.label}，用上面 ${fixed.label} 那行`
  }

  private tempTarget(payload: unknown): { machine: MachineSpec; layout: Layout; port: number } {
    const p = (payload ?? {}) as { id?: unknown; port?: unknown }
    const { machine, layout } = this.target(p.id)
    const port = p.port
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new MachineError('invalid-request', `端口要是 1 到 65535 的整数：${String(port)}`)
    const refusal = this.tempRefusal(machine, layout, port)
    if (refusal !== undefined) throw new MachineError('invalid-request', refusal)
    return { machine, layout, port }
  }

  /** 本机就用对面这个端口号；被占就往上 +1 找第一个空闲的，清单里服务的隧道端口也跳过。 */
  async plan(payload: unknown): Promise<TempPlan> {
    const { machine, layout, port } = this.tempTarget(payload)
    const preferred = port
    const existing = (await this.forwards(layout)).find((f) => f.machine === machine.id && f.port === port)
    if (existing !== undefined) return { port, preferred, localPort: existing.localPort, open: true }
    const reserved = reservedPorts(layout)
    let taken: TempPlan['taken']
    for (let candidate = preferred; candidate <= Math.min(65535, preferred + 100); candidate += 1) {
      const why = reserved.has(candidate) ? 'reserved' : await this.deps.portOpen(candidate) ? 'busy' : undefined
      if (why === undefined) return { port, preferred, localPort: candidate, ...(taken === undefined ? {} : { taken }), open: false }
      taken ??= why
    }
    throw new MachineError('no-free-port', `本机 ${String(preferred)} 往上 100 个端口都被占了`)
  }

  async tempOpen(payload: unknown): Promise<TempPlan & { already: boolean }> {
    const plan = await this.plan(payload)
    if (plan.open) return { ...plan, already: true }
    const { machine } = this.tempTarget(payload)
    await this.start(machine, plan.localPort, plan.port)
    return { ...plan, open: true, already: false }
  }

  /** 「打开」：拉起（或复用）临时隧道，再在本机浏览器打开它。 */
  async tempBrowse(payload: unknown): Promise<TempPlan & { already: boolean; url: string }> {
    const r = await this.tempOpen(payload)
    const url = `http://127.0.0.1:${String(r.localPort)}`
    await this.deps.open(url)
    return { ...r, url }
  }

  async tempClose(payload: unknown): Promise<{ closed: boolean; port: number; localPort?: number }> {
    const { machine, layout, port } = this.tempTarget(payload)
    const found = (await this.forwards(layout)).find((f) => f.machine === machine.id && f.port === port)
    if (found === undefined) return { closed: false, port }
    return { closed: await this.stop(found.localPort), port, localPort: found.localPort }
  }

  /** 对面在听的 TCP 端口，只在点「扫描」时跑。 */
  async scan(payload: unknown): Promise<{ ports: Listening[] }> {
    const { machine, layout } = this.target((payload as { id?: unknown } | null)?.id)
    const result = await this.remote(machine, ['/usr/sbin/lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fcn', '+c', '0'], 20_000)
    const ports = parseListening(result.stdout)
    // lsof 一个都没找到时退出码也是 1，所以只在 ssh 自己失败或带了报错时算没成。
    if (result.code !== 0 && ports.length === 0 && (result.code === 255 || result.code === null || lastLine(result.stderr) !== '')) {
      throw new MachineError('scan-failed', `扫描 ${machine.label} 没成：${failureLine(result)}`)
    }
    return {
      ports: ports.map((p) => {
        const note = this.tempRefusal(machine, layout, p.port)
        return note === undefined ? p : { ...p, note }
      }),
    }
  }

  async action(payload: unknown): Promise<{ ok: true; line: string }> {
    const { machine, service } = this.pick(payload)
    const index = (payload as { action?: unknown }).action
    const action = typeof index === 'number' ? service.actions?.[index] : undefined
    if (action === undefined) throw new MachineError('invalid-request', `${service.label} 没有这个按钮：${String(index)}`)
    const result = await this.remote(machine, this.fill(action.run, machine, service), 60_000)
    if (result.code !== 0) throw new MachineError('action-failed', `${action.label}没成：${failureLine(result)}`)
    return { ok: true, line: firstLine(result.stdout) || '完成' }
  }

  private pick(payload: unknown): { machine: MachineSpec; service: ServiceSpec } {
    const p = (payload ?? {}) as { id?: unknown; service?: unknown }
    const { machine, service } = this.target(p.id, p.service ?? '')
    return { machine, service: service! }
  }

  handlers(): Record<string, (payload: unknown) => Promise<unknown>> {
    return {
      list: async (p) => this.list(p),
      status: (p) => this.status(p),
      tunnel: (p) => this.tunnel(p),
      open: (p) => this.open(p),
      close: (p) => this.close(p),
      action: (p) => this.action(p),
      temps: () => this.temps(),
      scan: (p) => this.scan(p),
      tempOpen: (p) => this.tempOpen(p),
      tempBrowse: (p) => this.tempBrowse(p),
      tempClose: (p) => this.tempClose(p),
    }
  }
}

// ---------------------------------------------------------------------------
// 真实依赖
// ---------------------------------------------------------------------------

/** 子进程环境：去掉会话身份，免得对面的 dsh-use 以为是某个会话在调它。 */
function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env['DSH_SESSION_ID']
  delete env['DSH_SHELL']
  return env
}

export function realMachineDeps(dshHome: string): MachineDeps {
  let name: string | undefined
  return {
    localHostName: () => {
      if (name === undefined) {
        try { name = execFileSync('/usr/sbin/scutil', ['--get', 'LocalHostName'], { encoding: 'utf8' }).trim() } catch { name = '' }
      }
      return name
    },
    run: (file, args, timeoutMs) => new Promise((resolve) => {
      execFile(file, [...args], { env: childEnv(), timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null
        resolve({ code, stdout: String(stdout), stderr: String(stderr) || (error !== null && code === null ? error.message : '') })
      })
    }),
    portOpen: (port) => new Promise((resolve) => {
      const socket = connect({ host: '127.0.0.1', port })
      const done = (open: boolean) => { socket.destroy(); resolve(open) }
      socket.setTimeout(1500, () => done(false))
      socket.once('connect', () => done(true))
      socket.once('error', () => done(false))
    }),
    startTunnel: (machine, local, remote, logName) => new Promise((resolve) => {
      // 临时端口不留日志：报错读完就删，后台 ssh 手里的句柄照样能写。
      const keep = logName !== undefined
      const dir = keep ? join(dshHome, 'dsh-use', 'tunnels') : mkdtempSync(join(tmpdir(), 'dsh-use-tunnel-'))
      if (keep) mkdirSync(dir, { recursive: true, mode: 0o700 })
      const log = join(dir, `${logName ?? 'temp'}.log`)
      const drop = () => { if (!keep) rmSync(dir, { recursive: true, force: true }) }
      const fd = openSync(log, 'w', 0o600)
      // 输出写文件而不接管道：ssh -f 转入后台后还占着标准输出，接管道就永远等不到结束。
      // 不走连接复用：每条隧道一个独立进程，关隧道只停它自己，DSH 重启、别的 SSH 断开也都不牵连它。
      const child = spawn('ssh', [
        '-f', '-N',
        '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
        '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        '-L', `127.0.0.1:${String(local)}:127.0.0.1:${String(remote)}`,
        machine,
      ], { env: childEnv(), stdio: ['ignore', fd, fd], detached: true })
      closeSync(fd)
      const timer = setTimeout(() => { child.kill(); finish(null) }, 45_000)
      const finish = (code: number | null) => {
        clearTimeout(timer)
        let stderr = ''
        try { stderr = readFileSync(log, 'utf8') } catch { /* 读不到就只报退出码 */ }
        drop()
        resolve({ code, stdout: '', stderr })
      }
      child.once('error', (error) => { clearTimeout(timer); drop(); resolve({ code: null, stdout: '', stderr: error.message }) })
      child.once('exit', (code) => finish(code))
      child.unref()
    }),
    listeners: (port) => new Promise((resolve) => {
      execFile('/usr/sbin/lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN', '-Fpc'], (_error, stdout) => {
        const found: { pid: number; command: string }[] = []
        for (const line of String(stdout).split('\n')) {
          if (line.startsWith('p')) found.push({ pid: Number(line.slice(1)), command: '' })
          else if (line.startsWith('c') && found.length > 0) found[found.length - 1]!.command = line.slice(1)
        }
        resolve(found)
      })
    }),
    sshListeners: () => new Promise((resolve) => {
      execFile('/usr/sbin/lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-c', 'ssh', '-Fpn'], (_error, stdout) => {
        const found: { pid: number; port: number }[] = []
        let pid = 0
        for (const line of String(stdout).split('\n')) {
          if (line.startsWith('p')) pid = Number(line.slice(1))
          else if (line.startsWith('n127.0.0.1:')) found.push({ pid, port: Number(line.slice('n127.0.0.1:'.length)) })
        }
        if (found.length === 0) { resolve([]); return }
        execFile('/bin/ps', ['-o', 'pid=,args=', '-p', [...new Set(found.map((f) => f.pid))].join(',')], (_psError, ps) => {
          const args = new Map<number, string>()
          for (const line of String(ps).split('\n')) {
            const m = /^\s*(\d+)\s+(.*)$/.exec(line)
            if (m !== null) args.set(Number(m[1]), m[2]!)
          }
          resolve(found.flatMap((f) => {
            const a = args.get(f.pid)
            return a === undefined ? [] : [{ ...f, args: a }]
          }))
        })
      })
    }),
    kill: (pid) => { process.kill(pid, 'SIGTERM') },
    open: (url) => new Promise((resolve, reject) => {
      execFile('/usr/bin/open', [url], (error) => error === null ? resolve() : reject(new MachineError('open-failed', `浏览器没打开：${error.message}`)))
    }),
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/** connection.fetch.register 需要的最小形状。 */
export interface FetchRoute {
  path: string
  methods: readonly string[]
  requestBody: 'buffered'
  fetch(request: Request): Promise<Response>
}

type RpcResult = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; details: object } }

function serverResponse(rpcId: string, result: RpcResult): Response {
  return Response.json({ type: 'server-response', rpcId, result })
}

function failure(error: unknown): RpcResult {
  const code = error instanceof MachineError ? error.code : 'failed'
  return { ok: false, error: { code: `dsh-use/${code}`, message: error instanceof Error ? error.message : String(error), details: {} } }
}

/** 每个端点包成一条 exact POST 路由：`/api/dsh-use.<端点>`。 */
export function machineRoutes(page: MachinePage): FetchRoute[] {
  return Object.entries(page.handlers()).map(([endpoint, run]) => ({
    path: `/api/dsh-use.${endpoint}`,
    methods: ['POST'],
    requestBody: 'buffered' as const,
    fetch: async (request: Request) => {
      if (request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
      const rpcId = typeof record['rpcId'] === 'string' ? record['rpcId'] : 'invalid-request'
      if (record['type'] !== 'client-request' || typeof record['rpcId'] !== 'string') {
        return serverResponse(rpcId, failure(new MachineError('invalid-request', 'invalid client-request message')))
      }
      try {
        return serverResponse(rpcId, { ok: true, value: await run(record['payload'] ?? {}) })
      } catch (error) {
        return serverResponse(rpcId, failure(error))
      }
    },
  }))
}