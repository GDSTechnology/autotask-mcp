// Vendor ↔ customer-contract reconciliation (requirements §4–§6). Pure: given
// one vendor invoice's lines, the identity mappings and the customer's Autotask
// commercial data, produce one report row per (customer, product, term) with
// the comparison and its exceptions.
//
// Matching is on the PRODUCT: a vendor line's offering ↔ every ACTIVE contract
// of the mapped company ↔ the contract services whose Autotask service is that
// offering. Contracts never name the vendor. Nothing is claimed as a confirmed
// loss unless a POSTED billing item for the period shows the billed rate; an
// unknown quantity or ambiguous match is "unverified", never zero.

import { cadenceMatches, productKey, serviceCadence } from './offerings.js';
import { landedCost, policyFor, priceShouldBe, type CustomerPriceException, type PricingPolicy } from './policy.js';
import type { VendorLine, Cadence } from './types.js';
import type { CatalogLink, CustomerMapping, Offering, OfferingMapping } from './store.js';

export type Severity = 'critical' | 'high' | 'review' | 'info' | 'ok';
const RANK: Record<Severity, number> = { critical: 4, high: 3, review: 2, info: 1, ok: 0 };

export interface ContractRow { id: number; companyID: number; contractName: string; status: number; startDate: string | null; endDate: string | null }
export interface ContractServiceRow { id: number; contractID: number; serviceID: number; unitCost: number | null; unitPrice: number | null; invoiceDescription?: string | null }
export interface ServiceRow { id: number; name: string; periodType: number | null; unitCost: number | null; unitPrice: number | null }
export interface UnitsRow { contractServiceID: number; units: number; price: number | null; cost: number | null; startDate: string; endDate: string }
export interface BilledRow { contractServiceID: number; quantity: number; rate: number; extendedPrice: number; ourCost: number | null; invoiceID: number | null; itemDate: string; posted: boolean }

export interface ReconInput {
  vendor: string;
  invoice: { documentId: number; invoiceNumber: string | null; invoiceDate: string | null; periodStart: string; periodEnd: string };
  lines: VendorLine[];
  customerMappings: CustomerMapping[];
  offeringMappings: OfferingMapping[];
  offerings: Offering[];
  links: CatalogLink[];
  services: ServiceRow[];
  companies: Array<{ id: number; companyName: string; isActive: boolean }>;
  contracts: ContractRow[];
  contractServices: ContractServiceRow[];
  /** The ContractServiceUnits period covering the invoice period start, per contract service. */
  units: UnitsRow[];
  /** Recurring-service billing items (type 6) in the invoice period, per contract service. */
  billed: BilledRow[];
  policies: PricingPolicy[];
  customerExceptions: CustomerPriceException[];
}

export interface ReconRow {
  rowNo: number; exceptionKey: string; severity: Severity; exceptions: string[]; reason: string; proposedAction: string; confidence: 'verified' | 'unverified' | 'inferred';
  // required report columns (§10)
  customerName: string | null; autotaskContract: string | null; vendor: string; serviceSku: string; commitmentTerm: string; unit: string | null; quantity: number | null;
  costShouldBe: number | null; priceShouldBe: number | null; currentCost: number | null; currentPrice: number | null; differenceOnCost: number | null; differenceOnPrice: number | null;
  // recommended extras
  autotaskCompanyId: number | null; companyActive: boolean | null; contractId: number | null; contractServiceId: number | null; serviceId: number | null; serviceName: string | null;
  offeringId: number | null; offering: string | null; vendorCustomerId: string | null; vendorCustomerName: string | null; skus: string[]; subscriptionIds: string[]; vendorDescription: string;
  cadence: string; contractCadence: string | null;
  /** Report amounts are per this basis (the vendor term); the contract service itself bills per serviceBasis. */
  basis: 'month' | 'year'; serviceBasis: 'month' | 'year' | null;
  contractQuantity: number | null; billedQuantity: number | null; billedRate: number | null; billedInvoiceId: number | null; billingPosted: boolean | null;
  catalogCost: number | null; catalogPrice: number | null; vendorUnitCost: number | null; vendorSuggestedPrice: number | null; landedCost: number | null; priceRule: string | null;
  monthlyExposure: number | null; annualExposure: number | null; grossMarginMonthly: number | null; grossMarginPct: number | null;
  matchMethod: 'link' | 'name' | null; otherContractServices: number[]; sourceInvoice: string | null; period: string;
}

