// Keeps the console's hourly traffic counts (Reads by entity, Tool gaps) in
// Postgres (migration 0013) so they survive restarts and deploys. At start the
// last 7 days are added back into memory; every few minutes the current and
// previous hour are written. Never blocks or breaks the server: with Postgres
// down or the table missing, the counts are kept in memory only.

import type { Pool } from 'pg';
import { Logger } from '../utils/logger.js';
import { restoreStats, snapshotStats, type StatRow } from '../services/call-log.js';

type Queryable = Pick<Pool, 'query'>;
const KEEP_HOURS = 168;
const nowHour = () => Math.floor(Date.now() / 3_600_000);

export async function loadStats(db: Queryable): Promise<StatRow[]> {
  const r = await db.query<{ hour: number; kind: StatRow['kind']; key: string; data: Record<string, unknown> }>(
    'SELECT hour, kind, key, data FROM mcp_call_stat_hour WHERE hour > $1', [nowHour() - KEEP_HOURS]);
  return r.rows.map((x) => ({ hour: Number(x.hour), kind: x.kind, key: x.key, data: x.data }));
}

/** Upsert the given hours' counts (the full count for each hour, not a delta). */
export async function saveStats(db: Queryable, rows: StatRow[]): Promise<number> {
  for (let i = 0; i < rows.length; i += 500) {
    const part = rows.slice(i, i + 500);
    await db.query(
      `INSERT INTO mcp_call_stat_hour (hour, kind, key, data, updated_at)
       SELECT * , now() FROM unnest($1::int[], $2::text[], $3::text[], $4::jsonb[])
       ON CONFLICT (hour, kind, key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [part.map((r) => r.hour), part.map((r) => r.kind), part.map((r) => r.key), part.map((r) => JSON.stringify(r.data))],
    );
  }
  return rows.length;
}

/** Restore, then persist every `intervalMs`. Returns a stop function. */
export async function startCallStatsPersistence(db: Queryable, logger: Logger, intervalMs = 5 * 60_000): Promise<() => void> {
  try {
    const rows = await Promise.race([loadStats(db), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out')), 5000))]);
    const n = restoreStats(rows);
    if (n) logger.info(`Console traffic counts: restored ${n} hourly counter(s) from the last 7 days`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(/mcp_call_stat_hour/.test(msg) ? 'Console traffic counts: table missing — run the migrations (0013); counts are kept in memory only' : `Console traffic counts: could not load (${msg}); kept in memory only`);
    return () => undefined;
  }
  let lastPrune = 0;
  const flush = async () => {
    try {
      await saveStats(db, snapshotStats(nowHour() - 1));
      if (Date.now() - lastPrune > 6 * 3_600_000) { await db.query('DELETE FROM mcp_call_stat_hour WHERE hour < $1', [nowHour() - KEEP_HOURS - 24]); lastPrune = Date.now(); }
    } catch (err) { logger.warn('Console traffic counts: save failed (continuing)', err); }
  };
  const t = setInterval(() => { void flush(); }, intervalMs);
  t.unref?.();
  activeFlush = flush;
  return () => { clearInterval(t); activeFlush = null; };
}

let activeFlush: (() => Promise<void>) | null = null;

/** Save the current counts now — the server calls this on shutdown so a deploy keeps the last few minutes. */
export async function flushCallStats(): Promise<void> {
  if (activeFlush) await activeFlush();
}
