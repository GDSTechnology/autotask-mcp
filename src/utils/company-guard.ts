// Protected-company and unsafe-name hard safety gates (GDS brief §7.31).
//
// A prior parser bug created sentence-like "companies" and mutated the reserved
// company 0. These are the MCP-side HARD gates that stop that class of damage no
// matter which caller (ChatGPT, n8n, a bad parse) drives a write. The nuanced
// classification/routing policy (seller-spam phrase lists, queue routing, Nexus
// status taxonomy) deliberately stays in n8n (§7.17) — this file only rejects
// input that could not plausibly be a real company or that targets a protected
// internal account.

/**
 * Company IDs that must never be renamed, reclassified, deactivated, or reused
 * by source parsing. Company 0 is always protected — Autotask's "no company"
 * sentinel, which a parser bug once overwrote. Extend per-tenant via the
 * comma-separated AUTOTASK_PROTECTED_COMPANY_IDS env var.
 */
export function getProtectedCompanyIds(env: NodeJS.ProcessEnv = process.env): Set<number> {
  const ids = new Set<number>([0]);
  const raw = env.AUTOTASK_PROTECTED_COMPANY_IDS;
  if (raw) {
    for (const part of raw.split(',')) {
      const n = Number.parseInt(part.trim(), 10);
      if (Number.isFinite(n)) ids.add(n);
    }
  }
  return ids;
}

export function isProtectedCompanyId(id: number, env?: NodeJS.ProcessEnv): boolean {
  return getProtectedCompanyIds(env).has(id);
}

// Changing any of these on a protected company is a rename / reclassify. Note
// `classification` (Spam/Phishing/etc.) is distinct from `companyType` — only
// classification is a source-parsing target, so only it is gated here.
const PROTECTED_FIELDS = ['companyName', 'classification'] as const;

export interface MutationGuardResult {
  blocked: boolean;
  /** Present when blocked — a caller-facing explanation naming the fields. */
  reason?: string;
}

/**
 * Decide whether an update to `id` must be refused because it renames,
 * reclassifies, or deactivates a protected company. Benign updates to a
 * protected company (and any update to a normal company) are allowed.
 */
export function checkProtectedCompanyMutation(
  id: number,
  updates: Record<string, unknown>,
  env?: NodeJS.ProcessEnv
): MutationGuardResult {
  if (!isProtectedCompanyId(id, env)) return { blocked: false };

  const touched: string[] = [];
  for (const field of PROTECTED_FIELDS) {
    if (updates[field] !== undefined) touched.push(field);
  }
  // Deactivation: isActive explicitly set to false / 0.
  if (updates.isActive === false || updates.isActive === 0) touched.push('isActive (deactivate)');

  if (touched.length === 0) return { blocked: false };
  return {
    blocked: true,
    reason:
      `Company ${id} is a protected internal account; refusing to change ${touched.join(', ')}. ` +
      `Protected companies cannot be renamed, reclassified, or deactivated (brief §7.31).`,
  };
}

// Bare webmail provider roots — a company "name" that is just one of these
// (optionally with a TLD) is a parse artifact, not a company. Kept tight to
// avoid false positives on real names that merely contain a token like "Mail".
const WEBMAIL_PROVIDERS = new Set([
  'gmail', 'googlemail', 'yahoo', 'ymail', 'outlook', 'hotmail', 'aol',
  'icloud', 'proton', 'protonmail', 'gmx', 'yandex', 'live', 'msn',
]);

const SALUTATIONS = new Set(['hi', 'hello', 'hey', 'dear', 'greetings', 'thanks', 'thank', 'regards']);

const CTA_PHRASES = [
  'click here', 'unsubscribe', 'learn more', 'book a demo', 'buy now',
  'sign up', 'free trial', 'limited time', 'act now', 'contact us today',
];

export interface NameCheckResult {
  safe: boolean;
  /** Present when unsafe — why the value can't be accepted as a company name. */
  reason?: string;
}

/**
 * Reject values that cannot plausibly be a company name (brief §7.31): missing,
 * a bare webmail provider, a greeting, marketing/CTA text, or sentence-like
 * prose. Conservative by design — this is a hard gate, not the full seller-spam
 * classifier (that lives in n8n).
 */
export function isUnsafeCompanyName(name: unknown): NameCheckResult {
  if (typeof name !== 'string') return { safe: false, reason: 'company name is missing or not a string' };
  const trimmed = name.trim();
  if (trimmed.length === 0) return { safe: false, reason: 'company name is empty' };
  if (trimmed.length > 100) {
    return { safe: false, reason: 'company name exceeds 100 characters — looks like prose, not a name' };
  }

  const lower = trimmed.toLowerCase();

  // Bare webmail provider: the whole name (spaces stripped, one optional TLD).
  const collapsed = lower.replace(/\s+/g, '').replace(/\.(com|net|org|co|io|us)$/, '');
  if (WEBMAIL_PROVIDERS.has(collapsed)) {
    return { safe: false, reason: `"${trimmed}" is a webmail provider, not a company` };
  }

  const words = lower.split(/\s+/);
  if (SALUTATIONS.has(words[0])) {
    return { safe: false, reason: `"${trimmed}" starts with a greeting/salutation` };
  }
  for (const cta of CTA_PHRASES) {
    if (lower.includes(cta)) return { safe: false, reason: `"${trimmed}" contains marketing/CTA text` };
  }
  if (/[.!?]$/.test(trimmed) && words.length >= 4) {
    return { safe: false, reason: `"${trimmed}" looks like a sentence, not a company name` };
  }
  if (words.length > 8) {
    return { safe: false, reason: `"${trimmed}" has too many words to be a company name` };
  }

  return { safe: true };
}
