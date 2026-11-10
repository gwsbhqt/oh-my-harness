import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, renameSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { startServer } from '../src/server.ts'
import { COMMANDS, runCommand } from '../src/commands.ts'
import { RemoteService } from '../src/service.ts'
import { fileURLToPath } from 'node:url'

import { remoteFixture } from './remote-fixture.ts'

const launcher = fileURLToPath(new URL('../bin/dsh-control', import.meta.url))

// Use an isolated HOME and an explicitly configured test-only remote package.
function isolatedLauncher(root: string, shared?: Record<string, string>): string {
  const bin = join(root, 'dsh-plugins/dsh-control/bin')
  mkdirSync(bin, { recursive: true })
  copyFileSync(launcher, join(bin, 'dsh-control'))
  if (shared) {
    const pkg = join(root, 'shared/agentkit/remote')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(root, 'shared/agentkit/__init__.py'), '')
    writeFileSync(join(pkg, '__init__.py'), '')
    for (const [name, source] of Object.entries(shared)) writeFileSync(join(pkg, name), source)
  }
  return join(bin, 'dsh-control')
}

test('真实命令入口先调用共用目标选择，原样传参数和退出码，不触碰真实 DSH', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-control-target-'))
  try {
    const copy = isolatedLauncher(root, { 'target.py': `import json
def dispatch(tool, argv):
    print(json.dumps({"tool":tool,"args":argv}, ensure_ascii=False))
    return argv, 10
` })
    const args = ['-H', 'alpha', 'send', 'abcd', '中文 空格 \" $HOME ; --host']
    const r = spawnSync(copy, args, { encoding: 'utf8', env: { ...process.env, HOME: root, XDG_STATE_HOME: join(root, 'state'), DSH_CONTROL_SHARED_ROOT: join(root, 'shared'), PYTHONPATH: '' } })
    assert.equal(r.error, undefined)
    assert.equal(r.status, 10, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), { tool: 'dsh-control', args })
  } finally { rmSync(root, { recursive: true, force: true }) }
})



test('公开仓库默认使用相邻技能共享库，不依赖家目录布局', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-public-shared-'))
  try {
    const copy = isolatedLauncher(root, {'target.py': `import json
def dispatch(tool, argv):
    print(json.dumps({"tool":tool,"args":argv}))
    return argv, 10
`})
    mkdirSync(join(root,'dsh-plugins/skills'), {recursive:true})
    renameSync(join(root,'shared'),join(root,'dsh-plugins/skills/_shared'))
    const env: NodeJS.ProcessEnv = {...process.env, HOME:root, PYTHONPATH:'',XDG_STATE_HOME:join(root,'state')}
    delete env['DSH_CONTROL_SHARED_ROOT']
    const result = spawnSync(copy,['-H','alpha','health','--json'],{encoding:'utf8',env})
    assert.equal(result.status,10,result.stderr)
    assert.deepEqual(JSON.parse(result.stdout),{tool:'dsh-control',args:['-H','alpha','health','--json']})
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('能力握手先于共用代码：缺共用代码、离线也能给完整协议', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-control-capabilities-'))
  try {
    const r = spawnSync(isolatedLauncher(root), ['--local', '--capabilities', '--json'], { encoding: 'utf8', env: { ...process.env, HOME: root, XDG_STATE_HOME: join(root, 'state'), DSH_CONTROL_SHARED_ROOT: join(root, 'shared'), PYTHONPATH: '', DSH_CONTROL_SOCKET: join(root, 'absent.sock') } })
    assert.equal(r.error, undefined)
    assert.equal(r.status, 0, r.stderr)
    const payload = JSON.parse(r.stdout)
    assert.equal(payload.ok, true)
    assert.equal(payload.tool, 'dsh-control')
    assert.equal(payload.protocol, 1)
    for (const feature of ['local-routing', 'task-outcomes', 'send-receipts', 'chat-preflight', 'restart-receipts']) assert.ok(payload.features.includes(feature))
    assert.equal(r.stderr, '')
  } finally { rmSync(root, { recursive: true, force: true }) }
})



test('真实 Python 启动器与共享 target：审查错位 -H、保留正文，--local new --if-idle 明确拒绝忙碌', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-control-real-routing-'))
  const calls: string[] = []
  const id = 'session-fixture-aaaa1111'
  let maintenance: 'restart' | 'running' | 'queued' | 'job' | undefined
  const s = new RemoteService({
    gateway: { async invoke({ namespace, method, args }) {
      const endpoint = `${namespace}/${method}`; calls.push(endpoint)
      if (endpoint === 'session/list') return { items: [{ sessionId: id, running: false, blank: false, agentAvailable: true, updatedAt: 1, projections: { values: { title: '隔离夹具' } } }] }
      if (endpoint === 'session/prompt') { assert.deepEqual((args.request as { content: unknown }).content, [{ type: 'text', text: '正文 -H beta --host 不选机器' }]); return { accepted: true } }
      throw new Error(`未预期宿主边界 ${endpoint}`)
    }, stream: async () => { throw new Error('不应读取工作区') } },
    typert: { list: () => [], get: () => undefined }, query: { readSession: async () => ({ session: { id }, events: [] }) },
    usage: async () => undefined, onStatus: () => () => {}, log: () => {},
    pendingRestart: () => maintenance === 'restart' ? { phase: 'waiting', pid: process.pid } : undefined,
    quitBlockers: () => ({ running: maintenance === 'running' ? [id] : [], queued: maintenance === 'queued' ? [id] : [], jobs: maintenance === 'job' ? [{ id: 'job', kind: 'bash', label: '现有任务' }] : [] }),
    config: () => ({ readOnly: false, denyNamespaces: [], tiers: { normal: [], fast: [] }, reservePercent: 10, waitSliceMs: 10 }),
  })
  const socketPath = join(root, 'dsh-control/dsh.sock')
  const server = await startServer({ socketPath, commands: () => COMMANDS, info: () => ({}), log: () => {}, run: (c, a, o, sig) => runCommand(s, c, a, o, sig) })
  remoteFixture(root)
  const env = { ...process.env, HOME: root, DSH_HOME: root, DSH_CONTROL_SOCKET: socketPath, XDG_STATE_HOME: join(root, 'state'), DSH_CONTROL_SHARED_ROOT: join(root, 'shared') }
  const launch = (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(launcher, args, { env })
    let out = '', err = ''
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    child.stdout.on('data', (x: string) => { out += x }); child.stderr.on('data', (x: string) => { err += x })
    child.on('error', reject); child.on('close', (code) => resolve({ code, out, err }))
  })
  try {
    for (const args of [['health', '-H', 'beta', '--json'], ['health', '--host', 'beta', '--json'], ['api', 'list', '-H', 'beta', '--json']]) {
      calls.length = 0
      const r = await launch(args)
      assert.equal(r.code, 2, r.out + r.err)
      assert.deepEqual(calls, [])
    }
    const message = await launch(['--local', 'send', id, '正文 -H beta --host 不选机器', '--json'])
    assert.equal(message.code, 0, message.out + message.err)
    assert.equal(JSON.parse(message.out).data.sent, true)
    for (const blocker of ['restart', 'running', 'queued', 'job'] as const) {
      maintenance = blocker; calls.length = 0
      const r = await launch(['--local', 'new', '/repo/a', '维护', '--if-idle', '--json'])
      assert.equal(r.code, 2, r.out + r.err)
      assert.equal(JSON.parse(r.out).error.code, blocker === 'restart' ? 'restart-pending' : 'idle-required')
      assert.deepEqual(calls, [])
    }
  } finally { await server.close(); s.dispose(); rmSync(root, { recursive: true, force: true }) }
})

