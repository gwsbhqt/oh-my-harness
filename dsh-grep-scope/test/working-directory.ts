import type { Agent } from '@deepseek-ai/dsh-agent'

/** Stand-in for DSH 0.2.1's workingDirectory service: an override map, else the session's starting directory. */
export function fakeWorkingDirectory(moved = new Map<string, string>()) {
  const get = (session: Agent['session']) => moved.get(session.id) ?? session.header.cwd ?? process.cwd()
  return { get, ensure: async (agent: Agent) => get(agent.session) }
}
