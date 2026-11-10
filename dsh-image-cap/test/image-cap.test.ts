/**
 * dsh-image-cap 的单测。
 *
 * ## 这些测试的关键设计
 *
 * 最重要的一条：**不自己重新实现缩放逻辑来验证**。本插件的全部价值在于
 * 「交给 DSH 的那个目标尺寸，能让 DSH 缩出 ≤2000 的长边」——所以测试里
 * 必须跑**DSH 真正在用的那些函数**（`requestImageDimensions()` 算路由目标、
 * `longEdgeDimensions()` 算长边目标），而不是我们照着重写一遍。重写一遍
 * 只能证明"我的两段代码互相自洽"，证明不了真实行为。
 *
 * 尺寸数据全部为虚构夹具，覆盖宽条、接近阈值和已达标图片。
 *
 * 张数上限那一半同理：替换占位文字跑的是 DSH 自己的
 * `projectOffloadedImages()`，占位符文字跑的是 DSH 自己的
 * `offloadedImageText()`——本插件只负责「给哪几张打 offloaded 标记」和
 * 「挂在哪一层」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { longEdgeDimensions, requestImageDimensions } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import {
  LlmAdapter,
  LlmRuntime,
  createToolResultMessage,
  createUserMessage,
  offloadedImageText,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import {
  Config,
  DEFAULT_IMAGE_COUNT_QUANTUM,
  DEFAULT_MAX_IMAGES_PER_REQUEST,
  MANY_IMAGE_LONG_EDGE_LIMIT,
  apply,
  countImages,
  maxImagesFor,
  patchAttachments,
  patchLlm,
  projectImageCount,
  tightenTarget,
  type AdapterStreamHost,
  type ReadImageRequestHost,
} from '../src/index.ts'

/** DSH 的默认请求图面积预算：2048×2048。 */
const DEFAULT_BUDGET = 2048 * 2048
const LIMIT = MANY_IMAGE_LONG_EDGE_LIMIT

/**
 * 模拟路由给 `readImageRequest` 的真实入参：pi-ai 适配器就是
 * `requestImageDimensions(ref.w, ref.h, budget.maxPixels)` + 字节预算
 * （0.1.7 的 `requestImageTarget()`）。测试不走捷径，同样跑宿主的函数。
 */
function routeTarget(width: number, height: number, maxBytes = 1 << 20): ImageRequestTarget {
  return { ...requestImageDimensions(width, height, DEFAULT_BUDGET), maxBytes }
}

/** 虚构尺寸；over 标记目标长边超过阈值的情况。 */
const SAMPLE_IMAGES: { width: number; height: number; over: boolean }[] = [
  { width: 4800, height: 800, over: true },
  { width: 2400, height: 1200, over: true },
  { width: 2200, height: 1600, over: true },
  { width: 2500, height: 500, over: true },
  { width: 2300, height: 300, over: true },
  { width: 2600, height: 400, over: true },
  { width: 1999, height: 900, over: false },
  { width: 1800, height: 1700, over: false },
  { width: 1900, height: 1600, over: false },
  { width: 1200, height: 800, over: false },
  { width: 640, height: 320, over: false },
  { width: 900, height: 300, over: false },
]

test('虚构尺寸组：收紧后的目标长边一律 ≤ 2000', () => {
  for (const image of SAMPLE_IMAGES) {
    const target = tightenTarget(image, routeTarget(image.width, image.height), LIMIT)
    assert.ok(
      Math.max(target.width, target.height) <= LIMIT,
      `${image.width}×${image.height} → ${target.width}×${target.height}，长边仍然超过 ${LIMIT}`,
    )
  }
})

test('4800×800（虚构宽图）：修复前越线，修复后达标', () => {
  const image = { width: 4800, height: 800 }

  // 修复前：面积 384 万 < 419 万预算 → DSH 判定"无需缩放" → 目标就是原尺寸
  const before = routeTarget(image.width, image.height)
  assert.equal(before.width, 4800, '修复前应当原样不缩——这正是缺陷本身')
  assert.ok(before.width > LIMIT, '修复前确实越线')

  // 修复后
  const after = tightenTarget(image, before, LIMIT)
  // 断言的是契约（落在红线内、且没有被过度缩小），而不是某个精确数字。
  // 0.1.7 的 longEdgeDimensions 给出的是「长边恰好 2000」。
  assert.ok(after.width <= LIMIT, `修复后长边应 ≤ ${LIMIT}，实际 ${after.width}`)
  assert.ok(after.width > LIMIT * 0.95, `不应过度缩小，实际 ${after.width}`)
})

test('长边本来就达标的图：目标原样透传，画质零损失', () => {
  for (const image of SAMPLE_IMAGES.filter(i => !i.over)) {
    const target = routeTarget(image.width, image.height)
    const out = tightenTarget(image, target, LIMIT)
    assert.equal(out, target, `${image.width}×${image.height} 不该被干预（应返回原对象）`)
  }
})

test('缩放保持宽高比（误差在 1% 以内）', () => {
  for (const image of SAMPLE_IMAGES.filter(i => i.over)) {
    const out = tightenTarget(image, routeTarget(image.width, image.height), LIMIT)
    const before = image.width / image.height
    const after = out.width / out.height
    assert.ok(
      Math.abs(before - after) / before < 0.01,
      `${image.width}×${image.height} 比例漂移过大：${before} → ${after}`,
    )
  }
})

