// Unbilled *time* leakage (the pre-invoice stage): billable time entries that
// have not been approved/posted for billing yet, so they cannot appear on an
// invoice until someone approves them. Complements the posted-but-not-invoiced
// BillingItems report (unbilled-report.ts) — together they cover the funnel
// logged -> approved -> posted -> invoiced.
//
// Revenue value = billable hours x the role's bill rate. Where a rate is not
// known the value stays null (null must survive — never coerced to 0) and the
// hours are still counted so nothing is hidden.

export interface UnbilledTimeEntry {
  id?: number;
  resourceID?: number;
  roleID?: number;
  dateWorked?: string;
  createDateTime?: string;
  hoursWorked?: number;
  hoursToBill?: number;
  isNonBillable?: boolean;
  billingApprovalDateTime?: string | null;
  ticketID?: number;
  taskID?: number;
  contractID?: number | null;
}

export type AgeBucket = '0-30' | '31-60' | '61-90' | '90+';

// Labour-billing basis of the contract the time was worked under. Mirrors
// contract-labour.ts LabourBasis plus `no_contract` — time on a company with NO
// contract at all. That is NOT absorbed and must never be filtered out: it is
// billable-until-proven-otherwise and often a bigger leak than contract time,
// so it is surfaced as its own first-class bucket. `unknown` = contract exists
// but its type could not be classified.
export type ContractBasis = 'billed' | 'block' | 'absorbed' | 'umbrella' | 'unknown' | 'no_contract';

export interface BasisRollup {
  entries: number;
  billableHours: number;
  estValue: number | null;
  hoursMissingRate: number;
}

// Which bases are worth a human's attention (chase or set up billing) vs.
// working as designed. no_contract + unknown are "needs review"; absorbed +
// umbrella are by design. billed + block are active leakage to chase.
const REVIEW_BASES: ReadonlySet<ContractBasis> = new Set<ContractBasis>(['billed', 'block', 'no_contract', 'unknown']);

export interface ResourceUnbilledTime {
  resourceID: number;
  resourceName: string | null;
  entries: number;
  billableHours: number;
  estValue: number | null; // null when no entry had a resolvable bill rate
  hoursMissingRate: number; // billable hours with no resolvable rate (value gap)
  buckets: Record<AgeBucket, number>; // billable hours by dateWorked age
  avgWriteUpLagDays: number | null; // mean(createDateTime - dateWorked), when known
  oldestDateWorked: string | null;
}

export interface UnbilledTimeSummary {
  asOf: string;
  totals: {
    entries: number;
    billableHours: number;
    estValue: number | null;
    hoursMissingRate: number;
    buckets: Record<AgeBucket, number>;
    atRiskHours: number; // > 30 days old by dateWorked
    needsReviewHours: number; // billable hours in leakage/needs-review bases (excludes absorbed + umbrella)
  };
  byResource: ResourceUnbilledTime[];
  // Same billable time bucketed by the contract's labour-billing basis, so
  // contract-less work (`no_contract`) is surfaced, never excluded. Absent when
  // no basis mapping was supplied (all time would collapse to no_contract and
  // mislead), so callers can tell "unknown" from "not looked up".
  byContractBasis?: Record<ContractBasis, BasisRollup>;
}

const DAY = 86_400_000;
function ageDays(dateWorked: string | undefined, asOf: Date): number | null {
  if (!dateWorked) return null;
  const t = Date.parse(dateWorked);
  if (Number.isNaN(t)) return null;
  return Math.floor((asOf.getTime() - t) / DAY);
}
function bucketOf(days: number): AgeBucket {
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}
const emptyBuckets = (): Record<AgeBucket, number> => ({ '0-30': 0, '31-60': 0, '61-90': 0, '90+': 0 });
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Aggregate unbilled (unapproved) billable time per resource.
 * @param entries billable, unapproved time entries
 * @param opts.rateByRole roleID -> bill rate ($/hr); missing => value unknown
 * @param opts.nameByResource resourceID -> display name
 */
