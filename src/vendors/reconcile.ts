// Vendor ↔ customer-contract reconciliation (requirements §4–§6). Pure: given
// one vendor invoice's lines, the identity mappings and the customer's Autotask
// commercial data, produce one report row per (customer, product, term) with
// the comparison and its exceptions.
//
// Matching is on the PRODUCT: a vendor line's offering ↔ the mapped company's
// contracts IN EFFECT for the invoice period (active, Recurring Service type,
// dates overlapping the period) ↔ the contract services — and the service
// BUNDLES whose component services — are that offering. Contracts never name
// the vendor. Nothing is claimed as a confirmed loss unless a POSTED billing
// item for the period shows the billed rate; an unknown quantity or ambiguous
// match is "unverified", never zero.
//
// Three directions are checked:
//   vendor line → contract   below cost, not billed back, quantity short / over, term
//   contract → vendor line   "not purchased": the customer is billed for a product
//                            this vendor supplies but no longer charges us for
//   bundle price → its parts a bundle priced below the landed cost of its components

import { cadenceMatches, productKey, serviceCadence, similarity } from './offerings.js';
import { landedCost, policyFor, priceShouldBe, type CustomerPriceException, type PricingPolicy } from './policy.js';
import type { VendorLine, Cadence } from './types.js';
import type { CatalogLink, CustomerMapping, Offering, OfferingMapping } from './store.js';

export type Severity = 'critical' | 'high' | 'review' | 'info' | 'ok';
const RANK: Record<Severity, number> = { critical: 4, high: 3, review: 2, info: 1, ok: 0 };

/** Contracts.contractType 7 = Recurring Service — the only type that holds services and bundles. */
export const RECURRING_SERVICE_CONTRACT = 7;

export interface ContractRow { id: number; companyID: number; contractName: string; status: number; startDate: string | null; endDate: string | null; contractType?: number | null }
export interface ContractServiceRow { id: number; contractID: number; serviceID: number; unitCost: number | null; unitPrice: number | null; invoiceDescription?: string | null }
export interface ServiceRow { id: number; name: string; periodType: number | null; unitCost: number | null; unitPrice: number | null }
export interface UnitsRow { contractServiceID: number; units: number; price: number | null; cost: number | null; startDate: string; endDate: string }
export interface BilledRow { contractServiceID: number; quantity: number; rate: number; extendedPrice: number; ourCost: number | null; invoiceID: number | null; itemDate: string; posted: boolean }
/** A bundle on a contract (ContractServiceBundles). */
export interface BundleLineRow { id: number; contractID: number; serviceBundleID: number; unitPrice: number | null; adjustedPrice: number | null; invoiceDescription?: string | null }
/** A bundle in the catalog (ServiceBundles) with its component services (ServiceBundleServices). */
export interface BundleRow { id: number; name: string; periodType: number | null; unitCost: number | null; unitPrice: number | null; serviceIds: number[] }
export interface BundleUnitsRow { contractServiceBundleID: number; units: number; price: number | null; cost: number | null; startDate: string; endDate: string }
export interface BilledBundleRow { contractServiceBundleID: number; quantity: number; rate: number; extendedPrice: number; ourCost: number | null; invoiceID: number | null; itemDate: string; posted: boolean }

export interface ReconInput {
  vendor: string;
  invoice: { documentId: number; invoiceNumber: string | null; invoiceDate: string | null; periodStart: string; periodEnd: string };
  lines: VendorLine[];
  customerMappings: CustomerMapping[];
  offeringMappings: OfferingMapping[];
  offerings: Offering[];
  links: CatalogLink[];
  /** Every service referenced by a contract line or a bundle component. */
  services: ServiceRow[];
  companies: Array<{ id: number; companyName: string; isActive: boolean }>;
  /** The mapped companies' ACTIVE contracts (eligibility for the period is decided here). */
  contracts: ContractRow[];
  contractServices: ContractServiceRow[];
  /** The ContractServiceUnits period covering the invoice period start, per contract service. */
  units: UnitsRow[];
  /** Recurring-service billing items (type 6) in the invoice period, per contract service. */
  billed: BilledRow[];
  bundleLines?: BundleLineRow[];
  bundles?: BundleRow[];
  bundleUnits?: BundleUnitsRow[];
  billedBundles?: BilledBundleRow[];
  /** `${companyId}|${offeringId}` with an annual-billed (AA / annual) vendor line in the last 13 months — not on every invoice. */
  recentAnnual?: string[];
  policies: PricingPolicy[];
  customerExceptions: CustomerPriceException[];
  /** One-time contract charges on these contracts purchased on / after the period start — back-bills ("… — back-bill <month> [– <month>]") cover past months. */
  charges?: ChargeRow[];
}

export interface ChargeRow { id: number; contractID: number; contractServiceID: number | null; name: string; unitQuantity: number | null; unitPrice: number | null; isBilled: boolean }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** The months a back-bill charge covers, from its name ("Service — back-bill September 2026 – October 2026"): [from, to] as YYYY-MM. */
export function backbillWindow(name: string): [string, string] | null {
  const m = /back-bill\s+([A-Za-z]+)\s+(\d{4})(?:\s*[–-]\s*([A-Za-z]+)\s+(\d{4}))?/i.exec(name);
  if (!m) return null;
  const ym = (mon: string, y: string) => { const n = MONTHS.findIndex((x) => x.toLowerCase() === mon.toLowerCase()); return n < 0 ? null : `${y}-${String(n + 1).padStart(2, '0')}`; };
  const from = ym(m[1]!, m[2]!), to = m[3] ? ym(m[3], m[4]!) : from;
  return from && to ? [from, to] : null;
}

