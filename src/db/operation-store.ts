// Operation log + durable idempotency (migration 0008, gap register MCP-007).
// See the migration for the model. Everything here is best-effort except
// claim(): an idempotency claim that can't be made must not let the call run
// unguarded, so its errors propagate to the caller.

import type { Pool } from 'pg';
import type { OperationWrite } from '../utils/operation-context.js';

/** A claimed key whose call never finished (crash / restart) is not re-run after this long — the caller decides. */
export const RUNNING_STALE_MS = 10 * 60_000;
/** Stored result text is capped; a larger result replays as a short summary. */
const MAX_RESULT_CHARS = 200_000;

export interface OperationInput {
  operationId: string;
  correlationId: string;
  decisionId?: string | undefined;
  idempotencyKey?: string | undefined;
  tool: string;
  argsDigest?: string | undefined;
  source: string;
  caller?: Record<string, unknown> | undefined;
  refs?: Record<string, string> | undefined;
}

export type OperationStatus = 'running' | 'ok' | 'error' | 'partial';

export interface OperationRecord {
  operationId: string; correlationId: string; decisionId: string | null; idempotencyKey: string | null;
  tool: string; source: string; caller: Record<string, unknown> | null; refs: Record<string, string> | null;
  status: OperationStatus; startedAt: string; finishedAt: string | null; error: string | null;
  writes: OperationWrite[];
}

export type ClaimResult =
  | { status: 'claimed' }
  | { status: 'replay'; operation: OperationRecord; resultText: string | null }
  | { status: 'conflict' | 'in_progress' | 'incomplete' | 'partial'; operation: OperationRecord };

interface OpRow {
  operation_id: string; correlation_id: string; decision_id: string | null; idempotency_key: string | null; tool: string; args_digest: string | null;
  source: string; caller: Record<string, unknown> | null; refs: Record<string, string> | null; status: OperationStatus;
  started_at: Date; finished_at: Date | null; result_text: string | null; error: string | null;
}
interface WriteRow { operation_id: string; at: Date; method: string; path: string; entity_type: string | null; entity_id: string | null; parent_type: string | null; parent_id: string | null }

const toWrite = (w: WriteRow): OperationWrite => ({
  at: new Date(w.at).toISOString(), method: w.method, path: w.path, entityType: w.entity_type,
  entityId: w.entity_id == null ? null : Number(w.entity_id), parentType: w.parent_type, parentId: w.parent_id == null ? null : Number(w.parent_id),
});

export class OperationStore {
  constructor(private readonly pool: Pool) {}

  private record(r: OpRow, writes: OperationWrite[]): OperationRecord {
    return {
      operationId: r.operation_id, correlationId: r.correlation_id, decisionId: r.decision_id, idempotencyKey: r.idempotency_key,
      tool: r.tool, source: r.source, caller: r.caller, refs: r.refs, status: r.status,
      startedAt: new Date(r.started_at).toISOString(), finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null, error: r.error, writes,
    };
  }

  private async writesOf(ids: string[]): Promise<Map<string, OperationWrite[]>> {
    const m = new Map<string, OperationWrite[]>();
    if (!ids.length) return m;
    const r = await this.pool.query<WriteRow>('SELECT * FROM mcp_operation_write WHERE operation_id = ANY($1::uuid[]) ORDER BY id', [ids]);
    for (const w of r.rows) (m.get(w.operation_id) ?? m.set(w.operation_id, []).get(w.operation_id)!).push(toWrite(w));
    return m;
  }

