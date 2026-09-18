// Recurring-revenue roll-up for a contract (#73, Phase 6 / §10).
//
// Autotask recurring-service contracts bill MONTHLY: each service line
// (ContractServices) and bundle line (ContractServiceBundles) carries a per-unit
// rate, and the actual per-period quantities live in ContractServiceUnits /
// ContractServiceBundleUnits (one row per line per period, with units + a
// PRORATED `price` for partial first/last months).
//
// Verified live (test tenant, 2026-09-18): a full-month unit row's `price`
// equals units × unitPrice; partial months are `price = units × unitPrice ×
// (coveredDays / calendarMonthDays)`. So the steady-state monthly recurring for
// a line is units × rate (rate = adjustedPrice ?? unitPrice) — proration-free —
// NOT a naive sum of the prorated `price` values. This module computes MRR/ARR
// that way and flags any line whose covering period is prorated.

export interface RateLine {
  /** ContractServices.id or ContractServiceBundles.id */
  id: number;
  /** serviceID (service line) or serviceBundleID (bundle line) */
  refId?: number;
  unitPrice?: number;
  adjustedPrice?: number;
}

export interface UnitRow {
  /** contractServiceID (service units) or contractServiceBundleID (bundle units) */
  lineId: number;
  units?: number;
  /** the prorated period amount actually billed for this row */
  price?: number;
  startDate?: string;
  endDate?: string;
}

export interface RecurringLine {
  kind: 'service' | 'bundle';
  lineId: number;
  refId: number | null;
  refName?: string;
  units: number;
  rate: number;
  monthly: number;
  active: boolean;
  period: { startDate: string; endDate: string } | null;
  /** the covering unit row's actual (prorated) billed amount, when active */
  billedThisPeriod: number | null;
  /** true when the covering period is a partial month (billed < units × rate) */
  prorated: boolean;
}

export interface RecurringRevenue {
  asOf: string;
  mrr: number;
  arr: number;
  activeLineCount: number;
  lineCount: number;
  lines: RecurringLine[];
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** The unit row for `lineId` whose [startDate, endDate] covers `asOf`; the one
 *  with the latest start wins when several overlap. */
function coveringRow(rows: UnitRow[], lineId: number, asOf: number): UnitRow | null {
  let best: UnitRow | null = null;
  let bestStart = -Infinity;
  for (const r of rows) {
    if (r.lineId !== lineId || !r.startDate || !r.endDate) continue;
    const start = Date.parse(r.startDate);
    const end = Date.parse(r.endDate);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    if (start <= asOf && asOf <= end && start > bestStart) {
      best = r;
      bestStart = start;
    }
  }
  return best;
}

function buildLine(
  kind: 'service' | 'bundle',
  line: RateLine,
  units: UnitRow[],
  asOf: number,
): RecurringLine {
  const rate = line.adjustedPrice ?? line.unitPrice ?? 0;
  const row = coveringRow(units, line.id, asOf);
  const qty = row?.units ?? 0;
  const active = row != null && qty > 0 && rate > 0;
  const monthly = active ? round2(qty * rate) : 0;
  const billed = row?.price ?? null;
  // A partial (prorated) covering period bills less than the full units × rate.
  const prorated = active && billed != null && Math.abs(billed - qty * rate) > 0.01;
  return {
    kind,
    lineId: line.id,
    refId: line.refId ?? null,
    units: qty,
    rate,
    monthly,
    active,
    period: row?.startDate && row?.endDate ? { startDate: row.startDate, endDate: row.endDate } : null,
    billedThisPeriod: billed,
    prorated,
  };
}

/**
 * Compute MRR/ARR for a contract as of `asOf` from its service + bundle rate
 * lines and their per-period unit rows. Pure — no I/O; name enrichment is
 * layered on by the caller. A line with no unit row covering `asOf` (or a zero
 * rate/qty) is reported with active=false and contributes nothing to MRR.
 */
export function computeRecurringRevenue(input: {
  serviceLines: RateLine[];
  serviceUnits: UnitRow[];
  bundleLines: RateLine[];
  bundleUnits: UnitRow[];
  asOf: Date;
}): RecurringRevenue {
  const asOfMs = input.asOf.getTime();
  const lines: RecurringLine[] = [
    ...input.serviceLines.map((l) => buildLine('service', l, input.serviceUnits, asOfMs)),
    ...input.bundleLines.map((l) => buildLine('bundle', l, input.bundleUnits, asOfMs)),
  ];
  const active = lines.filter((l) => l.active);
  const mrr = round2(active.reduce((sum, l) => sum + l.monthly, 0));
  return {
    asOf: input.asOf.toISOString().slice(0, 10),
    mrr,
    arr: round2(mrr * 12),
    activeLineCount: active.length,
    lineCount: lines.length,
    lines,
  };
}
