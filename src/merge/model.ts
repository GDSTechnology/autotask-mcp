// Safe company / contact merges — the pure core (spec: safe account and contact
// consolidation, rev 1.1). Autotask has NO REST merge endpoint and Companies
// can't be deleted through the API; the web UI has a native merge (then the old
// record is deleted in Admin). So the MCP finds duplicates, inventories what is
// attached to each record, builds an ID-only plan of UI steps with deep links,
// and verifies afterwards. Plans are addressed ONLY by numeric ids:
//   company: survivorCompanyId + sourceCompanyIds   contact: survivorContactId + sourceContactIds
// A name / email / search is never a merge identifier, and a company merge never
// merges contacts. Plans of kind merge_* are a work list: autotask_change_plan_execute
// refuses them.

import { isUnsafeCompanyName } from '../utils/company-guard.js';
import type { PlanRowInput } from '../change-plans/store.js';

export type MergeEntity = 'company' | 'contact';
export const MERGE_PLAN_KINDS = { company: 'merge_company', contact: 'merge_contact' } as const;
export const MAX_SOURCES = 50;

// ── ids ─────────────────────────────────────────────────────────────────────

/** Survivor + sources: whole positive numbers, no repeats, the survivor never a source. Names / emails are refused. */
export function validateMergeIds(entity: MergeEntity, survivor: unknown, sources: unknown): { ok: true; survivor: number; sources: number[] } | { ok: false; error: string } {
  const label = entity === 'company' ? 'Company' : 'Contact';
  const sField = entity === 'company' ? 'survivorCompanyId' : 'survivorContactId';
  const srcField = entity === 'company' ? 'sourceCompanyIds' : 'sourceContactIds';
  const asId = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : typeof v === 'string' && /^\d+$/.test(v.trim()) ? Number(v.trim()) : null);
  const s = asId(survivor);
  if (s == null) return { ok: false, error: `${sField} must be an Autotask ${label} ID number (got ${JSON.stringify(survivor)}). Names, emails and searches are never merge identifiers — find the ids with autotask_merge_discover.` };
  if (s <= 0) return { ok: false, error: `${sField} ${s}: ${entity === 'company' && s === 0 ? 'company 0 is your own company — it is never merged' : 'must be a positive id'}.` };
  if (!Array.isArray(sources) || !sources.length) return { ok: false, error: `${srcField} must be a non-empty array of ${label} ID numbers.` };
  const ids: number[] = [];
  for (const v of sources) {
    const n = asId(v);
    if (n == null) return { ok: false, error: `${srcField} has ${JSON.stringify(v)} — only ${label} ID numbers are accepted.` };
    if (n <= 0) return { ok: false, error: `${srcField} has ${n}: ${entity === 'company' && n === 0 ? 'company 0 is your own company — it is never merged' : 'ids are positive'}.` };
    if (n === s) return { ok: false, error: `${srcField} contains the survivor ${s} — a record can't be merged into itself.` };
    if (ids.includes(n)) return { ok: false, error: `${srcField} lists ${n} twice.` };
    ids.push(n);
  }
  if (ids.length > MAX_SOURCES) return { ok: false, error: `${ids.length} sources — at most ${MAX_SOURCES} per plan (merge in batches).` };
  return { ok: true, survivor: s, sources: [...ids].sort((a, b) => a - b) };
}

// ── placeholders ────────────────────────────────────────────────────────────

const PLACEHOLDER_COMPANY = /^(unknown|n\/?a|none|no company|tbd|test)\b/i;
const PLACEHOLDER_CONTACT = /^(unknown( contact)?|n\/?a|none|no name|customer|user)$/i;
const PLACEHOLDER_PHONE = /^[\s()+-]*0[0\s()+-]*$/;

/** A company that is not a real customer: a webmail provider ("Gmail"), a greeting, "Unknown…". */
export function isPlaceholderCompany(c: { companyName?: unknown }): string | null {
  const name = String(c.companyName ?? '').trim();
  const g = isUnsafeCompanyName(name);
  if (!g.safe) return g.reason ?? 'not a company name';
  return PLACEHOLDER_COMPANY.test(name) ? `"${name}" is a placeholder name` : null;
}
export function isPlaceholderContact(c: { firstName?: unknown; lastName?: unknown }): string | null {
  const full = [c.firstName, c.lastName].map((x) => String(x ?? '').trim()).filter(Boolean).join(' ');
  if (!full) return 'no name';
  return PLACEHOLDER_CONTACT.test(full) ? `"${full}" is a placeholder name` : null;
}
/** Placeholder field values never copied over real data. */
export const isPlaceholderValue = (v: unknown): boolean => { const s = String(v ?? '').trim(); return !s || PLACEHOLDER_PHONE.test(s) || /^(unknown|n\/?a|none|gmail)$/i.test(s); };

