// Vendor import + mapping proposals (P0, read-only toward Autotask). Proposals
// are suggestions; nothing becomes a mapping until a person accepts it
// (reconcile_resolve_mapping set / accept), and an unmatched vendor customer or
// SKU is surfaced — never attached to an arbitrary Autotask record.

import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { pax8Adapter } from './pax8.js';
import { cadenceMatches, manufacturerOf, offeringName, productKey, renamedKey, serviceCadence, similarity } from './offerings.js';
import type { ParsedDocument, VendorAdapter } from './types.js';
import type { CatalogLink, CrosswalkRow, CustomerMapping, Offering, OfferingMapping, VendorStore } from './store.js';

export const ADAPTERS: VendorAdapter[] = [pax8Adapter];

const norm = (s: unknown) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Pax8 PSA admin → Mappings → "Download company report". */
const PAX8_CROSSWALK_HEADER = /^\uFEFF?\s*Company ID\s*,\s*Company Name\s*,\s*PSA Company ID\s*,\s*PSA Company Name/i;

export type ImportKind = 'invoice' | 'crosswalk';
export function detectFile(fileName: string, content: string): { kind: ImportKind; vendor: string; adapter?: VendorAdapter } | null {
  const head = content.slice(0, 2000);
  if (PAX8_CROSSWALK_HEADER.test(head)) return { kind: 'crosswalk', vendor: 'pax8' };
  const a = ADAPTERS.find((x) => x.detect(fileName, head));
  return a ? { kind: 'invoice', vendor: a.vendor, adapter: a } : null;
}

export function parseCrosswalk(content: string): CrosswalkRow[] {
  const rows = parse(content, { columns: (h: string[]) => h.map((x) => x.trim()), bom: true, skip_empty_lines: true, relax_column_count: true }) as Array<Record<string, string>>;
  return rows.filter((r) => r['Company Name']).map((r) => ({
    vendor: 'pax8', vendorCustomerRef: String(r['Company ID'] ?? '').trim(), vendorCustomerName: String(r['Company Name']).trim(),
    autotaskCompanyId: /^\d+$/.test(String(r['PSA Company ID'] ?? '').trim()) ? Number(String(r['PSA Company ID']).trim()) : null,
    autotaskCompanyName: String(r['PSA Company Name'] ?? '').trim() || null,
  }));
}

/** "Every line accounted for": per-customer subtotals the vendor printed vs the sum of the imported lines. */
export function documentChecks(d: ParsedDocument): { customers: number; subtotalMismatches: Array<{ customer: string; lines: number; vendorSubtotal: number }>; lineTotal: number } {
  const g = new Map<string, { sum: number; due: number | null; name: string }>();
  for (const l of d.lines) {
    const k = l.vendorCustomerId ?? '(no customer)';
    const due = Number((l.raw as Record<string, unknown>).totalDue);
    const e = g.get(k) ?? { sum: 0, due: Number.isFinite(due) ? due : null, name: l.vendorCustomerName ?? k };
    e.sum += l.costTotal ?? 0; g.set(k, e);
  }
  const subtotalMismatches = [...g.values()].filter((e) => e.due != null && Math.abs(e.sum - e.due) > 0.011).map((e) => ({ customer: e.name, lines: Math.round(e.sum * 100) / 100, vendorSubtotal: e.due! }));
  return { customers: g.size, subtotalMismatches, lineTotal: d.lineTotal };
}

export interface ImportResult {
  kind: ImportKind; vendor: string; created: boolean; sha256: string;
  document?: { id: number; invoiceNumber: string | null; invoiceDate: string | null; lineCount: number; lineTotal: number | null };
  byClass?: Record<string, number>; checks?: ReturnType<typeof documentChecks>; warnings: string[];
  crosswalkRows?: number;
}

export async function importVendorFile(store: VendorStore, f: { content: string; fileName: string; by: string | null; invoiceNumber?: string }): Promise<ImportResult> {
  const det = detectFile(f.fileName, f.content);
  if (!det) throw new Error(`Unrecognised file "${f.fileName}": not a Pax8 invoice CSV export or Pax8 company report. Supported: ${ADAPTERS.map((a) => a.label).join(', ')}; Pax8 company report.`);
  const hash = sha256(f.content);
  if (det.kind === 'crosswalk') {
    const rows = parseCrosswalk(f.content);
    const n = await store.importCrosswalk(rows, hash, f.by);
    return { kind: 'crosswalk', vendor: det.vendor, created: n > 0, sha256: hash, crosswalkRows: rows.length, warnings: rows.filter((r) => r.autotaskCompanyId == null).map((r) => `${r.vendorCustomerName}: no PSA company id`) };
  }
  const d = det.adapter!.parse(f.content, { fileName: f.fileName, invoiceNumber: f.invoiceNumber });
  const checks = documentChecks(d);
  const warnings = [...d.warnings, ...checks.subtotalMismatches.map((m) => `${m.customer}: lines sum to ${m.lines} but the vendor printed ${m.vendorSubtotal}`)];
  const r = await store.importDocument({ ...d, warnings }, { sha256: hash, fileName: f.fileName, format: 'csv', by: f.by });
  const byClass: Record<string, number> = {};
  for (const l of d.lines) byClass[l.chargeClass] = (byClass[l.chargeClass] ?? 0) + 1;
  return { kind: 'invoice', vendor: d.vendor, created: r.created, sha256: hash, document: { id: r.doc.id, invoiceNumber: r.doc.invoiceNumber, invoiceDate: r.doc.invoiceDate, lineCount: r.doc.lineCount, lineTotal: r.doc.lineTotal }, byClass, checks, warnings };
}

