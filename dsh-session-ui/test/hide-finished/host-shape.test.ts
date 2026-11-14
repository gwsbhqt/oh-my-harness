/**
 * 本插件靠「同插槽、同 id、更小优先级」顶替宿主的两个页头按钮，并把宿主组件原样渲染。
 * 宿主改了 id、插槽名、参数名或状态取值，顶替会悄悄失效（按钮又出现）或把按钮弄没，
 * 不会报错。所以对着开发依赖和本机 App 自带的宿主各核对一遍。
 *
 * App 路径取 DSH_APP_ASAR，否则用 macOS 默认安装位置；找不到 App 时跳过并注明。
 */
import { strict as assert } from 'node:assert'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { JOB_LIST_ID, LINEAGE_SLOT, SLOT, SUBAGENT_CATALOG_ID } from '../../src/client/hide-finished/ids.ts'

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

/** 压缩后的插槽实现：同格按优先级升序排，每格只渲染第一条（数字最小的那条）。0.2.2-rc.2 起多了 hoc 一种格，列表和 keyed 不变。 */
function assertBundledSlots(bundle: string, label: string): void {
  assert.match(bundle, /==="keyed"\?\w+\.options\.key:\w+==="list"\?\w+\.options\.id:(?:\w+==="hoc"\?\w+\(\w+\):)?void 0;\w+\.has\(\w+\)\|\|/, `${label}: 插槽仍按 key / id 分格，每格只留第一条`)
  assert.match(bundle, /\(\w+\.options\.priority\?\?0\)-\(\w+\.options\.priority\?\?0\)/, `${label}: 仍按优先级升序取胜者`)
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

function assertHostShape(jobsSource: string, subagentSource: string, label: string): void {
  const jobs = compact(jobsSource)
  const subagent = compact(subagentSource)
  const has = (code: string, snippet: string, message: string) => assert.ok(code.includes(snippet), message)
  const reg = (id: string) => new RegExp(`name:"${SLOT.replaceAll('.', '\\.')}",id:"${id}",order:-?\\d+,(?![^}]*priority)`)
  assert.match(jobs, reg(JOB_LIST_ID), `${label}: 后台任务按钮仍以默认优先级注册在同一插槽`)
  assert.match(subagent, reg(SUBAGENT_CATALOG_ID), `${label}: 子代理按钮仍以默认优先级注册在同一插槽`)
  has(jobs, 'locale:"job"', `${label}: 后台任务文案命名空间仍是 job`)
  has(subagent, 'const NS="subagent"', `${label}: 子代理文案命名空间仍是 subagent`)

  // 后台任务：组件从 useJobs 读 rows[sessionId]，没有任务就不显示。
  has(jobs, 'function JobListAction({sessionId,useJobs,', `${label}: 后台任务组件仍从 useJobs 取数据`)
  has(jobs, 'useJobs(state=>state.rows[sessionId])', `${label}: 任务行仍在 rows[sessionId]`)
  has(jobs, 'if(visibleCount===0)return null', `${label}: 空列表时整个不显示`)
  has(jobs, 'hooks:{jobs:ctx.jobs.state}', `${label}: useJobs 仍由 hooks.jobs 生成`)
  for (const s of ['running', 'stopping', 'completed', 'killed', 'failed']) has(jobs, `case"${s}"`, `${label}: 任务状态 ${s} 仍存在`)
  has(jobs, 'return job.status==="running"||job.status==="stopping"', `${label}: 「在跑」口径没变`)

  // 子代理：0.2.2-rc.2 起外层组件只判断是不是子会话，再把全部参数交给根会话按钮。
  has(subagent, 'function SubagentCatalogAction(props){', `${label}: 子代理组件仍收整份参数`)
  has(subagent, 'return(0,react_jsx_runtime.jsx)(RootCatalogAction,{...props})', `${label}: 子代理组件仍原样转交参数`)
  has(subagent, 'function RootCatalogAction({sessionId,useProjection,useSessions,useSessionStatus,useFooterAvailable,', `${label}: 根会话按钮参数没变`)
  // 任务板：有内容时宿主没有子代理也显示按钮，插件要按同一口径保留它（src/client/filter.ts 的 hasTeamBoard）。
  has(subagent, 'useProjection("agentTeam",team=>team?.enabled===true&&team.tasks.some(task=>task.status!=="deleted"))', `${label}: 任务板「有任务」口径没变`)
  has(subagent, 'useProjection("agentTeam",team=>team?.enabled===true&&team.failure!==void 0)', `${label}: 任务板「有失败说明」口径没变`)
  has(subagent, 'hasBoardContent:footerAvailable&&(hasSharedTasks||hasTaskFailure)', `${label}: 任务板仍要页脚可用才算`)
  has(subagent, 'inject:sessionId=>({...catalogActions(sessionId),hooks:{footerAvailable}})', `${label}: useFooterAvailable 仍由 hooks.footerAvailable 生成`)
  has(subagent, 'const visible=presentedCatalog!==void 0&&(variant==="switcher"||props.hasBoardContent||presentedCatalog.state==="error"||presentedCatalog.entries.length>0)', `${label}: 宿主按钮显示条件没变`)
  has(subagent, 'snapshot.values.subagentCatalog', `${label}: 目录仍在 subagentCatalog 投影`)
  const lineage = LINEAGE_SLOT.replaceAll('.', '\\.')
  assert.match(subagent, new RegExp(`name:"${lineage}",locale:NS,inject:catalogActions\\},SubagentHeaderLineage`), `${label}: 切换框仍以默认优先级注册在标题插槽`)
  has(subagent, 'function SubagentHeaderLineage({lineageSessionId,displayTitle,openTitle,useSessions,useSession,useSessionStatus,', `${label}: 切换框参数没变`)
  has(subagent, 'for(const[parentId,snapshot]of Object.entries(state.projectionsBySession))if(snapshot.values.subagentCatalog?.some(entry=>entry.id===lineageSessionId))return parentId;', `${label}: 切换框仍靠目录找父会话（所以当前子代理必须留在目录里）`)
  has(subagent, 'useSessions(state=>state.projectionsBySession)', `${label}: 目录仍从 useSessions 读`)
  has(subagent, 'children:t(totalCountKey,{count:directCount})', `${label}: 按钮数字仍是目录条数`)
  has(subagent, '(statuses.get(entry.id)?.running??summaries[entry.id]?.running)===true', `${label}: 「在跑」口径没变`)
}

/** 插槽：同 id 只渲染优先级最小的那条。 */
function assertSlots(source: string, label: string): void {
  const slots = compact(source)
  assert.match(slots, /kind==="list"\?\w+\.options\.id/, `${label}: 列表插槽仍按 id 分格`)
  assert.match(slots, /\(\w+\.options\.priority\?\?0\)-\(\w+\.options\.priority\?\?0\)/, `${label}: 仍按优先级升序取胜者`)
}

describe('宿主页头按钮', () => {
  it('开发依赖的宿主形状和插件的假设一致', () => {
    assertHostShape(
      readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-jobs/client'), 'utf8'),
      readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-subagent/client'), 'utf8'),
      'dev dependency',
    )
    assertSlots(readFileSync(require.resolve('@deepseek-ai/dsh-client-ui-slots'), 'utf8'), 'dev dependency')
  })

  it('本机 DeepSeek Harness App 的宿主形状和插件的假设一致', (t) => {
    if (!existsSync(APP_ASAR)) {
      t.skip(`no App at ${APP_ASAR} (set DSH_APP_ASAR to check another install)`)
      return
    }
    const version = (JSON.parse(appFile('dsh-client-ui-jobs', 'package.json')) as { version: string }).version
    t.diagnostic(`App dsh-client-ui-jobs ${version}`)
    assertHostShape(appFile('dsh-client-ui-jobs', 'lib', 'client.js'), appFile('dsh-client-ui-subagent', 'lib', 'client.js'), `App ${version}`)
    assertBundledSlots(appFrontendBundle(), `App ${version}`)
  })
})
