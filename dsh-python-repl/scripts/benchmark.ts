import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, realpath, symlink, stat, readdir, cp } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual, parseArgs } from 'node:util'

export interface BenchTask {
  id: string
  family: string
  rows: number
  files: Record<string, string>
  prompt: string
  expected: unknown
}
export interface RunMetrics {
  complete: boolean
  sessionId: string | null
  steps: number
  modelToolCalls: number
  toolErrors: number
  usage: Record<string, number | null>
  final: string | null
  errors: string[]
}
const USAGE = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

/** Synthetic records retain the columns used by the real process-log analysis task. */
export function makeTask(family: string, rows: number): BenchTask {
  if (!['total', 'groups', 'peak', 'window'].includes(family) || !Number.isSafeInteger(rows) || rows < 4) throw new Error('无效的评测任务')
  const names = ['worker', 'browser', 'database', 'editor']
  const records = Array.from({ length: rows }, (_, i) => ({
    timestamp: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    interval_seconds: 60, pid: 200 + i % 8, start_time: Math.floor(i / 120) * 120,
    executable: names[i % names.length]!, cpu_delta_seconds: (i * 7 + 3) % 17,
    rss_kib: 65536 + (i * 997) % 524288,
  }))
  const fields = Object.keys(records[0]!) as Array<keyof typeof records[number]>
  const chunks = rows > 24 ? 3 : 1
  const files: Record<string, string> = {}
  for (let part = 0; part < chunks; part++) {
    const slice = records.slice(Math.floor(part * rows / chunks), Math.floor((part + 1) * rows / chunks))
    files[`records/part-${part + 1}.csv`] = `${fields.join(',')}\n${slice.map(row => fields.map(key => row[key]).join(',')).join('\n')}\n`
  }
  let question: string
  let expected: unknown
  if (family === 'total') {
    question = '统计全部 CSV 的样本总数和 cpu_delta_seconds 总和。answer.json 的格式是 {"samples":整数,"cpu_seconds":整数}。'
    expected = { samples: records.length, cpu_seconds: records.reduce((sum, row) => sum + row.cpu_delta_seconds, 0) }
  } else if (family === 'groups') {
    question = '按 executable 汇总 cpu_delta_seconds，并计算各自最大的 rss_kib。answer.json 格式为 {"groups":[{"name":字符串,"cpu_seconds":整数,"peak_rss_kib":整数}]}，groups 按 name 升序排列。'
    expected = { groups: [...names].sort().map(name => {
      const selected = records.filter(row => row.executable === name)
      return { name, cpu_seconds: selected.reduce((sum, row) => sum + row.cpu_delta_seconds, 0), peak_rss_kib: Math.max(...selected.map(row => row.rss_kib)) }
    }) }
  } else if (family === 'peak') {
    question = '找出全部 CSV 中 rss_kib 最高的那一条；相同时取 timestamp 最早的。将这条记录完整写入 answer.json，timestamp 和 executable 为字符串，其余字段为数字。'
    expected = records.reduce((best, row) => row.rss_kib > best.rss_kib ? row : best)
  } else {
    const start = records[Math.floor(rows / 3)]!.timestamp
    const end = records[Math.floor(rows * 2 / 3)]!.timestamp
    question = `仅统计 timestamp 在 ${start}（含）到 ${end}（不含）范围内的记录。answer.json 格式为 {"samples":整数,"cpu_seconds":整数,"peak_rss_kib":整数}。`
    const selected = records.filter(row => row.timestamp >= start && row.timestamp < end)
    expected = { samples: selected.length, cpu_seconds: selected.reduce((sum, row) => sum + row.cpu_delta_seconds, 0), peak_rss_kib: Math.max(...selected.map(row => row.rss_kib)) }
  }
  return { id: `${family}-${rows}`, family, rows, files, expected,
    prompt: `这是一个进程资源日志分析任务。数据均为生成的测试数据。只处理当前工作目录内的 records/*.csv，保留输入文件原样，不访问目录外的数据。${question}必须实际读取数据并完成计算，不能只给脚本或方案。将答案写入当前目录的 answer.json，最后简短说明完成情况。` }
}

