// Tool-call side of the operation log (MCP-007): which calls can write, the
// payload digest an idempotency key is bound to, the `_operation` block
// returned to callers, and the answers to a key that was already used.

import { createHash } from 'node:crypto';
import { isMutatingTool, stableStringify } from './idempotency.js';
import type { OperationWrite } from './operation-context.js';
import type { ClaimResult, OperationInput, OperationRecord } from '../db/operation-store.js';

/**
 * Can this call write to Autotask? Mutating tools, raw_request with a write
 * method on a non-query path, and the find-or-create tools (named like reads).
 */
export function mayWrite(name: string, args: Record<string, unknown>): boolean {
  if (name === 'autotask_raw_request') {
    const m = String(args.method ?? 'GET').toUpperCase();
    return m !== 'GET' && !/\/query(?:$|[/?])/i.test(String(args.path ?? ''));
  }
  if (name.includes('_find_or_create_')) return true;
  return isMutatingTool(name);
}

/** The payload an idempotency key is bound to: same key + different payload is a conflict, not a replay. */
export function argsDigest(args: Record<string, unknown>): string {
  return createHash('sha256').update(stableStringify(args)).digest('hex').slice(0, 32);
}

export interface OperationSummary {
  operationId: string;
  correlationId: string;
  decisionId?: string;
  idempotencyKey?: string;
  refs?: Record<string, string>;
  writes: Array<{ method: string; entityType: string | null; entityId: number | null; parentType?: string | null; parentId?: number | null; at: string }>;
  replayed?: boolean;
}

export function operationSummary(op: Pick<OperationInput, 'operationId' | 'correlationId' | 'decisionId' | 'idempotencyKey' | 'refs'>, writes: OperationWrite[]): OperationSummary {
  return {
    operationId: op.operationId, correlationId: op.correlationId,
    ...(op.decisionId ? { decisionId: op.decisionId } : {}),
    ...(op.idempotencyKey ? { idempotencyKey: op.idempotencyKey } : {}),
    ...(op.refs ? { refs: op.refs } : {}),
    writes: writes.map((w) => ({ method: w.method, entityType: w.entityType, entityId: w.entityId, ...(w.parentId != null ? { parentType: w.parentType, parentId: w.parentId } : {}), at: w.at })),
  };
}

/** Add `_operation` to a tool's JSON response text (left unchanged if it isn't a JSON object). */
export function withOperation(responseText: string, summary: OperationSummary): string {
  try {
    const obj = JSON.parse(responseText) as unknown;
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return JSON.stringify({ ...(obj as Record<string, unknown>), _operation: summary });
  } catch { /* not JSON */ }
  return responseText;
}

const fromRecord = (r: OperationRecord, extra: Partial<OperationSummary> = {}): OperationSummary => ({
  ...operationSummary({ operationId: r.operationId, correlationId: r.correlationId, decisionId: r.decisionId ?? undefined, idempotencyKey: r.idempotencyKey ?? undefined, refs: r.refs ?? undefined }, r.writes),
  ...extra,
});

/** The tool result for a key that was already used: the stored result (replay) or why nothing was done. */
export function operationClaimResult(c: Exclude<ClaimResult, { status: 'claimed' }>, key: string): { content: Array<{ type: 'text'; text: string }> } {
  const text = (o: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(o) }] });
  if (c.status === 'replay') {
    const summary = fromRecord(c.operation, { replayed: true });
    if (c.resultText) {
      const replayed = withOperation(c.resultText, summary);
      if (replayed !== c.resultText) return { content: [{ type: 'text', text: replayed }] };
    }
    return text({ message: `Already done under idempotency key "${key}" (operation ${c.operation.operationId}, ${c.operation.finishedAt}) — not run again.`, data: null, _operation: summary });
  }
  const why: Record<typeof c.status, string> = {
    conflict: `idempotency key "${key}" was already used by ${c.operation.tool} with a different payload — nothing done. Use a new key for a different action.`,
    in_progress: `idempotency key "${key}" is being executed right now (operation ${c.operation.operationId}, started ${c.operation.startedAt}) — nothing done. Retry after it finishes to get its result.`,
    incomplete: `idempotency key "${key}": an earlier attempt (operation ${c.operation.operationId}, started ${c.operation.startedAt}) never finished — its outcome is unknown, so it is NOT re-run. Check the writes listed, then use a new key.`,
    partial: `idempotency key "${key}": an earlier attempt failed AFTER writing to Autotask (operation ${c.operation.operationId}: ${c.operation.error ?? 'error'}) — NOT re-run, so nothing is written twice. Check the writes listed, then use a new key.`,
  };
  const status = { conflict: 'idempotency_conflict', in_progress: 'in_progress', incomplete: 'previous_attempt_incomplete', partial: 'previous_attempt_partial' }[c.status];
  return text({ message: `Nothing done: ${why[c.status]}`, data: { status, operation: fromRecord(c.operation) } });
}
