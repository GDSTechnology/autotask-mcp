// Time-entry compliance / team hours (#100). Pure aggregation.
//
// Answers "is the team doing real-time time entry, and are the hours there?" from
// TimeEntries alone. Per resource × bucket (week/month) it reports:
//   • hours logged vs EXPECTED (utilization + billable utilization)
//   • billable vs non-billable split (non-billable is still paid time)
//   • APPROVED vs UNAPPROVED hours (billingApprovalDateTime) — the timesheet
//     check-and-balance: unapproved time can't be applied to contracts / billed
//   • LATE entries — logged > lateThresholdDays after the day worked (createDateTime
//     vs dateWorked): the real-time-discipline signal
// and flags resources who are under-logged, not logging, poorly utilized, or
// chronically late. Read-only; the service fetches, this computes.

import { bucketKey } from './project-pl.js';

export interface RawTimeEntry {
  resourceID?: number | null;
  hoursWorked?: number | null;
  isNonBillable?: boolean | null;
  billingApprovalDateTime?: string | null;
  dateWorked?: string | null;
  createDateTime?: string | null;
}

export interface BucketRow {
  bucket: string;
  totalHours: number;
  billableHours: number;
  nonBillableHours: number;
  approvedHours: number;
  unapprovedHours: number;
  entryCount: number;
  lateEntries: number;
  lateHours: number;
  utilizationPct: number | null;
  billableUtilizationPct: number | null;
  flags: string[];
}

export interface ResourceRow {
  resourceID: number;
  resourceName?: string | undefined;
  buckets: BucketRow[];
  totals: Omit<BucketRow, 'bucket' | 'flags'>;
  flags: string[];
}

export interface TimeEntryComplianceResult {
  from: string;
  to: string;
  bucket: 'week' | 'month';
  expectedHoursPerBucket: number;
  lateThresholdDays: number;
  resourcesEvaluated: number;
  bucketsCovered: string[];
  overall: Omit<BucketRow, 'bucket' | 'flags'>;
  byResource: ResourceRow[];
  flagged: number[];
  dataQuality: { entriesMissingCreateDate: number; entriesMissingResource: number };
  truncated?: boolean | undefined;
}

