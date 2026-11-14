import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fromShared, resolveModelTiers, pick, type UsageReportLike } from '../src/models.ts'

/** 测试用的档位：和 模型额度服务 的共用档位文件同一形状（这里只取原来的三个主力档模型，方便沿用旧用例）。 */
const SHARED = {
  tiers: {
    main: [{ provider: 'claude', model: 'claude-opus-5-5' }, { provider: 'codex', model: 'gpt-6.1-sol' }, { provider: 'kimi-coding', model: 'k3-256k' }],
    light: [{ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }],
  },
  quotas: {
    'claude': { quota: 'claude', windows: { '7d': 1 } },
    'codex': { quota: 'codex', windows: { '7d': 1 } },
    'kimi-coding': { quota: 'kimi', windows: { '7d': 1, '30d': 2 } },
    'opencode-go': { quota: 'opencode', windows: { '7d': 1, '30d': 2 } },
  },
  reservePercent: 10,
}
const DEFAULT_TIERS = fromShared(SHARED)

test('tier source precedence, standalone selection, and missing configuration', () => {
  const local = { normal: ['example/main'], fast: ['example/fast'] }
  assert.deepEqual(resolveModelTiers(SHARED, local).tiers, fromShared(SHARED))
  const standalone = resolveModelTiers(undefined, local)
  assert.equal(standalone.tiersError, undefined)
  const selected = pick('fast', standalone.tiers, undefined, { reservePercent: 10, now: 0, catalog: new Set(['example/fast']) })
  assert.equal(selected.chosen?.model, 'fast')
  const empty = resolveModelTiers(undefined, { normal: [], fast: [] })
  assert.match(empty.tiersError!, /没配置档位.*tiers.normal.*模型额度服务/)
  assert.throws(() => resolveModelTiers(undefined, { normal: ['invalid'], fast: [] }), /provider\/model/)
  const relay = resolveModelTiers(undefined, { normal: ['relay/underlying/model'], fast: [] }, ['relay'])
  assert.equal(relay.tiers.normal[0]!.quota, 'underlying')
})

test('中继 同一入口按底层服务商取额度，完整模型规则优先，自动组不猜账号', () => {
  const doc = {
    ...SHARED,
    tiers: {
      main: [
        { provider: 'relay', model: 'claude/claude-opus-5-5' },
        { provider: 'relay', model: 'kimi-code-cn/k3-256k' },
        { provider: 'relay-responses', model: 'codex/gpt-6.1-sol' },
        { provider: 'relay-responses', model: 'group/auto-gpt-6-1-sol' },
      ],
      light: [{ provider: 'relay', model: 'opencode-go/deepseek-v4.1-flash' }],
    },
    quotas: {
      ...SHARED.quotas,
      'kimi-code-cn': { quota: 'kimi', windows: { '7d': 1, '30d': 2 } },
      'relay-responses/codex/gpt-6.1-sol': { quota: 'codex-specific', windows: { '7d': 2 } },
      relay: { quota: 'wrong', windows: { '7d': 1 } },
      'relay-responses': { quota: 'wrong', windows: { '7d': 1 } },
    },
  }
  const actual = fromShared(doc, ['relay', 'relay-responses'])
  assert.deepEqual(actual.normal.map(c => c.quota), ['claude', 'kimi', 'codex-specific', 'group'])
  assert.equal(actual.normal[3]!.defaultWindows, true)
  assert.equal(actual.fast[0]!.quota, 'opencode')
  assert.deepEqual(actual.fast[0]!.windows, { '7d': 1, '30d': 2 })
})

const NOW = Date.parse('2026-09-30T12:00:00+08:00')
const DAY = 86_400_000

function report(over: Partial<Record<string, { label: string; left: number; expectedLeft?: number; resetsAt?: number; runsOut?: number }[]>>): UsageReportLike {
  const base: Record<string, { label: string; left: number; expectedLeft?: number; resetsAt?: number; runsOut?: number }[]> = {
    claude: [{ label: '5h', left: 1, expectedLeft: 50 }, { label: '7d', left: 60, expectedLeft: 50, resetsAt: NOW + 3 * DAY }],
    codex: [{ label: '7d', left: 55, expectedLeft: 50, resetsAt: NOW + 3 * DAY }],
    kimi: [{ label: '7d', left: 50, expectedLeft: 50, resetsAt: NOW + 3 * DAY }, { label: '30d', left: 50, expectedLeft: 50, resetsAt: NOW + 20 * DAY }],
    opencode: [{ label: '7d', left: 80, expectedLeft: 50, resetsAt: NOW + 3 * DAY }, { label: '30d', left: 80, expectedLeft: 60, resetsAt: NOW + 20 * DAY }],
    ...over,
  }
  return {
    fetchedAt: NOW,
    providers: Object.entries(base).map(([id, windows]) => ({
      id, name: id, ok: true,
      windows: windows.map((w, i) => ({ key: `${id}:${i}`, ...w })),
    })),
  }
}