// ── dependency matrix ───────────────────────────────────────────────────────

/** What can point at a company / a contact. `money`: financial history (stays where it is; never reparented by the MCP). */
export interface RefSpec { entity: string; field: string; label: string; money?: boolean; activeWhen?: { field: string; value: unknown; label: string } }
export const COMPANY_REFS: RefSpec[] = [
  { entity: 'Contacts', field: 'companyID', label: 'contacts', activeWhen: { field: 'isActive', value: true, label: 'active' } },
  { entity: 'Tickets', field: 'companyID', label: 'tickets' },
  { entity: 'Projects', field: 'companyID', label: 'projects' },
  { entity: 'Contracts', field: 'companyID', label: 'contracts', activeWhen: { field: 'status', value: 1, label: 'active' } },
  { entity: 'Opportunities', field: 'companyID', label: 'opportunities' },
  { entity: 'Quotes', field: 'companyID', label: 'quotes' },
  { entity: 'SalesOrders', field: 'companyID', label: 'sales orders' },
  { entity: 'ConfigurationItems', field: 'companyID', label: 'configuration items', activeWhen: { field: 'isActive', value: true, label: 'active' } },
  { entity: 'ServiceCalls', field: 'companyID', label: 'service calls' },
  { entity: 'CompanyNotes', field: 'companyID', label: 'company notes' },
  { entity: 'CompanyToDos', field: 'companyID', label: 'to-dos' },
  { entity: 'CompanyLocations', field: 'companyID', label: 'locations' },
  { entity: 'CompanyAlerts', field: 'companyID', label: 'alerts' },
  { entity: 'Invoices', field: 'companyID', label: 'invoices', money: true },
  { entity: 'BillingItems', field: 'companyID', label: 'billing items', money: true },
  { entity: 'Companies', field: 'parentCompanyID', label: 'child companies' },
];
export const CONTACT_REFS: RefSpec[] = [
  { entity: 'Tickets', field: 'contactID', label: 'tickets' },
  { entity: 'Projects', field: 'contactID', label: 'projects' },
  { entity: 'Contracts', field: 'contactID', label: 'contracts', activeWhen: { field: 'status', value: 1, label: 'active' } },
  { entity: 'Opportunities', field: 'contactID', label: 'opportunities' },
  { entity: 'Quotes', field: 'contactID', label: 'quotes' },
  { entity: 'ConfigurationItems', field: 'contactID', label: 'configuration items' },
  { entity: 'CompanyToDos', field: 'contactID', label: 'to-dos' },
];

export interface RefCount {
  entity: string; label: string; field: string; count: number; active: number | null; ids: number[]; money: boolean;
  /** Can the API change this reference? null = not known (field info unavailable). */
  movableByApi: boolean | null;
  /** The query failed (field not queryable in this tenant…): check by hand. */
  error: string | null;
}
export interface RecordInventory { id: number; refs: RefCount[]; total: number; blockers: string[] }

/** Per-record counts → totals and what needs a person before a merge. */
export function summarizeInventory(id: number, refs: RefCount[], entity: MergeEntity): RecordInventory {
  const blockers: string[] = [];
  for (const r of refs) {
    if (r.error) blockers.push(`${r.label}: could not be checked (${r.error}) — look in Autotask before merging`);
    if (r.entity === 'Contracts' && (r.active ?? 0) > 0) blockers.push(`${r.active} ACTIVE contract(s) — billing review before merging (contract ${r.ids.slice(0, 5).join(', ')})`);
    if (r.money && r.count) blockers.push(`${r.count} ${r.label} — financial history; check how the UI merge carries it, never reparent it by hand`);
    if (entity === 'company' && r.entity === 'Companies' && r.count) blockers.push(`parent of ${r.count} compan(ies) — billing / parent routing may change`);
  }
  return { id, refs, total: refs.reduce((t, r) => t + r.count, 0), blockers };
}

// ── plan rows ───────────────────────────────────────────────────────────────

export interface MergeRecord { id: number; name: string; isActive: boolean; createDate: string | null; createdBy: string | null; placeholder: string | null; companyId?: number | null; companyName?: string | null; fields: Record<string, unknown>; link: string | null }

/** Fields worth carrying to the survivor when it is empty there and a real value exists on a source. */
const ENRICH_FIELDS: Record<MergeEntity, string[]> = {
  company: ['phone', 'webAddress', 'address1', 'address2', 'city', 'state', 'postalCode', 'fax'],
  contact: ['phone', 'mobilePhone', 'title', 'emailAddress2', 'emailAddress3', 'addressLine', 'city', 'state', 'zipCode'],
};

