// Safe-orchestration contract for complex writes (MCP-CORE-004 / MCP-CORE-005).
//
// Every orchestrating write — one that validates several entities, then performs
// more than one mutation — returns the SAME envelope, so a caller (n8n, ChatGPT,
// Hermes) branches on `status` once instead of learning a per-tool shape:
//
//   { status, validation, ...outcome-specific fields }
//
//   validation_failed — a precondition failed; `step` and `detail` say which.
//                       NOTHING was written.
//   duplicate         — an idempotency probe found the work already done.
//                       NOTHING was written.
//   dry_run           — validation passed; the planned mutations are returned
//                       and NOTHING was written.
//   <success>         — the mutations were applied. The label is the tool's own
//                       ('created', 'linked', …) because callers already branch
//                       on it and the useful word differs by operation.
//
// `validation` is the ordered audit trail of every precondition checked,
// including the ones that passed — that is what makes a dry run reviewable
// rather than just a "looks fine".
//
// This shape was first written inline in `createMaintenanceTicket`; it is
// extracted here so new orchestrators inherit it instead of inventing a
// near-miss variant. The invariant worth protecting: a `dry_run`,
// `validation_failed` or `duplicate` result means no write was attempted.

/** One precondition that was checked, and what it found. */
export interface ValidationStep {
  step: string;
  ok: boolean;
  detail?: unknown;
}

/** The common envelope. Outcome-specific fields ride alongside these. */
export interface WritePlanResult extends Record<string, unknown> {
  status: string;
  validation: ValidationStep[];
}

/**
 * Accumulates validation steps and builds the terminal result.
 *
 * Usage mirrors how the checks actually read:
 *
 *   const plan = new WritePlan();
 *   const company = await this.getCompany(id);
 *   if (!company) return plan.fail('company', `Company ${id} not found`);
 *   plan.ok('company');
 *   ...
 *   if (dryRun) return plan.dryRun({ plannedProject: payload });
 *   return plan.done('linked', { id, item });
 */
export class WritePlan {
  private readonly steps: ValidationStep[] = [];

  /** Record a precondition that passed. */
  ok(step: string, detail?: unknown): this {
    this.steps.push(detail === undefined ? { step, ok: true } : { step, ok: true, detail });
    return this;
  }

  /**
   * Record a precondition that failed and build the terminal result. Returning
   * this from the orchestrator is what guarantees nothing downstream is written.
   */
  fail(step: string, detail: unknown): WritePlanResult {
    this.steps.push({ step, ok: false, detail });
    return { status: 'validation_failed', step, detail, validation: this.steps };
  }

  /**
   * Stop before writing because the work already exists (idempotency probe hit).
   * `extras` should carry the evidence — the records that were found.
   */
  duplicate(extras: Record<string, unknown> = {}): WritePlanResult {
    return { status: 'duplicate', ...extras, validation: this.steps };
  }

  /**
   * Validation passed and the caller asked for `dryRun`. `extras` carries the
   * planned mutations, named so a reviewer can see what WOULD happen
   * (`plannedTicket`, `wouldLinkConfigurationItems`, …).
   */
  dryRun(extras: Record<string, unknown> = {}): WritePlanResult {
    return { status: 'dry_run', ...extras, validation: this.steps };
  }

  /**
   * The mutations were applied. `status` is the tool's own success label
   * ('created', 'linked', …) so existing callers keep the word they branch on.
   */
  done(status: string, extras: Record<string, unknown> = {}): WritePlanResult {
    return { status, ...extras, validation: this.steps };
  }

  /** The steps recorded so far, for an orchestrator that builds its own result. */
  get validation(): ValidationStep[] {
    return this.steps;
  }
}

/**
 * Statuses that mean "nothing was written". Callers (and tests) can assert on
 * this rather than enumerating the non-success labels themselves.
 */
export const NO_WRITE_STATUSES = new Set(['validation_failed', 'duplicate', 'dry_run']);

/** True when the result reports that no mutation was attempted. */
export function isNoWrite(result: { status: string }): boolean {
  return NO_WRITE_STATUSES.has(result.status);
}
