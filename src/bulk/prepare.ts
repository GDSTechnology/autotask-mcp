// Prepare a placeholder cleanup job (read-only): select the placeholder companies
// (e.g. every company named "Gmail", optionally only those one integration created
// in a window), their contacts, and check each company for HISTORY. A company with
// history (tickets, projects, contracts, opportunities, quotes, sales orders,
// configuration items, service calls, invoices, billing items, child companies) or
// with a contact who looks like a real person is EXCLUDED — those need a person and a
// UI merge. The rest become items: inactivate each active contact, then the company.
// Reads page by id (≤ 4,999 per page) so the Postgres shadow answers them; entities
// it doesn't mirror are paced. A history check that fails stops the preparation —
// never "no history" by default.

import type { QueryFn } from '../vendors/contract-io.js';
import { isPlaceholderCompany, isPlaceholderContact, type RefSpec } from '../merge/model.js';
import type { BulkItemInput } from './store.js';

export interface PlaceholderSelector {
  companyName: string; createdByResourceId?: number; createdFrom?: string; createdTo?: string;
  /** Email addresses a person recognises as real: their placeholder companies are kept (excluded). */
  excludeEmails?: string[];
  /** Addresses a person confirmed as junk (spam senders): their tickets no longer keep their companies. Keep wins over junk. */
  junkEmails?: string[];
}

const EMAILS = ['emailAddress', 'emailAddress2', 'emailAddress3'] as const;
/** A person's email addresses (any of the three fields), as written. */
const emailsOf = (c: Record<string, any>): string[] => EMAILS.map((f) => String(c[f] ?? '').trim()).filter((e) => e.includes('@'));

export type EmailDecision = 'inactivate' | 'excluded';
export interface EmailReview { email: string; copies: number; companies: number; decision: EmailDecision; why: string; realCompanies: Array<{ id: number; name: string | null }>; tickets: number }

/** What counts as history (a reason to keep the company out of an automatic cleanup). */
export const HISTORY_REFS: RefSpec[] = [
  { entity: 'Tickets', field: 'companyID', label: 'tickets' },
  { entity: 'Projects', field: 'companyID', label: 'projects' },
  { entity: 'Contracts', field: 'companyID', label: 'contracts' },
  { entity: 'Opportunities', field: 'companyID', label: 'opportunities' },
  { entity: 'Quotes', field: 'companyID', label: 'quotes' },
  { entity: 'SalesOrders', field: 'companyID', label: 'sales orders' },
  { entity: 'ConfigurationItems', field: 'companyID', label: 'configuration items' },
  { entity: 'ServiceCalls', field: 'companyID', label: 'service calls' },
  { entity: 'Invoices', field: 'companyID', label: 'invoices' },
  { entity: 'BillingItems', field: 'companyID', label: 'billing items' },
  { entity: 'Companies', field: 'parentCompanyID', label: 'child companies' },
];

const PAGE = 4999;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface PrepareResult { items: BulkItemInput[]; stats: Record<string, unknown> }

