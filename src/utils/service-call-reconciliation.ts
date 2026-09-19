// Service-call billing reconciliation (weekly leakage sweep).
//
// Motivated by a live case (ticket 200510): a service call whose onsite work was
// done and whose techs logged time, but which was never marked complete — so a
// later ticket owner change cascaded into the still-open call and wiped its
// resource assignment, orphaning it. The parts on the ticket were also never
// pulled from inventory. This module detects that class of leakage from already-
// fetched data — pure/HTTP-free so the rules are unit-testable.
//
// Live picklists (verified 2026-09-18):
//   TicketCharges.status: 1 Pending · 2 Waiting Approval · 3 Need to Order/Fulfill
//                         · 4 On Order · 6 Ready to Deliver/Ship · 7 Delivered/Shipped
//                         Full · 8 Canceled
//   ServiceCalls.status : 1 New · 2 Complete · 101/102 Canceled

/** Charge statuses that mean "not pulled from inventory / not fulfilled yet". */
export const UNFULFILLED_CHARGE_STATUSES = new Set<number>([3]); // Need to Order/Fulfill
export const CANCELED_CHARGE_STATUS = 8;

export interface SCTimeEntry {
  resourceID?: number;
  dateWorked?: string;
  hoursWorked?: number;
  hoursToBill?: number;
  isNonBillable?: boolean;
  billingApprovalDateTime?: string | null;
}

export interface SCCharge {
  id?: number;
  name?: string;
  status?: number;
  unitQuantity?: number;
  unitPrice?: number;
  billableToAccount?: boolean;
}

export interface SCHistoryRow {
  date?: string;
  action?: string;
  detail?: string;
}

export interface SCReconInput {
  serviceCall: { id: number; isComplete?: number | boolean; status?: number; startDateTime?: string; endDateTime?: string };
  ticketId: number;
  ticketNumber?: string;
  timeEntries: SCTimeEntry[];
  charges: SCCharge[];
  history?: SCHistoryRow[];
  now?: Date;
}

export interface SCReconResult {
  serviceCallId: number;
  ticketId: number;
  ticketNumber: string | undefined;
  isComplete: boolean;
  window: { start: string | null; end: string | null; inPast: boolean };
  hoursInWindow: number;
  timeEntriesInWindow: number;
  recoveredAssignees: string[];
  flags: {
    doneNotClosed: boolean;
    noTimeLogged: boolean;
    unfulfilledParts: { count: number; value: number; items: Array<{ id?: number | undefined; name?: string | undefined; qty: number; value: number }> };
    unbilledTime: { count: number; hours: number };
  };
  issues: string[];
  /** Parts value not yet pulled/billed (labor is reported as hours, rate unknown). */
  atRiskPartsValue: number;
}

