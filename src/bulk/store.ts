// Bulk jobs (migration 0015): mass changes staged in Postgres, pushed to Autotask at a set pace.

import type { Pool } from 'pg';
import { createHash, randomUUID } from 'node:crypto';

export type JobStatus = 'preparing' | 'ready' | 'approved' | 'running' | 'paused' | 'done' | 'cancelled' | 'failed';
export type ItemStatus = 'pending' | 'done' | 'skipped' | 'failed' | 'excluded';

export interface BulkJob {
  id: string; kind: string; title: string; params: Record<string, unknown>; status: JobStatus; hash: string | null;
  ratePerHour: number; canarySize: number; pauseReason: string | null; lastError: string | null; stats: Record<string, unknown>;
  createdBy: string | null; approvedBy: string | null; approvedAt: string | null; startedAt: string | null; finishedAt: string | null; createdAt: string; updatedAt: string;
}
export interface BulkItemInput { entity: 'Companies' | 'Contacts'; recordId: number; parentId: number | null; action: 'inactivate'; status?: 'pending' | 'excluded'; reason?: string | null; before?: Record<string, unknown> | null }
export interface BulkItem extends Required<Omit<BulkItemInput, 'status' | 'reason' | 'before'>> { seq: number; status: ItemStatus; reason: string | null; attempts: number; before: Record<string, unknown> | null; error: string | null; doneAt: string | null }

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const job = (x: Record<string, any>): BulkJob => ({
  id: x.id, kind: x.kind, title: x.title, params: x.params ?? {}, status: x.status, hash: x.hash ?? null, ratePerHour: Number(x.rate_per_hour), canarySize: Number(x.canary_size),
  pauseReason: x.pause_reason ?? null, lastError: x.last_error ?? null, stats: x.stats ?? {}, createdBy: x.created_by ?? null, approvedBy: x.approved_by ?? null,
  approvedAt: iso(x.approved_at), startedAt: iso(x.started_at), finishedAt: iso(x.finished_at), createdAt: iso(x.created_at)!, updatedAt: iso(x.updated_at)!,
});
const item = (x: Record<string, any>): BulkItem => ({ seq: Number(x.seq), entity: x.entity, recordId: Number(x.record_id), parentId: x.parent_id == null ? null : Number(x.parent_id), action: x.action, status: x.status, reason: x.reason ?? null, attempts: Number(x.attempts), before: x.before ?? null, error: x.error ?? null, doneAt: iso(x.done_at) });

/** The approval hash binds the exact records and actions to be written (excluded ones are not part of it). */
export function itemsHash(kind: string, items: Array<Pick<BulkItemInput, 'entity' | 'recordId' | 'action' | 'status'>>): string {
  const w = items.filter((i) => (i.status ?? 'pending') === 'pending').map((i) => `${i.entity}:${i.recordId}:${i.action}`);
  return createHash('sha256').update(`${kind}\n${w.join('\n')}`).digest('hex').slice(0, 16);
}

export class BulkStore {
  constructor(private readonly pool: Pool) {}

  async create(j: { kind: string; title: string; params: Record<string, unknown>; ratePerHour: number; canarySize: number; by: string | null }): Promise<BulkJob> {
    const r = await this.pool.query(`INSERT INTO bulk_job (id, kind, title, params, status, rate_per_hour, canary_size, created_by) VALUES ($1,$2,$3,$4,'preparing',$5,$6,$7) RETURNING *`,
      [randomUUID(), j.kind, j.title, JSON.stringify(j.params), j.ratePerHour, j.canarySize, j.by]);
    return job(r.rows[0]);
  }
  async get(id: string): Promise<BulkJob | null> { const r = await this.pool.query('SELECT * FROM bulk_job WHERE id = $1', [id]); return r.rows[0] ? job(r.rows[0]) : null; }
  async list(limit = 20): Promise<BulkJob[]> { return (await this.pool.query('SELECT * FROM bulk_job ORDER BY created_at DESC LIMIT $1', [limit])).rows.map(job); }
  async running(): Promise<BulkJob[]> { return (await this.pool.query(`SELECT * FROM bulk_job WHERE status = 'running' ORDER BY created_at`)).rows.map(job); }

