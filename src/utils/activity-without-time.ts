// Activity without time (billable-time leakage audit). Pure computation.
//
// Answers "where did this tech do work in Autotask but log no time?" — the
// Autotask side of the GDS leakage audit (external evidence — Teams, email,
// meetings, phone — is matched by the caller). Per resource × local day, a GAP
// is a ticket with evidence of the tech's work and no time entry by them on it
// that day (or within toleranceDays either side — a common "logged on the next
// day" pattern, reported as covered, not a gap).
//
// Evidence, graded by how strongly it implies unlogged work — calibrated on a
// live week (2026-09-22..29): one tech had 137 human-type notes but 123 were
// the bare "Closed" resolution note Autotask requires on close; 119 of 135
// closes were same-day tickets, some real jobs, some monitoring alerts.
//   high    a substantive note the tech wrote (not a bare close word)
//   medium  a ticket the tech completed (monitoring-alert tickets excluded by
//           default — auto-generated, often closed with no billable work)
//   support bare close notes and notification e-mails the tech sent: attached
//           to a gap as context, never enough to create one on their own.
// Autotask/integration bookkeeping notes are dropped (see ticket-note-kind).

import { isSystemTicketNote } from './ticket-note-kind.js';

export type GapConfidence = 'high' | 'medium';

export interface AwtNote { ticketID?: number | null; noteType?: number | null; title?: string | null; description?: string | null; createDateTime?: string | null; creatorResourceID?: number | null }
export interface AwtCompletion { id: number; completedDate?: string | null }
export interface AwtEmail { ticketID?: number | null; timeEntryID?: number | null; notificationSentTime?: string | null; templateName?: string | null; recipientEmailAddress?: string | null }
export interface AwtTimeEntry { ticketID?: number | null; dateWorked?: string | null; hoursWorked?: number | null }
export interface AwtTicket {
  id: number; ticketNumber?: string; title?: string; companyName?: string | null; ticketUrl?: string | null;
  /** Auto-generated alert ticket (monitoring/RMM source, Alert type/category/queue). */
  isMonitoring?: boolean;
  /** On the tenant's own company (companyID 0) — internal, not client-billable. */
  isInternal?: boolean;
  createDate?: string | null;
}

export interface AwtEvidence {
  kind: 'note' | 'close_note' | 'completed' | 'email';
  at: string;
  text: string;
}

export interface AwtGap {
  ticketID: number;
  ticketNumber?: string;
  title?: string;
  company?: string | null;
  ticketUrl?: string | null;
  day: string;
  confidence: GapConfidence;
  evidence: AwtEvidence[];
  /** Time this tech logged on the ticket on OTHER days in the window (context). */
  otherTime: { hours: number; days: string[] };
}

export interface AwtResourceResult {
  resourceID: number;
  resourceName?: string;
  timeZone: string;
  gaps: AwtGap[];
  counts: { high: number; medium: number; ticketsWithEvidence: number; coveredByTime: number; coveredByNearbyTime: number };
  /** Evidence left out as not-billable-work, by reason — counted, never silent. */
  excluded: { internal: number; monitoring: number; junk: number; backlogCleanup: number };
  hoursLogged: number;
}

export interface AwtOptions {
  timeZone: string;
  /** Local-day window (YYYY-MM-DD, inclusive). Evidence outside it is ignored. */
  from?: string;
  to?: string;
  toleranceDays?: number;
  minConfidence?: GapConfidence;
  includeMonitoring?: boolean;
  /** Also flag tickets on the tenant's own company (default false). */
  includeInternal?: boolean;
  /** A ticket this many days old, closed with no substantive note, is backlog cleanup (default 30). */
  staleDays?: number;
}

const CLOSE_WORDS = /^(closed?|clsoed|complete[d]?|resolved|done|fixed|finished|cancel+ed|n\/?a)[.!]*$/i;
const SUBSTANTIVE_MIN = 25;
/** "Closed - no further action", "Resolved: user confirmed" — a close-out, not a work log. */
const CLOSE_WITH_REASON = /^(closed?|clsoed|complete[d]?|resolved|done|cancel+ed)\b\s*[-:–—.,;]/i;
/** Tickets created by mail loops, not customers. */
const JUNK_TITLE = /^(re:\s*|fw:\s*)?(automatic reply|auto[- ]?reply|out of (the )?office|undeliverable|delivery status notification|mail delivery (failed|subsystem)|read:)/i;

