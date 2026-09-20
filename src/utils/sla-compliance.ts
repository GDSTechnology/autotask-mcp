// SLA compliance reporting (#100) — the service-delivery KPI at the core of the
// framework. Autotask tracks three SLA stages on a ticket, each with a DUE and
// an ACTUAL timestamp:
//   Triage / First Response  → firstResponseDueDateTime  / firstResponseDateTime
//   Tech Engagement / Plan   → resolutionPlanDueDateTime / resolutionPlanDateTime
//   Resolved / Completed     → resolvedDueDateTime       / resolvedDateTime
//
// Per stage we classify: met (actual ≤ due), missed (actual > due), pending
// (no actual yet, due in the future), breached (no actual yet, due in the past),
// no_target (no due set = SLA not configured for that stage). The "next SLA event
// due" is the earliest still-open (pending/breached) stage — the "what needs
// attention next" signal. Pure/HTTP-free; the service fetches tickets + fields.

import { bucketKey } from './project-pl.js';

export type SlaStageStatus = 'met' | 'missed' | 'pending' | 'breached' | 'no_target';
export type SlaStage = 'triage' | 'engagement' | 'resolved';

export interface StageEval {
  status: SlaStageStatus;
  due: string | null;
  actual: string | null;
  /** hours until due (pending) — negative not used */
  hoursToDue?: number;
  /** hours overdue (breached) */
  hoursOverdue?: number;
}

export interface TicketSlaEval {
  id: number;
  ticketNumber?: string;
  stages: Record<SlaStage, StageEval>;
  /** earliest still-open SLA target (pending or breached) */
  nextEvent: { stage: SlaStage; due: string; breached: boolean; hoursOverdue?: number; hoursToDue?: number } | null;
  slaMetFlag?: boolean | undefined;
}

export interface StageAgg {
  met: number; missed: number; pending: number; breached: number; noTarget: number;
  total: number;
  /** met / (met + missed) — only closed targets count; null when none closed */
  compliancePct: number | null;
}

/** Actual elapsed-time metrics from createDate → the actual stage timestamps.
 *  These are populated even when SLA due targets are not, so they give real
 *  service metrics regardless of whether SLA automation is configured. */
export interface ResponseMetrics {
  respondedCount: number;
  avgHoursToFirstResponse: number | null;
  medianHoursToFirstResponse: number | null;
  resolvedCount: number;
  avgHoursToResolve: number | null;
  medianHoursToResolve: number | null;
}

export interface SlaComplianceResult {
  ticketsEvaluated: number;
  now: string;
  /** tickets with at least one SLA due target set (0 = SLA automation not configured) */
  targetsConfigured: number;
  stages: Record<SlaStage, StageAgg>;
  /** actual response/resolution times (usable even with no SLA targets configured) */
  responseMetrics: ResponseMetrics;
  /** open + overdue targets, worst first — the breach queue */
  breaches: Array<{ id: number; ticketNumber?: string; stage: SlaStage; due: string; hoursOverdue: number }>;
  groups?: Array<{ key: string; ticketsEvaluated: number; stages: Record<SlaStage, StageAgg> }>;
  truncated?: boolean;
}

const HOUR = 3_600_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

const STAGE_FIELDS: Record<SlaStage, { due: string; actual: string }> = {
  triage: { due: 'firstResponseDueDateTime', actual: 'firstResponseDateTime' },
  engagement: { due: 'resolutionPlanDueDateTime', actual: 'resolutionPlanDateTime' },
  resolved: { due: 'resolvedDueDateTime', actual: 'resolvedDateTime' },
};

function evalStage(due: string | null | undefined, actual: string | null | undefined, nowMs: number): StageEval {
  const d = due ? Date.parse(due) : NaN;
  const a = actual ? Date.parse(actual) : NaN;
  if (Number.isNaN(d)) return { status: 'no_target', due: null, actual: actual ?? null };
  if (!Number.isNaN(a)) return { status: a <= d ? 'met' : 'missed', due: due!, actual: actual! };
  // No actual yet → still open.
  if (nowMs <= d) return { status: 'pending', due: due!, actual: null, hoursToDue: round1((d - nowMs) / HOUR) };
  return { status: 'breached', due: due!, actual: null, hoursOverdue: round1((nowMs - d) / HOUR) };
}

export function evaluateTicketSla(t: Record<string, any>, now: Date): TicketSlaEval {
  const nowMs = now.getTime();
  const stages = {} as Record<SlaStage, StageEval>;
  for (const stage of Object.keys(STAGE_FIELDS) as SlaStage[]) {
    const f = STAGE_FIELDS[stage];
    stages[stage] = evalStage(t[f.due], t[f.actual], nowMs);
  }
  // next open SLA event = earliest due among pending/breached stages
  let nextEvent: TicketSlaEval['nextEvent'] = null;
  for (const stage of Object.keys(stages) as SlaStage[]) {
    const s = stages[stage];
    if ((s.status === 'pending' || s.status === 'breached') && s.due) {
      if (!nextEvent || Date.parse(s.due) < Date.parse(nextEvent.due)) {
        nextEvent = {
          stage, due: s.due, breached: s.status === 'breached',
          ...(s.hoursOverdue !== undefined ? { hoursOverdue: s.hoursOverdue } : {}),
          ...(s.hoursToDue !== undefined ? { hoursToDue: s.hoursToDue } : {}),
        };
      }
    }
  }
  return {
    id: t.id,
    ...(t.ticketNumber !== undefined ? { ticketNumber: t.ticketNumber } : {}),
    stages,
    nextEvent,
    slaMetFlag: typeof t.serviceLevelAgreementHasBeenMet === 'boolean' ? t.serviceLevelAgreementHasBeenMet : undefined,
  };
}

