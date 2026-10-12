// Contract-line adjustments, for the change-plan executor and the drift check.
//
// Autotask changes a contract line's price and units — and adds a service or
// bundle to a running contract — only through adjustments:
//   ContractServiceAdjustments        (line: ContractServices,       units: ContractServiceUnits)
//   ContractServiceBundleAdjustments  (line: ContractServiceBundles, units: ContractServiceBundleUnits)
// Both are create-only and NOTHING on them is queryable (verified with
// entityInformation/fields, 2026-10-11), so an adjustment can't be read back
// or found again by id. It is verified by its EFFECT instead: the line's unit
// period starting on / after the effective date must show the planned units
// and price. An adjustment without a line id (contractID + serviceID) ADDS
// that service to the contract from the effective date.

import type { PlanRow } from '../change-plans/store.js';
import type { ReadBack } from '../change-plans/execute.js';

export type LineKind = 'service' | 'bundle';
export interface AdjustmentSpec { kind: LineKind; line: string; units: string; lineField: string; refField: string }
export const ADJUSTMENTS: Record<string, AdjustmentSpec> = {
  ContractServiceAdjustments: { kind: 'service', line: 'ContractServices', units: 'ContractServiceUnits', lineField: 'contractServiceID', refField: 'serviceID' },
  ContractServiceBundleAdjustments: { kind: 'bundle', line: 'ContractServiceBundles', units: 'ContractServiceBundleUnits', lineField: 'contractServiceBundleID', refField: 'serviceBundleID' },
};
export const specOfKind = (k: LineKind): AdjustmentSpec => (k === 'bundle' ? ADJUSTMENTS.ContractServiceBundleAdjustments! : ADJUSTMENTS.ContractServiceAdjustments!);

type Filter = { op: string; field: string; value: unknown };
export type QueryFn = <T = Record<string, unknown>>(entity: string, filters: Filter[], opts: { maxRecords?: number; includeFields?: string[]; noCache?: boolean }) => Promise<T[]>;

export interface UnitPeriod { units: number; unitPrice: number | null; startDate: string; endDate: string }
const r4 = (n: number) => Math.round(n * 10000) / 10000;
const day = (d: string) => String(d).slice(0, 10);
const toPeriod = (u: Record<string, unknown>): UnitPeriod => {
  const units = Number(u.units ?? 0);
  return { units, unitPrice: units ? r4(Number(u.price ?? 0) / units) : null, startDate: day(String(u.startDate)), endDate: day(String(u.endDate)) };
};
export const dayBefore = (d: string) => { const x = new Date(`${day(d)}T00:00:00Z`); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };

/** The unit period of a line covering a date. */
export async function unitsOn(q: QueryFn, kind: LineKind, lineId: number, date: string): Promise<UnitPeriod | null> {
  const s = specOfKind(kind);
  const u = (await q<Record<string, unknown>>(s.units, [{ op: 'eq', field: s.lineField, value: lineId }, { op: 'lte', field: 'startDate', value: `${day(date)}T00:00:00` }, { op: 'gte', field: 'endDate', value: `${day(date)}T00:00:00` }], { maxRecords: 5, includeFields: ['id', 'units', 'price', 'startDate', 'endDate'], noCache: true }));
  return u.length ? toPeriod(u.sort((a, b) => String(b.startDate).localeCompare(String(a.startDate)))[0]!) : null;
}

/** The first unit period of a line starting on / after a date (a full period, so price ÷ units is the unit price) — else the one covering it. */
export async function unitsFrom(q: QueryFn, kind: LineKind, lineId: number, date: string): Promise<UnitPeriod | null> {
  const s = specOfKind(kind);
  const u = await q<Record<string, unknown>>(s.units, [{ op: 'eq', field: s.lineField, value: lineId }, { op: 'gte', field: 'startDate', value: `${day(date)}T00:00:00` }], { maxRecords: 60, includeFields: ['id', 'units', 'price', 'startDate', 'endDate'], noCache: true });
  if (u.length) return toPeriod(u.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate)))[0]!);
  return unitsOn(q, kind, lineId, date);
}

