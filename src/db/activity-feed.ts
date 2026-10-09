// Incremental activity feed (gap register MCP-002 / MCP-003): ticket field
// changes, ticket notes and time entries as ONE cursor-paged event stream,
// each event with a classified actor (MCP-001).
//
// Two halves:
//   ingest  — brings audit_event up to date from per-source checkpoints:
//             time entries from the shadow (0 calls), ticket notes from a live
//             query by createDateTime (1 call / 500 notes), then ticket
//             history for every ticket changed since the checkpoint (1 call per
//             ticket; a ticket whose history was read after its last change is
//             skipped). Bounded by maxApiCalls; whatever the budget cut off is
//             left for the next call and reported as pending, never dropped.
//   read    — pages audit_event in INGESTION order (audit_event.id is the
//             cursor). A late-arriving event gets a higher id than everything
//             already served, so a reader never skips it; replaying a cursor
//             returns the same event ids (event_key is unique).

import type { AuditLedger } from './audit-ledger.js';
import type { ShadowFilter } from './shadow-sql.js';
import { AuditEvent, historyEvent, noteEvent, timeEntryEvent } from '../utils/audit-events.js';
import { HISTORY_FIELD_PICKLIST } from '../utils/ticket-audit.js';
import { classifyActor, type ClassifyContext } from '../utils/actor-classify.js';

export type FeedSource = 'tickets' | 'ticketNotes' | 'timeEntries';
export const FEED_SOURCES: FeedSource[] = ['tickets', 'ticketNotes', 'timeEntries'];
/** The audit_event entity type each source writes. */
export const SOURCE_ENTITY: Record<FeedSource, 'ticket' | 'ticketNote' | 'timeEntry'> = { tickets: 'ticket', ticketNotes: 'ticketNote', timeEntries: 'timeEntry' };

/** Re-scan this far behind each watermark: catches rows the shadow synced late. Cheap — already-ingested rows cost no calls. */
export const OVERLAP_MS = 15 * 60_000;
/** How far back a feed may reach (older is a bounded backfill job, MCP-006). */
export const MAX_LOOKBACK_DAYS = 90;
/** The shadow must have synced within this long to be used instead of live reads. */
const SHADOW_MAX_AGE_S = 1800;

type Row = Record<string, unknown> & { id: number };

export interface FeedDeps {
  ledger: Pick<AuditLedger, 'insert' | 'historyFetched' | 'markHistoryFetched' | 'feedPage' | 'feedCheckpoints' | 'setFeedCheckpoint' | 'withIngestLock'>;
  /** The shadow store (null when Postgres mirroring is off). */
  store: {
    freshness(entity: string): Promise<{ ready: boolean; ageSeconds: number | null }>;
    query(entity: string, filters: ShadowFilter[], opts: { fields?: string[]; limit?: number; order?: 'id_asc' | 'id_desc' }): Promise<{ rows: Array<Record<string, unknown>> }>;
  } | null;
  http: { query<T>(entity: string, filters: ShadowFilter[], opts: { maxRecords?: number; includeFields?: string[] }): Promise<T[]> };
  service: {
    getFieldInfo(entity: string): Promise<Array<{ name: string; picklistValues?: Array<{ value: string | number; label: string }> }>>;
    getPicklistValues(entity: string, field: string): Promise<Array<{ value: string; label: string }>>;
    getActorContext(): Promise<ClassifyContext>;
  };
  now?: () => Date;
}

export interface SourceReport {
  read: 'shadow' | 'live' | 'skipped';
  watermark: string | null;
  coveredFrom: string | null;
  ingested: number;
  /** tickets only: candidates checked / histories read / served from the cache / left for the next call */
  checked?: number; historyFetched?: number; fromCache?: number; pending?: number;
}

export interface IngestReport {
  ran: boolean;
  apiCallsUsed: number;
  sources: Partial<Record<FeedSource, SourceReport>>;
  incomplete: string[];
}

