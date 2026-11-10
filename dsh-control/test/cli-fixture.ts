import { createCli, spawnDetachedCli, type AppControl } from '../src/cli/core.ts'

/** 测试不许碰本机真的 DSH：退出、打开、强杀一律报错。测试自己要模拟 App 时另传。 */
export const forbiddenApp: AppControl = {
  running: () => false,
  backendRunning: () => false,
  quit: () => { throw new Error('测试里不许退出真实的 DSH') },
  open: () => { throw new Error('测试里不许打开真实的 DSH') },
  kill: () => { throw new Error('测试里不许强杀真实的 DSH') },
  confirmScheduledQuit: () => { throw new Error('测试里不许点真实 DSH 的退出框') },
  screenLocked: () => { throw new Error('测试里不许查真实屏幕') },
}

/** 只调用可导入核心；环境和输出隔离，不启动 dsh-control 进程。 */
export async function invokeCli(args: string[], env: NodeJS.ProcessEnv) {
  let out = '', err = ''
  const code = await createCli(env, (text) => { out += text }, (text) => { err += text }, spawnDetachedCli, forbiddenApp)(args)
  return { code, out, err }
}
