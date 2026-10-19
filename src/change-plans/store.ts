// Change plans (migration 0011): built read-only, frozen (rows + hash), approved
// row by row by a person, executed with a re-read before every write. A plan's
// rows never change after it is built; to change what a plan does, build a new
// one (the old one is superseded).

import { createHash, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';

/** manual = a step a person does in the Autotask UI (e.g. a native merge); the executor never runs it. */
export type RowAction = 'create' | 'update' | 'deactivate' | 'info' | 'manual';
export type RowStatus = 'pending' | 'approved' | 'excluded' | 'applied' | 'failed' | 'stale' | 'skipped';

export interface PlanRowInput {
  action: RowAction;
  entity: string;
  targetId: number | null;
  label: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  /** Why the row can't run (it is shown, never approvable). */
  blocked: string | null;
  /** Bookkeeping for after the write (e.g. which offering a service belongs to) — never sent to Autotask. */
  meta?: Record<string, unknown> | null;
}
export interface PlanRow extends PlanRowInput { rowNo: number; status: RowStatus; approvedBy: string | null; approvedAt: string | null; result: Record<string, unknown> | null; executedAt: string | null }
export interface Plan { id: string; kind: string; title: string; params: Record<string, unknown> | null; hash: string; status: string; createdBy: string | null; createdAt: string; rows: PlanRow[] }

export const planHash = (kind: string, rows: PlanRowInput[]) => createHash('sha256').update(JSON.stringify({ kind, rows })).digest('hex').slice(0, 16);

/** "1-5, 8, 10-12" → [1,2,3,4,5,8,10,11,12]; "all" → every row. Null when malformed. */
export function parseRows(spec: unknown, max: number): number[] | null {
  if (Array.isArray(spec)) return spec.every((x) => Number.isInteger(Number(x))) ? [...new Set(spec.map(Number))].filter((n) => n >= 1 && n <= max) : null;
  const s = String(spec ?? '').trim().toLowerCase();
  if (s === 'all') return Array.from({ length: max }, (_, i) => i + 1);
  if (!/^\d+(\s*-\s*\d+)?(\s*,\s*\d+(\s*-\s*\d+)?)*$/.test(s)) return null;
  const out = new Set<number>();
  for (const part of s.split(',')) {
    const [a, b] = part.split('-').map((x) => Number(x.trim()));
    for (let i = a!; i <= (b ?? a!); i++) if (i >= 1 && i <= max) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

const iso = (d: unknown) => (d == null ? null : new Date(d as string).toISOString());

export class PlanStore {
  constructor(private readonly pool: Pool) {}

  async create(p: { kind: string; title: string; params?: Record<string, unknown>; rows: PlanRowInput[]; by: string | null; supersedeKind?: boolean }): Promise<Plan> {
    const id = randomUUID();
    const hash = planHash(p.kind, p.rows);
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      // A newer plan of the same kind replaces the older open one (it could be applied on stale data).
      // Serialize builds of one kind: two parallel builds each superseded only what was committed
      // before the other's insert, and both stayed open (seen live: ChatGPT built a catalog plan twice).
      if (p.supersedeKind !== false) await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`change_plan:${p.kind}`]);
      if (p.supersedeKind !== false) await c.query(`UPDATE change_plan SET status = 'superseded', updated_at = now() WHERE kind = $1 AND status = 'open'`, [p.kind]);
      await c.query(`INSERT INTO change_plan (id, kind, title, params, hash, status, created_by) VALUES ($1,$2,$3,$4,$5,'open',$6)`, [id, p.kind, p.title, p.params ? JSON.stringify(p.params) : null, hash, p.by]);
      for (let i = 0; i < p.rows.length; i++) {
        const r = p.rows[i]!;
        await c.query(`INSERT INTO change_plan_row (plan_id, row_no, action, entity, target_id, label, before, after, reason, blocked, status, meta) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [id, i + 1, r.action, r.entity, r.targetId, r.label, r.before ? JSON.stringify(r.before) : null, r.after ? JSON.stringify(r.after) : null, r.reason, r.blocked, r.action === 'info' ? 'skipped' : 'pending', r.meta ? JSON.stringify(r.meta) : null]);
      }
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
    return (await this.get(id))!;
  }

  async get(id: string): Promise<Plan | null> {
    const p = (await this.pool.query('SELECT * FROM change_plan WHERE id = $1', [id])).rows[0];
    if (!p) return null;
    const rows = (await this.pool.query('SELECT * FROM change_plan_row WHERE plan_id = $1 ORDER BY row_no', [id])).rows;
    return {
      id: p.id, kind: p.kind, title: p.title, params: p.params, hash: p.hash, status: p.status, createdBy: p.created_by, createdAt: iso(p.created_at)!,
      rows: rows.map((r) => ({ rowNo: r.row_no, action: r.action, entity: r.entity, targetId: r.target_id == null ? null : Number(r.target_id), label: r.label, before: r.before, after: r.after, reason: r.reason, blocked: r.blocked, meta: r.meta ?? null, status: r.status, approvedBy: r.approved_by, approvedAt: iso(r.approved_at), result: r.result, executedAt: iso(r.executed_at) })),
    };
  }

  async list(limit = 20): Promise<Array<Omit<Plan, 'rows'> & { counts: Record<string, number> }>> {
    const r = await this.pool.query(`SELECT p.*, (SELECT jsonb_object_agg(status, n) FROM (SELECT status, count(*) n FROM change_plan_row WHERE plan_id = p.id GROUP BY status) s) AS counts FROM change_plan p ORDER BY created_at DESC LIMIT $1`, [limit]);
    return r.rows.map((p) => ({ id: p.id, kind: p.kind, title: p.title, params: p.params, hash: p.hash, status: p.status, createdBy: p.created_by, createdAt: iso(p.created_at)!, counts: p.counts ?? {} }));
  }

  /** Approve (or exclude) rows of an OPEN plan whose hash matches. Blocked / info rows are never approved. */
  async setApproval(id: string, hash: string, rowNos: number[], approve: boolean, by: string | null): Promise<{ changed: number[]; refused: Array<{ row: number; why: string }> }> {
    const plan = await this.get(id);
    if (!plan) throw new Error(`No plan ${id}.`);
    if (plan.status !== 'open') throw new Error(`Plan ${id} is ${plan.status} — build a new plan.`);
    if (plan.hash !== hash) throw new Error(`Plan hash mismatch (plan is ${plan.hash}) — approve the plan you reviewed.`);
    const changed: number[] = [], refused: Array<{ row: number; why: string }> = [];
    for (const n of rowNos) {
      const r = plan.rows.find((x) => x.rowNo === n);
      if (!r) { refused.push({ row: n, why: 'no such row' }); continue; }
      if (r.blocked) { refused.push({ row: n, why: `blocked: ${r.blocked}` }); continue; }
      if (r.action === 'info') { refused.push({ row: n, why: 'information only' }); continue; }
      // A failed row can be approved again: a re-run first checks whether the write is already in place.
      if (!['pending', 'approved', 'excluded', 'failed'].includes(r.status)) { refused.push({ row: n, why: `already ${r.status}` }); continue; }
      await this.pool.query(`UPDATE change_plan_row SET status = $3, approved_by = $4, approved_at = CASE WHEN $3 = 'approved' THEN now() ELSE NULL END WHERE plan_id = $1 AND row_no = $2`, [id, n, approve ? 'approved' : 'excluded', by]);
      changed.push(n);
    }
    await this.pool.query('UPDATE change_plan SET updated_at = now() WHERE id = $1', [id]);
    return { changed, refused };
  }

  async setRowResult(id: string, rowNo: number, status: RowStatus, result: Record<string, unknown>): Promise<void> {
    await this.pool.query(`UPDATE change_plan_row SET status = $3, result = $4, executed_at = now() WHERE plan_id = $1 AND row_no = $2`, [id, rowNo, status, JSON.stringify(result)]);
  }
  async setStatus(id: string, status: string): Promise<void> {
    await this.pool.query('UPDATE change_plan SET status = $2, updated_at = now() WHERE id = $1', [id, status]);
  }
}