const opts = { reservePercent: 10, now: NOW }

test('档位文件额度一节为空（模型额度服务 现在的写法）：中继 模型按 id 第一段认额度来源，主力档第一个照样能挑上', () => {
  const doc = {
    tiers: {
      main: [{ provider: 'relay', model: 'claude/claude-opus-5-5' }, { provider: 'relay-responses', model: 'codex/gpt-6.1-sol' }],
      light: [{ provider: 'relay', model: 'opencode-go/deepseek-v4.1-flash' }],
    },
    quotas: {},
    reservePercent: 10,
  }
  const tiers = fromShared(doc, ['relay', 'relay-responses'])
  assert.deepEqual(tiers.normal.map((c) => c.quota), ['claude', 'codex'])
  const r = pick('normal', tiers, report({}), opts)
  assert.equal(r.chosen?.model, 'claude/claude-opus-5-5')
  assert.equal(r.candidates.every((v) => v.usable), true)
  // 默认权重只取报告里实际有的窗口：claude 只有 7d（5h 不算），就只看 7d，不因缺 30d 报警告
  assert.deepEqual(r.candidates[0]!.windows.map((w) => w.label), ['7d'])
  const fast = pick('fast', tiers, report({ 'opencode-go': [{ label: '7d', left: 0, resetsAt: NOW + DAY }, { label: '30d', left: 80 }] }), opts)
  assert.equal(fast.chosen, undefined, '默认窗口照样会因用光被排除')
  assert.match(fast.candidates[0]!.reasons.join(), /7d 已用光/)
  // 非 中继、又没有规则的模型仍判不可用
  const odd = fromShared({ ...doc, tiers: { main: [{ provider: 'nobody', model: 'x' }], light: [] } })
  assert.match(pick('normal', odd, report({}), opts).candidates[0]!.reasons.join(), /没有 nobody 的额度规则/)
})

test('中继 多账号不取第一份额度，也不把百分比相加', () => {
  const data = report({ claude: [{ label: '7d', left: 0, resetsAt: NOW + DAY }] })
  data.providers.push({ id: 'claude', name: '另一个 Claude 账号', ok: true, windows: [{ key: 'other', label: '7d', left: 90 }] })
  const r = pick('normal', DEFAULT_TIERS, data, opts)
  assert.equal(r.chosen?.provider, 'claude')
  assert.match(r.candidates[0]!.warnings.join(), /多个账号/)
  assert.equal(r.candidates[0]!.windows[0]!.left, undefined)
})

test('normal 档按顺序挑，额度不紧时排前面的先用；5h 窗口不参与（claude 5h 只剩 1% 也照样可选）', () => {
  const r = pick('normal', DEFAULT_TIERS, report({ codex: [{ label: '7d', left: 95, expectedLeft: 50, resetsAt: NOW + 3 * DAY }] }), opts)
  assert.equal(r.chosen?.provider, 'claude', 'Codex 余量更多也不抢先（用户 2026-10-12 定）')
  assert.equal(r.candidates.every((v) => v.usable), true)
})

test('额度紧（撑不到重置、剩不到一半）的排到后面；剩得多时用得快不算紧', () => {
  const r = pick('normal', DEFAULT_TIERS, report({ claude: [{ label: '7d', left: 30, expectedLeft: 60, resetsAt: NOW + 3 * DAY, runsOut: NOW + DAY }] }), opts)
  assert.equal(r.chosen?.provider, 'codex')
  assert.equal(r.candidates[0]!.tight, true)
  const roomy = pick('normal', DEFAULT_TIERS, report({ claude: [{ label: '7d', left: 70, expectedLeft: 80, resetsAt: NOW + 3 * DAY, runsOut: NOW + DAY }] }), opts)
  assert.equal(roomy.chosen?.provider, 'claude')
})

test('7d 已用光或低于保留线的排除，理由写清楚', () => {
  const r = pick('normal', DEFAULT_TIERS, report({ claude: [{ label: '7d', left: 0, expectedLeft: 50, resetsAt: NOW + DAY }], codex: [{ label: '7d', left: 5, expectedLeft: 50, resetsAt: NOW + DAY }] }), opts)
  assert.equal(r.chosen?.provider, 'kimi-coding')
  const claude = r.candidates.find((v) => v.provider === 'claude')!
  assert.equal(claude.usable, false)
  assert.match(claude.reasons.join(), /已用光/)
  assert.match(r.candidates.find((v) => v.provider === 'codex')!.reasons.join(), /低于保留线/)
})

