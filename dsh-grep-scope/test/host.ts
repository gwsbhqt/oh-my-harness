/** 0.2.2-rc.1 起的宿主测试搭法：AgentRegistry 依赖会话投影，工具执行改由执行器插件按批处理。 */
import type { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { ToolRuntime, type ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'

export async function mountAgents(ctx: Context): Promise<void> {
  if ((ctx as unknown as { get(name: string): unknown }).get('sessionProjections') === undefined) await ctx.plugin(SessionProjectionRegistry as never, {} as never)
  await ctx.plugin(AgentRegistry)
}

export async function mountNativeTools(ctx: Context): Promise<void> {
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeExecutor)
}

interface Call { callId: string; name: string; arguments: Record<string, unknown>; agent?: unknown; signal: AbortSignal }
interface Batch { execute(input: unknown): Promise<{ results: readonly { result: ToolExecutionResult }[] }> }

/** 单次调用包成一批：模型原样的调用块进去，取回这一条的结果。 */
export async function executeOne(registry: unknown, call: Call): Promise<ToolExecutionResult> {
  const batch = await (registry as Batch).execute({
    calls: [{ type: 'tool-call', id: call.callId, name: call.name, arguments: JSON.stringify(call.arguments) }],
    signal: call.signal,
    ...(call.agent === undefined ? {} : { agent: call.agent }),
  })
  return batch.results[0]!.result
}