export async function preparePlaceholderJob(q: QueryFn, sel: PlaceholderSelector, o: { includeContacts?: boolean; paceMs?: number; mirrored?: (entity: string) => boolean; onProgress?: (s: string) => void } = {}): Promise<PrepareResult> {
  const pace = async (entity: string) => { if (o.paceMs && !(o.mirrored?.(entity) ?? false)) await sleep(o.paceMs); };
  const calls = { n: 0 };
  // 1. The companies, page by id.
  const filter = [{ op: 'eq', field: 'companyName', value: sel.companyName },
    ...(sel.createdByResourceId != null ? [{ op: 'eq', field: 'createdByResourceID', value: sel.createdByResourceId }] : []),
    ...(sel.createdFrom ? [{ op: 'gte', field: 'createDate', value: `${sel.createdFrom.slice(0, 10)}T00:00:00` }] : []),
    ...(sel.createdTo ? [{ op: 'lte', field: 'createDate', value: `${sel.createdTo.slice(0, 10)}T23:59:59` }] : [])];
  const companies: Array<Record<string, any>> = [];
  for (let last = 0; ;) {
    calls.n++;
    const page = await q<Record<string, any>>('Companies', [...filter, { op: 'gt', field: 'id', value: last }], { maxRecords: PAGE, includeFields: ['id', 'companyName', 'isActive', 'createDate', 'createdByResourceID'] });
    companies.push(...page);
    o.onProgress?.(`companies: ${companies.length}`);
    if (page.length < PAGE) break;
    last = Math.max(...page.map((c) => Number(c.id)));
  }
  // Every selected company must be a placeholder — a selector can never sweep in a real customer.
  const notPlaceholder = companies.filter((c) => !isPlaceholderCompany(c));
  if (notPlaceholder.length) throw new Error(`${notPlaceholder.length} selected compan(ies) are not placeholders (e.g. #${notPlaceholder[0]!.id} "${notPlaceholder[0]!.companyName}") — refusing`);
  const ids = companies.map((c) => Number(c.id));

  // 2. Their contacts.
  const contacts: Array<Record<string, any>> = [];
  for (let i = 0; i < ids.length; i += 200) {
    calls.n++;
    contacts.push(...await q<Record<string, any>>('Contacts', [{ op: 'in', field: 'companyID', value: ids.slice(i, i + 200) }], { maxRecords: 5000, includeFields: ['id', 'companyID', 'isActive', 'firstName', 'lastName', ...EMAILS] }));
    await pace('Contacts');
  }
  const contactsOf = new Map<number, Array<Record<string, any>>>();
  for (const c of contacts) (contactsOf.get(Number(c.companyID)) ?? contactsOf.set(Number(c.companyID), []).get(Number(c.companyID))!).push(c);

  // 3. History, per entity.
  const why = new Map<number, string[]>();
  const add = (id: number, reason: string) => (why.get(id) ?? why.set(id, []).get(id)!).push(reason);
  for (const sp of HISTORY_REFS) {
    const hits = new Map<number, number>();
    for (let i = 0; i < ids.length; i += 200) {
      calls.n++;
      let rows: Array<Record<string, any>>;
      try { rows = await q<Record<string, any>>(sp.entity, [{ op: 'in', field: sp.field, value: ids.slice(i, i + 200) }], { maxRecords: 5000, includeFields: ['id', sp.field] }); }
      catch (e) { throw new Error(`history check on ${sp.label} failed (${(e instanceof Error ? e.message : String(e)).slice(0, 160)}) — nothing prepared; a company can't be called history-free without it`, { cause: e }); }
      if (rows.length >= 5000) throw new Error(`history check on ${sp.label}: a chunk returned 5,000+ rows (the read cap) — some companies could be missed; nothing prepared`);
      for (const r of rows) hits.set(Number(r[sp.field]), (hits.get(Number(r[sp.field])) ?? 0) + 1);
      await pace(sp.entity);
    }
    for (const [id, n] of hits) add(id, `${n} ${sp.label}`);
    o.onProgress?.(`history: ${sp.label} (${hits.size} companies)`);
  }
  // A contact with a real-looking name on a placeholder company may be a real person: a person decides.
  for (const [cid, list] of contactsOf) { const real = list.filter((c) => !isPlaceholderContact(c)); if (real.length) add(cid, `${real.length} contact(s) with a real name (e.g. #${real[0]!.id})`); }

  // 3b. Email safeguards. Personal mail (gmail, hotmail, outlook…) is also what real people use, so every address on
  // these placeholder contacts is checked across the WHOLE tenant (2026-10-23, before the Outlook / Hotmail cleanups):
  //   - any ticket on any contact with that address → the address is a real person: their companies are KEPT;
  //   - the address is also on a contact of a REAL company → the placeholder copy is a duplicate (inactivated, shown);
  //   - listed in excludeEmails → KEPT (a person recognised it);
  //   - listed in junkEmails → the ticket rule is waived (a person confirmed a spam sender, e.g. one spam ticket
  //     kept 1,339 "Outlook" companies); company history and real names still exclude;
  //   - otherwise it only exists on placeholders → inactivated.
  // A check that fails stops the preparation (never "no tickets" by default).
  const byEmail = new Map<string, { email: string; companies: Set<number>; contactIds: Set<number> }>();
  for (const c of contacts) for (const e of emailsOf(c)) {
    const k = e.toLowerCase();
    const x = byEmail.get(k) ?? byEmail.set(k, { email: e, companies: new Set(), contactIds: new Set() }).get(k)!;
    x.companies.add(Number(c.companyID)); x.contactIds.add(Number(c.id));
  }
  const keys = [...byEmail.keys()];
  const fail = (what: string, e: unknown) => new Error(`email check (${what}) failed (${(e instanceof Error ? e.message : String(e)).slice(0, 160)}) — nothing prepared; an address can't be called unused without it`, { cause: e });
  const sameAddress: Array<Record<string, any>> = [];
  for (const f of EMAILS) for (let i = 0; i < keys.length; i += 200) {
    calls.n++;
    let rows: Array<Record<string, any>>;
    try { rows = await q<Record<string, any>>('Contacts', [{ op: 'in', field: f, value: keys.slice(i, i + 200) }], { maxRecords: 5000, includeFields: ['id', 'companyID', 'isActive', ...EMAILS] }); }
    catch (e) { throw fail(`contacts by ${f}`, e); }
    if (rows.length >= 5000) throw new Error(`email check: a chunk of addresses matched 5,000+ contacts (the read cap) — nothing prepared`);
    sameAddress.push(...rows);
    await pace('Contacts');
  }
  const selected = new Set(ids);
  // The companies of same-address contacts outside this selection: real customers, or other placeholders?
  const outside = [...new Set(sameAddress.map((c) => Number(c.companyID)).filter((id) => !selected.has(id)))];
  const companyName = new Map<number, string>();
  for (let i = 0; i < outside.length; i += 200) {
    calls.n++;
    try { for (const c of await q<Record<string, any>>('Companies', [{ op: 'in', field: 'id', value: outside.slice(i, i + 200) }], { maxRecords: 500, includeFields: ['id', 'companyName'] })) companyName.set(Number(c.id), String(c.companyName ?? '')); }
    catch (e) { throw fail('companies of same-address contacts', e); }
  }
  const isReal = (cid: number) => !selected.has(cid) && companyName.has(cid) && !isPlaceholderCompany({ companyName: companyName.get(cid) });
  // Tickets on ANY contact with one of these addresses.
  const contactEmails = new Map<number, string[]>();
  for (const c of [...contacts, ...sameAddress]) contactEmails.set(Number(c.id), emailsOf(c).map((e) => e.toLowerCase()));
  const allContactIds = [...contactEmails.keys()];
  const ticketsOf = new Map<string, number>();
  for (let i = 0; i < allContactIds.length; i += 200) {
    calls.n++;
    let rows: Array<Record<string, any>>;
    try { rows = await q<Record<string, any>>('Tickets', [{ op: 'in', field: 'contactID', value: allContactIds.slice(i, i + 200) }], { maxRecords: 5000, includeFields: ['id', 'contactID'] }); }
    catch (e) { throw fail('tickets of same-address contacts', e); }
    if (rows.length >= 5000) throw new Error('email check: a chunk of contacts has 5,000+ tickets (the read cap) — nothing prepared');
    for (const t of rows) for (const k of contactEmails.get(Number(t.contactID)) ?? []) ticketsOf.set(k, (ticketsOf.get(k) ?? 0) + 1);
    await pace('Tickets');
  }
  const listed = new Set((sel.excludeEmails ?? []).map((e) => String(e).trim().toLowerCase()).filter(Boolean));
  const junk = new Set((sel.junkEmails ?? []).map((e) => String(e).trim().toLowerCase()).filter(Boolean));
  const realOf = new Map<string, Array<{ id: number; name: string | null }>>();
  for (const c of sameAddress) if (isReal(Number(c.companyID))) for (const k of emailsOf(c).map((e) => e.toLowerCase())) if (byEmail.has(k)) {
    const l = realOf.get(k) ?? realOf.set(k, []).get(k)!;
    if (!l.some((x) => x.id === Number(c.companyID))) l.push({ id: Number(c.companyID), name: companyName.get(Number(c.companyID)) ?? null });
  }
  const review: EmailReview[] = [];
  for (const [k, x] of byEmail) {
    const tickets = ticketsOf.get(k) ?? 0, real = realOf.get(k) ?? [];
    const [decision, why]: [EmailDecision, string] = listed.has(k) ? ['excluded', 'listed to keep']
      : junk.has(k) ? ['inactivate', `listed as junk${tickets ? ` (${tickets} ticket(s) ignored)` : ''}`]
      : tickets > 0 ? ['excluded', `${tickets} ticket(s) with this address — a real person`]
      : real.length ? ['inactivate', `duplicate: also on ${real[0]!.name ?? '#' + real[0]!.id}${real.length > 1 ? ` (+${real.length - 1})` : ''}`]
      : ['inactivate', 'only on placeholder companies'];
    review.push({ email: x.email, copies: x.contactIds.size, companies: x.companies.size, decision, why, realCompanies: real.slice(0, 3), tickets });
    if (decision === 'excluded') for (const cid of x.companies) add(cid, `email ${x.email}: ${why}`);
  }
  o.onProgress?.(`email check: ${review.length} address(es)`);

  // 4. Items: per clean company, its active contacts, then the company itself.
  const items: BulkItemInput[] = [];
  let alreadyInactive = 0, contactWrites = 0, companyWrites = 0;
  const reasons: Record<string, number> = {};
  for (const c of companies.sort((a, b) => Number(a.id) - Number(b.id))) {
    const id = Number(c.id); const active = c.isActive === true || c.isActive === 1;
    const r = why.get(id);
    if (r) {
      items.push({ entity: 'Companies', recordId: id, parentId: null, action: 'inactivate', status: 'excluded', reason: r.join('; '), before: { companyName: c.companyName, isActive: active, createDate: c.createDate ?? null } });
      for (const x of r) { const k = x.startsWith('email ') ? x.replace(/^email \S+: /, 'email: ').replace(/^email: \d+ ticket\(s\)/, 'email: ticket(s)') : x.replace(/^\d+\s+/, '').replace(/ \(e\.g\..*$/, ''); reasons[k] = (reasons[k] ?? 0) + 1; }
      continue;
    }
    if (o.includeContacts !== false) for (const ct of contactsOf.get(id) ?? []) {
      if (!(ct.isActive === true || ct.isActive === 1)) continue;
      items.push({ entity: 'Contacts', recordId: Number(ct.id), parentId: id, action: 'inactivate', before: { isActive: 1, name: [ct.firstName, ct.lastName].filter(Boolean).join(' ') } });
      contactWrites++;
    }
    if (active) { items.push({ entity: 'Companies', recordId: id, parentId: null, action: 'inactivate', before: { companyName: c.companyName, isActive: true, createDate: c.createDate ?? null } }); companyWrites++; }
    else alreadyInactive++;
  }
  const excluded = items.filter((i) => i.status === 'excluded').length;
  return {
    items,
    stats: {
      selector: sel, companies: companies.length, excludedCompanies: excluded, excludedBy: reasons,
      // The review table (before approval): kept addresses first, then duplicates of real contacts, then the most-copied.
      emailSummary: { addresses: review.length, kept: review.filter((r) => r.decision === 'excluded').length, withTickets: review.filter((r) => r.tickets > 0).length, listed: review.filter((r) => r.why === 'listed to keep').length, junk: review.filter((r) => r.why.startsWith('listed as junk')).length, duplicatesOfReal: review.filter((r) => r.decision === 'inactivate' && r.realCompanies.length).length, onlyOnPlaceholders: review.filter((r) => r.why === 'only on placeholder companies').length },
      emailReview: review.sort((a, b) => (a.decision === b.decision ? 0 : a.decision === 'excluded' ? -1 : 1) || (b.realCompanies.length ? 1 : 0) - (a.realCompanies.length ? 1 : 0) || b.copies - a.copies).slice(0, 300), companiesAlreadyInactive: alreadyInactive, companyWrites, contactWrites, writes: companyWrites + contactWrites, contactsSeen: contacts.length, prepareReads: calls.n },
  };
}
