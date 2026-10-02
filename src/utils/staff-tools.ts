// Staff high-level tools (#21 §9): start_work_on_ticket, add_ticket_update and
// the my_day gaps. Pure helpers — picklist-by-label resolution, note
// visibility, duplicate-note detection and "service call with no time" gaps —
// so the service methods stay thin and these rules are unit-tested directly.
//
// Ticket status, note type and note publish are tenant picklists. Values are
// resolved by LABEL from entityInformation (cached), never hard-coded, and an
// unknown label returns the active choices so nothing is written on a guess.

import type { PicklistValue } from '../services/picklist.cache';

export interface PicklistChoice { value: number; label: string }

export type PicklistMatch =
  | { ok: true; value: number; label: string }
  | { ok: false; requested: string | number; choices: PicklistChoice[] };

/** Active picklist values as numeric {value,label}. */
export function activeChoices(values: PicklistValue[] | undefined): PicklistChoice[] {
  return (values ?? [])
    .filter((v) => v.isActive !== false)
    .map((v) => ({ value: Number(v.value), label: v.label }))
    .filter((v) => Number.isFinite(v.value));
}

/**
 * Match a requested value (id, or label case-insensitively) against a picklist.
 * An exact label wins; otherwise a UNIQUE label containing the text ("progress"
 * → "In Progress"). Ambiguous or unknown → the choices, so the caller can pick.
 */
export function matchPicklist(values: PicklistValue[] | undefined, requested: string | number): PicklistMatch {
  const choices = activeChoices(values);
  if (typeof requested === 'number' || /^\d+$/.test(String(requested).trim())) {
    const n = Number(requested);
    const hit = choices.find((c) => c.value === n);
    return hit ? { ok: true, ...hit } : { ok: false, requested, choices };
  }
  const want = String(requested).trim().toLowerCase();
  const exact = choices.filter((c) => c.label.toLowerCase() === want);
  if (exact.length === 1) return { ok: true, ...exact[0]! };
  const partial = choices.filter((c) => c.label.toLowerCase().includes(want));
  if (partial.length === 1) return { ok: true, ...partial[0]! };
  return { ok: false, requested, choices };
}

export const formatChoices = (choices: PicklistChoice[]): string =>
  choices.map((c) => `${c.value} = ${c.label}`).join('; ');

/**
 * Note visibility → the TicketNotes `publish` label to look up. INTERNAL is
 * the default: a client-visible note is opt-in, never a fallback.
 *   internal    "Internal Project Team"  (internal users only)
 *   client      "All Autotask Users"     (also shown to the client portal)
 *   co-managed  "Internal & Co-Managed"
 */
export type NoteVisibility = 'internal' | 'client' | 'co-managed';
export const PUBLISH_LABELS: Record<NoteVisibility, string> = {
  internal: 'Internal Project Team',
  client: 'All Autotask Users',
  'co-managed': 'Internal & Co-Managed',
};

/** noteType for a human update — "Task Summary" (1); 2 "Task Detail" is automation. */
export const HUMAN_NOTE_TYPE_LABEL = 'Task Summary';

const norm = (s: unknown): string => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * An existing note that is the SAME update (same text, and same title when
 * both have one) posted within `windowMs` — a rerun of add_ticket_update
 * returns it instead of posting twice. Text equality, not a hidden marker:
 * a marker in the body would be visible to the client on a client note.
 */
export function findDuplicateNote<T extends { id?: number; title?: string; description?: string; createDateTime?: string }>(
  notes: T[], title: string | undefined, description: string, now: Date, windowMs = 24 * 3600_000,
): T | undefined {
  const want = norm(description);
  if (!want) return undefined;
  return notes.find((n) => {
    if (norm(n.description) !== want) return false;
    if (title && n.title && norm(n.title) !== norm(title)) return false;
    const at = n.createDateTime ? Date.parse(n.createDateTime) : NaN;
    return Number.isNaN(at) || now.getTime() - at <= windowMs;
  });
}

