import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CommandFailure } from './gateway.ts'

export interface DesktopNotification {
  title: string | undefined
  body: string | undefined
  sound: boolean
}

type Pending = { resolve(): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
type Receiver = { controller: ReadableStreamDefaultController<Uint8Array>; heartbeat: ReturnType<typeof setInterval> }

export class DesktopNotifications {
  private receiver: Receiver | undefined
  private readonly pending = new Map<string, Pending>()
  private readonly encoder = new TextEncoder()

  private readonly timeoutMs: number

  constructor(timeoutMs = 15_000) { this.timeoutMs = timeoutMs }

  private disconnect(receiver: Receiver): void {
    clearInterval(receiver.heartbeat)
    if (this.receiver !== receiver) return
    this.receiver = undefined
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer)
      pending.reject(new CommandFailure('桌面窗口连接中断，通知可能已经发出；不要自动重发', 'desktop-notification-unknown'))
      this.pending.delete(id)
    }
  }

  stream(request: Request): Response {
    let receiver: Receiver | undefined
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (this.receiver !== undefined) {
          const previous = this.receiver
          this.disconnect(previous)
          try { previous.controller.close() } catch { /* 连接可能已关闭 */ }
        }
        receiver = { controller, heartbeat: setInterval(() => {
          try { controller.enqueue(this.encoder.encode(': keepalive\n\n')) } catch { if (receiver) this.disconnect(receiver) }
        }, 25_000) }
        receiver.heartbeat.unref?.()
        this.receiver = receiver
        controller.enqueue(this.encoder.encode(': connected\n\n'))
        request.signal.addEventListener('abort', () => { if (receiver) this.disconnect(receiver) }, { once: true })
      },
      cancel: () => { if (receiver) this.disconnect(receiver) },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform' } })
  }

  async show(title: string | undefined, body: string | undefined): Promise<void> {
    const receiver = this.receiver
    if (receiver === undefined) throw new CommandFailure('DSH 桌面窗口尚未连接，不能发送系统通知', 'desktop-notification-unavailable')
    const id = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new CommandFailure('未收到桌面窗口回执，通知可能已经发出；不要自动重发', 'desktop-notification-unknown'))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        receiver.controller.enqueue(this.encoder.encode(`data: ${JSON.stringify({ id, title: title ?? '', body: body ?? '' })}\n\n`))
      } catch {
        this.disconnect(receiver)
      }
    })
  }

  async acknowledge(request: Request): Promise<Response> {
    let value: unknown
    try { value = await request.json() } catch { return new Response('invalid JSON', { status: 400 }) }
    if (typeof value !== 'object' || value === null) return new Response('invalid acknowledgment', { status: 400 })
    const data = value as Record<string, unknown>
    if (typeof data.id !== 'string' || (data.status !== 'shown' && data.status !== 'failed')) return new Response('invalid acknowledgment', { status: 400 })
    const pending = this.pending.get(data.id)
    if (pending === undefined) return new Response('unknown notification', { status: 404 })
    clearTimeout(pending.timer)
    this.pending.delete(data.id)
    if (data.status === 'shown') pending.resolve()
    else pending.reject(new CommandFailure(typeof data.error === 'string' ? data.error : '桌面窗口无法发送系统通知', 'desktop-notification-failed'))
    return new Response(null, { status: 204 })
  }

  dispose(): void {
    if (this.receiver === undefined) return
    const receiver = this.receiver
    this.disconnect(receiver)
    try { receiver.controller.close() } catch { /* 连接可能已关闭 */ }
  }
}

export async function sendDesktopNotification(
  bridge: Pick<DesktopNotifications, 'show'>,
  notification: DesktopNotification,
  platform = process.platform,
  play = playNotificationSound,
): Promise<void> {
  if (platform !== 'darwin') throw new CommandFailure('系统通知目前只支持 macOS', 'desktop-notification-unsupported')
  const visual = notification.title !== undefined || notification.body !== undefined
  if (visual) await bridge.show(notification.title, notification.body)
  if (notification.sound) {
    try { await play() } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new CommandFailure(`${visual ? '通知已交给 macOS，但' : ''}提示音播放失败：${reason}`, 'desktop-sound-failed', { notificationSubmitted: visual })
    }
  }
}

/** 找 terminal-notifier：DSH 从访达启动时 PATH 里通常没有 Homebrew，先看它的固定位置。 */
export function findTerminalNotifier(pathEnv = process.env.PATH ?? '', exists: (path: string) => boolean = existsSync): string | undefined {
  const candidates = ['/opt/homebrew/bin', '/usr/local/bin', ...pathEnv.split(delimiter).filter((dir) => dir !== '')]
  return candidates.map((dir) => join(dir, 'terminal-notifier')).find(exists)
}

/**
 * 不经桌面窗口，直接让 macOS 弹一条带声音的通知；窗口全关时只有这条路。
 * 用 terminal-notifier 而不是 osascript：后者的通知记在「脚本编辑器」名下，和别的脚本混在一起。
 */
export async function showSystemNotification(title: string, body: string, platform = process.platform, notifier: string | null | undefined = findTerminalNotifier()): Promise<void> {
  if (platform !== 'darwin') return
  if (notifier == null) throw new Error('没装 terminal-notifier（brew install terminal-notifier）')
  await new Promise<void>((resolve, reject) => {
    execFile(notifier, ['-title', title, '-message', body, '-sound', 'Glass', '-group', 'dsh-question'], (error) => error === null ? resolve() : reject(error))
  })
}

export async function playNotificationSound(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile('/usr/bin/afplay', ['/System/Library/Sounds/Glass.aiff'], (error) => error === null ? resolve() : reject(error))
  })
}
