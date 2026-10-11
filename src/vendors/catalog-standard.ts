// Catalog standardization plan (read-only build): one Autotask Service per
// (product, term), named to the GDS standard, priced from the vendor price
// reference. For each product we sell × each of its terms:
//   - existing services of that product + term: KEEP the one most active
//     contracts use, rename it to the standard (name / description / invoice
//     description); deactivate the others — only when no active contract uses
//     them (otherwise they are listed, never touched)
//   - none: CREATE the standard service (cost + suggested price for that term,
//     the work type of a sibling service) — blocked if a price is missing
// A service's term is fixed in Autotask (periodType can't be changed after
// creation), so a keeper must already bill on the right period.

import { productKey, serviceCadence } from './offerings.js';
import type { CatalogLink, Offering, OfferingMapping } from './store.js';
import type { VendorPrice } from './prices.js';
import type { PlanRowInput } from '../change-plans/store.js';

export type Term = 'MM' | 'AM' | 'AA' | 'monthly';

export const TERM_TEXT: Record<Term, string> = {
  MM: 'Monthly commitment, billed monthly',
  AM: 'Annual commitment, billed monthly',
  AA: 'Annual commitment, billed annually',
  monthly: 'Month to month, billed monthly',
};
const PERIOD: Record<Term, number> = { MM: 2, AM: 2, AA: 5, monthly: 2 }; // Autotask periodType 2 = Monthly, 5 = Yearly

export interface AutotaskServiceRow {
  id: number; name: string; description?: string | null; invoiceDescription?: string | null; periodType?: number | null;
  unitCost?: number | null; unitPrice?: number | null; isActive?: boolean; billingCodeID?: number | null; manufacturerServiceProvider?: string | null;
}

/** The standard: the term code in the name; the description and invoice description spell it out. */
export function standardService(o: Pick<Offering, 'manufacturer' | 'name'>, term: Term, nce: boolean): { name: string; description: string; invoiceDescription: string; manufacturerServiceProvider: string } {
  const code = term === 'monthly' ? 'Monthly' : term;
  return {
    name: `${o.name}${nce ? ' [NCE]' : ''} - ${code}`.slice(0, 150),
    description: `${o.name.toLowerCase().startsWith(o.manufacturer.replace(/\s*\(.*\)$/, '').toLowerCase()) ? '' : `${o.manufacturer} `}${o.name}${nce ? ' (New Commerce Experience)' : ''}. ${TERM_TEXT[term]}.`.slice(0, 400),
    invoiceDescription: `${o.name} — ${TERM_TEXT[term]}`.slice(0, 1000),
    manufacturerServiceProvider: o.manufacturer.replace(/\s*\(.*\)$/, '').slice(0, 100),
  };
}

export interface StandardizeInput {
  vendor: string;
  offerings: Offering[];
  offeringMappings: OfferingMapping[];
  /** SKUs with recurring lines on the vendor's invoices — "what we sell". */
  soldSkus: Map<string, { cadences: Set<string>; chargeClasses: Set<string> }>;
  links: CatalogLink[];
  services: AutotaskServiceRow[];
  /** Active contract services per Autotask service id. */
  activeUses: Map<number, number>;
  prices: VendorPrice[];
  /** Only these offerings (default: every product we sell or have in the catalog). */
  offeringIds?: number[];
}

export interface StandardizeResult { rows: PlanRowInput[]; summary: { products: number; keep: number; rename: number; reprice: number; create: number; deactivate: number; inUseDuplicates: number; blocked: number; unknownTerm: number } }

