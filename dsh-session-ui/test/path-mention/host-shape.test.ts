/**
 * 本插件靠「同插槽、同 key、更小优先级」顶替宿主的助手回复组件，并把宿主组件原样渲染、只换 fileMentions。
 * 宿主改了插槽名、key、参数名或提及的用法，顶替会悄悄失效，不会报错。所以对着开发依赖和本机 App 各核对一遍。
 */
import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ASSISTANT_KEY, CHAT_LOCALE, SLOT } from '../../src/client/path-mention/ids.ts'
import { MAC_CATALOG } from '../../src/host/path-mention/apps.ts'

const require = createRequire(import.meta.url)
const APP_ASAR = process.env.DSH_APP_ASAR ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

interface AsarEntry { files?: Record<string, AsarEntry>; size?: number; offset?: string; unpacked?: boolean }

const archives = new Map<string, { buf: Buffer; base: number; root: AsarEntry }>()

function asarNode(archive: string, path: readonly string[]): { node: AsarEntry; buf: Buffer; base: number } {
  let opened = archives.get(archive)
  if (opened === undefined) {
    const buf = readFileSync(archive)
    const jsonLength = buf.readUInt32LE(12)
    opened = { buf, base: 8 + buf.readUInt32LE(4), root: JSON.parse(buf.subarray(16, 16 + jsonLength).toString('utf8')) as AsarEntry }
    archives.set(archive, opened)
  }
  let node = opened.root
  for (const part of path) {
    const next = node.files?.[part]
    assert.ok(next !== undefined, `${path.join('/')} not in ${archive}`)
    node = next
  }
  return { node, buf: opened.buf, base: opened.base }
}

function readAsarFile(archive: string, path: readonly string[]): string {
  const { node, buf, base } = asarNode(archive, path)
  if (node.unpacked === true) return readFileSync(join(`${archive}.unpacked`, ...path), 'utf8')
  assert.ok(node.size !== undefined && node.offset !== undefined)
  const start = base + Number(node.offset)
  return buf.subarray(start, start + node.size).toString('utf8')
}

const appFile = (pkg: string, ...rest: string[]) => readAsarFile(APP_ASAR, ['dsh', 'node_modules', '@deepseek-ai', pkg, ...rest])

/** 0.2.1 起 App 不再单独放插槽和基础组件两个包，它们打进了网页前端的压缩总包，由总包的模块表提供给插件。 */
function appFrontendBundle(): string {
  const dir = ['dsh', 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist', 'assets']
  for (const name of Object.keys(asarNode(APP_ASAR, dir).node.files ?? {})) {
    if (!name.endsWith('.js')) continue
    const text = readAsarFile(APP_ASAR, [...dir, name])
    if (text.includes('"@deepseek-ai/dsh-client-ui-slots":')) return text
  }
  assert.fail('App 网页前端里没有登记 dsh-client-ui-slots 的模块表')
}

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

const has = (code: string, snippet: string, message: string) => assert.ok(code.includes(snippet), message)

/** 压缩后的插槽实现：同格按优先级升序排，每格只渲染第一条（数字最小的那条）。0.2.2-rc.2 起多了 hoc 一种格，列表和 keyed 不变。 */
function assertBundledSlots(bundle: string, label: string): void {
  assert.match(bundle, /==="keyed"\?\w+\.options\.key:\w+==="list"\?\w+\.options\.id:(?:\w+==="hoc"\?\w+\(\w+\):)?void 0;\w+\.has\(\w+\)\|\|/, `${label}: 插槽仍按 key / id 分格，每格只留第一条`)
  assert.match(bundle, /\(\w+\.options\.priority\?\?0\)-\(\w+\.options\.priority\?\?0\)/, `${label}: 仍按优先级升序取胜者`)
}

/**
 * 基础组件里 Markdown 提及和菜单定位的写法。开发依赖保留变量名，App 前端总包里变量名被改短，
 * 所以变量名一律用通配。
 */
function assertPrimitives(source: string, label: string): void {
  const code = compact(source)
  const id = String.raw`[\w$]+`
  const re = (pattern: string) => new RegExp(pattern)
  assert.match(code, re(String.raw`\.inLink===(?:true|!0)\?void 0:${id}\.fileMentions\?\.resolve\(${id}\)`), `${label}: Markdown 仍把行内代码原文交给 fileMentions.resolve`)
  assert.match(code, re(String.raw`${id}!==void 0(?:\)return |\?)(?:${id}\.)?jsx\("code",\{children:(?:${id}\.)?jsxs\("button",\{type:"button",className:${id}\.fileMention,title:${id}\.title,"aria-label":${id}\.label,onClick:${id}\.open,`), `${label}: 提及仍画成 code > button（右键和拖拽按这个认），点提及仍调 mention.open`)
  assert.match(code, re(String.raw`(?:${id}\.)?jsxs\("button",\{type:"button",className:${id}\(${id}\.fileMention,${id}\.fileLink\),title:${id}===void 0\?${id}\.path:void 0,[\s\S]{0,200}children:\[${id}&&(?:${id}\.)?jsx\(`), `${label}: Markdown 文件链接仍是带 title（路径）、以图标开头的 button`)
  // 右键菜单定位：0.2.2-rc.2 起宿主菜单不认 getAnchorRect，只认 anchorPoint，按它把锚点固定在鼠标处。
  assert.match(code, /anchorPoint[:,}]/, `${label}: 宿主菜单仍收 anchorPoint`)
  assert.match(code, re(String.raw`\{position:"fixed",left:${id}\.x,top:${id}\.y,width:0,height:0\}`), `${label}: 宿主菜单仍把锚点固定在 anchorPoint 处`)
  assert.match(code, re(String.raw`contextual(?::${id})?=(?:false|!1)[,}]`), `${label}: 宿主菜单仍有 contextual 开关`)
  assert.match(code, re(String.raw`autoFocus(?::${id})?=(?:false|!1)[,}]`), `${label}: 不传 autoFocus 时宿主菜单不抢焦点`)
}