export function buildMergeRows(entity: MergeEntity, survivor: MergeRecord, sources: MergeRecord[], inv: Map<number, RecordInventory>, o: { billingReviewed?: boolean; firstRowNo?: number } = {}): PlanRowInput[] {
  const offset = (o.firstRowNo ?? 1) - 1;
  const what = entity === 'company' ? 'company' : 'contact';
  const rows: PlanRowInput[] = [];
  const counts = (id: number) => Object.fromEntries((inv.get(id)?.refs ?? []).filter((r) => r.count).map((r) => [r.label, r.count]));
  for (const s of sources) {
    const i = inv.get(s.id);
    const hard = (i?.blockers ?? []).filter((b) => /ACTIVE contract/.test(b) && !o.billingReviewed);
    const crossCompany = entity === 'contact' && s.companyId != null && survivor.companyId != null && s.companyId !== survivor.companyId;
    const mergeRow = offset + rows.length + 1;
    rows.push({
      meta: { step: 'merge', sourceId: s.id, survivorId: survivor.id, entity },
      action: 'manual', entity: entity === 'company' ? 'Companies' : 'Contacts', targetId: s.id,
      label: `MERGE ${what} #${s.id} "${s.name}"${s.isActive ? '' : ' (inactive)'} → #${survivor.id} "${survivor.name}" in the Autotask UI`,
      before: { source: { id: s.id, name: s.name, ...(entity === 'contact' ? { companyId: s.companyId, company: s.companyName } : {}) }, attached: counts(s.id) },
      after: { mergedInto: survivor.id },
      reason: [
        `Open both: source ${s.link ?? `#${s.id}`} and survivor ${survivor.link ?? `#${survivor.id}`}. Merge the source INTO the survivor with Autotask's merge.`,
        i?.blockers.length ? `Check first: ${i.blockers.join('; ')}.` : 'Nothing attached needs a decision first.',
        crossCompany ? `The contacts are on different companies (#${s.companyId} "${s.companyName ?? ''}" vs #${survivor.companyId} "${survivor.companyName ?? ''}") — confirm they are the same person before merging.` : '',
        s.placeholder ? `Source is a placeholder (${s.placeholder}).` : '',
      ].filter(Boolean).join(' '),
      blocked: hard.length ? `${hard.join('; ')} — rebuild with billingReviewed: true once billing has signed off` : null,
    });
    rows.push({
      meta: { step: 'delete', sourceId: s.id, survivorId: survivor.id, entity, dependsOn: [mergeRow] },
      action: 'manual', entity: entity === 'company' ? 'Companies' : 'Contacts', targetId: s.id,
      label: `DELETE ${what} #${s.id} "${s.name}" in Autotask Admin — only after the merge, and only when autotask_merge_verify shows nothing left on it`,
      before: null, after: { deleted: true },
      reason: `After row ${mergeRow}. Run autotask_merge_verify { planId } first: it re-reads #${s.id} and everything that pointed at it.`, blocked: null,
    });
  }
  // Survivor gaps a real source value could fill — suggestions, copied by hand only if correct.
  for (const f of ENRICH_FIELDS[entity]) {
    if (!isPlaceholderValue(survivor.fields[f])) continue;
    const donor = sources.find((s) => !s.placeholder && !isPlaceholderValue(s.fields[f]));
    if (!donor) continue;
    rows.push({ meta: { step: 'enrich', field: f, fromId: donor.id, survivorId: survivor.id, entity }, action: 'manual', entity: entity === 'company' ? 'Companies' : 'Contacts', targetId: survivor.id,
      label: `SURVIVOR #${survivor.id} has no ${f}; #${donor.id} has "${String(donor.fields[f])}" — copy it if it is right`, before: { [f]: survivor.fields[f] ?? null }, after: { [f]: donor.fields[f] },
      reason: 'A suggestion, never applied automatically. Placeholder values (Unknown, 000-000-0000, Gmail) are never proposed.', blocked: null });
  }
  if (entity === 'company') {
    const contactCount = sources.reduce((t, s) => t + ((inv.get(s.id)?.refs.find((r) => r.entity === 'Contacts')?.count) ?? 0), 0);
    if (contactCount) rows.push({ meta: { step: 'contacts', entity }, action: 'info', entity: 'Contacts', targetId: null, before: null, after: null,
      label: `${contactCount} contact(s) on the source companies — a company merge does NOT decide them`,
      reason: `Review them: autotask_merge_discover { companyIds: [${[survivor.id, ...sources.map((s) => s.id)].join(', ')}] }, then a contact plan per person (survivorContactId + sourceContactIds). Same email ≠ same person.`, blocked: 'review separately' });
  }
  return rows;
}

// ── verification ────────────────────────────────────────────────────────────

export type SourceState = 'gone' | 'inactive' | 'active';
export interface VerifyInput { survivor: { exists: boolean; isActive: boolean }; sources: Array<{ id: number; state: SourceState; remaining: number; remainingByLabel: Record<string, number> }> }
export interface VerifyResult { status: 'passed' | 'partial' | 'failed' | 'not_started'; survivorOk: boolean; done: number[]; mergedNotDeleted: number[]; pending: number[]; remnants: Array<{ id: number; remaining: Record<string, number> }>; notes: string[] }

