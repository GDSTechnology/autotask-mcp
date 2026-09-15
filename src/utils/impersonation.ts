// Trusted gateway impersonation headers (#42 slice 2).
//
// When a request arrives through the conduit gateway (Teams handoff), the
// gateway — which has already authenticated the end user — may inject the acting
// Autotask identity as an HTTP header. This is read ONLY in gateway mode and
// only after the S2S gate (src/mcp/s2s-verify.ts) has verified the request came
// from the gateway, so the header is trusted; stdio/env mode never reads it.
//
// Two forms are accepted (resource id wins): a numeric Autotask resource id, or
// the acting user's email (resolved live against Autotask Resources).

/** Node lowercases inbound header names. */
export const ACTING_RESOURCE_ID_HEADER = 'x-acting-resource-id';
export const ACTING_USER_EMAIL_HEADER = 'x-acting-user-email';

export interface TrustedActing {
  resourceId?: number;
  email?: string;
}

/**
 * Parse the acting-identity headers into a TrustedActing, or undefined when
 * neither is present/valid. Case-insensitive; tolerates array-valued headers.
 */
export function parseActingHeaders(
  headers: Record<string, string | string[] | undefined>
): TrustedActing | undefined {
  // Normalize to a lowercased key map so lookup is case-insensitive regardless
  // of how the caller cased the header (Node lowercases inbound headers anyway).
  const lower: Record<string, string | string[] | undefined> = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  const get = (name: string): string | undefined => {
    const v = lower[name.toLowerCase()];
    return Array.isArray(v) ? v[0] : v;
  };
  const out: TrustedActing = {};
  const rawId = get(ACTING_RESOURCE_ID_HEADER);
  if (rawId != null && String(rawId).trim() !== '' && Number.isFinite(Number(rawId))) {
    out.resourceId = Number(rawId);
  }
  const email = get(ACTING_USER_EMAIL_HEADER);
  if (typeof email === 'string' && email.trim() !== '') {
    out.email = email.trim();
  }
  return out.resourceId != null || out.email ? out : undefined;
}
