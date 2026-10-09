// Bounded historical backfill (gap register MCP-006): history, notes and time
// entries of the tickets COMPLETED in a date range, stored in the audit ledger
// for learning — outside the shadow's window, without uncontrolled API use.
//
// A job (migration 0009) is advanced one step per call:
//   0. Tenant usage at/above pauseAtPct → the step does nothing (paused).
//   1. One page of tickets completed in the range, ids above the cursor.
//   2. Their notes and time entries in bulk (`ticketID in [...]`, by id pages).
//   3. Each ticket's history (1 call per ticket; skipped when already indexed
//      after the ticket's last change).
// The cursor moves only past tickets whose history is stored, so a budget cut
// mid-page resumes there; every insert is idempotent (event_key), so repeating
// a step never duplicates. Any Autotask error stops the step (no retries) and
// is recorded on the job.

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { AuditLedger } from './audit-ledger.js';
import type { ShadowFilter } from './shadow-sql.js';
import { AuditEvent, historyEvent, noteEvent, timeEntryEvent } from '../utils/audit-events.js';
import { HISTORY_FIELD_PICKLIST } from '../utils/ticket-audit.js';

export type BackfillSource = 'tickets' | 'ticketNotes' | 'timeEntries';
export const BACKFILL_SOURCES: BackfillSource[] = ['tickets', 'ticketNotes', 'timeEntries'];
export const MAX_RANGE_DAYS = 366;

export interface BackfillJob {
  id: string; rangeFrom: string; rangeTo: string; sources: BackfillSource[]; cursor: number;
  status: 'running' | 'done' | 'failed'; ticketsTotal: number | null; ticketsDone: number; eventsIngested: number;
  apiCalls: number; lastError: string | null; createdAt: string; updatedAt: string;
}

