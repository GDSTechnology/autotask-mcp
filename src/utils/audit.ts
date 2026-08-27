// Structured audit logging for every tool invocation (Expansion Spec §23).
//
// Log-only for now (goes to the structured logger → stderr JSON). When the
// optional PostgreSQL audit layer is enabled (MCP_PG_AUDIT_ENABLED), these
// entries are also persisted; the shape here is the source of truth for that.

import { Logger } from './logger';
import { CallerContext } from '../types/context';

export type AuditOutcome = 'ok' | 'error' | 'not-found';

export interface AuditEntry {
  tool: string;
  outcome: AuditOutcome;
  durationMs: number;
  /** Best-effort resolved target id (e.g. a create's new id). */
  resultId?: number;
  error?: string;
}

/**
 * Emit one structured audit record correlating the caller (who/where) with the
 * tool invocation and its outcome. Never include secrets or full sensitive
 * bodies (§23).
 */
export function emitAudit(logger: Logger, ctx: CallerContext, entry: AuditEntry): void {
  logger.info('audit', {
    audit: true,
    tool: entry.tool,
    outcome: entry.outcome,
    durationMs: entry.durationMs,
    source: ctx.source,
    correlationId: ctx.correlationId,
    ...(ctx.requestingUserEmail ? { requestingUserEmail: ctx.requestingUserEmail } : {}),
    ...(ctx.autotaskResourceId !== undefined ? { autotaskResourceId: ctx.autotaskResourceId } : {}),
    ...(ctx.idempotencyKey ? { idempotencyKey: ctx.idempotencyKey } : {}),
    ...(ctx.intent ? { intent: ctx.intent } : {}),
    ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
    ...(entry.resultId !== undefined ? { resultId: entry.resultId } : {}),
    ...(entry.error ? { error: entry.error } : {}),
  });
}
