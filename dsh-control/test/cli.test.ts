import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { parseCommand, quitApp, type QuitRunner } from '../src/cli/core.ts'
import { runCommand } from '../src/commands.ts'
import type { RemoteService } from '../src/service.ts'



test('菜单退出精确协议与中文英文普通退出项，不选择保留窗口或开发重启', () => {
  for (const label of ['退出 DeepSeek Harness', 'Quit DeepSeek Harness']) {
    const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
    const run: QuitRunner = (command, args, env) => {
      calls.push({ command, args, env })
      const data = args.includes('--capabilities')
        ? { ok: true, tool: 'computer-control', protocol: 1, features: ['local-routing'] }
        : args.length === 5
          ? { ok: true, app: 'DeepSeek Harness', menu: 'DeepSeek Harness', items: [{ label, enabled: true, hasSubmenu: false, shortcut: 'Q' }, { label: 'Quit and Keep Windows', enabled: true, hasSubmenu: false, shortcut: 'Q' }, { label: '重启应用与 Host', enabled: true, hasSubmenu: false }] }
          : { ok: true, menu: 'DeepSeek Harness', item: label }
      return { status: 0, stderr: '', stdout: JSON.stringify(data) }
    }
    const result = quitApp('menu', '/Applications/DeepSeek Harness.app', { HOME: '/fixture', COMPUTER_CONTROL_NO_AUTOLAUNCH: '0' }, run)
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(calls.map((c) => c.args), [
      ['--local', '--capabilities', '--json'],
      ['--local', 'menu', '/Applications/DeepSeek Harness.app', 'DeepSeek Harness', '--json'],
      ['--local', 'menu', '/Applications/DeepSeek Harness.app', 'DeepSeek Harness', label, '--json'],
    ])
    assert.ok(calls.every((c) => c.command === '/fixture/.local/bin/computer-control' && c.env.COMPUTER_CONTROL_NO_AUTOLAUNCH === '1'))
  }
})

test('菜单退出缺工具、旧协议、模糊重复禁用本地化及动作失败都不改道或重试', () => {
  const failures = ['missing', 'old', 'malformed', 'wrong-app', 'ambiguous', 'disabled', 'submenu', 'untranslated', 'timeout', 'action-rejected']
  for (const failure of failures) {
    const calls: string[][] = []
    const run: QuitRunner = (_command, args) => {
      calls.push(args)
      if (failure === 'missing') return { status: null, signal: null, stderr: 'missing computer-control', error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }
      if (args.includes('--capabilities')) return { status: 0, stderr: '', stdout: JSON.stringify({ ok: true, tool: 'computer-control', protocol: failure === 'old' ? 0 : 1, features: ['local-routing'] }) }
      if (failure === 'malformed') return { status: 0, stderr: '', stdout: 'invalid' }
      if (args.length === 5) {
        const item = { label: failure === 'untranslated' ? 'Quit and Keep Windows' : '退出 DeepSeek Harness', enabled: failure !== 'disabled', hasSubmenu: failure === 'submenu' }
        return { status: 0, stderr: '', stdout: JSON.stringify({ ok: true, app: failure === 'wrong-app' ? 'Other App' : 'DeepSeek Harness', menu: 'DeepSeek Harness', items: failure === 'ambiguous' ? [item, item] : [item] }) }
      }
      if (failure === 'timeout') return { status: null, signal: 'SIGTERM', error: Object.assign(new Error('spawnSync computer-control ETIMEDOUT'), { code: 'ETIMEDOUT' }), stderr: 'action status unknown' }
      return { status: 5, signal: null, stderr: 'no accessibility permission', stdout: JSON.stringify({ ok: false, code: 5, error: 'no permission' }) }
    }
    const result = quitApp('menu', '/Applications/DeepSeek Harness.app', { HOME: '/fixture' }, run)
    assert.notEqual(result.status, 0, failure)
    assert.ok(calls.length <= 3)
    assert.ok(calls.every((c) => c[0] === '--local' && !c.includes('key') && !c.includes('cmd+q')))
    assert.equal(calls.filter((c) => c.length === 6).length, ['timeout', 'action-rejected'].includes(failure) ? 1 : 0)
    if (failure === 'timeout') { assert.equal((result.error as NodeJS.ErrnoException).code, 'ETIMEDOUT'); assert.equal(result.signal, 'SIGTERM'); assert.equal(result.stage, 'menu-action') }
  }
  let touched = false
  const invalid = quitApp('menu', '/Applications/Other.app', {}, () => { touched = true; throw new Error('should not run') })
  assert.notEqual(invalid.status, 0)
  assert.equal(touched, false)
})

test('默认退出仍仅AppleEvent，原始超时状态完整保留、不调用 computer-control', () => {
  const calls: string[] = []
  const result = quitApp(undefined, undefined, {}, (command) => { calls.push(command); return { status: null, signal: 'SIGTERM', stderr: 'audit stderr', error: Object.assign(new Error('spawnSync osascript ETIMEDOUT'), { code: 'ETIMEDOUT' }) } })
  assert.deepEqual(calls, ['osascript'])
  assert.equal(result.stage, 'apple-event')
  assert.equal(result.signal, 'SIGTERM')
  assert.equal((result.error as NodeJS.ErrnoException).code, 'ETIMEDOUT')
})



