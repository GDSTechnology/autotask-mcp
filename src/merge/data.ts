// Safe merges — what is read from Autotask (read-only). Every query pages to
// exhaustion (maxRecords well above any real duplicate set) and the result says
// when a cap was reached, so a count is never silently a page size.

import type { QueryFn } from '../vendors/contract-io.js';
import { inChunks } from '../vendors/contract-context.js';
import { COMPANY_REFS, CONTACT_REFS, isPlaceholderCompany, isPlaceholderContact, summarizeInventory, type MergeEntity, type MergeRecord, type RecordInventory, type RefCount, type RefSpec } from './model.js';

export const READ_CAP = 10_000;
export const COMPANY_FIELDS = ['id', 'companyName', 'isActive', 'companyType', 'createDate', 'createdByResourceID', 'parentCompanyID', 'phone', 'webAddress', 'address1', 'address2', 'city', 'state', 'postalCode', 'fax', 'companyNumber'];
export const CONTACT_FIELDS = ['id', 'firstName', 'lastName', 'emailAddress', 'emailAddress2', 'emailAddress3', 'companyID', 'isActive', 'createDate', 'phone', 'mobilePhone', 'title', 'primaryContact', 'addressLine', 'city', 'state', 'zipCode'];

export interface MergeDeps {
  q: QueryFn;
  link: (kind: MergeEntity, id: number) => string | null;
  resourceNames: (ids: number[]) => Promise<Map<number, string>>;
  /** Is this field writable through the API? null when field info can't be read. */
  writable: (entity: string, field: string) => Promise<boolean | null>;
  /** The entity's field names in this tenant (null = unknown). includeFields naming a missing field fails the whole query. */
  fieldNames: (entity: string) => Promise<Set<string> | null>;
}

/** Only the wanted fields this tenant has (always id). */
export async function fieldsFor(d: MergeDeps, entity: string, wanted: string[]): Promise<string[]> {
  const have = await d.fieldNames(entity).catch(() => null);
  // Unknown field list: ask for what we want — a failing query then shows as an error, never as a silent 0.
  return have ? wanted.filter((f) => f === 'id' || have.has(f)) : wanted;
}

const day = (d: unknown) => (d ? String(d).slice(0, 10) : null);
const name = (c: Record<string, any>) => [c.firstName, c.lastName].map((x) => String(x ?? '').trim()).filter(Boolean).join(' ');

export async function loadCompanies(d: MergeDeps, ids: number[]): Promise<Array<Record<string, any>>> {
  return inChunks<Record<string, any>>(d.q, 'Companies', 'id', ids, [], await fieldsFor(d, 'Companies', COMPANY_FIELDS));
}
export async function loadContactsById(d: MergeDeps, ids: number[]): Promise<Array<Record<string, any>>> {
  return inChunks<Record<string, any>>(d.q, 'Contacts', 'id', ids, [], await fieldsFor(d, 'Contacts', CONTACT_FIELDS));
}

export function companyRecord(d: MergeDeps, c: Record<string, any>, creators: Map<number, string>): MergeRecord {
  return { id: Number(c.id), name: String(c.companyName ?? ''), isActive: c.isActive === true || c.isActive === 1, createDate: c.createDate ?? null, createdBy: c.createdByResourceID != null ? creators.get(Number(c.createdByResourceID)) ?? `resource ${c.createdByResourceID}` : null, placeholder: isPlaceholderCompany(c), fields: c, link: d.link('company', Number(c.id)) };
}
export function contactRecord(d: MergeDeps, c: Record<string, any>, companies: Map<number, string>): MergeRecord {
  return { id: Number(c.id), name: name(c) || '(no name)', isActive: c.isActive === true || c.isActive === 1, createDate: c.createDate ?? null, createdBy: null, placeholder: isPlaceholderContact(c), companyId: c.companyID == null ? null : Number(c.companyID), companyName: c.companyID != null ? companies.get(Number(c.companyID)) ?? null : null, fields: c, link: d.link('contact', Number(c.id)) };
}

