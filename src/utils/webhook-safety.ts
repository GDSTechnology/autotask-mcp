// Webhook secret handling + loop-prevention defaults.
//
// Autotask signs every webhook callout with the webhook's secret key
// (X-Hook-Signature: sha1=<base64 HMAC-SHA1 of the raw body>; key <= 64 chars —
// Autotask "Secret key and payload verification"). The receiver (n8n) must hold
// the same secret. Passing it as a tool argument puts it in the chat
// transcript, so the MCP reads it from AUTOTASK_WEBHOOK_SECRET when the caller
// omits it (n8n gets the same env var on the host), and NEVER echoes a secret
// back in a dry run or result.
//
// Loop prevention: changes made by an excluded resource don't fire the webhook.
// The MCP's own API user writes tickets (and so does any automation sharing it),
// so it is excluded by default, plus any ids in
// AUTOTASK_WEBHOOK_EXCLUDE_RESOURCE_IDS.

export const WEBHOOK_SECRET_ENV = 'AUTOTASK_WEBHOOK_SECRET';
export const WEBHOOK_EXCLUDE_ENV = 'AUTOTASK_WEBHOOK_EXCLUDE_RESOURCE_IDS';
/** Autotask's documented maximum secret length. */
export const MAX_SECRET_LENGTH = 64;

export type SecretSource = 'argument' | 'env';

export function resolveWebhookSecret(argument: string | undefined | null): { secret: string | null; source: SecretSource | null } {
  const fromArg = typeof argument === 'string' && argument.trim() ? argument.trim() : null;
  if (fromArg) return { secret: fromArg, source: 'argument' };
  const fromEnv = (process.env[WEBHOOK_SECRET_ENV] ?? '').trim();
  return fromEnv ? { secret: fromEnv, source: 'env' } : { secret: null, source: null };
}

/** Errors for a secret Autotask would reject. */
export function secretErrors(secret: string | null): string[] {
  if (!secret) return [`secretKey is required — pass it, or (preferred) set ${WEBHOOK_SECRET_ENV} on the MCP host so it never appears in chat`];
  return secret.length > MAX_SECRET_LENGTH ? [`secretKey must be at most ${MAX_SECRET_LENGTH} characters (Autotask limit); it is ${secret.length}`] : [];
}

/** Advice for a secret Autotask accepts but that is weak (it RECOMMENDS 10+). */
export function secretWarnings(secret: string | null): string[] {
  return secret && secret.length < 10 ? [`secretKey is only ${secret.length} characters — Autotask strongly recommends at least 10.`] : [];
}

/** What a dry run / result shows instead of the secret. */
export function secretPlaceholder(source: SecretSource | null): string {
  return source === 'env' ? `<from ${WEBHOOK_SECRET_ENV}>` : '<provided — hidden>';
}

/** Copy of a webhook payload with any secretKey replaced by a placeholder. */
export function maskSecret<T extends Record<string, unknown>>(payload: T, source: SecretSource | null): T {
  if (!('secretKey' in payload)) return payload;
  return { ...payload, secretKey: secretPlaceholder(source) };
}

/** Resource ids from AUTOTASK_WEBHOOK_EXCLUDE_RESOURCE_IDS ("30683921, 30683927"). */
export function envExcludedResourceIDs(): number[] {
  return (process.env[WEBHOOK_EXCLUDE_ENV] ?? '')
    .split(/[\s,;]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

export interface ExclusionEntry { resourceID: number; reason: 'requested' | 'mcp-api-user' | 'env' }

/**
 * The final excluded-resource set, each with why it is there (shown in the dry
 * run). `self` is the MCP's own API-user resource (null when unresolvable).
 */
export function buildExclusions(requested: number[] | undefined, self: number | null, includeSelf: boolean): ExclusionEntry[] {
  const out = new Map<number, ExclusionEntry>();
  for (const id of requested ?? []) if (Number.isInteger(id) && id > 0) out.set(id, { resourceID: id, reason: 'requested' });
  if (includeSelf && self != null && !out.has(self)) out.set(self, { resourceID: self, reason: 'mcp-api-user' });
  for (const id of envExcludedResourceIDs()) if (!out.has(id)) out.set(id, { resourceID: id, reason: 'env' });
  return [...out.values()];
}