/** YYYY-MM-DD of an instant in a timezone. */
export function localDay(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function oneLine(s: unknown, max = 140): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A human note that records real work, vs the bare "Closed" note a close requires. */
export function isSubstantiveNote(n: AwtNote): boolean {
  const body = String(n.description ?? '').trim();
  if (!body || CLOSE_WORDS.test(body) || CLOSE_WITH_REASON.test(body)) return false;
  // An auto-reply mailed into the ticket under the tech's name isn't work.
  if (JUNK_TITLE.test(body) || JUNK_TITLE.test(String(n.title ?? '').trim())) return false;
  return body.length >= SUBSTANTIVE_MIN || !CLOSE_WORDS.test(String(n.title ?? '').trim());
}

export function computeActivityWithoutTime(
  resourceID: number,
  input: { notes: AwtNote[]; completions: AwtCompletion[]; emails: AwtEmail[]; timeEntries: AwtTimeEntry[]; tickets: Map<number, AwtTicket> },
  opts: AwtOptions,
  resourceName?: string,
): AwtResourceResult {
  const tz = opts.timeZone;
  const tolerance = Math.max(0, opts.toleranceDays ?? 1);
  const minConf = opts.minConfidence ?? 'medium';

  // Evidence keyed by ticket|day.
  const byKey = new Map<string, { ticketID: number; day: string; ev: AwtEvidence[] }>();
  const add = (ticketID: number | null | undefined, at: string | null | undefined, e: Omit<AwtEvidence, 'at'>) => {
    if (ticketID == null || !at) return;
    const day = localDay(at, tz);
    const key = `${ticketID}|${day}`;
    const slot = byKey.get(key) ?? { ticketID: Number(ticketID), day, ev: [] };
    slot.ev.push({ ...e, at });
    byKey.set(key, slot);
  };
  for (const n of input.notes) {
    if (isSystemTicketNote(n)) continue;
    const substantive = isSubstantiveNote(n);
    const text = oneLine(n.title && !/^\[external\]/i.test(String(n.title)) && !CLOSE_WORDS.test(String(n.title).trim()) ? `${n.title}: ${n.description ?? ''}` : n.description);
    add(n.ticketID, n.createDateTime, { kind: substantive ? 'note' : 'close_note', text: text || '(empty note)' });
  }
  for (const c of input.completions) add(c.id, c.completedDate, { kind: 'completed', text: 'Ticket completed' });
  for (const m of input.emails) {
    if (m.timeEntryID != null) continue; // sent from a time entry → that time exists
    add(m.ticketID, m.notificationSentTime, { kind: 'email', text: oneLine(`${m.templateName ?? 'Notification'} → ${m.recipientEmailAddress ?? ''}`) });
  }

  // Time by ticket → set of days + hours per day.
  const timeDays = new Map<number, Map<string, number>>();
  let hoursLogged = 0;
  for (const t of input.timeEntries) {
    const h = Number(t.hoursWorked) || 0;
    hoursLogged += h;
    if (t.ticketID == null || !t.dateWorked) continue;
    const day = String(t.dateWorked).slice(0, 10);
    const m = timeDays.get(Number(t.ticketID)) ?? new Map<string, number>();
    m.set(day, (m.get(day) ?? 0) + h);
    timeDays.set(Number(t.ticketID), m);
  }

  const counts = { high: 0, medium: 0, ticketsWithEvidence: 0, coveredByTime: 0, coveredByNearbyTime: 0 };
  const excluded = { internal: 0, monitoring: 0, junk: 0, backlogCleanup: 0 };
  const staleMs = Math.max(1, opts.staleDays ?? 30) * 86_400_000;
  const evidenceTickets = new Set<number>();
  const gaps: AwtGap[] = [];
  for (const slot of byKey.values()) {
    if ((opts.from && slot.day < opts.from) || (opts.to && slot.day > opts.to)) continue;
    const hasNote = slot.ev.some((e) => e.kind === 'note');
    const hasClose = slot.ev.some((e) => e.kind === 'completed');
    if (!hasNote && !hasClose) continue; // support-only evidence never makes a gap
    evidenceTickets.add(slot.ticketID);
    const days = timeDays.get(slot.ticketID);
    if (days?.has(slot.day)) { counts.coveredByTime++; continue; }
    let nearby = false;
    for (let d = 1; d <= tolerance && !nearby; d++) nearby = !!(days?.has(addDays(slot.day, d)) || days?.has(addDays(slot.day, -d)));
    if (nearby) { counts.coveredByNearbyTime++; continue; }
    const ticket = input.tickets.get(slot.ticketID);
    const confidence: GapConfidence = hasNote ? 'high' : 'medium';
    if (ticket?.isInternal && !opts.includeInternal) { excluded.internal++; continue; }
    if (ticket?.title && JUNK_TITLE.test(ticket.title)) { excluded.junk++; continue; }
    if (confidence === 'medium' && ticket?.isMonitoring && !opts.includeMonitoring) { excluded.monitoring++; continue; }
    if (confidence === 'medium' && ticket?.createDate) {
      const closedAt = slot.ev.find((e) => e.kind === 'completed')?.at;
      if (closedAt && Date.parse(closedAt) - Date.parse(ticket.createDate) > staleMs) { excluded.backlogCleanup++; continue; }
    }
    if (minConf === 'high' && confidence !== 'high') continue;
    counts[confidence]++;
    const other = [...(days?.entries() ?? [])];
    gaps.push({
      ticketID: slot.ticketID,
      ...(ticket?.ticketNumber ? { ticketNumber: ticket.ticketNumber } : {}),
      ...(ticket?.title ? { title: ticket.title } : {}),
      ...(ticket?.companyName !== undefined ? { company: ticket.companyName } : {}),
      ...(ticket?.ticketUrl ? { ticketUrl: ticket.ticketUrl } : {}),
      day: slot.day,
      confidence,
      evidence: slot.ev.sort((a, b) => a.at.localeCompare(b.at)),
      otherTime: { hours: Math.round(other.reduce((s, [, h]) => s + h, 0) * 100) / 100, days: other.map(([d]) => d).sort() },
    });
  }
  counts.ticketsWithEvidence = evidenceTickets.size;
  gaps.sort((a, b) => (a.confidence === b.confidence ? a.day.localeCompare(b.day) || a.ticketID - b.ticketID : a.confidence === 'high' ? -1 : 1));
  return {
    resourceID,
    ...(resourceName ? { resourceName } : {}),
    timeZone: tz,
    gaps,
    counts,
    excluded,
    hoursLogged: Math.round(hoursLogged * 100) / 100,
  };
}
