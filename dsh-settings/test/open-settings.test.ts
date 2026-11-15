/**
 * 「编辑快捷回复…」靠设置外壳没公开的 openSection 打开设置页（见 src/client/open-settings.ts）。
 * 这里对着两份宿主核对它还在：开发依赖里的 ui-settings-general，以及本机 App 自带的那份。
 * App 自己会更新，开发依赖没跟上时只有后者能查出来。没有 App 时跳过并说明。
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { openSettingsSection } from '../src/client/quick-reply/open-settings.ts'

test('拿到共享状态句柄就调 openSection 并返回 true', () => {
  const calls: string[] = []
  const instance = { actions: { openSection: (id: string) => calls.push(id) } }
  const slots = { entries: () => [{}, { store: { create: () => instance } }] }
  assert.equal(openSettingsSection(slots, 'quick-reply'), true)
  assert.deepEqual(calls, ['quick-reply'])
})

test('句柄每次新建实例（调了也没人显示）、没有 openSection、没有登记：都不调、返回 false', () => {
  let calls = 0
  const fresh = { entries: () => [{ store: { create: () => ({ actions: { openSection: () => { calls += 1 } } }) } }] }
  assert.equal(openSettingsSection(fresh, 'x'), false)
  assert.equal(calls, 0)
  const shared = { actions: {} }
  assert.equal(openSettingsSection({ entries: () => [{ store: { create: () => shared } }] }, 'x'), false)
  assert.equal(openSettingsSection({ entries: () => [] }, 'x'), false)
  assert.equal(openSettingsSection({ entries: () => { throw new Error('undeclared') } }, 'x'), false)
})

const APP_ASAR = process.env['DSH_APP_ASAR'] ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

interface AsarEntry { files?: Record<string, AsarEntry>; size?: number; offset?: string; unpacked?: boolean }

function readAsarFile(archive: string, path: readonly string[]): string {
  const buf = readFileSync(archive)
  const headerPickleSize = buf.readUInt32LE(4)
  const jsonLength = buf.readUInt32LE(12)
  let node = JSON.parse(buf.subarray(16, 16 + jsonLength).toString('utf8')) as AsarEntry
  for (const part of path) {
    const next = node.files?.[part]
    assert.ok(next !== undefined, `${path.join('/')} 不在 ${archive} 里`)
    node = next
  }
  if (node.unpacked === true) return readFileSync(join(`${archive}.unpacked`, ...path), 'utf8')
  const start = 8 + headerPickleSize + Number(node.offset)
  return buf.subarray(start, start + node.size!).toString('utf8')
}

/**
 * App 0.2.2-rc.2 起自带的宿主产物去掉了空白、普通字符串改用反引号、单参数箭头函数去掉括号；开发依赖仍是排版过的。
 * 两份宿主先压成同一种写法再比，断言只认代码结构，不认排版。
 */
function compact(code: string): string {
  return code
    .replaceAll('`', '"')
    .replace(/\s+/g, (gap: string, at: number, all: string) => /[\w$]/.test(all[at - 1] ?? '') && /[\w$]/.test(all[at + gap.length] ?? '') ? ' ' : '')
    .replace(/\(([\w$]+)\)=>/g, '$1=>')
    .replace(/[;,]([}\])])/g, '$1')
}

/** 宿主设置外壳仍然：状态里有 openSection；登记 sidebar.settings 时带的是 create 永远返回同一实例的共享句柄。 */
function assertShellShape(source: string, label: string): void {
  const code = compact(source)
  assert.ok(code.includes('openSection:(d,id)=>{d.activeId=id;d.open=true'), `${label}：设置状态里没有 openSection 了`)
  assert.ok(code.includes('create:()=>shellInstance'), `${label}：状态句柄不再共享同一个实例`)
  assert.match(code, /name:"sidebar\.settings",[\s\S]{0,80}store:shellStore/, `${label}：sidebar.settings 不再带这个状态句柄`)
}

test('开发依赖里的设置外壳仍是这个形状', () => {
  const path = join(import.meta.dirname, '..', 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings-general', 'lib', 'client.js')
  assertShellShape(readFileSync(path, 'utf8'), '开发依赖')
})

test('本机 App 自带的设置外壳仍是这个形状', { skip: existsSync(APP_ASAR) ? false : `没有找到 App：${APP_ASAR}` }, () => {
  const code = readAsarFile(APP_ASAR, ['dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-settings-general', 'lib', 'client.js'])
  assertShellShape(code, 'App')
})
