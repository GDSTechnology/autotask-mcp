// Reconciliation runs and durable exception state (migration 0012). A run is a
// snapshot; an exception's owner / status / notes live in
// reconciliation_exception_state under a stable key, so next month's run of the
// same issue keeps its history instead of starting over.

import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ReconRow } from './reconcile.js';

export interface RunInfo { id: string; vendor: string; documentId: number | null; invoiceNumber: string | null; periodStart: string | null; periodEnd: string | null; summary: Record<string, unknown>; createdBy: string | null; createdAt: string }
/**
 * What became of an exception. open / acknowledged = still to decide; the rest are OUTCOMES:
 *   resolved          fixed in Autotask (reopens if it comes back next run)
 *   accepted          an expected variance (e.g. the customer buys it elsewhere)
 *   absorbed          GDS carries the cost — a write-off, counted apart from open exposure
 *   billed_elsewhere  billed on another company / contract / invoice — reference says where
 *   fix_planned       a change plan will fix it — reference = the plan id
 */
export const EXCEPTION_STATUSES = ['open', 'acknowledged', 'resolved', 'accepted', 'absorbed', 'billed_elsewhere', 'fix_planned'] as const;
export type ExceptionStatus = typeof EXCEPTION_STATUSES[number];
/** Decided: no longer counted as open exposure. */
export const DECIDED_STATUSES: ExceptionStatus[] = ['resolved', 'accepted', 'absorbed', 'billed_elsewhere'];
export interface ExceptionState {
  exceptionKey: string; status: ExceptionStatus; owner: string | null; dueOn: string | null; reference: string | null;
  history: Array<{ at: string; by: string | null; status?: string; owner?: string | null; note?: string; dueOn?: string | null; reference?: string | null }>; firstSeenRun: string | null; lastSeenRun: string | null;
}

const day = (d: unknown) => (d == null ? null : new Date(d as string).toISOString().slice(0, 10));

export class ReconStore {
  constructor(private readonly pool: Pool) {}