  /** Store the prepared items (chunked) and move to 'ready' with their hash. */
  async fill(id: string, items: BulkItemInput[], stats: Record<string, unknown>, hash: string): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('DELETE FROM bulk_job_item WHERE job_id = $1', [id]);
      for (let i = 0; i < items.length; i += 1000) {
        const b = items.slice(i, i + 1000);
        await c.query(`INSERT INTO bulk_job_item (job_id, seq, entity, record_id, parent_id, action, status, reason, before)
          SELECT $1, s, e, r, p, a, st, rs, bf::jsonb FROM unnest($2::int[], $3::text[], $4::bigint[], $5::bigint[], $6::text[], $7::text[], $8::text[], $9::text[]) AS t(s, e, r, p, a, st, rs, bf)`,
          [id, b.map((_, k) => i + k + 1), b.map((x) => x.entity), b.map((x) => x.recordId), b.map((x) => x.parentId), b.map((x) => x.action), b.map((x) => x.status ?? 'pending'), b.map((x) => x.reason ?? null), b.map((x) => (x.before ? JSON.stringify(x.before) : null))]);
      }
      await c.query(`UPDATE bulk_job SET status = 'ready', hash = $2, stats = $3, updated_at = now() WHERE id = $1`, [id, hash, JSON.stringify(stats)]);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }

  async setStatus(id: string, status: JobStatus, extra: { pauseReason?: string | null; lastError?: string | null; approvedBy?: string | null; started?: boolean; finished?: boolean; stats?: Record<string, unknown> } = {}): Promise<void> {
    await this.pool.query(`UPDATE bulk_job SET status = $2, pause_reason = CASE WHEN $3 THEN $4 ELSE pause_reason END, last_error = CASE WHEN $5 THEN $6 ELSE last_error END,
        approved_by = COALESCE($7, approved_by), approved_at = CASE WHEN $7 IS NOT NULL THEN now() ELSE approved_at END,
        started_at = CASE WHEN $8 AND started_at IS NULL THEN now() ELSE started_at END, finished_at = CASE WHEN $9 THEN now() ELSE finished_at END,
        stats = CASE WHEN $10::jsonb IS NULL THEN stats ELSE stats || $10::jsonb END, updated_at = now() WHERE id = $1`,
      [id, status, extra.pauseReason !== undefined, extra.pauseReason ?? null, extra.lastError !== undefined, extra.lastError ?? null, extra.approvedBy ?? null, !!extra.started, !!extra.finished, extra.stats ? JSON.stringify(extra.stats) : null]);
  }

  async next(id: string, n: number): Promise<BulkItem[]> {
    return (await this.pool.query(`SELECT * FROM bulk_job_item WHERE job_id = $1 AND status = 'pending' ORDER BY seq LIMIT $2`, [id, n])).rows.map(item);
  }
  async markItem(id: string, seq: number, status: ItemStatus, o: { error?: string | null; reason?: string | null } = {}): Promise<void> {
    await this.pool.query(`UPDATE bulk_job_item SET status = $3, attempts = attempts + 1, error = $4, reason = COALESCE($5, reason), done_at = CASE WHEN $3 IN ('done', 'skipped') THEN now() ELSE done_at END WHERE job_id = $1 AND seq = $2`,
      [id, seq, status, o.error ?? null, o.reason ?? null]);
  }
  /** Back to pending (a transient failure, retried later). */
  async retryLater(id: string, seq: number, error: string): Promise<void> {
    await this.pool.query(`UPDATE bulk_job_item SET attempts = attempts + 1, error = $3 WHERE job_id = $1 AND seq = $2`, [id, seq, error]);
  }
  /** Failed items back to pending (an operator retry). */
  async requeueFailed(id: string): Promise<number> { return (await this.pool.query(`UPDATE bulk_job_item SET status = 'pending', error = NULL, attempts = 0 WHERE job_id = $1 AND status = 'failed'`, [id])).rowCount ?? 0; }

  async counts(id: string): Promise<Record<string, Record<string, number>>> {
    const r = await this.pool.query('SELECT entity, status, count(*)::int n FROM bulk_job_item WHERE job_id = $1 GROUP BY entity, status', [id]);
    const out: Record<string, Record<string, number>> = {};
    for (const x of r.rows) (out[x.entity] ??= {})[x.status] = x.n;
    return out;
  }
  async items(id: string, status: ItemStatus, limit = 100): Promise<BulkItem[]> {
    return (await this.pool.query('SELECT * FROM bulk_job_item WHERE job_id = $1 AND status = $2 ORDER BY seq LIMIT $3', [id, status, limit])).rows.map(item);
  }
  async doneSince(id: string, sinceIso: string): Promise<number> {
    return Number((await this.pool.query(`SELECT count(*)::int n FROM bulk_job_item WHERE job_id = $1 AND status IN ('done', 'skipped') AND done_at >= $2`, [id, sinceIso])).rows[0]?.n ?? 0);
  }
  async allItemKeys(id: string): Promise<Array<Pick<BulkItemInput, 'entity' | 'recordId' | 'action' | 'status'>>> {
    return (await this.pool.query('SELECT entity, record_id, action, status FROM bulk_job_item WHERE job_id = $1 ORDER BY seq', [id])).rows.map((x) => ({ entity: x.entity, recordId: Number(x.record_id), action: x.action, status: x.status === 'excluded' ? 'excluded' : 'pending' }));
  }
}
