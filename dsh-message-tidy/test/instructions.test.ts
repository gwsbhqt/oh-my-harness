import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config, resolveConfig } from '../src/index.ts'
import { budgetCut, condense, parseSections, unifiedDiff, type MessageLike } from '../src/instructions.ts'

const UPDATED_LEAD = 'This file changed after it was loaded. Use the following content instead of the previously loaded instructions from this file.'
const config = resolveConfig(Config({}))

const RULES = Array.from({ length: 60 }, (_, i) => `- rule ${i}: keep things tidy and never do anything surprising in this repo`).join('\n')
const RULES_V2 = RULES.replace('- rule 30: keep things tidy', '- rule 30: keep things tidy on example-host')

function instructions(body: string, baseline = false): MessageLike {
  return Object.freeze({
    role: 'user',
    id: 'i',
    content: Object.freeze([Object.freeze({ type: 'text', text: `<system-reminder>\n${body}\n</system-reminder>` })]),
    source: Object.freeze({ kind: 'agent-instructions', form: 'instructions', ...(baseline ? { baseline: true } : {}), changes: [{ action: 'set', path: 'AGENTS.md', digest: 'x' }] }),
  })
}

const baseline = (content: string) => instructions(`Instructions from: /repo/AGENTS.md\n\n${content}`, true)
const updated = (content: string, path = '/repo/AGENTS.md') => instructions(`Updated instructions from: ${path}\n\n${UPDATED_LEAD}\n\n${content}`)
const body = (m: MessageLike) => m.content[0]!.text!

test('parseSections splits baseline, additional and updated sections', () => {
  const text = [
    'Instructions from: /a/AGENTS.md\n\nalpha\n\nstill alpha',
    'Additional instructions from: /a/sub/AGENTS.md\n\nThese instructions apply to work under `sub`.\n\nbeta',
    `Updated instructions from: /a/x.md\n\n${UPDATED_LEAD}\n\ngamma`,
  ].join('\n\n')
  const sections = parseSections(text)
  assert.deepEqual(sections.map((s) => [s.kind, s.path, s.content]), [
    ['Instructions from', '/a/AGENTS.md', 'alpha\n\nstill alpha'],
    ['Additional instructions from', '/a/sub/AGENTS.md', 'beta'],
    ['Updated instructions from', '/a/x.md', 'gamma'],
  ])
  for (const s of sections) assert.equal(text.slice(s.start, s.start + s.raw.length), s.raw)
})

test('unifiedDiff shows only the changed line with context', () => {
  assert.equal(unifiedDiff('a\nb\nc\nd\ne', 'a\nb\nC\nd\ne', 1), '@@ -2,3 +2,3 @@\n b\n-c\n+C\n d')
  assert.equal(unifiedDiff('a\nb', 'a\nb'), '')
  assert.equal(unifiedDiff('a', 'a\nb', 0), '@@ -1,0 +2,1 @@\n+b')
})

test('unifiedDiff applied back reproduces the new text', () => {
  const before = 'one\ntwo\nthree\nfour\nfive\nsix\nseven'
  const after = 'one\n2\nthree\nfour\nfive and a half\nsix\nseven\neight'
  const diff = unifiedDiff(before, after, 1)!
  // Rebuild: take unchanged/added lines from each hunk, the rest from `before`.
  const a = before.split('\n')
  const out: string[] = []
  let cursor = 0
  for (const hunk of diff.split(/^(?=@@)/m)) {
    const [header, ...lines] = hunk.replace(/\n$/, '').split('\n')
    const start = Number(/-(\d+)/.exec(header!)![1]) - 1
    const len = Number(/-\d+,(\d+)/.exec(header!)![1])
    out.push(...a.slice(cursor, len === 0 ? start + 1 : start))
    cursor = len === 0 ? start + 1 : start
    for (const l of lines) {
      if (l[0] !== '+') cursor++
      if (l[0] !== '-') out.push(l.slice(1))
    }
  }
  out.push(...a.slice(cursor))
  assert.equal(out.join('\n'), after)
})