export interface ReconRow {
  rowNo: number; exceptionKey: string; severity: Severity; exceptions: string[]; reason: string; proposedAction: string; confidence: 'verified' | 'unverified' | 'inferred';
  // required report columns (§10)
  customerName: string | null; autotaskContract: string | null; vendor: string; serviceSku: string; commitmentTerm: string; unit: string | null; quantity: number | null;
  costShouldBe: number | null; priceShouldBe: number | null; currentCost: number | null; currentPrice: number | null; differenceOnCost: number | null; differenceOnPrice: number | null;
  // recommended extras
  autotaskCompanyId: number | null; companyActive: boolean | null; contractId: number | null; contractServiceId: number | null; serviceId: number | null; serviceName: string | null;
  /** service = a contract service line; bundle = a service bundle line (contractServiceBundleId) — a component of it, or the bundle's own price row. */
  lineKind: 'service' | 'bundle' | null; contractServiceBundleId: number | null; serviceBundleId: number | null; bundleName: string | null;
  /** The line the vendor quantity is compared on (one per customer / product / term). */
  primary: boolean;
  offeringId: number | null; offering: string | null; vendorCustomerId: string | null; vendorCustomerName: string | null; skus: string[]; subscriptionIds: string[]; vendorDescription: string;
  cadence: string; contractCadence: string | null;
  /** Report amounts are per this basis (the vendor term); the contract line itself bills per serviceBasis. */
  basis: 'month' | 'year'; serviceBasis: 'month' | 'year' | null;
  contractQuantity: number | null; contractQuantityTotal: number | null; billedQuantity: number | null; billedRate: number | null; billedInvoiceId: number | null; billingPosted: boolean | null;
  catalogCost: number | null; catalogPrice: number | null; vendorUnitCost: number | null; vendorSuggestedPrice: number | null; landedCost: number | null; priceRule: string | null;
  monthlyExposure: number | null; annualExposure: number | null; grossMarginMonthly: number | null; grossMarginPct: number | null;
  matchMethod: 'link' | 'name' | null; otherContractServices: number[]; sourceInvoice: string | null; period: string;
}

const r2 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const r4 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10000) / 10000);
const basisOf = (c: string): 'month' | 'year' => (c === 'AA' || c === 'annual' ? 'year' : 'month');
const periodBasis = (periodType: number | null | undefined): 'month' | 'year' => (periodType === 5 ? 'year' : 'month');
/** Convert a per-unit amount from one billing basis to another. */
const toBasis = (v: number | null, from: 'month' | 'year', to: 'month' | 'year') => (v == null ? null : from === to ? v : from === 'year' ? v / 12 : v * 12);
const monthly = (v: number | null, b: 'month' | 'year') => (v == null ? null : b === 'year' ? v / 12 : v);
const day = (d: string | null) => (d ? d.slice(0, 10) : null);

/** Is this contract in effect for the period and able to hold services? */
export function contractCovers(c: Pick<ContractRow, 'status' | 'startDate' | 'endDate' | 'contractType'>, periodStart: string, periodEnd: string): boolean {
  if (c.status !== 1) return false;
  if (c.contractType != null && c.contractType !== RECURRING_SERVICE_CONTRACT) return false;
  const s = day(c.startDate), e = day(c.endDate);
  return (!s || s <= periodEnd) && (!e || e >= periodStart);
}

/** A line on a contract in effect with no unit period covering the month bills nothing this month. */
const NO_UNITS = { units: 0, price: null, cost: null } as const;

type OfferingRef = { offeringId: number; cadence: string; method: 'link' | 'name' };
interface Cand {
  kind: 'service' | 'bundle'; lineId: number; contractID: number; serviceID: number; o: OfferingRef;
  cs: ContractServiceRow | null; cb: BundleLineRow | null; bundle: BundleRow | null;
  u: { units: number; price: number | null; cost: number | null } | null;
  /** The line has no unit period for the month at all (ended, or never started) — it bills 0. */
  noPeriod?: boolean;
}

