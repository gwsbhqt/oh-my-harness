import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createToggler } from '../../src/shared/toggle.ts'

/** 等 Cordis 的异步加载/卸载落定：多让几轮微任务跑完。 */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

interface Counters {
  mounted: Map<string, number>
  disposed: Map<string, number>
}

function counted(ctx: Context, counters: Counters, key: string): (child: Context) => void {
  return (child: Context): void => {
    child.effect(() => {
      counters.mounted.set(key, (counters.mounted.get(key) ?? 0) + 1)
      return () => { counters.disposed.set(key, (counters.disposed.get(key) ?? 0) + 1) }
    }, `test:${key}`)
  }
}

describe('子开关挂载器：真的挂上、真的卸掉', () => {
  it('加载→关闭→恢复→重复循环→整体卸载，挂载和撤销次数一一对应', async () => {
    const ctx = new Context()
    const counters: Counters = { mounted: new Map(), disposed: new Map() }
    const toggler = createToggler(ctx, {
      a: counted(ctx, counters, 'a'),
      b: counted(ctx, counters, 'b'),
      c: counted(ctx, counters, 'c'),
    })

    // 四块全开：三块都真挂上了，各自注册了一个 effect。
    toggler.sync({ a: true, b: true, c: true })
    await settle()
    assert.deepEqual(toggler.active(), ['a', 'b', 'c'])
    assert.deepEqual([...counters.mounted.values()], [1, 1, 1])

    // 只关 b：b 的 effect 被撤销，a、c 不动。
    toggler.sync({ a: true, b: false, c: true })
    await settle()
    assert.deepEqual(toggler.active(), ['a', 'c'])
    assert.equal(counters.disposed.get('b'), 1)
    assert.equal(counters.mounted.get('a'), 1)
    assert.equal(counters.mounted.get('c'), 1)

    // b 反复关开 3 轮：每开一次都重新挂、每关一次都真的撤销，不累积。
    for (let round = 2; round <= 4; round++) {
      toggler.sync({ a: true, b: true, c: true })
      await settle()
      assert.equal(counters.mounted.get('b'), round)
      toggler.sync({ a: true, b: false, c: true })
      await settle()
      assert.equal(counters.disposed.get('b'), round)
    }

    // 整体卸载：所有还挂着的都撤销。
    toggler.sync({ a: false, b: false, c: false })
    await settle()
    assert.deepEqual(toggler.active(), [])
    assert.equal(counters.disposed.get('a'), 1)
    assert.equal(counters.disposed.get('c'), 1)

    // 已空的挂载器再整体卸载不重复撤销。
    toggler.dispose()
    await settle()
    assert.equal(counters.disposed.get('a'), 1)
    assert.equal(counters.disposed.get('b'), 4)
    assert.equal(counters.disposed.get('c'), 1)

    // 每个块：挂了几次就撤了几次，没有泄漏。
    for (const key of ['a', 'b', 'c']) {
      assert.equal(counters.mounted.get(key), counters.disposed.get(key), `${key} 挂载与撤销次数不等`)
    }
  })

  it('只开其中一块时不会把别的块也挂上', async () => {
    const ctx = new Context()
    const counters: Counters = { mounted: new Map(), disposed: new Map() }
    const toggler = createToggler(ctx, {
      a: counted(ctx, counters, 'a'),
      b: counted(ctx, counters, 'b'),
    })
    toggler.sync({ a: true, b: false })
    await settle()
    assert.deepEqual(toggler.active(), ['a'])
    assert.equal(counters.mounted.get('a'), 1)
    assert.equal(counters.mounted.get('b'), undefined)
    toggler.dispose()
    await settle()
  })

  it('挂了不存在的块名要立刻报错，而不是悄悄跳过', () => {
    const ctx = new Context()
    const toggler = createToggler(ctx, {})
    assert.throws(() => { toggler.sync({ nope: true }) }, /没有名为 nope 的能力/)
  })
})
