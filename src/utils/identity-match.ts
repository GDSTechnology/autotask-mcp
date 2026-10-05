// Read-only identity resolution (PR B of the audit tools): normalisation,
// evidence, duplicate clusters and a verdict for "which Autotask company /
// contact is this?". Pure — the service runs bounded queries and hands the
// rows here. NEVER picks silently: every plausible match is returned with the
// evidence for and against it, and the verdict is matched only when one
// candidate is clearly ahead.

/** Legal suffixes and noise words dropped when comparing company names. */
const COMPANY_NOISE = new Set(['the', 'inc', 'incorporated', 'llc', 'l.l.c', 'ltd', 'limited', 'co', 'corp', 'corporation', 'company', 'plc', 'pllc', 'pc', 'lp', 'llp', 'group', 'and', '&']);

/** "The Edge Estimates, LLC." → "edge estimates". */
export function normalizeCompanyName(s: unknown): string {
  return String(s ?? '').toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9&.]+/g, ' ')
    .split(' ').map((w) => w.replace(/\.+$/, '')).filter((w) => w && !COMPANY_NOISE.has(w))
    .join(' ').trim();
}

/** The most distinctive word of a company name (longest), for a bounded `contains` query. */
export function companySearchToken(s: unknown): string | null {
  const words = normalizeCompanyName(s).split(' ').filter((w) => w.length >= 3);
  return words.sort((a, b) => b.length - a.length)[0] ?? null;
}

/** Person name: lowercase, accents and punctuation stripped. */
export function normalizePersonName(s: unknown): string {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** "Daniel Lee" / "Lee, Daniel" → {first, last}. */
export function splitPersonName(s: unknown): { first: string; last: string } | null {
  const raw = String(s ?? '').trim();
  if (!raw) return null;
  if (raw.includes(',')) {
    const [last, first] = raw.split(',', 2).map(normalizePersonName);
    return first && last ? { first, last } : null;
  }
  const parts = normalizePersonName(raw).split(' ').filter(Boolean);
  return parts.length >= 2 ? { first: parts[0]!, last: parts[parts.length - 1]! } : null;
}

/** Phone → its last 10 digits (US national number); null when fewer than 7 digits. */
export function normalizePhone(s: unknown): string | null {
  const d = String(s ?? '').replace(/\D+/g, '');
  if (d.length < 7) return null;
  return d.length > 10 ? d.slice(-10) : d;
}

/** Domain of an email or URL: "Jane@Mail.Edge.com" / "https://www.edge.com/x" → "mail.edge.com" / "edge.com". */
export function domainOf(s: unknown): string | null {
  const t = String(s ?? '').trim().toLowerCase();
  if (!t) return null;
  const at = t.lastIndexOf('@');
  const host = at >= 0 ? t.slice(at + 1) : t.replace(/^[a-z]+:\/\//, '').split(/[/?#:]/)[0]!;
  const h = host.replace(/^www\./, '').replace(/\.$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) ? h : null;
}

/** Consumer mailbox providers — a shared domain says nothing about the company. */
export const FREE_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'hotmail.com', 'outlook.com', 'live.com', 'msn.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'protonmail.com', 'proton.me',
  'gmx.com', 'mail.com', 'zoho.com', 'yandex.com', 'charter.net', 'cox.net', 'earthlink.net', 'bellsouth.net', 'optonline.net',
]);
export const isFreeMailDomain = (d: string | null): boolean => !!d && FREE_MAIL_DOMAINS.has(d);

export type Strength = 'strong' | 'medium' | 'weak';
export interface Evidence { kind: string; strength: Strength; detail: string }
export interface Conflict { field: string; detail: string }

const WEIGHT: Record<Strength, number> = { strong: 3, medium: 2, weak: 1 };
export const score = (ev: Evidence[]): number => ev.reduce((s, e) => s + WEIGHT[e.strength], 0);

export interface CompanyRow { id: number; companyName?: string; webAddress?: string | null; phone?: string | null; alternatePhone1?: string | null; alternatePhone2?: string | null; fax?: string | null; isActive?: boolean; companyType?: number | null; companyNumber?: string | null; ownerResourceID?: number | null; createDate?: string; createdByResourceID?: number | null; parentCompanyID?: number | null }
export interface ContactRow { id: number; firstName?: string; lastName?: string; emailAddress?: string | null; emailAddress2?: string | null; emailAddress3?: string | null; phone?: string | null; mobilePhone?: string | null; alternatePhone?: string | null; companyID?: number | null; isActive?: boolean | number; createDate?: string; title?: string | null }

