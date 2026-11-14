import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { installHookTiming, realEvents, type HookTimer } from '../../src/host/run-status/hooks.ts'

interface Log { kind: string; plugin?: string; event?: string; at: number }

function fakeTimer(log: Log[]): HookTimer {
  let n = 0
  const t0 = Date.now()
  return {
    sessionOf: (_e, args) => (args[0] as { agent?: { session?: { id?: string } } })?.agent?.session?.id,
    start: (_s, plugin, event) => { log.push({ kind: 'start', plugin, event, at: Date.now() - t0 }); return ++n },
    wait: (_s, h) => { log.push({ kind: `wait${h}`, at: Date.now() - t0 }) },
    resume: (_s, h) => { log.push({ kind: `resume${h}`, at: Date.now() - t0 }) },
    end: (_s, h) => { log.push({ kind: `end${h}`, at: Date.now() - t0 }) },
  }
}

describe('钩子计时层（真实 cordis 事件总线）', () => {
  it('waterfall 里每个插件的监听器都被认出，等下游的时间分开记，结果原样返回', async () => {
    const root = new Context()
    const log: Log[] = []
    const events = realEvents(root.events)
    assert.ok(events !== undefined)
    await root.plugin({
      name: 'plugin-a',
      apply(ctx: Context) {
        ctx.on('tools/post-execute' as never, (async (_exec: unknown, _r: unknown, next: () => Promise<string>) => {
          await new Promise((r) => setTimeout(r, 30))
          return `${await next()}+a`
        }) as never)
      },
    })
    await root.plugin({
      name: 'plugin-b',
      apply(ctx: Context) {
        ctx.on('tools/post-execute' as never, ((_exec: unknown, _r: unknown, next: () => Promise<string>) => next().then((v) => `${v}+b`)) as never)
      },
    })
    const undo = installHookTiming(events!, fakeTimer(log))
    const exec = { agent: { session: { id: 's1' } } }
    const out = await (root as unknown as { waterfall: (...a: unknown[]) => Promise<string> }).waterfall('tools/post-execute', exec, {}, () => Promise.resolve('base'))
    assert.equal(out, 'base+b+a')
    assert.deepEqual(log.filter((l) => l.kind === 'start').map((l) => l.plugin), ['plugin-a', 'plugin-b'])
    assert.ok(log.some((l) => l.kind === 'wait1'))
    assert.ok(log.some((l) => l.kind === 'end1'))
    assert.ok(log.some((l) => l.kind === 'end2'))
    undo()
    log.length = 0
    await (root as unknown as { waterfall: (...a: unknown[]) => Promise<string> }).waterfall('tools/post-execute', exec, {}, () => Promise.resolve('base'))
    assert.equal(log.length, 0, '撤销后不再计时')
  })

  it('不认得会话、不在名单里的事件、emit 一律不包', async () => {
    const root = new Context()
    const log: Log[] = []
    await root.plugin({ name: 'p', apply(ctx: Context) { ctx.on('tools/pre-execute' as never, ((_e: unknown, next: () => unknown) => next()) as never); ctx.on('x/y' as never, (() => 'v') as never) } })
    const undo = installHookTiming(realEvents(root.events)!, fakeTimer(log))
    const w = (root as unknown as { waterfall: (...a: unknown[]) => Promise<unknown> }).waterfall
    await w('tools/pre-execute', {}, () => Promise.resolve('ok'))
    assert.equal(log.length, 0)
    undo()
  })

  it('监听器抛错时照样结束计时并把错误抛出去', async () => {
    const root = new Context()
    const log: Log[] = []
    await root.plugin({ name: 'bad', apply(ctx: Context) { ctx.on('agent/pre-step' as never, (async () => { throw new Error('boom') }) as never) } })
    const undo = installHookTiming(realEvents(root.events)!, fakeTimer(log))
    const w = (root as unknown as { waterfall: (...a: unknown[]) => Promise<unknown> }).waterfall
    await assert.rejects(w('agent/pre-step', { agent: { session: { id: 's' } } }, () => Promise.resolve('ok')), /boom/)
    assert.deepEqual(log.map((l) => l.kind), ['start', 'end1'])
    undo()
  })

  it('上面又被别人盖了一层时撤销：本层摘不掉，但之后不再计时，结果照常', async () => {
    const root = new Context()
    const log: Log[] = []
    await root.plugin({ name: 'p', apply(ctx: Context) { ctx.on('agent/pre-step' as never, ((_e: unknown, next: () => unknown) => next()) as never) } })
    const events = realEvents(root.events)!
    const undo = installHookTiming(events, fakeTimer(log))
    const key = typeof events._resolve === 'function' ? '_resolve' : 'dispatch'
    const own = events as unknown as Record<string, (...a: unknown[]) => unknown>
    const below = own[key]!
    own[key] = function (this: unknown, ...a: unknown[]) { return below.apply(this, a) }
    undo()
    const w = (root as unknown as { waterfall: (...a: unknown[]) => Promise<unknown> }).waterfall
    assert.equal(await w('agent/pre-step', { agent: { session: { id: 's' } } }, () => Promise.resolve('ok')), 'ok')
    assert.equal(log.length, 0, '撤销后被压在下面的这层只原样转发')
  })
})