function emptyAgg(): StageAgg { return { met: 0, missed: 0, pending: 0, breached: 0, noTarget: 0, total: 0, compliancePct: null }; }
function tally(agg: Record<SlaStage, StageAgg>, ev: TicketSlaEval): void {
  for (const stage of Object.keys(ev.stages) as SlaStage[]) {
    const a = agg[stage]; const st = ev.stages[stage].status;
    if (st === 'met') a.met++; else if (st === 'missed') a.missed++; else if (st === 'pending') a.pending++;
    else if (st === 'breached') a.breached++; else a.noTarget++;
    a.total++;
  }
}
function finalizeAgg(agg: Record<SlaStage, StageAgg>): void {
  for (const stage of Object.keys(agg) as SlaStage[]) {
    const a = agg[stage]; const closed = a.met + a.missed;
    a.compliancePct = closed > 0 ? Math.round((a.met / closed) * 1000) / 10 : null;
  }
}
function newAggSet(): Record<SlaStage, StageAgg> { return { triage: emptyAgg(), engagement: emptyAgg(), resolved: emptyAgg() }; }

/** Aggregate SLA compliance across tickets, optionally grouped. */
export function computeSlaCompliance(
  tickets: Record<string, any>[],
  now: Date,
  opts: { groupBy?: 'queue' | 'resource' | 'company' | 'week' | 'month' } = {},
): SlaComplianceResult {
  const overall = newAggSet();
  const breaches: SlaComplianceResult['breaches'] = [];
  const groupMap = new Map<string, { tickets: number; agg: Record<SlaStage, StageAgg> }>();
  const respHours: number[] = [];
  const resolveHours: number[] = [];
  let targetsConfigured = 0;
  const elapsed = (fromISO: string | null | undefined, toISO: string | null | undefined): number | null => {
    if (!fromISO || !toISO) return null;
    const a = Date.parse(fromISO), b = Date.parse(toISO);
    return Number.isNaN(a) || Number.isNaN(b) || b < a ? null : (b - a) / HOUR;
  };

  const keyFor = (t: Record<string, any>): string => {
    switch (opts.groupBy) {
      case 'queue': return t.queueID != null ? `queue:${t.queueID}` : 'queue:none';
      case 'resource': return t.assignedResourceID != null ? `resource:${t.assignedResourceID}` : 'resource:unassigned';
      case 'company': return t.companyID != null ? `company:${t.companyID}` : 'company:none';
      case 'week': case 'month': return bucketKey(t.createDate, opts.groupBy) ?? 'unknown';
      default: return '';
    }
  };

  for (const t of tickets) {
    const ev = evaluateTicketSla(t, now);
    tally(overall, ev);
    if (t.firstResponseDueDateTime || t.resolutionPlanDueDateTime || t.resolvedDueDateTime) targetsConfigured++;
    const rr = elapsed(t.createDate, t.firstResponseDateTime);
    if (rr != null) respHours.push(rr);
    const rs = elapsed(t.createDate, t.resolvedDateTime);
    if (rs != null) resolveHours.push(rs);
    for (const stage of Object.keys(ev.stages) as SlaStage[]) {
      const s = ev.stages[stage];
      if (s.status === 'breached' && s.due) breaches.push({ id: ev.id, ...(ev.ticketNumber ? { ticketNumber: ev.ticketNumber } : {}), stage, due: s.due, hoursOverdue: s.hoursOverdue ?? 0 });
    }
    if (opts.groupBy) {
      const k = keyFor(t);
      let g = groupMap.get(k);
      if (!g) { g = { tickets: 0, agg: newAggSet() }; groupMap.set(k, g); }
      g.tickets++; tally(g.agg, ev);
    }
  }
  finalizeAgg(overall);
  breaches.sort((a, b) => b.hoursOverdue - a.hoursOverdue);
  const groups = opts.groupBy
    ? [...groupMap.entries()].map(([key, g]) => { finalizeAgg(g.agg); return { key, ticketsEvaluated: g.tickets, stages: g.agg }; }).sort((a, b) => a.key.localeCompare(b.key))
    : undefined;

  const avg = (xs: number[]): number | null => xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : null;
  const median = (xs: number[]): number | null => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2);
    return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 10) / 10;
  };
  const responseMetrics: ResponseMetrics = {
    respondedCount: respHours.length,
    avgHoursToFirstResponse: avg(respHours),
    medianHoursToFirstResponse: median(respHours),
    resolvedCount: resolveHours.length,
    avgHoursToResolve: avg(resolveHours),
    medianHoursToResolve: median(resolveHours),
  };

  return {
    ticketsEvaluated: tickets.length,
    now: now.toISOString(),
    targetsConfigured,
    stages: overall,
    responseMetrics,
    breaches,
    ...(groups ? { groups } : {}),
  };
}
