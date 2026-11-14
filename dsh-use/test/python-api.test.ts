import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { startServer } from '../src/server.ts'
import { remoteFixture } from './remote-fixture.ts'
import { COMMANDS } from '../src/commands.ts'

test('Python API 经真实启动器与 socket 保留 chat 失败回执、等待输入和完整答案', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-use-python-socket-'))
  const socketPath = join(root, 'dsh-use/dsh.sock')
  const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = []
  const receipt = { sent: true, requestId: 'request-fixture', sessionId: 'session-fixture', since: 42 }
  const server = await startServer({ socketPath, commands: () => COMMANDS, info: () => ({}), log: () => {}, run: async (command, args, options) => {
    calls.push({ command, args, options })
    if (command === 'send') return { text: '已发', data: receipt }
    if (command === 'wait') return { text: '任务失败', ok: false, status: 'failed', error: { code: 'task-failed', message: '中文失败' }, data: { turns: [{ ended: 'error', reply: '半段回复' }] } }
    if (command === 'status') return { text: '等回答', status: 'waiting-input', data: { sessionId: receipt.sessionId, questions: [{ id: 'q', question: '选什么？' }] } }
    if (command === 'answer') return { text: '已接收', data: { accepted: true } }
    if (command === 'monitor') return { text: '已启动', data: { id: 'monitor-fixture', owner: args[0] } }
    throw new Error(`未预期命令 ${command}`)
  } })
  const shared = remoteFixture(root)
  const source = `import asyncio, json
import dsh_use
async def main():
    chat = await dsh_use.chat("session-fixture", "中文 空格 --host $HOME ;", local=True, timeout=1)
    status = await dsh_use.status("session-fixture", local=True)
    answer = await dsh_use.answer("session-fixture", local=True, json={"answers":[{"id":"q","custom":"中文 --json"}]})
    monitor = await dsh_use.monitor("session-original", local=True, command="fish -lc 'echo 中文 $HOME ;'", cwd="/repo/原目录", label="服务 原归属")
    help_result = await dsh_use.help(local=True)
    print(json.dumps({"chat":chat,"status":status,"answer":answer,"help":help_result,"monitor":monitor}, ensure_ascii=False))
asyncio.run(main())`
  try {
    const output = await new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
      const child = spawn('python3', ['-c', source], { env: { ...process.env, HOME: root, DSH_HOME: root, DSH_USE_SHARED_ROOT: shared, XDG_STATE_HOME: join(root, 'state'), DSH_USE_SOCKET: socketPath, PYTHONPATH: fileURLToPath(new URL('../skills/dsh-use/src', import.meta.url)) } })
      let out = '', err = ''
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
      child.stdout.on('data', (x: string) => { out += x }); child.stderr.on('data', (x: string) => { err += x })
      child.on('error', reject); child.on('close', (code) => resolve({ code, out, err }))
    })
    assert.equal(output.code, 0, output.out + output.err)
    const value = JSON.parse(output.out)
    assert.equal(value.chat.exit_code, 1)
    assert.equal(value.chat.ok, false)
    assert.equal(value.chat.error.code, 'task-failed')
    assert.deepEqual(value.chat.receipt, receipt)
    assert.equal(value.chat.data.turns[0].reply, '半段回复')
    assert.equal(value.status.exit_code, 10)
    assert.equal(value.status.status, 'waiting-input')
    assert.equal(value.answer.exit_code, 0)
    assert.equal(value.help.exit_code, 0)
    assert.equal(value.monitor.exit_code, 0)
    assert.equal(value.monitor.data.owner, 'session-original')
    assert.deepEqual(calls.find((c) => c.command === 'monitor'), { command: 'monitor', args: ['session-original'], options: { command: "fish -lc 'echo 中文 $HOME ;'", cwd: '/repo/原目录', label: '服务 原归属' } })
    assert.match(value.help.text, /dsh-use/)
    assert.equal(calls.filter((c) => c.command === 'send').length, 1)
    assert.deepEqual(calls.find((c) => c.command === 'send')?.args, ['session-fixture', '中文 空格 --host $HOME ;'])
    assert.equal(calls.find((c) => c.command === 'wait')?.options.since, '42')
    assert.deepEqual(JSON.parse(String(calls.find((c) => c.command === 'answer')?.options.json)), { answers: [{ id: 'q', custom: '中文 --json' }] })
  } finally { await server.close(); rmSync(root, { recursive: true, force: true }) }
})
