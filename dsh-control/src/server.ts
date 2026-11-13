/**
 * 本机通信口：`$DSH_HOME/dsh-control/dsh.sock` 上的普通 HTTP。
 *
 * - 目录权限 0700、socket 0600：只有同一个系统账户的程序连得上。能连上它的程序本来就能改 `~/.dsh`
 *   里的一切，所以同机不另设令牌。
 * - `GET  /v1/health`    在不在线（不调任何内部接口，DSH 卡住时也能答）
 * - `GET  /v1/commands`  命令表
 * - `POST /v1/run`       `{ command, args, options }` → `{ ok, text, data, status }` 或 `{ ok:false, error }`
 *
 * @module
 */
import { chmodSync, existsSync, linkSync, mkdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { basename, dirname, join } from 'node:path'
import { errorPayload, UsageError } from './gateway.ts'
import type { CommandResult } from './service.ts'

export interface CommandSpec {
  name: string
  summary: string
  usage: string
  /** 会不会改东西（只读模式下拒绝）。 */
  writes: boolean
}

export type Runner = (command: string, args: string[], options: Record<string, unknown>, signal: AbortSignal) => Promise<CommandResult>

export interface ServerOptions {
  socketPath: string
  commands: () => CommandSpec[]
  run: Runner
  info: () => Record<string, unknown>
  log: (line: string) => void
  /** 多久看一次通信口文件还在不在（默认 5 秒）；测试用来缩短。 */
  watchMs?: number
}

const MAX_BODY = 4 * 1024 * 1024

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY) throw new UsageError('请求体太大（上限 4 MiB）')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new UsageError('请求体不是 JSON')
  }
}

export function prepareSocketPath(socketPath: string): void {
  const dir = dirname(socketPath)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  if (existsSync(socketPath)) {
    const st = statSync(socketPath)
    if (!st.isSocket()) throw new Error(`${socketPath} 已存在且不是 socket，不敢删`)
    rmSync(socketPath)
  }
}

export async function startServer(options: ServerOptions): Promise<{ close(): Promise<void> }> {
  prepareSocketPath(options.socketPath)
  const inflight = new Set<AbortController>()
  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    void handle(req, res).catch((error: unknown) => {
      if (!res.headersSent) send(res, error instanceof UsageError ? 400 : 500, { ok: false, error: errorPayload(error) })
      else res.destroy()
    })
  }
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://dsh')
    if (req.method === 'GET' && url.pathname === '/v1/health') {
      send(res, 200, { ...options.info(), ok: true, tool: 'dsh-control', protocol: 1, features: ['task-outcomes', 'send-receipts', 'settled-wait', 'done-notify'] })
      return
    }
    if (req.method === 'GET' && url.pathname === '/v1/commands') {
      send(res, 200, { ok: true, commands: options.commands() })
      return
    }
    if (req.method === 'POST' && url.pathname === '/v1/run') {
      const body = await readBody(req) as { command?: unknown; args?: unknown; options?: unknown }
      const command = typeof body.command === 'string' ? body.command : ''
      const args = Array.isArray(body.args) ? body.args.map(String) : []
      const opts = typeof body.options === 'object' && body.options !== null ? body.options as Record<string, unknown> : {}
      const controller = new AbortController()
      inflight.add(controller)
      res.on('close', () => { if (!res.writableFinished) controller.abort() })
      const started = Date.now()
      try {
        const result = await options.run(command, args, opts, controller.signal)
        options.log(`${command} ok ${Date.now() - started}ms`)
        send(res, 200, { ok: true, ...result })
      } catch (error) {
        const payload = errorPayload(error)
        options.log(`${command} failed ${payload.code} ${Date.now() - started}ms`)
        send(res, error instanceof UsageError ? 400 : 500, { ok: false, error: payload })
      } finally {
        inflight.delete(controller)
      }
      return
    }
    send(res, 404, { ok: false, error: { code: 'not-found', message: `${req.method ?? ''} ${url.pathname}` } })
  }
  // Node（libuv）关监听时按绑定时的路径删文件，不管那个路径上现在是谁的。插件热重载或重启时旧实例晚于新实例关闭，
  // 就会把新实例刚建的通信口删掉，之后 dsh-control 一直「找不到通信口」（复盘 I-029）。
  // 所以先绑在只属于这一次的临时名上，再硬链接到正式路径：关监听只删临时名，正式路径按 inode 认是不是自己的再删。
  // 用硬链接而不是改名：正式路径已被别的 socket 占着时链接失败，不会把它顶掉。
  // 临时名和正式文件名一样长：socket 路径有长度上限（macOS 104 字节），正式路径放得下，临时名也必须放得下。
  const tempName = (): string => {
    const size = Math.max(4, basename(options.socketPath).length)
    let name = '.'
    while (name.length < size) name += Math.random().toString(36).slice(2)
    return join(dirname(options.socketPath), name.slice(0, size))
  }
  const listen = async (): Promise<{ server: Server; ino: number }> => {
    const temp = tempName()
    const server = createServer(onRequest)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(temp, () => {
        server.off('error', reject)
        resolve()
      })
    })
    try {
      chmodSync(temp, 0o600)
      linkSync(temp, options.socketPath)
      return { server, ino: statSync(options.socketPath).ino }
    } catch (error) {
      server.close()
      throw error
    } finally {
      try { unlinkSync(temp) } catch { /* 已经没了 */ }
    }
  }
  const ours = (ino: number): boolean => {
    try { return statSync(options.socketPath).ino === ino } catch { return false }
  }
  let current = await listen()
  const retired: Server[] = []
  writeFileSync(join(dirname(options.socketPath), 'dsh.pid'), `${process.pid}\n`, { mode: 0o600 })
  // 通信口文件被删后进程还开着它，外面却再也连不上（2026-10-19 起，复盘 I-029）。
  // 文件没了就在原路径重新监听；路径上换成了别人的 socket（另一个 DSH、新加载的插件实例）就不抢。
  let rebinding = false
  let closed = false
  const watch = setInterval(() => {
    if (rebinding || existsSync(options.socketPath)) return
    rebinding = true
    Promise.resolve().then(() => {
      mkdirSync(dirname(options.socketPath), { recursive: true, mode: 0o700 })
      chmodSync(dirname(options.socketPath), 0o700)
      return listen()
    }).then((next) => {
      if (closed) { next.server.close(); if (ours(next.ino)) rmSync(options.socketPath); return }
      retired.push(current.server)
      current.server.close()
      current = next
      options.log('socket rebound')
    }, () => { /* 下次再试 */ }).finally(() => { rebinding = false })
  }, options.watchMs ?? 5_000)
  watch.unref()
  return {
    async close() {
      closed = true
      clearInterval(watch)
      for (const c of inflight) c.abort()
      await Promise.all([...new Set([...retired, current.server])].map((server) => new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })))
      if (ours(current.ino)) {
        try { rmSync(options.socketPath) } catch { /* 已经没了 */ }
      }
    },
  }
}
