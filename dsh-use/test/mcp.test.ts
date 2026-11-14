/**
 * dsh-use mcp 的专用验收：
 * - 真实 Unix socket 的假 DSH（只实现命令结果，不碰真实 App）；
 * - 真实 stdio 子进程和官方 SDK 客户端做 initialize / listTools / callTool；
 * - 覆盖创建、幂等、继续、分页、提问、失败、离线、重启恢复和 Python 启动器分流。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { startServer } from '../src/server.ts'
import type { CommandResult } from '../src/service.ts'
import { TaskStore } from '../src/cli/mcp-store.ts'
import { invokeCli } from './cli-fixture.ts'

const MCP_ENTRY = fileURLToPath(new URL('../src/cli/mcp.ts', import.meta.url))
const LAUNCHER = fileURLToPath(new URL('../bin/dsh-use', import.meta.url))
const MODEL = { provider: 'relay', model: 'group/deepseek-v4.1-flash' }
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

interface Call { command: string; args: string[]; options: Record<string, unknown> }

interface ExternalTurn {
  turn: number
  user: string
  reply: string
  ended: string
  endDetail?: string | null
  thinking?: string
  system?: string
  toolLog?: string
}

interface ExternalSession {
  sessionId: string
  title: string
  cwd: string
  running: boolean
  state: string
  turns: ExternalTurn[]
}

class FakeDsh {
  readonly projectDir: string
  readonly calls: Call[] = []
  readonly sessions = new Map<string, { since: number; turn: number }>()
  readonly external = new Map<string, ExternalSession>()
  waitMode: 'completed' | 'running' | 'waiting' | 'failed' | 'settled-blocked' = 'completed'
  replyText = '完成：已整理好。'
  questions: unknown[] = []
  running = false
  newDelayMs = 0
  sendDelayMs = 0
  waitDelayMs = 0
  onNew?: () => void
  private created = 0
  private sent = 0

  constructor(root: string) {
    this.projectDir = join(root, '项目甲')
    this.external.set('session-external-aaaa-0000', {
      sessionId: 'session-external-aaaa-0000',
      title: '外部项目甲',
      cwd: '/tmp/external-a',
      running: false,
      state: 'idle',
      turns: [
        { turn: 1, user: '先看文献', reply: '第一轮结论：已读。', ended: 'completed', thinking: 'SECRET-THINK', system: 'SECRET-SYSTEM', toolLog: 'SECRET-TOOL' },
        { turn: 2, user: '再整理', reply: '第二轮结论：已整理。', ended: 'completed' },
        { turn: 3, user: '给出长报告', reply: 'R'.repeat(9000), ended: 'completed' },
      ],
    })
    this.external.set('session-external-bbbb-0000', {
      sessionId: 'session-external-bbbb-0000',
      title: '外部项目乙',
      cwd: '/tmp/external-b',
      running: true,
      state: 'running',
      turns: [{ turn: 1, user: '继续跑', reply: '正在处理。', ended: 'completed' }],
    })
    this.sessions.set('session-external-aaaa-0000', { since: 100, turn: 3 })
    this.sessions.set('session-external-bbbb-0000', { since: 100, turn: 1 })
  }

  async run(command: string, args: string[], options: Record<string, unknown>): Promise<CommandResult> {
    this.calls.push({ command, args, options })
    switch (command) {
      case 'sessions': {
        const query = typeof options['query'] === 'string' ? options['query'].toLowerCase() : undefined
        const workspace = typeof options['workspace'] === 'string' ? options['workspace'].toLowerCase() : undefined
        let list = [...this.external.values()].map((s) => ({ sessionId: s.sessionId, title: s.title, cwd: s.cwd, running: s.running, state: s.state, updatedAt: 1_700_000_000_000, archived: false, blank: false }))
        if (query !== undefined) list = list.filter((s) => s.title.toLowerCase().includes(query) || (s.cwd ?? '').toLowerCase().includes(query))
        if (workspace !== undefined) list = list.filter((s) => s.title.toLowerCase().includes(workspace) || (s.cwd ?? '').toLowerCase().includes(workspace))
        if (typeof options['cwd'] === 'string') list = list.filter((s) => (s.cwd ?? '').startsWith(options['cwd'] as string))
        if (options['running'] === true) list = list.filter((s) => s.running)
        const limit = typeof options['limit'] === 'string' ? Number(options['limit']) : 20
        const shown = list.slice(0, limit)
        return { text: '', data: shown, meta: { shown: shown.length, matched: list.length, archivedHidden: 0, blankHidden: 0 } }
      }
      case 'workspaces':
        return { text: '', data: [{ workspaceId: 'w1', title: '项目甲', path: this.projectDir, sessionIds: ['session-existing', ...this.external.keys()], archivedCount: 0 }] }
      case 'new': {
        if (this.newDelayMs > 0) await sleep(this.newDelayMs)
        this.onNew?.()
        const id = `session-fake-${++this.created}`
        const state = { since: 100 + this.created * 10, turn: 0 }
        this.sessions.set(id, state)
        this.running = true
        return { text: '', data: { sessionId: id, workspace: args[0] ?? null, since: state.since, sent: true, model: MODEL } }
      }
      case 'send': {
        if (this.sendDelayMs > 0) await sleep(this.sendDelayMs)
        const id = args[0] ?? ''
        const state = this.sessions.get(id)
        assert.ok(state, `send 收到未知会话 ${id}`)
        state.since += 10
        this.running = true
        this.sent += 1
        return { text: '', data: { sent: true, requestId: `req-${this.sent}`, sessionId: id, since: state.since, mode: 'queue', interrupted: false, queuedBefore: 0 } }
      }
      case 'status': {
        const id = args[0] ?? ''
        if (id === 'missing-session') return { text: '', ok: false, error: { code: 'not-found', message: '找不到会话 missing-session' } }
        if (id === 'ambiguous-session') return { text: '', ok: false, error: { code: 'ambiguous', message: '对上了多个会话：a、b' } }
        const externalId = id === '外部项目甲' ? 'session-external-aaaa-0000' : id
        const externalStatus = this.external.get(externalId)
        if (externalStatus !== undefined) {
          return {
            text: '',
            data: {
              sessionId: externalStatus.sessionId,
              title: externalStatus.title,
              state: externalStatus.state,
              running: externalStatus.running,
              model: MODEL,
              turns: externalStatus.turns.length,
              lastSeq: externalStatus.turns.length,
              todos: [],
              queued: 0,
              questions: [],
            },
          }
        }
        const external = this.external.get(id)
        if (external !== undefined) {
          return {
            text: '',
            data: {
              sessionId: id,
              title: external.title,
              state: external.state,
              running: external.running,
              model: MODEL,
              turns: external.turns.length,
              lastSeq: external.turns.length,
              todos: [],
              queued: 0,
              questions: [],
            },
          }
        }
        const state = this.sessions.get(id)
        return {
          text: '',
          data: {
            sessionId: id,
            state: this.waitMode === 'running' ? 'running' : 'idle',
            running: this.waitMode === 'running',
            model: MODEL,
            turns: state?.turn ?? 0,
            lastSeq: state?.since ?? 0,
            todos: [],
            queued: 0,
            questions: this.waitMode === 'waiting' ? this.questions : [],
          },
          ...(this.waitMode === 'waiting' ? { status: 'waiting-input' as const } : {}),
        }
      }
      case 'read': {
        const id = args[0] ?? ''
        if (id === '外部项目甲') return { text: '', data: { sessionId: 'session-wrong', turns: [{ turn: 1, user: '错误会话', reply: 'WRONG-READ', ended: 'completed' }] } }
        const external = this.external.get(id)
        if (external !== undefined) return { text: '', data: { sessionId: id, turns: external.turns } }
        const state = this.sessions.get(id)
        return {
          text: '',
          data: {
            sessionId: id,
            turns: [{ turn: state?.turn ?? 1, ended: 'completed', detail: null, reply: this.replyText }],
          },
        }
      }
      case 'wait': {
        if (this.waitDelayMs > 0) await sleep(this.waitDelayMs)
        const id = args[0] ?? ''
        const state = this.sessions.get(id)
        const since = typeof options['since'] === 'string' ? Number(options['since']) : (state?.since ?? 0)
        if (this.waitMode === 'running') return { text: '', status: 'running', data: { sessionId: id, since, waitingFor: '会话在跑' } }
        if (this.waitMode === 'settled-blocked') return { text: '', status: 'running', data: { sessionId: id, since, waitingFor: '这一轮已结束，但还没真做完：还有 1 个后台任务在跑', blockers: ['还有 1 个后台任务在跑'] } }
        if (this.waitMode === 'waiting') return { text: '', status: 'waiting-input', data: { sessionId: id, questions: this.questions } }
        if (this.waitMode === 'failed') {
          return {
            text: '', ok: false, status: 'failed',
            error: { code: 'task-failed', message: '验收用失败' },
            data: { sessionId: id, since, lastSeq: state?.since ?? 0, turns: [{ turn: 1, ended: 'error', detail: '验收用失败', reply: '失败前的回复' }] },
          }
        }
        return {
          text: '', status: 'ok',
          data: { sessionId: id, since, lastSeq: state?.since ?? 0, turns: [{ turn: 1, ended: 'completed', detail: null, reply: this.replyText }] },
        }
      }
      case 'answer':
        return { text: '', data: { sessionId: args[0] ?? '', accepted: true, answer: options['json'] ?? null } }
      case 'cancel':
        return { text: '', data: { sessionId: args[0] ?? '', cancelled: this.running } }
      default:
        throw new Error(`夹具不支持命令 ${command}`)
    }
  }
}

interface Fixture {
  root: string
  fake: FakeDsh
  socketPath: string
  close: () => Promise<void>
}

async function fixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), 'dsh-use-mcp-'))
  const fake = new FakeDsh(root)
  const socketPath = join(root, 'dsh-use', 'dsh.sock')
  const server = await startServer({
    socketPath,
    commands: () => [],
    info: () => ({}),
    log: () => {},
    run: (command, args, options) => fake.run(command, args, options),
  })
  return { root, fake, socketPath, close: async () => { await server.close(); rmSync(root, { recursive: true, force: true }) } }
}

interface McpConnection { client: Client; close: () => Promise<void> }

async function connect(entry: string, args: string[], env: Record<string, string>): Promise<McpConnection> {
  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) childEnv[key] = value
  Object.assign(childEnv, env)
  const fromSource = entry.endsWith('.ts')
  const transport = new StdioClientTransport({
    command: fromSource ? process.execPath : entry,
    args: fromSource ? [entry, ...args] : args,
    env: childEnv,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'dsh-use-mcp-test', version: '1.0.0' })
  await client.connect(transport)
  return { client, close: async () => { await client.close() } }
}

function mcpFor(f: Fixture): Promise<McpConnection> {
  return connect(MCP_ENTRY, [], { DSH_HOME: f.root, DSH_USE_SOCKET: f.socketPath })
}

function payloadOf(result: unknown): Record<string, unknown> {
  const value = result as { content?: { type: string; text: string }[]; isError?: boolean }
  assert.ok(Array.isArray(value.content), '工具返回没有 content')
  assert.equal(value.content[0]?.type, 'text')
  return JSON.parse(value.content[0]!.text) as Record<string, unknown>
}

function errorOf(result: unknown): { code: string; message: string } {
  const payload = payloadOf(result)
  assert.equal((result as { isError?: boolean }).isError, true, `期望工具错误，实际 ${JSON.stringify(payload)}`)
  const error = payload['error'] as { code: string; message: string }
  assert.ok(typeof error?.code === 'string' && typeof error?.message === 'string')
  return error
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args })
  return payloadOf(result)
}

test('官方 SDK 真实 stdio：initialize、tools/list 与工具说明完整', async () => {
  const f = await fixture()
  const mcp = await mcpFor(f)
  try {
    const listed = await mcp.client.listTools()
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      'dsh_answer_task', 'dsh_attach_session', 'dsh_cancel_task', 'dsh_continue_task', 'dsh_create_task',
      'dsh_list_sessions', 'dsh_list_workspaces', 'dsh_read_session', 'dsh_read_task',
    ])
    for (const tool of listed.tools) assert.ok(tool.description && tool.description.length > 10, `${tool.name} 缺说明`)
    const server = mcp.client.getServerVersion()
    assert.equal(server?.name, 'dsh-use')
  } finally { await mcp.close(); await f.close() }
})

test('发现并直接读取外部已有会话：分页保留正文、排除思考/系统/工具内容', async () => {
  const f = await fixture()
  const mcp = await mcpFor(f)
  try {
    const listed = await call(mcp.client, 'dsh_list_sessions', { query: '外部项目甲' })
    assert.equal((listed['sessions'] as unknown[]).length, 1)
    assert.equal((listed['sessions'] as { session_id: string }[])[0]!.session_id, 'session-external-aaaa-0000')
    assert.equal(listed['matched'], 1)
    assert.equal(listed['shown'], 1)

    const first = await call(mcp.client, 'dsh_read_session', { session: 'session-external-aaaa-0000', turn: 1, offset: 0, max_chars: 4000 })
    assert.equal(first['session_id'], 'session-external-aaaa-0000')
    assert.equal(first['state'], 'idle')
    assert.equal(first['running'], false)
    assert.equal((first['turns'] as { turn: number }[])[0]!.turn, 1)
    assert.match(String(first['text']), /第一轮结论/)
    const raw = JSON.stringify(first)
    assert.equal(raw.includes('SECRET-THINK'), false)
    assert.equal(raw.includes('SECRET-SYSTEM'), false)
    assert.equal(raw.includes('SECRET-TOOL'), false)

    const page1 = await call(mcp.client, 'dsh_read_session', { session: 'session-external-aaaa-0000', turn: 3, offset: 0, max_chars: 1000 })
    assert.equal(page1['turn'], 3)
    assert.equal(page1['total_chars'], 9000 + '第 3 轮\n用户：给出长报告\n助手：'.length)
    assert.equal(String(page1['text']).length, 1000)
    assert.equal(page1['next_offset'], 1000)
    const page2 = await call(mcp.client, 'dsh_read_session', { session: 'session-external-aaaa-0000', turn: 3, offset: 1000, max_chars: 1000 })
    assert.equal(page2['turn'], 3)
    assert.equal(page2['turn_start'], 3)
    assert.equal(page2['turn_end'], 3)
    assert.equal(String(page2['text']).length, 1000)

    const running = await call(mcp.client, 'dsh_read_session', { session: 'session-external-bbbb-0000', last: 1, offset: 0, max_chars: 4000 })
    assert.equal(running['running'], true)
    assert.equal(running['state'], 'running')
  } finally { await mcp.close(); await f.close() }
})

test('read_session 先用 status 解析 canonical ID，再按该 ID 读正文', async () => {
  const f = await fixture()
  const mcp = await mcpFor(f)
  try {
    const result = await call(mcp.client, 'dsh_read_session', { session: '外部项目甲', turn: 1, offset: 0, max_chars: 4000 })
    assert.equal(result['session_id'], 'session-external-aaaa-0000')
    assert.match(String(result['text']), /第一轮结论/)
    assert.equal(String(result['text']).includes('WRONG-READ'), false)
    const statusCall = f.fake.calls.find((c) => c.command === 'status' && c.args[0] === '外部项目甲')
    const readCall = f.fake.calls.find((c) => c.command === 'read' && c.args[0] === 'session-external-aaaa-0000')
    assert.ok(statusCall && readCall)
  } finally { await mcp.close(); await f.close() }
})

test('read_session 多轮分页带固定 through_turn 的 next_page，新轮出现不串页', async () => {
  const f = await fixture()
  const mcp = await mcpFor(f)
  try {
    const page1 = await call(mcp.client, 'dsh_read_session', { session: 'session-external-aaaa-0000', last: 2, offset: 0, max_chars: 200 })
    assert.equal(page1['through_turn'], 3)
    const next = page1['next_page'] as Record<string, unknown>
    assert.equal(next['session'], 'session-external-aaaa-0000')
    assert.equal(next['through_turn'], 3)
    assert.equal(next['last'], 2)
    assert.equal(next['offset'], 200)
    f.fake.external.get('session-external-aaaa-0000')!.turns.push({ turn: 4, user: '新问题', reply: '新回复', ended: 'completed' })
    const page2 = await call(mcp.client, 'dsh_read_session', next)
    assert.equal(page2['through_turn'], 3)
    assert.equal(page2['turn'], 3)
    assert.equal(String(page2['text']).includes('新回复'), false)
  } finally { await mcp.close(); await f.close() }
})

test('read_session 单轮分页 next_page 保留 turn，且分段边界轮号准确', async () => {
  const f = await fixture()
  const mcp = await mcpFor(f)
  try {
    const page1 = await call(mcp.client, 'dsh_read_session', { session: 'session-external-aaaa-0000', turn: 3, offset: 0, max_chars: 1000 })
    const next = page1['next_page'] as Record<string, unknown>
    assert.equal(next['turn'], 3)
    assert.equal(next['offset'], 1000)
    f.fake.external.get('session-external-aaaa-0000')!.turns.push({ turn: 4, user: '新问题', reply: '新回复', ended: 'completed' })
    const page2 = await call(mcp.client, 'dsh_read_session', next)
    assert.equal(page2['turn'], 3)
    assert.equal(String(page2['text']).length, 1000)
    assert.equal(String(page2['text']).includes('新回复'), false)

    const full = await call(mcp.client, 'dsh_read_session', { session: 'session-external-aaaa-0000', last: 2, through_turn: 3, offset: 0, max_chars: 10000 })
    const boundary = String(full['text']).indexOf('第 3 轮') - 3
    assert.ok(boundary > 0)
    const boundaryPage = await call(mcp.client, 'dsh_read_session', { session: 'session-external-aaaa-0000', last: 2, through_turn: 3, offset: boundary, max_chars: 1000 })
    assert.ok((boundaryPage['page_turns'] as number[]).includes(2), '边界页必须把仍在正文里的第 2 轮算进去')
  } finally { await mcp.close(); await f.close() }
})

test('接入已有会话不新建、不发送、不换模型；重复/并发接入复用同一任务', async () => {
  const f = await fixture()
  const a = await mcpFor(f)
  const b = await mcpFor(f)
  try {
    const first = await call(a.client, 'dsh_attach_session', { session: 'session-external-aaaa-0000' })
    assert.equal(first['session_id'], 'session-external-aaaa-0000')
    assert.equal(first['attached'], true)
    assert.equal(first['reused'], false)
    assert.equal(first['status'], 'idle')
    assert.deepEqual(first['model'], MODEL)
    assert.equal(first['tier'], null)
    assert.ok(String(first['task_id']).startsWith('task-'))
    assert.equal(f.fake.calls.filter((c) => ['new', 'send', 'model'].includes(c.command)).length, 0)

    const again = await call(a.client, 'dsh_attach_session', { session: 'session-external-aaaa-0000' })
    assert.equal(again['task_id'], first['task_id'])
    assert.equal(again['reused'], true)
    const other = await call(b.client, 'dsh_attach_session', { session: 'session-external-aaaa-0000' })
    assert.equal(other['task_id'], first['task_id'])
    assert.equal(other['reused'], true)

    const readIdle = await call(a.client, 'dsh_read_task', { task_id: String(first['task_id']), wait_seconds: 10, offset: 0, max_chars: 1000 })
    assert.equal(readIdle['status'], 'idle')
    assert.notEqual(readIdle['status'], 'running')
    assert.deepEqual(readIdle['model'], MODEL)
    assert.equal(readIdle['tier'], null)

    const continued = await call(a.client, 'dsh_continue_task', { task_id: String(first['task_id']), request_key: 'attach-cont', message: '接着做' })
    assert.equal(continued['session_id'], 'session-external-aaaa-0000')
    assert.equal(continued['task_id'], first['task_id'])
    assert.equal(f.fake.calls.filter((c) => c.command === 'new').length, 0)
    assert.equal(f.fake.calls.filter((c) => c.command === 'send').length, 1)
  } finally { await a.close(); await b.close(); await f.close() }
})

test('歧义会话在直接读取和接入时明确失败', async () => {
  const f = await fixture()
  const mcp = await mcpFor(f)
  try {
    const readError = errorOf(await mcp.client.callTool({ name: 'dsh_read_session', arguments: { session: 'ambiguous-session', last: 1, offset: 0, max_chars: 1000 } }))
    assert.equal(readError.code, 'ambiguous')
    const attachError = errorOf(await mcp.client.callTool({ name: 'dsh_attach_session', arguments: { session: 'ambiguous-session' } }))
    assert.equal(attachError.code, 'ambiguous')
  } finally { await mcp.close(); await f.close() }
})

test('无效会话在直接读取和接入时明确失败', async () => {
  const f = await fixture()
  const mcp = await mcpFor(f)
  try {
    const readError = errorOf(await mcp.client.callTool({ name: 'dsh_read_session', arguments: { session: 'missing-session', last: 1, offset: 0, max_chars: 1000 } }))
    assert.equal(readError.code, 'not-found')
    const attachError = errorOf(await mcp.client.callTool({ name: 'dsh_attach_session', arguments: { session: 'missing-session' } }))
    assert.equal(attachError.code, 'not-found')
    assert.equal(readdirSync(join(f.root, 'dsh-use', 'mcp', 'tasks')).filter((name) => name.endsWith('.json')).length, 0)
  } finally { await mcp.close(); await f.close() }
})

test('接入会话跨 MCP 进程重开仍复用原 task_id', async () => {
  const f = await fixture()
  const first = await mcpFor(f)
  let taskId = ''
  try {
    const attached = await call(first.client, 'dsh_attach_session', { session: 'session-external-aaaa-0000' })
    taskId = String(attached['task_id'])
  } finally { await first.close() }
  const second = await mcpFor(f)
  try {
    const again = await call(second.client, 'dsh_attach_session', { session: 'session-external-aaaa-0000' })
    assert.equal(again['task_id'], taskId)
    assert.equal(again['reused'], true)
    assert.equal(f.fake.calls.filter((c) => c.command === 'new' || c.command === 'send').length, 0)
  } finally { await second.close(); await f.close() }
})

test('接入已有 create 任务时复用原 task_id', async () => {
  const f = await fixture()
  const mcp = await mcpFor(f)
  try {
    const created = await call(mcp.client, 'dsh_create_task', { request_key: 'attach-existing', prompt: '原任务', workspace: '项目甲' })
    const attached = await call(mcp.client, 'dsh_attach_session', { session: String(created['session_id']) })
    assert.equal(attached['task_id'], created['task_id'])
    assert.equal(attached['reused'], true)
  } finally { await mcp.close(); await f.close() }
})

test('列工作区；创建任务默认 fast 并返回真实模型；同 key 同输入只建一次', async () => {
  const f = await fixture()
  const mcp = await mcpFor(f)
  try {
    const workspaces = await call(mcp.client, 'dsh_list_workspaces')
    assert.equal((workspaces['workspaces'] as unknown[]).length, 1)
    assert.equal((workspaces['workspaces'] as { title: string }[])[0]!.title, '项目甲')

    const first = await call(mcp.client, 'dsh_create_task', { request_key: 'create-1', prompt: '整理目录并给出报告', workspace: '项目甲' })
    assert.match(String(first['task_id']), /^task-/)
    assert.match(String(first['session_id']), /^session-fake-/)
    assert.equal(first['since'], 110)
    assert.deepEqual(first['model'], MODEL)
    assert.equal(first['selected_model'], 'relay/group/deepseek-v4.1-flash')
    const newCall = f.fake.calls.find((c) => c.command === 'new')
    assert.equal(newCall?.options['tier'], 'fast')
    assert.match(newCall?.args[1] ?? '', /整理目录并给出报告/)
    assert.match(newCall?.args[1] ?? '', /只回复四项/)
    assert.match(newCall?.args[1] ?? '', /绝对路径/)

    const second = await call(mcp.client, 'dsh_create_task', { request_key: 'create-1', prompt: '整理目录并给出报告', workspace: '项目甲' })
    assert.equal(second['task_id'], first['task_id'])
    assert.equal(second['replayed'], true)
    assert.equal(f.fake.calls.filter((c) => c.command === 'new').length, 1)

    const conflict = errorOf(await mcp.client.callTool({ name: 'dsh_create_task', arguments: { request_key: 'create-1', prompt: '另一份输入', workspace: '项目甲' } }))
    assert.equal(conflict.code, 'request_key_conflict')
  } finally { await mcp.close(); await f.close() }
})

test('同 key 并发创建只发一次，两个调用拿到同一个任务', async () => {
  const f = await fixture()
  const mcp = await mcpFor(f)
  try {
    const args = { request_key: 'create-concurrent', prompt: '并发测试', workspace: '项目甲' }
    const [a, b] = await Promise.all([
      mcp.client.callTool({ name: 'dsh_create_task', arguments: args }),
      mcp.client.callTool({ name: 'dsh_create_task', arguments: args }),
    ])
    const one = payloadOf(a), two = payloadOf(b)
    assert.equal(one['task_id'], two['task_id'])
    assert.equal(f.fake.calls.filter((c) => c.command === 'new').length, 1)
  } finally { await mcp.close(); await f.close() }
})

test('继续派活：新 since、requestId、同 key 幂等与异输入冲突', async () => {
  const f = await fixture()
  const mcp = await mcpFor(f)
  try {
    const created = await call(mcp.client, 'dsh_create_task', { request_key: 'create-c', prompt: '第一步', workspace: '项目甲' })
    const id = String(created['task_id'])
    const first = await call(mcp.client, 'dsh_continue_task', { task_id: id, request_key: 'continue-1', message: '做第二步' })
    assert.equal(first['since'], 120)
    assert.match(String(first['request_id']), /^req-/)
    assert.equal(f.fake.calls.filter((c) => c.command === 'send').length, 1)
    const again = await call(mcp.client, 'dsh_continue_task', { task_id: id, request_key: 'continue-1', message: '做第二步' })
    assert.equal(again['since'], first['since'])
    assert.equal(again['replayed'], true)
    assert.equal(f.fake.calls.filter((c) => c.command === 'send').length, 1)
    const conflict = errorOf(await mcp.client.callTool({ name: 'dsh_continue_task', arguments: { task_id: id, request_key: 'continue-1', message: '换了内容' } }))
    assert.equal(conflict.code, 'request_key_conflict')
  } finally { await mcp.close(); await f.close() }
})

test('读结果默认只取最后必要回复，长文按 offset/max_chars 分页', async () => {
  const f = await fixture()
  f.fake.replyText = '甲'.repeat(10_000)
  const mcp = await mcpFor(f)
  try {
    const created = await call(mcp.client, 'dsh_create_task', { request_key: 'create-read', prompt: '写一份长报告', workspace: '项目甲' })
    const id = String(created['task_id'])
    const page1 = await call(mcp.client, 'dsh_read_task', { task_id: id, wait_seconds: 0, offset: 0, max_chars: 4000 })
    assert.equal(page1['status'], 'completed')
    const reply1 = page1['reply'] as { text: string; offset: number; next_offset: number; total_chars: number; truncated: boolean }
    assert.equal(reply1.text.length, 4000)
    assert.equal(reply1.next_offset, 4000)
    assert.equal(reply1.total_chars, 10_000)
    assert.equal(reply1.truncated, true)
    const page2 = await call(mcp.client, 'dsh_read_task', { task_id: id, wait_seconds: 0, offset: 4000, max_chars: 4000 })
    const reply2 = page2['reply'] as { text: string; offset: number; next_offset: number }
    assert.equal(reply2.text.length, 4000)
    assert.equal(reply2.offset, 4000)
    assert.equal(reply2.next_offset, 8000)
    const waitDone = await call(mcp.client, 'dsh_read_task', { task_id: id, wait_seconds: 1, offset: 0, max_chars: 4000 })
    assert.equal(waitDone['status'], 'completed')
  } finally { await mcp.close(); await f.close() }
})

test('运行中、等待回答、回答任务提问、失败终态', async () => {
  const f = await fixture()
  f.fake.waitMode = 'running'
  const mcp = await mcpFor(f)
  try {
    const created = await call(mcp.client, 'dsh_create_task', { request_key: 'create-run', prompt: '长任务', workspace: '项目甲' })
    const id = String(created['task_id'])
    const running = await call(mcp.client, 'dsh_read_task', { task_id: id, wait_seconds: 1, offset: 0, max_chars: 4000 })
    assert.equal(running['status'], 'running')

    f.fake.waitMode = 'waiting'
    f.fake.questions = [{ callId: 'call-1', questions: [{ id: 'q1', question: '选哪个颜色？', options: [{ label: '蓝色' }, { label: '绿色' }] }] }]
    const waiting = await call(mcp.client, 'dsh_read_task', { task_id: id, wait_seconds: 0, offset: 0, max_chars: 4000 })
    assert.equal(waiting['status'], 'waiting_input')
    const groups = waiting['questions'] as { callId: string; questions: { id: string }[] }[]
    assert.equal(groups[0]?.callId, 'call-1')
    assert.equal(groups[0]?.questions[0]?.id, 'q1')
    const answered = await call(mcp.client, 'dsh_answer_task', { task_id: id, answers: [{ id: 'q1', selected: ['蓝色'] }] })
    assert.equal(answered['accepted'], true)
    const answerCall = f.fake.calls.find((c) => c.command === 'answer')
    assert.match(String(answerCall?.options['json']), /蓝色/)

    const badAnswer = errorOf(await mcp.client.callTool({ name: 'dsh_answer_task', arguments: { task_id: id, answers: [{ id: 'q-other', selected: ['蓝色'] }] } }))
    assert.equal(badAnswer.code, 'unknown_question')

    f.fake.waitMode = 'failed'
    f.fake.questions = []
    const failed = await call(mcp.client, 'dsh_read_task', { task_id: id, wait_seconds: 1, offset: 0, max_chars: 4000 })
    assert.equal(failed['status'], 'failed')
    assert.equal((failed['error'] as { code: string }).code, 'task-failed')
  } finally { await mcp.close(); await f.close() }
})

test('离线、未知任务和非本桥任务都有明确错误', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-use-mcp-offline-'))
  const mcp = await connect(MCP_ENTRY, [], { DSH_HOME: root, DSH_USE_SOCKET: join(root, 'absent.sock') })
  try {
    const offline = errorOf(await mcp.client.callTool({ name: 'dsh_create_task', arguments: { request_key: 'offline-1', prompt: '不该发出去', workspace: '项目甲' } }))
    assert.equal(offline.code, 'dsh_unavailable')
  } finally { await mcp.close(); rmSync(root, { recursive: true, force: true }) }
  const f = await fixture()
  const live = await mcpFor(f)
  try {
    const unknown = errorOf(await live.client.callTool({ name: 'dsh_read_task', arguments: { task_id: 'task-not-mine', wait_seconds: 0 } }))
    assert.equal(unknown.code, 'task_not_found')
    const sessionId = errorOf(await live.client.callTool({ name: 'dsh_read_task', arguments: { task_id: 'session-existing', wait_seconds: 0 } }))
    assert.equal(sessionId.code, 'task_not_found')
  } finally { await live.close(); await f.close() }
})

test('进程重开后旧任务仍可读；取消只作用于本桥任务', async () => {
  const f = await fixture()
  f.fake.waitMode = 'completed'
  const first = await mcpFor(f)
  let id = ''
  try {
    const created = await call(first.client, 'dsh_create_task', { request_key: 'create-restart', prompt: '重开测试', workspace: '项目甲' })
    id = String(created['task_id'])
  } finally { await first.close() }
  const second = await mcpFor(f)
  try {
    const read = await call(second.client, 'dsh_read_task', { task_id: id, wait_seconds: 0 })
    assert.equal(read['task_id'], id)
    assert.equal(read['status'], 'completed')
    f.fake.running = true
    const cancelled = await call(second.client, 'dsh_cancel_task', { task_id: id })
    assert.equal(cancelled['cancelled'], true)
    const unknown = errorOf(await second.client.callTool({ name: 'dsh_cancel_task', arguments: { task_id: 'task-other' } }))
    assert.equal(unknown.code, 'task_not_found')
  } finally { await second.close(); await f.close() }
})

test('Python 启动器 dsh-use mcp 固定本机分流，真实 SDK 完成握手和工具调用', async () => {
  const f = await fixture()
  const mcp = await connect(LAUNCHER, ['mcp'], { HOME: f.root, DSH_HOME: f.root, DSH_USE_SOCKET: f.socketPath })
  try {
    const listed = await mcp.client.listTools()
    assert.equal(listed.tools.length, 9)
    const result = await call(mcp.client, 'dsh_list_workspaces')
    assert.equal((result['workspaces'] as unknown[]).length, 1)
  } finally { await mcp.close(); await f.close() }
})

test('任务库写锁：另一个进程持锁时明确报 store_locked，不破坏已有记录', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-use-mcp-lock-'))
  try {
    const first = new TaskStore(root)
    const second = new TaskStore(root)
    first.ensure()
    let release!: () => void
    const held = first.withLock(() => new Promise<void>((resolve) => { release = resolve }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    await assert.rejects(second.withLock(() => undefined, 60), (error: unknown) => (error as { code?: string }).code === 'store_locked')
    release()
    await held
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('断电恢复：遗留 dispatching 任务读成 unknown，不自动重放', async () => {
  const f = await fixture()
  try {
    const store = new TaskStore(f.root)
    store.ensure()
    store.save({
      version: 1,
      taskId: 'task-stale',
      workspace: '项目甲',
      tier: 'fast',
      createdAt: 1,
      updatedAt: 1,
      status: 'dispatching',
      requests: { 'stale-key': { key: 'stale-key', kind: 'start', inputHash: 'x', phase: 'dispatching', startedAt: 1 } },
      pendingRequest: { id: 'create:stale-key', key: 'stale-key', kind: 'start', startedAt: 1, pid: 999_999 },
    })
    const mcp = await mcpFor(f)
    try {
      const read = await call(mcp.client, 'dsh_read_task', { task_id: 'task-stale', wait_seconds: 0 })
      assert.equal(read['status'], 'unknown')
      assert.equal((read['last_error'] as { code: string }).code, 'outcome_unknown')
      assert.equal(f.fake.calls.filter((c) => c.command === 'new' || c.command === 'send').length, 0)
    } finally { await mcp.close() }
  } finally { await f.close() }
})


test('0 秒读取遇到后台任务阻塞不报 completed', async () => {
  const f = await fixture()
  f.fake.waitMode = 'settled-blocked'
  const mcp = await mcpFor(f)
  try {
    const created = await call(mcp.client, 'dsh_create_task', { request_key: 'create-blocked-zero', prompt: '后台没结束', workspace: '项目甲' })
    const read = await call(mcp.client, 'dsh_read_task', { task_id: String(created['task_id']), wait_seconds: 0, offset: 0, max_chars: 1000 })
    assert.equal(read['status'], 'running')
    const waitCall = f.fake.calls.filter((c) => c.command === 'wait').at(-1)
    assert.equal(waitCall?.options['settled'], true)
  } finally { await mcp.close(); await f.close() }
})

test('0 秒读取也走 wait --settled；真实 CLI 的 read --last 1 可用', async () => {
  const f = await fixture()
  const mcp = await mcpFor(f)
  try {
    const created = await call(mcp.client, 'dsh_create_task', { request_key: 'create-zero', prompt: '零秒读取', workspace: '项目甲' })
    const id = String(created['task_id'])
    f.fake.calls.length = 0
    const read = await call(mcp.client, 'dsh_read_task', { task_id: id, wait_seconds: 0, offset: 0, max_chars: 1000 })
    assert.equal(read['status'], 'completed')
    const waitCall = f.fake.calls.find((c) => c.command === 'wait')
    assert.ok(waitCall, '0 秒读取必须调用 wait')
    assert.equal(waitCall?.options['settled'], true, '0 秒读取必须带 --settled')
    assert.ok(Number(waitCall?.options['slice']) >= 3000, '0 秒读取至少要给真做完判据 3 秒稳定期')

    const readCli = await invokeCli(['read', String(created['session_id']), '--last', '1', '--json'], { DSH_HOME: f.root, DSH_USE_SOCKET: f.socketPath })
    assert.equal(readCli.code, 0, readCli.err)
    const readData = JSON.parse(readCli.out).data as { turns: unknown[] }
    assert.equal(readData.turns.length, 1)
  } finally { await mcp.close(); await f.close() }
})

test('发送前任务文件和 request 索引已经写入（含目录持久化屏障）', async () => {
  const f = await fixture()
  let before: { tasks: string[]; requests: string[] } | undefined
  f.fake.onNew = () => {
    const base = join(f.root, 'dsh-use', 'mcp')
    before = {
      tasks: readdirSync(join(base, 'tasks')).filter((name) => name.endsWith('.json')),
      requests: readdirSync(join(base, 'requests')).filter((name) => name.endsWith('.json')),
    }
  }
  const mcp = await mcpFor(f)
  try {
    const created = await call(mcp.client, 'dsh_create_task', { request_key: 'create-durable', prompt: '先落盘再发送', workspace: '项目甲' })
    assert.ok(before, 'new 执行前没有观测到账本')
    assert.equal(before!.tasks.length, 1)
    assert.equal(before!.requests.length, 1)
    const taskFile = join(f.root, 'dsh-use', 'mcp', 'tasks', `${String(created['task_id'])}.json`)
    assert.equal((JSON.parse(readFileSync(taskFile, 'utf8')) as { status: string }).status, 'running')
  } finally { await mcp.close(); await f.close() }
})

test('两个 stdio 进程同 key 创建：只建一次，另一进程返回原任务/进行中', async () => {
  const f = await fixture()
  f.fake.newDelayMs = 120
  const a = await mcpFor(f)
  const b = await mcpFor(f)
  try {
    const args = { request_key: 'cross-create', prompt: '跨进程创建', workspace: '项目甲' }
    const [ra, rb] = await Promise.all([
      a.client.callTool({ name: 'dsh_create_task', arguments: args }),
      b.client.callTool({ name: 'dsh_create_task', arguments: args }),
    ])
    const pa = payloadOf(ra), pb = payloadOf(rb)
    assert.equal(pa['task_id'], pb['task_id'])
    assert.equal(f.fake.calls.filter((c) => c.command === 'new').length, 1)
    assert.ok(pa['in_progress'] === true || pb['in_progress'] === true, '另一进程应看到原任务进行中')
  } finally { await a.close(); await b.close(); await f.close() }
})

test('两个 stdio 进程同 key 续办：只发一次，另一进程返回进行中', async () => {
  const f = await fixture()
  const a = await mcpFor(f)
  const b = await mcpFor(f)
  try {
    const created = await call(a.client, 'dsh_create_task', { request_key: 'cross-cont-create', prompt: '准备', workspace: '项目甲' })
    const id = String(created['task_id'])
    f.fake.sendDelayMs = 150
    const args = { task_id: id, request_key: 'cross-cont', message: '同一份续办' }
    const [ra, rb] = await Promise.all([
      a.client.callTool({ name: 'dsh_continue_task', arguments: args }),
      b.client.callTool({ name: 'dsh_continue_task', arguments: args }),
    ])
    const pa = payloadOf(ra), pb = payloadOf(rb)
    assert.equal(f.fake.calls.filter((c) => c.command === 'send').length, 1)
    assert.ok(pa['in_progress'] === true || pb['in_progress'] === true, '另一进程应看到原续办进行中')
    assert.equal(pa['task_id'], pb['task_id'])
  } finally { await a.close(); await b.close(); await f.close() }
})

test('两个 stdio 进程不同 key 续办：一个发送，另一个 task_busy，不并发发送', async () => {
  const f = await fixture()
  const a = await mcpFor(f)
  const b = await mcpFor(f)
  try {
    const created = await call(a.client, 'dsh_create_task', { request_key: 'race-create', prompt: '准备', workspace: '项目甲' })
    const id = String(created['task_id'])
    f.fake.sendDelayMs = 180
    const [ra, rb] = await Promise.all([
      a.client.callTool({ name: 'dsh_continue_task', arguments: { task_id: id, request_key: 'race-a', message: 'A' } }),
      b.client.callTool({ name: 'dsh_continue_task', arguments: { task_id: id, request_key: 'race-b', message: 'B' } }),
    ])
    const results = [ra, rb]
    assert.equal(f.fake.calls.filter((c) => c.command === 'send').length, 1)
    const errors = results.filter((result) => (result as { isError?: boolean }).isError === true)
    assert.equal(errors.length, 1)
    assert.equal(errorOf(errors[0]).code, 'task_busy')
  } finally { await a.close(); await b.close(); await f.close() }
})

test('读状态进行中另一个进程续办：since 和 requests 不回退', async () => {
  const f = await fixture()
  f.fake.waitMode = 'running'
  f.fake.waitDelayMs = 250
  const a = await mcpFor(f)
  const b = await mcpFor(f)
  try {
    const created = await call(a.client, 'dsh_create_task', { request_key: 'read-race-create', prompt: '准备', workspace: '项目甲' })
    const id = String(created['task_id'])
    const readPromise = a.client.callTool({ name: 'dsh_read_task', arguments: { task_id: id, wait_seconds: 1, offset: 0, max_chars: 1000 } })
    await sleep(50)
    await call(b.client, 'dsh_continue_task', { task_id: id, request_key: 'read-race-cont', message: '续办' })
    const read = payloadOf(await readPromise)
    const stored = new TaskStore(f.root).require(id)
    assert.equal(stored.since, 120, '读状态不能把续办后的 since 回退')
    assert.ok(stored.requests['read-race-cont'], '读状态不能丢掉续办的请求记录')
    assert.equal(read['superseded'], true)
    assert.equal(read['status'], 'running')
  } finally { await a.close(); await b.close(); await f.close() }
})

test('两个竞争者同时遇到同一残留锁：安全拒绝，不互相误删', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-use-mcp-stale-race-'))
  try {
    const first = new TaskStore(root)
    const second = new TaskStore(root)
    first.ensure()
    const lock = join(root, 'dsh-use', 'mcp', '.lock')
    writeFileSync(lock, JSON.stringify({ pid: 999_999, at: 0, token: 'dead-owner' }))
    const results = await Promise.allSettled([
      first.withLock(() => undefined, 100),
      second.withLock(() => undefined, 100),
    ])
    for (const result of results) {
      assert.equal(result.status, 'rejected')
      assert.equal((result as PromiseRejectedResult).reason.code, 'store_lock_stale')
    }
    assert.equal(existsSync(lock), true, '残留锁不能被任一方自动删除')
    assert.equal((JSON.parse(readFileSync(lock, 'utf8')) as { token: string }).token, 'dead-owner')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('活进程持锁超过 30 秒不被当残留；刚建的空锁也不被秒删', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-use-mcp-lock-stale-'))
  try {
    const store = new TaskStore(root)
    store.ensure()
    const lock = join(root, 'dsh-use', 'mcp', '.lock')
    writeFileSync(lock, JSON.stringify({ pid: process.pid, at: 0, token: 'live' }))
    utimesSync(lock, new Date(0), new Date(0))
    await assert.rejects(store.withLock(() => undefined, 80), (error: unknown) => (error as { code?: string }).code === 'store_locked')
    assert.equal(existsSync(lock), true, '活进程的锁不能被删')
    writeFileSync(lock, '')
    await assert.rejects(store.withLock(() => undefined, 80), (error: unknown) => (error as { code?: string }).code === 'store_lock_unresolved')
    assert.equal(existsSync(lock), true, '刚创建还没写内容的锁不能被秒删')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
