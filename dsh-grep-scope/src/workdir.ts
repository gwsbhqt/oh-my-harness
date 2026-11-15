import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** DSH 0.2.1 的会话工作目录服务：会话可以 cd，header.cwd 只是起始目录。 */
export interface WorkingDirectoryLike {
  get(session: Agent['session']): string
  ensure(agent: Agent, signal?: AbortSignal): Promise<string>
}

export function workingDirectory(ctx: Context): WorkingDirectoryLike {
  return (ctx as unknown as { workingDirectory: WorkingDirectoryLike }).workingDirectory
}