export interface ComplianceOptions {
  bucket?: 'week' | 'month' | undefined;
  expectedHoursPerBucket?: number | undefined;
  /** used to derive expectedHoursPerBucket when not given directly (default 40) */
  expectedHoursPerWeek?: number | undefined;
  /** entries created more than this many days after dateWorked are "late" (default 2) */
  lateThresholdDays?: number | undefined;
  /** fraction of expected below which a bucket is "under-logged" (default 0.9) */
  underLoggedThreshold?: number | undefined;
  /** billable-utilization fraction below which to flag (default 0.6) */
  lowBillableUtilThreshold?: number | undefined;
  /** late-hours / total-hours above which to flag chronic lateness (default 0.5) */
  lateRatioThreshold?: number | undefined;
  resourceNames?: Map<number, string> | undefined;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const DAY = 86_400_000;

function emptyAgg(): Omit<BucketRow, 'bucket' | 'flags'> {
  return { totalHours: 0, billableHours: 0, nonBillableHours: 0, approvedHours: 0, unapprovedHours: 0, entryCount: 0, lateEntries: 0, lateHours: 0, utilizationPct: null, billableUtilizationPct: null };
}

function pct(n: number, d: number): number | null {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : null;
}

/** Days between the day worked and when the entry was created (>=0), or null. */
function latenessDays(dateWorked: string | null | undefined, createDateTime: string | null | undefined): number | null {
  if (!dateWorked || !createDateTime) return null;
  const w = Date.parse(dateWorked), c = Date.parse(createDateTime);
  if (Number.isNaN(w) || Number.isNaN(c)) return null;
  return Math.max(0, Math.floor((c - w) / DAY));
}

export function computeTimeEntryCompliance(
  entries: RawTimeEntry[],
  from: string,
  to: string,
  opts: ComplianceOptions = {},
): TimeEntryComplianceResult {
  const bucket = opts.bucket ?? 'week';
  const expectedPerWeek = opts.expectedHoursPerWeek && opts.expectedHoursPerWeek > 0 ? opts.expectedHoursPerWeek : 40;
  const expected = opts.expectedHoursPerBucket && opts.expectedHoursPerBucket > 0
    ? opts.expectedHoursPerBucket
    : (bucket === 'month' ? Math.round(expectedPerWeek * 52 / 12) : expectedPerWeek);
  const lateThreshold = opts.lateThresholdDays ?? 2;
  const underThreshold = opts.underLoggedThreshold ?? 0.9;
  const lowBillableUtil = opts.lowBillableUtilThreshold ?? 0.6;
  const lateRatio = opts.lateRatioThreshold ?? 0.5;

  const byResource = new Map<number, Map<string, BucketRow>>();
  const bucketSet = new Set<string>();
  let missingCreate = 0, missingResource = 0;

  const applyEntry = (row: BucketRow | Omit<BucketRow, 'bucket' | 'flags'>, e: RawTimeEntry, late: number | null): void => {
    const hrs = Number(e.hoursWorked) || 0;
    row.totalHours = round1(row.totalHours + hrs);
    if (e.isNonBillable) row.nonBillableHours = round1(row.nonBillableHours + hrs);
    else row.billableHours = round1(row.billableHours + hrs);
    if (e.billingApprovalDateTime) row.approvedHours = round1(row.approvedHours + hrs);
    else row.unapprovedHours = round1(row.unapprovedHours + hrs);
    row.entryCount += 1;
    if (late != null && late > lateThreshold) { row.lateEntries += 1; row.lateHours = round1(row.lateHours + hrs); }
  };

  for (const e of entries) {
    if (e.resourceID == null) { missingResource++; continue; }
    const key = bucketKey(e.dateWorked ?? undefined, bucket);
    if (!key) continue;
    bucketSet.add(key);
    const late = latenessDays(e.dateWorked, e.createDateTime);
    if (e.createDateTime == null) missingCreate++;
    let rmap = byResource.get(e.resourceID);
    if (!rmap) { rmap = new Map(); byResource.set(e.resourceID, rmap); }
    let row = rmap.get(key);
    if (!row) { row = { bucket: key, ...emptyAgg(), flags: [] }; rmap.set(key, row); }
    applyEntry(row, e, late);
  }

  const overall = emptyAgg();
  const resourceRows: ResourceRow[] = [];
  for (const [resourceID, rmap] of byResource) {
    const buckets = [...rmap.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
    const totals = emptyAgg();
    for (const b of buckets) {
      b.utilizationPct = pct(b.totalHours, expected);
      b.billableUtilizationPct = pct(b.billableHours, expected);
      // per-bucket flags
      if (b.totalHours === 0) b.flags.push('no_time');
      else if (b.totalHours < expected * underThreshold) b.flags.push('under_logged');
      if (b.billableUtilizationPct != null && b.billableUtilizationPct < lowBillableUtil * 100) b.flags.push('low_billable_utilization');
      if (b.totalHours > 0 && b.lateHours / b.totalHours > lateRatio) b.flags.push('chronic_late_entry');
      // roll up
      totals.totalHours = round1(totals.totalHours + b.totalHours);
      totals.billableHours = round1(totals.billableHours + b.billableHours);
      totals.nonBillableHours = round1(totals.nonBillableHours + b.nonBillableHours);
      totals.approvedHours = round1(totals.approvedHours + b.approvedHours);
      totals.unapprovedHours = round1(totals.unapprovedHours + b.unapprovedHours);
      totals.entryCount += b.entryCount;
      totals.lateEntries += b.lateEntries;
      totals.lateHours = round1(totals.lateHours + b.lateHours);
    }
    const expectedTotal = expected * buckets.length;
    totals.utilizationPct = pct(totals.totalHours, expectedTotal);
    totals.billableUtilizationPct = pct(totals.billableHours, expectedTotal);
    // resource-level flags = union of any bucket flags that recur, plus totals-based
    const flags = new Set<string>();
    for (const b of buckets) b.flags.forEach((f) => flags.add(f));
    const rr: ResourceRow = {
      resourceID,
      ...(opts.resourceNames?.get(resourceID) ? { resourceName: opts.resourceNames.get(resourceID) } : {}),
      buckets, totals, flags: [...flags],
    };
    resourceRows.push(rr);
    // overall
    overall.totalHours = round1(overall.totalHours + totals.totalHours);
    overall.billableHours = round1(overall.billableHours + totals.billableHours);
    overall.nonBillableHours = round1(overall.nonBillableHours + totals.nonBillableHours);
    overall.approvedHours = round1(overall.approvedHours + totals.approvedHours);
    overall.unapprovedHours = round1(overall.unapprovedHours + totals.unapprovedHours);
    overall.entryCount += totals.entryCount;
    overall.lateEntries += totals.lateEntries;
    overall.lateHours = round1(overall.lateHours + totals.lateHours);
  }
  resourceRows.sort((a, b) => a.totals.totalHours - b.totals.totalHours); // worst-logged first
  const expectedOverall = expected * bucketSet.size * resourceRows.length;
  overall.utilizationPct = pct(overall.totalHours, expectedOverall);
  overall.billableUtilizationPct = pct(overall.billableHours, expectedOverall);

  return {
    from, to, bucket, expectedHoursPerBucket: expected, lateThresholdDays: lateThreshold,
    resourcesEvaluated: resourceRows.length,
    bucketsCovered: [...bucketSet].sort(),
    overall,
    byResource: resourceRows,
    flagged: resourceRows.filter((r) => r.flags.length > 0).map((r) => r.resourceID),
    dataQuality: { entriesMissingCreateDate: missingCreate, entriesMissingResource: missingResource },
  };
}
