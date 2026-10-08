// Wires the Postgres shadow into the running MCP: the store, the sync engine,
// the scheduler (one instance at a time via a Postgres advisory lock), the
// write hook (re-read rows the MCP just wrote), and the read path the search
// methods use. Entirely inert unless MCP_PG_ENABLED + MCP_PG_SHADOW_ENABLED.
//
// Env (defaults):
//   MCP_PG_SHADOW_INTERVAL_SECONDS   300   how often a sync run starts
//   MCP_PG_SHADOW_MAX_CALLS_PER_RUN  100   Autotask calls one run may spend
//   MCP_PG_SHADOW_PAUSE_AT_PCT       50    skip a run when the tenant's hourly
//                                           usage is at/above this % (Autotask
//                                           adds latency nearing its 10,000/h
//                                           per-database limit)
//   MCP_PG_SHADOW_RECONCILE_HOUR_UTC 7     hour of the nightly deletion sweep
//   MCP_PG_SHADOW_SERVE_READS        false answer search_* from the shadow
//   MCP_PG_SHADOW_MAX_AGE_SECONDS    900   ...only while it is at most this old
//   MCP_PG_SHADOW_HISTORY_MONTHS     6     backfill only this much history of
//                                           Tickets (plus every open ticket) and
//                                           TimeEntries; 0 = everything. Reads
//                                           reaching further back go live.

import { Logger } from '../utils/logger.js';
import { getPool } from './pool.js';
import { loadPgFlags } from './config.js';
import { ShadowStore, Freshness } from './shadow-store.js';
import { AuditLedger } from './audit-ledger.js';
import { ShadowSync, RunReport } from './shadow-sync.js';
import { SHADOW_ENTITIES, shadowEntity } from './shadow-entities.js';
import type { ShadowFilter } from './shadow-sql.js';
import { setWriteListener } from '../services/autotask-http.js';
import type { AutotaskService } from '../services/autotask.service.js';
import { runJob, noteShadowRead } from '../services/call-log.js';

const ADVISORY_KEY = 727_210_455; // "shadow sync" — distinct from the migration lock

const intEnv = (v: string | undefined, d: number): number => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; };

export interface ShadowRuntime {
  store: ShadowStore;
  /** Normalized audit event ledger (ticket history cache, webhook + row-diff events). */
  ledger: AuditLedger;
  sync: ShadowSync;
  serveReads: boolean;
  maxAgeSeconds: number;
  /** False pauses the scheduled sync (admin console). runNow still works. */
  syncEnabled: boolean;
  /** Run one sync now (under the lock). Returns null if another instance holds it. */
  runNow(): Promise<RunReport | null>;
  lastRun(): { at: string; report: RunReport } | null;
  stop(): void;
}

let runtime: ShadowRuntime | null = null;
export const getShadowRuntime = (): ShadowRuntime | null => runtime;

/** Which shadow row an Autotask write touched (path forms: /Tickets, /TimeEntries/123, /Companies/5/Contacts, /Projects/9/Tasks). */
export function writtenRow(path: string, body: unknown, response: unknown): { entity: string; id: number } | null {
  const segs = path.split('?')[0]!.split('/').filter(Boolean);
  if (!segs.length || segs[segs.length - 1] === 'query' || segs.includes('query')) return null;
  const childMap: Record<string, string> = { Contacts: 'Contacts', Services: 'ContractServices', Blocks: 'ContractBlocks', Tasks: 'Tasks', ToDos: 'CompanyToDos' };
  const entityName = segs.length >= 3 ? childMap[segs[2]!] : segs[0];
  const e = entityName ? shadowEntity(entityName) : undefined;
  if (!e) return null;
  const idFromPath = segs.length === 2 ? Number(segs[1]) : segs.length === 4 ? Number(segs[3]) : NaN;
  const b = body as { id?: unknown } | undefined, r = response as { itemId?: unknown } | undefined;
  const id = Number.isFinite(idFromPath) ? idFromPath : Number(b?.id ?? r?.itemId);
  return Number.isFinite(id) && id > 0 ? { entity: e.name, id } : null;
}

