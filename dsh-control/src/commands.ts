/**
 * 命令表与参数解析。命令行把 argv 原样送过来（位置参数 + `--key value` 选项），这里统一解释，
 * 所以命令行本身不懂任何命令——插件加了新命令，命令行不用更新。
 *
 * @module
 */
import { UsageError } from './gateway.ts'
import type { CommandSpec } from './server.ts'
import type { CommandResult, RemoteService } from './service.ts'
import type { Tier } from './models.ts'

export const COMMANDS: CommandSpec[] = [
  { name: 'health', summary: 'DSH 在不在线、几个会话在跑、几个在等你回答', usage: 'health', writes: false },
  { name: 'workspaces', summary: '列出工作区', usage: 'workspaces', writes: false },
  { name: 'sessions', summary: '列出会话（默认不含归档、空白会话和子代理，末尾说明省略了多少）', usage: 'sessions [--running] [--workspace <工作区 id、名字或路径> | --ungrouped] [--include-blank] [--cwd <目录>] [--query <标题关键词>] [--limit N] [--all]', writes: false },
  { name: 'archive', summary: '存档会话；有活动任务时拒绝，不会中止任务', usage: 'archive <会话>', writes: true },
  { name: 'unarchive', summary: '取消会话存档', usage: 'unarchive <会话>', writes: true },
  { name: 'rename', summary: '重命名会话', usage: 'rename <会话> <新标题>', writes: true },
  { name: 'fork', summary: '分叉会话；默认复制到最近完成的一轮，可用 --at-seq 指定事件边界，不会自动发消息', usage: 'fork <会话> [--at-seq N]', writes: true },
  { name: 'status', summary: '一个会话的状态：在不在跑、模型、待办、排队、是否在等你回答（在等回答时退出码 10）', usage: 'status <会话>', writes: false },
  { name: 'cwd', summary: '看会话现在的工作目录；给了目录就换过去（模型之后在新目录干活，已经开着的终端和后台命令还在原目录）', usage: 'cwd <会话> [新目录，绝对路径或 ~/ 开头]', writes: true },
  { name: 'goal', summary: '看会话的持续目标；pause 暂停、resume 恢复、clear 清掉，等同在界面目标面板上点（模型自己恢复不了被暂停的目标；会话正在跑时 pause 会中止这一轮）；hold 只停自动续跑，这一轮照常跑完，用 resume 恢复', usage: 'goal <会话> [pause|resume|clear|hold]', writes: true },
  { name: 'schedule', summary: '定时提醒（界面「自动化任务」）：列出全部或某个会话的，看一条的发送记录，删掉一条。新建要在会话里让模型建，宿主没开放外部新建', usage: 'schedule [list] [会话] | schedule history <提醒> [--limit N] | schedule delete <提醒>', writes: true },
  { name: 'last', summary: '最后一段助手回复', usage: 'last <会话> [--chars N]', writes: false },
  { name: 'read', summary: '逐轮概览；--turn N 看某一轮（-1 = 最后一轮）', usage: 'read <会话> [--turn N] [--tools] [--last N] [--chars N] [--max N]', writes: false },
  { name: 'send', summary: '给会话发消息。默认排到下一轮；--now 插进当前这一轮（模型做完手上这一步就看到，等同界面「插话发送」，旧名 --steer）；--interrupt 先停下当前这一步再发（这条成为下一轮开头）；--notify <会话> 在目标真做完（口径同 wait --settled）后给那个会话送一次插件通知，失败或中止也送，DSH 重启不丢；写 self 表示发起命令的 DSH 会话', usage: 'send <会话> <消息> [--now|--interrupt] [--tier normal|fast] [--model provider/model] [--effort 档位] [--notify <会话>|self]', writes: true },
  { name: 'queue', summary: '看和改排队消息（对应界面排队条的三个按钮），一条一条单独生效：list 列出（每条带编号）；steer 编号… 只把点名的几条插进当前这一轮，其余照常排队（不写或 all 是全部）；remove 编号… 删掉；edit 编号 改写。编号不随队列前移变化，也可以写序号', usage: 'queue <会话> [list | steer [编号…|all] | remove 编号… | edit 编号 <新内容>]', writes: true },
  { name: 'wait', summary: '等会话结束，保留回复和轮次详情；最后一轮失败或中止退出 1，只有成功完成退出 0；空闲又没有新内容立即返回（退出码 11），不空等。默认一轮结束就返回；--settled 等到真做完：这一轮结束、没在跑、没有排队，名下（含子代理）没有在跑的后台任务，子代理不在干活，持续目标不会自动续跑，且连续保持 3 秒；不看回复内容', usage: 'wait <会话> [--since SEQ] [--settled] [--timeout 秒，默认 1800] [--slice MS]', writes: false },
  { name: 'new', summary: '在工作区开新会话（默认 normal 档模型），可同时发第一条消息；输出等待用的起点 seq。档位没有可用模型就不建会话。--notify 同 send，要和第一条消息一起用', usage: 'new <工作区名字，或绝对路径> [消息] [--tier normal|fast] [--model provider/model] [--effort 档位] [--preset 名字] [--if-idle] [--notify <会话>|self]', writes: true },
  { name: 'notify', summary: '以 DSH 身份发 macOS 系统通知；默认有标题、正文和声音，可分别关闭，纯声音不会弹通知', usage: 'notify [正文] [--title 标题|--no-title] [--body 正文|--no-body] [--sound|--no-sound]', writes: true },
  { name: 'notice', summary: '以插件通知（不是用户消息）给会话送一段话：界面显示成一行通知，模型知道不是用户说的；会话闲着会被唤醒开一轮；加 --quiet 只放进上下文不唤醒', usage: 'notice <会话> <消息> [--summary 一行摘要] [--quiet]', writes: true },
  { name: 'wait-idle', summary: '等指定会话停下（不在跑、没有排队消息）；不指定则等所有会话。指定会话在等回答时退出 10；超时退出 124。空闲只是当下状态，不代表任务成功', usage: 'wait-idle [会话] [--timeout 秒] [--slice 毫秒]', writes: false },
  { name: 'web-url', summary: '这次启动的网页登录网址，带一次性口令（等同登录凭据，别外传；DSH 重启后失效）。从别的机器经 SSH 转发打开时用 --base 换成转发后的地址', usage: 'web-url [--base 网址]', writes: false },
  { name: 'open', summary: '拉起到别的机器上某个服务的隧道，并在本机浏览器打开（和设置「远程机器」页的「打开」一样）', usage: 'open <机器> <服务>', writes: false },
  { name: 'tunnel', summary: '关掉到别的机器上某个服务的隧道', usage: 'tunnel close <机器> <服务>', writes: false },
  { name: 'quit-check', summary: '现在退出 DSH 会不会弹确认框，卡在哪（在跑的会话、排队消息、后台任务、已打开会话的定时提醒）', usage: 'quit-check', writes: false },
  { name: 'restart-prepare', summary: '重启前用：让能接回的后台任务（持久监听）记下自己并暂停，新进程起来后自动接回。dsh-control restart 自己会调，一般不用手动跑', usage: 'restart-prepare', writes: true },
  { name: 'requeue-lost', summary: '把 --since 之后被中止吞掉的用户消息（宿主已从排队区取走、还没写进会话记录）原样放回下一轮排队区；dsh-control restart 自己会调。放回过的、用户已重发的不再放', usage: 'requeue-lost <会话> --since <毫秒时间戳>', writes: true },
  { name: 'restart-abort', summary: '重启没成时用：把 restart-prepare 暂停的任务马上接回', usage: 'restart-abort', writes: true },
  { name: 'monitor', summary: '直接给指定会话启动持久后台服务，重启后接回原会话，不发送消息或启动模型回合', usage: 'monitor <会话> --command <命令> --cwd <绝对目录> [--label <名称>] [--restart never|on-failure] [--quiet]', writes: true },
  { name: 'kill-jobs', summary: '停掉后台任务（不管属于哪个会话）；写 all 停掉所有在跑的', usage: 'kill-jobs <任务 id...>|all', writes: true },
  { name: 'cancel', summary: '中止正在跑的会话', usage: 'cancel <会话>', writes: true },
  { name: 'answer', summary: '回答会话里的提问；--select 可写选项的开头或其中几个字，对上多个会报歧义', usage: 'answer <会话> [自由回答] [--select 选项]... [--json 完整答案] [--call-id ID]', writes: true },
  { name: 'quota', summary: '各家额度（只看挑模型用的窗口）', usage: 'quota [--refresh]', writes: false },
  { name: 'models', summary: '两档候选模型现在能不能用、为什么', usage: 'models', writes: false },
  { name: 'pick', summary: '只算不改：这一档现在该用哪个模型（整档没有可用的退出码 2）', usage: 'pick [normal|fast]', writes: false },
  { name: 'model', summary: '给会话换模型（按档位挑，或直接指定）；已开始的会话默认拒绝（退出码 2），除非额度用光', usage: 'model <会话> [--tier normal|fast] [--model provider/model] [--effort 档位] [--force]', writes: true },
  { name: 'plugins', summary: '列出插件（组合包）', usage: 'plugins', writes: false },
  { name: 'plugin', summary: '装、卸、启用、停用插件', usage: 'plugin install|remove|enable|disable <包名或路径> [--force]', writes: true },
  { name: 'config', summary: '看或改设置（立即生效）', usage: 'config [命名空间] | config <命名空间> --set \'{"字段":值}\'', writes: true },
  { name: 'api', summary: '万能兜底：列出、查看、调用任意内部接口', usage: 'api list [namespace] | api describe <ns/method> | api call <ns/method> [\'{"参数":值}\']', writes: true },
]