const ms = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v) return null;
  const t = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}Z`).getTime();
  return Number.isNaN(t) ? null : t;
};
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/** Clamp a requested start to the allowed lookback. */
export function clampSince(since: Date, now: Date): Date {
  const floor = new Date(now.getTime() - MAX_LOOKBACK_DAYS * 86_400_000);
  return since < floor ? floor : since;
}

/** Bring audit_event up to date for the given sources. Never throws for a source failure — it is reported. */
export async function ingestActivity(deps: FeedDeps, o: { since: Date; sources: FeedSource[]; maxApiCalls: number; backfill?: boolean; timeZone: string }): Promise<IngestReport> {
  const now = deps.now?.() ?? new Date();
  const report: IngestReport = { ran: false, apiCallsUsed: 0, sources: {}, incomplete: [] };
  const budget = Math.min(Math.max(Math.floor(o.maxApiCalls), 0), 500);
  const out = await deps.ledger.withIngestLock(async () => {
    report.ran = true;
    const cps = await deps.ledger.feedCheckpoints();
    const since = clampSince(o.since, now);
    // Start point per source: its checkpoint, or the requested start the first time (or on backfill).
    const start = (s: FeedSource) => {
      const cp = cps.get(s);
      if (!cp || (o.backfill && since < cp.coveredFrom)) return { wm: since, coveredFrom: since };
      return { wm: cp.watermark, coveredFrom: cp.coveredFrom };
    };
    const tickets = new Map<number, { id: number; ticketNumber?: string | null; companyID?: number | null }>();

    const live = async <T extends Row>(entity: string, filter: ShadowFilter[], max: number, fields?: string[]): Promise<T[]> => {
      if (report.apiCallsUsed >= budget) throw new Error('budget');
      const rows = await deps.http.query<T>(entity, filter, { maxRecords: max, ...(fields ? { includeFields: fields } : {}) });
      report.apiCallsUsed += Math.max(1, Math.ceil(rows.length / 500));
      return rows;
    };
    const shadowFresh = async (entity: string) => {
      if (!deps.store) return false;
      try { const f = await deps.store.freshness(entity); return f.ready && f.ageSeconds != null && f.ageSeconds <= SHADOW_MAX_AGE_S; } catch { return false; }
    };
    /** Every row matching `filter`, walked by id: from the shadow when fresh (0 calls), else live (budgeted). */
    const walk = async (entity: string, filter: ShadowFilter[], fields: string[]): Promise<{ rows: Row[]; read: 'shadow' | 'live'; complete: boolean }> => {
      const rows: Row[] = [];
      let lastId = 0;
      if (await shadowFresh(entity)) {
        for (;;) {
          const r = await deps.store!.query(entity, [...filter, { op: 'gt', field: 'id', value: lastId }], { fields, limit: 5000, order: 'id_asc' });
          rows.push(...(r.rows as Row[]));
          if (r.rows.length < 5000) return { rows, read: 'shadow', complete: true };
          lastId = Number(r.rows[r.rows.length - 1]!.id);
        }
      }
      for (;;) {
        let page: Row[];
        try { page = await live<Row>(entity, [...filter, { op: 'gt', field: 'id', value: lastId }], 500, fields); } catch (e) {
          if (e instanceof Error && e.message === 'budget') return { rows, read: 'live', complete: false };
          throw e;
        }
        rows.push(...page);
        if (page.length < 500) return { rows, read: 'live', complete: true };
        lastId = Number(page[page.length - 1]!.id);
      }
    };
    /** Ticket number / company for parents not yet known (shadow first). */
    const ensureTickets = async (ids: number[]) => {
      const missing = [...new Set(ids)].filter((id) => !tickets.has(id));
      for (let i = 0; i < missing.length; i += 500) {
        const f: ShadowFilter[] = [{ op: 'in', field: 'id', value: missing.slice(i, i + 500) }];
        let rows: Row[] | null = null;
        if (await shadowFresh('Tickets')) rows = (await deps.store!.query('Tickets', f, { fields: ['ticketNumber', 'companyID'], limit: 5000 })).rows as Row[];
        else { try { rows = await live<Row>('Tickets', f, 500, ['id', 'ticketNumber', 'companyID']); } catch { rows = null; } }
        for (const t of rows ?? []) tickets.set(Number(t.id), { id: Number(t.id), ticketNumber: (t.ticketNumber as string) ?? null, companyID: num(t.companyID) });
      }
    };
    const guard = async (s: FeedSource, fn: () => Promise<void>) => {
      try { await fn(); } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        report.sources[s] ??= { read: 'skipped', watermark: null, coveredFrom: null, ingested: 0 };
        report.incomplete.push(msg === 'budget' ? `${s}: API-call budget (${budget}) reached — continues on the next call` : `${s}: ${msg}`);
      }
    };

    // 1. Time entries (shadow: free). Created → one event; edited later → one more per edit seen.
    if (o.sources.includes('timeEntries')) await guard('timeEntries', async () => {
      const { wm, coveredFrom } = start('timeEntries');
      const from = new Date(wm.getTime() - OVERLAP_MS).toISOString();
      const w = await walk('TimeEntries', [{ op: 'gte', field: 'lastModifiedDateTime', value: from }],
        ['id', 'resourceID', 'ticketID', 'taskID', 'dateWorked', 'startDateTime', 'endDateTime', 'hoursWorked', 'hoursToBill', 'isNonBillable', 'roleID', 'billingCodeID', 'internalBillingCodeID', 'contractID', 'summaryNotes', 'createDateTime', 'lastModifiedDateTime', 'creatorUserID', 'lastModifiedUserID', 'billingApprovalDateTime']);
      await ensureTickets(w.rows.map((r) => num(r.ticketID)).filter((x): x is number => x != null));
      const evs: AuditEvent[] = [];
      let max = wm.getTime();
      for (const r of w.rows) {
        const tid = num(r.ticketID), kid = num(r.taskID);
        const t = tid != null ? tickets.get(tid) : undefined;
        const ev = timeEntryEvent(r, { type: tid != null ? 'ticket' : kid != null ? 'task' : null, id: tid ?? kid, reference: t?.ticketNumber ?? null, companyId: t?.companyID ?? null }, o.timeZone);
        if (!ev) continue;
        evs.push(ev);
        const mod = ms(r.lastModifiedDateTime), created = ms(r.createDateTime);
        if (mod != null) max = Math.max(max, mod);
        if (mod != null && created != null && mod - created > 60_000) {
          evs.push({ ...ev, eventId: `te:${r.id}:m:${new Date(mod).toISOString()}`, timestamp: new Date(mod).toISOString(), action: 'update', resourceId: num(r.lastModifiedUserID) ?? ev.resourceId, details: { ...ev.details, edit: true } });
        }
      }
      const ingested = await deps.ledger.insert(evs);
      // Incomplete live walk: hold the watermark (the next call re-walks from it; inserts are idempotent).
      const next = w.complete ? new Date(max) : wm;
      await deps.ledger.setFeedCheckpoint('timeEntries', next, coveredFrom);
      report.sources.timeEntries = { read: w.read, watermark: next.toISOString(), coveredFrom: coveredFrom.toISOString(), ingested };
      if (!w.complete) report.incomplete.push(`timeEntries: API-call budget (${budget}) reached — continues on the next call`);
    });

    // 2. Ticket notes (live by creation, walked by id — ids follow creation order).
    if (o.sources.includes('ticketNotes')) await guard('ticketNotes', async () => {
      const { wm, coveredFrom } = start('ticketNotes');
      const from = new Date(wm.getTime() - OVERLAP_MS).toISOString();
      const w = await walk('TicketNotes', [{ op: 'gte', field: 'createDateTime', value: from }],
        ['id', 'ticketID', 'title', 'description', 'noteType', 'publish', 'creatorResourceID', 'createdByContactID', 'createDateTime']);
      let types: Array<{ value: string; label: string }> = [], pubs: Array<{ value: string; label: string }> = [];
      try { types = await deps.service.getPicklistValues('TicketNotes', 'noteType'); pubs = await deps.service.getPicklistValues('TicketNotes', 'publish'); } catch { /* raw values */ }
      await ensureTickets(w.rows.map((r) => num(r.ticketID)).filter((x): x is number => x != null));
      const evs: AuditEvent[] = [];
      let max = wm.getTime();
      for (const r of w.rows) {
        const pid = num(r.ticketID);
        if (pid == null) continue;
        const t = tickets.get(pid);
        const ev = noteEvent('ticketNote', r, { type: 'ticket', id: pid, reference: t?.ticketNumber ?? null, companyId: t?.companyID ?? null }, {
          noteType: types.find((x) => String(x.value) === String(r.noteType))?.label ?? null,
          publish: pubs.find((x) => String(x.value) === String(r.publish))?.label ?? null,
        });
        if (!ev) continue;
        evs.push(ev);
        const c = ms(r.createDateTime);
        if (c != null) max = Math.max(max, c);
      }
      const ingested = await deps.ledger.insert(evs);
      // Notes walk by id = creation order, so a budget cut still leaves everything up to `max` ingested.
      const next = new Date(max);
      await deps.ledger.setFeedCheckpoint('ticketNotes', next, coveredFrom);
      report.sources.ticketNotes = { read: w.read, watermark: next.toISOString(), coveredFrom: coveredFrom.toISOString(), ingested };
      if (!w.complete) report.incomplete.push(`ticketNotes: API-call budget (${budget}) reached — continues on the next call`);
    });

    // 3. Ticket field changes: history of each ticket changed since the watermark, oldest change first.
    if (o.sources.includes('tickets')) await guard('tickets', async () => {
      const { wm, coveredFrom } = start('tickets');
      const from = new Date(wm.getTime() - OVERLAP_MS).toISOString();
      const w = await walk('Tickets', [{ op: 'gte', field: 'lastTrackedModificationDateTime', value: from }], ['id', 'ticketNumber', 'companyID', 'lastTrackedModificationDateTime']);
      const cand = w.rows
        .map((t) => ({ id: Number(t.id), ticketNumber: (t.ticketNumber as string) ?? null, companyID: num(t.companyID), lastMod: ms(t.lastTrackedModificationDateTime) }))
        .filter((t): t is typeof t & { lastMod: number } => t.lastMod != null)
        .sort((a, b) => a.lastMod - b.lastMod || a.id - b.id);
      for (const t of cand) tickets.set(t.id, t);
      let fields: Awaited<ReturnType<FeedDeps['service']['getFieldInfo']>> = [];
      try { fields = await deps.service.getFieldInfo('Tickets'); } catch { /* parse without label anchors */ }
      const labelsFor = (f: string) => (fields.find((x) => x.name === HISTORY_FIELD_PICKLIST[f.toLowerCase()])?.picklistValues ?? []).map((v) => v.label);
      const fetched = await deps.ledger.historyFetched(cand.map((t) => t.id));
      let fromCache = 0, historyFetched = 0, ingested = 0;
      const cached = (t: { id: number; lastMod: number }) => (fetched.get(t.id)?.getTime() ?? -1) >= t.lastMod;
      let stopIdx = -1; // first ticket left unread (budget)
      for (let i = 0; i < cand.length; i++) {
        const t = cand[i]!;
        if (cached(t)) { fromCache++; continue; }
        if (report.apiCallsUsed >= budget) { stopIdx = i; break; }
        const hist = await live<Row>('TicketHistory', [{ op: 'eq', field: 'ticketID', value: t.id }], 500);
        const evs = hist.map((h) => historyEvent(h as never, t, labelsFor)).filter((e): e is AuditEvent => !!e);
        ingested += await deps.ledger.insert(evs);
        await deps.ledger.markHistoryFetched(t.id, now);
        historyFetched++;
      }
      const stoppedAt = stopIdx >= 0 ? cand[stopIdx]!.lastMod : null;
      const pending = stopIdx >= 0 ? cand.slice(stopIdx).filter((t) => !cached(t)).length : 0;
      // Advance only past tickets fully read; a cut walk (live, budget) holds the watermark.
      const last = cand.length ? cand[cand.length - 1]!.lastMod : wm.getTime();
      const next = !w.complete ? wm : new Date(stoppedAt ?? Math.max(last, wm.getTime()));
      await deps.ledger.setFeedCheckpoint('tickets', next, coveredFrom);
      report.sources.tickets = { read: w.read, watermark: next.toISOString(), coveredFrom: coveredFrom.toISOString(), ingested, checked: cand.length, historyFetched, fromCache, pending };
      if (stoppedAt != null) report.incomplete.push(`tickets: API-call budget (${budget}) reached — ${pending} ticket(s) left for the next call`);
      if (!w.complete) report.incomplete.push(`tickets: candidate scan cut by the API-call budget (${budget}) — continues on the next call`);
    });
  });
  if (out === null) report.incomplete.push('another feed ingest is running — served what is already stored');
  return report;
}

// ---------------------------------------------------------------- reading

export interface FeedCursor { id: number; since: string }
export const encodeCursor = (c: FeedCursor): string => `af1.${Buffer.from(JSON.stringify(c)).toString('base64url')}`;
export function decodeCursor(s: unknown): FeedCursor | null {
  if (typeof s !== 'string' || !s.startsWith('af1.')) return null;
  try {
    const c = JSON.parse(Buffer.from(s.slice(4), 'base64url').toString('utf8')) as FeedCursor;
    return Number.isInteger(c.id) && c.id >= 0 && typeof c.since === 'string' && !Number.isNaN(Date.parse(c.since)) ? c : null;
  } catch { return null; }
}

const slug = (s: string) => s.trim().replace(/[^A-Za-z0-9]+(.)?/g, (_, ch: string | undefined) => (ch ? ch.toUpperCase() : '')).replace(/^./, (c) => c.toLowerCase());

/** "ticket.status.changed", "ticket.created", "ticketNote.created", "timeEntry.updated", … */
export function eventType(e: AuditEvent): string {
  const verb: Record<string, string> = { create: 'created', update: 'changed', delete: 'deleted', complete: 'completed', reopen: 'reopened', assign: 'assigned', note: 'created', time: 'created', cancel: 'cancelled' };
  if (e.entityType === 'ticket' && e.field && (e.action === 'update' || e.action === 'assign' || e.action === 'complete' || e.action === 'reopen')) return `ticket.${slug(e.field)}.changed`;
  if (e.entityType === 'timeEntry' && e.action === 'update') return 'timeEntry.updated';
  return `${e.entityType}.${verb[e.action] ?? e.action}`;
}

export interface FeedActor {
  resourceId: number | null;
  contactId?: number | null;
  displayName: string | null;
  actorType: string;
  classificationSource: string;
  reference: boolean;
}

export function feedActor(e: AuditEvent, ctx: ClassifyContext | null): FeedActor {
  const contact = num((e.details as Record<string, unknown> | undefined)?.createdByContactID);
  if (e.resourceId == null && contact != null) return { resourceId: null, contactId: contact, displayName: null, actorType: 'contact', classificationSource: 'created-by-contact', reference: false };
  if (!ctx) return { resourceId: e.resourceId, displayName: null, actorType: 'unknown', classificationSource: 'roster-unavailable', reference: false };
  const a = classifyActor(e.resourceId, ctx);
  return { resourceId: a.resourceId, displayName: a.displayName, actorType: a.actorType, classificationSource: a.classificationSource, reference: a.reference };
}
