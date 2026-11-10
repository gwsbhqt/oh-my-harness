/**
 * 经真实 cordis 服务代理取宿主对象时，两个补丁能不能装上、撤掉、重装不叠层。
 *
 * 真机上插件拿到的 `attachments` / `llm` 是 cordis 的服务代理：每读一次方法都
 * 返回新包装，引用比较永远不相等。普通 class 实例测不出这类问题，所以这里把
 * 宿主挂成真实 cordis 服务，走 `ctx.plugin()` / `fiber.update()` / `fiber.dispose()`。
 *
 * 判断「叠没叠层」靠放宽配置：旧层还在链上的话，它会按旧的更严的上限再裁一次。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import type { ImageAttachmentRef, ImageRequestTarget } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, type GenerateOptions, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Config, apply, countImages } from '../src/index.ts'

class Attachments extends Service {
  constructor(ctx: Context) {
    super(ctx, 'attachments')
  }

  async readImageRequest(_ref: ImageAttachmentRef, target: ImageRequestTarget): Promise<ImageRequestTarget> {
    return target
  }
}

class Llm extends Service {
  constructor(ctx: Context) {
    super(ctx, 'llm')
  }

  async *adapterStream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'probe', images: countImages(options.messages) } as unknown as StreamChunk
  }
}

/** inject 回调在子 fiber 里异步执行，等它们都落定。 */
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

function imagesMessage(count: number): Message {
  return createUserMessage({
    content: Array.from({ length: count }, (_, index) => ({
      type: 'image' as const,
      attachment: {
        attachmentId: `img-${index}` as ImageAttachmentRef['attachmentId'],
        mediaType: 'image/png',
        bytes: 1024,
        width: 100,
        height: 50,
      },
    })),
    source: { kind: 'user' as const },
  })
}

async function setup() {
  const ctx = new Context()
  const att = new Attachments(ctx)
  const llm = new Llm(ctx)
  await settle()
  /** 4800×800 的图原样交上去，看宿主最终收到的目标宽度。 */
  const width = async () => {
    const host = ctx.get('attachments') as unknown as Attachments
    const ref = { width: 4800, height: 800 } as ImageAttachmentRef
    return (await host.readImageRequest(ref, { width: 4800, height: 800, maxBytes: 1 << 20 })).width
  }
  /** 一次请求带 31 张图，看宿主最终收到几张。 */
  const images = async () => {
    const host = ctx.get('llm') as unknown as Llm
    for await (const chunk of host.adapterStream({ provider: 'p', model: 'm', messages: [imagesMessage(31)] })) {
      return (chunk as unknown as { images: number }).images
    }
    throw new Error('adapterStream 没有产出')
  }
  const clean = () => !Object.hasOwn(att, 'readImageRequest') && !Object.hasOwn(llm, 'adapterStream')
  return { ctx, att, llm, width, images, clean }
}

/** 每次新建一个插件对象：同一个对象 plugin 两次会被 cordis 当成同一个运行时。 */
const plugin = () => ({ name: 'dsh-image-cap', apply, Config })

test('真 cordis：停用插件后两个补丁都撤掉，宿主行为恢复', async () => {
  const { ctx, width, images, clean } = await setup()
  const fiber = ctx.plugin(plugin(), {})
  await settle()
  assert.equal(await width(), 2000)
  assert.equal(await images(), 23)

  await fiber.dispose()
  await settle()
  assert.equal(await width(), 4800, '停用后不该再收紧长边')
  assert.equal(await images(), 31, '停用后不该再裁张数')
  assert.ok(clean(), '停用后原型方法应重新露出')
})

test('真 cordis：改配置重载（先 dispose 后 apply）不叠层，只按新配置生效', async () => {
  const { ctx, width, images, clean } = await setup()
  const fiber = ctx.plugin(plugin(), {})
  await settle()
  assert.equal(await width(), 2000)
  assert.equal(await images(), 23)

  fiber.update({ maxLongEdge: 3000, maxImagesPerRequest: 40 })
  await fiber.await()
  await settle()
  assert.equal(await width(), 3000, '旧层不该留在链上再按 2000 收紧一次')
  assert.equal(await images(), 31, '旧层不该留在链上再按 30 张裁一次')

  await fiber.dispose()
  await settle()
  assert.equal(await width(), 4800)
  assert.equal(await images(), 31)
  assert.ok(clean())
})

test('真 cordis：乱序重载（新 apply 先于旧 dispose）不叠层，旧的后卸不误删新的', async () => {
  const { ctx, width, images, clean } = await setup()
  const first = ctx.plugin(plugin(), {})
  await settle()
  const second = ctx.plugin(plugin(), { maxLongEdge: 3000, maxImagesPerRequest: 40 })
  await settle()
  assert.equal(await width(), 3000, '新补丁接管，旧补丁不再参与')
  assert.equal(await images(), 31)

  await first.dispose()
  await settle()
  assert.equal(await width(), 3000, '旧 fiber 后卸不能拆掉新补丁')
  assert.equal(await images(), 31)
  // 新补丁还在：把 31 张收紧到 40 以下不会触发，但长边 3000 仍然生效
  second.update({ maxLongEdge: 3000, maxImagesPerRequest: 30 })
  await second.await()
  await settle()
  assert.equal(await images(), 23)

  await second.dispose()
  await settle()
  assert.equal(await width(), 4800)
  assert.equal(await images(), 31)
  assert.ok(clean())
})

test('真 cordis：别人后来又包了一层时，卸载不破坏别人那层，自己那层变直通', async () => {
  const { ctx, att, llm, width, images } = await setup()
  const fiber = ctx.plugin(plugin(), {})
  await settle()

  // 另一个插件按描述符取当前实现，再包一层（只数调用次数）
  let calls = 0
  const belowRead = Object.getOwnPropertyDescriptor(att, 'readImageRequest')!.value as Attachments['readImageRequest']
  function otherRead(this: Attachments, ref: ImageAttachmentRef, target: ImageRequestTarget) {
    calls += 1
    return belowRead.call(this, ref, target)
  }
  Object.defineProperty(att, 'readImageRequest', { value: otherRead, writable: true, configurable: true })
  const belowStream = Object.getOwnPropertyDescriptor(llm, 'adapterStream')!.value as Llm['adapterStream']
  function otherStream(this: Llm, options: GenerateOptions) {
    calls += 1
    return belowStream.call(this, options)
  }
  Object.defineProperty(llm, 'adapterStream', { value: otherStream, writable: true, configurable: true })
  assert.equal(await width(), 2000)
  assert.equal(await images(), 23)

  await fiber.dispose()
  await settle()
  assert.equal(Object.getOwnPropertyDescriptor(att, 'readImageRequest')?.value, otherRead, '别人那层原样保留')
  assert.equal(Object.getOwnPropertyDescriptor(llm, 'adapterStream')?.value, otherStream, '别人那层原样保留')
  calls = 0
  assert.equal(await width(), 4800, '自己那层只剩直通')
  assert.equal(await images(), 31, '自己那层只剩直通')
  assert.equal(calls, 2, '别人那层仍在工作')
})