/** 命令行和通信口共用校验；写操作之前拒绝拼错、缺值和错位机器参数。 */
export function validateCommand(command: string, args: string[], options: Record<string, unknown>): void {
  const specs: Record<string, [string, number]> = {
    health: ['', 0], workspaces: ['', 0], sessions: ['running all ungrouped include-blank workspace cwd query limit', 1],
    archive: ['', 1], unarchive: ['', 1], cwd: ['', 2], goal: ['', 2], schedule: ['limit', 2], rename: ['', Infinity], fork: ['at-seq', 1], status: ['', 1],
    last: ['chars', 1], read: ['turn tools last chars max', 1], send: ['now steer interrupt tier model effort notify', Infinity],
    chat: ['now steer interrupt tier model effort timeout since slice notify settled', Infinity], queue: ['', Infinity],
    wait: ['since timeout slice settled', 1], new: ['tier model effort preset if-idle notify', Infinity], notice: ['summary quiet', Infinity], notify: ['title body sound no-title no-body no-sound', 1],
    'wait-idle': ['slice timeout', 1], 'quit-check': ['', 0], 'web-url': ['base', 0], open: ['', 2], tunnel: ['', 3], 'restart-prepare': ['', 0], 'restart-abort': ['', 0], 'requeue-lost': ['since', 1],
    monitor: ['command cwd label restart quiet', 1], 'kill-jobs': ['', Infinity], cancel: ['', 1], answer: ['select json call-id', Infinity], quota: ['refresh', 0],
    models: ['', 0], pick: ['tier', 1], model: ['tier model effort force', 1], plugins: ['', 0], plugin: ['force', 2],
    config: ['set', 1], api: ['items timeout', args[0] === 'call' ? 3 : 2],
    start: ['', 0], restart: ['detach kill notify before quit-via install-app', 0], upgrade: ['feed check rollback force before detach notify quit-via', 0],
    'restart-status': ['request-id', 0], doctor: ['full profile timeout-ms', 0], version: ['', 0], help: ['', 1],
  }
  const spec = specs[command]
  if (spec === undefined) throw new UsageError(`没有命令 "${command}"。dsh-control help 看全部`)
  const allowed = new Set([...spec[0].split(' ').filter(Boolean), 'help'])
  const flags = new Set(['running', 'all', 'ungrouped', 'include-blank', 'tools', 'now', 'steer', 'interrupt', 'refresh', 'force', 'when-idle', 'if-idle', 'detach', 'kill', 'full', 'quiet', 'check', 'rollback', 'settled', 'help', 'sound', 'no-title', 'no-body', 'no-sound'])
  for (const [key, value] of Object.entries(options)) {
    if (!allowed.has(key)) throw new UsageError(`${command} 不支持 --${key}`)
    if (flags.has(key)) {
      if (value !== true) throw new UsageError(`--${key} 只能是单个不带值的开关`)
    } else if ((key === 'select' || (command === 'answer' && key === 'json')) && Array.isArray(value)) {
      if (value.some((v) => typeof v !== 'string' || v.trim() === '')) throw new UsageError(`--${key} 后面要写一个值`)
    } else if (typeof value !== 'string' || value.trim() === '') throw new UsageError(`--${key} 后面要写一个值，不能重复`)
  }
  if (args.length > spec[1]) throw new UsageError(`${command} 收到多余位置参数；机器选择 -H 必须写在命令前`)
  const textCommands = new Set(['send', 'chat', 'new', 'notice', 'rename', 'answer'])
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '-H' || args[i] === '--host' || args[i]?.startsWith('--host=')) && !(textCommands.has(command) && i >= 1)) {
      throw new UsageError('机器选择 -H / --host 必须写在命令前；没有执行操作')
    }
  }
  if ((command === 'restart' || command === 'upgrade') && options['quit-via'] !== undefined) {
    if (options['quit-via'] !== 'apple-event' && options['quit-via'] !== 'menu') throw new UsageError('--quit-via 只能是 apple-event 或 menu')
    if (options['kill'] === true) throw new UsageError('--quit-via 不能和 --kill 同用')
  }
  if (command === 'notify') {
    if (args[0] !== undefined && args[0].trim() === '') throw new UsageError('正文不能为空')
    if (args[0] !== undefined && (options.body !== undefined || options['no-body'] === true)) throw new UsageError('正文只能写一次，不能同时指定正文参数和 --body / --no-body')
    for (const field of ['title', 'body', 'sound']) {
      if (options[field] !== undefined && options[`no-${field}`] === true) throw new UsageError(`--${field} 和 --no-${field} 不能同时使用`)
    }
    if (options['no-title'] === true && options['no-body'] === true && options['no-sound'] === true) throw new UsageError('标题、正文、声音不能全部关闭')
  }
  if (command === 'chat' && (!args[0]?.trim() || !args.slice(1).join(' ').trim())) throw new UsageError('chat 要写会话和非空消息')
  if (options.tier !== undefined && !['normal', 'fast'].includes(String(options.tier))) throw new UsageError('--tier 只能是 normal 或 fast')
  if (options.model !== undefined && !/^([^/]+)\/(.+)$/.test(String(options.model).trim())) throw new UsageError('--model 要写成 provider/model')
  if (options.tier !== undefined && options.model !== undefined) throw new UsageError('--tier 和 --model 只能选一个')
  if (options.interrupt && (options.now || options.steer)) throw new UsageError('--interrupt 和 --now 只能选一个')
  if (command === 'chat' || command === 'wait' || command === 'wait-idle') {
    if (options.timeout !== undefined && (!Number.isFinite(Number(options.timeout)) || Number(options.timeout) <= 0)) throw new UsageError('--timeout 要是正数（秒）')
    for (const key of ['since', 'slice']) {
      if (options[key] !== undefined && (!Number.isSafeInteger(Number(options[key])) || Number(options[key]) < (key === 'since' ? -1 : 1))) throw new UsageError(`--${key} 要是${key === 'since' ? '大于等于 -1 的安全整数' : '正整数（毫秒）'}`)
    }
  }
}

