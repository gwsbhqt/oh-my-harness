import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { live } from '../runtime/live.mjs'
import { reminderSummary, reminderText } from '../runtime/notice.mjs'
import { stringListField } from '../runtime/fields.mjs'
import { createCardController } from '../runtime/card.mjs'
import { createRouteRegistry } from '../runtime/routes.mjs'
import { createMethodPatcher } from '../runtime/method-patch.mjs'
import { LineReader } from '../runtime/line-reader.mjs'
import { ownerGateway } from '../runtime/gateway.mjs'
import { formatPreferences, preferencesPath, readPreferences, readSection, writeSection } from '../runtime/preferences.mjs'

test('共享路由保持逐条构造登记、标签和注册失败透传', () => {
  const registerRoutes = createRouteRegistry()
  const order = [], cleanup = []
  function* routes() {
    order.push('构造一'); yield { path: '/one' }
    order.push('构造二'); yield { path: '/two' }
  }
  registerRoutes((install, label) => { order.push(label); cleanup.push(install()) },
    route => { order.push(route.path); return () => order.push(`卸载${route.path}`) },
    routes, route => `登记${route.path}`)
  assert.deepEqual(order, ['构造一', '登记/one', '/one', '构造二', '登记/two', '/two'])
  const error = new Error('register failed')
  assert.throws(() => registerRoutes(install => install(), () => { throw error },
    () => [{ path: '/new' }], route => route.path), value => value === error)
  assert.deepEqual(order.slice(-2), ['卸载/one', '卸载/two'])
  cleanup.forEach(dispose => dispose())
  assert.deepEqual(order.slice(-2), ['卸载/one', '卸载/two'])
})

test('共享现读保留裸值、接收者、每次读取与异常', () => {
  const cell = { value: 1, get() { return this.value } }
  assert.equal(live(cell), 1)
  cell.value = 2
  assert.equal(live(cell), 2)
  for (const value of [null, undefined, false, 0, '', [], { get: 3 }]) assert.equal(live(value), value)
  const error = new Error('read failed')
  assert.throws(() => live({ get() { throw error } }), value => value === error)
})

test('共享提醒格式统一为 system-reminder、来源和中文标题', () => {
  assert.equal(reminderText('dsh-x', 'One-line headline', 'Body'), '<system-reminder>\n[dsh-x] One-line headline\n\nBody\n</system-reminder>')
  assert.equal(reminderText('dsh-x', 'Headline only'), '<system-reminder>\n[dsh-x] Headline only\n</system-reminder>')
  assert.equal(reminderText('dsh-x', 'Headline', 'A body containing </system-reminder> must not end the frame early'), '<system-reminder>\n[dsh-x] Headline\n\nA body containing <\\/system-reminder> must not end the frame early\n</system-reminder>')
  assert.equal(reminderSummary('dsh-x', ' 一句话\n标题 '), '[dsh-x] 一句话 标题')
})

test('共享英文逗号列表保持空白、重复、顺序与无效输入', () => {
  const spec = stringListField('list')
  assert.equal(spec.field, 'list')
  assert.deepEqual(spec.parse('  '), { kind: 'clear' })
  assert.equal(spec.parse(' , , '), undefined)
  assert.deepEqual(spec.parse(' B, A, B '), { kind: 'set', value: ['B', 'A', 'B'] })
  assert.deepEqual(spec.parse('A，B'), { kind: 'set', value: ['A，B'] })
  assert.equal(spec.format(['B', 'A', 'B']), 'B, A, B')
  assert.equal(spec.format(null), '')
})

test('共享卡片桥接保留投影、hook、动作与卸载时序', () => {
  let disposed = 0
  let project
  const field = { text: '1' }
  const actions = { save() {} }
  const form = {
    shell: () => ({ writable: true }),
    field: name => { assert.equal(name, 'value'); return field },
    actions: () => actions,
    dispose: () => { disposed++ },
  }
  const store = {}
  const card = createCardController(form, [{ field: 'value' }], 'existingHook', projection => {
    project = projection
    return store
  })
  assert.deepEqual(project(), { writable: true, value: field })
  assert.equal(card.form, form)
  assert.equal(card.store, store)
  assert.equal(card.inject().hooks.existingHook, store)
  assert.equal(card.inject().save, actions.save)
  assert.equal(disposed, 0)
  card.dispose()
  assert.equal(disposed, 1)
})

