/**
 * Per-cell run leases: the authority model.
 *
 * One `run_code` call == one lease. A lease owns the exact binding functions
 * PTC handed us for that call, and nothing else may use them. The invariants
 * (AGENTS.md, technical design §6.3):
 *
 * - A tool call is resolved against the lease of the cell that ISSUED it, not
 *   "the current cell". A leftover asyncio task from cell 1 carries cell 1's
 *   runId and must fail once cell 1 settled — it must never ride cell 2's
 *   bindings.
 * - Revocation happens SYNCHRONOUSLY before the outer run promise resolves, so
 *   a late frame sitting in the same read buffer cannot be accepted by the
 *   next cell.
 * - A reply from a previous kernel generation (epoch) is never honoured.
 *
 * @module
 */

/** Why a lookup was refused. Callers map these to Python-visible failures. */
export type LeaseDenial =
  | { reason: 'unknown-run'; runId: string }
  | { reason: 'stale-epoch'; runId: string; expected: number; got: number }
  | { reason: 'unknown-tool'; runId: string; tool: string }

/** One tool callable exactly as PTC bound it. */
export type BoundTool = (args: unknown) => Promise<unknown>

/** An active cell's authority. */
interface Lease {
  runId: string
  epoch: number
  tools: Map<string, BoundTool>
}

/** Result of resolving a tool call against the registry. */
export type LeaseLookup =
  | { ok: true; call: BoundTool }
  | { ok: false; denial: LeaseDenial }

/**
 * The lease table. One per kernel; the kernel's epoch is supplied per grant so
 * a restart cannot be papered over.
 */
export class LeaseRegistry {
  readonly #leases = new Map<string, Lease>()

  /**
   * Open a lease for one cell.
   * @param runId - unique per `run_code` invocation.
   * @param epoch - the kernel generation this cell runs on.
   * @param tools - the exact bound functions PTC supplied for this call.
   * @throws if the runId is already in use — ids must be unique per run.
   */
  grant(runId: string, epoch: number, tools: Map<string, BoundTool>): void {
    if (this.#leases.has(runId)) {
      throw new Error(`dsh-python-repl: duplicate run id ${JSON.stringify(runId)}`)
    }
    this.#leases.set(runId, { runId, epoch, tools })
  }

  /**
   * Resolve a tool call. Every failure mode is explicit; there is deliberately
   * no fallback to "the current run" — that fallback IS the vulnerability.
   */
  resolve(runId: string, epoch: number, tool: string): LeaseLookup {
    const lease = this.#leases.get(runId)
    if (lease === undefined) return { ok: false, denial: { reason: 'unknown-run', runId } }
    if (lease.epoch !== epoch) {
      return { ok: false, denial: { reason: 'stale-epoch', runId, expected: lease.epoch, got: epoch } }
    }
    const call = lease.tools.get(tool)
    if (call === undefined) return { ok: false, denial: { reason: 'unknown-tool', runId, tool } }
    return { ok: true, call }
  }

  /** Whether this run still holds its lease (its cell is running). */
  isActive(runId: string): boolean {
    return this.#leases.has(runId)
  }

  /**
   * Close a lease. MUST be called synchronously on cell settlement — before
   * the outer promise resolves — so a late in-buffer frame finds it gone.
   * Idempotent: settling an already-revoked run is not an error.
   */
  revoke(runId: string): void {
    this.#leases.delete(runId)
  }

  /** Revoke everything — kernel death or disposal. */
  revokeAll(): void {
    this.#leases.clear()
  }
}

/** Human-readable denial text, surfaced to the program as an error message. */
export function describeDenial(denial: LeaseDenial): string {
  switch (denial.reason) {
    case 'unknown-run':
      return `run ${denial.runId} is not active: its cell already settled, so its tool authority is gone (a leftover background task cannot borrow the current cell's bindings)`
    case 'stale-epoch':
      return `run ${denial.runId} belongs to kernel generation ${denial.expected}, but the call arrived tagged ${denial.got}: the kernel restarted and prior authority does not carry over`
    case 'unknown-tool':
      return `tool ${JSON.stringify(denial.tool)} is not available to run ${denial.runId}`
  }
}