function str(options: Record<string, unknown>, key: string): string | undefined {
  const v = options[key]
  if (v === undefined || v === true) return undefined
  return Array.isArray(v) ? String(v.at(-1)) : String(v)
}

function int(options: Record<string, unknown>, key: string): number | undefined {
  const raw = str(options, key)
  if (raw === undefined) return undefined
  const n = Number(raw)
  if (!Number.isInteger(n)) throw new UsageError(`--${key} 要是整数，收到 "${raw}"`)
  return n
}

function flag(options: Record<string, unknown>, key: string): boolean {
  return options[key] === true || options[key] === 'true'
}

function list(options: Record<string, unknown>, key: string): string[] {
  const v = options[key]
  if (v === undefined) return []
  return (Array.isArray(v) ? v : [v]).map(String)
}

function tierOption(options: Record<string, unknown>): Tier | undefined {
  const t = str(options, 'tier')
  if (t === undefined) return undefined
  if (t !== 'normal' && t !== 'fast') throw new UsageError(`--tier 只能是 normal 或 fast，收到 "${t}"`)
  return t
}

function json(raw: string, what: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    throw new UsageError(`${what} 不是合法 JSON：${raw}`)
  }
}

function need(args: string[], index: number, what: string, usage: string): string {
  const v = args[index]
  if (v === undefined || v === '') throw new UsageError(`缺少${what}。用法：dsh-control ${usage}`)
  return v
}

