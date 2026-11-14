/**
 * dsh-path-mention 宿主半：两条同源 HTTP 路由。
 *
 *   POST /dsh-path-mention/resolve  {cwd, tokens} → {results}：哪些片段在本机真实存在
 *   POST /dsh-path-mention/open      {path, action} → 在本机打开：action 是 open（目录用默认程序打开）、reveal（在访达中显示）
 *   POST /dsh-path-mention/open-with {path, app}    → 用宿主头栏菜单清单里的某个应用打开（见 src/apps.ts）
 *
 * 左键点目录走这里：宿主侧栏只预览文件，工作区外的目录会报错。右键菜单的打开方式用宿主的会话接口，
 * 只有宿主接口不在时才退回这里。只接受真实存在的绝对路径，动作是固定的两种，不执行任意程序。
 *
 * @module dsh-path-mention
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { appOpenCommand } from './apps.ts'
import { createResolver, findFd } from './resolve.ts'
import { MAX_TOKENS, OPEN_PATH, OPEN_WITH_PATH, RESOLVE_PATH } from '../../shared/path-mention/token.ts'

export const name = 'dsh-path-mention'

export type OpenAction = 'open' | 'reveal'

/**
 * 一个动作对应的命令。只在 macOS 上支持「在访达中显示」；其他系统只支持用默认程序打开目录。
 * @param action - 打开方式。
 * @param path - 已确认存在的绝对路径。
 * @param isDirectory - 路径是不是目录。
 * @returns 命令和参数，不支持时返回 undefined。
 */
export function openCommand(action: OpenAction, path: string, isDirectory: boolean, platform: NodeJS.Platform = process.platform): [string, string[]] | undefined {
  if (platform !== 'darwin') {
    if (action !== 'open' || !isDirectory) return undefined
    return platform === 'win32' ? ['explorer', [path]] : ['xdg-open', [path]]
  }
  if (action === 'reveal') return ['open', ['-R', path]]
  return isDirectory ? ['open', [path]] : undefined
}

const BODY_LIMIT = 256 * 1024

function isSameOrigin(req: IncomingMessage): boolean {
  const raw = req.headers['sec-fetch-site']
  const value = Array.isArray(raw) ? raw[0] : raw
  return value === undefined || value === '' || value === 'same-origin' || value === 'none'
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((done, fail) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > BODY_LIMIT) {
        req.destroy()
        fail(new Error('request body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        done(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        fail(error)
      }
    })
    req.on('error', fail)
  })
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}


/** 只认真实存在的绝对路径。 */
function existingPath(value: unknown): string | undefined {
  return typeof value === 'string' && isAbsolute(value) && existsSync(value) ? value : undefined
}

export function applyPathMention(ctx: Context): void {
  const logger = ctx.logger(name)
  const fd = findFd()
  if (fd === undefined) logger.warn('没找到 fd：只认原样存在的路径，带省略号或只写文件名的路径不会被找到')
  else logger.info(`已加载，用 ${fd} 搜索路径`)
  const resolver = createResolver({ fd })

  const launch = (command: [string, string[]], path: string): void => {
    const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' })
    child.on('error', (error) => logger.warn(`打开 ${path} 失败：${error.message}`))
    child.unref()
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: RESOLVE_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST' || !isSameOrigin(req)) return send(res, 403, { error: 'forbidden' })
        try {
          const body = await readJson(req) as { cwd?: unknown; tokens?: unknown }
          const cwd = typeof body.cwd === 'string' && isAbsolute(body.cwd) ? body.cwd : undefined
          const tokens = Array.isArray(body.tokens) ? body.tokens.filter((t): t is string => typeof t === 'string').slice(0, MAX_TOKENS) : []
          send(res, 200, { results: await resolver.resolve(cwd, tokens) })
        } catch (error) {
          send(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'path-mention: resolve route')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: OPEN_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST' || !isSameOrigin(req)) return send(res, 403, { error: 'forbidden' })
        try {
          const body = await readJson(req) as { path?: unknown; action?: unknown }
          const path = existingPath(body.path)
          if (path === undefined) return send(res, 400, { error: 'path does not exist' })
          const action = body.action === undefined ? 'open' : body.action
          if (action !== 'open' && action !== 'reveal') return send(res, 400, { error: 'unknown action' })
          const command = openCommand(action, path, (await stat(path)).isDirectory())
          if (command === undefined) return send(res, 400, { error: 'unsupported action for this path' })
          launch(command, path)
          send(res, 200, { ok: true })
        } catch (error) {
          send(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'path-mention: open route')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: OPEN_WITH_PATH,
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        if (req.method !== 'POST' || !isSameOrigin(req)) return send(res, 403, { error: 'forbidden' })
        try {
          const body = await readJson(req) as { path?: unknown; app?: unknown }
          const path = existingPath(body.path)
          if (path === undefined) return send(res, 400, { error: 'path does not exist' })
          if (typeof body.app !== 'string') return send(res, 400, { error: 'app must be a string' })
          const command = appOpenCommand(body.app, path, (await stat(path)).isDirectory())
          if (command === undefined) return send(res, 400, { error: `app not available: ${body.app}` })
          launch(command, path)
          send(res, 200, { ok: true })
        } catch (error) {
          send(res, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      },
    }), 'path-mention: open-with route')
  })
}