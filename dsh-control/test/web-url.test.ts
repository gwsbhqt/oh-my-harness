import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateCommand } from '../src/commands.ts'
import { CommandFailure, UsageError } from '../src/gateway.ts'
import { RemoteService, type Deps } from '../src/service.ts'

function service(webUrl?: Deps['webUrl']): RemoteService {
  const forbidden = () => { throw new Error('取网址不许调用宿主或历史') }
  const deps: Deps = {
    gateway: { invoke: async () => forbidden(), stream: async () => forbidden() },
    typert: { list: forbidden, get: forbidden },
    query: { readSession: async () => forbidden() },
    usage: async () => forbidden(), onStatus: () => () => {},
    config: () => ({ readOnly: true, denyNamespaces: [], tiers: { normal: [], fast: [] }, reservePercent: 10, waitSliceMs: 0 }),
    log: forbidden,
    ...(webUrl === undefined ? {} : { webUrl }),
  }
  return new RemoteService(deps)
}

test('web-url 把 --base 原样交给宿主加口令，不给就用本机端口', () => {
  const seen: (string | undefined)[] = []
  const s = service((base) => { seen.push(base); return `${base ?? 'http://127.0.0.1:3080'}/?token=abc` })
  assert.equal(s.webUrl().data && (s.webUrl().data as { url: string }).url, 'http://127.0.0.1:3080/?token=abc')
  assert.equal((s.webUrl('http://127.0.0.1:13080').data as { url: string }).url, 'http://127.0.0.1:13080/?token=abc')
  assert.deepEqual(seen, [undefined, undefined, 'http://127.0.0.1:13080'])
})

test('web-url 拒绝不是 http(s) 的 --base，网页服务没起来或宿主不支持时报失败', () => {
  const s = service(() => 'http://x/?token=abc')
  assert.throws(() => s.webUrl('127.0.0.1:13080'), UsageError)
  assert.throws(() => s.webUrl('file:///etc/passwd'), UsageError)
  assert.throws(() => service(() => undefined).webUrl(), (e: unknown) => e instanceof CommandFailure && e.code === 'web-unavailable')
  assert.throws(() => service().webUrl(), (e: unknown) => e instanceof CommandFailure && e.code === 'web-url-unsupported')
})

test('web-url 只收 --base，不收位置参数', () => {
  validateCommand('web-url', [], { base: 'http://127.0.0.1:13080' })
  assert.throws(() => validateCommand('web-url', ['x'], {}))
  assert.throws(() => validateCommand('web-url', [], { port: '1' }))
})