export async function runCommand(service: RemoteService, command: string, args: string[], options: Record<string, unknown>, signal: AbortSignal): Promise<CommandResult> {
  const spec = COMMANDS.find((c) => c.name === command)
  if (spec === undefined) throw new UsageError(`没有命令 "${command}"。dsh-control help 看全部`)
  validateCommand(command, args, options)
  const u = spec.usage
  switch (command) {
    case 'health': return service.health()
    case 'workspaces': return service.listWorkspaces()
    case 'sessions': {
      const workspace = str(options, 'workspace')
      const cwd = str(options, 'cwd')
      const query = str(options, 'query') ?? args[0]
      const limit = int(options, 'limit')
      return service.listSessions({ running: flag(options, 'running'), all: flag(options, 'all'), ungrouped: flag(options, 'ungrouped'), includeBlank: flag(options, 'include-blank'), ...(workspace === undefined ? {} : { workspace }), ...(cwd === undefined ? {} : { cwd }), ...(query === undefined ? {} : { query }), ...(limit === undefined ? {} : { limit }) })
    }
    case 'archive': return service.archive(need(args, 0, '会话', u))
    case 'unarchive': return service.unarchive(need(args, 0, '会话', u))
    case 'rename': return service.rename(need(args, 0, '会话', u), need(args, 1, '新标题', u) + (args.length > 2 ? ` ${args.slice(2).join(' ')}` : ''))
    case 'fork': return service.fork(need(args, 0, '会话', u), int(options, 'at-seq'))
    case 'status': return service.status(need(args, 0, '会话', u))
    case 'last': {
      const chars = int(options, 'chars')
      return service.last(need(args, 0, '会话', u), chars === undefined ? {} : { chars })
    }
    case 'read': {
      const turn = int(options, 'turn')
      const chars = int(options, 'chars')
      const max = int(options, 'max')
      const last = int(options, 'last')
      return service.read(need(args, 0, '会话', u), { tools: flag(options, 'tools'), ...(turn === undefined ? {} : { turn }), ...(chars === undefined ? {} : { chars }), ...(max === undefined ? {} : { max }), ...(last === undefined ? {} : { last }) })
    }
    case 'send': {
      const tier = tierOption(options)
      const model = str(options, 'model')
      const effort = str(options, 'effort')
      const text = args.slice(1).join(' ')
      need(args, 1, '消息', u)
      const notify = str(options, 'notify')
      return service.send(need(args, 0, '会话', u), text, { steer: flag(options, 'steer'), now: flag(options, 'now'), interrupt: flag(options, 'interrupt'), ...(tier === undefined ? {} : { tier }), ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }), ...(notify === undefined ? {} : { notify }) })
    }
    case 'queue': return service.queue(need(args, 0, '会话', u), args[1], args.slice(2))
    case 'cwd': return service.cwd(need(args, 0, '会话', u), args[1])
    case 'goal': return service.goal(need(args, 0, '会话', u), args[1])
    case 'schedule': {
      const limit = int(options, 'limit')
      return service.schedule(args[0], args.slice(1), limit === undefined ? {} : { limit })
    }
    case 'wait': {
      const since = int(options, 'since')
      const sliceMs = int(options, 'slice')
      return service.wait(need(args, 0, '会话', u), { signal, settled: flag(options, 'settled'), ...(since === undefined ? {} : { since }), ...(sliceMs === undefined ? {} : { sliceMs }) })
    }
    case 'new': {
      const tier = tierOption(options)
      const model = str(options, 'model')
      const effort = str(options, 'effort')
      const preset = str(options, 'preset')
      const notify = str(options, 'notify')
      const text = args.slice(1).join(' ')
      return service.newSession(need(args, 0, '工作区', u), text === '' ? undefined : text, { ...(tier === undefined ? {} : { tier }), ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }), ...(preset === undefined ? {} : { preset }), ...(options['if-idle'] === true ? { ifIdle: true } : {}), ...(notify === undefined ? {} : { notify }) })
    }
    case 'notify': return service.notifyDesktop({
      title: flag(options, 'no-title') ? undefined : (str(options, 'title') ?? 'DSH'),
      body: flag(options, 'no-body') ? undefined : (args[0] ?? str(options, 'body') ?? '有一条新通知'),
      sound: !flag(options, 'no-sound'),
    })
    case 'notice': {
      need(args, 1, '消息', u)
      return service.notice(need(args, 0, '会话', u), args.slice(1).join(' '), str(options, 'summary'), flag(options, 'quiet'))
    }
    case 'wait-idle': {
      const sliceMs = int(options, 'slice')
      return service.waitIdle({ signal, ...(args[0] === undefined ? {} : { session: args[0] }), ...(sliceMs === undefined ? {} : { sliceMs }) })
    }
    case 'quit-check': return service.quitCheck()
    case 'web-url': return service.webUrl(str(options, 'base'))
    case 'open': return service.openService(need(args, 0, '机器', u), need(args, 1, '服务', u))
    case 'tunnel': {
      if (args[0] !== 'close') throw new UsageError(`tunnel 的子命令只有 close。用法：dsh-control ${u}`)
      return service.closeTunnel(need(args, 1, '机器', u), need(args, 2, '服务', u))
    }
    case 'restart-prepare': return service.restartPrepare()
    case 'restart-abort': return service.restartAbort()
    case 'requeue-lost': return service.requeueLost(need(args, 0, '会话', u), int(options, 'since'))
    case 'monitor': return service.monitor(need(args, 0, '会话', u), { command: str(options, 'command'), cwd: str(options, 'cwd'), label: str(options, 'label'), restart: str(options, 'restart'), quiet: flag(options, 'quiet') })
    case 'kill-jobs': need(args, 0, '任务 id 或 all', u); return service.killJobs(args)
    case 'cancel': return service.cancel(need(args, 0, '会话', u))
    case 'answer': {
      const raw = str(options, 'json')
      const callId = str(options, 'call-id')
      const text = args.slice(1).join(' ')
      return service.answer(need(args, 0, '会话', u), {
        select: list(options, 'select'),
        ...(text === '' ? {} : { text }),
        ...(raw === undefined ? {} : { json: json(raw, '--json') }),
        ...(callId === undefined ? {} : { callId }),
      })
    }
    case 'quota': return service.quota(flag(options, 'refresh'))
    case 'models': return service.models()
    case 'pick': {
      const tier = args[0] ?? str(options, 'tier') ?? 'normal'
      if (tier !== 'normal' && tier !== 'fast') throw new UsageError(`档位只能是 normal 或 fast，收到 "${tier}"`)
      return service.pickModel(tier)
    }
    case 'model': {
      const tier = tierOption(options)
      const model = str(options, 'model')
      const effort = str(options, 'effort')
      if (tier === undefined && model === undefined && effort === undefined) throw new UsageError(`需要 --tier、--model 或 --effort。用法：dsh-control ${u}`)
      return service.model(need(args, 0, '会话', u), { force: flag(options, 'force'), ...(tier === undefined ? {} : { tier }), ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) })
    }
    case 'plugins': return service.plugins()
    case 'plugin': {
      const action = need(args, 0, '动作', u)
      if (action !== 'install' && action !== 'remove' && action !== 'enable' && action !== 'disable') throw new UsageError(`动作只能是 install / remove / enable / disable。用法：dsh-control ${u}`)
      return service.pluginAction(action, need(args, 1, '包名', u), flag(options, 'force'))
    }
    case 'config': {
      const ns = args[0]
      const set = str(options, 'set')
      if (set === undefined) return service.settingsGet(ns)
      if (ns === undefined) throw new UsageError(`改设置要给命名空间。用法：dsh-control ${u}`)
      const patch = json(set, '--set')
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) throw new UsageError('--set 要是一个 JSON 对象')
      return service.settingsSet(ns, patch as Record<string, unknown>)
    }
    case 'api': {
      const sub = need(args, 0, '子命令', u)
      if (sub === 'list') return service.apiList(args[1])
      if (sub === 'describe') return service.apiDescribe(need(args, 1, '接口名', u))
      if (sub === 'call') {
        const raw = args.slice(2).join(' ')
        const parsed = raw.trim() === '' ? {} : json(raw, '参数')
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new UsageError('参数要是一个 JSON 对象，键是接口的 args 字段名（dsh-control api describe 查看）')
        const maxItems = int(options, 'items')
        const timeoutMs = int(options, 'timeout')
        return service.apiCall(need(args, 1, '接口名', u), parsed as Record<string, unknown>, { signal, ...(maxItems === undefined ? {} : { maxItems }), ...(timeoutMs === undefined ? {} : { timeoutMs }) })
      }
      throw new UsageError(`api 的子命令只有 list / describe / call。用法：dsh-control ${u}`)
    }
    default:
      throw new UsageError(`没有命令 "${command}"`)
  }
}
