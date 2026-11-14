import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'

test('子代理目录加载失败时保留宿主的错误和重试入口', async () => {
  const dir = await mkdtemp(join(dirname(fileURLToPath(import.meta.url)), '.catalog-test-'))
  try {
    const source = await readFile(new URL('../../src/client/hide-finished/index.tsx', import.meta.url), 'utf8')
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX } }).outputText
      .replace('./filter.ts', '../../../src/client/hide-finished/filter.ts').replace('./ids.ts', '../../../src/client/hide-finished/ids.ts')
    const target = join(dir, 'client.mjs')
    await writeFile(target, compiled)
    const plugin = await import(pathToFileURL(target).href) as { apply: (ctx: unknown) => void }
    const Host = () => null
    const entries: Array<{ options: { id?: string; name: string }; component: unknown; inject?: unknown }> = [
      { options: { id: 'subagent-catalog', name: 'conversation.session.header.actions' }, component: Host },
    ]
    plugin.apply({ slots: {
      entries: (slot: string) => entries.filter(entry => entry.options.name === slot),
      inject: (_slot: string, register: () => unknown) => register(),
      register: (options: { id?: string; name: string }, component: unknown) => { entries.push({ options, component }); return () => {} },
    } })
    const component = entries.find(entry => entry.options.id === 'subagent-catalog' && entry.component !== Host)?.component as ((props: unknown) => { type: unknown; props: { useSessions: (selector: (state: typeof sessions) => unknown) => unknown; refreshProjection: unknown } } | null)
    assert.ok(component)
    const error = { message: '目录加载失败' }
    const sessions = { byId: {}, projectionsBySession: { root: { state: 'error', error, values: {} } } }
    const refreshProjection = () => {}
    const result = component({ sessionId: 'root', useSessions: (select: (state: typeof sessions) => unknown) => select(sessions), useSessionStatus: (select: (state: Map<string, never>) => unknown) => select(new Map<string, never>()), refreshProjection })
    assert.ok(result, '目录报错时不能隐藏宿主组件')
    assert.equal(result.type, Host)
    assert.equal(result.props.useSessions(state => state.projectionsBySession.root.error), error)
    assert.equal(result.props.refreshProjection, refreshProjection)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
