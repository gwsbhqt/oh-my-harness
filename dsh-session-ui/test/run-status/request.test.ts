import { strict as assert } from 'node:assert'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { fetchRunStatus } from '../../src/client/run-status/request.ts'
import { applyRunStatus } from '../../src/host/run-status/index.ts'
import { STATE_PATH } from '../../src/shared/run-status/types.ts'

test('运行状态和网关速率从当前挂载位置请求，沿用宿主的允许与拒绝结果', async (t) => {
  let rejection: 401 | 403 | undefined
  let checked = 0
  let handler: ((req: IncomingMessage, res: ServerResponse) => Promise<void>) | undefined
  const scope = {
    effect: (fn: () => unknown) => fn(),
    get: () => ({ requestRejection: () => { checked++; return rejection } }),
    webServer: { register(route: { path: string; handler: NonNullable<typeof handler> }) {
      assert.equal(route.path, STATE_PATH)
      handler = route.handler
    } },
  }
  const ctx = {
    on() {}, effect: scope.effect, logger: () => ({ info() {}, warn() {} }),
    get: () => ({ resolve() { throw new Error('test gateway offline') } }),
    inject(services: string[], fn: (scope: unknown) => unknown) {
      if (services.includes('webServer')) {
        assert.ok(services.includes('connection'))
        fn(scope)
      }
    },
  }
  applyRunStatus(ctx as unknown as Context, { magpieBaseUrl: () => 'https://gateway.invalid/v1', magpieKeyRef: () => 'TEST_KEY' })
  assert.ok(handler)
  const serve = handler
  const seen: URL[] = []
  const server = createServer((req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`)
    seen.push(url)
    if (url.pathname !== STATE_PATH && url.pathname !== '/mount/nested' + STATE_PATH) {
      res.writeHead(404).end()
      return
    }
    req.url = STATE_PATH + url.search
    void serve(req, res)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const id = 'example session & second'
  for (const mount of ['/', '/mount/nested/']) {
    for (const view of [undefined, 'magpie'] as const) {
      const response = await fetchRunStatus(origin + mount, id, view)
      assert.equal(response.status, 200)
      const payload = await response.json()
      if (view) assert.deepEqual(payload, { state: 'unavailable' })
      else assert.equal(payload.sessionId, id)
      const received = seen.at(-1)!
      assert.equal(received.origin, origin)
      assert.equal(received.pathname, mount + STATE_PATH.slice(1))
      assert.equal(received.searchParams.get('session'), id)
      assert.equal(received.searchParams.get('view'), view ?? null)
    }
  }
  for (const status of [401, 403] as const) {
    rejection = status
    for (const view of [undefined, 'magpie'] as const) {
      const response = await fetchRunStatus(origin + '/', id, view)
      assert.equal(response.status, status)
      assert.equal(await response.text(), '')
    }
  }
  assert.equal(checked, 8)
})

test('桌面应用的两个视图保留 dsh-app 协议与宿主名', async (t) => {
  const requests: URL[] = []
  t.mock.method(globalThis, 'fetch', async (input: URL, options: RequestInit) => {
    requests.push(input)
    assert.equal(options.mode, 'same-origin')
    return new Response('{}')
  })
  await fetchRunStatus('dsh-app://app/', 'example')
  await fetchRunStatus('dsh-app://app/', 'example', 'magpie')
  assert.deepEqual(requests.map(url => url.href), [
    'dsh-app://app/dsh-run-status/state?session=example',
    'dsh-app://app/dsh-run-status/state?session=example&view=magpie',
  ])
})
