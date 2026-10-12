// Undo an executed plan (requirements §9 "rollback plan"): a NEW plan of kind
// "revert" whose rows put back what the original rows changed — built from the
// before-images the original plan kept, reviewed and approved like any plan.
//
//   update / deactivate      → update the same fields back (stale if changed since)
//   created Service          → deactivate it (Autotask can't delete services)
//   contract adjustment      → a counter-adjustment that restores the line's
//                              units and price from the revert date on; months
//                              already invoiced stay invoiced (credits are a
//                              separate decision)
// Only APPLIED rows are reverted ("already as planned" rows wrote nothing).
// Order is reversed, and dependencies flip: a move's "end the old line" is
// undone (old line back) before its "add the new line" is undone.

import type { Plan, PlanRowInput } from './store.js';
import { dependsOn } from './execute.js';

const ADJ: Record<string, string> = { ContractServiceAdjustments: 'contractServiceID', ContractServiceBundleAdjustments: 'contractServiceBundleID' };
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

export function buildRevertRows(plan: Plan, o: { effectiveDate: string; rowNos?: number[] }): { rows: PlanRowInput[]; skipped: Array<{ row: number; why: string }> } {
  const rows: PlanRowInput[] = [];
  const skipped: Array<{ row: number; why: string }> = [];
  const newNo = new Map<number, number>();
  const src = plan.rows.filter((r) => !o.rowNos?.length || o.rowNos.includes(r.rowNo)).slice().reverse();
  for (const r of src) {
    if (r.status !== 'applied') { if (r.action !== 'info') skipped.push({ row: r.rowNo, why: r.status === 'skipped' ? 'already as planned — nothing was written' : `not applied (${r.status})` }); continue; }
    const meta = { revertsPlan: plan.id, revertsRow: r.rowNo };
    const lineField = ADJ[r.entity];
    if (lineField) {
      const a = r.after ?? {};
      const lineId = num(a[lineField]) ?? num(r.result?.lineId);
      if (lineId == null) { skipped.push({ row: r.rowNo, why: 'the contract line it created is not known (re-run autotask_reconcile_check_sync_drift, then revert by hand)' }); continue; }
      const origDate = String(a.effectiveDate ?? '').slice(0, 10);
      const date = origDate && origDate > o.effectiveDate ? origDate : o.effectiveDate;
      const origUnits = num(r.before?.units) ?? 0;
      const origPrice = num(r.before?.unitPrice);
      const change = num(a.unitChange) ?? 0;
      const changedPrice = num(a.adjustedUnitPrice);
      // The day before the revert date: still the original state if the change hasn't taken effect yet.
      const before = date > origDate
        ? { units: origUnits + change, ...(changedPrice != null && origUnits + change > 0 ? { unitPrice: changedPrice } : {}) }
        : { units: origUnits, ...(origPrice != null && origUnits > 0 ? { unitPrice: origPrice } : {}) };
      newNo.set(r.rowNo, rows.length + 1);
      rows.push({
        meta: { ...meta, expect: { units: origUnits, unitPrice: origPrice } }, action: 'create', entity: r.entity, targetId: null,
        label: `REVERT row ${r.rowNo}: ${r.label.replace(/^(MOVE \d\/2|PRICE|QUANTITY|ADD|END|EXTRA SEATS)\s*/, '')} → back to ${origUnits} unit(s)${origPrice != null ? ` at ${origPrice}` : ''} from ${date}`,
        before,
        after: { contractID: a.contractID, [lineField]: lineId, ...(a.serviceID != null && lineField === 'contractServiceID' ? { serviceID: a.serviceID } : {}), ...(a.serviceBundleID != null ? { serviceBundleID: a.serviceBundleID } : {}), effectiveDate: date, unitChange: -change, ...(origPrice != null && origUnits > 0 && changedPrice != null ? { adjustedUnitPrice: origPrice } : {}) },
        reason: `Undoes plan ${plan.id} row ${r.rowNo} from ${date}. ${date > origDate ? 'Periods already billed at the new values stay billed — credit them separately if needed.' : 'It had not taken effect yet.'}`,
        blocked: null,
      });
      continue;
    }
    if (r.action === 'create' && r.entity === 'Services') {
      const id = num(r.result?.id);
      if (id == null) { skipped.push({ row: r.rowNo, why: 'created service id not recorded' }); continue; }
      newNo.set(r.rowNo, rows.length + 1);
      rows.push({ meta, action: 'deactivate', entity: 'Services', targetId: id, label: `REVERT row ${r.rowNo}: deactivate service #${id} created by the plan (Autotask can't delete services)`, before: { isActive: true }, after: { isActive: false }, reason: `Undoes plan ${plan.id} row ${r.rowNo}. Contract lines using it must be moved first.`, blocked: null });
      continue;
    }
    if ((r.action === 'update' || r.action === 'deactivate') && r.targetId != null && r.before && r.after) {
      const back = Object.fromEntries(Object.keys(r.after).map((k) => [k, r.before![k] ?? null]));
      newNo.set(r.rowNo, rows.length + 1);
      rows.push({ meta, action: 'update', entity: r.entity, targetId: r.targetId, label: `REVERT row ${r.rowNo}: ${r.label}`, before: r.after, after: back, reason: `Puts back the values plan ${plan.id} row ${r.rowNo} replaced. Stale (skipped) if they were changed again since.`, blocked: null });
      continue;
    }
    if (r.action === 'create' && r.entity === 'ContractCharges') { skipped.push({ row: r.rowNo, why: `a one-time charge (#${String(r.result?.id ?? '?')}) — delete it in Autotask before it is billed, or credit it after` }); continue; }
    skipped.push({ row: r.rowNo, why: `no automatic undo for ${r.action} ${r.entity}` });
  }
  // Flip dependencies: if B depended on A, undoing A waits for undoing B.
  for (const r of plan.rows) {
    const b = newNo.get(r.rowNo);
    if (b == null) continue;
    for (const d of dependsOn(r)) {
      const a = newNo.get(d);
      if (a == null) continue;
      const row = rows[a - 1]!;
      row.meta = { ...(row.meta ?? {}), dependsOn: [...new Set([...(dependsOn(row)), b])] };
    }
  }
  return { rows, skipped };
}