test('只收紧、绝不放宽：路由目标已经更小时保持不变', () => {
  // 路由的面积预算比我们更严（4800×800 已经被压到 1000×167）
  const tiny: ImageRequestTarget = { width: 1000, height: 167, maxBytes: 1 << 20 }
  const out = tightenTarget({ width: 4800, height: 800 }, tiny, LIMIT)
  assert.equal(out, tiny, '原目标比我们算的还小，应原样返回')
})

test('maxBytes 不受影响', () => {
  const target = routeTarget(4800, 800, 12345)
  const out = tightenTarget({ width: 4800, height: 800 }, target, LIMIT)
  assert.equal(out.maxBytes, 12345)
  assert.notEqual(out.width, target.width, '目标宽度应当被改小')
})

test('幂等：对已收紧的目标再跑一次不再变化', () => {
  const image = { width: 4800, height: 800 }
  const once = tightenTarget(image, routeTarget(image.width, image.height), LIMIT)
  const twice = tightenTarget(image, once, LIMIT)
  assert.equal(twice, once, '第二次应当原样返回同一个对象')
})

test('异常尺寸原样透传，交给 DSH 去校验报错', () => {
  const target = routeTarget(4800, 800)
  for (const bad of [
    { width: 0, height: 100 },
    { width: -5, height: 100 },
    { width: Number.NaN, height: 100 },
    { width: 100, height: Number.POSITIVE_INFINITY },
  ]) {
    assert.equal(tightenTarget(bad, target, LIMIT), target, `${JSON.stringify(bad)} 应当原样透传`)
  }
})

test('回归：超长条不被过度缩小（11983×1 应得 2000×1）', () => {
  // 短边最小只能是 1 像素。0.1.5 时代用面积预算反推会把长边压到 333px；
  // 0.1.7 直接按长边算，长边恰好是上限、短边 1px。
  const image = { width: 11983, height: 1 }
  const out = tightenTarget(image, routeTarget(image.width, image.height), LIMIT)
  assert.equal(out.width, LIMIT)
  assert.equal(out.height, 1)
  assert.deepEqual(out, {
    ...out,
    ...longEdgeDimensions(image.width, image.height, LIMIT),
  }, '应当就是宿主 longEdgeDimensions 的结果')
})

test('扫一遍大量长宽比：既不越线，也不过度缩小', () => {
  let exceeded = 0
  let overShrunk = 0
  for (let width = 2001; width <= 15000; width += 97) {
    for (let height = 50; height <= width; height += 311) {
      const out = tightenTarget({ width, height }, routeTarget(width, height), LIMIT)
      const longEdge = Math.max(out.width, out.height)
      if (longEdge > LIMIT) exceeded += 1
      // 真实截图（短边 ≥50px）不该被压到红线的 90% 以下
      if (longEdge < LIMIT * 0.9) overShrunk += 1
    }
  }
  assert.equal(exceeded, 0, `有 ${exceeded} 个尺寸越过了 ${LIMIT}px 红线`)
  assert.equal(overShrunk, 0, `有 ${overShrunk} 个尺寸被过度缩小`)
})

test('竖图同样受保护（长边在高度方向）', () => {
  const image = { width: 800, height: 4800 }
  const out = tightenTarget(image, routeTarget(image.width, image.height), LIMIT)
  assert.ok(out.height <= LIMIT, `竖图长边应 ≤ ${LIMIT}，实际 ${out.height}`)
  assert.ok(out.height > LIMIT * 0.95, `不应过度缩小，实际 ${out.height}`)
})

/**
 * 造一个形状对齐**真实** attachments 服务的桩。
 *
 * ★ 关键：方法必须挂在**原型**上（用 class），不能挂在对象自己身上。
 *
 * 真实的 `LocalAttachmentStore` 是个 class，`readImageRequest` 在原型上。
 * 早先的测试用对象字面量（方法是自有属性），结果**漏掉了一个无限递归的
 * bug**：补丁装成自有属性后，「调用时再去实例上取原实现」取到的是补丁
 * 自己，自己调自己直接爆栈。用 class 才能复现真实拓扑。
 */
class FakeStore {
  seen: ImageRequestTarget[] = []
  marker = 'instance-state'
  readImageRequest(
    _ref: unknown,
    target: ImageRequestTarget,
  ): Promise<string> {
    this.seen.push(target)
    return Promise.resolve(this.marker)
  }
}

test('patchAttachments：把收紧后的目标交给原实现', async () => {
  const store = new FakeStore()
  const restore = patchAttachments(store as unknown as ReadImageRequestHost, () => LIMIT)

  await store.readImageRequest({ width: 4800, height: 800 }, routeTarget(4800, 800))
  await store.readImageRequest({ width: 800, height: 600 }, routeTarget(800, 600))

  assert.equal(store.seen.length, 2)
  assert.ok(Math.max(store.seen[0]!.width, store.seen[0]!.height) <= LIMIT, '超限图应收到被收紧的目标')
  assert.equal(store.seen[1]!.width, 800, '达标图的目标不该被动')
  restore?.()
})