  /**
   * Claim an idempotency key before the call runs. Exactly one caller gets
   * "claimed"; a repeat gets the stored result (same tool + payload) or a
   * refusal saying why. A key whose earlier attempt failed WITHOUT writing is
   * released and claimed again.
   */
  async claim(op: OperationInput & { idempotencyKey: string }): Promise<ClaimResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ins = await this.pool.query(
        `INSERT INTO mcp_operation (operation_id, correlation_id, decision_id, idempotency_key, tool, args_digest, source, caller, refs, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'running')
         ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING RETURNING operation_id`,
        [op.operationId, op.correlationId, op.decisionId ?? null, op.idempotencyKey, op.tool, op.argsDigest ?? null, op.source,
          op.caller ? JSON.stringify(op.caller) : null, op.refs ? JSON.stringify(op.refs) : null],
      );
      if (ins.rowCount) return { status: 'claimed' };
      const ex = (await this.pool.query<OpRow>('SELECT * FROM mcp_operation WHERE idempotency_key = $1', [op.idempotencyKey])).rows[0];
      if (!ex) continue; // released between the two statements — try again
      if (ex.status === 'error') {
        // Failed before writing anything: safe to run again under the same key.
        await this.pool.query(`DELETE FROM mcp_operation WHERE operation_id = $1 AND status = 'error'`, [ex.operation_id]);
        continue;
      }
      const rec = this.record(ex, (await this.writesOf([ex.operation_id])).get(ex.operation_id) ?? []);
      if (ex.tool !== op.tool || (ex.args_digest ?? null) !== (op.argsDigest ?? null)) return { status: 'conflict', operation: rec };
      if (ex.status === 'ok') return { status: 'replay', operation: rec, resultText: ex.result_text };
      if (ex.status === 'partial') return { status: 'partial', operation: rec };
      return { status: Date.now() - new Date(ex.started_at).getTime() < RUNNING_STALE_MS ? 'in_progress' : 'incomplete', operation: rec };
    }
    throw new Error(`idempotency key "${op.idempotencyKey}" could not be claimed`);
  }

  /** Record the outcome (inserting the row when it wasn't claimed) and the writes made. */
  async finish(op: OperationInput, out: { status: Exclude<OperationStatus, 'running'>; writes: OperationWrite[]; resultText?: string | null; error?: string | null }): Promise<void> {
    const text = out.resultText != null && out.resultText.length <= MAX_RESULT_CHARS ? out.resultText : null;
    await this.pool.query(
      `INSERT INTO mcp_operation (operation_id, correlation_id, decision_id, idempotency_key, tool, args_digest, source, caller, refs, status, finished_at, result_text, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now(), $11, $12)
       ON CONFLICT (operation_id) DO UPDATE SET status = EXCLUDED.status, finished_at = now(), result_text = EXCLUDED.result_text, error = EXCLUDED.error`,
      [op.operationId, op.correlationId, op.decisionId ?? null, op.idempotencyKey ?? null, op.tool, op.argsDigest ?? null, op.source,
        op.caller ? JSON.stringify(op.caller) : null, op.refs ? JSON.stringify(op.refs) : null, out.status, text, out.error ?? null],
    );
    if (!out.writes.length) return;
    const w = out.writes;
    await this.pool.query(
      `INSERT INTO mcp_operation_write (operation_id, at, method, path, entity_type, entity_id, parent_type, parent_id)
       SELECT $1, * FROM unnest($2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::text[], $8::bigint[])`,
      [op.operationId, w.map((x) => x.at), w.map((x) => x.method), w.map((x) => x.path), w.map((x) => x.entityType), w.map((x) => x.entityId), w.map((x) => x.parentType), w.map((x) => x.parentId)],
    );
  }

  /** Operations by id / correlation / decision / key, or that wrote a ticket (or something under it). Newest first. */
  async find(q: { operationId?: string; correlationId?: string; decisionId?: string; idempotencyKey?: string; ticketId?: number; since?: string; limit?: number }): Promise<OperationRecord[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.split('?').join(`$${params.length}`)); };
    if (q.operationId) add('o.operation_id = ?::uuid', q.operationId);
    if (q.correlationId) add('o.correlation_id = ?', q.correlationId);
    if (q.decisionId) add('o.decision_id = ?', q.decisionId);
    if (q.idempotencyKey) add('o.idempotency_key = ?', q.idempotencyKey);
    if (q.ticketId != null) add(`EXISTS (SELECT 1 FROM mcp_operation_write w WHERE w.operation_id = o.operation_id AND ((w.entity_type = 'ticket' AND w.entity_id = ?) OR (w.parent_type = 'ticket' AND w.parent_id = ?)))`, q.ticketId);
    if (q.since) add('o.started_at >= ?', q.since);
    if (!where.length) return [];
    params.push(Math.min(Math.max(q.limit ?? 50, 1), 500));
    const r = await this.pool.query<OpRow>(`SELECT * FROM mcp_operation o WHERE ${where.join(' AND ')} ORDER BY o.started_at DESC LIMIT $${params.length}`, params);
    const writes = await this.writesOf(r.rows.map((x) => x.operation_id));
    return r.rows.map((x) => this.record(x, writes.get(x.operation_id) ?? []));
  }

  /**
   * For Autotask audit events (a ticket change, a note) made by this MCP's API
   * user: the operation whose recorded write on the same entity is nearest in
   * time, within `windowMs`. Key = `${type}:${id}:${at}` of the target.
   */
  async linkEvents(targets: Array<{ type: string; id: number; at: string }>, windowMs = 5 * 60_000): Promise<Map<string, OperationRecord>> {
    const out = new Map<string, OperationRecord>();
    if (!targets.length) return out;
    const times = targets.map((t) => Date.parse(t.at)).filter(Number.isFinite);
    if (!times.length) return out;
    const r = await this.pool.query<WriteRow & OpRow>(
      `SELECT w.at AS w_at, w.entity_type AS w_type, w.entity_id AS w_id, o.* FROM mcp_operation_write w JOIN mcp_operation o ON o.operation_id = w.operation_id
       WHERE w.entity_type = ANY($1::text[]) AND w.entity_id = ANY($2::bigint[]) AND w.at BETWEEN $3 AND $4`,
      [[...new Set(targets.map((t) => t.type))], [...new Set(targets.map((t) => t.id))], new Date(Math.min(...times) - windowMs), new Date(Math.max(...times) + windowMs)],
    );
    const rows = r.rows as unknown as Array<OpRow & { w_at: Date; w_type: string; w_id: string }>;
    for (const t of targets) {
      const at = Date.parse(t.at);
      let best: (typeof rows)[number] | null = null;
      for (const x of rows) {
        if (x.w_type !== t.type || Number(x.w_id) !== t.id) continue;
        const d = Math.abs(new Date(x.w_at).getTime() - at);
        if (d <= windowMs && (!best || d < Math.abs(new Date(best.w_at).getTime() - at))) best = x;
      }
      if (best) out.set(`${t.type}:${t.id}:${t.at}`, this.record(best, []));
    }
    return out;
  }

  /** Drop operations older than `days` (their writes cascade). */
  async purge(days = 90): Promise<number> {
    const r = await this.pool.query(`DELETE FROM mcp_operation WHERE started_at < now() - make_interval(days => $1)`, [days]);
    return r.rowCount ?? 0;
  }
}
