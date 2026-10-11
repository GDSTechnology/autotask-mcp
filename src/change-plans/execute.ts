// Execute the APPROVED rows of a change plan: re-read each target first (a row
// whose target changed since the plan was built is STALE — skipped, never
// written over), write only that row's fields, read back and verify. Failures
// are recorded per row and never stop other rows — except an Autotask 401 /
// 429, which stop the run (nothing is retried here). Re-running is safe:
// applied rows are not run again, and a create checks the record isn't
// already there.

import type { PlanStore, Plan, PlanRow } from './store.js';

export interface EntityIO {
  get(entity: string, id: number): Promise<Record<string, unknown> | null>;
  update(entity: string, id: number, fields: Record<string, unknown>): Promise<void>;
  create(entity: string, fields: Record<string, unknown>): Promise<number>;
  /** For creates: an existing record that already IS this row (e.g. same Service name) — makes a re-run safe. */
  findExisting(entity: string, fields: Record<string, unknown>): Promise<number | null>;
  /**
   * For a create that depends on another record's state (e.g. a contract price
   * adjustment depends on the contract service's current price / units): the
   * current values of the row's `before` fields, so a changed target is STALE.
   */
  snapshot?(row: PlanRow): Promise<Record<string, unknown> | null>;
}

export interface ExecuteReport {
  planId: string; attempted: number; applied: number; failed: number; stale: number; skipped: number;
  stoppedBy?: string; rows: Array<{ row: number; label: string; status: string; detail?: string; id?: number | null }>;
}

const DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/;
const same = (a: unknown, b: unknown): boolean => {
  const na = a === '' || a === undefined ? null : a, nb = b === '' || b === undefined ? null : b;
  if (na === null || nb === null) return na === nb;
  // "2026-11-01" and "2026-11-01T00:00:00Z" are the same date
  if (typeof na === 'string' && typeof nb === 'string' && DATE.test(na) && DATE.test(nb)) return na.slice(0, 10) === nb.slice(0, 10);
  if (typeof na === 'number' || typeof nb === 'number') return Math.abs(Number(na) - Number(nb)) < 1e-6;
  if (typeof na === 'boolean' || typeof nb === 'boolean') return String(na) === String(nb);
  return String(na).trim() === String(nb).trim();
};
export const fieldsDiffer = (cur: Record<string, unknown>, want: Record<string, unknown>) => Object.keys(want).filter((k) => !same(cur[k], want[k]));

export async function executePlan(plans: PlanStore, plan: Plan, io: EntityIO, o: { maxRows?: number; onApplied?: (row: PlanRow, id: number | null) => Promise<void> } = {}): Promise<ExecuteReport> {
  const rep: ExecuteReport = { planId: plan.id, attempted: 0, applied: 0, failed: 0, stale: 0, skipped: 0, rows: [] };
  const todo = plan.rows.filter((r) => r.status === 'approved').slice(0, Math.min(Math.max(o.maxRows ?? 25, 1), 100));
  await plans.setStatus(plan.id, 'executing');
  for (const r of todo) {
    rep.attempted++;
    const done = async (status: 'applied' | 'failed' | 'stale' | 'skipped', result: Record<string, unknown>, detail?: string, id: number | null = r.targetId) => {
      await plans.setRowResult(plan.id, r.rowNo, status, result);
      rep[status === 'applied' ? 'applied' : status]++;
      rep.rows.push({ row: r.rowNo, label: r.label, status, ...(detail ? { detail } : {}), id });
    };
    try {
      if (r.action === 'create') {
        if (r.before && io.snapshot) {
          const cur = await io.snapshot(r);
          const moved = cur ? Object.keys(r.before).filter((k) => !same(cur[k], r.before![k])) : ['(target not found)'];
          if (moved.length) { await done('stale', { changedSincePlan: moved, current: cur }, `changed since the plan was built (${moved.join(', ')}) — rebuild the plan`); continue; }
        }
        const existing = await io.findExisting(r.entity, r.after ?? {});
        if (existing != null) { await done('skipped', { existingId: existing }, `already exists as ${existing}`, existing); if (o.onApplied) await o.onApplied(r, existing); continue; }
        const id = await io.create(r.entity, r.after ?? {});
        const back = await io.get(r.entity, id);
        const off = back ? fieldsDiffer(back, r.after ?? {}) : ['(not readable)'];
        if (off.length) { await done('failed', { id, notApplied: off, readBack: back }, `created ${id} but ${off.join(', ')} did not read back`, id); continue; }
        await done('applied', { id, readBack: pick(back!, Object.keys(r.after ?? {})) }, undefined, id);
        if (o.onApplied) await o.onApplied(r, id);
        continue;
      }
      if (r.targetId == null) { await done('failed', { error: 'no target id' }, 'no target id'); continue; }
      const cur = await io.get(r.entity, r.targetId);
      if (!cur) { await done('failed', { error: 'target not found' }, 'target no longer exists'); continue; }
      // Stale: what the plan saw is no longer what Autotask has.
      const moved = Object.keys(r.before ?? {}).filter((k) => !same(cur[k], r.before![k]));
      if (moved.length) {
        // …unless it already has the planned values (e.g. someone made the same change): nothing to do.
        if (!fieldsDiffer(cur, r.after ?? {}).length) { await done('skipped', { current: pick(cur, Object.keys(r.after ?? {})) }, 'already as planned'); if (o.onApplied) await o.onApplied(r, r.targetId); continue; }
        await done('stale', { changedSincePlan: moved, current: pick(cur, moved) }, `changed since the plan was built (${moved.join(', ')}) — rebuild the plan`);
        continue;
      }
      await io.update(r.entity, r.targetId, r.after ?? {});
      const back = await io.get(r.entity, r.targetId);
      const off = back ? fieldsDiffer(back, r.after ?? {}) : ['(not readable)'];
      if (off.length) { await done('failed', { notApplied: off, readBack: back ? pick(back, off) : null }, `${off.join(', ')} did not read back as planned`); continue; }
      await done('applied', { readBack: pick(back!, Object.keys(r.after ?? {})) });
      if (o.onApplied) await o.onApplied(r, r.targetId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await done('failed', { error: msg.slice(0, 500) }, msg.slice(0, 200));
      if (/\b401\b|login|rate limit|\b429\b|threshold/i.test(msg)) { rep.stoppedBy = msg.slice(0, 200); break; }
    }
  }
  const after = await plans.get(plan.id);
  const left = after?.rows.some((x) => x.status === 'approved' || x.status === 'pending') ?? false;
  await plans.setStatus(plan.id, left ? 'open' : 'done');
  return rep;
}

function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));
}
