import assert from 'node:assert/strict'
import { linkSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'

const home = mkdtempSync(join(tmpdir(), 'prompt-prefix-'))
process.env['DSH_HOME'] = home
writeFileSync(join(home, 'AGENTS.md'), 'global rules')
const workspace = join(home, 'ws')
mkdirSync(join(workspace, 'nested'), { recursive: true })
symlinkSync(join(home, 'AGENTS.md'), join(workspace, 'nested', 'AGENTS.md'))

const { apply, pointer, pinKey, PinStore, stripListing, PINNED_ORIGINALS } = await import('../src/index.ts')

class SystemPrompt extends Service {
  constructor(ctx: Context) { super(ctx, 'systemPrompt') }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const msg = (text: string, source?: Record<string, unknown>) => ({ role: 'user', content: [{ type: 'text', text }], ...(source ? { source } : {}) })
const BASELINE = '<system-reminder>rules for workspace</system-reminder>'
const PROFILE = '<openviking-context source="profile">\nprofile body\n<available-memories>\n  - a.md\n</available-memories>\n</openviking-context>'

function host(catalog: { text: string }) {
  const ctx = new Context()
  ctx.plugin(SystemPrompt)
  const on = (ctx as any).on.bind(ctx)
  on('agent/pre-step', async (_a: unknown, next: () => Promise<any>) => {
    const d = await next()
    return { ...d, messages: [...d.messages, msg(BASELINE, { kind: 'agent-instructions', form: 'instructions', baseline: true })] }
  })
  on('agent/pre-step', async (_a: unknown, next: () => Promise<any>) => {
    const d = await next()
    return { ...d, messages: [...d.messages, msg(catalog.text, { kind: 'skill-catalog', form: 'catalog' })] }
  })
  let profileSent = false
  on('agent/pre-step', async (_a: unknown, next: () => Promise<any>) => {
    const d = await next()
    if (profileSent) return d
    profileSent = true
    return { ...d, messages: [...d.messages, msg(PROFILE, { kind: 'plugin:openviking-memory', form: 'instructions' })] }
  }, { prepend: true })
  return ctx
}

async function step(ctx: Context, agent: object, user: string, extra: any[] = []) {
  const waterfall = (ctx as any).waterfall.bind(ctx)
  const assembly = await waterfall('system-prompt/assemble', { sections: [] }, { agent }, async () => ({ sections: [{ name: 'base', text: 'BASE' }] }))
  const decision = await waterfall('agent/pre-step', { agent, messages: [] }, async () => ({ kind: 'enter', messages: [msg(user), ...extra] }))
  return { prompt: assembly.sections.map((s: any) => s.text).join('\n'), messages: decision.messages }
}

test('pins stable injections into the system prompt and keeps them identical across steps', async () => {
  const catalog = { text: 'skills v1' }
  const ctx = host(catalog)
  ctx.plugin({ name: 'dsh-prompt-prefix', apply })
  await settle()
  const agent = { session: { id: 's1', header: { cwd: workspace } } }

  const first = await step(ctx, agent, 'hello')
  assert.match(first.prompt, /rules for workspace/)
  assert.match(first.prompt, /skills v1/)
  assert.match(first.prompt, /profile body/)
  assert.doesNotMatch(first.prompt, /available-memories/)
  assert.deepEqual(first.messages.map((m: any) => (m.content[0].text)), ['hello', pointer(pinKey('s1'))])

  const second = await step(ctx, agent, 'next')
  assert.equal(second.prompt, first.prompt)
  assert.deepEqual(second.messages.map((m: any) => m.content[0].text), ['next', pointer(pinKey('s1'))])

  catalog.text = 'skills v2'
  const third = await step(ctx, agent, 'after install')
  assert.match(third.prompt, /skills v2/)
  assert.doesNotMatch(third.prompt, /skills v1/)
  assert.ok(third.messages.some((m: any) => m.content[0].text === 'skills v2'))
  const fourth = await step(ctx, agent, 'next again')
  assert.equal(fourth.prompt, third.prompt)
})

test('drops a nested instruction message that re-delivers the global file', async () => {
  const ctx = host({ text: 'skills' })
  ctx.plugin({ name: 'dsh-prompt-prefix', apply })
  await settle()
  const agent = { session: { id: 's2', header: { cwd: workspace } } }
  await step(ctx, agent, 'hi')
  const dup = msg('global rules', { kind: 'agent-instructions', form: 'instructions', changes: [{ action: 'set', path: 'nested/AGENTS.md' }] })
  const other = msg('project rules', { kind: 'agent-instructions', form: 'instructions', changes: [{ action: 'set', path: 'other/AGENTS.md' }] })
  const out = await step(ctx, agent, 'read', [dup, other])
  const texts = out.messages.map((m: any) => m.content[0].text)
  assert.ok(!texts.includes('global rules'))
  assert.ok(texts.includes('project rules'))
})

test('a restarted host reloads the pin instead of re-capturing', async () => {
  const store = new PinStore(join(home, 'plugins', 'prompt-prefix', 'sessions'))
  const pin = store.get('s1')
  assert.equal(pin?.instructions, BASELINE)
  assert.equal(pin?.profile, stripListing(PROFILE))
  const ctx = host({ text: 'something else' })
  ctx.plugin({ name: 'dsh-prompt-prefix', apply })
  await settle()
  const out = await step(ctx, { session: { id: 's1', header: { cwd: workspace } } }, 'resumed')
  assert.match(out.prompt, /something else/)
  assert.doesNotMatch(out.prompt, /skills v2/)
  assert.ok(out.messages.some((m: any) => m.content[0].text === 'something else'))
  assert.ok(!out.messages.some((m: any) => /profile body/.test(m.content[0].text)))
})

test('恢复会话从可见历史取最新技能目录，即使宿主不重发', async () => {
  const store = new PinStore(join(home, 'plugins', 'prompt-prefix', 'sessions'))
  store.set('resumed-catalog', { v: 1, createdAt: Date.now(), catalog: { text: '旧技能', digest: 'old' } })
  const events = [
    { seq: 1, type: 'user/message', data: msg('新技能', { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'new', description: 'new' }] }) },
    { seq: 2, type: 'user/message', data: msg('不可见旧技能', { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'hidden', description: 'hidden' }] }) },
  ]
  let disposed = false
  class SessionQuery extends Service {
    constructor(ctx: Context) { super(ctx, 'sessionQuery') }
    async observeSession() { return { events, [Symbol.dispose]() { disposed = true } } }
  }
  const ctx = new Context()
  ctx.plugin(SystemPrompt)
  ctx.plugin(SessionQuery)
  ctx.plugin({ name: 'dsh-prompt-prefix', apply })
  await settle()
  const agent = { session: { id: 'resumed-catalog', header: { cwd: workspace }, surface: { nodes: [1] }, snapshotEvents: () => events } }
  const out = await step(ctx, agent, '继续')
  assert.match(out.prompt, /新技能/)
  assert.doesNotMatch(out.prompt, /旧技能/)
  assert.equal(disposed, true)
  assert.equal(new PinStore(join(home, 'plugins', 'prompt-prefix', 'sessions')).get('resumed-catalog')?.catalog?.text, '新技能')
})