// ───────────────────────────── proposals ─────────────────────────────

export interface CompanyLookup {
  /** Companies by id (name + active). */
  byIds(ids: number[]): Promise<Array<{ id: number; companyName: string; isActive: boolean }>>;
  /** Companies whose name equals one of these (case-insensitive). */
  byNames(names: string[]): Promise<Array<{ id: number; companyName: string; isActive: boolean }>>;
}

export interface CustomerProposal {
  vendor: string; vendorCustomerId: string; vendorCustomerName: string | null;
  proposed: { status: 'mapped' | 'internal'; autotaskCompanyId: number; autotaskCompanyName: string | null; active: boolean | null } | null;
  method: string; confidence: 'high' | 'medium' | 'low' | 'none'; why: string; current: CustomerMapping | null;
}

export async function proposeCustomers(store: VendorStore, companies: CompanyLookup, vendor: string, opts: { includeMapped?: boolean } = {}): Promise<CustomerProposal[]> {
  const lines = await store.lines({ vendor, limit: 20000 });
  const seen = new Map<string, string | null>();
  for (const l of lines) if (l.vendorCustomerId && !seen.has(l.vendorCustomerId)) seen.set(l.vendorCustomerId, l.vendorCustomerName);
  const current = new Map((await store.customerMappings(vendor)).map((m) => [m.vendorCustomerId, m]));
  const xw = new Map((await store.crosswalk(vendor)).map((x) => [norm(x.vendorCustomerName), x]));
  const todo = [...seen.entries()].filter(([id]) => opts.includeMapped || !current.has(id));
  const xIds = todo.map(([, n]) => xw.get(norm(n))?.autotaskCompanyId).filter((x): x is number => x != null);
  const xCompanies = new Map((xIds.length ? await companies.byIds([...new Set(xIds)]) : []).map((c) => [c.id, c]));
  const unmatchedNames = todo.filter(([, n]) => !xw.get(norm(n))).map(([, n]) => n).filter((x): x is string => !!x);
  const named = unmatchedNames.length ? await companies.byNames(unmatchedNames) : [];
  return todo.map(([id, name]): CustomerProposal => {
    const cur = current.get(id) ?? null;
    const x = xw.get(norm(name));
    if (x && x.autotaskCompanyId != null) {
      const c = xCompanies.get(x.autotaskCompanyId);
      const internal = x.autotaskCompanyId === 0;
      return {
        vendor, vendorCustomerId: id, vendorCustomerName: name, current: cur,
        proposed: { status: internal ? 'internal' : 'mapped', autotaskCompanyId: x.autotaskCompanyId, autotaskCompanyName: c?.companyName ?? x.autotaskCompanyName, active: c ? c.isActive : null },
        method: 'vendor-crosswalk', confidence: c && !c.isActive ? 'medium' : 'high',
        why: internal ? 'the vendor maps it to your own company (id 0) — internal use, never billed to a customer'
          : c && !c.isActive ? `the vendor maps it to ${c.companyName} (${c.id}), which is INACTIVE in Autotask — confirm before billing`
          : `the vendor's PSA mapping: ${c?.companyName ?? x.autotaskCompanyName ?? x.autotaskCompanyId}`,
      };
    }
    const hits = named.filter((c) => norm(c.companyName) === norm(name));
    if (hits.length === 1) return { vendor, vendorCustomerId: id, vendorCustomerName: name, current: cur, proposed: { status: hits[0]!.id === 0 ? 'internal' : 'mapped', autotaskCompanyId: hits[0]!.id, autotaskCompanyName: hits[0]!.companyName, active: hits[0]!.isActive }, method: 'exact-name', confidence: 'medium', why: 'same company name in Autotask (not in the vendor crosswalk) — confirm' };
    return { vendor, vendorCustomerId: id, vendorCustomerName: name, current: cur, proposed: null, method: 'none', confidence: 'none', why: hits.length > 1 ? `${hits.length} Autotask companies share this name` : /\b(gds|demo|internal|test)\b/i.test(String(name)) ? 'not in the crosswalk; the name suggests internal / demo use — set it to internal if so' : 'not in the vendor crosswalk and no Autotask company has this name' };
  });
}

export interface OfferingProposal {
  vendor: string; sku: string; description: string; chargeClasses: string[];
  proposed: { status: 'mapped' | 'not_billable'; offering: { id: number | null; manufacturer: string; name: string } | null };
  confidence: 'high' | 'medium' | 'low'; why: string; current: OfferingMapping | null;
}