/** The ServiceCalls columns my_day reads. */
export interface ServiceCallRow {
  id: number;
  startDateTime?: string;
  endDateTime?: string;
  isComplete?: boolean | number;
  canceledDateTime?: string | null;
}

export type StartWorkStatus =
  | 'started' | 'already_started' | 'dry_run'
  | 'not_found' | 'ticket_complete' | 'invalid_status' | 'assigned_to_other' | 'role_required';

/** Result of start_work_on_ticket — `status` says what happened (only `started` wrote). */
export interface StartWorkResult {
  status: StartWorkStatus;
  ticketID: number;
  ticketNumber?: string | undefined;
  title?: string | undefined;
  message?: string;
  requested?: string | number;
  choices?: PicklistChoice[];
  assignedResourceID?: number;
  assignedResourceName?: string | null;
  assignment?: 'already_yours' | 'assigned_to_you' | 'taken_over';
  statusLabel?: string;
  startedAt?: string;
  previousStatus?: number;
  previousAssignedResourceID?: number | null;
  changes?: Record<string, unknown>;
  plannedChanges?: Record<string, unknown>;
}

/** UTC bounds of a YYYY-MM-DD day, as Autotask datetime filter values. */
export function utcDayBounds(day: string): { start: string; end: string } {
  return { start: `${day}T00:00:00Z`, end: `${day}T23:59:59Z` };
}

/** my_day shows open To-Dos starting in this many days up to (and including) the day. */
export const TODO_WINDOW_DAYS = 7;

/** UTC start of the day `days - 1` days before `day` (a `days`-long window ending on `day`). */
export function windowStart(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (days - 1));
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface MyServiceCall {
  serviceCallID: number;
  startDateTime?: string | undefined;
  endDateTime?: string | undefined;
  durationHours: number | null;
  isComplete: boolean;
  ticketIDs: number[];
}

export interface TimeGap {
  ticketID: number;
  /** Every service call that day that put this ticket on the resource. */
  serviceCallIDs: number[];
  /** Earliest start / latest end across those calls. */
  startDateTime?: string;
  endDateTime?: string;
  /** Sum of the calls' scheduled hours (null when none had both times). */
  scheduledHours: number | null;
  reason: 'service_call_without_time';
}

/** Hours between two ISO datetimes (null if either is missing/invalid). */
export function hoursBetween(start?: string, end?: string): number | null {
  if (!start || !end) return null;
  const ms = Date.parse(end) - Date.parse(start);
  return Number.isFinite(ms) && ms > 0 ? Math.round((ms / 3600_000) * 100) / 100 : null;
}

/**
 * Service-call tickets the resource worked today with NO time logged against
 * that ticket today — the "missing time" the end-of-day backfill should fill.
 * One gap PER TICKET: a ticket on two calls that day (a live case) is one
 * missing entry, with both calls listed and their hours summed. Cancelled
 * calls (canceledDateTime set) are not gaps.
 */
export function serviceCallTimeGaps(
  calls: Array<MyServiceCall & { canceled?: boolean }>,
  ticketTime: Array<{ ticketID?: number | null }>,
): TimeGap[] {
  const logged = new Set(ticketTime.map((e) => Number(e.ticketID)).filter(Number.isFinite));
  const byTicket = new Map<number, TimeGap>();
  for (const c of calls) {
    if (c.canceled) continue;
    for (const ticketID of c.ticketIDs) {
      if (logged.has(ticketID)) continue;
      const g = byTicket.get(ticketID) ?? { ticketID, serviceCallIDs: [], scheduledHours: null, reason: 'service_call_without_time' as const };
      g.serviceCallIDs.push(c.serviceCallID);
      if (c.startDateTime && (!g.startDateTime || c.startDateTime < g.startDateTime)) g.startDateTime = c.startDateTime;
      if (c.endDateTime && (!g.endDateTime || c.endDateTime > g.endDateTime)) g.endDateTime = c.endDateTime;
      if (c.durationHours != null) g.scheduledHours = Math.round(((g.scheduledHours ?? 0) + c.durationHours) * 100) / 100;
      byTicket.set(ticketID, g);
    }
  }
  return [...byTicket.values()];
}
