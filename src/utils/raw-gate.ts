// Raw-request gatekeeping (Expansion Spec §3.4, issue #17).
//
// `autotask_raw_request` is the administrator escape hatch. The HTTP layer already
// rejects absolute URLs, auth-header overrides, and off-zone hosts. This gate adds
// the policy layer on top:
//   - administrator-only when permission gating is enabled (§4.2);
//   - DELETE disabled unless explicitly opted in (MCP_RAW_ALLOW_DELETE=true);
//   - a production read-only switch (MCP_RAW_READONLY=true) that blocks every
//     mutating method, leaving only GET.
//
// Denials are structured with a reason; every raw call is audited by the caller.

import { FunctionalRole } from './permissions';

export interface RawGateInput {
  method: string;
  role?: FunctionalRole | undefined;
  permissionsEnabled: boolean;
  env?: NodeJS.ProcessEnv | undefined;
}

export interface RawGateDecision {
  allowed: boolean;
  reason?: string;
}

function isTrue(v: unknown): boolean {
  return String(v).toLowerCase() === 'true';
}

export function evaluateRawRequest(input: RawGateInput): RawGateDecision {
  const env = input.env ?? process.env;
  const method = String(input.method ?? '').toUpperCase();

  // Administrator-only when permission gating is on. Raw bypasses the typed-tool
  // surface, so it is never subject to the ordinary role→risk ladder.
  if (input.permissionsEnabled && input.role !== 'administrator') {
    return {
      allowed: false,
      reason: 'autotask_raw_request is administrator-only. Use a typed tool, or have an administrator run this.',
    };
  }

  // DELETE is disabled by default — deletes must go through a typed delete tool
  // (which is risk-gated and idempotent) unless explicitly opted in.
  if (method === 'DELETE' && !isTrue(env.MCP_RAW_ALLOW_DELETE)) {
    return {
      allowed: false,
      reason: 'DELETE is disabled for autotask_raw_request. Use a typed delete tool, or set MCP_RAW_ALLOW_DELETE=true.',
    };
  }

  // Production read-only switch: block every mutating method, allow only GET.
  if (method !== 'GET' && isTrue(env.MCP_RAW_READONLY)) {
    return {
      allowed: false,
      reason: 'Mutating raw requests are disabled in this environment (MCP_RAW_READONLY=true). Only GET is permitted.',
    };
  }

  return { allowed: true };
}

export interface RawRequestDenied {
  status: 'raw_request_denied';
  tool: 'autotask_raw_request';
  method: string;
  message: string;
}

export function buildRawRequestDenied(method: string, decision: RawGateDecision): RawRequestDenied {
  return {
    status: 'raw_request_denied',
    tool: 'autotask_raw_request',
    method: String(method ?? '').toUpperCase(),
    message: decision.reason ?? 'autotask_raw_request is not permitted.',
  };
}