  async saveRun(r: { vendor: string; documentId: number; invoiceNumber: string | null; periodStart: string; periodEnd: string; params: Record<string, unknown>; summary: Record<string, unknown>; rows: ReconRow[]; by: string | null }): Promise<string> {
    const id = randomUUID();
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('INSERT INTO reconciliation_run (id, vendor, document_id, invoice_number, period_start, period_end, params, summary, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [id, r.vendor, r.documentId, r.invoiceNumber, r.periodStart, r.periodEnd, JSON.stringify(r.params), JSON.stringify(r.summary), r.by]);
      for (let k = 0; k < r.rows.length; k += 200) {
        const b = r.rows.slice(k, k + 200);
        await c.query(`INSERT INTO reconciliation_row (run_id, row_no, exception_key, severity, exception_type, company_id, contract_id, contract_service_id, offering_id, data)
          SELECT $1, * FROM unnest($2::int[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::bigint[], $8::bigint[], $9::bigint[], $10::jsonb[])`,
          [id, b.map((x) => x.rowNo), b.map((x) => x.exceptionKey), b.map((x) => x.severity), b.map((x) => x.exceptions[0] ?? null), b.map((x) => x.autotaskCompanyId), b.map((x) => x.contractId), b.map((x) => x.contractServiceId), b.map((x) => x.offeringId), b.map((x) => JSON.stringify(x))]);
      }
      // Exceptions seen in this run: create their state on first sight, refresh last-seen. Resolved ones that came back reopen.
      const keys = r.rows.filter((x) => x.severity !== 'ok' && x.severity !== 'info').map((x) => x.exceptionKey);
      if (keys.length) {
        await c.query(`INSERT INTO reconciliation_exception_state (exception_key, first_seen_run, last_seen_run) SELECT k, $2, $2 FROM unnest($1::text[]) k
          ON CONFLICT (exception_key) DO UPDATE SET last_seen_run = EXCLUDED.last_seen_run, updated_at = now(),
            status = CASE WHEN reconciliation_exception_state.status = 'resolved' THEN 'open' ELSE reconciliation_exception_state.status END,
            history = CASE WHEN reconciliation_exception_state.status = 'resolved' THEN reconciliation_exception_state.history || jsonb_build_array(jsonb_build_object('at', now(), 'by', 'reconciliation', 'status', 'open', 'note', 'seen again after being resolved')) ELSE reconciliation_exception_state.history END`, [keys, id]);
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
    return id;
  }

  async runs(limit = 20): Promise<RunInfo[]> {
    const r = await this.pool.query('SELECT * FROM reconciliation_run ORDER BY created_at DESC LIMIT $1', [limit]);
    return r.rows.map((x) => this.run(x));
  }
  async latestRun(vendor?: string): Promise<RunInfo | null> {
    const r = await this.pool.query(`SELECT * FROM reconciliation_run ${vendor ? 'WHERE vendor = $1' : ''} ORDER BY created_at DESC LIMIT 1`, vendor ? [vendor] : []);
    return r.rows[0] ? this.run(r.rows[0]) : null;
  }
  async getRun(id: string): Promise<RunInfo | null> {
    const r = await this.pool.query('SELECT * FROM reconciliation_run WHERE id = $1', [id]);
    return r.rows[0] ? this.run(r.rows[0]) : null;
  }
  private run(x: Record<string, any>): RunInfo {
    return { id: x.id, vendor: x.vendor, documentId: x.document_id == null ? null : Number(x.document_id), invoiceNumber: x.invoice_number, periodStart: day(x.period_start), periodEnd: day(x.period_end), summary: x.summary ?? {}, createdBy: x.created_by, createdAt: new Date(x.created_at).toISOString() };
  }

  async rows(runId: string): Promise<ReconRow[]> {
    const r = await this.pool.query('SELECT data FROM reconciliation_row WHERE run_id = $1 ORDER BY row_no', [runId]);
    return r.rows.map((x) => x.data as ReconRow);
  }

  async states(keys: string[]): Promise<Map<string, ExceptionState>> {
    if (!keys.length) return new Map();
    const r = await this.pool.query('SELECT * FROM reconciliation_exception_state WHERE exception_key = ANY($1::text[])', [keys]);
    return new Map(r.rows.map((x) => [x.exception_key, { exceptionKey: x.exception_key, status: x.status, owner: x.owner, dueOn: x.due_on ? new Date(x.due_on).toISOString().slice(0, 10) : null, reference: x.reference ?? null, history: x.history ?? [], firstSeenRun: x.first_seen_run, lastSeenRun: x.last_seen_run }]));
  }

  /** Change status / owner / add a note — appended to the history, never overwritten. */
  async updateState(keys: string[], u: { status?: ExceptionStatus; owner?: string | null; note?: string; dueOn?: string | null; reference?: string | null; by: string | null }): Promise<number> {
    let n = 0;
    for (const k of keys) {
      const entry = { at: new Date().toISOString(), by: u.by, ...(u.status ? { status: u.status } : {}), ...(u.owner !== undefined ? { owner: u.owner } : {}), ...(u.note ? { note: u.note } : {}), ...(u.dueOn !== undefined ? { dueOn: u.dueOn } : {}), ...(u.reference !== undefined ? { reference: u.reference } : {}) };
      const r = await this.pool.query(`INSERT INTO reconciliation_exception_state (exception_key, status, owner, history, due_on, reference) VALUES ($1, COALESCE($2, 'open'), $3, jsonb_build_array($4::jsonb), $6::date, $8)
        ON CONFLICT (exception_key) DO UPDATE SET status = COALESCE($2, reconciliation_exception_state.status), owner = CASE WHEN $5 THEN $3 ELSE reconciliation_exception_state.owner END,
          due_on = CASE WHEN $7 THEN $6::date ELSE reconciliation_exception_state.due_on END, reference = CASE WHEN $9 THEN $8 ELSE reconciliation_exception_state.reference END,
          history = reconciliation_exception_state.history || jsonb_build_array($4::jsonb), updated_at = now()`,
        [k, u.status ?? null, u.owner ?? null, JSON.stringify(entry), u.owner !== undefined, u.dueOn ?? null, u.dueOn !== undefined, u.reference ?? null, u.reference !== undefined]);
      n += r.rowCount ?? 0;
    }
    return n;
  }
}