/** The contract line an adjustment applies to: its line id, or the line of that service / bundle on the contract. */
export async function resolveLine(q: QueryFn, spec: AdjustmentSpec, after: Record<string, unknown>): Promise<number | null> {
  if (after[spec.lineField] != null) return Number(after[spec.lineField]);
  if (after.contractID == null || after[spec.refField] == null) return null;
  const hits = await q<{ id: number }>(spec.line, [{ op: 'eq', field: 'contractID', value: after.contractID }, { op: 'eq', field: spec.refField, value: after[spec.refField] }], { maxRecords: 5, includeFields: ['id'], noCache: true });
  return hits.length ? Math.max(...hits.map((h) => Number(h.id))) : null;
}

/** State of the line the day before the adjustment takes effect (a line not on the contract yet = 0 units). */
export async function adjustmentSnapshot(q: QueryFn, row: Pick<PlanRow, 'entity' | 'after'>): Promise<Record<string, unknown> | null> {
  const spec = ADJUSTMENTS[row.entity]; const a = row.after ?? {};
  if (!spec || !a.effectiveDate) return null;
  const lineId = await resolveLine(q, spec, a);
  if (lineId == null) return { units: 0, unitPrice: null, lineId: null };
  const u = await unitsOn(q, spec.kind, lineId, dayBefore(String(a.effectiveDate)));
  return { units: u?.units ?? 0, unitPrice: u?.unitPrice ?? null, lineId };
}

/**
 * What the line must show from the effective date once the adjustment is in:
 * the state the day before plus the unit change — or, for a revert, the
 * original state it restores (meta.expect).
 */
export function adjustmentExpect(row: Pick<PlanRow, 'after'> & { meta?: Record<string, unknown> | null }, snap: Record<string, unknown> | null): Record<string, unknown> {
  const fixed = row.meta?.expect as { units?: number; unitPrice?: number | null } | undefined;
  if (fixed && typeof fixed.units === 'number') return { units: r4(fixed.units), ...(fixed.units > 0 && fixed.unitPrice != null ? { unitPrice: r4(fixed.unitPrice) } : {}) };
  const a = row.after ?? {};
  const units = r4(Number(snap?.units ?? 0) + Number(a.unitChange ?? 0));
  return { units, ...(units > 0 && a.adjustedUnitPrice != null ? { unitPrice: r4(Number(a.adjustedUnitPrice)) } : {}) };
}

const matches = (u: UnitPeriod, want: Record<string, unknown>) => Math.abs(u.units - Number(want.units)) < 1e-4 && (want.unitPrice == null || (u.unitPrice != null && Math.abs(u.unitPrice - Number(want.unitPrice)) < 1e-3));

/** A re-run: the line already shows the planned effect → the line id (nothing to create). */
export async function adjustmentAlreadyApplied(q: QueryFn, row: Pick<PlanRow, 'entity' | 'after'> & { meta?: Record<string, unknown> | null }, snap: Record<string, unknown> | null): Promise<number | null> {
  const spec = ADJUSTMENTS[row.entity]; const a = row.after ?? {};
  if (!spec || !a.effectiveDate) return null;
  const lineId = (snap?.lineId as number | null | undefined) ?? (await resolveLine(q, spec, a));
  if (lineId == null) return null;
  const want = adjustmentExpect(row, snap);
  // No change between the day before and the target → it can only "match" if it was already done.
  if (Number(a.unitChange ?? 0) === 0 && (want.unitPrice == null || (snap?.unitPrice != null && Math.abs(Number(snap.unitPrice) - Number(want.unitPrice)) < 1e-3))) return null;
  const u = await unitsFrom(q, spec.kind, lineId, String(a.effectiveDate));
  return u && u.startDate >= day(String(a.effectiveDate)) && matches(u, want) ? lineId : null;
}

/** Verify a created adjustment by its effect on the line. */
export async function adjustmentReadBack(q: QueryFn, row: Pick<PlanRow, 'entity' | 'after'> & { meta?: Record<string, unknown> | null }, snap: Record<string, unknown> | null): Promise<ReadBack | null> {
  const spec = ADJUSTMENTS[row.entity]; const a = row.after ?? {};
  if (!spec || !a.effectiveDate) return null;
  const lineId = await resolveLine(q, spec, a);
  if (lineId == null) return { unverifiable: `no ${spec.line} line for ${spec.refField} ${String(a[spec.refField])} on contract ${String(a.contractID)} yet` };
  const u = await unitsFrom(q, spec.kind, lineId, String(a.effectiveDate));
  if (!u) return { unverifiable: `line ${lineId} has no unit period on or after ${day(String(a.effectiveDate))} yet` };
  return { record: { units: u.units, unitPrice: u.unitPrice }, expect: adjustmentExpect(row, snap), lineId };
}