export async function proposeOfferings(store: VendorStore, vendor: string, opts: { includeMapped?: boolean } = {}): Promise<OfferingProposal[]> {
  const lines = await store.lines({ vendor, limit: 20000 });
  const skus = new Map<string, { description: string; classes: Set<string>; unit: string | null }>();
  for (const l of lines) {
    const k = l.sku ?? `(no sku) ${l.description.slice(0, 40)}`;
    const e = skus.get(k) ?? { description: l.description, classes: new Set<string>(), unit: l.unit };
    e.classes.add(l.chargeClass);
    // prefer the plain subscription description over "Jun Partial: …"
    if (l.chargeClass === 'recurring') e.description = l.description;
    skus.set(k, e);
  }
  const current = new Map((await store.offeringMappings(vendor)).map((m) => [m.sku, m]));
  const offerings = await store.offerings();
  return [...skus.entries()].filter(([sku]) => opts.includeMapped || !current.has(sku)).map(([sku, e]): OfferingProposal => {
    const cur = current.get(sku) ?? null;
    const classes = [...e.classes];
    if (classes.every((c) => c === 'vendor_fee')) return { vendor, sku, description: e.description, chargeClasses: classes, current: cur, proposed: { status: 'not_billable', offering: null }, confidence: 'high', why: 'a vendor fee / surcharge — GDS overhead unless your fee policy allocates it' };
    const manufacturer = manufacturerOf(vendor, sku, e.description);
    const name = offeringName(e.description.replace(/^[A-Z][a-z]{2} Partial:?\s*/, ''));
    const existing = offerings.find((o) => o.manufacturer === manufacturer && productKey(o.name) === productKey(name));
    return {
      vendor, sku, description: e.description, chargeClasses: classes, current: cur,
      proposed: { status: 'mapped', offering: { id: existing?.id ?? null, manufacturer, name: existing?.name ?? name } },
      confidence: manufacturer === 'Unknown' ? 'low' : existing ? 'high' : 'medium',
      why: existing ? `same product as the existing offering "${existing.manufacturer} | ${existing.name}"` : manufacturer === 'Unknown' ? 'manufacturer not recognised from the SKU — set it' : 'new offering from the vendor description',
    };
  });
}

export interface CatalogProposal {
  autotaskEntity: 'Services'; autotaskId: number; name: string; cadence: string; unitCost: number | null; unitPrice: number | null;
  proposed: { offeringId: number; offering: string } | null;
  candidates: Array<{ offeringId: number; offering: string; score: number }>;
  confidence: 'high' | 'medium' | 'low' | 'none'; why: string; current: CatalogLink | null;
}

export async function proposeCatalogLinks(store: VendorStore, services: Array<{ id: number; name: string; periodType?: number | null; unitCost?: number | null; unitPrice?: number | null; isActive?: boolean }>, opts: { includeLinked?: boolean; offeringIds?: number[] } = {}): Promise<CatalogProposal[]> {
  const offerings = (await store.offerings()).filter((o) => !opts.offeringIds?.length || opts.offeringIds.includes(o.id));
  const current = new Map((await store.catalogLinks()).filter((l) => l.autotaskEntity === 'Services').map((l) => [l.autotaskId, l]));
  const label = (o: Offering) => `${o.manufacturer} | ${o.name}`;
  const out: CatalogProposal[] = [];
  for (const s of services.filter((x) => x.isActive !== false)) {
    const cur = current.get(s.id) ?? null;
    if (cur && !opts.includeLinked) continue;
    const key = productKey(s.name);
    const exact = offerings.filter((o) => productKey(o.name) === key);
    const newKey = exact.length ? null : renamedKey(s.name);
    const renamed = newKey ? offerings.filter((o) => productKey(o.name) === newKey) : [];
    const ranked = offerings.map((o) => ({ offeringId: o.id, offering: label(o), score: Math.round(similarity(o.name, s.name) * 100) / 100 })).filter((c) => c.score >= 0.34).sort((a, b) => b.score - a.score).slice(0, 3);
    const cadence = serviceCadence(s.name, s.periodType ?? null);
    const base = { autotaskEntity: 'Services' as const, autotaskId: s.id, name: s.name, cadence, unitCost: s.unitCost ?? null, unitPrice: s.unitPrice ?? null, current: cur };
    if (exact.length === 1) out.push({ ...base, proposed: { offeringId: exact[0]!.id, offering: label(exact[0]!) }, candidates: ranked, confidence: cadence ? 'high' : 'medium', why: cadence ? `same product; sells ${cadence}` : 'same product; the service name does not state the term — confirm it' });
    else if (renamed.length === 1) out.push({ ...base, proposed: { offeringId: renamed[0]!.id, offering: label(renamed[0]!) }, candidates: ranked, confidence: 'medium', why: `renamed product: now sold as ${renamed[0]!.name}${cadence ? `; sells ${cadence}` : '; the service name does not state the term'} — confirm it` });
    else if (ranked.length) out.push({ ...base, proposed: null, candidates: ranked, confidence: 'low', why: 'similar names only — pick one, or leave unlinked' });
  }
  return out;
}

export { cadenceMatches };