test('照现在速度会在重置前用光、剩得又不到一半：仍可用，但排到后面；整档只剩它时照样用', () => {
  const r = pick('normal', DEFAULT_TIERS, report({ claude: [{ label: '7d', left: 40, expectedLeft: 50, resetsAt: NOW + 3 * DAY, runsOut: NOW + DAY }] }), opts)
  const claude = r.candidates[0]!
  assert.equal(claude.usable, true)
  assert.match(claude.warnings.join(), /早于重置/)
  assert.notEqual(r.chosen?.provider, 'claude')
  const alone = pick('normal', { ...DEFAULT_TIERS, normal: [DEFAULT_TIERS.normal[0]!] }, report({ claude: [{ label: '7d', left: 40, expectedLeft: 50, resetsAt: NOW + 3 * DAY, runsOut: NOW + DAY }] }), opts)
  assert.equal(alone.chosen?.provider, 'claude')
})

test('kimi 的 30d 权重高于 7d：7d 省很多但 30d 超支时，分数仍偏低（几个都紧时用来排先后）', () => {
  const r = pick('normal', DEFAULT_TIERS, report({
    claude: [{ label: '7d', left: 55, expectedLeft: 50, resetsAt: NOW + DAY }],
    codex: [{ label: '7d', left: 55, expectedLeft: 50, resetsAt: NOW + DAY }],
    kimi: [{ label: '7d', left: 95, expectedLeft: 50, resetsAt: NOW + DAY }, { label: '30d', left: 30, expectedLeft: 55, resetsAt: NOW + 20 * DAY }],
  }), opts)
  const kimi = r.candidates.find((v) => v.provider === 'kimi-coding')!
  // (45*1 + -25*2) / 3 = -1.67
  assert.ok(Math.abs(kimi.score! - (-5 / 3)) < 1e-9)
  assert.equal(r.chosen?.provider, 'claude')
})

test('分数相同按排好的顺序', () => {
  const same = [{ label: '7d', left: 50, expectedLeft: 50, resetsAt: NOW + DAY }]
  const r = pick('normal', DEFAULT_TIERS, report({ claude: same, codex: same, kimi: [...same, { label: '30d', left: 50, expectedLeft: 50 }] }), opts)
  assert.equal(r.chosen?.provider, 'claude')
})

test('整档不可用时不偷偷换档，给出最早重置时间', () => {
  const r = pick('fast', DEFAULT_TIERS, report({ opencode: [{ label: '7d', left: 0, expectedLeft: 50, resetsAt: NOW + 2 * DAY }, { label: '30d', left: 40, expectedLeft: 50 }] }), opts)
  assert.equal(r.chosen, undefined)
  assert.equal(r.earliestReset, NOW + 2 * DAY)
})

test('不在这台机器模型列表里的不选；额度报告缺席时照样可选、按顺序（查额度和发请求是两回事）', () => {
  const catalog = new Set(['codex/gpt-6.1-sol'])
  const r = pick('normal', DEFAULT_TIERS, report({}), { ...opts, catalog })
  assert.equal(r.chosen?.provider, 'codex')
  assert.match(r.candidates[0]!.reasons.join(), /不在共用模型列表里/)
  const none = pick('normal', DEFAULT_TIERS, undefined, opts)
  assert.equal(none.chosen?.provider, 'claude')
  assert.match(none.chosen!.warnings.join(), /拿不到额度报告/)
})

test('这台机器上最近调用失败的模型跳过，说明原因', () => {
  const skip = new Map([['claude/claude-opus-5-5', '这台机器上最近调用失败：登录或授权失效，暂时跳过']])
  const r = pick('normal', DEFAULT_TIERS, report({}), { ...opts, skip })
  assert.notEqual(r.chosen?.provider, 'claude')
  assert.match(r.candidates[0]!.reasons.join(), /授权失效/)
})

test('重置时间已过的窗口不再算用光', () => {
  const r = pick('normal', DEFAULT_TIERS, report({ claude: [{ label: '7d', left: 0, expectedLeft: 50, resetsAt: NOW - 1000 }] }), opts)
  assert.equal(r.candidates[0]!.usable, true)
})

test('共用档位换算：主力档 → normal，轻量档 → fast，每家的窗口来自额度规则；没规则的模型判不可用', () => {
  assert.deepEqual(DEFAULT_TIERS.normal.map((c) => `${c.provider}/${c.model}`), ['claude/claude-opus-5-5', 'codex/gpt-6.1-sol', 'kimi-coding/k3-256k'])
  assert.deepEqual(DEFAULT_TIERS.fast.map((c) => `${c.provider}/${c.model}`), ['opencode-go/deepseek-v4.1-flash'])
  assert.deepEqual(DEFAULT_TIERS.normal.map((c) => c.windows), [{ '7d': 1 }, { '7d': 1 }, { '7d': 1, '30d': 2 }])
  assert.deepEqual(DEFAULT_TIERS.fast[0]!.windows, { '7d': 1, '30d': 2 })
  const odd = fromShared({ ...SHARED, tiers: { main: [{ provider: 'nobody', model: 'x' }], light: [] } })
  const r = pick('normal', odd, report({}), opts)
  assert.equal(r.chosen, undefined)
})