test('真实子进程菜单argv夹具：capabilities/读取/单次普通退出，完全不碰真实App', () => {
  const root = mkdtempSync('/tmp/dsh-quit-menu-')
  try {
    const script = join(root, 'computer-control-fixture.mjs'), log = join(root, 'calls.jsonl')
    writeFileSync(script, `import {appendFileSync} from 'node:fs';
const a=process.argv.slice(2); appendFileSync(${JSON.stringify(log)},JSON.stringify({args:a,noLaunch:process.env.COMPUTER_CONTROL_NO_AUTOLAUNCH})+'\\n');
const result=a.includes('--capabilities')?{ok:true,tool:'computer-control',protocol:1,features:['local-routing']}:
a.length===5?{ok:true,app:'DeepSeek Harness',menu:'DeepSeek Harness',items:[{label:'退出 DeepSeek Harness',enabled:true,hasSubmenu:false},{label:'Quit and Keep Windows',enabled:true,hasSubmenu:false}]}:
{ok:true,menu:'DeepSeek Harness',item:a[4]};console.log(JSON.stringify(result));`)
    const result = quitApp('menu', '/Applications/DeepSeek Harness.app', { HOME: root }, (_command, args, env) => spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', timeout: 1000 }))
    assert.equal(result.status, 0, result.stderr)
    const rows = readFileSync(log, 'utf8').trim().split('\n').map((row) => JSON.parse(row))
    assert.equal(rows.length, 3)
    assert.deepEqual(rows[2].args, ['--local', 'menu', '/Applications/DeepSeek Harness.app', 'DeepSeek Harness', '退出 DeepSeek Harness', '--json'])
    assert.ok(rows.every((row) => row.noLaunch === '1'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

const answer = { answers: [
  { id: 'q1', selected: ['蓝色', '绿色'] },
  { id: 'q2', selected: [], custom: '保留中文、空格与 --json 字样' },
] }
const payload = JSON.stringify(answer)
const forms = [
  { name: '空格', args: ['--json', payload], asJson: false },
  { name: '等号', args: [`--json=${payload}`], asJson: false },
  { name: '载荷后加输出开关', args: ['--json', payload, '--json'], asJson: true },
  { name: '载荷前加输出开关', args: ['--json', '--json', payload], asJson: true },
  { name: '等号载荷与输出共存', args: ['--json', `--json=${payload}`], asJson: true },
]
for (const form of forms) {
  test(`answer JSON 回归：${form.name}，多问题与自定义回答完整送到服务端`, async () => {
    const parsed = parseCommand(['answer', 'session-fixture', ...form.args, '--call-id', 'call-fixture'])
    assert.deepEqual(parsed.positional, ['session-fixture'])
    assert.equal(parsed.options.json, payload)
    assert.equal(parsed.asJson, form.asJson)
    let received: unknown
    const service = { async answer(id: string, options: unknown) {
      received = { id, options }
      return { text: '已回答，会话会接着跑' }
    } } as unknown as RemoteService
    await runCommand(service, parsed.command!, parsed.positional, parsed.options, new AbortController().signal)
    assert.deepEqual(received, { id: 'session-fixture', options: { select: [], json: answer, callId: 'call-fixture' } })
  })
}

test('send/chat 的 --now、--interrupt 是开关：写在消息前面也不会把消息吃成它的值', () => {
  for (const command of ['send', 'chat']) {
    assert.deepEqual(parseCommand([command, 'abcd', '--now', '改目标']), { command, positional: ['abcd', '改目标'], options: { now: true }, asJson: false })
    assert.deepEqual(parseCommand([command, 'abcd', '--interrupt', '停下']), { command, positional: ['abcd', '停下'], options: { interrupt: true }, asJson: false })
  }
  assert.deepEqual(parseCommand(['queue', 'abcd', 'steer', 'all']), { command: 'queue', positional: ['abcd', 'steer', 'all'], options: {}, asJson: false })
})

test('未分组和空白开关不会吞掉后面的标题词', () => {
  assert.deepEqual(parseCommand(['sessions', '--ungrouped', '--include-blank', '中文']), { command: 'sessions', positional: ['中文'], options: { ungrouped: true, 'include-blank': true }, asJson: false })
})

test('其他命令的 --json、重复开关、等号值和 -- 分隔符保持旧解析结果', () => {
  for (const command of ['health', 'sessions', 'status', 'send', 'wait', 'chat', 'new', 'cancel', 'quota', 'models', 'pick', 'model', 'plugins', 'plugin', 'config', 'api', 'doctor', 'start', 'restart', 'version', 'help']) {
    assert.deepEqual(parseCommand([command, 'arg', '--json']), { command, positional: ['arg'], options: {}, asJson: true })
    assert.deepEqual(parseCommand([command, '--json', 'arg']), { command, positional: ['arg'], options: {}, asJson: true })
    assert.deepEqual(parseCommand([command, '--json', '--json']), { command, positional: [], options: {}, asJson: false })
    assert.deepEqual(parseCommand([command, '--json=value']), { command, positional: [], options: {}, asJson: false })
    assert.deepEqual(parseCommand([command, '--', '--json']), { command, positional: ['--json'], options: {}, asJson: false })
  }
})

test('answer 单问题选择、自由回答和裸 --json 输出仍可用', () => {
  assert.deepEqual(parseCommand(['answer', '--json', 'session-fixture', '--select', '蓝']), {
    command: 'answer', positional: ['session-fixture'], options: { select: '蓝' }, asJson: true,
  })
  assert.deepEqual(parseCommand(['answer', 'session-fixture', '自定义文字', '--select', '蓝', '--json']), {
    command: 'answer', positional: ['session-fixture', '自定义文字'], options: { select: '蓝' }, asJson: true,
  })
})