test('回归：方法在原型上时不会无限递归（真实服务就是这个形状）', async () => {
  const store = new FakeStore()
  const restore = patchAttachments(store as unknown as ReadImageRequestHost, () => LIMIT)
  // 早先的实现在这一行直接 RangeError: Maximum call stack size exceeded
  const got = await store.readImageRequest({ width: 4800, height: 800 }, routeTarget(4800, 800))
  assert.equal(got, 'instance-state')
  restore?.()
})

test('patchAttachments：卸载后干净还原到原型方法', async () => {
  const store = new FakeStore()
  const prototypeMethod = FakeStore.prototype.readImageRequest

  const restore = patchAttachments(store as unknown as ReadImageRequestHost, () => LIMIT)
  assert.ok(Object.hasOwn(store, 'readImageRequest'), '打补丁期间应有自有属性遮蔽原型')

  restore?.()
  assert.ok(!Object.hasOwn(store, 'readImageRequest'), '还原后自有属性应被删除')
  assert.equal(store.readImageRequest, prototypeMethod, '应回到原型上的原方法')

  // 还原之后行为回到「没装插件」：超限图不再被收紧
  await store.readImageRequest({ width: 4800, height: 800 }, routeTarget(4800, 800))
  assert.equal(store.seen[0]!.width, 4800)
})

test('patchAttachments：重复打补丁不叠层，后装的接管，先装的随后卸载不误删', async () => {
  const store = new FakeStore()
  const first = patchAttachments(store as unknown as ReadImageRequestHost, () => LIMIT)
  const second = patchAttachments(store as unknown as ReadImageRequestHost, () => 3000)

  // 旧层还在链上的话会再按 2000 收紧一次
  await store.readImageRequest({ width: 4800, height: 800 }, routeTarget(4800, 800))
  assert.equal(store.seen[0]!.width, 3000, '只按后装的上限收紧')

  first?.()
  await store.readImageRequest({ width: 4800, height: 800 }, routeTarget(4800, 800))
  assert.equal(store.seen[1]!.width, 3000, '先装的卸载不能拆掉后装的')

  second?.()
  assert.ok(!Object.hasOwn(store, 'readImageRequest'))
})

test('patchAttachments：原实现抛错时如实向上传播', async () => {
  class Boom {
    readImageRequest(): Promise<never> {
      return Promise.reject(new Error('boom'))
    }
  }
  const store = new Boom()
  const restore = patchAttachments(store as unknown as ReadImageRequestHost, () => LIMIT)
  await assert.rejects(() => store.readImageRequest(), /boom/)
  restore?.()
})

test('patchAttachments：原实现能通过 this 访问实例状态', async () => {
  const store = new FakeStore()
  store.marker = 'root-and-compression'
  const restore = patchAttachments(store as unknown as ReadImageRequestHost, () => LIMIT)
  const got = await store.readImageRequest({ width: 10, height: 10 }, { width: 10, height: 10, maxBytes: 1 })
  assert.equal(got, 'root-and-compression', 'this 必须绑回实例，否则原实现读不到 root/compression')
  restore?.()
})

test('现读上限：改了设置立刻生效，不用重新打补丁', async () => {
  // 这条守的是「选项可热改」：上限走 thunk 现读，所以换掉闭包外的值，
  // 下一次调用就该用新值。写成存下来的数字，这个用例会失败。
  const store = new FakeStore()
  let limit = 2000
  const restore = patchAttachments(store as unknown as ReadImageRequestHost, () => limit)

  await store.readImageRequest({ width: 4800, height: 800 }, routeTarget(4800, 800))
  const at2000 = store.seen[0]!
  assert.equal(Math.max(at2000.width, at2000.height), 2000, '2000px 上限下应当收紧到 2000')

  // 放宽到 2576（虚构策略值）：4800 仍然超限，但目标该跟着变大
  limit = 2576
  await store.readImageRequest({ width: 4800, height: 800 }, routeTarget(4800, 800))
  const at2576 = store.seen[1]!
  assert.ok(at2576.width > at2000.width, `放宽上限后目标应变大：${at2000.width} → ${at2576.width}`)
  assert.ok(at2576.width <= 2576, '新目标仍要满足新的红线')

  // 收紧回 2000 → 4800×800 又回到被压的状态；而 2100×500 这种在新旧阈值间
  // 的图，跟着阈值走才说明是真现读而不是碰巧
  limit = 2000
  await store.readImageRequest({ width: 2100, height: 500 }, routeTarget(2100, 500))
  assert.equal(store.seen[2]!.width, 2000, '2100 > 2000，应当被收紧')

  limit = 4000
  await store.readImageRequest({ width: 2100, height: 500 }, routeTarget(2100, 500))
  assert.equal(store.seen[3]!.width, 2100, '2100 < 4000，不该再干预')

  restore?.()
})

/* ─────────────── 设置接线（0.1.7 的 volatile 模型） ─────────────── */

