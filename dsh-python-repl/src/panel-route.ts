import type { IncomingMessage, ServerResponse } from 'node:http'
import { PANEL_STATE_PATH, PANEL_PREVIEW_PATH, PANEL_CONTROL_PATH, PANEL_CONTROL_ACTIONS, PANEL_NAME_PATH, PANEL_NAME_ACTIONS, type PanelNameAction, type PanelNameResult, type PanelState, type PanelPreview, type PanelPreviewRequest, type PanelControlAction, type PanelControlResult } from './panel-types.ts'

export interface PanelWebServer {
  register(route: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
}

/** Click-only exact-name preview with the same read boundary as the state route. */
export function previewRoute(readPreview: (request: PanelPreviewRequest) => Promise<PanelPreview>): Parameters<PanelWebServer['register']>[0] {
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    if (res.destroyed || res.writableEnded) return
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(Buffer.byteLength(text, 'utf8') <= 64 * 1024 ? text : JSON.stringify({ status: 'error', reason: '预览超过大小限制' }))
  }
  return { kind: 'exact', path: PANEL_PREVIEW_PATH, handler: (req, res) => {
    const raw = req.headers['sec-fetch-site']
    const site = Array.isArray(raw) ? raw[0] : raw
    const origin = req.headers.origin
    let foreignOrigin = false
    if (origin !== undefined) {
      try {
        const protocol = (req.socket as { encrypted?: boolean }).encrypted === true ? 'https:' : 'http:'
        foreignOrigin = new URL(origin).origin !== `${protocol}//${req.headers.host}`
      } catch { foreignOrigin = true }
    }
    if (req.method !== 'GET' || foreignOrigin || ![undefined, '', 'same-origin', 'none'].includes(site)) {
      send(res, 403, { error: 'forbidden' }); return
    }
    const params = new URL(req.url ?? '/', 'http://local').searchParams
    const session = params.get('session')
    const name = params.get('name')
    const rawEpoch = params.get('epoch')
    const epoch = rawEpoch === null || !/^(0|[1-9]\d*)$/.test(rawEpoch) ? NaN : Number(rawEpoch)
    if (!session || session.length > 4096 || !name || name.length > 256 || !Number.isSafeInteger(epoch)
      || !/^[_\p{ID_Start}][_\p{ID_Continue}]*$/u.test(name)) {
      send(res, 400, { error: 'session, an exact top-level name, and a nonnegative epoch are required' }); return
    }
    void readPreview({ session, name, epoch }).then((value) => send(res, 200, value), () => {
      send(res, 500, { status: 'error', reason: '读取预览失败' })
    })
  } }
}

/**
 * The only route that changes anything: start/stop/restart/reset one session's
 * kernel. POST only. A direct browser must send this server as its Origin so
 * another site cannot drive it from a link or form; the desktop shell strips
 * Origin when it forwards the page's requests, so an Origin-less POST is
 * accepted too (a browser on another site always sends one).
 */
export function controlRoute(control: (session: string, action: PanelControlAction) => Promise<PanelControlResult>): Parameters<PanelWebServer['register']>[0] {
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    if (res.destroyed || res.writableEnded) return
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  return { kind: 'exact', path: PANEL_CONTROL_PATH, handler: (req, res) => {
    if (!sameOriginPost(req)) {
      send(res, 403, { error: 'forbidden' }); return
    }
    const params = new URL(req.url ?? '/', 'http://local').searchParams
    const session = params.get('session')
    const action = params.get('action')
    if (!session || session.length > 4096 || !(PANEL_CONTROL_ACTIONS as readonly string[]).includes(action ?? '')) {
      send(res, 400, { error: 'session and an action of start, stop, restart or reset are required' }); return
    }
    void control(session, action as PanelControlAction).then((result) => send(res, 200, result), (error: unknown) => {
      send(res, 500, { action, ok: false, epoch: 0, reason: error instanceof Error ? error.message : String(error) })
    })
  } }
}

/** Same guard as controlRoute, for pin/unpin/unarchive/archive of one exact top-level name. */
export function nameRoute(act: (session: string, action: PanelNameAction, name: string) => Promise<PanelNameResult>): Parameters<PanelWebServer['register']>[0] {
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    if (res.destroyed || res.writableEnded) return
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  return { kind: 'exact', path: PANEL_NAME_PATH, handler: (req, res) => {
    if (!sameOriginPost(req)) { send(res, 403, { error: 'forbidden' }); return }
    const params = new URL(req.url ?? '/', 'http://local').searchParams
    const session = params.get('session')
    const action = params.get('action')
    const name = params.get('name')
    if (!session || session.length > 4096 || !(PANEL_NAME_ACTIONS as readonly string[]).includes(action ?? '')
      || !name || name.length > 256 || !/^[\p{ID_Start}][\p{ID_Continue}]*$/u.test(name)) {
      send(res, 400, { error: 'session, an action of keep, unkeep, unarchive or archive, and an exact top-level name are required' }); return
    }
    void act(session, action as PanelNameAction, name).then((result) => send(res, 200, result), (error: unknown) => {
      send(res, 500, { action, name, ok: false, reason: error instanceof Error ? error.message : String(error) })
    })
  } }
}

/**
 * POST from this page: a direct same-origin browser (Origin equals Host) or the desktop
 * shell, which authenticates the renderer then forwards through its proxy after stripping
 * Origin, Host and Sec-Fetch-Site. A missing Origin is therefore trusted, but any Origin
 * that is present must still equal this server, and cross-site Fetch Metadata is refused,
 * so a browser on another site cannot drive the route.
 */
function sameOriginPost(req: IncomingMessage): boolean {
  const raw = req.headers['sec-fetch-site']
  const site = Array.isArray(raw) ? raw[0] : raw
  if (req.method !== 'POST' || ![undefined, '', 'same-origin'].includes(site)) return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    const protocol = (req.socket as { encrypted?: boolean }).encrypted === true ? 'https:' : 'http:'
    return new URL(origin).origin === `${protocol}//${req.headers.host}`
  } catch { return false }
}

/** Same Fetch Metadata boundary as other read-only routes. No write or execution route. */
export function panelRoute(readState: (session: string) => Promise<PanelState>): Parameters<PanelWebServer['register']>[0] {
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  return { kind: 'exact', path: PANEL_STATE_PATH, handler: (req, res) => {
    const raw = req.headers['sec-fetch-site']
    const site = Array.isArray(raw) ? raw[0] : raw
    if (req.method !== 'GET' || ![undefined, '', 'same-origin', 'none'].includes(site)) {
      send(res, 403, { error: 'forbidden' }); return
    }
    const session = new URL(req.url ?? '/', 'http://local').searchParams.get('session')
    if (session === null || session === '' || session.length > 4096) {
      send(res, 400, { error: 'session is required and must not exceed 4096 characters' }); return
    }
    void readState(session).then((state) => send(res, 200, state), (error: unknown) => {
      send(res, 500, { error: error instanceof Error ? error.message : String(error) })
    })
  } }
}