test('缺共用远程代码时入口非零退出，不退回本机执行', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-control-missing-target-'))
  try {
    const r = spawnSync(isolatedLauncher(root), ['-H', 'alpha', 'health', '--json'], {
      encoding: 'utf8', env: { ...process.env, HOME: root, XDG_STATE_HOME: join(root, 'state'), DSH_CONTROL_SHARED_ROOT: join(root, 'shared'), PYTHONPATH: '' },
    })
    assert.equal(r.error, undefined)
    assert.equal(r.status, 1)
    assert.equal(JSON.parse(r.stdout).error.code, 'transport-failed')
    assert.match(r.stderr, /install the shared remote support/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('HOME without remote support still executes local health over the socket', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-control-local-only-'))
  const socketPath = join(root, 'dsh.sock')
  const server = await startServer({ socketPath, commands: () => COMMANDS, info: () => ({ fixture: true }), log: () => {}, run: async (command) => { assert.equal(command, 'health'); return { ok: true, text: 'fixture healthy', data: { fixture: true } } } })
  try {
    for (const local of [false, true]) {
    if (local) { mkdirSync(join(root, 'state/dsh-control'), { recursive: true }); writeFileSync(join(root, 'state/dsh-control/pin.json'), JSON.stringify({ host: 'alpha' })) }
    const result = await new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const child = spawn(launcher, [...(local ? ['--local'] : []), 'health', '--json'], { env: { ...process.env, HOME: root, XDG_STATE_HOME: join(root, 'state'), DSH_CONTROL_SHARED_ROOT: join(root, 'absent'), DSH_CONTROL_SOCKET: socketPath } })
      let out = '', err = ''
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      child.stdout.on('data', (x: string) => { out += x }); child.stderr.on('data', (x: string) => { err += x })
      child.on('error', reject); child.on('close', code => resolve({ code, out, err }))
    })
    assert.equal(result.code, 0, result.out + result.err)
    assert.equal(JSON.parse(result.out).ok, true)
    }
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }) }
})

test('test-only remote package forwards remote requests and returns local arguments unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-control-remote-fixture-'))
  try {
    const shared = remoteFixture(root)
    const r = spawnSync(launcher, ['-H', 'alpha', 'health', '--json'], { encoding: 'utf8', env: { ...process.env, HOME: root, DSH_CONTROL_SHARED_ROOT: shared } })
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(JSON.parse(r.stdout), { tool: 'dsh-control', host: 'alpha', forwarded: ['health', '--json'] })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('remembered remote target requires support, and malformed pins never run locally', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-control-pin-'))
  try {
    const state = join(root, 'state', 'dsh-control')
    mkdirSync(state, { recursive: true })
    for (const pin of [{ host: 'alpha' }, { host: ' ' }, []]) {
      writeFileSync(join(state, 'pin.json'), JSON.stringify(pin))
      const r = spawnSync(launcher, ['health', '--json'], { encoding: 'utf8', env: { ...process.env, HOME: root, XDG_STATE_HOME: join(root, 'state'), DSH_CONTROL_SHARED_ROOT: join(root, 'absent') } })
      assert.notEqual(r.status, 0)
      assert.equal(JSON.parse(r.stdout).ok, false)
      assert.match(r.stdout + r.stderr, /shared remote support|Invalid default machine/)
    }
  } finally { rmSync(root, { recursive: true, force: true }) }
})