/**
 * 0.1.7 的设置链路：设置页写 profile patch，loader 把 volatile 字段的新值
 * **原地提交**进正在运行的 config 单元格（`updateVolatile()`），插件不重载。
 * 这里模拟这一步：解析出新值后写进单元格。写入符号是 cosmokit 的
 * 跨副本协议（`Symbol.for('cosmokit.volatile.write')`）。
 */
const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write')

type Cells = ReturnType<typeof Config>

function snapshotCells(config: Cells): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(config).map(([key, cell]) => [key, (cell as { get(): unknown }).get()]),
  )
}

/** 模拟用户改设置：把补丁层的新值原地提交进运行中的单元格。 */
function commitCells(config: Cells, patch: Record<string, unknown>): void {
  const next = Config({ ...snapshotCells(config), ...patch })
  for (const key of Object.keys(patch)) {
    const cell = (config as Record<string, unknown>)[key]
    ;(cell as Record<symbol, (value: unknown) => void>)[VOLATILE_WRITE]!(
      (next as Record<string, { get(): unknown }>)[key]!.get(),
    )
  }
}

/** 最小 ctx 桩：`inject` 只在该服务存在时回调，和 cordis 的行为一致。 */
function fakeCtx(services: Record<string, unknown>) {
  const logs: string[] = []
  const disposes: (void | (() => void))[] = []
  const ctx = {
    logs,
    logger: () => ({
      info: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
      debug: () => {},
    }),
    // 现取服务：插件在回调里用 ctx.get() 拿可选依赖（attachments / fs）
    get: (name: string) => services[name],
    inject(names: string[], callback: (scoped: unknown) => void) {
      if (!names.every(name => services[name] !== undefined)) return
      callback({
        ...services,
        get: (name: string) => services[name],
        effect: (fn: () => void | (() => void)) => disposes.push(fn()),
      })
    },
  }
  return { ctx: ctx as unknown as Context, logs, disposes }
}

test('设置入口：全部字段都是 volatile（设置卡片的可写字段以此为准）', () => {
  // 0.1.7 的 GUI 入口是 client 半自注册的卡片，但可写字段以 Config schema 的
  // volatile 标记为准：SettingsForms 只端 volatile 字段、settings 写入只接受
  // volatile 字段。哪个字段忘了标，卡片上那一项就写不进。
  const dict = (Config as unknown as { dict: Record<string, { meta: { volatile?: boolean } }> }).dict
  for (const [key, child] of Object.entries(dict)) {
    assert.equal(child.meta.volatile, true, `${key} 忘了标 .volatile()`)
  }
})

test('选项改完立刻作用到补丁上（volatile 原地提交）', async () => {
  const store = new FakeStore()
  const { ctx, logs, disposes } = fakeCtx({ attachments: store })
  const config = Config({ maxLongEdge: 2000 })

  apply(ctx, config)

  await store.readImageRequest({ width: 4800, height: 800 }, routeTarget(4800, 800))
  assert.equal(store.seen[0]!.width, 2000, '条目 config 的 2000 应当生效')

  // 用户在设置页把长边上限改成 4000 → loader 原地提交
  commitCells(config, { maxLongEdge: 4000 })
  await store.readImageRequest({ width: 2100, height: 500 }, routeTarget(2100, 500))
  assert.equal(store.seen[1]!.width, 2100, '2100 < 4000，改完立刻不再干预')

  assert.ok(
    logs.some(line => line.includes('2000')),
    `生效上限应当写进日志，实际日志：${logs.join(' / ')}`,
  )

  disposes.forEach(dispose => dispose?.())
})

test('headless（没有 GUI/设置服务）照样生效：值就是条目 config 本身', async () => {
  const store = new FakeStore()
  const { ctx, disposes } = fakeCtx({ attachments: store })

  apply(ctx, Config({ maxLongEdge: 2000 }))
  await store.readImageRequest({ width: 4800, height: 800 }, routeTarget(4800, 800))

  assert.equal(store.seen[0]!.width, 2000, '没有设置服务也要能收紧')
  disposes.forEach(dispose => dispose?.())
})

/* ─────────────────────── 第二条红线：请求图片张数上限 ─────────────────────── */

/** 造一张真实形状的图片引用；张数逻辑只看出现次数，不看尺寸。 */
function imageRef(index: number): ImageAttachmentRef {
  return {
    attachmentId: `img-${index}` as ImageAttachmentRef['attachmentId'],
    mediaType: 'image/png',
    bytes: 1024,
    width: 100,
    height: 50,
  }
}

/** 造一条带 `count` 张图的用户消息，图片 id 从 `start` 开始编号。 */
function imagesMessage(count: number, start = 0): Message {
  return createUserMessage({
    content: Array.from({ length: count }, (_, offset) => ({
      type: 'image' as const,
      attachment: imageRef(start + offset),
    })),
    source: { kind: 'user' as const },
  })
}

/** 收集一次投影实际省略掉的图片 id（占位符按被省略的顺序回调）。 */
function omittedIds(messages: readonly Message[], maxImages: number, countQuantum: number): string[] {
  const ids: string[] = []
  projectImageCount(messages, {
    maxImages,
    countQuantum,
    placeholder: (ref) => {
      ids.push(String(ref.attachmentId))
      return '[省略]'
    },
  })
  return ids
}

