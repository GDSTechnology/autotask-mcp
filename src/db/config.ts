// PostgreSQL configuration + capability flags (Expansion Spec §17, issue #18).
//
// The whole layer is OFF unless MCP_PG_ENABLED=true. Each capability is behind its
// own independent flag so features can be rolled out one at a time. Nothing here
// opens a connection — see db/pool.ts.

function boolEnv(v: string | undefined): boolean {
  return String(v).toLowerCase() === 'true';
}

function intEnv(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export type PgSslMode = false | 'require';

export interface PgConfig {
  host: string;
  port: number;
  database: string;
  schema: string;
  user: string;
  password: string;
  ssl: PgSslMode;
  poolMax: number;
}

export interface PgFlags {
  audit: boolean;
  jobs: boolean;
  shadow: boolean;
  snapshots: boolean;
  identity: boolean;
  pricing: boolean;
  webhookBuffer: boolean;
}

/** Master switch. When false, no connection is ever opened and every flag is inert. */
export function isPgEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return boolEnv(env.MCP_PG_ENABLED);
}

function parseSsl(v: string | undefined): PgSslMode {
  const s = String(v).toLowerCase();
  return s === 'require' || s === 'true' ? 'require' : false;
}

/**
 * Load the connection config. Throws only when the layer is enabled but a
 * required value is missing — a misconfigured-but-enabled PG should fail loudly
 * at startup, not silently connect wrong.
 */
export function loadPgConfig(env: NodeJS.ProcessEnv = process.env): PgConfig {
  const password = env.MCP_PG_PASSWORD ?? '';
  const user = env.MCP_PG_USER ?? 'gds_autotask_mcp_app';
  if (isPgEnabled(env) && !password) {
    throw new Error('MCP_PG_ENABLED=true but MCP_PG_PASSWORD is not set.');
  }
  return {
    host: env.MCP_PG_HOST ?? 'localhost',
    port: intEnv(env.MCP_PG_PORT, 5432),
    database: env.MCP_PG_DATABASE ?? 'gds_autotask_mcp',
    schema: env.MCP_PG_SCHEMA ?? 'autotask_mcp',
    user,
    password,
    ssl: parseSsl(env.MCP_PG_SSL),
    poolMax: intEnv(env.MCP_PG_POOL_MAX, 10),
  };
}

export interface MigratorConfig {
  host: string;
  port: number;
  database: string;
  schema: string;
  user: string;
  password: string;
  ssl: PgSslMode;
  /** Group role that owns migrated objects (so app default privileges apply). */
  owner: string;
}

/**
 * Connection config for the migration runner — the DDL-capable `migrator` login,
 * separate from the runtime `app` role. Same host/db as the app; distinct
 * credentials. Throws if the migrator password is missing.
 */
export function loadMigratorConfig(env: NodeJS.ProcessEnv = process.env): MigratorConfig {
  const app = loadPgConfig(env);
  const password = env.MCP_PG_MIGRATOR_PASSWORD ?? '';
  if (!password) {
    throw new Error('Migrations require MCP_PG_MIGRATOR_PASSWORD (the DDL migrator login).');
  }
  return {
    host: app.host,
    port: app.port,
    database: app.database,
    schema: app.schema,
    user: env.MCP_PG_MIGRATOR_USER ?? 'gds_autotask_mcp_migrator',
    password,
    ssl: app.ssl,
    owner: env.MCP_PG_OWNER ?? 'gds_autotask_mcp_owner',
  };
}

/** Load capability flags. Any flag is inert unless the master switch is also on. */
export function loadPgFlags(env: NodeJS.ProcessEnv = process.env): PgFlags {
  const on = isPgEnabled(env);
  const flag = (v: string | undefined) => on && boolEnv(v);
  return {
    audit: flag(env.MCP_PG_AUDIT_ENABLED),
    jobs: flag(env.MCP_PG_JOBS_ENABLED),
    shadow: flag(env.MCP_PG_SHADOW_ENABLED),
    snapshots: flag(env.MCP_PG_SNAPSHOTS_ENABLED),
    identity: flag(env.MCP_PG_IDENTITY_ENABLED),
    pricing: flag(env.MCP_PG_PRICING_ENABLED),
    webhookBuffer: flag(env.MCP_PG_WEBHOOK_BUFFER_ENABLED),
  };
}