/** 宿主头栏清单里 macOS 上能用的应用 id，按清单顺序。 */
function hostMacCatalog(hostOpenInApp: string): string[] {
  const code = compact(hostOpenInApp)
  const start = code.indexOf('const OPEN_IN_APP_CATALOG=[')
  assert.ok(start >= 0, 'host open-in-app catalog not found')
  const body = code.slice(start, code.indexOf('];', start))
  return body.split('{id:"').slice(1).filter((entry) => entry.includes('darwin:')).map((entry) => entry.slice(0, entry.indexOf('"')))
}

function assertCatalog(hostOpenInApp: string, label: string): void {
  // 插件自己按这份清单把应用 id 换成 .app 再打开；宿主加了新应用这里就会失败，提醒去 src/apps.ts 补一行。
  assert.deepEqual(MAC_CATALOG.map((app) => app.id), hostMacCatalog(hostOpenInApp), `${label}: src/apps.ts 的应用清单和宿主头栏清单（macOS 部分）一致`)
  const code = compact(hostOpenInApp)
  for (const app of MAC_CATALOG) for (const bundle of app.bundles) {
    if (app.id === 'xcode') continue
    has(code, compact(`"${bundle}"`), `${label}: 宿主清单仍按 ${bundle} 找 ${app.id}`)
  }
}

/** 路由常量：以前直接写字符串，0.2.2-rc.2 起先定义 *_PATH 再 slice。 */
function hasRoute(code: string, name: string, path: string): boolean {
  return code.includes(`const ${name}_ROUTE="${path}".slice(1);`)
    || (code.includes(`const ${name}_PATH="${path}";`) && code.includes(`const ${name}_ROUTE=${name}_PATH.slice(1);`))
}

