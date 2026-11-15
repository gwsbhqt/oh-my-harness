/**
 * dsh-settings 形状门。
 *
 * 守四件事：
 * 1. 宿主半边导出 `name` + `apply`（loader 条目能激活），Config 只有 `quickReply` 开关（volatile）。
 * 2. 客户端半边导出 `apply` + `inject`：没有 apply 就是 invalid plugin，整页停在 "Failed to load plugins"。
 * 3. 客户端产物只 require 平台模块表里的包，不许引私有服务或额外库。
 * 4. package.json 的 `dsh.client` / `dsh.bundle.patch` / `exports["./client"]` / `files` 四处齐全。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PLATFORM = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives']

test('宿主半导出 name / apply / Config；主配置里只剩 quickReply 开关', async () => {
  const host = await import(join(root, 'lib/index.js')) as { name?: unknown; apply?: unknown; Config?: (value: unknown) => Record<string, unknown> }
  assert.equal(host.name, 'dsh-settings')
  assert.equal(typeof host.apply, 'function')
  const read = (cell: unknown) => (cell as { get(): unknown }).get()
  const config = host.Config!({})
  assert.equal(read(config['quickReply']), true)
  assert.equal(config['presets'], undefined)
  assert.equal(config['action'], undefined)
})

test('客户端产物注册到模块表、导出 apply 和 inject，只 require 平台模块', () => {
  const code = readFileSync(join(root, 'lib/client.js'), 'utf8')
  const required: string[] = []
  let registered: { id: string; exports: Record<string, unknown> } | undefined
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load({ id, factory }: { id: string; factory: (require: (name: string) => unknown) => Record<string, unknown> }) {
          const exports = factory((name) => { required.push(name); return new Proxy(() => {}, { get: () => () => {} }) })
          registered = { id, exports }
        },
      },
    },
  }
  vm.runInNewContext(code, sandbox)
  assert.equal(registered?.id, 'dsh-settings')
  assert.equal(typeof registered?.exports['apply'], 'function')
  assert.deepEqual([...registered!.exports['inject'] as string[]], ['slots', 'locale', 'configForms', 'sessions', 'connection'])
  assert.deepEqual(required.filter(name => !PLATFORM.includes(name)), [])
})

test('package.json 的 dsh.client、dsh.bundle.patch、exports["./client"]、files 与客户端产物同在', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    dsh?: { client?: { platform?: string }; bundle?: { patch?: string } }
    exports?: Record<string, unknown>
    files?: string[]
  }
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
  assert.equal(pkg.exports?.['./client'], './lib/client.js')
  assert.ok(pkg.files?.includes('lib/*.js'))
})