test('a one-word edit to AGENTS.md is sent as a small diff', () => {
  const seen = new Map<string, string>()
  const first = baseline(RULES)
  assert.equal(condense(first, seen, config), first)
  const input = updated(RULES_V2)
  const out = condense(input, seen, config)
  assert.notEqual(out, input)
  assert.match(body(out), /^<system-reminder>\nUpdated instructions from: \/repo\/AGENTS\.md\n\nThis file changed after it was loaded\. Only the changed lines are shown/)
  assert.match(body(out), /-- rule 30: keep things tidy and never/)
  assert.match(body(out), /\+- rule 30: keep things tidy on example-host and never/)
  assert.ok(body(out).length < body(input).length / 5)
  assert.deepEqual(out.source, input.source)
  assert.equal(seen.get('/repo/AGENTS.md'), RULES_V2)
})

test('successive edits diff against the version the model last saw', () => {
  const seen = new Map<string, string>()
  condense(baseline(RULES), seen, config)
  condense(updated(RULES_V2), seen, config)
  const v3 = RULES_V2.replace('- rule 50:', '- rule 50 (new):')
  const out = body(condense(updated(v3), seen, config))
  assert.doesNotMatch(out, /rule 30/)
  assert.match(out, /\+- rule 50 \(new\):/)
})

test('without a previous version the full text is kept (resumed session)', () => {
  const input = updated(RULES_V2)
  assert.equal(condense(input, new Map(), config), input)
})

test('a rewrite bigger than maxDiffRatio keeps the full text', () => {
  const seen = new Map<string, string>()
  condense(baseline(RULES), seen, config)
  const input = updated(RULES.replaceAll('tidy', 'neat'))
  assert.equal(condense(input, seen, config), input)
  assert.equal(seen.get('/repo/AGENTS.md'), RULES.replaceAll('tidy', 'neat'))
})

test('budget-truncated files are neither cached nor diffed', () => {
  const marker = 'Workspace instruction budget 1000 bytes: truncated /repo/AGENTS.md from 5000 to 1000 bytes'
  assert.deepEqual([...budgetCut(`${marker}\n\nWorkspace instructions were omitted…`)], ['/repo/AGENTS.md'])
  const seen = new Map<string, string>()
  condense(instructions(`${marker}\n\nInstructions from: /repo/AGENTS.md\n\n${RULES.slice(0, 1000)}`, true), seen, config)
  assert.equal(seen.has('/repo/AGENTS.md'), false)
  const input = updated(RULES_V2)
  assert.equal(condense(input, seen, config), input)
})

test('a removed file is forgotten', () => {
  const seen = new Map<string, string>()
  condense(baseline(RULES), seen, config)
  condense(instructions('Instructions removed: /repo/AGENTS.md\n\nIgnore it.'), seen, config)
  assert.equal(seen.has('/repo/AGENTS.md'), false)
})

test('only the updated section of a multi-section message is rewritten', () => {
  const seen = new Map<string, string>([['/repo/AGENTS.md', RULES]])
  const other = 'Additional instructions from: /repo/sub/AGENTS.md\n\nThese instructions apply to work under `sub`.\n\nsub rules'
  const input = instructions(`${other}\n\nUpdated instructions from: /repo/AGENTS.md\n\n${UPDATED_LEAD}\n\n${RULES_V2}`)
  const out = body(condense(input, seen, config))
  assert.ok(out.startsWith(`<system-reminder>\n${other}\n\nUpdated instructions from: /repo/AGENTS.md\n\nThis file changed`))
  assert.ok(out.endsWith('```\n</system-reminder>'))
  assert.equal(seen.get('/repo/sub/AGENTS.md'), 'sub rules')
})

test('other messages pass through untouched', () => {
  const human: MessageLike = { role: 'user', content: [{ type: 'text', text: `Updated instructions from: x\n\n${UPDATED_LEAD}\n\ny` }], source: { kind: 'user' } }
  assert.equal(condense(human, new Map([['x', 'z']]), config), human)
})

type Waterfall = (name: string, payload: unknown, next: () => Promise<unknown>) => Promise<{ kind: string; messages: MessageLike[] }>

