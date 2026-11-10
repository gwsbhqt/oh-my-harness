import { live } from '../../tooling/runtime/live.mjs'
import { createMethodPatcher } from '../../tooling/runtime/method-patch.mjs'
/**
 * 请求图片预算：只收紧宿主目标长边，并在适配器调用前按步长省略最老图片。
 *
 * 像素缩放、附件缓存、offloaded 占位符与字节预算仍由宿主负责；不改会话原始消息。
 * adapterStream 同时覆盖普通与 preparedCall 入口。内部宿主结构变化须由契约测试检查。
 * 方法包装的原型、代理与卸载所有权不变式见 AGENTS.md。
 * @module
 */
import type { Context } from '@deepseek-ai/cordis'
import {
  longEdgeDimensions,
  type ImageAttachmentRef,
  type ImageRequestTarget,
} from '@deepseek-ai/dsh-attachment'
import {
  offloadedImageText,
  projectOffloadedImages,
  resolveImageAttachmentAccess,
  type GenerateOptions,
  type ImageAttachmentAccess,
  type RequestMessage,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import z from '@deepseek-ai/schemastery'

/**
 * Anthropic 在「>20 张图」请求里对每张图施加的单边红线。
 * 这是服务端的硬规则，不是我们挑的数。
 */
export const MANY_IMAGE_LONG_EDGE_LIMIT = 2000

/**
 * 一个请求最多发多少张图。
 *
 * 这是 schema 默认策略，不是所有服务商的固定限制；随包或 profile 配置可覆盖。
 */
export const DEFAULT_MAX_IMAGES_PER_REQUEST = 30

/**
 * 张数裁剪的步长：超限时一次裁掉「超出部分向上取整到步长」张。
 *
 * 为什么不是超一张裁一张：投影替换的是**最老**的那几张图，前缀一变，
 * 它之后的 KV 缓存全部作废（缓存只按前缀复用）。步长 1 意味着每贴一张新图
 * 就把整段历史重读一遍；步长 8 意味着每多 8 张才动一次前缀。
 * 代价是超限那一刻会多裁几张（最多 7 张），拿一点上下文换缓存。
 */
export const DEFAULT_IMAGE_COUNT_QUANTUM = 8

/** 一张图的固有尺寸；只取我们需要的两个字段，方便测试直接构造。 */
export interface Dimensions {
  width: number
  height: number
}

/**
 * 按单边红线收紧一份请求图目标。
 *
 * 0.1.7 的 `target` 是具体尺寸：编码器按「参考图长边 → target 长边」缩放
 * （`pipeline()` 只按长边一个方向 resize，短边由编码器按比例推出），所以
 * 把目标长边压到红线以内就够了。尺寸计算用宿主自己的 `longEdgeDimensions()`，
 * 和编码器的取整方式逐像素一致（短边 round、最小 1px——退化比例如 11983×1
 * 会得到 2000×1，不会被面积公式压到 333px，那是 0.1.5 时代反推面积预算
 * 才需要的兜底）。
 *
 * **只收紧、绝不放宽**：目标长边本来就在红线内时原样返回（引用相等，
 * 便于调用方判断），哪怕它的面积比我们的候选更小也不替它放大。
 *
 * @param ref - 带原始宽高的图片引用
 * @param target - 路由选定的目标尺寸与字节预算
 * @param maxLongEdge - 长边上限
 * @returns 收紧后的目标；无需干预时返回原对象本身
 */
export function tightenTarget<T extends ImageRequestTarget>(
  ref: Dimensions,
  target: T,
  maxLongEdge: number,
): T {
  // 尺寸不可信时不做任何判断，原样透传给 DSH 去校验报错
  if (!Number.isFinite(ref.width) || !Number.isFinite(ref.height)) return target
  if (ref.width <= 0 || ref.height <= 0) return target

  const longEdge = Math.max(ref.width, ref.height)
  // 原图本来就达标：不干预（目标只会比原图更小）
  if (longEdge <= maxLongEdge) return target
  // 目标已经压到红线内（路由的面积预算比我们更严）：不替它放宽
  if (Math.max(target.width, target.height) <= maxLongEdge) return target

  const candidate = longEdgeDimensions(ref.width, ref.height, maxLongEdge)
  return { ...target, width: candidate.width, height: candidate.height }
}

/** `attachments` 服务里我们要包装的那一个方法的形状。 */
export interface ReadImageRequestHost {
  readImageRequest(
    ref: ImageAttachmentRef,
    target: ImageRequestTarget,
    signal?: AbortSignal,
  ): Promise<unknown>
}

/** 包装后向外汇报一次收紧动作，供插件层打日志。 */
export type TightenReporter = (info: {
  width: number
  height: number
  from: { width: number; height: number }
  to: { width: number; height: number }
}) => void

const installMethodPatch = createMethodPatcher('dsh-image-cap')

/**
 * 就地给 `attachments` 服务打上补丁，返回还原用的 disposer。
 *
 * ## 为什么是「就地改实例」而不是「换掉整个服务」
 *
 * cordis 的 `set()` 有一条硬约束（见 cordis 源码 reflect.ts）：
 *
 *     if (impl.fiber !== this.ctx.fiber)
 *       throw new Error(`cannot set property "${name}" in multiple fibers`)
 *
 * `attachments` 是**别的 fiber**（attachment-local）提供的，我们这个 fiber
 * 调 `set()` 必抛。换不掉整个服务值，就只能就地换掉实例上的那一个方法：
 * 把包装函数挂成**实例自有属性**，遮蔽原型链上的原实现；卸载时换回装之前
 * 的样子（见 installMethodPatch）。
 *
 * ## ⚠️ 这里踩过一个无限递归的坑
 *
 * 早先的写法是「先建代理、再在调用时去 `store.readImageRequest` 取原实现」。
 * 单测里过了，因为测试桩把方法挂在对象自己身上；一接到真实服务就爆栈：
 * 真实服务的方法在**原型**上，插件把包装函数装成自有属性之后，
 * 「调用时再去取」取到的就是**包装函数自己** → 自己调自己 → RangeError。
 *
 * 所以原实现在装之前就取好，交给包装函数（installMethodPatch 的 `wrap`）。
 * 闭包捕获的是那一刻的原方法引用，之后不管实例上被装了什么，都不会再影响它。
 *
 * @param store - 原始 attachments 服务（会被就地修改）
 * @param resolveMaxLongEdge - 现读长边上限。**必须是 thunk 不能是数字**：
 *   用户在设置里改完要立刻生效（0.1.7 的 volatile 单元格原地提交），
 *   存下来的数字会让改动等到重启才起作用。
 * @param report - 可选，每次实际收紧时回调一次
 * @returns 还原函数；方法不存在时返回 undefined（没装）
 */
export function patchAttachments(
  store: ReadImageRequestHost,
  resolveMaxLongEdge: () => number,
  report?: TightenReporter,
): (() => void) | undefined {
  return installMethodPatch<ReadImageRequestHost['readImageRequest']>(store, 'readImageRequest', original => function patched(
    this: ReadImageRequestHost,
    ref: ImageAttachmentRef,
    target: ImageRequestTarget,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let effective = target
    try {
      effective = tightenTarget(ref, target, resolveMaxLongEdge())

      if (effective !== target) {
        report?.({
          width: ref.width,
          height: ref.height,
          from: { width: target.width, height: target.height },
          to: { width: effective.width, height: effective.height },
        })
      }
    } catch {
      // 本插件自身出任何问题，都不该把发图这条路拖垮：
      // 退回原目标，维持「没装这个插件」的行为。
      effective = target
    }
    // 用 .call(this, ...)：原实现内部要访问 this.root / this.compression
    // 等实例状态，必须把 this 绑回真实服务实例。
    return original.call(this, ref, effective, signal)
  })
}

/** 一次请求图片投影的输入：张数上限、裁剪步长、占位符构造器。 */
export interface ImageCountPolicy {
  /** 一个请求最多保留多少张图。 */
  maxImages: number
  /** 超限时一次裁掉多少张的步长。 */
  countQuantum: number
  /** 每张被省略的图换成什么文字。 */
  placeholder: (ref: ImageAttachmentRef) => string
}

/**
 * 按张数上限投影一次请求历史。
 *
 * 0.1.7 的图片省略是**标记制**：`offloaded: true` 是一个持久事实，
 * 路由只负责把带标记的图换成占位文字（`projectOffloadedImages()`）。
 * 本插件扮演「做决定的那一方」：数保留中的图片出现次数，超限时给**最老的**
 * 若干张打上标记（浅拷贝，不改任何原消息——没超限时返回原数组本身），
 * 替换文字交给宿主自己的投影器。裁剪数量按步长向上取整，与宿主
 * `offloadedImagePrefixCount()` 在纯张数预算下的结果一致。
 *
 * 字节预算仍然归适配器（pi-ai 的 `maxRequestImageBytes`），两边叠加、
 * 互不冲突。
 *
 * @param messages - 完整请求历史，最老的在前
 * @param policy - 张数上限、步长与占位符
 * @returns 没超限时返回原数组（引用相等，调用方可零成本跳过）；否则返回投影后的新数组
 */
export function projectImageCount(
  messages: readonly RequestMessage[],
  policy: ImageCountPolicy,
): readonly RequestMessage[] {
  // 保留中的图片出现位置（最老在前）。offloaded 标记的不计：
  // 它们发出的本来就是占位文字，不占张数。
  const retained: { message: number; block: number }[] = []
  messages.forEach((message, messageIndex) => {
    message.content.forEach((block, blockIndex) => {
      if (block.type === 'image' && block.offloaded !== true) {
        retained.push({ message: messageIndex, block: blockIndex })
      }
    })
  })

  const excess = retained.length - policy.maxImages
  if (excess <= 0) return messages
  // 步长向上取整；裁的数量不能超过实际存在的张数
  const remove = Math.min(
    Math.ceil(excess / policy.countQuantum) * policy.countQuantum,
    retained.length,
  )

  // 给最老的 remove 张打标记：只浅拷贝被动到的消息与块。
  const marks = new Map<number, Set<number>>()
  for (const at of retained.slice(0, remove)) {
    const blocks = marks.get(at.message) ?? new Set<number>()
    blocks.add(at.block)
    marks.set(at.message, blocks)
  }
  const marked = messages.map((message, messageIndex) => {
    const blocks = marks.get(messageIndex)
    if (blocks === undefined) return message
    const content = message.content.map((block, blockIndex) =>
      blocks.has(blockIndex) && block.type === 'image'
        ? { ...block, offloaded: true as const }
        : block,
    )
    return { ...message, content }
  })
  return projectOffloadedImages(marked, policy.placeholder)
}

/**
 * 数一遍一段请求历史里的图片出现次数。
 *
 * 0.1.7 里工具结果是独立的 `role: "tool"` 消息，图片块只出现在消息的
 * 顶层 content 里（0.1.5 的 `tool-result` 嵌套块已不存在），所以只数顶层。
 *
 * **只用于日志**：真正的裁剪决策在 `projectImageCount()` 里，这里不参与判断。
 *
 * @param messages - 完整请求历史
 * @returns 图片块总数（含已标记 offloaded 的）
 */
export function countImages(messages: readonly RequestMessage[]): number {
  let total = 0
  for (const message of messages) {
    for (const block of message.content) if (block.type === 'image') total += 1
  }
  return total
}

/**
 * `llm` 服务里我们要包装的那一个方法的形状。
 *
 * 为什么是 `adapterStream`（DSH 标了 private 的内部方法）而不是公开的
 * `stream()`：agent-loop 正常那条路走的是 `preparedCall.stream(request)`，
 * 它**不经过** `stream()`，两条路唯一的共同收口就是 `adapterStream()`。
 * 而且它在 `llm/stream` 瀑布之下——DSH 自己的「文件转文字」「纯文本模型
 * 图片转文字」两次投影就在同一个位置，本插件的张数投影和它们并列。
 */
export interface AdapterStreamHost {
  adapterStream(options: GenerateOptions, prepared?: unknown): AsyncIterable<StreamChunk>
}

/**
 * 按 provider 现读一次张数策略。
 *
 * 必须是 thunk：provider 每次调用才知道，而且用户在设置里改完要立刻生效。
 */
export type CountPolicyResolver = (provider: string) => {
  maxImages: number
  countQuantum: number
}

/** 包装后向外汇报一次省略动作，供插件层打日志。 */
export type OffloadReporter = (info: {
  provider: string
  before: number
  after: number
}) => void

/**
 * 就地给 `llm` 服务打上补丁，返回还原用的 disposer。
 *
 * 手法与 `patchAttachments()` 完全一致，都走 installMethodPatch。
 *
 * 补丁自身出任何问题都只影响「这一次投影」：异常时退回原请求，
 * 维持「没装这个插件」的行为，绝不把模型调用这条路拖垮。
 *
 * @param llm - 原始 llm 服务（会被就地修改）
 * @param resolvePolicy - 现读某个 provider 的张数策略
 * @param placeholder - 被省略图片的占位文字构造器
 * @param report - 可选，每次实际省略时回调一次
 * @returns 还原函数；方法不存在时返回 undefined（没装，调用方负责告警）
 */
export function patchLlm(
  llm: AdapterStreamHost,
  resolvePolicy: CountPolicyResolver,
  placeholder: (ref: ImageAttachmentRef) => string,
  report?: OffloadReporter,
): (() => void) | undefined {
  return installMethodPatch<AdapterStreamHost['adapterStream']>(llm, 'adapterStream', original => function patched(
    this: AdapterStreamHost,
    options: GenerateOptions,
    prepared?: unknown,
  ): AsyncIterable<StreamChunk> {
    let projected: readonly RequestMessage[] = options.messages
    try {
      const { maxImages, countQuantum } = resolvePolicy(options.provider)
      projected = projectImageCount(options.messages, { maxImages, countQuantum, placeholder })
      if (projected !== options.messages) {
        report?.({
          provider: options.provider,
          before: countImages(options.messages),
          after: countImages(projected),
        })
      }
    } catch {
      projected = options.messages
    }
    if (projected === options.messages) return original.call(this, options, prepared)
    // 造新对象而不是改原对象：loop 造的请求是深冻结的，原地改会直接抛。
    const next = { ...options, messages: projected as RequestMessage[] }
    // 原请求冻结时把新对象也冻上，保持「loop 请求不可变」这个性质；
    // 本来就没冻的（手搓的一次性调用）也不替它冻，免得挡住别人的写入。
    return original.call(this, Object.isFrozen(options) ? Object.freeze(next) : next, prepared)
  })
}

/**
 * 本插件的运行时配置（volatile 单元格解析成普通值之后的形状）。
 *
 * 字段语义见下面的 schema。设置页改完由 loader 原地提交，不用重启。
 */
export interface ImageCapConfig {
  readonly maxLongEdge: number
  readonly maxImagesPerRequest: number
  readonly imageCountQuantum: number
  readonly providerMaxImages: Readonly<Record<string, number>>
}

/**
 * 某个 provider 生效的张数上限。
 *
 * `providerMaxImages` 里给了就用它（逐条线路放宽/收紧），否则用全局值。
 * 例如 claude 官方上限 100 张，就写 `providerMaxImages: { claude: 100 }`。
 *
 * @param config - 当前生效的插件配置
 * @param provider - 请求上的 provider 路由名
 * @returns 该线路一个请求最多保留的图片张数
 */
export function maxImagesFor(config: ImageCapConfig, provider: string): number {
  return config.providerMaxImages[provider] ?? config.maxImagesPerRequest
}

/*
 * 0.1.7 的设置模型：标了 `.volatile()` 的字段由宿主 SettingsForms 端给
 * 浏览器半（GUI 卡片是本插件 client 半自己注册的，见 src/client/index.tsx），
 * 值活在 profile patch 里；用户改完 loader 把新值原地写回
 * 运行中的单元格（不重启插件），所以读配置必须 `live()` 现读，不能存下来。
 * （installSection / setSource 那套 0.1.7 已删掉。）
 */
export const Config = z.object({
  /** Anthropic 在「一个请求 >20 张图」时对每张图施加的单边红线。 */
  maxLongEdge: z.natural().min(1).default(MANY_IMAGE_LONG_EDGE_LIMIT).volatile(),
  /** 一个请求最多发多少张图；超过就把最老的换成文字占位符。 */
  maxImagesPerRequest: z.natural().min(1).default(DEFAULT_MAX_IMAGES_PER_REQUEST).volatile(),
  /** 张数裁剪步长；越大越省缓存，越小越省图。 */
  imageCountQuantum: z.natural().min(1).default(DEFAULT_IMAGE_COUNT_QUANTUM).volatile(),
  /** 逐条线路覆盖张数上限：`{ claude: 100 }`；没写的线路用上面的全局值。 */
  providerMaxImages: z.dict(z.natural().min(1)).default({}).volatile(),
})

/** schema 输出形状：volatile 字段是单元格。 */
type ConfigCells = ReturnType<typeof Config>

export const name = 'dsh-image-cap'

export function apply(ctx: Context, config: ConfigCells): void {
  const logger = ctx.logger(name)

  // 当前生效的配置。三层叠加（右边盖左边）：
  //   schema 默认值 < cordis.patch.yml 的条目 config < profile patch（设置页写的就是这层）
  // volatile 字段的值是单元格：用户在设置页改完立刻生效（loader 原地写回），
  // 所以补丁里必须每次现读（见 patchAttachments 的 resolveMaxLongEdge），
  // 不能把 config.maxLongEdge 存成数字——存下来改完就得重启才生效。
  const current = (): ImageCapConfig => ({
    maxLongEdge: live(config.maxLongEdge),
    maxImagesPerRequest: live(config.maxImagesPerRequest),
    imageCountQuantum: live(config.imageCountQuantum),
    providerMaxImages: live(config.providerMaxImages),
  })

  /**
   * 被省略图片的占位文字。
   *
   * 直接用 DSH 自己的 `offloadedImageText()`，和 pi-ai 适配器按字节裁剪时写的
   * 是同一份文字：附件 id、规范化尺寸，外加一条**只读路径**——模型可以拿文件
   * 工具把图读回来，不至于因为省略就彻底看不见。
   *
   * 路径解析照抄运行时 `LlmRuntime.fileReadPath()` 与 pi-ai 的接线：附件服务
   * 给宿主路径，文件系统服务再把它映射进当前工具执行世界。两个服务缺一个、
   * 或者引用非法，就退回不带路径的占位符——只是少一条线索，不影响发请求。
   */
  const placeholderFor = (ref: ImageAttachmentRef): string =>
    offloadedImageText(ref, resolveImageAccess(ctx, ref))

  ctx.inject(['attachments'], (scoped: Context) => {
    const store = scoped.get('attachments') as ReadImageRequestHost | undefined
    if (store === undefined) return

    let tightened = 0
    const restore = patchAttachments(store, () => current().maxLongEdge, info => {
      tightened += 1
      logger.debug(
        `图片长边超限，收紧目标尺寸：${info.width}×${info.height}，`
        + `${info.from.width}×${info.from.height} → ${info.to.width}×${info.to.height}`,
      )
    })
    if (restore === undefined) return

    scoped.effect(() => () => {
      restore()
      if (tightened > 0) {
        logger.info(`image-cap 卸载，本次会话共收紧 ${tightened} 张图`)
      }
    })
    logger.info(`图片长边上限 ${current().maxLongEdge}px 已生效`)
  })

  ctx.inject(['llm'], (scoped: Context) => {
    const llm = scoped.get('llm') as AdapterStreamHost | undefined
    if (llm === undefined) return
    // 上游换了内部结构就别硬装：静默失效比装错地方更危险，这里明确告警。
    if (typeof llm.adapterStream !== 'function') {
      logger.warn('llm 服务上没有 adapterStream（DSH 内部结构可能变了），本次不装图片张数上限')
      return
    }

    let offloaded = 0
    const restore = patchLlm(
      llm,
      provider => ({
        maxImages: maxImagesFor(current(), provider),
        countQuantum: current().imageCountQuantum,
      }),
      placeholderFor,
      info => {
        offloaded += 1
        logger.debug(
          `请求图片张数超限（${info.provider}）：${info.before} → ${info.after} 张，`
          + '最老的若干张已换成文字占位符',
        )
      },
    )
    if (restore === undefined) return

    scoped.effect(() => () => {
      restore()
      if (offloaded > 0) {
        logger.info(`image-cap 卸载，本次会话共 ${offloaded} 次请求省略了超限图片`)
      }
    })
    logger.info(
      `请求图片张数上限 ${current().maxImagesPerRequest} 张已生效`
      + `（裁剪步长 ${current().imageCountQuantum}）`,
    )
  })
}

/**
 * 解析一张被省略图片在当前工具执行世界里的只读路径。
 *
 * 与运行时 `LlmRuntime.fileReadPath()` 的两步走法一致：附件服务给出宿主路径，
 * 文件系统服务把宿主路径映射进当前执行世界（沙箱/远程执行时两者不同）。
 * 任一服务缺失、或引用非法，都返回 undefined——占位符退化成不带路径的版本。
 *
 * @param ctx - 插件上下文，用来现取服务（服务可能还没挂上）
 * @param ref - 被省略的图片引用
 * @returns 只读执行世界路径；拿不到时 undefined
 */
function resolveImageAccess(
  ctx: Context,
  ref: ImageAttachmentRef,
): ImageAttachmentAccess | undefined {
  try {
    const attachments = ctx.get('attachments')
    const fs = ctx.get('fs')
    if (attachments === undefined || fs === undefined) return undefined
    return resolveImageAttachmentAccess(
      attachments,
      (hostPath: string) => fs.processPathFromHostPath(hostPath),
      ref,
    )
  } catch {
    return undefined
  }
}