test('共享网关每次调用都带同一个本机所有者 Peer，其余字段原样转交', async () => {
  const created = [], seen = []
  const gateway = ownerGateway({
    invoke: async request => { seen.push(request); return 'ok' },
    stream: async request => { seen.push(request); return (async function* () {})() },
  }, { createPeer: options => { const peer = { options }; created.push(peer); return peer } })
  const signal = new AbortController().signal
  assert.equal(await gateway.invoke({ namespace: 'session', method: 'list', args: {}, signal }), 'ok')
  await gateway.stream({ namespace: 'workspace', method: 'follow', args: { id: 'a' } })
  assert.deepEqual(created, [{ options: { principal: { kind: 'owner' } } }])
  assert.equal(seen[0].peer, created[0])
  assert.equal(seen[1].peer, created[0])
  assert.equal(seen[0].signal, signal)
  assert.deepEqual(seen[1].args, { id: 'a' })
})

test('共用偏好文件：默认位置、缺文件与坏内容', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prefs-'))
  const previousHome = process.env['DSH_HOME']
  const previousFile = process.env['DSH_PREFERENCES_FILE']
  try {
    delete process.env['DSH_PREFERENCES_FILE']
    process.env['DSH_HOME'] = dir
    assert.equal(preferencesPath(), join(dir, 'preferences.json'))
    process.env['DSH_PREFERENCES_FILE'] = join(dir, 'custom.json')
    assert.equal(preferencesPath(), join(dir, 'custom.json'))

    const missing = readPreferences(join(dir, 'missing.json'))
    assert.equal(missing.exists, false)
    assert.deepEqual(missing.raw, {})
    assert.equal(missing.error, undefined)

    const bad = join(dir, 'bad.json')
    writeFileSync(bad, 'not json')
    assert.match(readPreferences(bad).error ?? '', /不是合法内容/)
    writeFileSync(bad, '{"version":2}')
    assert.match(readPreferences(bad).error ?? '', /不认识的版本/)
  } finally {
    if (previousHome === undefined) delete process.env['DSH_HOME']
    else process.env['DSH_HOME'] = previousHome
    if (previousFile === undefined) delete process.env['DSH_PREFERENCES_FILE']
    else process.env['DSH_PREFERENCES_FILE'] = previousFile
    rmSync(dir, { recursive: true, force: true })
  }
})

