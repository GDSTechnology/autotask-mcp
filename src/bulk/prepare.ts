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

export interface PlaceholderSelector { companyName: string; createdByResourceId?: number; createdFrom?: string; createdTo?: string }

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
    contacts.push(...await q<Record<string, any>>('Contacts', [{ op: 'in', field: 'companyID', value: ids.slice(i, i + 200) }], { maxRecords: 5000, includeFields: ['id', 'companyID', 'isActive', 'firstName', 'lastName'] }));
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

  // 4. Items: per clean company, its active contacts, then the company itself.
  const items: BulkItemInput[] = [];
  let alreadyInactive = 0, contactWrites = 0, companyWrites = 0;
  const reasons: Record<string, number> = {};
  for (const c of companies.sort((a, b) => Number(a.id) - Number(b.id))) {
    const id = Number(c.id); const active = c.isActive === true || c.isActive === 1;
    const r = why.get(id);
    if (r) {
      items.push({ entity: 'Companies', recordId: id, parentId: null, action: 'inactivate', status: 'excluded', reason: r.join('; '), before: { companyName: c.companyName, isActive: active, createDate: c.createDate ?? null } });
      for (const x of r) { const k = x.replace(/^\d+\s+/, '').replace(/ \(e\.g\..*$/, ''); reasons[k] = (reasons[k] ?? 0) + 1; }
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
    stats: { selector: sel, companies: companies.length, excludedCompanies: excluded, excludedBy: reasons, companiesAlreadyInactive: alreadyInactive, companyWrites, contactWrites, writes: companyWrites + contactWrites, contactsSeen: contacts.length, prepareReads: calls.n },
  };
}
