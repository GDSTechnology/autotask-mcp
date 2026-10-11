// Sync drift (requirements §8 step 7, acceptance test 9): an APPROVED, applied
// change that something later reverted or bypassed (the Pax8 PSA sync, a
// person, another integration). Every applied plan row is re-checked against
// Autotask; a difference is recorded once per (plan, row, field, value) and
// raised as a notification. Nothing is re-applied automatically — ownership of
// the field has to be decided first.

import type { Pool } from 'pg';
import type { Plan, PlanRow } from '../change-plans/store.js';

export interface DriftDeps {
  get(entity: string, id: number): Promise<Record<string, unknown> | null>;
  /** The unit period of a contract service covering a date: units + price per unit. */
  unitsOn(contractServiceId: number, date: string): Promise<{ units: number; unitPrice: number | null } | null>;
}
export interface DriftFinding { planId: string; row: number; label: string; entity: string; targetId: number | null; field: string; approved: unknown; current: unknown }

const same = (a: unknown, b: unknown) => {
  if (a == null || a === '') return b == null || b === '';
  if (typeof a === 'number' || typeof b === 'number') return Math.abs(Number(a) - Number(b)) < 1e-4;
  if (typeof a === 'string' && typeof b === 'string' && /^\d{4}-\d{2}-\d{2}/.test(a) && /^\d{4}-\d{2}-\d{2}/.test(b)) return a.slice(0, 10) === b.slice(0, 10);
  return String(a).trim() === String(b).trim();
};

export async function checkDrift(plans: Plan[], d: DriftDeps, today = new Date().toISOString().slice(0, 10)): Promise<{ checked: number; findings: DriftFinding[] }> {
  const findings: DriftFinding[] = [];
  let checked = 0;
  const add = (p: Plan, r: PlanRow, field: string, approved: unknown, current: unknown, targetId: number | null) => findings.push({ planId: p.id, row: r.rowNo, label: r.label, entity: r.entity, targetId, field, approved, current });
  for (const p of plans) {
    for (const r of p.rows.filter((x) => x.status === 'applied' || x.status === 'skipped')) {
      if (r.action === 'info' || !r.after) continue;
      checked++;
      const id = r.targetId ?? (typeof r.result?.id === 'number' ? (r.result.id as number) : typeof r.result?.existingId === 'number' ? (r.result.existingId as number) : null);
      if (r.entity === 'ContractServiceAdjustments') {
        // An adjustment is a one-off event; what must hold is its EFFECT from the effective date on.
        const a = r.after as { contractServiceID?: number; effectiveDate?: string; unitChange?: number; adjustedUnitPrice?: number };
        if (!a.contractServiceID || !a.effectiveDate || a.effectiveDate > today) continue;
        const u = await d.unitsOn(a.contractServiceID, today);
        if (!u) { add(p, r, 'units', 'a unit period', 'none (line ended or removed?)', a.contractServiceID); continue; }
        if (a.adjustedUnitPrice != null && u.unitPrice != null && !same(a.adjustedUnitPrice, u.unitPrice)) add(p, r, 'unitPrice', a.adjustedUnitPrice, u.unitPrice, a.contractServiceID);
        const beforeUnits = typeof r.before?.units === 'number' ? (r.before.units as number) : null;
        if (beforeUnits != null && a.unitChange && !same(beforeUnits + a.unitChange, u.units)) add(p, r, 'units', beforeUnits + a.unitChange, u.units, a.contractServiceID);
        continue;
      }
      if (id == null) continue;
      const cur = await d.get(r.entity, id);
      if (!cur) { add(p, r, '(record)', 'exists', 'missing', id); continue; }
      for (const [f, v] of Object.entries(r.after)) if (!same(v, cur[f])) add(p, r, f, v, cur[f] ?? null, id);
    }
  }
  return { checked, findings };
}

export class DriftStore {
  constructor(private readonly pool: Pool) {}
  /** Record findings; returns only the NEW ones (not already recorded with the same current value). */
  async record(fs: DriftFinding[]): Promise<DriftFinding[]> {
    const fresh: DriftFinding[] = [];
    for (const f of fs) {
      const r = await this.pool.query(`INSERT INTO sync_drift_event (plan_id, row_no, entity, target_id, field, approved_value, current_value) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
        [f.planId, f.row, f.entity, f.targetId, f.field, f.approved == null ? null : String(f.approved), f.current == null ? null : String(f.current)]);
      if (r.rowCount) fresh.push(f);
    }
    return fresh;
  }
  async open(limit = 200): Promise<Array<Record<string, unknown>>> {
    const r = await this.pool.query('SELECT * FROM sync_drift_event WHERE resolved_at IS NULL ORDER BY detected_at DESC LIMIT $1', [limit]);
    return r.rows;
  }
}