export const taskIds = () => [24, 600, 12000].flatMap(rows => ['total', 'groups', 'peak', 'window'].map(family => `${family}-${rows}`))
export function taskById(id: string): BenchTask {
  const found = /^(total|groups|peak|window)-(24|600|12000)$/.exec(id)
  if (!found) throw new Error(`未知任务：${id}`)
  return makeTask(found[1]!, Number(found[2]))
}

/** Missing usage stays null; malformed, incomplete or failed streams never count as successful runs. */
export function parseRunEvents(text: string): RunMetrics {
  const metrics: RunMetrics = { complete: false, sessionId: null, steps: 0, modelToolCalls: 0, toolErrors: 0,
    usage: Object.fromEntries(USAGE.map(key => [key, null])), final: null, errors: [] }
  let finals = 0
  let completed = false
  let usageSteps = 0
  const coverage: Record<string, number> = {}
  for (const line of text.split('\n').filter(line => line.trim())) {
    let event: Record<string, any>
    try { event = JSON.parse(line) } catch { metrics.errors.push('运行输出包含不完整的 JSON 行'); continue }
    if (event.type === 'session') metrics.sessionId = typeof event.sessionId === 'string' ? event.sessionId : null
    if (event.type === 'tool_call') metrics.modelToolCalls++
    if (event.type === 'tool_result' && event.status !== 'completed') {
      metrics.toolErrors++
      if (/dsh-python-repl: (没找到能用的 Python|建 Python 内核的专用环境失败)/.test(String(event.result))) metrics.errors.push('评测环境未能启动 Python 内核')
      if (/no sandbox backend is usable|sandbox_apply: Operation not permitted/.test(String(event.result))) metrics.errors.push('评测环境的命令执行隔离不可用')
    }
    if (event.type === 'error') metrics.errors.push(String(event.message ?? '运行错误'))
    if (event.type === 'status' && event.phase === 'step_end') {
      metrics.steps++
      usageSteps++
      for (const key of USAGE) {
        const value = event.usage?.[key]
        if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
          metrics.usage[key] = (metrics.usage[key] ?? 0) + value
          coverage[key] = (coverage[key] ?? 0) + 1
        }
      }
    }
    if (event.type === 'status' && event.phase === 'turn_end') {
      const reason = typeof event.reason === 'string' ? event.reason : event.reason?.kind
      if (reason !== 'completed') metrics.errors.push(`执行未完成：${String(reason)}`)
      else completed = true
    }
    if (event.type === 'final') { finals++; metrics.final = typeof event.text === 'string' ? event.text : null }
    if (event.truncated && ['session', 'final', 'status'].includes(String(event.type))) metrics.errors.push('关键运行事件被截断')
  }
  for (const key of USAGE) if (!usageSteps || coverage[key] !== usageSteps) metrics.usage[key] = null
  metrics.complete = finals === 1 && completed && metrics.sessionId !== null && !metrics.errors.length
  return metrics
}

export async function gradeTask(task: BenchTask, work: string): Promise<{ passed: boolean; reasons: string[] }> {
  const reasons: string[] = []
  for (const [name, content] of Object.entries(task.files)) {
    try { if (sha(await readFile(join(work, name), 'utf8')) !== sha(content)) reasons.push(`输入被改动：${name}`) }
    catch { reasons.push(`输入已丢失：${name}`) }
  }
  try {
    const actual = JSON.parse(await readFile(join(work, 'answer.json'), 'utf8'))
    if (!isDeepStrictEqual(actual, task.expected)) reasons.push('答案与独立验收结果不一致')
  } catch (error) { reasons.push(`答案缺失或不是合法 JSON：${error instanceof Error ? error.message : String(error)}`) }
  return { passed: reasons.length === 0, reasons }
}

export interface BenchRun {
  task: string; mode: string; variant: string; provider: string; model: string; inputHash: string
  valid: boolean; passed: boolean; elapsedMs: number; metrics: RunMetrics; appBuild: string; runtimeDigest?: string | null; isolation?: string
}

