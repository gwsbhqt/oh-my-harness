/**
 * Whether a session is a delegated subagent, and what that changes about waiting.
 *
 * A root session that ends its turn stays alive, and DSH wakes it when one of
 * its jobs ends. A subagent does not: once its turn ends with an empty inbox
 * DSH releases it (dsh-subagent watchLocalSettlement), every job it owns is
 * cancelled as teardown (dsh-jobs-local cancelForTeardown), and teardown
 * cancellations send no notice (dsh-tool-jobs deliverSettlement). Until DSH
 * keeps a subagent alive while it owns running jobs, a subagent has to wait
 * inside its cells.
 *
 * @module
 */

/**
 * Longest single wait for a subagent's cell, in ms: DSH's own job_output cap
 * (tool-jobs maxWaitTimeoutMs, 10 minutes by default). Still a cap, not
 * forever: the cell stays cancellable (stop button, run_code timeoutMs) and a
 * wait that returns lets the model see progress and decide.
 */
export const SUBAGENT_WAIT_MS = 600_000

/** True for a session DSH created as a subagent: the header carries `origin: 'subagent'` and a delegation depth. */
export function isSubagentHeader(header: unknown): boolean {
  if (header === null || typeof header !== 'object') return false
  const { origin, delegationDepth } = header as { origin?: unknown; delegationDepth?: unknown }
  return origin === 'subagent' || (typeof delegationDepth === 'number' && delegationDepth > 0)
}

/** The same test for a live agent (`agent.session.header`). */
export function isSubagentAgent(agent: unknown): boolean {
  if (agent === null || typeof agent !== 'object') return false
  const session = (agent as { session?: unknown }).session
  return session !== null && typeof session === 'object' && isSubagentHeader((session as { header?: unknown }).header)
}

/** The wait cap a cell gets: cellWaitMs in a root session, at least `subagentMs` in a subagent; 0 stays "no cap". */
export function waitCapFor(cellWaitMs: number, subagent: boolean, subagentMs: number = SUBAGENT_WAIT_MS): number {
  if (!subagent || !(cellWaitMs > 0)) return cellWaitMs
  return Math.max(cellWaitMs, subagentMs)
}
