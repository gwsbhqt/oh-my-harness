import type { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'

/** 0.2.2-rc.1 起 AgentRegistry 依赖 sessionProjections，真实宿主两者都有；测试里按同样顺序挂上。 */
export async function mountAgents(ctx: Context): Promise<void> {
  if ((ctx as unknown as { get(name: string): unknown }).get('sessionProjections') === undefined) await ctx.plugin(SessionProjectionRegistry as never, {} as never)
  await ctx.plugin(AgentRegistry)
}
