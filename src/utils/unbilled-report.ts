// Unbilled-work / revenue-leakage reporting (Expansion Spec §Phase 6).
//
// Autotask creates a BillingItem for each posted billable item (time or charge);
// while it has no invoiceID it is billable work NOT yet invoiced. Accounting that
// only reviews recent time misses older items, which age out unbilled — lost
// revenue. This summarizes uninvoiced items by age so the stale ones surface.
//
// Pure: the service fetches the uninvoiced BillingItems (invoiceID notExist,
// nonBillable false) and feeds them here.

export interface UnbilledItem {
  id: number;
  itemDate?: string;
  postedDate?: string;
  totalAmount?: number;
  extendedPrice?: number;
  timeEntryID?: number | null;
  ticketChargeID?: number | null;
  contractID?: number | null;
  ticketID?: number | null;
  companyID?: number | null;
  company?: string;
}

export type AgeBucket = '0-30' | '31-60' | '61-90' | '90+';

export interface UnbilledSummary {
  totalCount: number;
  totalAmount: number;
  atRiskCount: number;   // older than 30 days
  atRiskAmount: number;
  oldestDays: number;
  buckets: Record<AgeBucket, { count: number; amount: number }>;
  bySource: { time: number; charge: number; other: number };
  byCompany: Array<{ companyID: number | null; company: string; count: number; amount: number; atRiskAmount: number }>;
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round2 = (n: number) => Math.round(n * 100) / 100;

function bucketOf(days: number): AgeBucket {
  return days <= 30 ? '0-30' : days <= 60 ? '31-60' : days <= 90 ? '61-90' : '90+';
}

export function summarizeUnbilled(items: UnbilledItem[], asOf: Date = new Date()): UnbilledSummary {
  const buckets: Record<AgeBucket, { count: number; amount: number }> = {
    '0-30': { count: 0, amount: 0 }, '31-60': { count: 0, amount: 0 },
    '61-90': { count: 0, amount: 0 }, '90+': { count: 0, amount: 0 },
  };
  const bySource = { time: 0, charge: 0, other: 0 };
  const companies = new Map<string, { companyID: number | null; company: string; count: number; amount: number; atRiskAmount: number }>();

  let totalAmount = 0, atRiskCount = 0, atRiskAmount = 0, oldestDays = 0;

  for (const it of items ?? []) {
    const amount = round2(num(it.totalAmount ?? it.extendedPrice));
    const dateStr = it.itemDate ?? it.postedDate;
    const days = dateStr ? Math.floor((asOf.getTime() - new Date(dateStr).getTime()) / 864e5) : 0;
    const b = bucketOf(days);
    buckets[b].count += 1;
    buckets[b].amount = round2(buckets[b].amount + amount);
    totalAmount += amount;
    oldestDays = Math.max(oldestDays, days);
    const atRisk = days > 30;
    if (atRisk) { atRiskCount += 1; atRiskAmount += amount; }

    if (it.timeEntryID != null) bySource.time += 1;
    else if (it.ticketChargeID != null) bySource.charge += 1;
    else bySource.other += 1;

    const key = String(it.companyID ?? 'unknown');
    let c = companies.get(key);
    if (!c) { c = { companyID: it.companyID ?? null, company: it.company ?? key, count: 0, amount: 0, atRiskAmount: 0 }; companies.set(key, c); }
    c.count += 1;
    c.amount = round2(c.amount + amount);
    if (atRisk) c.atRiskAmount = round2(c.atRiskAmount + amount);
  }

  const byCompany = [...companies.values()].sort((a, b) => b.atRiskAmount - a.atRiskAmount || b.amount - a.amount);
  return {
    totalCount: (items ?? []).length,
    totalAmount: round2(totalAmount),
    atRiskCount,
    atRiskAmount: round2(atRiskAmount),
    oldestDays,
    buckets,
    bySource,
    byCompany,
  };
}