test('end to end: the cache is per agent', async () => {
  const ctx = new Context()
  await (ctx.plugin as unknown as (p: unknown, c: unknown) => PromiseLike<unknown>)({ apply, Config, name: 'dsh-message-tidy' }, {})
  const waterfall = (ctx as unknown as { waterfall: Waterfall }).waterfall.bind(ctx)
  const agentA = { session: {} }
  const agentB = { session: {} }
  const first = await waterfall('agent/pre-step', { agent: agentA, messages: [] }, async () => ({ kind: 'enter', messages: [baseline(RULES)] }))
  ;(ctx as unknown as { emit: (...args: unknown[]) => void }).emit('session/event', agentA.session, { type: 'user/message', data: structuredClone(first.messages[0]) })
  const a = await waterfall('agent/pre-step', { agent: agentA, messages: [] }, async () => ({ kind: 'enter', messages: [updated(RULES_V2)] }))
  assert.match(body(a.messages[0]!), /Only the changed lines are shown/)
  const input = updated(RULES_V2)
  const b = await waterfall('agent/pre-step', { agent: agentB, messages: [] }, async () => ({ kind: 'enter', messages: [input] }))
  assert.equal(b.messages[0], input)
})

test('an Updated section identical to the recorded version is sent whole, never as "nothing changed"', () => {
  const seen = new Map<string, string>()
  condense(baseline(RULES), seen, config)
  condense(updated(RULES_V2), seen, config)
  const resent = updated(RULES_V2)
  const out = condense(resent, seen, config)
  assert.equal(out, resent)
  assert.doesNotMatch(body(out), /no line changed/)
})

async function deliveryHarness() {
  const ctx = new Context()
  await (ctx.plugin as unknown as (p: unknown, c: unknown) => PromiseLike<unknown>)({ apply, Config, name: 'dsh-message-tidy' }, {})
  const waterfall = (ctx as unknown as { waterfall: Waterfall }).waterfall.bind(ctx)
  const emit = (ctx as unknown as { emit: (...args: unknown[]) => void }).emit.bind(ctx)
  const agent = { session: {} }
  const committed: MessageLike[] = []
  const prepare = (messages: MessageLike[]) => waterfall('agent/pre-step', { agent, messages: [] }, async () => ({ kind: 'enter', messages }))
  const commit = (message: MessageLike) => {
    // Session.append stores a JSON snapshot, not the pre-step object's identity.
    const data = structuredClone(message)
    committed.push(data)
    emit('session/event', agent.session, { type: 'user/message', data })
  }
  const finish = () => emit('session/event', agent.session, { type: 'turn/end', data: {} })
  const step = async (message: MessageLike, outcome: 'success' | 'prepare-failure' | 'cancel' = 'success') => {
    const decision = await prepare([message])
    const abort = new AbortController()
    if (outcome === 'cancel') abort.abort(new Error('cancelled'))
    try {
      // rc.2 checks cancellation, then prepares the request, then appends user/message.
      abort.signal.throwIfAborted()
      await (outcome === 'prepare-failure' ? Promise.reject(new Error('request preparation failed')) : Promise.resolve())
      for (const m of decision.messages) commit(m)
    } finally {
      finish()
    }
    return decision.messages[0]!
  }
  return { prepare, commit, finish, step, committed }
}

const SAFETY_V2 = RULES.replace('- rule 10:', '- NEVER DELETE USER DATA; rule 10:')
const SAFETY_V3 = SAFETY_V2.replace('- rule 40:', '- latest edit; rule 40:')

for (const outcome of ['prepare-failure', 'cancel'] as const) {
  test(`delivery regression: ${outcome} before commit does not hide V2 safety in V3`, async () => {
    const host = await deliveryHarness()
    await host.step(baseline(RULES))
    await assert.rejects(host.step(updated(SAFETY_V2), outcome), outcome === 'cancel' ? /cancelled/ : /request preparation failed/)
    assert.equal(host.committed.length, 1)
    const v3 = body(await host.step(updated(SAFETY_V3)))
    assert.match(v3, /Only the changed lines are shown/)
    assert.match(v3, /\+- NEVER DELETE USER DATA; rule 10:/)
    assert.match(v3, /\+- latest edit; rule 40:/)
    const v4 = body(await host.step(updated(SAFETY_V3.replace('- rule 55:', '- fourth edit; rule 55:'))))
    assert.match(v4, /\+- fourth edit; rule 55:/)
    assert.doesNotMatch(v4, /NEVER DELETE USER DATA|latest edit/)
  })

  test(`delivery regression: same version retried after ${outcome} still includes safety`, async () => {
    const host = await deliveryHarness()
    await host.step(baseline(RULES))
    await assert.rejects(host.step(updated(SAFETY_V2), outcome))
    const resent = body(await host.step(updated(SAFETY_V2)))
    assert.match(resent, /\+- NEVER DELETE USER DATA; rule 10:/)
  })
}