export function buildStandardizePlan(i: StandardizeInput): StandardizeResult {
  const rows: PlanRowInput[] = [];
  const sum = { products: 0, keep: 0, rename: 0, reprice: 0, create: 0, deactivate: 0, inUseDuplicates: 0, blocked: 0, unknownTerm: 0 };
  const byOffering = new Map<number, OfferingMapping[]>();
  for (const m of i.offeringMappings) if (m.status === 'mapped' && m.offeringId != null) (byOffering.get(m.offeringId) ?? byOffering.set(m.offeringId, []).get(m.offeringId)!).push(m);
  const linkOf = new Map(i.links.filter((l) => l.autotaskEntity === 'Services').map((l) => [l.autotaskId, l]));

  // Services of each offering: decided links first; an unlinked active service with the same product key joins too (its term parsed from the name).
  const servicesOf = (o: Offering) => {
    const out: Array<{ s: AutotaskServiceRow; term: string; source: 'link' | 'name' }> = [];
    for (const s of i.services) {
      const l = linkOf.get(s.id);
      if (l) { if (l.offeringId === o.id) out.push({ s, term: l.cadence || serviceCadence(s.name, s.periodType ?? null), source: 'link' }); continue; }
      if (s.isActive !== false && productKey(s.name) === productKey(o.name)) out.push({ s, term: serviceCadence(s.name, s.periodType ?? null), source: 'name' });
    }
    return out;
  };

  // The work type most of a manufacturer's linked services use (for a product with no service yet).
  const manufacturerSibling = (manufacturer: string): AutotaskServiceRow | null => {
    const ids = new Set(i.offerings.filter((x) => x.manufacturer === manufacturer).map((x) => x.id));
    const pool = i.services.filter((s) => s.billingCodeID != null && s.isActive !== false && ((linkOf.get(s.id) && ids.has(linkOf.get(s.id)!.offeringId)) || i.offerings.some((x) => ids.has(x.id) && productKey(x.name) === productKey(s.name))));
    const count = new Map<number, number>();
    for (const s of pool) count.set(s.billingCodeID!, (count.get(s.billingCodeID!) ?? 0) + 1);
    const top = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    return top ? pool.find((s) => s.billingCodeID === top[0]) ?? null : null;
  };

  const offerings = i.offerings.filter((o) => o.kind !== 'internal' && (!i.offeringIds?.length || i.offeringIds.includes(o.id)));
  for (const o of offerings) {
    const skus = (byOffering.get(o.id) ?? []).map((m) => m.sku);
    const sold = skus.some((k) => i.soldSkus.get(k)?.chargeClasses.has('recurring') || i.soldSkus.get(k)?.chargeClasses.has('proration'));
    const usageOnly = skus.length > 0 && skus.every((k) => { const c = i.soldSkus.get(k)?.chargeClasses; return !!c && ![...c].some((x) => x === 'recurring' || x === 'proration'); });
    const nfr = skus.some((k) => i.soldSkus.get(k)?.chargeClasses.has('nfr_internal'));
    const group = servicesOf(o);
    if (nfr || (!sold && !group.length) || (usageOnly && !group.length)) continue;
    sum.products++;
    const nce = skus.some((k) => /^MST-NCE-/i.test(k)) || (o.manufacturer === 'Microsoft' && group.some((g) => /\b(nce|new commerce)\b/i.test(g.s.name)));
    const terms: Term[] = nce ? ['MM', 'AM', 'AA'] : ['monthly'];
    // A month-to-month product has one term: an unstated term on a monthly-billed service is that term.
    if (!nce) for (const g of group) if (!g.term && (g.s.periodType ?? 2) === 2) g.term = 'monthly';

    for (const g of group.filter((x) => !x.term)) {
      sum.unknownTerm++;
      rows.push({ action: 'info', entity: 'Services', targetId: g.s.id, label: `${g.s.name} (#${g.s.id}): term not stated — ${o.manufacturer} | ${o.name}`, before: null, after: null, reason: `The name doesn't say which term it sells and it is used by ${i.activeUses.get(g.s.id) ?? 0} active contract line(s). Tell me MM / AM / AA (autotask_reconcile_resolve_mapping kind=catalog action=set) and rebuild the plan.`, blocked: 'term unknown' });
    }

    for (const term of terms) {
      const std = standardService(o, term, nce);
      const price = pickPrice(i.prices, skus, term);
      const members = group.filter((g) => g.term === term || (term === 'monthly' && g.term === 'MM'));
      // A keeper must already bill on the right period (periodType can't be changed in Autotask).
      const eligible = members.filter((g) => (g.s.periodType ?? PERIOD[term]) === PERIOD[term] && g.s.isActive !== false);
      const keeper = eligible.sort((a, b) => (i.activeUses.get(b.s.id) ?? 0) - (i.activeUses.get(a.s.id) ?? 0) || Number(/[-–] (MM|AM|AA|Monthly)$/.test(b.s.name)) - Number(/[-–] (MM|AM|AA|Monthly)$/.test(a.s.name)) || a.s.id - b.s.id)[0];

      if (keeper) {
        const k = keeper.s;
        const want = { name: std.name, description: std.description, invoiceDescription: std.invoiceDescription, manufacturerServiceProvider: std.manufacturerServiceProvider };
        const diff = Object.fromEntries(Object.entries(want).filter(([f, v]) => String((k as unknown as Record<string, unknown>)[f] ?? '').trim() !== v));
        if (Object.keys(diff).length) {
          sum.rename++;
          rows.push({ meta: { offeringId: o.id, term }, action: 'update', entity: 'Services', targetId: k.id, label: `Rename #${k.id} "${k.name}" → "${std.name}"`, before: Object.fromEntries(Object.keys(diff).map((f) => [f, (k as unknown as Record<string, unknown>)[f] ?? null])), after: diff, reason: `Keeper for ${o.name} ${term}: used by ${i.activeUses.get(k.id) ?? 0} active contract line(s).`, blocked: null });
        } else sum.keep++;
        if (price && (price.unitCost != null || price.suggestedPrice != null)) {
          const pa: Record<string, unknown> = {};
          if (price.unitCost != null && Math.abs((k.unitCost ?? 0) - price.unitCost) > 1e-6) pa.unitCost = price.unitCost;
          if (price.suggestedPrice != null && Math.abs((k.unitPrice ?? 0) - price.suggestedPrice) > 1e-6) pa.unitPrice = price.suggestedPrice;
          if (Object.keys(pa).length) {
            sum.reprice++;
            const loss = price.unitCost != null && price.suggestedPrice != null && price.suggestedPrice < price.unitCost;
            if (loss) sum.blocked++;
            rows.push({ blocked: loss ? `the vendor's suggested price ${price.suggestedPrice} is BELOW its cost ${price.unitCost} — set the GDS price for this term (autotask_vendor_prices action=set) and rebuild` : null, meta: { offeringId: o.id, term }, action: 'update', entity: 'Services', targetId: k.id, label: `Catalog price #${k.id} ${std.name}: cost ${k.unitCost ?? '—'} → ${pa.unitCost ?? k.unitCost}, price ${k.unitPrice ?? '—'} → ${pa.unitPrice ?? k.unitPrice} (per ${price.per})`, before: Object.fromEntries(Object.keys(pa).map((f) => [f, (k as unknown as Record<string, unknown>)[f] ?? null])), after: pa, reason: `${i.vendor} ${price.source}, ${price.effectiveDate}. Catalog reference only — customer contract prices are NOT changed by this.` });
          }
        }
      } else {
        sum.create++;
        const sibling = group.map((g) => g.s).find((s) => s.billingCodeID != null) ?? manufacturerSibling(o.manufacturer);
        const blocked = price && price.unitCost != null && price.suggestedPrice != null && price.suggestedPrice < price.unitCost ? `the vendor's suggested price ${price.suggestedPrice} is BELOW its cost ${price.unitCost} — set the GDS price (autotask_vendor_prices action=set) and rebuild` : !price || price.unitCost == null ? `no ${i.vendor} price for ${term} yet — add it (autotask_vendor_prices action=set) and rebuild` : !sibling ? 'no sibling service to copy the work type (billing code) from — create one service of this product first' : null;
        if (blocked) sum.blocked++;
        rows.push({
          meta: { offeringId: o.id, term }, action: 'create', entity: 'Services', targetId: null, label: `Create "${std.name}"${price?.unitCost != null ? ` — cost ${price.unitCost} / price ${price.suggestedPrice ?? '—'} per ${price.per}` : ''}`,
          before: null,
          after: { ...std, periodType: PERIOD[term], isActive: true, ...(price?.unitCost != null ? { unitCost: price.unitCost } : {}), unitPrice: price?.suggestedPrice ?? price?.unitCost ?? 0, ...(sibling?.billingCodeID != null ? { billingCodeID: sibling.billingCodeID } : {}) },
          reason: `${o.manufacturer} | ${o.name} has no ${term} service.${price ? ` Price: ${i.vendor} ${price.source}, ${price.effectiveDate}.` : ''}${sibling ? ` Work type copied from #${sibling.id}.` : ''}`, blocked,
        });
      }

      for (const g of members.filter((x) => x !== keeper && x.s.isActive !== false)) {
        const uses = i.activeUses.get(g.s.id) ?? 0;
        if (uses === 0) {
          sum.deactivate++;
          rows.push({ action: 'deactivate', entity: 'Services', targetId: g.s.id, label: `Deactivate duplicate #${g.s.id} "${g.s.name}"`, before: { isActive: true }, after: { isActive: false }, reason: `Duplicate of ${keeper ? `#${keeper.s.id}` : 'the new standard service'} for ${o.name} ${term}; no active contract uses it.`, blocked: null });
        } else {
          sum.inUseDuplicates++;
          rows.push({ action: 'info', entity: 'Services', targetId: g.s.id, label: `Keep duplicate #${g.s.id} "${g.s.name}" — in use`, before: null, after: null, reason: `Used by ${uses} active contract line(s); it stays active. Move those lines to ${keeper ? `#${keeper.s.id}` : 'the standard service'} (a contract change plan), then it can be deactivated.`, blocked: 'in use by active contracts' });
        }
      }
    }
  }
  return { rows, summary: sum };
}

function pickPrice(prices: VendorPrice[], skus: string[], term: Term): VendorPrice | null {
  const ok = prices.filter((p) => skus.includes(p.sku) && (p.cadence === term || (term === 'monthly' && p.cadence === 'MM')));
  return ok.sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))[0] ?? null;
}