/** Comparison uses identical inputs and only jointly correct tasks for efficiency figures. */
export function summarizeRuns(runs: BenchRun[]) {
  if (!runs.length || runs.some(run => typeof run.valid !== 'boolean' || typeof run.passed !== 'boolean' || !run.metrics || typeof run.metrics.steps !== 'number')) throw new Error('结果缺少实际运行记录，不能用准备数据代替评测')
  const variants = [...new Set(runs.map(run => `${run.variant}-${run.mode}`))].sort()
  const models = new Set(runs.map(run => JSON.stringify([run.provider, run.model])))
  if (models.size !== 1) throw new Error('不同模型的结果必须分开统计')
  if (new Set(runs.map(run => run.appBuild)).size !== 1) throw new Error('不同 App 构建的结果不能直接比较')
  if (new Set(runs.map(run => run.isolation ?? null)).size !== 1) throw new Error('不同隔离配置的结果不能直接比较')
  for (const key of variants) {
    const fingerprints = new Set(runs.filter(run => `${run.variant}-${run.mode}` === key).map(run => run.runtimeDigest ?? null))
    if (fingerprints.size !== 1) throw new Error(`同一版本的运行代码发生了变化：${key}`)
  }
  const tasks = new Map<string, Map<string, BenchRun>>()
  for (const run of runs) {
    const group = tasks.get(run.task) ?? new Map<string, BenchRun>()
    const key = `${run.variant}-${run.mode}`
    if (group.has(key)) throw new Error(`任务重复：${run.task} ${key}`)
    if ([...group.values()].some(other => other.inputHash !== run.inputHash)) throw new Error(`输入不一致：${run.task}`)
    group.set(key, run); tasks.set(run.task, group)
  }
  const comparable = [...tasks.entries()].filter(([, group]) => group.size === variants.length && [...group.values()].every(run => run.valid && run.passed)).map(([task]) => task)
  return { model: runs[0] ? `${runs[0].provider}/${runs[0].model}` : null, jointlyPassedTasks: comparable,
    groups: variants.map(key => {
      const selected = runs.filter(run => `${run.variant}-${run.mode}` === key)
      const paired = selected.filter(run => comparable.includes(run.task))
      const tokenValues = paired.map(run => run.metrics.usage.totalTokens)
      return { variant: key, attempted: selected.length, valid: selected.filter(run => run.valid).length,
        passed: selected.filter(run => run.valid && run.passed).length,
        comparable: paired.length, totalTokensOnComparable: paired.length && tokenValues.every(value => value != null) ? tokenValues.reduce<number>((sum, value) => sum + value!, 0) : null,
        totalMsOnComparable: paired.length ? paired.reduce((sum, run) => sum + run.elapsedMs, 0) : null,
        stepsOnComparable: paired.length ? paired.reduce((sum, run) => sum + run.metrics.steps, 0) : null }
    }) }
}