test('a baseline that never commits cannot be used to generate a diff', async () => {
  const host = await deliveryHarness()
  await assert.rejects(host.step(baseline(RULES), 'prepare-failure'))
  const input = updated(SAFETY_V3)
  assert.equal(await host.step(input), input)
})

test('pending instructions never count as delivered, even without a turn/end notification', async () => {
  const host = await deliveryHarness()
  await host.step(baseline(RULES))
  await host.prepare([updated(SAFETY_V2)])
  const next = await host.prepare([updated(SAFETY_V3)])
  assert.match(body(next.messages[0]!), /\+- NEVER DELETE USER DATA; rule 10:/)
  assert.match(body(next.messages[0]!), /\+- latest edit; rule 40:/)
})

test('only matching committed messages advance the baseline; a mismatch falls back to full text', async () => {
  const host = await deliveryHarness()
  await host.step(baseline(RULES))
  const prepared = await host.prepare([updated(SAFETY_V2)])
  host.commit({ ...prepared.messages[0]!, content: [{ type: 'text', text: 'replaced by another plugin' }] })
  host.finish()
  const input = updated(SAFETY_V3)
  assert.equal(await host.step(input), input)
})

test('partial message commits do not promote the uncommitted suffix', async () => {
  const host = await deliveryHarness()
  await host.step(baseline(RULES))
  const prepared = await host.prepare([updated(SAFETY_V2), updated(SAFETY_V3)])
  host.commit(prepared.messages[0]!)
  host.finish()
  const retried = body(await host.step(updated(SAFETY_V3)))
  assert.match(retried, /\+- latest edit; rule 40:/)
  assert.doesNotMatch(retried, /NEVER DELETE USER DATA/)
})

// dsh-prompt-prefix 把基线换成指针、原文挪进系统提示词；两个插件谁在外层取决于加载先后，两种都要接得上。
const PINNED_ORIGINALS = ((globalThis as Record<symbol, unknown>)[Symbol.for('dsh-prompt-prefix.originals')] ??= new WeakMap()) as WeakMap<object, unknown>
const pinnedPointer = (original: MessageLike, key = '0'.repeat(32)): MessageLike => {
  const pointer = { ...original, content: [{ type: 'text', text: `<system-reminder>\n[dsh-prompt-prefix] Workspace instructions location\n<!-- prompt-prefix pin=${key} -->\n</system-reminder>` }] } as MessageLike
  PINNED_ORIGINALS.set(pointer, original)
  return pointer
}

test('prompt-prefix 在里层：指针带着原基线，之后的更新照样只发差异', async () => {
  const host = await deliveryHarness()
  const prepared = await host.prepare([pinnedPointer(baseline(RULES))])
  host.commit(prepared.messages[0]!)
  host.finish()
  assert.match(body(await host.step(updated(RULES_V2))), /Only the changed lines are shown/)
})

test('prompt-prefix 在外层：基线被换成指针后提交，之后的更新照样只发差异', async () => {
  const host = await deliveryHarness()
  const prepared = await host.prepare([baseline(RULES)])
  host.commit(pinnedPointer(prepared.messages[0]!))
  host.finish()
  assert.match(body(await host.step(updated(RULES_V2))), /Only the changed lines are shown/)
})

test('指针的来源和待提交的基线对不上时，仍按改写处理、下次发全文', async () => {
  const host = await deliveryHarness()
  const prepared = await host.prepare([baseline(RULES)])
  const pointer = pinnedPointer(prepared.messages[0]!)
  host.commit({ ...pointer, source: { ...pointer.source, changes: [{ action: 'set', path: 'OTHER.md', digest: 'y' }] } })
  host.finish()
  const input = updated(RULES_V2)
  assert.equal(await host.step(input), input)
})
