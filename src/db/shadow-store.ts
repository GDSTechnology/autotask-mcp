// Postgres access for the Autotask shadow (read-only mirror). All SQL lives
// here; the sync engine and the tools call these methods. Every query result
// carries the entity's freshness so callers can say how old the answer is.

import { Pool } from 'pg';
import { ShadowEntity, modifiedAt } from './shadow-entities.js';
import { ShadowFilter, SqlBuilder, assertField, groupExpr, whereClause } from './shadow-sql.js';

export interface SyncState {
  entity: string;
  watermark: Date | null;
  backfill_cursor: number;
  backfill_done: boolean;
  window_from: Date | null;
  last_backfill_at: Date | null;
  last_incremental_at: Date | null;
  last_full_at: Date | null;
  last_reconcile_at: Date | null;
  row_count: number;
  api_calls_total: number;
  last_error: string | null;
  last_error_at: Date | null;
}

export interface Freshness { entity: string; ready: boolean; lastSyncedAt: string | null; ageSeconds: number | null; rows: number; /** Oldest history mirrored (YYYY-MM-DD) for windowed entities; null = everything. */ windowFrom: string | null }

const MAX_LIMIT = 5000;

/** The sync-state columns saveState may set (column names are never caller-supplied). */
const STATE_COLUMNS = new Set(['watermark', 'window_from', 'backfill_cursor', 'backfill_done', 'last_backfill_at', 'last_incremental_at', 'last_full_at', 'last_reconcile_at', 'last_error', 'last_error_at']);

export class ShadowStore {
  constructor(private readonly pool: Pool) {}

  /** Insert or update rows (a revived row loses its deleted mark). Returns the count written. */
  async upsert(entity: ShadowEntity, rows: Array<Record<string, unknown>>): Promise<number> {
    if (!rows.length) return 0;
    const ids: number[] = [], datas: string[] = [], mods: Array<string | null> = [];
    for (const r of rows) {
      const id = Number(r.id);
      if (!Number.isFinite(id)) continue;
      ids.push(id);
      datas.push(JSON.stringify(r));
      mods.push(modifiedAt(entity, r)?.toISOString() ?? null);
    }
    await this.pool.query(
      `INSERT INTO shadow_record (entity, id, data, modified_at, synced_at, deleted_at)
       SELECT $1, u.id, u.data::jsonb, u.mod::timestamptz, now(), NULL
         FROM unnest($2::bigint[], $3::text[], $4::text[]) AS u(id, data, mod)
       ON CONFLICT (entity, id) DO UPDATE
         SET data = EXCLUDED.data, modified_at = EXCLUDED.modified_at, synced_at = now(), deleted_at = NULL`,
      [entity.name, ids, datas, mods],
    );
    return ids.length;
  }

  /** Mark rows deleted (Autotask no longer returns them). */
  async markDeleted(entity: string, ids: number[]): Promise<number> {
    if (!ids.length) return 0;
    const r = await this.pool.query(`UPDATE shadow_record SET deleted_at = now() WHERE entity = $1 AND id = ANY($2::bigint[]) AND deleted_at IS NULL`, [entity, ids]);
    return r.rowCount ?? 0;
  }

  /** Every live id for an entity (reconcile compares this with Autotask's id list). */
  async liveIds(entity: string): Promise<number[]> {
    const r = await this.pool.query<{ id: string }>(`SELECT id FROM shadow_record WHERE entity = $1 AND deleted_at IS NULL`, [entity]);
    return r.rows.map((x) => Number(x.id));
  }

  async getState(entity: string): Promise<SyncState | null> {
    const r = await this.pool.query<SyncState>(`SELECT * FROM shadow_sync_state WHERE entity = $1`, [entity]);
    const s = r.rows[0];
    return s ? { ...s, backfill_cursor: Number(s.backfill_cursor), row_count: Number(s.row_count), api_calls_total: Number(s.api_calls_total) } : null;
  }

  async allStates(): Promise<SyncState[]> {
    const r = await this.pool.query<SyncState>(`SELECT * FROM shadow_sync_state ORDER BY entity`);
    return r.rows.map((s) => ({ ...s, backfill_cursor: Number(s.backfill_cursor), row_count: Number(s.row_count), api_calls_total: Number(s.api_calls_total) }));
  }