test('张数上限：31 张 / 上限 30 / 步长 8 → 裁掉最老的 8 张，剩 23 张', () => {
  const messages = [imagesMessage(31)]
  const out = projectImageCount(messages, { maxImages: 30, countQuantum: 8, placeholder: () => '[省略]' })

  assert.equal(countImages(messages), 31, '原消息一个字都不能被改动')
  assert.equal(countImages(out), 23, '超 1 张，按步长 8 一次裁掉 8 张')
  assert.equal(out[0]!.content.filter(block => block.type === 'text').length, 8)
})

test('张数上限：没超限时原样返回（引用相等，零成本跳过）', () => {
  const messages = [imagesMessage(30)]
  const out = projectImageCount(messages, { maxImages: 30, countQuantum: 8, placeholder: () => '[省略]' })
  assert.equal(out, messages, '没超限不该造新数组')
})

test('张数上限：裁的永远是最老的那些图', () => {
  assert.deepEqual(
    omittedIds([imagesMessage(31)], 30, 8),
    ['img-0', 'img-1', 'img-2', 'img-3', 'img-4', 'img-5', 'img-6', 'img-7'],
  )
})

test('张数上限：步长决定一次裁多少，保留张数落在 (上限−步长, 上限]', () => {
  const remaining = (n: number): number => countImages(projectImageCount(
    [imagesMessage(n)],
    { maxImages: 30, countQuantum: 8, placeholder: () => '[省略]' },
  ))
  assert.equal(remaining(30), 30, '刚好到上限：不动')
  assert.equal(remaining(31), 23)
  assert.equal(remaining(38), 30, '超 8 张：正好裁一个步长')
  assert.equal(remaining(39), 23, '超 9 张：向上取整到两个步长')
})

test('张数上限：一个步长区间内前缀稳定（这正是步长换来的缓存复用）', () => {
  // 投影改的是最老的前缀，前缀一变它之后的 KV 缓存全部作废。31 张和 38 张
  // 两次请求必须省略同一批图，否则每贴一张新截图，整段历史都要重读一遍。
  const at31 = omittedIds([imagesMessage(31)], 30, 8)
  assert.deepEqual(omittedIds([imagesMessage(38)], 30, 8), at31, '同一步长区间内省略的还是那 8 张')
  assert.notDeepEqual(omittedIds([imagesMessage(39)], 30, 8), at31, '越过下一个台阶才动前缀')
})

test('张数上限：工具结果消息里的截图同样计入', () => {
  // 0.1.7 里工具结果是独立的 role:"tool" 消息，图片块在顶层 content。
  const callId = 'call-1' as unknown as Parameters<typeof createToolResultMessage>[0]['callId']
  const toolMessage = createToolResultMessage({
    callId,
    content: [{ type: 'image', attachment: imageRef(9) }],
    isError: false,
  })
  const messages = [imagesMessage(1), toolMessage]

  assert.equal(countImages(messages), 2, '工具结果里的截图也要数进来')
  // 上限 1、步长 1：只裁最老的那张（用户消息里的），工具消息里的留着
  const out = projectImageCount(messages, { maxImages: 1, countQuantum: 1, placeholder: () => '[省略]' })
  assert.equal(countImages(out), 1)
  assert.equal(out[1], toolMessage, '没被裁的消息应当原样保留（引用相等）')
})

test('张数上限：已经 offloaded 的图不占张数（它们发出的已是占位文字）', () => {
  // 压缩那一路先标记了一批；本插件数上限时不能把它们再算进去，
  // 否则会把「已经换成文字的图」当图数，误裁还有效的图。
  const marked = createUserMessage({
    content: [
      { type: 'image' as const, attachment: imageRef(0), offloaded: true as const },
      { type: 'image' as const, attachment: imageRef(1) },
    ],
    source: { kind: 'user' as const },
  })
  assert.equal(countImages([marked]), 2, 'countImages 数全部图片块（日志用）')
  const out = projectImageCount([marked], { maxImages: 1, countQuantum: 1, placeholder: () => '[省略]' })
  assert.equal(out[0], marked, '保留中的只有 1 张、上限 1：不该再裁')
})

test('占位符用的是 DSH 自己的 offloadedImageText：带附件 id 与只读路径', () => {
  const ref = imageRef(7)
  const text = offloadedImageText(ref)
  assert.ok(text.includes('img-7'), `占位符要点名是哪张图，实际：${text}`)

  const withPath = offloadedImageText(ref, { readonlyPath: '/tmp/normalized.png' })
  assert.ok(withPath.includes('/tmp/normalized.png'), '有只读路径时模型还能把图读回来')
})

test('默认值：上限 30 张（撞过的硬线）、步长 8', () => {
  const defaults = Config({})
  assert.equal(DEFAULT_MAX_IMAGES_PER_REQUEST, 30)
  assert.equal(defaults.maxImagesPerRequest.get(), DEFAULT_MAX_IMAGES_PER_REQUEST)
  assert.equal(defaults.imageCountQuantum.get(), DEFAULT_IMAGE_COUNT_QUANTUM)
  assert.deepEqual(defaults.providerMaxImages.get(), {})
})