export function summarizeUnbilledTime(
  entries: UnbilledTimeEntry[],
  opts: {
    rateByRole?: Map<number, number>;
    nameByResource?: Map<number, string>;
    asOf?: Date;
    /**
     * contractID -> labour-billing basis. When supplied, the summary adds a
     * byContractBasis rollup and time on contract-less companies lands in the
     * `no_contract` bucket (surfaced, never dropped). Omit it and the rollup is
     * omitted rather than collapsing everything to no_contract.
     */
    basisByContract?: Map<number, ContractBasis>;
  } = {}
): UnbilledTimeSummary {
  const asOf = opts.asOf ?? new Date();
  const rateByRole = opts.rateByRole ?? new Map();
  const nameByResource = opts.nameByResource ?? new Map();
  const basisByContract = opts.basisByContract;

  const emptyBasis = (): BasisRollup => ({ entries: 0, billableHours: 0, estValue: null, hoursMissingRate: 0 });
  const byBasis: Record<ContractBasis, BasisRollup> | undefined = basisByContract
    ? { billed: emptyBasis(), block: emptyBasis(), absorbed: emptyBasis(), umbrella: emptyBasis(), unknown: emptyBasis(), no_contract: emptyBasis() }
    : undefined;
  const basisOf = (e: UnbilledTimeEntry): ContractBasis =>
    e.contractID != null ? (basisByContract!.get(Number(e.contractID)) ?? 'unknown') : 'no_contract';

  const byId = new Map<number, ResourceUnbilledTime & { _lagSum: number; _lagN: number }>();
  for (const e of entries) {
    const rid = e.resourceID != null ? Number(e.resourceID) : -1;
    const hours = e.hoursToBill != null ? Number(e.hoursToBill) : e.hoursWorked != null ? Number(e.hoursWorked) : 0;
    if (!(hours > 0)) continue;
    let r = byId.get(rid);
    if (!r) {
      r = { resourceID: rid, resourceName: nameByResource.get(rid) ?? null, entries: 0, billableHours: 0, estValue: null, hoursMissingRate: 0, buckets: emptyBuckets(), avgWriteUpLagDays: null, oldestDateWorked: null, _lagSum: 0, _lagN: 0 };
      byId.set(rid, r);
    }
    r.entries += 1;
    r.billableHours = round2(r.billableHours + hours);
    // value at the role's bill rate (null-survives)
    const rate = e.roleID != null ? rateByRole.get(Number(e.roleID)) : undefined;
    if (rate != null) r.estValue = round2((r.estValue ?? 0) + hours * rate);
    else r.hoursMissingRate = round2(r.hoursMissingRate + hours);
    // aging by dateWorked
    const days = ageDays(e.dateWorked, asOf);
    if (days != null) r.buckets[bucketOf(days)] = round2(r.buckets[bucketOf(days)] + hours);
    if (e.dateWorked && (r.oldestDateWorked == null || e.dateWorked < r.oldestDateWorked)) r.oldestDateWorked = e.dateWorked;
    // write-up lag
    if (e.createDateTime && e.dateWorked) {
      const lag = Math.floor((Date.parse(e.createDateTime) - Date.parse(`${String(e.dateWorked).slice(0, 10)}T00:00:00Z`)) / DAY);
      if (!Number.isNaN(lag)) { r._lagSum += lag; r._lagN += 1; }
    }
    // contract labour-billing basis (no_contract surfaced, never dropped)
    if (byBasis) {
      const b = byBasis[basisOf(e)];
      b.entries += 1;
      b.billableHours = round2(b.billableHours + hours);
      if (rate != null) b.estValue = round2((b.estValue ?? 0) + hours * rate);
      else b.hoursMissingRate = round2(b.hoursMissingRate + hours);
    }
  }

  const byResource = [...byId.values()].map((r) => {
    const { _lagSum, _lagN, ...rest } = r;
    rest.avgWriteUpLagDays = _lagN > 0 ? round2(_lagSum / _lagN) : null;
    return rest;
  }).sort((a, b) => b.billableHours - a.billableHours);

  const totals = {
    entries: byResource.reduce((s, r) => s + r.entries, 0),
    billableHours: round2(byResource.reduce((s, r) => s + r.billableHours, 0)),
    estValue: byResource.some((r) => r.estValue != null) ? round2(byResource.reduce((s, r) => s + (r.estValue ?? 0), 0)) : null,
    hoursMissingRate: round2(byResource.reduce((s, r) => s + r.hoursMissingRate, 0)),
    buckets: byResource.reduce((acc, r) => { (Object.keys(acc) as AgeBucket[]).forEach((k) => { acc[k] = round2(acc[k] + r.buckets[k]); }); return acc; }, emptyBuckets()),
    atRiskHours: 0,
    needsReviewHours: 0,
  };
  totals.atRiskHours = round2(totals.buckets['31-60'] + totals.buckets['61-90'] + totals.buckets['90+']);
  // needs-review = leakage + no_contract + unknown (never absorbed/umbrella).
  // Without a basis map nothing is proven by-design, so all billable hours need review.
  totals.needsReviewHours = byBasis
    ? round2((Object.keys(byBasis) as ContractBasis[]).filter((b) => REVIEW_BASES.has(b)).reduce((s, b) => s + byBasis[b].billableHours, 0))
    : totals.billableHours;
  return { asOf: asOf.toISOString(), totals, byResource, ...(byBasis ? { byContractBasis: byBasis } : {}) };
}