interface JobRow {
  id: string; range_from: Date; range_to: Date; sources: string[]; cursor: string; status: BackfillJob['status'];
  tickets_total: number | null; tickets_done: number; events_ingested: number; api_calls: number; last_error: string | null; created_at: Date; updated_at: Date;
}
const toJob = (r: JobRow): BackfillJob => ({
  id: r.id, rangeFrom: new Date(r.range_from).toISOString(), rangeTo: new Date(r.range_to).toISOString(), sources: r.sources as BackfillSource[],
  cursor: Number(r.cursor), status: r.status, ticketsTotal: r.tickets_total, ticketsDone: r.tickets_done, eventsIngested: r.events_ingested,
  apiCalls: r.api_calls, lastError: r.last_error, createdAt: new Date(r.created_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
});

export class BackfillJobs {
  constructor(private readonly pool: Pool) {}
  async create(j: { rangeFrom: Date; rangeTo: Date; sources: BackfillSource[]; ticketsTotal: number | null }): Promise<BackfillJob> {
    const r = await this.pool.query<JobRow>(
      `INSERT INTO history_backfill_job (id, range_from, range_to, sources, status, tickets_total) VALUES ($1, $2, $3, $4, 'running', $5) RETURNING *`,
      [randomUUID(), j.rangeFrom, j.rangeTo, j.sources, j.ticketsTotal],
    );
    return toJob(r.rows[0]!);
  }
  async get(id: string): Promise<BackfillJob | null> {
    const r = await this.pool.query<JobRow>('SELECT * FROM history_backfill_job WHERE id = $1', [id]);
    return r.rows[0] ? toJob(r.rows[0]) : null;
  }
  async list(limit = 20): Promise<BackfillJob[]> {
    const r = await this.pool.query<JobRow>('SELECT * FROM history_backfill_job ORDER BY created_at DESC LIMIT $1', [limit]);
    return r.rows.map(toJob);
  }
  async update(id: string, p: { cursor?: number; status?: BackfillJob['status']; ticketsDone?: number; eventsIngested?: number; apiCalls?: number; lastError?: string | null }): Promise<BackfillJob> {
    const r = await this.pool.query<JobRow>(
      `UPDATE history_backfill_job SET cursor = COALESCE($2, cursor), status = COALESCE($3, status), tickets_done = tickets_done + COALESCE($4, 0),
         events_ingested = events_ingested + COALESCE($5, 0), api_calls = api_calls + COALESCE($6, 0),
         last_error = CASE WHEN $7::boolean THEN $8 ELSE last_error END, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, p.cursor ?? null, p.status ?? null, p.ticketsDone ?? 0, p.eventsIngested ?? 0, p.apiCalls ?? 0, p.lastError !== undefined, p.lastError ?? null],
    );
    return toJob(r.rows[0]!);
  }
}

type Row = Record<string, unknown> & { id: number };
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const ms = (v: unknown): number | null => {
  if (typeof v !== 'string' || !v) return null;
  const t = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(v) ? v : `${v}Z`).getTime();
  return Number.isNaN(t) ? null : t;
};

export interface BackfillDeps {
  ledger: Pick<AuditLedger, 'insert' | 'historyFetched' | 'markHistoryFetched'>;
  jobs: Pick<BackfillJobs, 'update'>;
  http: { query<T>(entity: string, filters: ShadowFilter[], opts: { maxRecords?: number; includeFields?: string[] }): Promise<T[]> };
  service: {
    getFieldInfo(entity: string): Promise<Array<{ name: string; picklistValues?: Array<{ value: string | number; label: string }> }>>;
    getPicklistValues(entity: string, field: string): Promise<Array<{ value: string; label: string }>>;
  };
  /** Tenant API usage % (null = unknown). Called once per step. */
  usagePct: () => Promise<number | null>;
}

export interface StepReport {
  job: BackfillJob;
  paused?: string;
  apiCallsUsed: number;
  ticketsProcessed: number;
  eventsIngested: number;
  stoppedBy?: 'budget' | 'error';
  error?: string;
}

/** Advance a job by one budgeted step. */
export async function runBackfillStep(deps: BackfillDeps, job: BackfillJob, o: { maxApiCalls: number; batchSize: number; pauseAtPct: number; timeZone: string }): Promise<StepReport> {
  // At least 10: usage check + tickets page + notes + time + a few histories, so every step makes progress.
  const budget = Math.min(Math.max(Math.floor(o.maxApiCalls), 10), 500);
  let calls = 0, events = 0, processed = 0;
  const finish = async (p: Partial<StepReport> & { cursor?: number; status?: BackfillJob['status']; lastError?: string | null }) => {
    const updated = await deps.jobs.update(job.id, {
      ...(p.cursor !== undefined ? { cursor: p.cursor } : {}), ...(p.status ? { status: p.status } : {}),
      ticketsDone: processed, eventsIngested: events, apiCalls: calls, ...(p.lastError !== undefined ? { lastError: p.lastError } : {}),
    });
    return { job: updated, apiCallsUsed: calls, ticketsProcessed: processed, eventsIngested: events, ...(p.paused ? { paused: p.paused } : {}), ...(p.stoppedBy ? { stoppedBy: p.stoppedBy } : {}), ...(p.error ? { error: p.error } : {}) };
  };
  if (job.status !== 'running') return { job, apiCallsUsed: 0, ticketsProcessed: 0, eventsIngested: 0 };

  const pct = await deps.usagePct().catch(() => null);
  calls++;
  if (pct != null && pct >= o.pauseAtPct) return finish({ paused: `tenant API usage ${pct}% ≥ ${o.pauseAtPct}% — nothing read this step; try again later` });

  const live = async <T extends Row>(entity: string, filter: ShadowFilter[], max: number, fields?: string[]): Promise<T[]> => {
    if (calls >= budget) throw new Error('budget');
    const rows = await deps.http.query<T>(entity, filter, { maxRecords: max, ...(fields ? { includeFields: fields } : {}) });
    calls += Math.max(1, Math.ceil(rows.length / 500));
    return rows;
  };
  /** All rows of `entity` for these tickets, walked by id (500 per call). */
  const forTickets = async (entity: string, ids: number[], fields: string[]): Promise<Row[]> => {
    const out: Row[] = [];
    let last = 0;
    for (;;) {
      const page = await live<Row>(entity, [{ op: 'in', field: 'ticketID', value: ids }, { op: 'gt', field: 'id', value: last }], 500, fields);
      out.push(...page);
      if (page.length < 500) return out;
      last = Number(page[page.length - 1]!.id);
    }
  };

  const want = (s: BackfillSource) => job.sources.includes(s);
  try {
    const tickets = await live<Row>('Tickets', [
      { op: 'gte', field: 'completedDate', value: job.rangeFrom },
      { op: 'lt', field: 'completedDate', value: job.rangeTo },
      { op: 'gt', field: 'id', value: job.cursor },
    ], Math.min(Math.max(o.batchSize, 1), 200), ['id', 'ticketNumber', 'companyID', 'lastTrackedModificationDateTime']);
    tickets.sort((a, b) => Number(a.id) - Number(b.id));
    if (!tickets.length) return finish({ status: 'done' });
    const info = new Map(tickets.map((t) => [Number(t.id), { id: Number(t.id), ticketNumber: (t.ticketNumber as string) ?? null, companyID: num(t.companyID) }]));
    const ids = [...info.keys()];

    if (want('ticketNotes')) {
      const notes = await forTickets('TicketNotes', ids, ['id', 'ticketID', 'title', 'description', 'noteType', 'publish', 'creatorResourceID', 'createdByContactID', 'createDateTime']);
      let types: Array<{ value: string; label: string }> = [], pubs: Array<{ value: string; label: string }> = [];
      try { types = await deps.service.getPicklistValues('TicketNotes', 'noteType'); pubs = await deps.service.getPicklistValues('TicketNotes', 'publish'); } catch { /* raw values */ }
      const evs = notes.map((n) => {
        const t = info.get(Number(n.ticketID));
        return t ? noteEvent('ticketNote', n, { type: 'ticket', id: t.id, reference: t.ticketNumber, companyId: t.companyID }, {
          noteType: types.find((x) => String(x.value) === String(n.noteType))?.label ?? null, publish: pubs.find((x) => String(x.value) === String(n.publish))?.label ?? null,
        }) : null;
      }).filter((e): e is AuditEvent => !!e);
      events += await deps.ledger.insert(evs);
    }
    if (want('timeEntries')) {
      const rows = await forTickets('TimeEntries', ids, ['id', 'resourceID', 'ticketID', 'dateWorked', 'startDateTime', 'endDateTime', 'hoursWorked', 'hoursToBill', 'isNonBillable', 'roleID', 'billingCodeID', 'internalBillingCodeID', 'contractID', 'summaryNotes', 'createDateTime', 'lastModifiedDateTime', 'creatorUserID', 'lastModifiedUserID', 'billingApprovalDateTime']);
      const evs = rows.map((r) => {
        const t = info.get(Number(r.ticketID));
        return timeEntryEvent(r, { type: 'ticket', id: num(r.ticketID), reference: t?.ticketNumber ?? null, companyId: t?.companyID ?? null }, o.timeZone);
      }).filter((e): e is AuditEvent => !!e);
      events += await deps.ledger.insert(evs);
    }

    let cursor = job.cursor;
    if (want('tickets')) {
      let fields: Awaited<ReturnType<BackfillDeps['service']['getFieldInfo']>> = [];
      try { fields = await deps.service.getFieldInfo('Tickets'); } catch { /* parse without label anchors */ }
      const labelsFor = (f: string) => (fields.find((x) => x.name === HISTORY_FIELD_PICKLIST[f.toLowerCase()])?.picklistValues ?? []).map((v) => v.label);
      const fetched = await deps.ledger.historyFetched(ids);
      for (const t of tickets) {
        const id = Number(t.id);
        const lastMod = ms(t.lastTrackedModificationDateTime);
        const at = fetched.get(id);
        if (!(at && lastMod != null && at.getTime() >= lastMod)) {
          let hist: Row[];
          try { hist = await live<Row>('TicketHistory', [{ op: 'eq', field: 'ticketID', value: id }], 500); } catch (e) {
            if (e instanceof Error && e.message === 'budget') return finish({ cursor, stoppedBy: 'budget' });
            throw e;
          }
          events += await deps.ledger.insert(hist.map((h) => historyEvent(h as never, info.get(id)!, labelsFor)).filter((e): e is AuditEvent => !!e));
          await deps.ledger.markHistoryFetched(id, new Date());
        }
        cursor = id; processed++;
      }
    } else {
      cursor = ids[ids.length - 1]!; processed = ids.length;
    }
    return finish({ cursor });
  } catch (e) {
    if (e instanceof Error && e.message === 'budget') return finish({ stoppedBy: 'budget' });
    const msg = e instanceof Error ? e.message : String(e);
    return finish({ stoppedBy: 'error', error: msg, lastError: msg.slice(0, 500) });
  }
}