export interface CompanyCriteria { name?: string | undefined; domain?: string | undefined; phone?: string | undefined; companyNumber?: string | undefined }
export interface ContactCriteria { email?: string | undefined; name?: string | undefined; phone?: string | undefined; companyIDs?: number[] | undefined }

const companyPhones = (c: CompanyRow) => [c.phone, c.alternatePhone1, c.alternatePhone2, c.fax].map(normalizePhone).filter(Boolean);
const contactPhones = (c: ContactRow) => [c.phone, c.mobilePhone, c.alternatePhone].map(normalizePhone).filter(Boolean);
export const contactEmails = (c: ContactRow): string[] => [c.emailAddress, c.emailAddress2, c.emailAddress3].map((e) => String(e ?? '').trim().toLowerCase()).filter(Boolean);
export const fullName = (c: ContactRow): string => [c.firstName, c.lastName].filter(Boolean).join(' ');

/** Evidence that a company row is the one described by the criteria (plus conflicts). */
export function companyEvidence(c: CompanyRow, q: CompanyCriteria, extra: Evidence[] = []): { evidence: Evidence[]; conflicts: Conflict[] } {
  const evidence: Evidence[] = [...extra];
  const conflicts: Conflict[] = [];
  if (q.name) {
    const want = normalizeCompanyName(q.name), have = normalizeCompanyName(c.companyName);
    if (want && have === want) evidence.push({ kind: 'name_exact', strength: 'strong', detail: `normalized name "${have}"` });
    else if (want && have && (have.includes(want) || want.includes(have))) evidence.push({ kind: 'name_partial', strength: 'weak', detail: `"${c.companyName}" ~ "${q.name}"` });
    else if (want && have) {
      const tokenHit = want.split(' ').filter((w) => w.length >= 4 && have.split(' ').includes(w));
      if (tokenHit.length) evidence.push({ kind: 'name_token', strength: 'weak', detail: `shares "${tokenHit.join(' ')}"` });
    }
  }
  const dom = q.domain ? domainOf(q.domain) : null;
  if (dom && !isFreeMailDomain(dom)) {
    const web = domainOf(c.webAddress);
    if (web && (web === dom || web.endsWith('.' + dom) || dom.endsWith('.' + web))) evidence.push({ kind: 'web_domain', strength: 'strong', detail: `webAddress ${c.webAddress}` });
    else if (web && q.name && evidence.some((e) => e.kind === 'name_exact')) conflicts.push({ field: 'webAddress', detail: `company web domain ${web} ≠ ${dom}` });
  }
  const ph = normalizePhone(q.phone);
  if (ph && companyPhones(c).includes(ph)) evidence.push({ kind: 'phone', strength: 'medium', detail: `phone …${ph.slice(-4)}` });
  if (q.companyNumber && String(c.companyNumber ?? '').trim().toLowerCase() === q.companyNumber.trim().toLowerCase()) evidence.push({ kind: 'company_number', strength: 'strong', detail: `companyNumber ${c.companyNumber}` });
  if (c.isActive === false) conflicts.push({ field: 'isActive', detail: 'company is INACTIVE' });
  return { evidence, conflicts };
}

/** Evidence that a contact row is the person described by the criteria (plus conflicts). */
export function contactEvidence(c: ContactRow, q: ContactCriteria): { evidence: Evidence[]; conflicts: Conflict[] } {
  const evidence: Evidence[] = [];
  const conflicts: Conflict[] = [];
  const email = String(q.email ?? '').trim().toLowerCase();
  const emails = contactEmails(c);
  if (email) {
    if (emails[0] === email) evidence.push({ kind: 'email_exact', strength: 'strong', detail: 'primary email' });
    else if (emails.includes(email)) evidence.push({ kind: 'email_exact', strength: 'strong', detail: 'secondary email' });
  }
  const emailMismatch = !!email && emails.length > 0 && !emails.includes(email);
  const want = q.name ? splitPersonName(q.name) : null;
  if (want) {
    const f = normalizePersonName(c.firstName), l = normalizePersonName(c.lastName);
    if (f === want.first && l === want.last) evidence.push({ kind: 'name_exact', strength: 'medium', detail: `name "${fullName(c)}"` });
    else if (l === want.last && f && want.first && (f.startsWith(want.first) || want.first.startsWith(f))) evidence.push({ kind: 'name_close', strength: 'weak', detail: `name "${fullName(c)}"` });
    else if (evidence.some((e) => e.kind === 'email_exact')) conflicts.push({ field: 'name', detail: `email matches but the contact is "${fullName(c)}", not "${q.name}"` });
  }
  const ph = normalizePhone(q.phone);
  if (ph && contactPhones(c).includes(ph)) evidence.push({ kind: 'phone', strength: 'medium', detail: `phone …${ph.slice(-4)}` });
  if (q.companyIDs?.length) {
    if (c.companyID != null && q.companyIDs.includes(Number(c.companyID))) evidence.push({ kind: 'company_consistent', strength: 'weak', detail: `belongs to candidate company ${c.companyID}` });
    else if (evidence.length) conflicts.push({ field: 'companyID', detail: `belongs to company ${c.companyID ?? 'none'}, not a candidate company` });
  }
  // Matched on name/phone but the record carries a DIFFERENT address than the
  // one given: a new address, a shared name, or someone using the name.
  if (emailMismatch && evidence.length) conflicts.push({ field: 'email', detail: `contact's email(s) ${emails.join(', ')} differ from ${email}` });
  if (c.isActive === false || c.isActive === 0) conflicts.push({ field: 'isActive', detail: 'contact is INACTIVE' });
  return { evidence, conflicts };
}