const r2 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);
const r4 = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10000) / 10000);
const basisOf = (c: string): 'month' | 'year' => (c === 'AA' || c === 'annual' ? 'year' : 'month');
/** Convert a per-unit amount from one billing basis to another. */
const toBasis = (v: number | null, from: 'month' | 'year', to: 'month' | 'year') => (v == null ? null : from === to ? v : from === 'year' ? v / 12 : v * 12);
const monthly = (v: number | null, b: 'month' | 'year') => (v == null ? null : b === 'year' ? v / 12 : v);

export function reconcile(i: ReconInput): { rows: ReconRow[]; summary: Record<string, unknown> } {
  const cust = new Map(i.customerMappings.map((m) => [m.vendorCustomerId, m]));
  const offMap = new Map(i.offeringMappings.map((m) => [m.sku, m]));
  const offerings = new Map(i.offerings.map((o) => [o.id, o]));
  const links = new Map(i.links.filter((l) => l.autotaskEntity === 'Services').map((l) => [l.autotaskId, l]));
  const services = new Map(i.services.map((s) => [s.id, s]));
  const companies = new Map(i.companies.map((c) => [c.id, c]));
  const contracts = new Map(i.contracts.map((c) => [c.id, c]));
  const units = new Map(i.units.map((u) => [u.contractServiceID, u]));
  const billed = new Map<number, BilledRow>();
  for (const b of i.billed) { const e = billed.get(b.contractServiceID); if (!e || (b.posted && !e.posted)) billed.set(b.contractServiceID, b); }
  // Vendor fees as a share of everything else on the invoice (for fee policy "allocate").
  const feeTotal = i.lines.filter((l) => l.chargeClass === 'vendor_fee').reduce((s, l) => s + (l.costTotal ?? 0), 0);
  const otherTotal = i.lines.filter((l) => l.chargeClass !== 'vendor_fee').reduce((s, l) => s + (l.costTotal ?? 0), 0);
  const feeRate = otherTotal > 0 ? feeTotal / otherTotal : 0;

  // Contract services per company → per offering.
  const csByCompany = new Map<number, ContractServiceRow[]>();
  for (const cs of i.contractServices) { const c = contracts.get(cs.contractID); if (!c || c.status !== 1) continue; (csByCompany.get(c.companyID) ?? csByCompany.set(c.companyID, []).get(c.companyID)!).push(cs); }
  const offeringOfService = (sid: number): { offeringId: number; cadence: string; method: 'link' | 'name' } | null => {
    const l = links.get(sid);
    if (l) return { offeringId: l.offeringId, cadence: l.cadence || serviceCadence(services.get(sid)?.name ?? '', services.get(sid)?.periodType ?? null), method: 'link' };
    const s = services.get(sid); if (!s) return null;
    const o = i.offerings.find((x) => productKey(x.name) === productKey(s.name));
    return o ? { offeringId: o.id, cadence: serviceCadence(s.name, s.periodType), method: 'name' } : null;
  };

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
  const period = `${i.invoice.periodStart} – ${i.invoice.periodEnd}`;
  const source = i.invoice.invoiceNumber ? `${i.vendor} ${i.invoice.invoiceNumber}` : `${i.vendor} document ${i.invoice.documentId}`;

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
    const empty = { serviceBasis: null, autotaskContract: null, contractId: null, contractServiceId: null, serviceId: null, serviceName: null, contractCadence: null, contractQuantity: null, billedQuantity: null, billedRate: null, billedInvoiceId: null, billingPosted: null, catalogCost: null, catalogPrice: null, currentCost: null, currentPrice: null, differenceOnCost: null, differenceOnPrice: null, landedCost: null, priceShouldBe: null, costShouldBe: null, priceRule: null, monthlyExposure: null, annualExposure: null, grossMarginMonthly: null, grossMarginPct: null, matchMethod: null, otherContractServices: [] };
    const keyOf = (csId: number | null) => `${i.vendor}|${cm?.autotaskCompanyId ?? l0.vendorCustomerId}|${offering?.id ?? `sku:${l0.sku}`}|${l0.cadence}|${g.kind === 'recurring' ? csId ?? 'none' : l0.chargeClass}`;

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

    // Every contract service of this company whose service is this product.
    const cands = (csByCompany.get(cm.autotaskCompanyId!) ?? []).map((cs) => ({ cs, o: offeringOfService(cs.serviceID) })).filter((x) => x.o?.offeringId === offering.id);
    if (!cands.length) {
      const exposure = landed != null && qty ? landed * qty : costTotal;
      push({ ...base, ...empty, exceptionKey: keyOf(null), severity: company && !company.isActive ? 'high' : 'critical', exceptions: ['not_billed', ...(company && !company.isActive ? ['inactive_company'] : [])],
        reason: `${company && !company.isActive ? 'the Autotask company is INACTIVE and ' : ''}no active contract of ${company?.companyName ?? 'the customer'} bills ${offering.name} — the vendor charge is not billed back`,
        proposedAction: 'add a contract service (or confirm it is intentionally absorbed)', confidence: 'verified',
        costShouldBe: r4(landed), priceShouldBe: r4(target.price), priceRule: target.rule, landedCost: r4(landed), monthlyExposure: r2(monthly(exposure, basis)), annualExposure: r2(monthly(exposure, basis)! * 12) });
      continue;
    }
    // Primary: same term first, then the most units.
    const ranked = cands.map((x) => ({ ...x, u: units.get(x.cs.id) ?? null, term: cadenceMatches(l0.cadence as Cadence, (x.o!.cadence || '') as Cadence | '') })).sort((a, b) => Number(b.term === 'same') - Number(a.term === 'same') || (b.u?.units ?? 0) - (a.u?.units ?? 0));
    const totalContractQty = ranked.reduce((s, x) => s + (x.u?.units ?? 0), 0);
    ranked.forEach((x, idx) => {
      const svc = services.get(x.cs.serviceID) ?? null;
      const contract = contracts.get(x.cs.contractID)!;
      const cBasis: 'month' | 'year' = svc?.periodType === 5 ? 'year' : 'month';
      const unitsKnown = x.u != null;
      const curPriceNative = x.u && x.u.units > 0 && x.u.price != null ? x.u.price / x.u.units : x.cs.unitPrice;
      const curCostNative = x.cs.unitCost ?? (x.u && x.u.units > 0 && x.u.cost != null ? x.u.cost / x.u.units : null);
      const curPrice = toBasis(curPriceNative, cBasis, basis), curCost = toBasis(curCostNative, cBasis, basis);
      const b = billed.get(x.cs.id) ?? null;
      const billedRate = b ? toBasis(b.rate, cBasis, basis) : null;
      const exc: string[] = []; let sev: Severity = 'ok'; const why: string[] = []; let action = 'none';
      const raise = (s: Severity, t: string, w: string, a?: string) => { exc.push(t); why.push(w); if (RANK[s] > RANK[sev]) sev = s; if (a && (action === 'none' || RANK[s] >= RANK[sev])) action = a; };
      const qtyHere = idx === 0 ? qty : 0; // the vendor quantity is compared once, on the primary line
      let exposure = 0;
      if (company && !company.isActive) raise('high', 'inactive_company', 'the Autotask company is inactive but still billed by the vendor');
      if (idx > 0) raise('review', 'billed_on_multiple_lines', `${offering.name} is also billed on contract service #${ranked[0]!.cs.id} — check this is not a duplicate`, 'review duplicate');
      const effPrice = billedRate ?? curPrice;
      if (landed != null && effPrice != null && effPrice < landed - 1e-6 && qtyHere) {
        exposure += (landed - effPrice) * qtyHere;
        raise('critical', 'below_cost', `${b?.posted ? 'BILLED' : 'contract'} price ${r4(effPrice)} is below the landed cost ${r4(landed)}${b?.posted ? ` (posted on invoice ${b.invoiceID})` : ' (not yet confirmed by a posted invoice)'}`, 'raise price');
      }
      if (idx === 0 && unitsKnown && totalContractQty < qty - 1e-6) {
        exposure += (qty - totalContractQty) * (target.price ?? landed ?? 0);
        raise('high', 'qty_short', `the vendor bills ${qty} but the contract(s) bill ${totalContractQty} — ${r4(qty - totalContractQty)} unit(s) not billed back`, 'increase quantity');
      }
      if (idx === 0 && unitsKnown && totalContractQty > qty + 1e-6) raise('review', 'qty_over', `the contract(s) bill ${totalContractQty} but the vendor only charges ${qty} — stale quantity or a seat billed elsewhere`, 'review quantity');
      if (x.term === 'different') raise('high', 'term_mismatch', `the vendor sells this as ${l0.cadence} but the contract service is ${x.o!.cadence}`, 'move to the matching term service');
      if (landed != null && curCost != null && curCost < landed - 0.005) raise('high', 'cost_stale', `the contract cost ${r4(curCost)} is below the vendor's ${r4(landed)} — cost increase not reviewed`, 'update cost');
      if (target.price != null && effPrice != null && effPrice < target.price - 0.005 && !negotiated && !exc.includes('below_cost')) raise('review', 'below_target', `price ${r4(effPrice)} is below the target ${r4(target.price)} (${target.rule})`, 'review price');
      if (negotiated && effPrice != null && target.price != null && Math.abs(effPrice - target.price) > 0.005) raise('review', 'negotiated', `negotiated price ${negotiated.agreedUnitPrice} (${negotiated.reason}) — billed ${r4(effPrice)}`);
      const marginPct = effPrice && landed != null ? (effPrice - landed) / effPrice : null;
      if (policy.marginFloor && marginPct != null && marginPct < policy.marginFloor && !exc.includes('below_cost')) raise('review', 'margin_below_policy', `margin ${Math.round(marginPct * 100)}% is below the ${Math.round(policy.marginFloor * 100)}% floor`, 'review price');
      if (!b) why.push('no billing item for this period yet — actual billing unverified');
      const conf: ReconRow['confidence'] = x.o!.method === 'name' ? 'inferred' : !unitsKnown || !b?.posted ? 'unverified' : 'verified';
      push({
        ...base, exceptionKey: keyOf(x.cs.id), severity: sev, exceptions: exc, reason: why.join('; ') || 'matches', proposedAction: action, confidence: conf,
        serviceBasis: cBasis, autotaskContract: contract.contractName, contractId: contract.id, contractServiceId: x.cs.id, serviceId: x.cs.serviceID, serviceName: svc?.name ?? null, contractCadence: x.o!.cadence || null,
        contractQuantity: x.u?.units ?? null, billedQuantity: b?.quantity ?? null, billedRate: r4(billedRate), billedInvoiceId: b?.invoiceID ?? null, billingPosted: b ? b.posted : null,
        catalogCost: r4(toBasis(svc?.unitCost ?? null, cBasis, basis)), catalogPrice: r4(toBasis(svc?.unitPrice ?? null, cBasis, basis)),
        currentCost: r4(curCost), currentPrice: r4(curPrice), costShouldBe: r4(landed), priceShouldBe: r4(target.price), priceRule: target.rule, landedCost: r4(landed),
        differenceOnCost: landed != null && curCost != null ? r4(landed - curCost) : null, differenceOnPrice: target.price != null && curPrice != null ? r4(target.price - curPrice) : null,
        monthlyExposure: exposure ? r2(monthly(exposure, basis)) : 0, annualExposure: exposure ? r2(monthly(exposure, basis)! * 12) : 0,
        grossMarginMonthly: effPrice != null && landed != null && qtyHere ? r2(monthly((effPrice - landed) * qtyHere, basis)) : null, grossMarginPct: marginPct != null ? r4(marginPct) : null,
        matchMethod: x.o!.method, otherContractServices: ranked.filter((y) => y !== x).map((y) => y.cs.id),
      });
    });
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
      vendorCost: r2(i.lines.reduce((s, l) => s + (l.costTotal ?? 0), 0)), feeRate: r4(feeRate),
    },
  };
}

function termLabel(c: string, commit: string | null, term: string | null): string {
  const t: Record<string, string> = { MM: 'MM — monthly commitment, billed monthly', AM: 'AM — annual commitment, billed monthly', AA: 'AA — annual commitment, billed annually', monthly: 'Monthly (no commitment)', annual: 'Annual', one_time: 'One-time' };
  return t[c] ?? ([commit, term].filter(Boolean).join(' / ') || c);
}