test('providerMaxImages：逐条线路覆盖全局上限', () => {
  const cells = Config({ maxImagesPerRequest: 30, providerMaxImages: { "override-provider": 100 } })
  const config = {
    maxLongEdge: cells.maxLongEdge.get(),
    maxImagesPerRequest: cells.maxImagesPerRequest.get(),
    imageCountQuantum: cells.imageCountQuantum.get(),
    providerMaxImages: cells.providerMaxImages.get(),
  }
  assert.equal(maxImagesFor(config, 'example-provider'), 30, '没写的线路用全局值')
  assert.equal(maxImagesFor(config, 'override-provider'), 100)
})

/**
 * 造一个形状对齐**真实** LlmRuntime 的桩。
 *
 * ★ 方法必须挂在**原型**上（用 class），理由同 FakeStore：真实 `LlmRuntime`
 * 是 class，`adapterStream` 在原型上。挂成对象自有属性会让「安装前捕获原实现」
 * 这条不变式的回归测不出来。
 */
class FakeLlm {
  seen: { options: GenerateOptions; prepared: unknown }[] = []
  marker = 'llm-instance-state'

  async *adapterStream(options: GenerateOptions, prepared?: unknown): AsyncIterable<StreamChunk> {
    this.seen.push({ options, prepared })
    yield { type: 'text-delta', text: this.marker } as unknown as StreamChunk
  }
}

/** 把一条 chunk 流读干净。 */
async function drain(stream: AsyncIterable<StreamChunk>): Promise<void> {
  for await (const _chunk of stream) void _chunk
}

/** 造一次最小请求。 */
function requestWith(provider: string, messages: Message[]): GenerateOptions {
  return { provider, model: 'test-model', messages }
}

const CAP_30 = { maxImages: 30, countQuantum: 8 }

test('patchLlm：超限的请求交给原实现时已经被投影过', async () => {
  const llm = new FakeLlm()
  const restore = patchLlm(llm as unknown as AdapterStreamHost, () => CAP_30, () => '[省略]')

  const messages = [imagesMessage(31)]
  await drain(llm.adapterStream(requestWith('example-provider', messages)))

  const sent = llm.seen[0]!.options
  assert.notEqual(sent.messages, messages, '应当造一份投影后的新历史')
  assert.equal(countImages(sent.messages), 23)
  assert.equal(countImages(messages), 31, '原历史不受影响')
  restore?.()
})

test('patchLlm：没超限时把原请求原样交给原实现（同一个对象，零开销）', async () => {
  const llm = new FakeLlm()
  const restore = patchLlm(llm as unknown as AdapterStreamHost, () => CAP_30, () => '[省略]')

  const request = requestWith('example-provider', [imagesMessage(30)])
  await drain(llm.adapterStream(request))
  assert.equal(llm.seen[0]!.options, request, '没超限就不该造新对象')
  restore?.()
})

test('patchLlm：prepared 原样透传，this 仍绑在真实服务实例上', async () => {
  const llm = new FakeLlm()
  const prepared = { registration: 'fake' }
  const restore = patchLlm(llm as unknown as AdapterStreamHost, () => CAP_30, () => '[省略]')

  await drain(llm.adapterStream(requestWith('example-provider', [imagesMessage(31)]), prepared))
  assert.equal(llm.seen[0]!.prepared, prepared, 'preparedCall 的第二参必须原样传下去')

  const chunks: StreamChunk[] = []
  for await (const chunk of llm.adapterStream(requestWith('example-provider', [imagesMessage(1)]))) chunks.push(chunk)
  assert.equal((chunks[0] as unknown as { text: string }).text, 'llm-instance-state', 'this 必须绑回实例')
  restore?.()
})

test('patchLlm：loop 造的冻结请求，投影后仍然冻结', async () => {
  const llm = new FakeLlm()
  const restore = patchLlm(llm as unknown as AdapterStreamHost, () => CAP_30, () => '[省略]')

  const messages = Object.freeze([imagesMessage(31)]) as unknown as Message[]
  const request = Object.freeze(requestWith('example-provider', messages))
  await drain(llm.adapterStream(request))

  const sent = llm.seen[0]!.options
  assert.notEqual(sent, request)
  assert.ok(Object.isFrozen(sent), '「loop 请求不可变」这条性质要保住')
  restore?.()
})

test('patchLlm：手搓的未冻结请求不替它冻上', async () => {
  const llm = new FakeLlm()
  const restore = patchLlm(llm as unknown as AdapterStreamHost, () => CAP_30, () => '[省略]')

  await drain(llm.adapterStream(requestWith('example-provider', [imagesMessage(31)])))
  assert.ok(!Object.isFrozen(llm.seen[0]!.options), '本来没冻的请求不该被我们冻上')
  restore?.()
})

test('patchLlm：卸载后干净还原到原型方法', async () => {
  const llm = new FakeLlm()
  const prototypeMethod = FakeLlm.prototype.adapterStream

  const restore = patchLlm(llm as unknown as AdapterStreamHost, () => CAP_30, () => '[省略]')
  assert.ok(Object.hasOwn(llm, 'adapterStream'), '打补丁期间应有自有属性遮蔽原型')

  restore?.()
  assert.ok(!Object.hasOwn(llm, 'adapterStream'), '还原后自有属性应被删除')
  assert.equal(llm.adapterStream, prototypeMethod, '应回到原型上的原方法')

  // 还原之后行为回到「没装插件」：31 张原样发出去
  await drain(llm.adapterStream(requestWith('example-provider', [imagesMessage(31)])))
  assert.equal(countImages(llm.seen[0]!.options.messages), 31)
})