/** A source is done when it is gone (merged + deleted) or inactive with nothing left on it. Deactivation alone with history left is NOT a merge. */
export function evaluateMerge(v: VerifyInput): VerifyResult {
  const notes: string[] = [];
  const survivorOk = v.survivor.exists && v.survivor.isActive;
  if (!v.survivor.exists) notes.push('The SURVIVOR no longer exists — stop: it may have been merged the wrong way round.');
  else if (!v.survivor.isActive) notes.push('The survivor is inactive.');
  const done: number[] = [], mergedNotDeleted: number[] = [], pending: number[] = [];
  const remnants: VerifyResult['remnants'] = [];
  for (const s of v.sources) {
    if (s.state === 'gone') { done.push(s.id); continue; }
    if (s.remaining > 0) { remnants.push({ id: s.id, remaining: s.remainingByLabel }); pending.push(s.id); continue; }
    // Nothing left on it: merged (the UI moved everything) — delete it in Admin.
    mergedNotDeleted.push(s.id);
  }
  if (mergedNotDeleted.length) notes.push(`${mergedNotDeleted.length} source(s) have nothing left but still exist — delete them in Autotask Admin: ${mergedNotDeleted.join(', ')}.`);
  if (remnants.length) notes.push(`${remnants.length} source(s) still have records attached — not merged yet (or the merge left them): ${remnants.map((r) => r.id).join(', ')}.`);
  const status = !survivorOk ? 'failed' : done.length === v.sources.length ? 'passed' : done.length || mergedNotDeleted.length ? 'partial' : 'not_started';
  return { status, survivorOk, done, mergedNotDeleted, pending, remnants, notes };
}

// ── batch: a CSV / list of old id → correct id ─────────────────────────────

export interface MergeGroup { survivor: number; sources: number[] }

/**
 * Many merges at once, still ID-only: rows of { old (source) id, correct (survivor) id }, from a CSV
 * (header optional; the first two numeric columns: old, correct) or a list. Refused: non-numeric ids,
 * an old id twice, an old id that is also a survivor (a chain A→B, B→C — merge B first or point A at C),
 * a survivor merged into itself. Grouped by survivor.
 */
export function parseMergeMappings(entity: MergeEntity, input: { csv?: unknown; mappings?: unknown }): { ok: true; groups: MergeGroup[] } | { ok: false; errors: string[] } {
  const pairs: Array<{ line: number; source: unknown; survivor: unknown }> = [];
  if (typeof input.csv === 'string' && input.csv.trim()) {
    const lines = input.csv.replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    lines.forEach((l, n) => {
      const cells = l.split(/[,;\t]/).map((c) => c.trim().replace(/^"|"$/g, ''));
      if (n === 0 && !cells.some((c) => /^\d+$/.test(c))) return; // header
      pairs.push({ line: n + 1, source: cells[0], survivor: cells[1] });
    });
  } else if (Array.isArray(input.mappings)) {
    input.mappings.forEach((m: any, n) => pairs.push({ line: n + 1, source: m?.sourceId ?? m?.oldId ?? m?.source, survivor: m?.survivorId ?? m?.newId ?? m?.survivor }));
  }
  if (!pairs.length) return { ok: false, errors: ['No rows: give csv ("old_id,new_id" per line) or mappings [{ sourceId, survivorId }].'] };
  const errors: string[] = [];
  const bySource = new Map<number, number>();
  for (const p of pairs) {
    const v = validateMergeIds(entity, p.survivor, [p.source]);
    if (!v.ok) { errors.push(`row ${p.line}: ${v.error}`); continue; }
    const src = v.sources[0]!;
    if (bySource.has(src)) { errors.push(`row ${p.line}: old id ${src} is listed more than once`); continue; }
    bySource.set(src, v.survivor);
  }
  for (const [src, surv] of bySource) if (bySource.has(surv)) errors.push(`old id ${src} → ${surv}, but ${surv} is itself being merged into ${bySource.get(surv)} — a chain; point ${src} at ${bySource.get(surv)} or merge ${surv} first`);
  if (bySource.size > MAX_SOURCES * 10) errors.push(`${bySource.size} rows — at most ${MAX_SOURCES * 10} per plan; split the CSV`);
  if (errors.length) return { ok: false, errors };
  const groups = new Map<number, number[]>();
  for (const [src, surv] of bySource) (groups.get(surv) ?? groups.set(surv, []).get(surv)!).push(src);
  return { ok: true, groups: [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([survivor, sources]) => ({ survivor, sources: sources.sort((a, b) => a - b) })) };
}