  /** Merge fields into an entity's sync state (creating it), refreshing row_count. */
  async saveState(entity: string, patch: Partial<Omit<SyncState, 'entity' | 'row_count'>> & { apiCalls?: number }): Promise<void> {
    const { apiCalls = 0, ...fields } = patch;
    const cols = Object.keys(fields).filter((c) => STATE_COLUMNS.has(c));
    const sets = cols.map((c, i) => `${c} = $${i + 3}`);
    await this.pool.query(`INSERT INTO shadow_sync_state (entity) VALUES ($1) ON CONFLICT (entity) DO NOTHING`, [entity]);
    await this.pool.query(
      `UPDATE shadow_sync_state SET api_calls_total = api_calls_total + $2${sets.length ? ', ' + sets.join(', ') : ''},
         row_count = (SELECT count(*) FROM shadow_record WHERE entity = $1 AND deleted_at IS NULL), updated_at = now()
       WHERE entity = $1`,
      [entity, apiCalls, ...cols.map((c) => (fields as Record<string, unknown>)[c])],
    );
  }

  /** How fresh an entity's mirror is: ready once backfilled; age = since the last successful sync of any kind. */
  async freshness(entity: string): Promise<Freshness> {
    const s = await this.getState(entity);
    const last = [s?.last_incremental_at, s?.last_full_at, s?.last_backfill_at].filter(Boolean).map((d) => new Date(d as Date).getTime());
    const at = last.length ? Math.max(...last) : null;
    return {
      entity, ready: !!s?.backfill_done, rows: s?.row_count ?? 0,
      windowFrom: s?.window_from ? new Date(s.window_from).toISOString().slice(0, 10) : null,
      lastSyncedAt: at ? new Date(at).toISOString() : null,
      ageSeconds: at ? Math.round((Date.now() - at) / 1000) : null,
    };
  }

  /** Rows matching Autotask-style filters (live rows only), newest-id first unless orderBy is given. */
  async query(entity: string, filters: ShadowFilter[], opts: { fields?: string[]; limit?: number; offset?: number; orderBy?: string; desc?: boolean; order?: 'id_asc' | 'id_desc' } = {}): Promise<{ rows: Array<Record<string, unknown>>; total: number }> {
    const b = new SqlBuilder();
    const ent = b.bind(entity);
    const where = whereClause(filters, b);
    const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), MAX_LIMIT);
    const offset = Math.max(Number(opts.offset) || 0, 0);
    const order = opts.orderBy ? `${groupExpr(opts.orderBy).sql} ${opts.desc ? 'DESC' : 'ASC'} NULLS LAST, id` : opts.order === 'id_asc' ? 'id ASC' : 'id DESC';
    const select = opts.fields?.length
      ? `jsonb_build_object(${opts.fields.map((f) => { const ff = assertField(f); return `'${ff}', data->'${ff}'`; }).join(', ')}, 'id', id)`
      : 'data';
    const base = `FROM shadow_record WHERE entity = ${ent} AND deleted_at IS NULL AND ${where}`;
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n ${base}`, b.params);
    const rows = await this.pool.query<{ r: Record<string, unknown> }>(`SELECT ${select} AS r ${base} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, b.params);
    return { rows: rows.rows.map((x) => x.r), total: Number(total.rows[0]?.n ?? 0) };
  }

  /** GROUP BY over the mirror: counts and numeric sums, e.g. hours by contract by month. */
  async aggregate(entity: string, filters: ShadowFilter[], groupBy: string[], sums: string[], limit = 1000): Promise<Array<Record<string, unknown>>> {
    const b = new SqlBuilder();
    const ent = b.bind(entity);
    const where = whereClause(filters, b);
    const groups = groupBy.map(groupExpr);
    const sumCols = sums.map((s) => { const f = assertField(s); return `round(coalesce(sum(NULLIF(data->>'${f}', '')::numeric), 0), 2) AS "sum_${f}"`; });
    const cols = [...groups.map((g) => `${g.sql} AS "${g.alias}"`), 'count(*) AS "count"', ...sumCols];
    const groupSql = groups.length ? `GROUP BY ${groups.map((_, i) => i + 1).join(', ')} ORDER BY ${groups.map((_, i) => i + 1).join(', ')}` : '';
    const r = await this.pool.query(`SELECT ${cols.join(', ')} FROM shadow_record WHERE entity = ${ent} AND deleted_at IS NULL AND ${where} ${groupSql} LIMIT ${Math.min(Math.max(limit, 1), 10000)}`, b.params);
    return r.rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, k === 'count' || k.startsWith('sum_') ? Number(v) : v])));
  }
}