export interface DiscoverInput { email?: string; companyIds?: number[]; contactIds?: number[]; name?: string; includeInactive?: boolean; limit?: number }

/** Candidate duplicates — read-only. Never chooses a survivor. */
export async function discover(d: MergeDeps, i: DiscoverInput): Promise<Record<string, unknown>> {
  const contacts = new Map<number, Record<string, any>>();
  const companies = new Map<number, Record<string, any>>();
  const queries: string[] = [];
  let capped = false;
  const add = (rows: Array<Record<string, any>>, into: Map<number, Record<string, any>>) => { if (rows.length >= READ_CAP) capped = true; for (const r of rows) into.set(Number(r.id), r); };
  const active = i.includeInactive === false ? [{ op: 'eq', field: 'isActive', value: 1 }] : [];

  const email = String(i.email ?? '').trim().toLowerCase();
  if (email) {
    // Each email field separately — an exact match in emailAddress2 / 3 counts too.
    for (const f of ['emailAddress', 'emailAddress2', 'emailAddress3']) {
      add(await d.q<Record<string, any>>('Contacts', [{ op: 'eq', field: f, value: email }, ...active], { maxRecords: READ_CAP, includeFields: await fieldsFor(d, 'Contacts', CONTACT_FIELDS) }), contacts);
      queries.push(`Contacts ${f} = ${email}`);
    }
  }
  if (i.contactIds?.length) { add(await loadContactsById(d, i.contactIds), contacts); queries.push(`Contacts id in ${i.contactIds.length} id(s)`); }
  if (i.companyIds?.length) {
    add(await loadCompanies(d, i.companyIds), companies);
    add(await inChunks<Record<string, any>>(d.q, 'Contacts', 'companyID', i.companyIds, active, await fieldsFor(d, 'Contacts', CONTACT_FIELDS)), contacts);
    queries.push(`Companies id in ${i.companyIds.length} id(s) + their contacts`);
  }
  if (i.name) {
    add(await d.q<Record<string, any>>('Companies', [{ op: 'eq', field: 'companyName', value: i.name.trim() }, ...(i.includeInactive === false ? [{ op: 'eq', field: 'isActive', value: true }] : [])], { maxRecords: READ_CAP, includeFields: await fieldsFor(d, 'Companies', COMPANY_FIELDS) }), companies);
    queries.push(`Companies companyName = "${i.name.trim()}"`);
  }
  // The companies the contacts are on.
  const missing = [...new Set([...contacts.values()].map((c) => Number(c.companyID)).filter((id) => Number.isFinite(id) && !companies.has(id)))];
  if (missing.length) add(await loadCompanies(d, missing), companies);

  const creators = await d.resourceNames([...new Set([...companies.values()].map((c) => Number(c.createdByResourceID)).filter(Number.isFinite))]).catch(() => new Map<number, string>());
  const coRecs = [...companies.values()].map((c) => companyRecord(d, c, creators));
  const coName = new Map(coRecs.map((c) => [c.id, c.name]));
  const ctRecs = [...contacts.values()].map((c) => contactRecord(d, c, coName));

  const byCreator = new Map<string, { companies: number; active: number }>();
  for (const c of coRecs) { const k = c.createdBy ?? 'unknown'; const e = byCreator.get(k) ?? { companies: 0, active: 0 }; e.companies++; if (c.isActive) e.active++; byCreator.set(k, e); }
  const byDay = new Map<string, number>();
  for (const c of coRecs) { const k = day(c.createDate) ?? '?'; byDay.set(k, (byDay.get(k) ?? 0) + 1); }
  const contactsOf = new Map<number, number[]>();
  for (const c of ctRecs) if (c.companyId != null) (contactsOf.get(c.companyId) ?? contactsOf.set(c.companyId, []).get(c.companyId)!).push(c.id);
  // Real (non-placeholder) companies first, active first, then the oldest — HINTS for a person, never a decision.
  const hints = coRecs.filter((c) => !c.placeholder).sort((a, b) => Number(b.isActive) - Number(a.isActive) || String(a.createDate ?? '').localeCompare(String(b.createDate ?? ''))).slice(0, 10)
    .map((c) => ({ id: c.id, name: c.name, isActive: c.isActive, createDate: day(c.createDate), contacts: contactsOf.get(c.id)?.length ?? 0, link: c.link }));
  const limit = Math.min(Math.max(i.limit ?? 500, 1), 5000);
  const sorted = coRecs.sort((a, b) => String(b.createDate ?? '').localeCompare(String(a.createDate ?? '')));
  const dates = coRecs.map((c) => c.createDate).filter(Boolean).sort() as string[];
  return {
    queries, capped,
    totals: {
      contacts: ctRecs.length, activeContacts: ctRecs.filter((c) => c.isActive).length, placeholderContacts: ctRecs.filter((c) => c.placeholder).length,
      companies: coRecs.length, activeCompanies: coRecs.filter((c) => c.isActive).length, placeholderCompanies: coRecs.filter((c) => c.placeholder).length,
      companiesWithOneContact: coRecs.filter((c) => (contactsOf.get(c.id)?.length ?? 0) === 1).length,
    },
    created: { first: dates[0] ?? null, latest: dates[dates.length - 1] ?? null, byDay: Object.fromEntries([...byDay.entries()].sort()), byCreator: Object.fromEntries(byCreator) },
    survivorHints: hints,
    companies: sorted.slice(0, limit).map((c) => ({ id: c.id, name: c.name, isActive: c.isActive, createDate: c.createDate, createdBy: c.createdBy, placeholder: c.placeholder, contactIds: contactsOf.get(c.id) ?? [], link: c.link })),
    contacts: ctRecs.slice(0, limit).map((c) => ({ id: c.id, name: c.name, isActive: c.isActive, createDate: c.createDate, companyId: c.companyId, company: c.companyName, placeholder: c.placeholder, emails: [c.fields.emailAddress, c.fields.emailAddress2, c.fields.emailAddress3].filter(Boolean), link: c.link })),
    listed: { companies: Math.min(sorted.length, limit), contacts: Math.min(ctRecs.length, limit) },
  };
}

