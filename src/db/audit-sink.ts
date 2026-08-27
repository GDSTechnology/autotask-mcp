// PostgreSQL audit sink (Expansion Spec §23, issue #18).
//
// When MCP_PG_AUDIT_ENABLED (and the master switch) is on, each audit record is
// also written to the `audit_log` table, in addition to the structured stderr
// log (which is always emitted). Writes are fire-and-forget and best-effort:
// audit persistence must never block or fail a tool call.

import { Pool } from 'pg';
import { Logger } from '../utils/logger.js';
import { CallerContext } from '../types/context.js';
import { AuditEntry } from '../utils/audit.js';
import { getPool } from './pool.js';
import { loadPgFlags } from './config.js';

export interface AuditSink {
  record(ctx: CallerContext, entry: AuditEntry): void;
}

const INSERT_SQL = `INSERT INTO audit_log
  (tool, outcome, duration_ms, source, correlation_id, requesting_user_email,
   autotask_resource_id, conversation_id, idempotency_key, intent, result_id, error)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`;

/** Ordered parameter values for INSERT_SQL. Pure — unit-tested without a database. */
export function auditRowValues(ctx: CallerContext, entry: AuditEntry): unknown[] {
  return [
    entry.tool,
    entry.outcome,
    entry.durationMs,
    ctx.source,
    ctx.correlationId ?? null,
    ctx.requestingUserEmail ?? null,
    ctx.autotaskResourceId ?? null,
    ctx.conversationId ?? null,
    ctx.idempotencyKey ?? null,
    ctx.intent ?? null,
    entry.resultId ?? null,
    entry.error ?? null,
  ];
}

export class PgAuditSink implements AuditSink {
  constructor(
    private readonly pool: Pool,
    private readonly logger: Logger
  ) {}

  record(ctx: CallerContext, entry: AuditEntry): void {
    // Fire-and-forget: never block the caller, never throw. A failed audit write
    // is logged and dropped — the structured log already captured the event.
    this.pool.query(INSERT_SQL, auditRowValues(ctx, entry)).catch((err) => {
      this.logger.warn('PG audit write failed (continuing)', err);
    });
  }
}

/** Build the audit sink when PG + the audit flag are enabled, else null (no-op). */
export function createAuditSink(logger: Logger, env: NodeJS.ProcessEnv = process.env): AuditSink | null {
  if (!loadPgFlags(env).audit) return null;
  const pool = getPool(logger, env);
  return pool ? new PgAuditSink(pool, logger) : null;
}