export type Verdict = 'matched' | 'ambiguous' | 'unmatched';

/**
 * matched   — exactly one candidate with DECISIVE evidence (a strong item, or
 *             ≥ 3 points from ≥ 2 independent kinds, e.g. exact name inside a
 *             candidate company) and a clear lead (≥ 2 points over the
 *             runner-up) and no blocking conflict;
 * ambiguous — several plausible candidates, or the leader has a conflict;
 * unmatched — nothing with evidence.
 */
export function verdict<T extends { evidence: Evidence[]; conflicts: Conflict[] }>(cands: T[]): { verdict: Verdict; confidence: 'high' | 'medium' | 'low'; reason: string } {
  const ranked = cands.filter((c) => c.evidence.length).sort((a, b) => score(b.evidence) - score(a.evidence));
  if (!ranked.length) return { verdict: 'unmatched', confidence: 'low', reason: 'no candidate has any matching evidence' };
  const [top, next] = [ranked[0]!, ranked[1]];
  const topStrong = top.evidence.some((e) => e.strength === 'strong');
  const decisive = topStrong || (score(top.evidence) >= 3 && new Set(top.evidence.map((e) => e.kind)).size >= 2);
  const lead = score(top.evidence) - (next ? score(next.evidence) : 0);
  const blocking = top.conflicts.filter((c) => c.field !== 'isActive');
  if (decisive && lead >= 2 && !blocking.length) {
    return { verdict: 'matched', confidence: topStrong && score(top.evidence) >= 5 ? 'high' : 'medium', reason: `one candidate leads with ${top.evidence.map((e) => e.kind).join(' + ')}${top.conflicts.length ? ` (note: ${top.conflicts.map((c) => c.detail).join('; ')})` : ''}` };
  }
  if (blocking.length) return { verdict: 'ambiguous', confidence: 'low', reason: `the best candidate has conflicting fields: ${blocking.map((c) => c.detail).join('; ')}` };
  return { verdict: 'ambiguous', confidence: topStrong ? 'medium' : 'low', reason: next ? `${ranked.length} plausible candidates, best lead only ${lead} point(s)` : 'only weak evidence (no exact email / name / domain / number)' };
}

/** Groups of ≥2 records that look like the same thing (duplicates), by key. */
export function clusters<T extends { id: number }>(rows: T[], keyOf: (r: T) => string[]): Array<{ key: string; ids: number[] }> {
  const by = new Map<string, Set<number>>();
  for (const r of rows) for (const k of keyOf(r)) if (k) (by.get(k) ?? by.set(k, new Set()).get(k)!).add(r.id);
  return [...by.entries()].filter(([, ids]) => ids.size > 1).map(([key, ids]) => ({ key, ids: [...ids].sort((a, b) => a - b) }));
}

export const companyClusterKeys = (c: CompanyRow): string[] => {
  const keys = [`name:${normalizeCompanyName(c.companyName)}`];
  const d = domainOf(c.webAddress);
  if (d && !isFreeMailDomain(d)) keys.push(`domain:${d}`);
  const p = normalizePhone(c.phone);
  if (p) keys.push(`phone:${p}`);
  return keys.filter((k) => !k.endsWith(':'));
};
export const contactClusterKeys = (c: ContactRow): string[] => [
  ...contactEmails(c).map((e) => `email:${e}`),
  ...(c.companyID != null && c.lastName ? [`name+company:${normalizePersonName(fullName(c))}@${c.companyID}`] : []),
];
