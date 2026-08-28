// Block-hour contract usage (Expansion Spec §Phase 6 — contracts/reporting).
//
// GDS block-hour contracts are MONTHLY and use-it-or-lose-it: each month has its
// own purchased hours (from ContractBlocks) that expire at month end — there is no
// rollover / running pool. So each month stands alone:
//   overage   = hours used beyond that month's block  → billable
//   forfeited = purchased hours left unused when the month has ENDED → expired
// Current and future months are never "forfeited" (not yet expired).
//
// Pure and HTTP-free: the service fetches the blocks + time entries and feeds them
// here; this module owns the accounting so it can be unit-tested without a tenant.

export interface BlockHourBlock {
  /** Hours purchased for this block's period. */
  hours: number;
  /** ISO date; the block is attributed to this date's month. */
  startDate: string;
}

export interface BlockHourEntry {
  /** ISO date the work was performed; attributes usage to this month. */
  dateWorked: string;
  hoursWorked?: number;
  isNonBillable?: boolean;
}

export interface BlockMonth {
  month: string; // YYYY-MM
  allocated: number;
  used: number;
  overage: number;
  forfeited: number;
  /** Hours left this month (max(0, allocated-used)) — meaningful for the current month. */
  remaining: number;
  ended: boolean;
}

export interface BlockHourUsage {
  totalAllocated: number;
  totalUsed: number;
  billableOverageHours: number;
  forfeitedHours: number;
  monthsOver: number;
  currentMonth: string;
  months: BlockMonth[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const monthKey = (iso: string): string | null => {
  const s = String(iso ?? '');
  return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : null;
};

/**
 * Compute monthly block-hour usage for one contract. `asOf` decides which months
 * count as ended (default: now).
 */
export function computeBlockHourUsage(
  blocks: BlockHourBlock[],
  entries: BlockHourEntry[],
  asOf: Date = new Date()
): BlockHourUsage {
  const buckets = new Map<string, { allocated: number; used: number }>();
  const bucket = (m: string) => {
    let b = buckets.get(m);
    if (!b) { b = { allocated: 0, used: 0 }; buckets.set(m, b); }
    return b;
  };

  for (const blk of blocks ?? []) {
    const m = monthKey(blk.startDate);
    if (m) bucket(m).allocated += Number(blk.hours) || 0;
  }
  for (const te of entries ?? []) {
    if (te.isNonBillable) continue; // block hours are consumed by billable labor
    const m = monthKey(te.dateWorked);
    if (m) bucket(m).used += Number(te.hoursWorked) || 0;
  }

  const currentMonth = `${asOf.getUTCFullYear()}-${String(asOf.getUTCMonth() + 1).padStart(2, '0')}`;

  const months: BlockMonth[] = [...buckets.keys()].sort().map((month) => {
    const { allocated, used } = buckets.get(month)!;
    const ended = month < currentMonth;
    const overage = Math.max(0, used - allocated);
    const forfeited = ended ? Math.max(0, allocated - used) : 0;
    return {
      month,
      allocated: round2(allocated),
      used: round2(used),
      overage: round2(overage),
      forfeited: round2(forfeited),
      remaining: round2(Math.max(0, allocated - used)),
      ended,
    };
  });

  const sum = (pick: (m: BlockMonth) => number) => round2(months.reduce((s, m) => s + pick(m), 0));
  const current =
    months.find((m) => m.month === currentMonth) ??
    { month: currentMonth, allocated: 0, used: 0, overage: 0, forfeited: 0, remaining: 0, ended: false };

  return {
    totalAllocated: sum((m) => m.allocated),
    totalUsed: sum((m) => m.used),
    billableOverageHours: sum((m) => m.overage),
    forfeitedHours: sum((m) => m.forfeited),
    monthsOver: months.filter((m) => m.overage > 0).length,
    currentMonth: current.month,
    months,
  };
}