test('patchLlm：重复打补丁不叠层，后装的接管，先装的随后卸载不误删', async () => {
  const llm = new FakeLlm()
  const first = patchLlm(llm as unknown as AdapterStreamHost, () => CAP_30, () => '[省略]')
  const second = patchLlm(llm as unknown as AdapterStreamHost, () => ({ maxImages: 40, countQuantum: 8 }), () => '[省略]')

  // 旧层还在链上的话会再按 30 张裁一次
  await drain(llm.adapterStream(requestWith('example-provider', [imagesMessage(31)])))
  assert.equal(countImages(llm.seen[0]!.options.messages), 31, '只按后装的上限')

  first?.()
  await drain(llm.adapterStream(requestWith('example-provider', [imagesMessage(41)])))
  assert.equal(countImages(llm.seen[1]!.options.messages), 33, '先装的卸载不能拆掉后装的')

  second?.()
  assert.ok(!Object.hasOwn(llm, 'adapterStream'))
})

test('patchLlm：策略按 provider 现读，改完立刻生效', async () => {
  const llm = new FakeLlm()
  let maxImages = 30
  const restore = patchLlm(
    llm as unknown as AdapterStreamHost,
    provider => ({ maxImages: provider === 'override-provider' ? 100 : maxImages, countQuantum: 8 }),
    () => '[省略]',
  )

  await drain(llm.adapterStream(requestWith('example-provider', [imagesMessage(31)])))
  assert.equal(countImages(llm.seen[0]!.options.messages), 23, '默认 30：裁到 23')

  await drain(llm.adapterStream(requestWith('override-provider', [imagesMessage(31)])))
  assert.equal(countImages(llm.seen[1]!.options.messages), 31, 'claude 上限 100，不该动')

  maxImages = 10
  await drain(llm.adapterStream(requestWith('example-provider', [imagesMessage(31)])))
  assert.equal(countImages(llm.seen[2]!.options.messages), 7, '上限改成 10：超 21 张，向上取整到 24')

  restore?.()
})

test('patchLlm：策略抛错时退回原请求，不拖垮模型调用', async () => {
  const llm = new FakeLlm()
  const restore = patchLlm(
    llm as unknown as AdapterStreamHost,
    () => {
      throw new Error('boom')
    },
    () => '[省略]',
  )

  const request = requestWith('example-provider', [imagesMessage(31)])
  await drain(llm.adapterStream(request))
  assert.equal(llm.seen[0]!.options, request, '插件自己出错时必须退回「没装插件」的行为')
  restore?.()
})

test('契约：DSH 的 LlmRuntime 上确实有 adapterStream，两条公开入口都汇到它', () => {
  // 本插件挂在 DSH 的**内部**方法上，上游改名或改结构就得跟着改。
  // 这三条断言是「静默失效」的报警器：DSH 一动内部结构，测试先红。
  // 类型上是 private，所以这里按结构取——测的本来就是「运行时有没有」。
  const proto = LlmRuntime.prototype as unknown as {
    adapterStream?: unknown
    streamWithRegistration: () => unknown
    stream: () => unknown
  }
  assert.equal(typeof proto.adapterStream, 'function')

  const funnel = proto.streamWithRegistration.toString()
  assert.ok(funnel.includes('adapterStream'), `streamWithRegistration 应当汇到 adapterStream，实际：${funnel}`)

  const entry = proto.stream.toString()
  assert.ok(entry.includes('streamWithRegistration'), `stream 应当汇到 streamWithRegistration，实际：${entry}`)
})

test('接线：apply 同时装上两个补丁，张数上限走 volatile 现读', async () => {
  const store = new FakeStore()
  const llm = new FakeLlm()
  const { ctx, logs, disposes } = fakeCtx({ attachments: store, llm })
  const config = Config({})

  apply(ctx, config)

  await drain(llm.adapterStream(requestWith('example-provider', [imagesMessage(31)])))
  assert.equal(countImages(llm.seen[0]!.options.messages), 23, '默认上限 30 应当生效')

  // 用户把上限改成 40 → loader 原地提交 → 立刻不再裁
  commitCells(config, { maxImagesPerRequest: 40 })
  await drain(llm.adapterStream(requestWith('example-provider', [imagesMessage(31)])))
  assert.equal(countImages(llm.seen[1]!.options.messages), 31, '放宽到 40 后 31 张不该再裁')

  // 逐条线路覆盖
  commitCells(config, { maxImagesPerRequest: 30, providerMaxImages: { "override-provider": 100 } })
  await drain(llm.adapterStream(requestWith('override-provider', [imagesMessage(31)])))
  assert.equal(countImages(llm.seen[2]!.options.messages), 31, '示例覆盖线路走逐条覆盖的 100')

  // 长边那条路也还在
  await store.readImageRequest({ width: 4800, height: 800 }, routeTarget(4800, 800))
  assert.equal(store.seen[0]!.width, 2000, '长边补丁不该被张数补丁挤掉')

  assert.ok(
    logs.some(line => line.includes('张数上限')),
    `张数上限生效应当有日志，实际：${logs.join(' / ')}`,
  )
  disposes.forEach(dispose => dispose?.())
})