function assertHostShape(chatSource: string, conversationSource: string, openInAppSource: string, inputTriggerSource: string, gatewaySource: string, label: string): void {
  const [chat, conversation, openInApp, inputTrigger, gateway] = [chatSource, conversationSource, openInAppSource, inputTriggerSource, gatewaySource].map(compact) as [string, string, string, string, string]
  const slot = SLOT.replaceAll('.', '\\.')
  // 0.2.1 起这条登记多了子插槽声明（思考内容、消息图片），声明归宿主这条，插件顶替时不重复声明。
  assert.match(chat, new RegExp(`name:"${slot}",key:"${ASSISTANT_KEY}",locale:NS,(?:children:\\{[\\s\\S]*?\\},)?inject:(?:sessionId)?=>\\(\\{hooks:\\{presentation\\}[\\s\\S]{0,300}?\\}\\)\\},AssistantNodeView\\)`), `${label}: 助手回复仍以默认优先级注册在 ${SLOT}/${ASSISTANT_KEY}`)
  has(chat, `const NS="${CHAT_LOCALE}"`, `${label}: 聊天文案命名空间仍是 ${CHAT_LOCALE}`)
  const params = /function AssistantNodeView\(\{([^}]*)\}\)/.exec(chat)?.[1]?.split(',') ?? []
  for (const name of ['node', 'openFile', 'fileMentions']) assert.ok(params.includes(name), `${label}: 助手回复组件仍收 ${name}`)
  // 0.2.2-rc.1 起多传 getFileTriggerProps，插件原样转交。
  assert.match(chat, /owner===void 0\?void 0:fileMentions\(owner(?:,getFileTriggerProps)?\)/, `${label}: 宿主仍按 owner 调 fileMentions`)
  has(chat, 'streaming:data.status==="running"', `${label}: 流式状态仍是 data.status === "running"`)
  assert.match(chat, /if\(block===void 0\)continue;[\s\S]{0,300}case"text":[\s\S]{0,150}text:block\.text/, `${label}: 正文仍在 data.blocks 的 text 块`)
  assert.match(chat, /const owner=\(0,react\.useMemo\)\(\(\)=>node===void 0\?null:\{[\s\S]{0,100}cwd,openFile,/, `${label}: 聊天节点仍收到 cwd 和 openFile`)
  has(chat, 'openFile:async(path,options)=>', `${label}: openFile 仍接受 (path, {line})`)
  // 右键菜单的打开方式：和宿主头栏「打开工作区」那个菜单同一份清单、同一个图标接口、同一套应用名文案。
  assert.ok(hasRoute(openInApp, 'OPEN_IN_APP_APPS', '/open-in-app/apps'), `${label}: 本机应用清单接口仍是 open-in-app/apps`)
  assert.ok(hasRoute(openInApp, 'OPEN_IN_APP_ICON_PREFIX', '/open-in-app/icon'), `${label}: 应用图标接口仍是 open-in-app/icon/<id>`)
  has(openInApp, 'if(Array.isArray(payload.apps))apps=payload.apps.filter(id=>typeof id==="string")', `${label}: 清单接口仍返回 {apps: string[]}`)
  has(openInApp, 'const NS="open-in-app";', `${label}: 应用名文案命名空间仍是 open-in-app`)
  has(openInApp, '"app.finder":"访达",', `${label}: 应用名文案键仍是 app.<id>`)
  // 粘贴：编辑器的粘贴处理注册在编辑器上，文档捕获阶段的监听先到，拦下后它就不会再插一遍。
  assert.match(conversation, /const text=clipboardData\.getData\("text\/plain"\);[\s\S]{0,150}handlers\.pasteText\(text\);/, `${label}: 输入框粘贴仍读 text/plain 再插入`)
  has(conversation, '"data-composer-input":true,', `${label}: 输入框编辑区仍有 data-composer-input`)
  // 带行号的提及块：归插件登记的 @ 来源管，发送时按 source 找它的 codec，点开时按 source 找它的 openReference。
  has(inputTrigger, 'registerSource(src){', `${label}: 仍能登记 @ 来源`)
  assert.match(inputTrigger, /const owner=this\.deps\.roster\.all\(\)\.find\(s=>s\.name===source\);[\s\S]{0,200}return owner\.codec\.serialize\(ref,signal\)/, `${label}: 发送时仍按来源名找 codec.serialize`)
  has(inputTrigger, 'owner.name===source)&&owner.openReference?.(session,reference)', `${label}: 点提及块时仍按来源名找 openReference`)
  has(inputTrigger, 'for(const source of roster)source.candidates(projection,{', `${label}: 候选菜单仍逐个问来源的 candidates`)
  has(chat, 'else ctx.sidebarRight.openResource(url,{params:{line:options.line}});', `${label}: 侧栏打开文件仍接受 params.line`)
  // 接口命名空间各是一个单独的服务，名字是 `remote.<命名空间>`。插件只能按这个名字 ctx.get，
  // 不能写 ctx.get('remote').session：那条路要求声明依赖，没声明就抛错，右键菜单曾因此整个不弹。
  has(gateway, 'function remoteServiceKey(namespace){return"remote.${namespace}"', `${label}: 接口命名空间服务名仍是 remote.<命名空间>`)
  has(gateway, 'super(ctx,remoteServiceKey(name));', `${label}: 每个命名空间仍单独登记成服务`)
  // 相对路径按 ~/… 写时要家目录，取的是 remote.$host.home（宿主 @ 引用菜单也这么取）。
  has(gateway, 'get $host(){const home=this.connection.generation.getSnapshot()?.host.home;', `${label}: 家目录仍由 remote.$host.home 给出`)
  // 拖进输入框：按落点的会话找输入框，走和访达拖文件同一个 addFiles。
  has(conversation, '"data-conversation-session":sessionId,', `${label}: 对话区仍标着会话 id`)
  has(conversation, '"data-composer-card":true,', `${label}: 输入框卡片仍有 data-composer-card`)
  has(conversation, 'ctx.plugin(ConversationController,{input:inputHub,', `${label}: conversation 服务仍公开 input`)
  assert.match(conversation, /addFiles\(references,ids\)\{[\s\S]{0,150}this\.draftEditor\.insertFileReferences\(references\)/, `${label}: 输入框 addFiles 仍插入提及块`)
  assert.match(conversation, /source:"reference",ref:mention,label:directory\?"\$\{label\}\/":label,appearance:directory\?"folder":"file",clipboardText:mention/, `${label}: 访达拖入生成的提及块字段没变`)
  has(conversation, 'if(!(preserveQuote||/\\s/u.test(path)))return"@${path}";', `${label}: 提及块写法仍是 @路径`)
}

/** 插槽：同 key 只渲染优先级最小的那条。 */
function assertSlots(source: string, label: string): void {
  const slots = compact(source)
  assert.match(slots, /const cell=kind==="keyed"\?entry\.options\.key/, `${label}: keyed 插槽仍按 key 分格`)
  assert.match(slots, /\(a\.options\.priority\?\?0\)-\(b\.options\.priority\?\?0\)/, `${label}: 仍按优先级升序取胜者`)
}

describe('宿主助手回复组件', () => {
  it('开发依赖的宿主形状和插件的假设一致', () => {
    assertHostShape(
      readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-chat/client'), 'utf8'),
      readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-conversation/client'), 'utf8'),
      readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-open-in-app/client'), 'utf8'),
      readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-input-trigger/client'), 'utf8'),
      readFileSync(require.resolve('@deepseek-ai/dsh-api-gateway/client'), 'utf8'),
      'dev dependency',
    )
    assertPrimitives(readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-primitives'), 'utf8'), 'dev dependency')
    assertSlots(readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-slots'), 'utf8'), 'dev dependency')
  })

  it('本机 DeepSeek Harness App 的宿主形状和插件的假设一致', (t) => {
    if (!existsSync(APP_ASAR)) {
      t.skip(`no App at ${APP_ASAR}`)
      return
    }
    const version = (JSON.parse(appFile('dsh-client-ui-chat', 'package.json')) as { version: string }).version
    t.diagnostic(`App dsh-client-ui-chat ${version}`)
    assertHostShape(
      appFile('dsh-client-ui-chat', 'lib', 'client.js'),
      appFile('dsh-client-ui-conversation', 'lib', 'client.js'),
      appFile('dsh-client-ui-open-in-app', 'lib', 'client.js'),
      appFile('dsh-client-ui-input-trigger', 'lib', 'client.js'),
      // 0.2.1 起网关客户端分成 node / browser 两份，网页加载的是 browser 那份。
      appFile('dsh-api-gateway', 'lib', 'client.browser.js'),
      `App ${version}`,
    )
    const bundle = appFrontendBundle()
    assert.ok(bundle.includes('"@deepseek-ai/dsh-client-ui-primitives":'), `App ${version}: 模块表仍提供 dsh-client-ui-primitives`)
    assertPrimitives(bundle, `App ${version}`)
    assertBundledSlots(bundle, `App ${version}`)
  })
})

describe('宿主头栏应用清单', () => {
  it('开发依赖的清单和插件的一致', () => {
    assertCatalog(readFileSync(require.resolve('@deepseek-ai/dsh-host-open-in-app'), 'utf8'), 'dev dependency')
  })

  it('本机 DeepSeek Harness App 的清单和插件的一致', (t) => {
    if (!existsSync(APP_ASAR)) {
      t.skip(`no App at ${APP_ASAR}`)
      return
    }
    assertCatalog(appFile('dsh-host-open-in-app', 'lib', 'index.js'), 'App')
  })
})