export function reconcile(i: ReconInput): { rows: ReconRow[]; summary: Record<string, unknown> } {
  const { periodStart, periodEnd } = i.invoice;
  const cust = new Map(i.customerMappings.map((m) => [m.vendorCustomerId, m]));
  const offMap = new Map(i.offeringMappings.map((m) => [m.sku, m]));
  const offerings = new Map(i.offerings.map((o) => [o.id, o]));
  const links = new Map(i.links.filter((l) => l.autotaskEntity === 'Services').map((l) => [l.autotaskId, l]));
  const services = new Map(i.services.map((s) => [s.id, s]));
  const companies = new Map(i.companies.map((c) => [c.id, c]));
  const contracts = new Map(i.contracts.map((c) => [c.id, c]));
  const units = new Map(i.units.map((u) => [u.contractServiceID, u]));
  const bundles = new Map((i.bundles ?? []).map((b) => [b.id, b]));
  const bundleUnits = new Map((i.bundleUnits ?? []).map((u) => [u.contractServiceBundleID, u]));
  const billed = new Map<number, BilledRow>();
  for (const b of i.billed) { const e = billed.get(b.contractServiceID); if (!e || (b.posted && !e.posted)) billed.set(b.contractServiceID, b); }
  const billedBundle = new Map<number, BilledBundleRow>();
  for (const b of i.billedBundles ?? []) { const e = billedBundle.get(b.contractServiceBundleID); if (!e || (b.posted && !e.posted)) billedBundle.set(b.contractServiceBundleID, b); }
  const recentAnnual = new Set(i.recentAnnual ?? []);
  const vendorOfferings = new Set(i.offeringMappings.filter((m) => m.status === 'mapped' && m.offeringId != null).map((m) => m.offeringId!));
  // Vendor fees as a share of everything else on the invoice (for fee policy "allocate").
  const feeTotal = i.lines.filter((l) => l.chargeClass === 'vendor_fee').reduce((s, l) => s + (l.costTotal ?? 0), 0);
  const otherTotal = i.lines.filter((l) => l.chargeClass !== 'vendor_fee').reduce((s, l) => s + (l.costTotal ?? 0), 0);
  const feeRate = otherTotal > 0 ? feeTotal / otherTotal : 0;

  const offeringOfService = (sid: number): OfferingRef | null => {
    const l = links.get(sid);
    if (l) return { offeringId: l.offeringId, cadence: l.cadence || serviceCadence(services.get(sid)?.name ?? '', services.get(sid)?.periodType ?? null), method: 'link' };
    const s = services.get(sid); if (!s) return null;
    const o = i.offerings.find((x) => productKey(x.name) === productKey(s.name));
    return o ? { offeringId: o.id, cadence: serviceCadence(s.name, s.periodType), method: 'name' } : null;
  };

  // Contract lines per company — only on contracts in effect for the period. Lines on active contracts
  // that are NOT in effect (future renewals, expired, wrong type) are kept to explain a "not billed".
  const candsByCompany = new Map<number, Cand[]>();
  const outOfPeriod = new Map<number, Array<{ contract: ContractRow; offeringId: number }>>();
  /** Lines on contracts in effect whose service isn't linked to any product — a "not billed" may just be one of these. */
  const unlinked = new Map<number, Array<{ contract: ContractRow; serviceID: number }>>();
  const addCand = (companyID: number, c: Cand) => { (candsByCompany.get(companyID) ?? candsByCompany.set(companyID, []).get(companyID)!).push(c); };
  for (const cs of i.contractServices) {
    const c = contracts.get(cs.contractID); if (!c) continue;
    const o = offeringOfService(cs.serviceID);
    if (!o) { if (contractCovers(c, periodStart, periodEnd)) (unlinked.get(c.companyID) ?? unlinked.set(c.companyID, []).get(c.companyID)!).push({ contract: c, serviceID: cs.serviceID }); continue; }
    if (!contractCovers(c, periodStart, periodEnd)) { if (c.status === 1) (outOfPeriod.get(c.companyID) ?? outOfPeriod.set(c.companyID, []).get(c.companyID)!).push({ contract: c, offeringId: o.offeringId }); continue; }
    addCand(c.companyID, { kind: 'service', lineId: cs.id, contractID: c.id, serviceID: cs.serviceID, o, cs, cb: null, bundle: null, u: units.get(cs.id) ?? NO_UNITS, noPeriod: !units.has(cs.id) });
  }
  for (const cb of i.bundleLines ?? []) {
    const c = contracts.get(cb.contractID); const b = bundles.get(cb.serviceBundleID);
    if (!c || !b) continue;
    const covers = contractCovers(c, periodStart, periodEnd);
    for (const sid of b.serviceIds) {
      const o = offeringOfService(sid); if (!o) continue;
      if (!covers) { if (c.status === 1) (outOfPeriod.get(c.companyID) ?? outOfPeriod.set(c.companyID, []).get(c.companyID)!).push({ contract: c, offeringId: o.offeringId }); continue; }
      addCand(c.companyID, { kind: 'bundle', lineId: cb.id, contractID: c.id, serviceID: sid, o, cs: null, cb, bundle: b, u: bundleUnits.get(cb.id) ?? NO_UNITS, noPeriod: !bundleUnits.has(cb.id) });
    }
  }

  // Vendor groups: customer × SKU-offering × cadence. Prorations / credits / usage / fees stay their own rows.
  type G = { key: string; lines: VendorLine[]; kind: 'recurring' | 'other' };
  const groups = new Map<string, G>();
  for (const l of i.lines) {
    const off = l.sku ? offMap.get(l.sku) : undefined;
    const recurring = l.chargeClass === 'recurring';
    const k = recurring ? `${l.vendorCustomerId}|${off?.offeringId ?? `sku:${l.sku}`}|${l.cadence}` : `${l.vendorCustomerId}|${l.lineKey}`;
    (groups.get(k) ?? groups.set(k, { key: k, lines: [], kind: recurring ? 'recurring' : 'other' }).get(k)!).lines.push(l);
  }

  const rows: ReconRow[] = [];
  const push = (r: Omit<ReconRow, 'rowNo'>) => rows.push({ rowNo: rows.length + 1, ...r });
  const period = `${periodStart} – ${periodEnd}`;
  const source = i.invoice.invoiceNumber ? `${i.vendor} ${i.invoice.invoiceNumber}` : `${i.vendor} document ${i.invoice.documentId}`;
  /** What this vendor charges per customer × offering (× cadence): landed unit cost, for the bundle check; and what it supplies at all, for "not purchased". */
  const landedBy = new Map<string, { landed: number; basis: 'month' | 'year' }>();
  const supplied = new Set<string>();
  const noLine = { lineKind: null, contractServiceBundleId: null, serviceBundleId: null, bundleName: null, primary: false, contractQuantityTotal: null } as const;

  for (const g of groups.values()) {
    const l0 = g.lines[0]!;
    const qty = g.lines.reduce((s, l) => s + (l.quantity ?? 0), 0);
    const costTotal = g.lines.reduce((s, l) => s + (l.costTotal ?? 0), 0);
    // The vendor's exact unit cost, quantity-weighted — not total ÷ qty (totals are rounded to the cent).
    const weighted = g.lines.every((l) => l.unitCost != null && l.quantity != null) && qty > 0 ? g.lines.reduce((s, l) => s + l.unitCost! * l.quantity!, 0) / qty : null;
    const unitCost = weighted ?? (qty > 0 ? costTotal / qty : l0.unitCost);
    const vendorSuggested = l0.vendorSuggestedUnitPrice;
    const om = l0.sku ? offMap.get(l0.sku) : undefined;
    const offering = om?.offeringId ? offerings.get(om.offeringId) ?? null : null;
    const cm = l0.vendorCustomerId ? cust.get(l0.vendorCustomerId) : undefined;
    const company = cm?.autotaskCompanyId != null ? companies.get(cm.autotaskCompanyId) ?? null : null;
    const basis = basisOf(l0.cadence);
    const base = {
      vendor: i.vendor, serviceSku: l0.sku ?? '(none)', commitmentTerm: termLabel(l0.cadence, l0.commitmentTerm, l0.billingTerm), unit: l0.unit, quantity: l0.quantity == null ? null : r4(qty),
      autotaskCompanyId: cm?.autotaskCompanyId ?? null, companyActive: company ? company.isActive : null, customerName: company?.companyName ?? l0.vendorCustomerName,
      offeringId: offering?.id ?? null, offering: offering ? `${offering.manufacturer} | ${offering.name}` : null, vendorCustomerId: l0.vendorCustomerId, vendorCustomerName: l0.vendorCustomerName,
      skus: [...new Set(g.lines.map((l) => l.sku).filter((x): x is string => !!x))], subscriptionIds: [...new Set(g.lines.map((l) => l.subscriptionId).filter((x): x is string => !!x))],
      vendorDescription: l0.description, cadence: l0.cadence, basis, vendorUnitCost: r4(unitCost), vendorSuggestedPrice: r4(vendorSuggested), sourceInvoice: source, period,
    };
    const empty = { ...noLine, serviceBasis: null, autotaskContract: null, contractId: null, contractServiceId: null, serviceId: null, serviceName: null, contractCadence: null, contractQuantity: null, billedQuantity: null, billedRate: null, billedInvoiceId: null, billingPosted: null, catalogCost: null, catalogPrice: null, currentCost: null, currentPrice: null, differenceOnCost: null, differenceOnPrice: null, landedCost: null, priceShouldBe: null, costShouldBe: null, priceRule: null, monthlyExposure: null, annualExposure: null, grossMarginMonthly: null, grossMarginPct: null, matchMethod: null, otherContractServices: [] };
    const keyOf = (lineKey: string | null) => `${i.vendor}|${cm?.autotaskCompanyId ?? l0.vendorCustomerId}|${offering?.id ?? `sku:${l0.sku}`}|${l0.cadence}|${g.kind === 'recurring' ? lineKey ?? 'none' : l0.chargeClass}`;

    // Lines that never flow into customer recurring billing as-is.
    if (g.kind === 'other' || om?.status === 'not_billable' || om?.status === 'ignore' || cm?.status === 'internal' || cm?.status === 'ignore' || l0.chargeClass === 'nfr_internal') {
      const why = l0.chargeClass === 'vendor_fee' || om?.status === 'not_billable' ? 'vendor fee — overhead unless the fee policy allocates it'
        : cm?.status === 'internal' ? 'internal use (GDS) — not billed to a customer'
        : l0.chargeClass === 'nfr_internal' ? 'NFR / internal — not billed to a customer'
        : l0.chargeClass === 'proration' || l0.chargeClass === 'credit' ? `${l0.chargeClass} — check the customer was adjusted for the same change`
        : cm?.status === 'ignore' || om?.status === 'ignore' ? 'ignored by decision'
        : `${l0.chargeClass} charge — review whether it is billed on`;
      const sev: Severity = l0.chargeClass === 'proration' || l0.chargeClass === 'credit' || ((l0.chargeClass === 'usage' || l0.chargeClass === 'minimum_commitment') && cm?.status !== 'internal') ? 'review' : 'info';
      push({ ...base, ...empty, exceptionKey: keyOf(null), severity: sev, exceptions: [l0.chargeClass === 'proration' || l0.chargeClass === 'credit' ? 'proration_credit' : 'not_customer_billable'], reason: why, proposedAction: sev === 'review' ? 'review' : 'none', confidence: 'verified' });
      continue;
    }
    if (!cm) { push({ ...base, ...empty, exceptionKey: keyOf(null), severity: 'review', exceptions: ['unmapped_customer'], reason: 'vendor customer not mapped to an Autotask company yet — decide it (resolve_mapping kind=customers)', proposedAction: 'map customer', confidence: 'unverified' }); continue; }
    if (!offering) { push({ ...base, ...empty, exceptionKey: keyOf(null), severity: 'review', exceptions: ['unmapped_sku'], reason: 'SKU not mapped to an offering yet — decide it (resolve_mapping kind=offerings)', proposedAction: 'map SKU', confidence: 'unverified' }); continue; }

    const policy = policyFor(i.policies, offering.id, offering.manufacturer);
    const negotiated = i.customerExceptions.find((e) => e.autotaskCompanyId === cm.autotaskCompanyId && e.offeringId === offering.id && (!e.cadence || e.cadence === l0.cadence)) ?? null;
    const landed = landedCost(unitCost, feeRate, policy);
    const target = priceShouldBe(landed, vendorSuggested, policy, negotiated);
    supplied.add(`${cm.autotaskCompanyId}|${offering.id}`);
    if (landed != null) landedBy.set(`${cm.autotaskCompanyId}|${offering.id}|${l0.cadence}`, { landed, basis });

    // Every contract line of this company — standalone or inside a bundle — that is this product.
    const cands = (candsByCompany.get(cm.autotaskCompanyId!) ?? []).filter((x) => x.o.offeringId === offering.id);
    if (!cands.length) {
      const exposure = landed != null && qty ? landed * qty : costTotal;
      const elsewhere = (outOfPeriod.get(cm.autotaskCompanyId!) ?? []).filter((x) => x.offeringId === offering.id).map((x) => `${x.contract.contractName} (${x.contract.contractType != null && x.contract.contractType !== RECURRING_SERVICE_CONTRACT ? 'not a Recurring Service contract' : `${day(x.contract.startDate) ?? '?'} – ${day(x.contract.endDate) ?? '?'}`})`);
      // A line on a service with a similar name that isn't linked to a product: probably this one, not yet linked.
      const maybe = [...new Set((unlinked.get(cm.autotaskCompanyId!) ?? []).filter((x) => similarity(services.get(x.serviceID)?.name ?? '', offering.name) >= 0.34)
        .map((x) => `"${services.get(x.serviceID)?.name ?? x.serviceID}" on ${x.contract.contractName}`))];
      push({ ...base, ...empty, exceptionKey: keyOf(null), severity: maybe.length ? 'review' : company && !company.isActive ? 'high' : 'critical', exceptions: ['not_billed', ...(company && !company.isActive ? ['inactive_company'] : []), ...(maybe.length ? ['unlinked_service'] : [])],
        reason: `${company && !company.isActive ? 'the Autotask company is INACTIVE and ' : ''}no contract of ${company?.companyName ?? 'the customer'} in effect for ${period} bills ${offering.name} — the vendor charge is not billed back${elsewhere.length ? `; a contract NOT in effect for this period has it: ${[...new Set(elsewhere)].join('; ')}` : ''}${maybe.length ? `; BUT ${maybe.join('; ')} ${maybe.length > 1 ? 'are' : 'is'} not linked to a product — probably this one. Link it (resolve_mapping kind=catalog) and re-run before acting` : ''}`,
        proposedAction: maybe.length ? 'link the service, then re-run' : 'add it to the customer’s contract (or confirm it is intentionally absorbed)', confidence: maybe.length ? 'unverified' : 'verified',
        costShouldBe: r4(landed), priceShouldBe: r4(target.price), priceRule: target.rule, landedCost: r4(landed), monthlyExposure: r2(monthly(exposure, basis)), annualExposure: r2(monthly(exposure, basis)! * 12) });
      continue;
    }
    // Primary: same term first, then a standalone line before a bundle (extra seats are standalone), then the most units.
    const ranked = cands.map((x) => ({ ...x, term: cadenceMatches(l0.cadence as Cadence, (x.o.cadence || '') as Cadence | '') }))
      .sort((a, b) => Number(b.term === 'same') - Number(a.term === 'same') || Number(a.kind === 'bundle') - Number(b.kind === 'bundle') || (b.u?.units ?? 0) - (a.u?.units ?? 0));
    const totalContractQty = ranked.reduce((s, x) => s + (x.u?.units ?? 0), 0);
    const anyUnitsKnown = ranked.some((x) => x.u != null);
    ranked.forEach((x, idx) => {
      const svc = services.get(x.serviceID) ?? null;
      const contract = contracts.get(x.contractID)!;
      const inBundle = x.kind === 'bundle';
      const cBasis = inBundle ? periodBasis(x.bundle!.periodType) : periodBasis(svc?.periodType);
      const unitsKnown = x.u != null;
      // A component inside a bundle has no price of its own — the bundle is priced as a whole (its own row).
      const curPriceNative = inBundle ? null : x.u && x.u.units > 0 && x.u.price != null ? x.u.price / x.u.units : x.cs!.unitPrice;
      const curCostNative = inBundle ? null : x.cs!.unitCost ?? (x.u && x.u.units > 0 && x.u.cost != null ? x.u.cost / x.u.units : null);
      const curPrice = toBasis(curPriceNative, cBasis, basis), curCost = toBasis(curCostNative, cBasis, basis);
      const b = inBundle ? billedBundle.get(x.lineId) ?? null : billed.get(x.lineId) ?? null;
      const billedRate = b && !inBundle ? toBasis(b.rate, cBasis, basis) : null;
      const exc: string[] = []; let sev: Severity = 'ok'; const why: string[] = []; let action = 'none';
      const raise = (s: Severity, t: string, w: string, a?: string) => { exc.push(t); why.push(w); if (RANK[s] > RANK[sev]) sev = s; if (a && (action === 'none' || RANK[s] >= RANK[sev])) action = a; };
      const primary = idx === 0;
      const qtyHere = primary ? qty : 0; // the vendor quantity is compared once, on the primary line
      let exposure = 0;
      if (company && !company.isActive) raise('high', 'inactive_company', 'the Autotask company is inactive but still billed by the vendor');
      if (!primary) raise('review', 'billed_on_multiple_lines', `${offering.name} is also billed on ${ranked[0]!.kind === 'bundle' ? `bundle line #${ranked[0]!.lineId}` : `contract service #${ranked[0]!.lineId}`} — check this is not a duplicate (fine if these are intentional extra seats)`, 'review duplicate');
      const effPrice = billedRate ?? curPrice;
      if (!inBundle && landed != null && effPrice != null && effPrice < landed - 1e-6 && qtyHere) {
        exposure += (landed - effPrice) * qtyHere;
        raise('critical', 'below_cost', `${b?.posted ? 'BILLED' : 'contract'} price ${r4(effPrice)} is below the landed cost ${r4(landed)}${b?.posted ? ` (posted on invoice ${b.invoiceID})` : ' (not yet confirmed by a posted invoice)'}`, 'raise price');
      }
      if (primary && anyUnitsKnown && totalContractQty < qty - 1e-6) {
        exposure += (qty - totalContractQty) * (target.price ?? landed ?? 0);
        raise('high', 'qty_short', `the vendor bills ${qty} but the contract line(s) bill ${totalContractQty} — ${r4(qty - totalContractQty)} unit(s) not billed back`, 'increase quantity');
      }
      if (primary && anyUnitsKnown && totalContractQty > qty + 1e-6) raise('review', 'qty_over', `the contract line(s) bill ${totalContractQty} but the vendor only charges ${qty} — cancelled seats still billed, or a seat bought elsewhere`, 'reduce quantity');
      if (x.term === 'different') raise('high', 'term_mismatch', `the vendor sells this as ${l0.cadence} but the contract ${inBundle ? `bundle ${x.bundle!.name} holds` : 'service is'} ${x.o.cadence || 'a different term'}`, 'move to the matching term service');
      if (!inBundle && landed != null && curCost != null && curCost < landed - 0.005) raise('high', 'cost_stale', `the contract cost ${r4(curCost)} is below the vendor's ${r4(landed)} — cost increase not reviewed`, 'update cost');
      if (!inBundle && target.price != null && effPrice != null && effPrice < target.price - 0.005 && !negotiated && !exc.includes('below_cost')) raise('review', 'below_target', `price ${r4(effPrice)} is below the target ${r4(target.price)} (${target.rule})`, 'review price');
      if (!inBundle && negotiated && effPrice != null && target.price != null && Math.abs(effPrice - target.price) > 0.005) raise('review', 'negotiated', `negotiated price ${negotiated.agreedUnitPrice} (${negotiated.reason}) — billed ${r4(effPrice)}`);
      const marginPct = effPrice && landed != null ? (effPrice - landed) / effPrice : null;
      if (policy.marginFloor && marginPct != null && marginPct < policy.marginFloor && !exc.includes('below_cost')) raise('review', 'margin_below_policy', `margin ${Math.round(marginPct * 100)}% is below the ${Math.round(policy.marginFloor * 100)}% floor`, 'review price');
      if (inBundle) why.push(`inside bundle ${x.bundle!.name} (bundle line #${x.lineId}) — priced as a whole on the bundle's own row`);
      if (x.noPeriod) why.push('the line has no billing period for this month — it bills nothing (ended or not started)');
      if (!b) why.push('no billing item for this period yet — actual billing unverified');
      const conf: ReconRow['confidence'] = x.o.method === 'name' ? 'inferred' : !unitsKnown || !b?.posted ? 'unverified' : 'verified';
      push({
        ...base, exceptionKey: keyOf(inBundle ? `b${x.lineId}` : String(x.lineId)), severity: sev, exceptions: exc, reason: why.join('; ') || 'matches', proposedAction: action, confidence: conf,
        lineKind: x.kind, contractServiceBundleId: inBundle ? x.lineId : null, serviceBundleId: inBundle ? x.bundle!.id : null, bundleName: inBundle ? x.bundle!.name : null, primary, contractQuantityTotal: anyUnitsKnown ? r4(totalContractQty) : null,
        serviceBasis: cBasis, autotaskContract: contract.contractName, contractId: contract.id, contractServiceId: inBundle ? null : x.lineId, serviceId: x.serviceID, serviceName: inBundle ? `${x.bundle!.name} › ${svc?.name ?? x.serviceID}` : svc?.name ?? null, contractCadence: x.o.cadence || null,
        contractQuantity: x.u?.units ?? null, billedQuantity: b?.quantity ?? null, billedRate: r4(billedRate), billedInvoiceId: b?.invoiceID ?? null, billingPosted: b ? b.posted : null,
        catalogCost: inBundle ? null : r4(toBasis(svc?.unitCost ?? null, cBasis, basis)), catalogPrice: inBundle ? null : r4(toBasis(svc?.unitPrice ?? null, cBasis, basis)),
        currentCost: r4(curCost), currentPrice: r4(curPrice), costShouldBe: r4(landed), priceShouldBe: r4(target.price), priceRule: inBundle ? `${target.rule} — standalone, for seats beyond the bundle` : target.rule, landedCost: r4(landed),
        differenceOnCost: landed != null && curCost != null ? r4(landed - curCost) : null, differenceOnPrice: !inBundle && target.price != null && curPrice != null ? r4(target.price - curPrice) : null,
        monthlyExposure: exposure ? r2(monthly(exposure, basis)) : 0, annualExposure: exposure ? r2(monthly(exposure, basis)! * 12) : 0,
        grossMarginMonthly: effPrice != null && landed != null && qtyHere ? r2(monthly((effPrice - landed) * qtyHere, basis)) : null, grossMarginPct: marginPct != null ? r4(marginPct) : null,
        matchMethod: x.o.method, otherContractServices: ranked.filter((y) => y !== x).map((y) => y.lineId),
      });
    });
  }

  // Bundle price vs the landed cost of its components (for bundles holding something this vendor supplies).
  const mappedCompanies = new Set(i.customerMappings.filter((m) => m.status === 'mapped' && m.autotaskCompanyId != null).map((m) => m.autotaskCompanyId!));
  const floorPolicy = policyFor(i.policies, -1, '');
  const seenBundleLine = new Set<number>();
  for (const [companyId, cands] of candsByCompany) {
    if (!mappedCompanies.has(companyId)) continue;
    const company = companies.get(companyId) ?? null;
    for (const x of cands) {
      if (x.kind !== 'bundle' || seenBundleLine.has(x.lineId)) continue;
      seenBundleLine.add(x.lineId);
      const bdl = x.bundle!, cb = x.cb!, contract = contracts.get(x.contractID)!;
      const comps = bdl.serviceIds.map((sid) => ({ sid, svc: services.get(sid) ?? null, o: offeringOfService(sid) }));
      if (!comps.some((c) => c.o && vendorOfferings.has(c.o.offeringId))) continue;
      const bBasis = periodBasis(bdl.periodType);
      const parts: string[] = []; let cost = 0; let unknown = 0; let vendorParts = 0;
      for (const c of comps) {
        const viaVendor = c.o ? (landedBy.get(`${companyId}|${c.o.offeringId}|${c.o.cadence}`) ?? [...landedBy.entries()].find(([k]) => k.startsWith(`${companyId}|${c.o!.offeringId}|`))?.[1]) : undefined;
        if (viaVendor) { const v = toBasis(viaVendor.landed, viaVendor.basis, bBasis)!; cost += v; vendorParts++; parts.push(`${c.svc?.name ?? c.sid} ${r4(v)} (${i.vendor})`); continue; }
        if (c.svc?.unitCost != null) { const v = toBasis(c.svc.unitCost, periodBasis(c.svc.periodType), bBasis)!; cost += v; parts.push(`${c.svc.name} ${r4(v)} (catalog cost)`); continue; }
        unknown++; parts.push(`${c.svc?.name ?? `service ${c.sid}`} (cost unknown)`);
      }
      const u = bundleUnits.get(cb.id) ?? null;
      const b = billedBundle.get(cb.id) ?? null;
      const curPrice = u && u.units > 0 && u.price != null ? u.price / u.units : cb.adjustedPrice ?? cb.unitPrice;
      const curCost = u && u.units > 0 && u.cost != null ? u.cost / u.units : bdl.unitCost;
      const effPrice = b?.rate ?? curPrice;
      const exc: string[] = []; let sev: Severity = 'ok'; const why: string[] = [`components: ${parts.join(' + ')}`]; let action = 'none';
      const raise = (s: Severity, t: string, w: string, a?: string) => { exc.push(t); why.unshift(w); if (RANK[s] > RANK[sev]) { sev = s; if (a) action = a; } };
      let exposure = 0;
      const marginPct = effPrice ? (effPrice - cost) / effPrice : null;
      if (effPrice != null && effPrice < cost - 1e-6) { exposure = (cost - effPrice) * (u?.units ?? 0); raise('critical', 'below_cost', `bundle ${b?.posted ? 'BILLED' : 'contract'} price ${r4(effPrice)} is below the landed cost of its components ${r4(cost)}`, 'raise bundle price'); }
      else if (floorPolicy.marginFloor && marginPct != null && marginPct < floorPolicy.marginFloor) raise('review', 'margin_below_policy', `bundle margin ${Math.round(marginPct * 100)}% is below the ${Math.round(floorPolicy.marginFloor * 100)}% floor`, 'review bundle price');
      if (curCost != null && curCost < cost - 0.005) raise('high', 'cost_stale', `the bundle cost ${r4(curCost)} is below its components' ${r4(cost)} — update the component services' costs (catalog plan)`, 'update component costs');
      if (company && !company.isActive) raise('high', 'inactive_company', 'the Autotask company is inactive');
      const priceTarget = exc.includes('below_cost') || exc.includes('margin_below_policy') ? (floorPolicy.marginFloor ? cost / (1 - floorPolicy.marginFloor) : cost) : effPrice;
      push({
        ...noLine, lineKind: 'bundle', contractServiceBundleId: cb.id, serviceBundleId: bdl.id, bundleName: bdl.name, primary: true, contractQuantityTotal: u?.units ?? null,
        vendor: i.vendor, serviceSku: `bundle:${bdl.id}`, commitmentTerm: bBasis === 'year' ? 'Bundle — billed yearly' : 'Bundle — billed monthly', unit: 'Bundle', quantity: u?.units ?? null,
        autotaskCompanyId: companyId, companyActive: company ? company.isActive : null, customerName: company?.companyName ?? null,
        offeringId: null, offering: `Bundle | ${bdl.name}`, vendorCustomerId: null, vendorCustomerName: null, skus: [], subscriptionIds: [], vendorDescription: '', cadence: bBasis === 'year' ? 'annual' : 'monthly', basis: bBasis,
        vendorUnitCost: null, vendorSuggestedPrice: null, sourceInvoice: source, period,
        exceptionKey: `${i.vendor}|${companyId}|bundle:${cb.id}`, severity: sev, exceptions: exc, reason: why.join('; '), proposedAction: action, confidence: unknown || vendorParts < comps.filter((c) => c.o && vendorOfferings.has(c.o.offeringId)).length ? 'unverified' : b?.posted ? 'verified' : 'unverified',
        serviceBasis: bBasis, autotaskContract: contract.contractName, contractId: contract.id, contractServiceId: null, serviceId: null, serviceName: bdl.name, contractCadence: null,
        contractQuantity: u?.units ?? null, billedQuantity: b?.quantity ?? null, billedRate: r4(b?.rate ?? null), billedInvoiceId: b?.invoiceID ?? null, billingPosted: b ? b.posted : null,
        catalogCost: r4(bdl.unitCost), catalogPrice: r4(bdl.unitPrice), currentCost: r4(curCost), currentPrice: r4(curPrice), costShouldBe: r4(cost), priceShouldBe: r4(priceTarget),
        priceRule: `bundle: at least the landed cost of its components${floorPolicy.marginFloor ? ` at a ${Math.round(floorPolicy.marginFloor * 100)}% margin` : ''}`, landedCost: r4(cost),
        differenceOnCost: curCost != null ? r4(cost - curCost) : null, differenceOnPrice: priceTarget != null && curPrice != null ? r4(priceTarget - curPrice) : null,
        monthlyExposure: r2(monthly(exposure, bBasis)) ?? 0, annualExposure: r2(monthly(exposure, bBasis)! * 12) ?? 0,
        grossMarginMonthly: effPrice != null && u ? r2(monthly((effPrice - cost) * u.units, bBasis)) : null, grossMarginPct: marginPct != null ? r4(marginPct) : null,
        matchMethod: null, otherContractServices: [],
      });
    }
  }

  // The other direction: the customer is billed for something this vendor supplies but no longer charges us for.
  for (const [companyId, cands] of candsByCompany) {
    if (!mappedCompanies.has(companyId)) continue;
    const company = companies.get(companyId) ?? null;
    for (const x of cands) {
      if (!vendorOfferings.has(x.o.offeringId) || supplied.has(`${companyId}|${x.o.offeringId}`)) continue;
      if (!x.u || x.u.units <= 0) continue; // nothing billed this period
      if ((x.o.cadence === 'AA' || x.o.cadence === 'annual') && recentAnnual.has(`${companyId}|${x.o.offeringId}`)) continue; // billed yearly by the vendor
      const off = offerings.get(x.o.offeringId) ?? null;
      const svc = services.get(x.serviceID) ?? null;
      const contract = contracts.get(x.contractID)!;
      const inBundle = x.kind === 'bundle';
      const cBasis = inBundle ? periodBasis(x.bundle!.periodType) : periodBasis(svc?.periodType);
      const curPrice = inBundle ? null : x.u.price != null && x.u.units > 0 ? x.u.price / x.u.units : x.cs!.unitPrice;
      const curCost = inBundle ? null : x.cs!.unitCost;
      const billedMonthly = curPrice != null ? monthly(curPrice * x.u.units, cBasis) : null;
      push({
        lineKind: x.kind, contractServiceBundleId: inBundle ? x.lineId : null, serviceBundleId: inBundle ? x.bundle!.id : null, bundleName: inBundle ? x.bundle!.name : null, primary: true, contractQuantityTotal: x.u.units,
        vendor: i.vendor, serviceSku: '(no vendor line)', commitmentTerm: termLabel(x.o.cadence, null, null), unit: null, quantity: 0,
        autotaskCompanyId: companyId, companyActive: company ? company.isActive : null, customerName: company?.companyName ?? null,
        offeringId: x.o.offeringId, offering: off ? `${off.manufacturer} | ${off.name}` : null, vendorCustomerId: null, vendorCustomerName: null, skus: [], subscriptionIds: [], vendorDescription: '',
        cadence: x.o.cadence, basis: cBasis, vendorUnitCost: null, vendorSuggestedPrice: null, sourceInvoice: source, period,
        exceptionKey: `${i.vendor}|${companyId}|${x.o.offeringId}|${x.o.cadence}|not_purchased:${inBundle ? 'b' : ''}${x.lineId}`, severity: 'high', exceptions: ['not_purchased'],
        reason: `the contract bills ${x.u.units} × ${inBundle ? `${x.bundle!.name} › ` : ''}${svc?.name ?? off?.name ?? x.serviceID}${billedMonthly != null ? ` (${r2(billedMonthly)}/month)` : ''} but ${source} has no charge for it for this customer — a cancelled subscription still billed to the customer, or bought from another vendor (then mark it accepted)`,
        proposedAction: inBundle ? 'review the bundle (its other parts may still be needed)' : 'end the line (units to 0) if the subscription was cancelled', confidence: x.o.method === 'name' ? 'inferred' : 'unverified',
        serviceBasis: cBasis, autotaskContract: contract.contractName, contractId: contract.id, contractServiceId: inBundle ? null : x.lineId, serviceId: x.serviceID, serviceName: inBundle ? `${x.bundle!.name} › ${svc?.name ?? x.serviceID}` : svc?.name ?? null, contractCadence: x.o.cadence || null,
        contractQuantity: x.u.units, billedQuantity: null, billedRate: null, billedInvoiceId: null, billingPosted: null,
        catalogCost: null, catalogPrice: null, currentCost: r4(curCost), currentPrice: r4(curPrice), costShouldBe: null, priceShouldBe: null, priceRule: null, landedCost: null,
        differenceOnCost: null, differenceOnPrice: null, monthlyExposure: 0, annualExposure: 0, grossMarginMonthly: null, grossMarginPct: null,
        matchMethod: x.o.method, otherContractServices: [],
      });
    }
  }

  // A back-bill charge covering this month already bills what the contract line missed.
  const month = periodStart.slice(0, 7);
  const companyOfContract = new Map(i.contracts.map((c) => [c.id, c.companyID]));
  const backbills = (i.charges ?? []).map((ch) => ({ ch, w: backbillWindow(ch.name), product: ch.name.split(/\s+[—-]\s+back-bill/i)[0]!.trim() })).filter((x) => x.w && x.w[0] <= month && x.w[1] >= month);
  for (const r of rows) {
    if (!r.exceptions.includes('not_billed') && !r.exceptions.includes('qty_short')) continue;
    const off = r.offeringId != null ? offerings.get(r.offeringId) : undefined; if (!off) continue;
    const hit = backbills.find(({ ch, product }) => companyOfContract.get(ch.contractID) === r.autotaskCompanyId
      && ((r.contractServiceId != null && ch.contractServiceID === r.contractServiceId) || productKey(product) === productKey(off.name)
        || [...services.values()].some((sv) => sv.name === product && offeringOfService(sv.id)?.offeringId === off.id)));
    if (!hit) continue;
    const { ch } = hit;
    r.severity = 'info'; r.exceptions.push('backbilled'); r.confidence = 'verified';
    r.reason += `; covered for ${month} by back-bill charge ${ch.id} "${ch.name}" (${ch.unitQuantity ?? '?'} × ${ch.unitPrice ?? '?'}, ${ch.isBilled ? 'invoiced' : 'not invoiced yet — bills at the next Approve & Post'})`;
    r.proposedAction = ch.isBilled ? 'none — back-billed' : 'none — back-billed; make sure the charge is posted';
    r.monthlyExposure = 0; r.annualExposure = 0;
  }

  rows.sort((a, b) => RANK[b.severity] - RANK[a.severity] || (b.monthlyExposure ?? 0) - (a.monthlyExposure ?? 0) || String(a.customerName).localeCompare(String(b.customerName)));
  rows.forEach((r, n) => { r.rowNo = n + 1; });
  const count = (s: Severity) => rows.filter((r) => r.severity === s).length;
  const exposure = (f: (r: ReconRow) => boolean) => r2(rows.filter(f).reduce((s, r) => s + (r.monthlyExposure ?? 0), 0));
  return {
    rows,
    summary: {
      rows: rows.length, critical: count('critical'), high: count('high'), review: count('review'), info: count('info'), ok: count('ok'),
      monthlyExposure: exposure(() => true), monthlyExposureCritical: exposure((r) => r.severity === 'critical'),
      belowCost: rows.filter((r) => r.exceptions.includes('below_cost')).length, belowCostConfirmed: rows.filter((r) => r.exceptions.includes('below_cost') && r.billingPosted).length,
      notBilled: rows.filter((r) => r.exceptions.includes('not_billed')).length, qtyShort: rows.filter((r) => r.exceptions.includes('qty_short')).length,
      qtyOver: rows.filter((r) => r.exceptions.includes('qty_over')).length, notPurchased: rows.filter((r) => r.exceptions.includes('not_purchased')).length,
      bundles: rows.filter((r) => r.lineKind === 'bundle' && r.offering?.startsWith('Bundle |')).length,
      vendorCost: r2(i.lines.reduce((s, l) => s + (l.costTotal ?? 0), 0)), feeRate: r4(feeRate),
    },
  };
}

function termLabel(c: string, commit: string | null, term: string | null): string {
  const t: Record<string, string> = { MM: 'MM — monthly commitment, billed monthly', AM: 'AM — annual commitment, billed monthly', AA: 'AA — annual commitment, billed annually', monthly: 'Monthly (no commitment)', annual: 'Annual', one_time: 'One-time' };
  return t[c] ?? ([commit, term].filter(Boolean).join(' / ') || c);
}