/** Start the shadow (no-op unless enabled). Safe to call once at server start. */
export function initShadow(service: AutotaskService, logger: Logger, env: NodeJS.ProcessEnv = process.env): ShadowRuntime | null {
  if (runtime) return runtime;
  if (!loadPgFlags(env).shadow) return null;
  const pool = getPool(logger, env);
  if (!pool) return null;
  const store = new ShadowStore(pool);
  const ledger = new AuditLedger(pool);
  store.onDiff = (events) => ledger.insert(events);
  const sync = new ShadowSync(() => service.httpClient(), store, logger, {
    maxCallsPerRun: intEnv(env.MCP_PG_SHADOW_MAX_CALLS_PER_RUN, 100),
    pauseAtPct: intEnv(env.MCP_PG_SHADOW_PAUSE_AT_PCT, 50),
    historyMonths: intEnv(env.MCP_PG_SHADOW_HISTORY_MONTHS, 6),
    usagePct: async () => { const u = await service.getApiUsage(); return 'usedPct' in u.autotask ? (u.autotask.usedPct ?? null) : null; },
  });
  const reconcileHour = intEnv(env.MCP_PG_SHADOW_RECONCILE_HOUR_UTC, 7);
  let last: { at: string; report: RunReport } | null = null;
  let running = false;

  const underLock = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    const client = await pool.connect();
    try {
      const got = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [ADVISORY_KEY]);
      if (!got.rows[0]?.ok) return null;
      try { return await fn(); } finally { await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_KEY]); }
    } finally { client.release(); }
  };

  const tick = async (): Promise<RunReport | null> => {
    if (running) return null;
    running = true;
    try {
      return await underLock(async () => {
        const now = new Date();
        const report = await runJob('shadow sync', () => sync.runOnce(now));
        // Nightly deletion sweep for the big tables, once per day in the configured hour.
        if (!report.skipped && now.getUTCHours() === reconcileHour) {
          for (const e of SHADOW_ENTITIES.filter((x) => x.watermarkField)) {
            const st = await store.getState(e.name);
            if (st?.backfill_done && (!st.last_reconcile_at || now.getTime() - new Date(st.last_reconcile_at).getTime() > 20 * 3600_000)) {
              report.entities.push(await runJob('shadow sync', () => sync.reconcile(e.name, 600, now)));
            }
          }
        }
        last = { at: now.toISOString(), report };
        logger.info(`shadow sync: ${report.skipped ?? `${report.calls} Autotask call(s); ${report.entities.filter((x) => x.rows).map((x) => `${x.entity} ${x.mode} ${x.rows}`).join(', ') || 'no changes'}`}`);
        return report;
      });
    } catch (err) {
      logger.error('shadow sync run failed (continuing)', err);
      return null;
    } finally { running = false; }
  };

  setWriteListener((method, path, body, response) => {
    if (method === 'GET') return;
    const w = writtenRow(path, body, response);
    if (w) sync.markDirty(w.entity, w.id);
  });

  const intervalMs = Math.max(30, intEnv(env.MCP_PG_SHADOW_INTERVAL_SECONDS, 300)) * 1000;
  const first = setTimeout(() => { if (runtime?.syncEnabled !== false) void tick(); }, 15_000);
  const timer = setInterval(() => { if (runtime?.syncEnabled !== false) void tick(); }, intervalMs);
  first.unref?.(); timer.unref?.();

  runtime = {
    store, ledger, sync,
    serveReads: String(env.MCP_PG_SHADOW_SERVE_READS).toLowerCase() === 'true',
    maxAgeSeconds: intEnv(env.MCP_PG_SHADOW_MAX_AGE_SECONDS, 900),
    syncEnabled: true,
    runNow: tick,
    lastRun: () => last,
    stop: () => { clearTimeout(first); clearInterval(timer); setWriteListener(null); runtime = null; },
  };
  logger.info(`Postgres shadow enabled: sync every ${intervalMs / 1000}s, ≤${intEnv(env.MCP_PG_SHADOW_MAX_CALLS_PER_RUN, 100)} calls/run, pause at ${intEnv(env.MCP_PG_SHADOW_PAUSE_AT_PCT, 50)}% usage, serve reads: ${runtime.serveReads}`);
  return runtime;
}

const freshCache = new Map<string, { at: number; f: Freshness }>();

/**
 * Answer a search from the shadow, or null to go live. Only when serving reads
 * is on, the entity is mirrored, backfilled, and fresh enough, and every
 * filter translates to SQL. Rows come back in ascending id order, like Autotask.
 */
export async function shadowRead<T>(entity: string, filters: ShadowFilter[], limit: number): Promise<{ rows: T[]; ageSeconds: number } | null> {
  const rt = runtime;
  if (!rt?.serveReads || !shadowEntity(entity)) return null;
  try {
    const name = shadowEntity(entity)!.name;
    let c = freshCache.get(name);
    if (!c || Date.now() - c.at > 15_000) { c = { at: Date.now(), f: await rt.store.freshness(name) }; freshCache.set(name, c); }
    const f = c.f;
    if (!f.ready || f.ageSeconds == null || f.ageSeconds + Math.round((Date.now() - c.at) / 1000) > rt.maxAgeSeconds) return null;
    // A windowed mirror only holds recent history: serve only queries whose
    // filters stay inside it (e.g. open tickets, dateWorked ≥ window start).
    const def = shadowEntity(entity)!;
    if (f.windowFrom && def.windowCovers && !def.windowCovers(filters, f.windowFrom)) return null;
    const r = await rt.store.query(name, filters, { limit, order: 'id_asc' });
    noteShadowRead(name);
    return { rows: r.rows as T[], ageSeconds: f.ageSeconds };
  } catch {
    return null; // unsupported filter, PG hiccup — the live API answers instead
  }
}

/** Test hook. */
export function _setShadowRuntime(rt: ShadowRuntime | null): void { runtime = rt; freshCache.clear(); }
