import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config, resolveConfig } from '../src/index.ts'
import { labelNotice, type MessageLike } from '../src/notice.ts'

const SOURCES = ['repeat-tool-reminder', 'tool-jobs']

function notice(plugin: string, text: string): MessageLike {
  return Object.freeze({
    role: 'user',
    id: `m-${plugin}`,
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    // 0.1.7 实测形状：repeat-tool-reminder 发的是 { kind: 'repeat-tool-reminder', form: 'notice', summary }
    source: Object.freeze({ kind: plugin, form: 'notice', summary: 'bash × 3' }),
  })
}

const human: MessageLike = { role: 'user', id: 'h', content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }

test('the default list frames dsh-control notices without changing their source or authority', () => {
  const sources = resolveConfig(Config({})).noticeSources
  const input = notice('dsh-control', 'Continue the existing task; this is not new human authorization.')
  const out = labelNotice(input, sources)
  assert.match(out.content[0]!.text!, /the user did not write this/)
  assert.equal(out.source, input.source)
  assert.equal(out.role, input.role)
  assert.equal(labelNotice(human, sources), human)
  const nonNotice = { ...input, source: { kind: 'dsh-control', form: 'context' } }
  assert.equal(labelNotice(nonNotice, sources), nonNotice)
})

test('an explicit source list still opts out of dsh-control labels', () => {
  const sources = resolveConfig(Config({ noticeSources: ['tool-jobs'] })).noticeSources
  const input = notice('dsh-control', 'Continue')
  assert.equal(labelNotice(input, sources), input)
})

test('a repeat reminder is framed as a system reminder naming its source', () => {
  const out = labelNotice(notice('repeat-tool-reminder', 'You are repeating the exact same tool call.'), SOURCES)
  const text = out.content[0]!.text!
  assert.match(text, /^<system-reminder>\n\[repeat-tool-reminder\] Automatic system notice \(the user did not write this\)/)
  assert.match(text, /You are repeating the exact same tool call\.\n<\/system-reminder>$/)
})

test('source metadata is preserved exactly (other plugins recognise their messages by it)', () => {
  const input = notice('tool-jobs', 'background job bash-4 (bash: x) finished [status: completed, exit code: 0].')
  const out = labelNotice(input, SOURCES)
  assert.deepEqual(out.source, input.source)
  assert.equal(out.id, input.id)
})

test('the user\'s own words and unlisted plugins are untouched', () => {
  assert.equal(labelNotice(human, SOURCES), human)
  const other = notice('some-other-plugin', 'hello')
  assert.equal(labelNotice(other, SOURCES), other)
})

test('already framed text is not framed twice', () => {
  const once = labelNotice(notice('tool-jobs', 'done'), SOURCES)
  assert.equal(labelNotice(once, SOURCES), once)
})

test('multi-block notices frame only the first text and stay idempotent', () => {
  const image = Object.freeze({ type: 'image', attachmentId: 'image-1' })
  const first = Object.freeze({ type: 'text', text: 'first' })
  const second = Object.freeze({ type: 'text', text: 'second' })
  const input: MessageLike = Object.freeze({ ...notice('tool-jobs', 'unused'), content: Object.freeze([image, first, second]) })
  const out = labelNotice(input, SOURCES)
  assert.match(out.content[1]!.text!, /^<system-reminder>/)
  assert.equal(out.content[0], image)
  assert.equal(out.content[2], second)
  assert.equal(out.source, input.source)
  assert.equal(labelNotice(out, SOURCES), out)
  assert.equal(first.text, 'first')
})

test('an already framed first text is untouched even with a later unframed text', () => {
  const input = {
    ...notice('repeat-tool-reminder', 'unused'),
    content: [{ type: 'text', text: '  <system-reminder>existing</system-reminder>' }, { type: 'text', text: 'extra' }],
  }
  assert.equal(labelNotice(input, SOURCES), input)
})

test('frozen input is not mutated', () => {
  const input = notice('tool-jobs', 'done')
  labelNotice(input, SOURCES)
  assert.equal(input.content[0]!.text, 'done')
})

test('as the outermost pre-step listener it sees notices injected by inner listeners', async () => {
  const ctx = new Context()
  // An inner listener registered FIRST — like a host plugin loaded before ours.
  ctx.on('agent/pre-step' as never, (async (_p: unknown, next: () => Promise<{ kind: string; messages: MessageLike[] }>) => {
    const d = await next()
    return { ...d, messages: [...d.messages, notice('repeat-tool-reminder', 'Repeated tool call detected')] }
  }) as never)
  await (ctx.plugin as unknown as (p: unknown, c: unknown) => PromiseLike<unknown>)({ apply, Config, name: 'dsh-message-tidy' }, {})
  const decision = await (ctx as unknown as {
    waterfall: (name: string, payload: unknown, next: () => Promise<unknown>) => Promise<{ kind: string; messages: MessageLike[] }>
  }).waterfall('agent/pre-step', { agent: {}, messages: [human], step: 2 }, async () => ({ kind: 'enter', messages: [human] }))
  assert.equal(decision.messages.length, 2)
  assert.equal(decision.messages[0], human)
  assert.match(decision.messages[1]!.content[0]!.text!, /^<system-reminder>\n\[repeat-tool-reminder\] Automatic system notice/)
})

test('a rejected step passes through untouched', async () => {
  const ctx = new Context()
  await (ctx.plugin as unknown as (p: unknown, c: unknown) => PromiseLike<unknown>)({ apply, Config, name: 'dsh-message-tidy' }, {})
  const decision = await (ctx as unknown as {
    waterfall: (name: string, payload: unknown, next: () => Promise<unknown>) => Promise<unknown>
  }).waterfall('agent/pre-step', { agent: {}, messages: [] }, async () => ({ kind: 'reject' }))
  assert.deepEqual(decision, { kind: 'reject' })
})
