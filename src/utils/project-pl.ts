// Profitability (P&L) for a project / task / ticket, bucketed by week or month
// (#98). Burden-based cost from ALL time worked (billable or not, posted or not)
// vs realized revenue from posted billing items, with posted-vs-pending clarity.
// Pure/HTTP-free; the service fetches time entries, billing items and resource
// burden and hands them in.
//
// Cost model (see #98): labor cost = Σ hoursWorked × resource burden over EVERY
// time entry — paid time is a cost the moment it's worked. Materials/expense cost
// = ourCost of non-labor billing items only (labor cost comes from time, so no
// double-count). Revenue = totalAmount of POSTED billing items. Unapproved
// billable hours are surfaced as pending (revenue-in-waiting), not dollarized.

/** BillingItems.billingItemType values whose ourCost is a materials/expense cost
 *  (labor cost is taken from time entries instead). 3=Cost, 4=Expense. */
export const MATERIAL_COST_ITEM_TYPES = new Set<number>([3, 4]);

export interface PLTimeEntry {
  resourceID?: number;
  hoursWorked?: number;
  isNonBillable?: boolean;
  billingApprovalDateTime?: string | null;
  dateWorked?: string;
}
export interface PLBillingItem {
  totalAmount?: number;
  ourCost?: number;
  billingItemType?: number;
  nonBillable?: number; // 0/1 on BillingItems
  postedDate?: string | null;
  itemDate?: string;
}

export interface PLBucket {
  period: string;
  laborHours: number;
  laborCost: number;
  materialsCost: number;
  totalCost: number;
  postedRevenue: number;
  realizedMargin: number;
  marginPct: number | null;
  pendingBillableHours: number;
}

export interface ProjectPLResult {
  scope: 'project' | 'task' | 'ticket';
  entityId: number;
  bucket: 'week' | 'month';
  buckets: PLBucket[];
  totals: Omit<PLBucket, 'period'>;
  /** Guardrail: hours whose resource has no burden set — cost understated here. */
  costCoverage: { hoursNoBurden: number; resourcesMissingBurden: number[] };
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Period key: 'YYYY-MM' for month, the ISO date of the week's Monday for week. */
export function bucketKey(dateISO: string | null | undefined, bucket: 'week' | 'month'): string | null {
  if (!dateISO) return null;
  const ms = Date.parse(dateISO);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  if (bucket === 'month') return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  // Week: back up to Monday (UTC).
  const day = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
  return monday.toISOString().slice(0, 10);
}

export function computeProjectPL(input: {
  scope: 'project' | 'task' | 'ticket';
  entityId: number;
  bucket: 'week' | 'month';
  timeEntries: PLTimeEntry[];
  billingItems: PLBillingItem[];
  burdenByResource: Map<number, number>;
}): ProjectPLResult {
  const buckets = new Map<string, PLBucket>();
  const get = (period: string): PLBucket => {
    let b = buckets.get(period);
    if (!b) { b = { period, laborHours: 0, laborCost: 0, materialsCost: 0, totalCost: 0, postedRevenue: 0, realizedMargin: 0, marginPct: null, pendingBillableHours: 0 }; buckets.set(period, b); }
    return b;
  };

  const resourcesMissingBurden = new Set<number>();
  let hoursNoBurden = 0;

  // Labor cost + hours, by dateWorked. Every entry counts toward cost.
  for (const te of input.timeEntries) {
    const period = bucketKey(te.dateWorked, input.bucket);
    if (period == null) continue;
    const hrs = te.hoursWorked ?? 0;
    const b = get(period);
    b.laborHours += hrs;
    const burden = te.resourceID != null ? input.burdenByResource.get(te.resourceID) : undefined;
    if (burden == null || burden === 0) { if (hrs > 0) { hoursNoBurden += hrs; if (te.resourceID != null) resourcesMissingBurden.add(te.resourceID); } }
    else b.laborCost += hrs * burden;
    // Pending = billable but not yet approved/posted → revenue-in-waiting.
    if (te.isNonBillable !== true && !te.billingApprovalDateTime) b.pendingBillableHours += hrs;
  }

  // Revenue (posted billing items) + materials/expense cost, by postedDate.
  for (const bi of input.billingItems) {
    if (!bi.postedDate) continue; // only posted = realized
    const period = bucketKey(bi.postedDate, input.bucket);
    if (period == null) continue;
    const b = get(period);
    if (bi.nonBillable !== 1) b.postedRevenue += bi.totalAmount ?? 0;
    if (bi.billingItemType != null && MATERIAL_COST_ITEM_TYPES.has(bi.billingItemType)) b.materialsCost += bi.ourCost ?? 0;
  }

  const finalize = (b: PLBucket) => {
    b.laborHours = round2(b.laborHours);
    b.laborCost = round2(b.laborCost);
    b.materialsCost = round2(b.materialsCost);
    b.totalCost = round2(b.laborCost + b.materialsCost);
    b.postedRevenue = round2(b.postedRevenue);
    b.realizedMargin = round2(b.postedRevenue - b.totalCost);
    b.marginPct = b.postedRevenue !== 0 ? round2(b.realizedMargin / b.postedRevenue) : null;
    b.pendingBillableHours = round2(b.pendingBillableHours);
  };
  const ordered = [...buckets.values()].sort((a, b) => a.period.localeCompare(b.period));
  for (const b of ordered) finalize(b);

  const sum = (f: (b: PLBucket) => number) => round2(ordered.reduce((s, b) => s + f(b), 0));
  const totalRevenue = sum((b) => b.postedRevenue);
  const totalCost = sum((b) => b.totalCost);
  const totals: Omit<PLBucket, 'period'> = {
    laborHours: sum((b) => b.laborHours),
    laborCost: sum((b) => b.laborCost),
    materialsCost: sum((b) => b.materialsCost),
    totalCost,
    postedRevenue: totalRevenue,
    realizedMargin: round2(totalRevenue - totalCost),
    marginPct: totalRevenue !== 0 ? round2((totalRevenue - totalCost) / totalRevenue) : null,
    pendingBillableHours: sum((b) => b.pendingBillableHours),
  };

  return {
    scope: input.scope,
    entityId: input.entityId,
    bucket: input.bucket,
    buckets: ordered,
    totals,
    costCoverage: { hoursNoBurden: round2(hoursNoBurden), resourcesMissingBurden: [...resourcesMissingBurden] },
  };
}
