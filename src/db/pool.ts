// Lazy PostgreSQL connection pool (Expansion Spec §17, issue #18).
//
// A single process-wide pool, created on first use only when the layer is
// enabled. When PG is disabled or unreachable the callers get null / a not-ok
// health result — the MCP must never hard-fail because Postgres is unavailable
// (degraded modes, §24).

import { Pool, PoolConfig } from 'pg';
import { Logger } from '../utils/logger.js';
import { loadPgConfig, isPgEnabled } from './config.js';

let pool: Pool | null = null;

/** Quote a schema identifier, rejecting anything that isn't a plain identifier. */
function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid PostgreSQL identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

/** Get the shared pool, or null when the layer is disabled. Never throws on disabled. */
export function getPool(logger: Logger, env: NodeJS.ProcessEnv = process.env): Pool | null {
  if (!isPgEnabled(env)) return null;
  if (pool) return pool;

  const cfg = loadPgConfig(env);
  const schema = quoteIdent(cfg.schema);
  const poolConfig: PoolConfig = {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    max: cfg.poolMax,
    ssl: cfg.ssl === 'require' ? { rejectUnauthorized: false } : false,
  };

  pool = new Pool(poolConfig);
  // Scope every physical connection to our schema.
  pool.on('connect', (client) => {
    client.query(`SET search_path TO ${schema}, public`).catch((err) => {
      logger.warn('PG: failed to set search_path', err);
    });
  });
  // A pool-level error (e.g. an idle client dropped) must not crash the process.
  pool.on('error', (err) => logger.error('PG pool error (continuing)', err));
  logger.info(`PG pool created: ${cfg.user}@${cfg.host}:${cfg.port}/${cfg.database} schema=${cfg.schema}`);
  return pool;
}

export interface PgHealth {
  enabled: boolean;
  ok: boolean;
  latencyMs?: number;
  serverVersion?: string;
  error?: string;
}

/** Round-trip check. Returns { enabled:false } when the layer is off — not an error. */
export async function pgHealthCheck(logger: Logger, env: NodeJS.ProcessEnv = process.env): Promise<PgHealth> {
  if (!isPgEnabled(env)) return { enabled: false, ok: false };
  const p = getPool(logger, env);
  if (!p) return { enabled: false, ok: false };

  const started = Date.now();
  try {
    const res = await p.query<{ v: string }>('select version() as v');
    return { enabled: true, ok: true, latencyMs: Date.now() - started, serverVersion: res.rows[0]?.v };
  } catch (err) {
    return {
      enabled: true,
      ok: false,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Close the pool (tests / shutdown). Safe to call when never opened. */
export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
