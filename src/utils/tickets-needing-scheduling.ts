// Tickets needing scheduling (#100). Pure aggregation.
//
// Open work that should be on the calendar but isn't: tickets with hours left to
// schedule (or an install/project type) that have NO usable Service Call. Extends
// the service-call reconciliation in #90 — that fixes leakage on tickets that DID
// have a service call; this catches the ones that never got one.
//
// Per candidate ticket we classify:
//   unscheduled       — no service call linked at all
//   past_service_call — has service call(s), but all start in the past (stale;
//                       likely needs rescheduling — the work isn't on the future
//                       calendar)
//   scheduled         — has a service call starting now/in the future (excluded
//                       from the "needs" list, still counted)
// Read-only; the service fetches tickets + service-call links, this computes.

export interface RawTicket {
  id: number;
  ticketNumber?: string | null;
  companyID?: number | null;
  queueID?: number | null;
  ticketType?: number | null;
  priority?: number | null;
  status?: number | null;
  assignedResourceID?: number | null;
  hoursToBeScheduled?: number | null;
  createDate?: string | null;
  dueDateTime?: string | null;
}

export interface ServiceCallLite { id: number; startDateTime?: string | null }

export type ScheduleStatus = 'unscheduled' | 'past_service_call' | 'scheduled';

export interface NeedsSchedulingRow {
  id: number;
  ticketNumber: string | null;
  companyID: number | null;
  queueID: number | null;
  ticketType: number | null;
  priority: number | null;
  assignedResourceID: number | null;
  hoursToBeScheduled: number;
  ageDays: number | null;
  dueDateTime: string | null;
  reason: Exclude<ScheduleStatus, 'scheduled'>;
  lastServiceCallDate: string | null;
}

export interface SchedulingGroup { key: string; count: number; hoursToSchedule: number }

export interface TicketsNeedingSchedulingResult {
  now: string;
  ticketsEvaluated: number;
  counts: { unscheduled: number; pastServiceCall: number; scheduled: number };
  needsScheduling: NeedsSchedulingRow[];
  totalHoursToSchedule: number;
  groups?: SchedulingGroup[] | undefined;
  truncated?: boolean | undefined;
}

const DAY = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

function ageDaysOf(createDate: string | null | undefined, nowMs: number): number | null {
  if (!createDate) return null;
  const c = Date.parse(createDate);
  if (Number.isNaN(c)) return null;
  return Math.max(0, Math.floor((nowMs - c) / DAY));
}

function classify(calls: ServiceCallLite[], nowMs: number): { status: ScheduleStatus; lastStart: string | null } {
  if (calls.length === 0) return { status: 'unscheduled', lastStart: null };
  let hasFuture = false;
  let lastStartMs = -Infinity;
  let lastStart: string | null = null;
  for (const c of calls) {
    if (!c.startDateTime) continue;
    const ms = Date.parse(c.startDateTime);
    if (Number.isNaN(ms)) continue;
    if (ms > nowMs) hasFuture = true;
    if (ms > lastStartMs) { lastStartMs = ms; lastStart = c.startDateTime; }
  }
  if (hasFuture) return { status: 'scheduled', lastStart };
  return { status: 'past_service_call', lastStart };
}

export function computeTicketsNeedingScheduling(
  tickets: RawTicket[],
  serviceCallsByTicket: Map<number, ServiceCallLite[]>,
  now: Date,
  opts: { groupBy?: 'queue' | 'company' | 'resource' | undefined } = {},
): TicketsNeedingSchedulingResult {
  const nowMs = now.getTime();
  const counts = { unscheduled: 0, pastServiceCall: 0, scheduled: 0 };
  const needs: NeedsSchedulingRow[] = [];

  for (const t of tickets) {
    const calls = serviceCallsByTicket.get(t.id) ?? [];
    const { status, lastStart } = classify(calls, nowMs);
    if (status === 'scheduled') { counts.scheduled++; continue; }
    if (status === 'unscheduled') counts.unscheduled++; else counts.pastServiceCall++;
    needs.push({
      id: t.id,
      ticketNumber: t.ticketNumber ?? null,
      companyID: t.companyID ?? null,
      queueID: t.queueID ?? null,
      ticketType: t.ticketType ?? null,
      priority: t.priority ?? null,
      assignedResourceID: t.assignedResourceID ?? null,
      hoursToBeScheduled: Number(t.hoursToBeScheduled) || 0,
      ageDays: ageDaysOf(t.createDate, nowMs),
      dueDateTime: t.dueDateTime ?? null,
      reason: status,
      lastServiceCallDate: lastStart,
    });
  }

  // Worst backlog first: most hours to schedule, then oldest.
  needs.sort((a, b) => (b.hoursToBeScheduled - a.hoursToBeScheduled) || ((b.ageDays ?? 0) - (a.ageDays ?? 0)));

  let groups: SchedulingGroup[] | undefined;
  if (opts.groupBy) {
    const m = new Map<string, SchedulingGroup>();
    const keyOf = (r: NeedsSchedulingRow): string => {
      switch (opts.groupBy) {
        case 'queue': return r.queueID != null ? `queue:${r.queueID}` : 'queue:none';
        case 'company': return r.companyID != null ? `company:${r.companyID}` : 'company:none';
        case 'resource': return r.assignedResourceID != null ? `resource:${r.assignedResourceID}` : 'resource:unassigned';
        default: return '';
      }
    };
    for (const r of needs) {
      const k = keyOf(r);
      let g = m.get(k);
      if (!g) { g = { key: k, count: 0, hoursToSchedule: 0 }; m.set(k, g); }
      g.count++; g.hoursToSchedule = round1(g.hoursToSchedule + r.hoursToBeScheduled);
    }
    groups = [...m.values()].sort((a, b) => b.hoursToSchedule - a.hoursToSchedule || b.count - a.count);
  }

  return {
    now: now.toISOString(),
    ticketsEvaluated: tickets.length,
    counts,
    needsScheduling: needs,
    totalHoursToSchedule: round1(needs.reduce((s, r) => s + r.hoursToBeScheduled, 0)),
    ...(groups ? { groups } : {}),
  };
}
