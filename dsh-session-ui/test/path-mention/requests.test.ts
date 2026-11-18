import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchResolved, openOnHost, openWithApp } from '../../src/client/path-mention/requests.ts'

test('回复中的路径在网页子目录和桌面协议下都发给当前宿主', async (t) => {
  const calls: Array<{ url: string; method: string | undefined; body: unknown }> = []
  const directory = { kind: 'directory', path: '/example/project folder' } as const
  const file = { kind: 'file', path: `${directory.path}/notes.md`, line: 4 } as const
  const results = { 'notes.md': { kind: 'file', path: file.path } }
  for (const base of ['https://example.com/tool/', 'dsh-app://app/']) {
    const fetcher = t.mock.method(globalThis, 'fetch', async (input: string | URL, options: RequestInit) => {
      calls.push({ url: new URL(input, base).href, method: options.method, body: JSON.parse(String(options.body)) })
      return Response.json({ results })
    })
    assert.deepEqual(await fetchResolved(directory.path, ['notes.md']), results)
    openOnHost(file.path, 'reveal')
    assert.equal(await openWithApp(directory, 'zed'), true)
    assert.equal(await openWithApp(file, 'terminal'), true)
    assert.deepEqual(calls.splice(0), [
      { url: `${base}dsh-path-mention/resolve`, method: 'POST', body: { cwd: directory.path, tokens: ['notes.md'] } },
      { url: `${base}dsh-path-mention/open`, method: 'POST', body: { path: file.path, action: 'reveal' } },
      { url: `${base}open-in-app/open`, method: 'POST', body: { path: directory.path, app: 'zed' } },
      { url: `${base}dsh-path-mention/open-with`, method: 'POST', body: { path: file.path, app: 'terminal' } },
    ])
    fetcher.mock.restore()
  }
})

test('宿主拒绝或未返回打开结果时结束这次请求', async (t) => {
  const target = { kind: 'directory', path: '/example/project' } as const
  const fetcher = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 403 }))
  assert.equal(await openWithApp(target, 'zed'), false)
  fetcher.mock.mockImplementation(async () => { throw new Error('connection closed') })
  assert.equal(await openWithApp(target, 'zed'), false)
  assert.equal(fetcher.mock.callCount(), 2)
})