/** Everything that points at each record, per entity — counts, ids (first 50), active ones, and whether the API could move it. */
export async function inventory(d: MergeDeps, entity: MergeEntity, ids: number[]): Promise<Map<number, RecordInventory>> {
  const specs: RefSpec[] = entity === 'company' ? COMPANY_REFS : CONTACT_REFS;
  const per = new Map<number, RefCount[]>(ids.map((id) => [id, []]));
  for (const sp of specs) {
    let rows: Array<Record<string, any>> = []; let error: string | null = null;
    try {
      rows = await inChunks<Record<string, any>>(d.q, sp.entity, sp.field, ids, [], await fieldsFor(d, sp.entity, ['id', sp.field, ...(sp.activeWhen ? [sp.activeWhen.field] : [])]));
    } catch (e) { error = (e instanceof Error ? e.message : String(e)).slice(0, 160); }
    const movable = error ? null : await d.writable(sp.entity, sp.field).catch(() => null);
    for (const id of ids) {
      const mine = rows.filter((r) => Number(r[sp.field]) === id);
      const act = sp.activeWhen ? mine.filter((r) => r[sp.activeWhen!.field] === sp.activeWhen!.value || (sp.activeWhen!.value === true && r[sp.activeWhen!.field] === 1)).length : null;
      per.get(id)!.push({ entity: sp.entity, label: sp.label, field: sp.field, count: mine.length, active: act, ids: mine.slice(0, 50).map((r) => Number(r.id)), money: !!sp.money, movableByApi: movable, error });
    }
  }
  return new Map(ids.map((id) => [id, summarizeInventory(id, per.get(id)!, entity)]));
}