const DAY = (d?: string | null): number | null => {
  if (!d) return null;
  const ms = Date.parse(d);
  if (Number.isNaN(ms)) return null;
  // Normalize to a UTC day so a datetime window and a date-only dateWorked compare.
  return Math.floor(ms / 86_400_000);
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

const NULLISH_NAME = /^\[(none selected|blank|none)\]$/i;
function cleanName(s: string | undefined): string | null {
  const t = (s ?? '').trim();
  return t === '' || NULLISH_NAME.test(t) ? null : t;
}

/**
 * Best-effort reconstruction of who was assigned to the ticket AS OF `asOf`, from
 * TicketHistory Primary/Secondary Resource change rows — so a still-open call
 * whose assignment was later cleared can still report the techs who did the work.
 * Name strings only (history records names, not ids); enrichment, not a verdict.
 */
export function recoverAssignees(history: SCHistoryRow[] | undefined, asOf: number | null): string[] {
  if (!history?.length) return [];
  const rows = [...history]
    .filter((h) => h.detail && (/(primary|secondary) resource/i.test(h.action ?? '') || /resource/i.test(h.detail ?? '')))
    .sort((a, b) => (Date.parse(a.date ?? '') || 0) - (Date.parse(b.date ?? '') || 0));
  let primary: string | null = null;
  const secondary = new Set<string>();
  for (const r of rows) {
    if (asOf != null) { const d = DAY(r.date); if (d != null && d > asOf) continue; }
    const action = (r.action ?? '').toLowerCase();
    const m = /changed from (.+?) to (.+?)\.?$/i.exec(r.detail ?? '');
    const from = cleanName(m?.[1]);
    const to = cleanName(m?.[2]);
    if (action.includes('primary resource') && !action.includes('role')) {
      primary = to;
    } else if (action.includes('secondary resource')) {
      if (action.includes('added')) { if (to) secondary.add(to); }
      else if (action.includes('removed')) { if (from) secondary.delete(from); }
      else { secondary.clear(); if (to) for (const n of to.split(/,\s*/)) { const c = cleanName(n); if (c) secondary.add(c); } }
    }
  }
  return [...(primary ? [primary] : []), ...secondary];
}

/** Reconcile one service call against its ticket's time entries, charges and history. */
export function reconcileServiceCall(input: SCReconInput): SCReconResult {
  const now = input.now ?? new Date();
  const nowDay = Math.floor(now.getTime() / 86_400_000);
  const sc = input.serviceCall;
  const isComplete = sc.isComplete === true || sc.isComplete === 1 || sc.status === 2;

  const startDay = DAY(sc.startDateTime);
  const endDay = DAY(sc.endDateTime) ?? startDay;
  const inPast = endDay != null && endDay < nowDay;

  // Time logged within the scheduled window (day granularity).
  let hoursInWindow = 0;
  let entriesInWindow = 0;
  for (const te of input.timeEntries) {
    const d = DAY(te.dateWorked);
    if (d == null || startDay == null || endDay == null) continue;
    if (d >= startDay && d <= endDay) { hoursInWindow += te.hoursWorked ?? 0; entriesInWindow++; }
  }
  hoursInWindow = round2(hoursInWindow);

  // Unfulfilled parts: charges still "Need to Order/Fulfill".
  const unfItems = input.charges
    .filter((c) => c.status != null && UNFULFILLED_CHARGE_STATUSES.has(c.status))
    .map((c) => ({ id: c.id, name: c.name, qty: c.unitQuantity ?? 0, value: round2((c.unitQuantity ?? 0) * (c.unitPrice ?? 0)) }));
  const unfValue = round2(unfItems.reduce((s, i) => s + i.value, 0));

  // Unbilled/unapproved billable time on the ticket (any date).
  const unbilled = input.timeEntries.filter((te) => te.isNonBillable !== true && !te.billingApprovalDateTime);
  const unbilledHours = round2(unbilled.reduce((s, te) => s + (te.hoursToBill ?? te.hoursWorked ?? 0), 0));

  const flags = {
    doneNotClosed: !isComplete && inPast && hoursInWindow > 0,
    noTimeLogged: !isComplete && inPast && hoursInWindow === 0,
    unfulfilledParts: { count: unfItems.length, value: unfValue, items: unfItems },
    unbilledTime: { count: unbilled.length, hours: unbilledHours },
  };

  const issues: string[] = [];
  if (flags.doneNotClosed) issues.push('done_not_closed');
  if (flags.noTimeLogged) issues.push('no_time_logged');
  if (flags.unfulfilledParts.count > 0) issues.push('parts_unfulfilled');
  if (flags.unbilledTime.count > 0) issues.push('unbilled_time');

  return {
    serviceCallId: sc.id,
    ticketId: input.ticketId,
    ticketNumber: input.ticketNumber,
    isComplete,
    window: { start: sc.startDateTime ?? null, end: sc.endDateTime ?? null, inPast },
    hoursInWindow,
    timeEntriesInWindow: entriesInWindow,
    recoveredAssignees: recoverAssignees(input.history, endDay),
    flags,
    issues,
    atRiskPartsValue: unfValue,
  };
}