test('共用偏好文件：各段合并写回、未知字段保留、顺序稳定', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prefs-'))
  const path = join(dir, 'preferences.json')
  try {
    writeFileSync(path, JSON.stringify({ version: 1, quickReplies: { presets: ['a'], action: 'send' }, custom: { keep: true } }))
    await writeSection('modelTiers', { tiers: { main: [], light: [] }, quotas: {}, reservePercent: 10 }, path)
    assert.deepEqual(readSection('modelTiers', path).value, { tiers: { main: [], light: [] }, quotas: {}, reservePercent: 10 })
    assert.deepEqual(readSection('quickReplies', path).value, { presets: ['a'], action: 'send' })
    assert.deepEqual(readSection('custom', path).value, { keep: true })
    assert.equal(readFileSync(path, 'utf8'), formatPreferences({
      version: 1,
      modelTiers: { tiers: { main: [], light: [] }, quotas: {}, reservePercent: 10 },
      quickReplies: { presets: ['a'], action: 'send' },
      custom: { keep: true },
    }))

    await writeSection('presetPreferences', { projects: { '~/example-project': 'cordis' } }, path)
    assert.deepEqual(readSection('presetPreferences', path).value, { projects: { '~/example-project': 'cordis' } })
    assert.deepEqual(readSection('quickReplies', path).value, { presets: ['a'], action: 'send' }, '写别的段不能丢快捷回复')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('共用偏好文件：同一进程里几段同时保存，各段都留下且不互相踩临时文件', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prefs-'))
  const path = join(dir, 'preferences.json')
  try {
    writeFileSync(path, formatPreferences({ version: 1, custom: { keep: true } }))
    const results = await Promise.allSettled([
      writeSection('modelTiers', { tiers: { main: [], light: [] }, quotas: {}, reservePercent: 10 }, path),
      writeSection('presetPreferences', { projects: { '~/example-project': 'cordis' } }, path),
      writeSection('quickReplies', { presets: ['x'], action: 'send' }, path),
    ])
    assert.deepEqual(results.map(result => result.status), ['fulfilled', 'fulfilled', 'fulfilled'])
    assert.deepEqual(readSection('modelTiers', path).value, { tiers: { main: [], light: [] }, quotas: {}, reservePercent: 10 })
    assert.deepEqual(readSection('presetPreferences', path).value, { projects: { '~/example-project': 'cordis' } })
    assert.deepEqual(readSection('quickReplies', path).value, { presets: ['x'], action: 'send' })
    assert.deepEqual(readSection('custom', path).value, { keep: true })
    assert.deepEqual(readdirSync(dir), ['preferences.json'], '不留临时文件')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('共用偏好文件：路径是符号链接时写真实文件，链接保留', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'prefs-'))
  try {
    const real = join(dir, 'preferences.main.json')
    const link = join(dir, 'preferences.json')
    writeFileSync(real, formatPreferences({ version: 1, presetPreferences: { projects: {} } }))
    symlinkSync(real, link)
    await writeSection('quickReplies', { presets: ['x'], action: 'send' }, link)
    assert.equal(readFileSync(link, 'utf8'), readFileSync(real, 'utf8'))
    assert.match(readFileSync(real, 'utf8'), /"quickReplies"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('共享就地补丁按原型取原实现、乱序重载不叠层、别人后包时变直通、按插件名隔离', () => {
  class Host { greet(name) { return `hi ${name}` } }
  const host = new Host()
  const install = createMethodPatcher('dsh-test-a')
  const wrapUpper = suffix => original => function (name) { return original.call(this, name).toUpperCase() + suffix }

  assert.equal(install(host, 'missing', original => original), undefined)
  assert.equal(Object.hasOwn(host, 'missing'), false)

  const first = install(host, 'greet', wrapUpper('1'))
  assert.equal(host.greet('a'), 'HI A1')
  const second = install(host, 'greet', wrapUpper('2'))
  assert.equal(host.greet('a'), 'HI A2', '新层接在旧层下面，不叠两次')
  first()
  assert.equal(host.greet('a'), 'HI A2', '旧层后卸不拆新层')
  second()
  assert.equal(Object.hasOwn(host, 'greet'), false, '卸下后原型方法重新露出')
  assert.equal(host.greet('a'), 'hi a')

  const own = { greet(name) { return `own ${name}` } }
  const ownDescriptor = Object.getOwnPropertyDescriptor(own, 'greet')
  const undoOwn = install(own, 'greet', wrapUpper('!'))
  assert.equal(own.greet('b'), 'OWN B!')
  undoOwn()
  assert.deepEqual(Object.getOwnPropertyDescriptor(own, 'greet'), ownDescriptor, '自有属性原样换回')

  const mine = install(host, 'greet', wrapUpper('3'))
  const below = Object.getOwnPropertyDescriptor(host, 'greet').value
  const other = function (name) { return `[${below.call(this, name)}]` }
  Object.defineProperty(host, 'greet', { value: other, writable: true, configurable: true })
  mine()
  assert.equal(host.greet('c'), '[hi c]', '自己那层变直通，别人那层不动')
  assert.equal(Object.getOwnPropertyDescriptor(host, 'greet').value, other)
  delete host.greet

  const undoA = install(host, 'greet', wrapUpper('a'))
  const undoB = createMethodPatcher('dsh-test-b')(host, 'greet', wrapUpper('b'))
  assert.equal(host.greet('d'), 'HI DAb', '别的插件的层不当成自己的旧层')
  undoB()
  undoA()
  assert.equal(Object.hasOwn(host, 'greet'), false)
})

test('共享按行读流：多字节跨 chunk 不裂、去掉 \\r、半行留到下一批、结束交出末行、错误透传', async () => {
  const lines = [], errors = []
  const reader = new LineReader(line => lines.push(line), error => errors.push(error))
  reader.attach(undefined)
  const stream = new PassThrough()
  reader.attach(stream)
  const han = Buffer.from('汉字\r\n半', 'utf8')
  stream.write(han.subarray(0, 1))
  stream.write(han.subarray(1, 4))
  assert.deepEqual(lines, [])
  stream.write(han.subarray(4))
  assert.deepEqual(lines, ['汉字'])
  stream.write(Buffer.from('行\n\n末尾'))
  assert.deepEqual(lines, ['汉字', '半行', ''])
  const ended = new Promise(resolve => stream.on('end', resolve))
  stream.end()
  stream.resume()
  await ended
  assert.deepEqual(lines, ['汉字', '半行', '', '末尾'])
  assert.equal(reader.takeCarry(), '')

  const broken = new PassThrough()
  reader.attach(broken)
  const error = new Error('stream failed')
  broken.destroy(error)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(errors, [error])
})
