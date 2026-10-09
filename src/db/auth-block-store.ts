// Saves the Autotask login-protection pause in Postgres (migration 0006) so a
// restart or deploy during a lockout doesn't start with a clean slate and spend
// more failed logins. Loaded once at startup, before any Autotask call.

import type { Pool } from 'pg';
import { Logger } from '../utils/logger.js';
import { restoreAuthBlocks, setAuthBlockPersistence, type PersistedAuthBlock } from '../services/autotask-http.js';

type Queryable = Pick<Pool, 'query'>;

export async function loadSavedAuthBlocks(db: Queryable): Promise<PersistedAuthBlock[]> {
  const r = await db.query<{ tenant: string; since: Date; until: Date | null; failures: number; last_error: string; held: boolean; fp: string | null }>(
    'SELECT tenant, since, until, failures, last_error, held, fp FROM autotask_auth_block',
  );
  return r.rows.map((x) => ({
    tenant: x.tenant, since: new Date(x.since).getTime(), until: x.until ? new Date(x.until).getTime() : null,
    failures: Number(x.failures), lastError: x.last_error, held: !!x.held, fp: x.fp,
  }));
}

export async function saveAuthBlock(db: Queryable, tenant: string, b: PersistedAuthBlock | null): Promise<void> {
  if (!b) { await db.query('DELETE FROM autotask_auth_block WHERE tenant = $1', [tenant]); return; }
  await db.query(
    `INSERT INTO autotask_auth_block (tenant, since, until, failures, last_error, held, fp, updated_at)
     VALUES ($1, to_timestamp($2 / 1000.0), CASE WHEN $3::bigint IS NULL THEN NULL ELSE to_timestamp($3::bigint / 1000.0) END, $4, $5, $6, $7, now())
     ON CONFLICT (tenant) DO UPDATE SET since = EXCLUDED.since, until = EXCLUDED.until, failures = EXCLUDED.failures,
       last_error = EXCLUDED.last_error, held = EXCLUDED.held, fp = EXCLUDED.fp, updated_at = now()`,
    [tenant, b.since, b.until, b.failures, b.lastError, b.held, b.fp],
  );
}

/**
 * Restore saved pauses and save future ones. Never blocks startup for long:
 * with Postgres down or the table missing, the in-memory protection still works.
 */
export async function initAuthBlockStore(db: Queryable, logger: Logger): Promise<void> {
  try {
    const rows = await Promise.race([
      loadSavedAuthBlocks(db),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timed out')), 5000)),
    ]);
    restoreAuthBlocks(rows);
    for (const r of rows) {
      logger.warn(`Autotask login protection: restored a saved ${r.held ? 'HOLD' : 'pause'} for ${r.tenant} (${r.failures} rejected login(s) since ${new Date(r.since).toISOString()}) — ${r.held ? 'press "Retry now" in the admin console once the account is fixed' : 'one test call when it ends'}`);
    }
    setAuthBlockPersistence({ save: (tenant, b) => saveAuthBlock(db, tenant, b) });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(/autotask_auth_block/.test(msg) ? 'Autotask login protection: table missing — run the migrations (0006); the pause is kept in memory only' : `Autotask login protection: could not load saved pauses (${msg}); kept in memory only`);
  }
}