test('恢复时会话查询失败，不把旧目录当作当前目录', async () => {
  new PinStore(join(home, 'plugins', 'prompt-prefix', 'sessions')).set('query-failed', {
    v: 1, createdAt: Date.now(), instructions: '保留规范', catalog: { text: '旧技能', digest: 'old' },
  })
  class SessionQuery extends Service {
    constructor(ctx: Context) { super(ctx, 'sessionQuery') }
    async observeSession() { throw new Error('查询失败') }
  }
  const ctx = new Context()
  ctx.plugin(SystemPrompt)
  ctx.plugin(SessionQuery)
  ctx.plugin({ name: 'dsh-prompt-prefix', apply })
  await settle()
  const out = await step(ctx, { session: { id: 'query-failed', surface: { nodes: [] } } }, '继续')
  assert.match(out.prompt, /保留规范/)
  assert.doesNotMatch(out.prompt, /旧技能/)
})

test('a fork that only inherits the pointer reuses the parent pin and system prompt', async () => {
  const ctx = host({ text: 'skills v1' })
  ctx.plugin({ name: 'dsh-prompt-prefix', apply })
  await settle()
  const parent = await step(ctx, { session: { id: 's1', header: { cwd: workspace } } }, 'parent again')
  // The host does not resend the baseline to a fork: its seed history already has the (rewritten) pointer.
  const seed = [{ type: 'user/message', data: msg(pointer(pinKey('s1')), { kind: 'agent-instructions', baseline: true }) }]
  const forkCtx = new Context()
  forkCtx.plugin(SystemPrompt)
  forkCtx.plugin({ name: 'dsh-prompt-prefix', apply })
  await settle()
  const fork = await step(forkCtx, { session: { id: 'fork1', header: { cwd: workspace }, inheritedEventCount: seed.length, snapshotEvents: (from = 0, to = seed.length) => seed.slice(from, to) } }, 'forked')
  assert.equal(fork.prompt, parent.prompt)
  assert.match(fork.prompt, /rules for workspace/)
})

