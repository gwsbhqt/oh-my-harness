import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { applyPathMention } from '../../src/host/path-mention/index.ts'
import { OPEN_PATH, OPEN_WITH_PATH, RESOLVE_PATH } from '../../src/shared/path-mention/token.ts'

test('路径路由遵循宿主授权，接受已授权的网页和桌面请求', async (t) => {
  type Route = { path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }
  const handlers = new Map<string, Route['handler']>()
  let rejection: 401 | 403 | undefined
  const connection = { requestRejection: t.mock.fn(() => rejection) }
  const ctx = {
    logger: () => ({ info() {}, warn() {} }),
    inject(names: string[], install: (ctx: unknown) => void) {
      assert.deepEqual(names, ['webServer', 'connection'])
      install({
        get: (name: string) => { assert.equal(name, 'connection'); return connection },
        effect: (effect: () => unknown) => effect(),
        webServer: { register: (route: Route) => handlers.set(route.path, route.handler) },
      })
    },
  }
  applyPathMention(ctx as unknown as Context)
  const server = createServer((req, res) => {
    const handler = handlers.get(req.url ?? '')
    if (handler !== undefined) void handler(req, res)
    else res.writeHead(404).end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const dir = await mkdtemp(join(tmpdir(), 'path-mention-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(join(dir, 'notes.md'), 'example')
  const post = (path: string, extraHeaders?: Record<string, string>) => fetch(`http://127.0.0.1:${address.port}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify({ cwd: dir, tokens: ['notes.md'] }),
  })

  for (const denied of [401, 403] as const) {
    rejection = denied
    for (const path of [RESOLVE_PATH, OPEN_PATH, OPEN_WITH_PATH]) {
      const response = await post(path)
      assert.equal(response.status, denied)
      assert.deepEqual(await response.json(), { error: 'forbidden' })
    }
  }
  rejection = undefined
  for (const headers of [undefined, { 'sec-fetch-site': 'same-origin' }]) {
    const response = await post(RESOLVE_PATH, headers)
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { results: { 'notes.md': { path: join(dir, 'notes.md'), kind: 'file' } } })
  }
  assert.equal((await post(RESOLVE_PATH, { 'sec-fetch-site': 'same-site' })).status, 403)
  assert.equal(connection.requestRejection.mock.callCount(), 9)
})
