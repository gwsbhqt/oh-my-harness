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
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
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
  /** 多久看一次通信口文件还在不在；测试用来缩短。 */
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
  const listen = async (): Promise<Server> => {
    const server = createServer(onRequest)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
    chmodSync(options.socketPath, 0o600)
    return server
  }
  let current = await listen()
  const retired: Server[] = []
  writeFileSync(join(dirname(options.socketPath), 'dsh.pid'), `${process.pid}\n`, { mode: 0o600 })
  // 通信口文件被删后进程还开着它，外面却再也连不上，dsh-control 和等空闲重启全断，只能手动重启（2026-10-19 03:01 起，复盘 I-029）。
  // 文件没了就在原路径重新监听；路径上换成了别人的 socket（另一个 DSH）就不抢。
  // 旧监听必须先关：Node 关监听时会删掉绑定路径上的文件，后关会把刚建好的新文件删掉。
  let rebinding = false
  let closed = false
  const watch = setInterval(() => {
    if (rebinding || existsSync(options.socketPath)) return
    rebinding = true
    Promise.resolve().then(() => {
      if (!retired.includes(current)) { retired.push(current); current.close() }
      prepareSocketPath(options.socketPath)
      return listen()
    }).then((next) => {
      if (closed) { next.close(); return }
      current = next
      options.log('socket rebound')
    }, () => { /* 下次再试 */ }).finally(() => { rebinding = false })
  }, options.watchMs ?? 30_000)
  watch.unref()
  return {
    async close() {
      closed = true
      clearInterval(watch)
      for (const c of inflight) c.abort()
      await Promise.all([...new Set([...retired, current])].map((server) => new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })))
      try { rmSync(options.socketPath) } catch { /* 已经没了 */ }
    },
  }
}