test('分叉会话优先使用继承的可见历史里的最新技能目录', async () => {
  const store = new PinStore(join(home, 'plugins', 'prompt-prefix', 'sessions'))
  store.set('fork-parent-old', { v: 1, createdAt: Date.now(), catalog: { text: '旧技能', digest: 'old' } })
  const seed = [
    { seq: 0, type: 'user/message', data: msg(pointer(pinKey('fork-parent-old')), { kind: 'agent-instructions', baseline: true }) },
    { seq: 1, type: 'user/message', data: msg('新技能', { kind: 'skill-catalog', form: 'catalog', entries: [{ name: 'new', description: 'new' }] }) },
  ]
  class SessionQuery extends Service {
    constructor(ctx: Context) { super(ctx, 'sessionQuery') }
    async observeSession() { return { events: seed, [Symbol.dispose]() {} } }
  }
  const ctx = new Context()
  ctx.plugin(SystemPrompt)
  ctx.plugin(SessionQuery)
  ctx.plugin({ name: 'dsh-prompt-prefix', apply })
  await settle()
  const agent = { session: { id: 'fork-new-catalog', header: { cwd: workspace }, surface: { nodes: [0, 1] }, inheritedEventCount: seed.length, snapshotEvents: () => seed } }
  const out = await step(ctx, agent, '分叉继续')
  assert.match(out.prompt, /新技能/)
  assert.doesNotMatch(out.prompt, /旧技能/)
})

test('memory profile in the real DSH shape is pinned, not re-sent', async () => {
  const ctx = host({ text: 'skills' })
  ctx.plugin({ name: 'dsh-prompt-prefix', apply })
  await settle()
  const out = await step(ctx, { session: { id: 's3', header: { cwd: workspace } } }, 'hi')
  assert.match(out.prompt, /profile body/)
  assert.ok(!out.messages.some((m: any) => /profile body/.test(m.content[0].text)))
})

test('固定内容整份换新文件，不在原文件上覆盖写，也不留临时文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'prompt-prefix-pins-'))
  try {
    const store = new PinStore(dir)
    store.set('atomic', { v: 1, createdAt: 1, instructions: 'old rules' })
    const file = join(dir, `${pinKey('atomic')}.json`)
    // A hard link keeps the old inode: an in-place rewrite would show up through it too.
    linkSync(file, join(dir, 'held-by-reader'))
    store.set('atomic', { v: 1, createdAt: 2, instructions: 'new rules' })
    assert.equal(JSON.parse(readFileSync(join(dir, 'held-by-reader'), 'utf8')).instructions, 'old rules')
    assert.equal(new PinStore(dir).get('atomic')?.instructions, 'new rules')
    assert.deepEqual(readdirSync(dir).sort(), [`${pinKey('atomic')}.json`, 'held-by-reader'].sort())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('指针消息带着被换掉的基线原消息，提交时不进会话记录', async () => {
  const ctx = host({ text: 'skills' })
  ctx.plugin({ name: 'dsh-prompt-prefix', apply })
  await settle()
  const agent = { session: { id: 's-original', header: { cwd: workspace } } }
  await step(ctx, agent, 'hi')
  const out = await step(ctx, agent, 'again')
  const replaced = out.messages.find((m: any) => m.content[0].text === pointer(pinKey('s-original')))
  const original = PINNED_ORIGINALS.get(replaced)
  assert.equal(original.content[0].text, BASELINE)
  assert.equal(original.source.baseline, true)
  assert.deepEqual(replaced.source, original.source)
  // The host's session log rejects any key JSON would drop; structuredClone and JSON.stringify both hide such keys.
  const plain = (value: unknown): boolean => typeof value !== 'object' || value === null
    || (Array.isArray(value) ? Reflect.ownKeys(value).length === value.length + 1 && value.every(plain) : Reflect.ownKeys(value).every(key => typeof key === 'string' && Object.prototype.propertyIsEnumerable.call(value, key))
      && Object.values(value).every(plain))
  assert.ok(plain(replaced))
  assert.doesNotMatch(JSON.stringify(replaced), /rules for workspace/)
})

test.after(() => rmSync(home, { recursive: true, force: true }))
