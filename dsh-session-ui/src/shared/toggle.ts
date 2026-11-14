/**
 * 四个子开关的挂载/卸载器：每块能力挂在一个独立的子 fiber 上，关掉就把那个子 fiber 整个卸掉，
 * 它注册的槽位、事件监听、路由、计时器随着 fiber 一起撤销，不留残渣；再开就重新挂一个干净的。
 *
 * 宿主半和浏览器半共用这份逻辑：宿主靠 loader 的 volatile 更新事件调 {@link Toggler.sync}，
 * 浏览器半靠 ConfigForm 的订阅调同一个方法。判断“该开还是该关”由调用方给，这里只管生命周期。
 *
 * @module dsh-session-ui/shared/toggle
 */
import type { Context } from '@deepseek-ai/cordis'

/** 一块能力的挂载函数：在自己的子 fiber 上注册，父 fiber 卸载时无需自己清理。 */
export type FeatureApply = (ctx: Context) => void

export interface Toggler {
  /** 按期望状态对齐：该开的没开就挂上，该关的还开着就卸掉；已经对上的不动。 */
  sync(desired: Record<string, boolean>): void
  /** 整体卸载：把所有还挂着的子 fiber 卸掉。 */
  dispose(): void
  /** 当前挂着的块（按键名排序），用于观测和测试。 */
  active(): string[]
}

/**
 * 建一个挂载器。`ctx` 是宿主半或浏览器半的上下文；每块能力用 `features` 里的函数挂到新的子 fiber 上。
 */
export function createToggler(ctx: Context, features: Record<string, FeatureApply>): Toggler {
  const running = new Map<string, () => Promise<void>>()

  const start = (key: string): void => {
    const apply = features[key]
    if (apply === undefined) throw new Error(`session-ui 没有名为 ${key} 的能力`)
    // 每次挂载用一个新函数包一层，避免两个同名能力的 fiber 共用同一个 registry 记录。
    // 一块挂载失败只记一笔，不影响别的块，也不把异常抛给 loader 的配置更新流程。
    try {
      const fiber = ctx.plugin((child: Context) => { apply(child) })
      running.set(key, fiber.dispose)
    } catch (error) {
      ctx.logger('session-ui').warn(`${key} 加载失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const stop = (key: string): void => {
    const dispose = running.get(key)
    if (dispose === undefined) return
    running.delete(key)
    void dispose()
  }

  return {
    sync(desired: Record<string, boolean>): void {
      for (const [key, on] of Object.entries(desired)) {
        const isRunning = running.has(key)
        if (on && !isRunning) start(key)
        else if (!on && isRunning) stop(key)
      }
    },
    dispose(): void {
      for (const key of [...running.keys()]) stop(key)
    },
    active(): string[] {
      return [...running.keys()].sort()
    },
  }
}
