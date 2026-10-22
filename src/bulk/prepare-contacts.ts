// Prepare a junk-contact cleanup on ONE real company (read-only): a customer account that was
// stuffed with contacts that don't belong to it (spam senders, webmail addresses, a mail lane
// that filed everyone under one account). Selection is either an explicit list of contact ids
// or a rule: every active contact whose email domain is NOT one of the company's own.
// The company's own domains = its web address + keepDomains + the (non-webmail) domains of
// contacts with history, so real staff are never selected by the rule.
// Always EXCLUDED (a person decides): the primary contact, and contacts with history —
// projects, contracts, opportunities, quotes, configuration items, to-dos, and tickets
// (unless ticketsOk: a junk sender is often the contact on its own spam tickets; inactivating
// it leaves the tickets as they are). A history check that fails stops the preparation.

import type { QueryFn } from '../vendors/contract-io.js';
import { CONTACT_REFS } from '../merge/model.js';
import { domainOf, isFreeMailDomain } from '../utils/identity-match.js';
import type { BulkItemInput } from './store.js';
import type { PrepareResult } from './prepare.js';

export interface CompanyContactsSelector {
  companyId: number;
  /** Explicit contacts to inactivate (all must be on the company). Otherwise the domain rule. */
  contactIds?: number[];
  /** Extra domains that belong to the company (never selected). */
  keepDomains?: string[];
  /** Rule mode: only these domains (e.g. ["gmail.com", "hotmail.com"]). */
  onlyDomains?: string[];
  createdFrom?: string; createdTo?: string;
  /** Rule mode: also contacts with no email address (default false: kept and counted). */
  includeNoEmail?: boolean;
  /** A contact whose only history is tickets is still inactivated (default false). */
  ticketsOk?: boolean;
}

const PAGE = 4999;
const EMAILS = ['emailAddress', 'emailAddress2', 'emailAddress3'] as const;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const domains = (c: Record<string, any>) => [...new Set(EMAILS.map((f) => domainOf(c[f])).filter((d): d is string => !!d))];
const normDomain = (d: string) => domainOf(d.includes('@') ? d : `x@${d.replace(/^https?:\/\//i, '').replace(/^www\./i, '')}`) ?? d.toLowerCase().trim();