async function runtimeDigest(pluginRoot: string) {
  const parts: string[] = []
  const scan = async (relative: string): Promise<void> => {
    for (const entry of (await readdir(join(pluginRoot, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = join(relative, entry.name)
      if (entry.isDirectory() && entry.name !== '__pycache__') await scan(name)
      else if (entry.isFile() && entry.name.endsWith('.py')) parts.push(`${name}:${sha(await readFile(join(pluginRoot, name), 'utf8'))}`)
    }
  }
  parts.push(`lib/index.js:${sha(await readFile(join(pluginRoot, 'lib/index.js'), 'utf8'))}`)
  await scan('python'); await scan('vendor')
  return sha(parts.join('\n'))
}

export interface BenchOptions {
  output: string; app: string; credentials: string; baseUrl: string; keyRef: string
  provider: string; model: string; api: string; pluginRoot: string; kernelVenv: string
  mode: 'native' | 'ptc'; variant: string; timeoutMs: number; tasks: string[]; dryRun: boolean
}

async function execute(file: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, input: string, timeoutMs: number) {
  const started = performance.now()
  let stdout = '', stderr = '', timedOut = false, spawnError: string | null = null
  const child = spawn(file, args, { env, cwd, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const stop = (signal: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, signal) } catch {} }
  let cancelled = false
  let cancelKill: ReturnType<typeof setTimeout> | undefined
  const cancel = () => { cancelled = true; stop('SIGTERM'); cancelKill ??= setTimeout(() => stop('SIGKILL'), 3000) }
  process.once('SIGTERM', cancel); process.once('SIGINT', cancel)
  const timer = setTimeout(() => { timedOut = true; stop('SIGTERM') }, timeoutMs)
  const hard = setTimeout(() => stop('SIGKILL'), timeoutMs + 3000)
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
  child.stdout.on('data', value => { stdout += value })
  child.stderr.on('data', value => {
    stderr += value
    if (/entr(?:y|ies) did not activate|slot entry crashed/.test(stderr)) {
      stop('SIGTERM'); cancelKill ??= setTimeout(() => stop('SIGKILL'), 3000)
    }
  })
  child.stdin.on('error', () => {})
  child.stdin.end(input)
  const exitCode = await new Promise<number | null>(done => {
    child.on('error', error => { spawnError = error.message })
    child.on('close', code => done(code))
  })
  clearTimeout(timer); clearTimeout(hard); clearTimeout(cancelKill); stop('SIGKILL')
  process.removeListener('SIGTERM', cancel); process.removeListener('SIGINT', cancel)
  return { exitCode, timedOut, cancelled, spawnError, elapsedMs: Math.round(performance.now() - started), stdout, stderr }
}

export async function runBenchmark(options: BenchOptions) {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000) throw new Error('超时必须为至少 1000 毫秒的整数')
  if (!['native', 'ptc'].includes(options.mode)) throw new Error('模式必须为 native 或 ptc')
  if (!/^[a-z0-9][a-z0-9-]*$/.test(options.variant)) throw new Error('版本标签只能使用小写字母、数字和短横线')
  const runRoot = resolve(options.output, `${options.variant}-${options.mode}`)
  await mkdir(dirname(runRoot), { recursive: true, mode: 0o700 })
  await mkdir(runRoot, { mode: 0o700 })
  let pluginRoot = resolve(options.pluginRoot)
  let fingerprint: string | null = null
  if (!options.dryRun && options.mode === 'ptc') {
    const original = await runtimeDigest(pluginRoot)
    const staged = join(runRoot, 'runtime')
    await mkdir(join(staged, 'lib'), { recursive: true })
    await cp(join(pluginRoot, 'lib/index.js'), join(staged, 'lib/index.js'))
    await cp(join(pluginRoot, 'package.json'), join(staged, 'package.json'))
    for (const directory of ['python', 'vendor']) await cp(join(pluginRoot, directory), join(staged, directory), { recursive: true })
    await symlink(await realpath(join(pluginRoot, 'node_modules')), join(staged, 'node_modules'))
    fingerprint = await runtimeDigest(staged)
    if (fingerprint !== original || await runtimeDigest(pluginRoot) !== original) throw new Error('准备评测期间插件内容发生了变化，请在构建完成后重新运行')
    pluginRoot = staged
  }
  const appBuild = options.dryRun ? null : sha(await readFile(join(options.app, 'Contents/Info.plist'), 'utf8'))
  const results: unknown[] = []
  for (const id of options.tasks) {
    const task = taskById(id)
    const root = join(runRoot, id)
    const work = join(root, 'work')
    const home = join(root, 'home')
    const profile = join(home, 'profiles', 'headless')
    await mkdir(profile, { recursive: true, mode: 0o700 })
    await mkdir(work, { recursive: true })
    for (const [name, content] of Object.entries(task.files)) {
      await mkdir(dirname(join(work, name)), { recursive: true })
      await writeFile(join(work, name), content)
    }
    await writeFile(join(root, 'prompt.txt'), task.prompt)
    const inputHash = sha(JSON.stringify(task.files))
    if (options.dryRun) { results.push({ task: id, inputHash, prepared: true }); continue }
    const patch: unknown[] = [
      { id: 'credentials', disabled: false, config: { path: resolve(options.credentials), watch: false } },
      { id: 'agent-default-model', config: { provider: options.provider, model: options.model } },
      { id: 'llm-pi-ai', config: { providers: { [options.provider]: { apiKeyEnv: options.keyRef, api: options.api, baseURL: options.baseUrl,
        models: [{ id: options.model, name: options.model, contextWindow: 1000000, maxTokens: 16384, input: ['text'] }] } } } },
      { id: 'tools', config: { mode: options.mode } },
      { id: 'permission', config: { defaultPreset: 'danger-full-access' } },
      ...['session-title-llm', 'agent-instructions', 'tool-skill', 'workflow-ptc', 'tool-workflow', 'tool-web', 'tool-subagent', 'tool-subagent-fork', 'tool-goal', 'tool-todo'].map(id => ({ id, disabled: true })),
    ]
    if (options.mode === 'ptc') {
      const venvRoot = join(home, 'plugins', 'python-repl', 'kernel-venv')
      await mkdir(dirname(venvRoot), { recursive: true })
      await symlink(await realpath(options.kernelVenv), venvRoot)
      const marker = JSON.parse(await readFile(join(options.kernelVenv, '3.14', '.dsh-kernel-env.json'), 'utf8')) as { base?: string }
      if (!marker.base) throw new Error('现有内核缺少解释器记录，不能在评测时临时安装')
      await stat(marker.base)
      patch.push({ id: 'ptc-runtime', disabled: true }, { insert: [{ id: 'python-repl', name: resolve(pluginRoot, 'lib/index.js'), config: { python: marker.base, skillRoots: [], projectSkillRoots: [] } }] })
    }
    await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } } }))
    await writeFile(join(profile, 'cordis.yml'), '[]\n')
    await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify(patch, null, 2))
    const sandbox = join(root, 'sandbox.sb')
    await writeFile(sandbox, `(version 1)(allow default)(deny file-write*)(allow file-write* (subpath ${JSON.stringify(await realpath(root))}) (literal "/dev/null"))`)
    const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', TMPDIR: root, PYTHONDONTWRITEBYTECODE: '1' }
    delete env.ELECTRON_RUN_AS_NODE; delete env.DSH_WEB_URL; delete env.DSH_TOOLS_MODE
    const execution = await execute('/usr/bin/sandbox-exec', ['-f', sandbox, join(options.app, 'Contents/Resources/runtime/cli/bin/dsh'), 'headless', '--json', '-'], env, work, task.prompt, options.timeoutMs)
    await writeFile(join(root, 'events.jsonl'), execution.stdout, { mode: 0o600, flag: 'wx' })
    await writeFile(join(root, 'stderr.txt'), execution.stderr, { mode: 0o600, flag: 'wx' })
    const metrics = parseRunEvents(execution.stdout)
    const grade = await gradeTask(task, work)
    const invalid: string[] = []
    if (execution.exitCode !== 0) invalid.push(`进程退出码 ${execution.exitCode}`)
    if (execution.timedOut) invalid.push('运行超时')
    if (execution.cancelled) invalid.push('评测已取消')
    if (execution.spawnError) invalid.push(execution.spawnError)
    if (!metrics.complete) invalid.push('没有收到完整且成功的执行终态')
    if (/entr(?:y|ies) did not activate|slot entry crashed/.test(execution.stderr)) invalid.push('评测宿主有未激活的插件')
    const result = { task: id, family: task.family, rows: task.rows, mode: options.mode, variant: options.variant,
      provider: options.provider, model: options.model, runtimeDigest: fingerprint, appBuild, isolation: 'outer-os-write-boundary-v1', inputHash, elapsedMs: execution.elapsedMs,
      valid: invalid.length === 0, passed: invalid.length === 0 && grade.passed, reasons: [...invalid, ...metrics.errors, ...grade.reasons], metrics }
    results.push(result)
    await writeFile(join(root, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600, flag: 'wx' })
    console.log(JSON.stringify({ task: id, mode: options.mode, variant: options.variant, passed: result.passed, valid: result.valid, elapsedMs: result.elapsedMs, steps: metrics.steps, totalTokens: metrics.usage.totalTokens, reasons: result.reasons }))
    if (!result.valid) break
  }
  await writeFile(join(runRoot, 'results.json'), JSON.stringify({ format: 1, source: 'adapted-synthetic-process-logs', options: { ...options, credentials: '[existing read-only reference]' }, results }, null, 2), { mode: 0o600, flag: 'wx' })
  return results
}

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean' }, reports: { type: 'string', multiple: true }, matrix: { type: 'boolean' }, 'baseline-root': { type: 'string' }, output: { type: 'string' }, app: { type: 'string', default: '/Applications/DeepSeek Harness.app' },
    credentials: { type: 'string', default: join(homedir(), '.dsh', '.credentials.yaml') }, 'base-url': { type: 'string' }, 'key-ref': { type: 'string' },
    provider: { type: 'string' }, model: { type: 'string' }, api: { type: 'string', default: 'openai-completions' },
    'plugin-root': { type: 'string', default: resolve(dirname(fileURLToPath(import.meta.url)), '..') },
    'kernel-venv': { type: 'string', default: join(homedir(), '.dsh/plugins/python-repl/kernel-venv') },
    mode: { type: 'string', default: 'ptc' }, variant: { type: 'string', default: 'current' }, timeout: { type: 'string', default: '180000' },
    tasks: { type: 'string' }, 'dry-run': { type: 'boolean', default: false },
  } })
  if (values.help) {
    console.log('用法：node scripts/benchmark.ts --output <新目录> --provider <线路> --model <模型> --base-url <网关> --key-ref <凭据引用名> [--mode ptc|native] [--variant current|baseline] [--tasks total-24,groups-600] [--plugin-root <已构建插件>] [--timeout 180000] [--dry-run]\n每个版本和模式只运行一次，已存在的输出目录拒绝覆盖。轮换版本顺序：--matrix [--baseline-root <已构建旧插件>]。合并结果：--reports <results.json>，可重复传入。默认生成十二个日志分析任务。--dry-run 只准备生成数据，不调用模型。密钥仅由宿主读取既有凭据，不复制、不打印。')
    return
  }
  if (values.reports?.length) {
    const runs: BenchRun[] = []
    for (const file of values.reports) {
      const report = JSON.parse(await readFile(file, 'utf8')) as { results: BenchRun[] }
      runs.push(...report.results)
    }
    console.log(JSON.stringify(summarizeRuns(runs), null, 2)); return
  }
  if (!values.output || (!values['dry-run'] && (!values.provider || !values.model || !values['base-url'] || !values['key-ref']))) throw new Error('缺少输出目录或模型连接参数，先运行 --help')
  const tasks = values.tasks ? values.tasks.split(',') : taskIds()
  if (new Set(tasks).size !== tasks.length) throw new Error('任务不能重复')
  for (const id of tasks) taskById(id)
  if (!values['dry-run']) {
    if (process.platform !== 'darwin') throw new Error('这份启动器需要 macOS sandbox-exec；其他平台尚未实现')
    await stat(join(values.app!, 'Contents/Resources/runtime/cli/bin/dsh'))
  }
  const options: BenchOptions = { output: values.output, app: values.app!, credentials: values.credentials!, baseUrl: values['base-url'] ?? '', keyRef: values['key-ref'] ?? '',
    provider: values.provider ?? '', model: values.model ?? '', api: values.api!, pluginRoot: values['plugin-root']!, kernelVenv: values['kernel-venv']!,
    mode: values.mode as 'native' | 'ptc', variant: values.variant!, timeoutMs: Number(values.timeout), tasks, dryRun: values['dry-run']! }
  let results: unknown[] = []
  if (values.matrix) {
    await mkdir(dirname(resolve(options.output)), { recursive: true, mode: 0o700 })
    await mkdir(resolve(options.output), { mode: 0o700 })
    const variants: Array<Pick<BenchOptions, 'mode' | 'variant' | 'pluginRoot'>> = [
      { mode: 'native', variant: 'current', pluginRoot: options.pluginRoot },
      { mode: 'ptc', variant: 'current', pluginRoot: options.pluginRoot },
    ]
    if (values['baseline-root']) variants.push({ mode: 'ptc', variant: 'baseline', pluginRoot: resolve(values['baseline-root']) })
    for (let index = 0; index < tasks.length; index++) {
      const id = tasks[index]!
      const start = index % variants.length
      for (const variant of [...variants.slice(start), ...variants.slice(0, start)]) {
        const batch = await runBenchmark({ ...options, ...variant, output: join(options.output, id), tasks: [id] })
        results.push(...batch)
        if (batch.some(result => (result as { valid?: boolean }).valid === false)) throw new Error('评测环境无效，已停止后续模型调用；原始结果已保留')
      }
    }
    await writeFile(join(options.output, 'results.json'), JSON.stringify({ format: 1, source: 'adapted-synthetic-process-logs', results }, null, 2), { mode: 0o600, flag: 'wx' })
  } else results = await runBenchmark(options)
  if (results.some(result => (result as { passed?: boolean }).passed === false)) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 })