test('接线：拿得到只读路径时，占位符里带上映射后的路径', async () => {
  const llm = new FakeLlm()
  // 附件服务给宿主路径，文件系统服务把宿主路径映射进当前工具执行世界
  const attachments = {
    imageHostPath: (ref: ImageAttachmentRef) => `/host/objects/${String(ref.attachmentId)}.png`,
  }
  const fs = { processPathFromHostPath: (hostPath: string) => hostPath.replace('/host', '/sandbox') }
  const { ctx, disposes } = fakeCtx({ attachments, llm, fs })

  apply(ctx, Config({}))
  await drain(llm.adapterStream(requestWith('example-provider', [imagesMessage(31)])))

  const omitted = llm.seen[0]!.options.messages
    .flatMap(message => message.content)
    .filter(block => block.type === 'text')
    .map(block => (block as { text: string }).text)
  assert.ok(
    omitted.some(text => text.includes('/sandbox/objects/img-0.png')),
    `占位符应当带上映射后的只读路径，实际：${omitted.join(' | ')}`,
  )

  disposes.forEach(dispose => dispose?.())
})

test('接线：没挂 llm 服务时只装长边补丁，不报错', async () => {
  const store = new FakeStore()
  const { ctx, disposes } = fakeCtx({ attachments: store })

  apply(ctx, Config({}))
  await store.readImageRequest({ width: 4800, height: 800 }, routeTarget(4800, 800))

  assert.equal(store.seen[0]!.width, 2000, '没有 llm 也要能收紧长边')
  disposes.forEach(dispose => dispose?.())
})

test('接线：llm 上没有 adapterStream 时告警，而不是静默失效', () => {
  const { ctx, logs } = fakeCtx({ llm: { marker: 'no-adapterStream' } })

  apply(ctx, Config({}))
  assert.ok(
    logs.some(line => line.includes('adapterStream')),
    `结构变了必须告警，实际：${logs.join(' / ')}`,
  )
})

/* ─────────────────── 端到端：真实 LlmRuntime 上的两条入口 ─────────────────── */

/**
 * 上面那些用例用桩测拓扑，这一组用**真实**的 `LlmRuntime` 测收口。
 *
 * 要证明的事只有一件：agent-loop 的两条入口——公开的 `llm.stream()` 和
 * 它正常走的那条 `preparedCall.stream()`——都必须经过被包装的
 * `adapterStream()`。少拦到一条，「张数上限」在真实链路上就是漏的。
 */
class RecordingAdapter extends LlmAdapter {
  seen: { images: number; texts: string[] }[] = []

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: 100_000 },
      inputModalities: ['text', 'image'],
    }
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.seen.push({
      images: countImages(options.messages),
      texts: options.messages
        .flatMap(message => message.content)
        .filter(block => block.type === 'text')
        .map(block => (block as { text: string }).text),
    })
    yield { type: 'finish', reason: { kind: 'stop' } } as unknown as StreamChunk
  }
}

test('端到端：真实 LlmRuntime 上，两条入口都被张数投影拦到', async () => {
  const llm = new LlmRuntime(new Context())
  const adapter = new RecordingAdapter()
  llm.registerAdapter(['fake'], adapter)
  const restore = patchLlm(
    llm as unknown as AdapterStreamHost,
    () => CAP_30,
    ref => `[省略 ${String(ref.attachmentId)}]`,
  )

  const messages = [imagesMessage(31)]
  await drain(llm.stream({ provider: 'fake', model: 'm', messages }))
  assert.equal(adapter.seen[0]!.images, 23, 'llm.stream() 这条入口必须被拦到')
  assert.ok(adapter.seen[0]!.texts.some(text => text.includes('img-0')), '占位符要落到真实请求里')

  const prepared = await llm.prepareCall({ provider: 'fake', model: 'm' })
  await drain(prepared.stream({ provider: 'fake', model: 'm', messages }))
  assert.equal(adapter.seen[1]!.images, 23, 'preparedCall.stream() 这条入口必须被拦到')

  // loop 造的请求是**深冻结**的，真实链路上就是这种形状
  const frozen = Object.freeze({
    provider: 'fake',
    model: 'm',
    messages: Object.freeze([imagesMessage(31)]) as unknown as Message[],
  })
  await drain(llm.stream(frozen))
  assert.equal(adapter.seen[2]!.images, 23, '冻结请求也要能裁')

  // 没超限的请求原样透传
  await drain(llm.stream({ provider: 'fake', model: 'm', messages: [imagesMessage(30)] }))
  assert.equal(adapter.seen[3]!.images, 30, '没超限不该被动')

  restore?.()
  await drain(llm.stream({ provider: 'fake', model: 'm', messages }))
  assert.equal(adapter.seen[4]!.images, 31, '卸载后回到「没装插件」的行为')
})
