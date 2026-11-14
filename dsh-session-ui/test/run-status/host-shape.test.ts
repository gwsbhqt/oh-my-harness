/**
 * 网页半靠宿主「深度求索中」那一行的结构挂进去。宿主改了属性名、子元素顺序或插槽，
 * 这一段就悄悄不显示，不会报错。所以对着开发依赖和本机 App 自带的宿主各核对一遍。
 */
import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { DOCK_SLOT, STATS_ENTRY_ID, STATS_ENTRY_ORDER, STATS_SLOT } from '../../src/client/run-status/ids.ts'

const require = createRequire(import.meta.url)
const APP_ASAR = process.env.DSH_APP_ASAR ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

interface AsarEntry { files?: Record<string, AsarEntry>; size?: number; offset?: string; unpacked?: boolean }

function readAsarFile(archive: string, path: readonly string[]): string {
  const buf = readFileSync(archive)
  const headerPickleSize = buf.readUInt32LE(4)
  const jsonLength = buf.readUInt32LE(12)
  let node = JSON.parse(buf.subarray(16, 16 + jsonLength).toString('utf8')) as AsarEntry
  for (const part of path) {
    const next = node.files?.[part]
    assert.ok(next !== undefined, `${path.join('/')} not in ${archive}`)
    node = next
  }
  if (node.unpacked === true) return readFileSync(join(`${archive}.unpacked`, ...path), 'utf8')
  assert.ok(node.size !== undefined && node.offset !== undefined)
  const start = 8 + headerPickleSize + Number(node.offset)
  return buf.subarray(start, start + node.size).toString('utf8')
}

const appFile = (pkg: string, ...rest: string[]) => readAsarFile(APP_ASAR, ['dsh', 'node_modules', '@deepseek-ai', pkg, ...rest])

/**
 * 0.2.2-rc.2 起开发依赖和 App 自带的宿主都是压缩产物（去掉空白、字符串改用反引号、单参数箭头函数去掉括号），
 * 以前的开发依赖是排版过的。两边先压成同一种写法再比，断言只认代码结构，不认排版。
 */
function compact(code: string): string {
  return code
    .replaceAll('`', '"')
    .replace(/\s+/g, (gap: string, at: number, all: string) => /[\w$]/.test(all[at - 1] ?? '') && /[\w$]/.test(all[at + gap.length] ?? '') ? ' ' : '')
    .replace(/\(([\w$]+)\)=>/g, '$1=>')
    .replace(/[;,]([}\])])/g, '$1')
}

function assertHostShape(chatSource: string, conversationSource: string, label: string): void {
  const chat = compact(chatSource)
  const conversation = compact(conversationSource)
  // 「深度求索中」那一行：带 data-chat-running，三个子元素依次是读屏文字、分隔线、内容区，都是 span。
  const at = chat.indexOf('"data-chat-running":true')
  assert.ok(at >= 0, `${label}: 运行行仍带 data-chat-running`)
  const head = chat.slice(at, at + 1000)
  const spans = [...head.matchAll(/\(0,react_jsx_runtime\.jsxs?\)\("(\w+)",\{className:(\w+)\.(\w+)/g)].map((m) => `${m[1]}:${m[3]}`)
  assert.deepEqual(spans.slice(0, 3), ['span:visuallyHidden', 'span:runningDivider', 'span:runningContent'], `${label}: 运行行的三个子元素顺序没变`)
  assert.ok(head.includes('children:label'), `${label}: 内容区里仍是「深度求索中，用时 N」文字`)
  // 0.2.1 起运行行是对话列表的最后一项（`...running ? [行] : []`），以前直接写在列表后面（`running && 行`）。
  // 0.2.2-rc.1 起会话「保持中」（holding）也挂这一行。
  assert.match(chat, /running(?:\|\|holding)?(?:&&|\?\[)\(0,react_jsx_runtime\.jsx\)\(RunningStatus,/, `${label}: 只在会话在跑时挂载运行行`)
  // 对话区和输入框在同一个 data-conversation-session 外层里，输入框上方有列表插槽。
  assert.ok(conversation.includes('"data-conversation-session":sessionId'), `${label}: 会话外层仍带 data-conversation-session`)
  assert.ok(conversation.includes(`renderSlot("${DOCK_SLOT}",zone)`), `${label}: 输入框上方插槽仍在`)
  assert.ok(conversation.includes('children:[sessionId===void 0?null:(0,react_jsx_runtime.jsx)(Views,{}),composerSeat]'), `${label}: 对话区和输入框仍在同一个外层里`)
  // 输入框下方的统计卡：自带「会话统计」卡仍用这个 id 和 order 注册在这个列表插槽里，同 id 同 order 才能顶替它；
  // 对不上的话页面会同时出现两张卡。
  const slot = STATS_SLOT.replaceAll('.', '\\.')
  assert.match(chat, new RegExp(`name:"${slot}",id:"${STATS_ENTRY_ID}",order:${STATS_ENTRY_ORDER},`), `${label}: 自带统计卡的 id 和 order 没变`)
  assert.match(conversation, new RegExp(`"${slot}":\\{kind:"list"`), `${label}: 统计插槽仍是列表插槽`)
  assert.ok(conversation.includes(`renderSlot("${STATS_SLOT}"`), `${label}: 输入框下方仍渲染统计插槽`)
}

describe('宿主「深度求索中」那一行', () => {
  it('开发依赖的宿主结构和插件的假设一致', () => {
    assertHostShape(
      readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-chat/client'), 'utf8'),
      readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-conversation/client'), 'utf8'),
      'dev dependency',
    )
  })

  it('本机 DeepSeek Harness App 的宿主结构和插件的假设一致', (t) => {
    if (!existsSync(APP_ASAR)) {
      t.skip(`no App at ${APP_ASAR} (set DSH_APP_ASAR to check another install)`)
      return
    }
    const version = (JSON.parse(appFile('dsh-client-ui-chat', 'package.json')) as { version: string }).version
    t.diagnostic(`App dsh-client-ui-chat ${version}`)
    assertHostShape(appFile('dsh-client-ui-chat', 'lib', 'client.js'), appFile('dsh-client-ui-conversation', 'lib', 'client.js'), `App ${version}`)
  })
})
