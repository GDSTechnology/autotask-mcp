// Sync drift (requirements §8 step 7, acceptance test 9): an APPROVED, applied
// change that something later reverted or bypassed (the Pax8 PSA sync, a
// person, another integration). Every applied plan row is re-checked against
// Autotask; a difference is recorded once per (plan, row, field, value) and
// raised as a notification. Nothing is re-applied automatically — ownership of
// the field has to be decided first.

import type { Pool } from 'pg';
import type { Plan, PlanRow } from '../change-plans/store.js';
import { ADJUSTMENTS, type LineKind } from './contract-io.js';

export interface DriftDeps {
  get(entity: string, id: number): Promise<Record<string, unknown> | null>;
  /** The unit period of a contract service / bundle line covering a date: units + price per unit. */
  unitsOn(lineId: number, date: string, kind?: LineKind): Promise<{ units: number; unitPrice: number | null } | null>;
}
export interface DriftFinding { planId: string; row: number; label: string; entity: string; targetId: number | null; field: string; approved: unknown; current: unknown }

const same = (a: unknown, b: unknown) => {
  if (a == null || a === '') return b == null || b === '';
  if (typeof a === 'number' || typeof b === 'number') return Math.abs(Number(a) - Number(b)) < 1e-3;
  if (typeof a === 'string' && typeof b === 'string' && /^\d{4}-\d{2}-\d{2}/.test(a) && /^\d{4}-\d{2}-\d{2}/.test(b)) return a.slice(0, 10) === b.slice(0, 10);
  return String(a).trim() === String(b).trim();
};
const num = (v: unknown) => (typeof v === 'number' ? v : null);

/** The keys a row writes: an adjustment owns its line's units / price; an update owns each field it set. */
function writes(r: PlanRow): string[] {
  const spec = ADJUSTMENTS[r.entity];
  if (spec) { const lineId = num(r.after?.[spec.lineField]) ?? num(r.result?.lineId) ?? num(r.result?.existingId); return lineId == null ? [] : [`adj:${spec.kind}:${lineId}`]; }
  const id = r.targetId ?? num(r.result?.id) ?? num(r.result?.existingId);
  return id == null ? [] : Object.keys(r.after ?? {}).map((f) => `${r.entity}:${id}:${f}`);
}

export async function checkDrift(plans: Plan[], d: DriftDeps, today = new Date().toISOString().slice(0, 10)): Promise<{ checked: number; findings: DriftFinding[] }> {
  const findings: DriftFinding[] = [];
  let checked = 0;
  const add = (p: Plan, r: PlanRow, field: string, approved: unknown, current: unknown, targetId: number | null) => findings.push({ planId: p.id, row: r.rowNo, label: r.label, entity: r.entity, targetId, field, approved, current });
  // Only the LATEST approved write to a field / line is expected to hold: a later
  // plan (or a revert plan) re-pricing the same line supersedes the earlier one.
  const ordered = [...plans].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const latest = new Map<string, string>();
  for (const p of ordered) for (const r of p.rows) if (r.status === 'applied' || r.status === 'skipped') for (const k of writes(r)) latest.set(k, `${p.id}:${r.rowNo}`);
  const isLatest = (p: Plan, r: PlanRow, key: string) => latest.get(key) === `${p.id}:${r.rowNo}`;
  for (const p of ordered) {
    for (const r of p.rows.filter((x) => x.status === 'applied' || x.status === 'skipped')) {
      if (r.action === 'info' || !r.after) continue;
      const spec = ADJUSTMENTS[r.entity];
      if (spec) {
        // An adjustment is a one-off event; what must hold is its EFFECT from the effective date on.
        const a = r.after as Record<string, unknown>;
        const lineId = num(a[spec.lineField]) ?? num(r.result?.lineId) ?? num(r.result?.existingId);
        if (lineId == null || !a.effectiveDate || String(a.effectiveDate).slice(0, 10) > today || r.status !== 'applied') continue;
        if (!isLatest(p, r, `adj:${spec.kind}:${lineId}`)) continue;
        checked++;
        const u = await d.unitsOn(lineId, today, spec.kind);
        // A revert row states the state it restores; otherwise it is the state before plus the change.
        const fixed = r.meta?.expect as { units?: number; unitPrice?: number | null } | undefined;
        const beforeUnits = num(r.before?.units);
        const wantUnits = typeof fixed?.units === 'number' ? fixed.units : beforeUnits != null ? beforeUnits + Number(a.unitChange ?? 0) : null;
        const wantPrice = fixed ? fixed.unitPrice ?? null : a.adjustedUnitPrice ?? null;
        if (!u) { if (wantUnits) add(p, r, 'units', wantUnits, 'none (line ended or removed?)', lineId); continue; }
        if (wantUnits != null && !same(wantUnits, u.units)) add(p, r, 'units', wantUnits, u.units, lineId);
        if (wantPrice != null && u.units > 0 && u.unitPrice != null && !same(wantPrice, u.unitPrice)) add(p, r, 'unitPrice', wantPrice, u.unitPrice, lineId);
        continue;
      }
      const id = r.targetId ?? num(r.result?.id) ?? num(r.result?.existingId);
      if (id == null) continue;
      const fields = Object.entries(r.after).filter(([f]) => isLatest(p, r, `${r.entity}:${id}:${f}`));
      if (!fields.length) continue;
      checked++;
      const cur = await d.get(r.entity, id);
      if (!cur) { add(p, r, '(record)', 'exists', 'missing', id); continue; }
      for (const [f, v] of fields) if (!same(v, cur[f])) add(p, r, f, v, cur[f] ?? null, id);
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
