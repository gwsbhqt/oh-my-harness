import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopNotifications, findTerminalNotifier, sendDesktopNotification, showSystemNotification, type DesktopNotification } from '../src/desktop-notifications.ts'
import { receiveDesktopNotifications } from '../src/client/desktop-notifications.ts'

const request = () => new Request('http://localhost/api/dsh-use.desktop-notification-stream')
const ack = (id: string, status: string, error?: string) => new Request('http://localhost/api/dsh-use.desktop-notification-ack', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, status, error }),
})

test('桌面客户端接收消息并在通知显示后回执；普通浏览器不接收', async () => {
  const originals = new Map(['location', 'EventSource', 'Notification', 'fetch'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const bridge = new DesktopNotifications(500)
  const reader = bridge.stream(request()).body!.getReader()
  await reader.read()
  let listener: ((event: { data: string }) => void) | undefined
  let closed = false
  const shown: unknown[] = []
  class FakeSource {
    onmessage?: (event: { data: string }) => void
    constructor() { Object.defineProperty(this, 'onmessage', { set(value) { listener = value } }) }
    close() { closed = true }
  }
  class FakeNotification {
    static permission = 'granted'
    onshow?: () => void
    onerror?: () => void
    onclose?: () => void
    constructor(title: string, options: unknown) { shown.push({ title, options }); queueMicrotask(() => this.onshow?.()) }
  }
  try {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'dsh-app:', hostname: 'app' } })
    Object.defineProperty(globalThis, 'EventSource', { configurable: true, value: FakeSource })
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: FakeNotification })
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (_url: string, init: RequestInit) => bridge.acknowledge(new Request('http://localhost/ack', init)) })
    const dispose = receiveDesktopNotifications()
    const sent = bridge.show('标题', '正文')
    const wire = new TextDecoder().decode((await reader.read()).value)
    listener?.({ data: wire.slice(6).trim() })
    await sent
    assert.deepEqual(shown, [{ title: '标题', options: { body: '正文', silent: true } }])
    dispose()
    assert.equal(closed, true)
    Object.defineProperty(globalThis, 'location', { configurable: true, value: { protocol: 'http:', hostname: 'localhost' } })
    listener = undefined
    receiveDesktopNotifications()()
    assert.equal(listener, undefined)
  } finally {
    await reader.cancel()
    for (const [key, descriptor] of originals) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, descriptor)
    }
  }
})

test('桌面流投递 Unicode 内容并等待显示回执；每条只完成一次', async () => {
  const bridge = new DesktopNotifications(500)
  const response = bridge.stream(request())
  assert.match(response.headers.get('content-type')!, /text\/event-stream/)
  const reader = response.body!.getReader()
  assert.match(new TextDecoder().decode((await reader.read()).value), /connected/)
  const result = bridge.show('标题 🎉', '第一行\n第二行')
  const text = new TextDecoder().decode((await reader.read()).value)
  const message = JSON.parse(text.slice('data: '.length)) as { id: string; title: string; body: string }
  assert.equal(message.title, '标题 🎉')
  assert.equal(message.body, '第一行\n第二行')
  assert.equal((await bridge.acknowledge(ack(message.id, 'shown'))).status, 204)
  await result
  assert.equal((await bridge.acknowledge(ack(message.id, 'shown'))).status, 404)
  await reader.cancel()
})

test('未连接、显示失败、断线及未确认分别报告，绝不自动重发', async () => {
  const bridge = new DesktopNotifications(20)
  await assert.rejects(bridge.show('无连接', undefined), { code: 'desktop-notification-unavailable' })
  const reader = bridge.stream(request()).body!.getReader()
  await reader.read()
  const failed = bridge.show('拒绝', undefined)
  const message = JSON.parse(new TextDecoder().decode((await reader.read()).value).slice(6)) as { id: string }
  assert.equal((await bridge.acknowledge(ack(message.id, 'failed', '权限被拒绝'))).status, 204)
  await assert.rejects(failed, { code: 'desktop-notification-failed', message: '权限被拒绝' })
  const unknown = bridge.show('超时', undefined)
  await reader.read()
  await assert.rejects(unknown, { code: 'desktop-notification-unknown' })
  const lost = bridge.show('断线', undefined)
  const rejected = assert.rejects(lost, { code: 'desktop-notification-unknown' })
  await reader.read()
  await reader.cancel()
  await rejected
})

test('标题、正文和声音独立组合；纯声音不请求桌面弹窗', async () => {
  for (const title of [undefined, '标题']) for (const body of [undefined, '正文']) for (const sound of [false, true]) {
    if (title === undefined && body === undefined && !sound) continue
    const calls: unknown[] = []
    const input: DesktopNotification = { title, body, sound }
    await sendDesktopNotification({ show: async (t, b) => { calls.push(['show', t, b]) } }, input, 'darwin', async () => { calls.push(['sound']) })
    assert.deepEqual(calls, [
      ...(title !== undefined || body !== undefined ? [['show', title, body]] : []),
      ...(sound ? [['sound']] : []),
    ])
  }
})

test('通知成功后声音失败会说明部分完成，其他系统不会执行', async () => {
  let shown = false
  const bridge = { show: async () => { shown = true } }
  await assert.rejects(sendDesktopNotification(bridge, { title: '标题', body: undefined, sound: true }, 'darwin', async () => { throw new Error('音频失败') }), {
    code: 'desktop-sound-failed', details: { notificationSubmitted: true },
  })
  assert.equal(shown, true)
  shown = false
  await assert.rejects(sendDesktopNotification(bridge, { title: '标题', body: undefined, sound: false }, 'linux'), { code: 'desktop-notification-unsupported' })
  assert.equal(shown, false)
})

test('窗口全关时的提醒：先找 Homebrew 固定位置里的 terminal-notifier，再找 PATH，找不到就是 undefined', () => {
  const have = (paths: string[]) => (path: string) => paths.includes(path)
  assert.equal(findTerminalNotifier('/x/bin', have(['/opt/homebrew/bin/terminal-notifier', '/x/bin/terminal-notifier'])), '/opt/homebrew/bin/terminal-notifier')
  assert.equal(findTerminalNotifier('/x/bin:/y/bin', have(['/y/bin/terminal-notifier'])), '/y/bin/terminal-notifier')
  assert.equal(findTerminalNotifier('', have([])), undefined)
})

test('窗口全关时的提醒：用 terminal-notifier 弹，不走 osascript；没装就报错，非 macOS 什么都不做', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-notifier-'))
  try {
    const fake = join(dir, 'terminal-notifier')
    const record = join(dir, 'args.txt')
    writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${record}'\n`)
    chmodSync(fake, 0o755)
    await showSystemNotification('DSH 在等你回答', '选哪个颜色', 'darwin', fake)
    assert.deepEqual(readFileSync(record, 'utf8').trimEnd().split('\n'), ['-title', 'DSH 在等你回答', '-message', '选哪个颜色', '-sound', 'Glass', '-group', 'dsh-question'])
    await assert.rejects(showSystemNotification('t', 'b', 'darwin', null), /terminal-notifier/)
    await showSystemNotification('t', 'b', 'linux', undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