export async function prepareCompanyContactsJob(q: QueryFn, sel: CompanyContactsSelector, o: { paceMs?: number; mirrored?: (entity: string) => boolean; onProgress?: (s: string) => void; /** Live field names (null = unknown): a history link this tenant doesn't have is skipped, not failed. */ fieldNames?: (entity: string) => Promise<Set<string> | null> } = {}): Promise<PrepareResult> {
  const pace = async (entity: string) => { if (o.paceMs && !(o.mirrored?.(entity) ?? false)) await sleep(o.paceMs); };
  const calls = { n: 0 };
  // 1. The company — a real one (company 0 is the tenant's own and is never cleaned this way).
  if (!Number.isInteger(sel.companyId) || sel.companyId <= 0) throw new Error(`companyId ${sel.companyId}: a customer company id (company 0 is your own company — never cleaned in bulk).`);
  calls.n++;
  const [company] = await q<Record<string, any>>('Companies', [{ op: 'eq', field: 'id', value: sel.companyId }], { maxRecords: 1, includeFields: ['id', 'companyName', 'isActive', 'webAddress'] });
  if (!company) throw new Error(`No company ${sel.companyId}.`);

  // 2. Every contact on it, page by id.
  const contacts: Array<Record<string, any>> = [];
  for (let last = 0; ;) {
    calls.n++;
    const page = await q<Record<string, any>>('Contacts', [{ op: 'eq', field: 'companyID', value: sel.companyId }, { op: 'gt', field: 'id', value: last }], { maxRecords: PAGE, includeFields: ['id', 'companyID', 'isActive', 'firstName', 'lastName', ...EMAILS, 'primaryContact', 'createDate'] });
    contacts.push(...page);
    o.onProgress?.(`contacts: ${contacts.length}`);
    if (page.length < PAGE) break;
    last = Math.max(...page.map((c) => Number(c.id)));
  }
  const byId = new Map(contacts.map((c) => [Number(c.id), c]));
  if (sel.contactIds?.length) {
    const missing = sel.contactIds.filter((id) => !byId.has(Number(id)));
    if (missing.length) throw new Error(`${missing.length} contact id(s) are not on company ${sel.companyId} (e.g. ${missing.slice(0, 5).join(', ')}) — nothing prepared.`);
  }
  const ids = contacts.map((c) => Number(c.id));

  // 3. History per contact.
  const hist = new Map<number, Record<string, number>>();
  const notApplicable: string[] = [];
  for (const sp of CONTACT_REFS) {
    // A link field this tenant doesn't have (Projects.contactID: "Unable to find contactID in the Project Entity")
    // can't point at a contact. Only a KNOWN field list skips it — an unknown one still queries and fails closed.
    const have = await o.fieldNames?.(sp.entity).catch(() => null);
    if (have && !have.has(sp.field)) { notApplicable.push(`${sp.entity}.${sp.field}`); continue; }
    for (let i = 0; i < ids.length; i += 200) {
      calls.n++;
      let rows: Array<Record<string, any>>;
      try { rows = await q<Record<string, any>>(sp.entity, [{ op: 'in', field: sp.field, value: ids.slice(i, i + 200) }], { maxRecords: 5000, includeFields: ['id', sp.field] }); }
      catch (e) { throw new Error(`history check on ${sp.label} failed (${(e instanceof Error ? e.message : String(e)).slice(0, 160)}) — nothing prepared; a contact can't be called history-free without it`, { cause: e }); }
      if (rows.length >= 5000) throw new Error(`history check on ${sp.label}: a chunk returned 5,000+ rows (the read cap) — some contacts could be missed; nothing prepared`);
      for (const r of rows) { const h = hist.get(Number(r[sp.field])) ?? hist.set(Number(r[sp.field]), {}).get(Number(r[sp.field]))!; h[sp.label] = (h[sp.label] ?? 0) + 1; }
      await pace(sp.entity);
    }
    o.onProgress?.(`history: ${sp.label}`);
  }

  // 4. The company's own domains: web address + keepDomains + (non-webmail) domains of contacts with history.
  const own = new Set<string>((sel.keepDomains ?? []).map(normDomain));
  const web = domainOf(company.webAddress); if (web && !isFreeMailDomain(web)) own.add(web);
  // (With ticketsOk, ticket-only history says nothing: spam senders are the contacts on their spam tickets.)
  const ownFrom: Record<string, string> = {}; if (web && own.has(web)) ownFrom[web] = 'web address';
  for (const d of own) ownFrom[d] ??= 'keepDomains';
  for (const [id, h] of hist) {
    if (sel.ticketsOk && Object.keys(h).every((k) => k === 'tickets')) continue;
    for (const d of domains(byId.get(id) ?? {})) if (!isFreeMailDomain(d) && !own.has(d)) { own.add(d); ownFrom[d] = `history of contact #${id}`; }
  }
  const only = sel.onlyDomains?.length ? new Set(sel.onlyDomains.map(normDomain)) : null;
  const explicit = sel.contactIds?.length ? new Set(sel.contactIds.map(Number)) : null;
  const from = sel.createdFrom ? `${sel.createdFrom.slice(0, 10)}T00:00:00` : null;
  const to = sel.createdTo ? `${sel.createdTo.slice(0, 10)}T23:59:59` : null;

  // 5. Items.
  const items: BulkItemInput[] = [];
  const byDomain: Record<string, { inactivate: number; kept: number; excluded: number; alreadyInactive: number }> = {};
  const tally = (d: string, k: 'inactivate' | 'kept' | 'excluded' | 'alreadyInactive') => { (byDomain[d] ??= { inactivate: 0, kept: 0, excluded: 0, alreadyInactive: 0 })[k]++; };
  const keptWhy: Record<string, number> = {};
  const keep = (why: string) => { keptWhy[why] = (keptWhy[why] ?? 0) + 1; };
  for (const c of [...contacts].sort((a, b) => Number(a.id) - Number(b.id))) {
    const id = Number(c.id);
    const ds = domains(c); const dKey = ds[0] ?? '(no email)';
    const name = [c.firstName, c.lastName].filter(Boolean).join(' ');
    const before = { isActive: 1, name, email: c.emailAddress ?? c.emailAddress2 ?? c.emailAddress3 ?? null, createDate: c.createDate ?? null };
    if (!(c.isActive === true || c.isActive === 1)) { tally(dKey, 'alreadyInactive'); continue; }
    // Selected?
    if (explicit) { if (!explicit.has(id)) { tally(dKey, 'kept'); keep('not in the list'); continue; } }
    else {
      if (!ds.length && !sel.includeNoEmail) { tally(dKey, 'kept'); keep('no email address'); continue; }
      if (ds.some((d) => own.has(d))) { tally(dKey, 'kept'); keep('company domain'); continue; }
      if (only && !ds.some((d) => only.has(d))) { tally(dKey, 'kept'); keep('domain not selected'); continue; }
      const cd = String(c.createDate ?? '');
      if ((from && cd < from) || (to && cd > to)) { tally(dKey, 'kept'); keep('created outside the window'); continue; }
    }
    // Selected — but some always need a person.
    const h = hist.get(id) ?? {};
    const blocking = Object.entries(h).filter(([k]) => !(sel.ticketsOk && k === 'tickets'));
    const reasons = [...(c.primaryContact === true || c.primaryContact === 1 ? ['primary contact'] : []), ...blocking.map(([k, n]) => `${n} ${k}`)];
    if (reasons.length) { items.push({ entity: 'Contacts', recordId: id, parentId: sel.companyId, action: 'inactivate', status: 'excluded', reason: reasons.join('; '), before }); tally(dKey, 'excluded'); continue; }
    items.push({ entity: 'Contacts', recordId: id, parentId: sel.companyId, action: 'inactivate', before: h.tickets ? { ...before, tickets: h.tickets } : before });
    tally(dKey, 'inactivate');
  }
  const writes = items.filter((i) => i.status !== 'excluded').length;
  const topDomains = Object.fromEntries(Object.entries(byDomain).sort((a, b) => (b[1].inactivate + b[1].kept) - (a[1].inactivate + a[1].kept)).slice(0, 40));
  return {
    items,
    stats: {
      selector: sel, company: { id: Number(company.id), name: company.companyName ?? null, isActive: company.isActive ?? null },
      mode: explicit ? 'contact list' : 'domain rule', companyDomains: Object.fromEntries(Object.entries(ownFrom).sort()),
      contactsSeen: contacts.length, contactWrites: writes, writes, excludedContacts: items.length - writes, kept: keptWhy,
      byDomain: topDomains, domains: Object.keys(byDomain).length, prepareReads: calls.n, historyNotApplicable: notApplicable,
    },
  };
}
