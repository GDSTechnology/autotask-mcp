// Migration runner (Expansion Spec §17.2, issue #18).
//
// Runs the ordered SQL files in `migrations/` against the dedicated database as
// the DDL-capable `migrator` login, which SET ROLEs to `owner` so every created
// object is owner-owned and inherits the app role's default DML grants.
//
// Safety: a session advisory lock serializes concurrent runners; a checksum
// registry (`schema_migrations`) records what ran and FAILS CLOSED if a
// previously-applied file's content has changed (drift). Idempotent — re-running
// applies only new files.

import { Client } from 'pg';
import { createHash } from 'crypto';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { Logger } from '../utils/logger.js';
import { loadMigratorConfig, MigratorConfig } from './config.js';

// Stable lock key for this schema's migrations (arbitrary constant).
const ADVISORY_LOCK_KEY = 4820_1971;

export interface MigrationFile {
  name: string;
  content: string;
  checksum: string;
}

export function computeChecksum(content: string): string {
  // Normalize line endings so a CRLF/LF flip is not seen as drift.
  return createHash('sha256').update(content.replace(/\r\n/g, '\n')).digest('hex');
}

/** Load and order the .sql migration files from a directory. */
export function loadMigrationFiles(dir: string): MigrationFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const content = readFileSync(join(dir, name), 'utf8');
      return { name, content, checksum: computeChecksum(content) };
    });
}

export function migrationsDir(): string {
  // dist/db/migrate.js → repo root → migrations/
  return resolve(__dirname, '..', '..', 'migrations');
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(
  logger: Logger,
  env: NodeJS.ProcessEnv = process.env,
  dir: string = migrationsDir()
): Promise<MigrateResult> {
  const cfg: MigratorConfig = loadMigratorConfig(env);
  const files = loadMigrationFiles(dir);
  const applied: string[] = [];
  const skipped: string[] = [];

  const client = new Client({
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    ssl: cfg.ssl === 'require' ? { rejectUnauthorized: false } : false,
  });

  await client.connect();
  try {
    // Own everything we create so the app role's default privileges apply.
    await client.query(`SET ROLE ${quoteIdent(cfg.owner)}`);
    await client.query(`SET search_path TO ${quoteIdent(cfg.schema)}, public`);
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);

    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name        text PRIMARY KEY,
         checksum    text NOT NULL,
         applied_at  timestamptz NOT NULL DEFAULT now()
       )`
    );

    for (const file of files) {
      const prior = await client.query<{ checksum: string }>(
        'SELECT checksum FROM schema_migrations WHERE name = $1',
        [file.name]
      );
      if (prior.rowCount && prior.rowCount > 0) {
        if (prior.rows[0].checksum !== file.checksum) {
          throw new Error(
            `Migration drift: ${file.name} was already applied with a different checksum. ` +
              `Applied migrations are immutable — add a new migration instead of editing this one.`
          );
        }
        skipped.push(file.name);
        continue;
      }
      logger.info(`Applying migration ${file.name}`);
      await client.query('BEGIN');
      try {
        await client.query(file.content);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
          file.name,
          file.checksum,
        ]);
        await client.query('COMMIT');
        applied.push(file.name);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
    } catch {
      /* best-effort */
    }
    await client.end();
  }

  return { applied, skipped };
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid PostgreSQL identifier: ${JSON.stringify(name)}`);
  }
  return `"${name}"`;
}

// --- CLI ---------------------------------------------------------------------
function loadDotEnv(): void {
  const path = resolve(process.cwd(), '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i === -1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  const logger = new Logger((process.env.LOG_LEVEL as any) || 'info');
  const result = await runMigrations(logger, process.env);
  logger.info(
    `Migrations complete. Applied ${result.applied.length} (${result.applied.join(', ') || 'none'}), ` +
      `skipped ${result.skipped.length}.`
  );
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Migration failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
