// Caller context for multi-user safety (Expansion Spec §3.5 / §4).
//
// The Autotask API user is only the transport identity — it is NOT the person
// who requested an action. ChatGPT and Hermes-in-Teams pass per-request caller
// context (who, from where, correlation/idempotency, intent) either via the
// MCP request `_meta` or a reserved `_context` key in the tool arguments. This
// context is the substrate for audit logging (§23) and, later, permission
// intersection (§4.2) and idempotency (§4.4).

import { randomUUID } from 'node:crypto';

export type CallerSource = 'chatgpt' | 'hermes-teams' | 'unknown';

export interface CallerContext {
  source: CallerSource;
  requestingUserEmail?: string;
  teamsObjectId?: string;
  autotaskResourceId?: number;
  conversationId?: string;
  correlationId: string;
  idempotencyKey?: string;
  intent?: string;
  timestamp: string;
}

const VALID_SOURCES: readonly CallerSource[] = ['chatgpt', 'hermes-teams'];

/** Reserved argument key callers may use to pass context when `_meta` isn't available. */
export const CALLER_CONTEXT_ARG = '_context';

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return undefined;
}

function firstNumber(...vals: unknown[]): number | undefined {
  for (const v of vals) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return undefined;
}

/**
 * Build a CallerContext from the MCP request `_meta` and/or a reserved
 * `_context` key in the tool arguments (`_meta` wins). A missing correlationId
 * is generated; an unknown/absent source is 'unknown'.
 */
export function extractCallerContext(
  meta: Record<string, any> | undefined,
  args: Record<string, any> | undefined
): CallerContext {
  const m = (meta ?? {}) as Record<string, any>;
  const c = (args?.[CALLER_CONTEXT_ARG] ?? {}) as Record<string, any>;

  const rawSource = firstString(m.source, c.source);
  const source: CallerSource = VALID_SOURCES.includes(rawSource as CallerSource)
    ? (rawSource as CallerSource)
    : 'unknown';

  const ctx: CallerContext = {
    source,
    correlationId: firstString(m.correlationId, c.correlationId) ?? randomUUID(),
    timestamp: new Date().toISOString(),
  };

  const email = firstString(m.requestingUserEmail, c.requestingUserEmail, m.userEmail, c.userEmail);
  if (email) ctx.requestingUserEmail = email;

  const teams = firstString(m.teamsObjectId, c.teamsObjectId, m.entraObjectId, c.entraObjectId);
  if (teams) ctx.teamsObjectId = teams;

  const conversationId = firstString(m.conversationId, c.conversationId, m.messageId, c.messageId);
  if (conversationId) ctx.conversationId = conversationId;

  const idempotencyKey = firstString(m.idempotencyKey, c.idempotencyKey);
  if (idempotencyKey) ctx.idempotencyKey = idempotencyKey;

  const intent = firstString(m.intent, c.intent);
  if (intent) ctx.intent = intent;

  const resourceId = firstNumber(m.autotaskResourceId, c.autotaskResourceId);
  if (resourceId !== undefined) ctx.autotaskResourceId = resourceId;

  return ctx;
}

/** Return a copy of `args` with the reserved context key removed so it never reaches tool logic. */
export function stripCallerContext(args: Record<string, any>): Record<string, any> {
  if (args && Object.prototype.hasOwnProperty.call(args, CALLER_CONTEXT_ARG)) {
    const { [CALLER_CONTEXT_ARG]: _drop, ...rest } = args;
    return rest;
  }
  return args;
}
