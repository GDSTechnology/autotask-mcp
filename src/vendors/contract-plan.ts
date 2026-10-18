// Contract change plan (requirements §8): proposed corrections from a
// reconciliation run, frozen for row-level approval. Nothing here writes.
//
// In Autotask a contract line's PRICE and UNITS change only through an
// adjustment (effective date, unit change, adjusted unit price / cost) —
// ContractServices.unitPrice and .serviceID are read-only. Its COST
// (ContractServices.unitCost) is writable. An adjustment that names a
// contract + service but no line ADDS that service to the running contract
// from the effective date. So:
//   cost rows        → update ContractServices.unitCost                 (cost-only, separate)
//   price rows       → ContractServiceAdjustment / ContractServiceBundleAdjustment, unit change 0
//   quantity rows    → adjustment with the unit change (up when the vendor bills more, DOWN when less)
//   missing line     → an adjustment adding the standard service to the licence contract, with its units
//   extra seats      → beyond a bundle's units: the standard service added next to the bundle
//   term move        → add the line for the vendor's term, THEN end the old line (row depends on the first)
//   end line         → units to 0 on a line the vendor no longer charges for
// Defaults are prospective: effective the 1st of next month. A row is blocked
// when the effective date is outside the contract, the period is already
// invoiced, or the target contract is ambiguous. A negotiated customer price is the target itself.
// Vendor cost going up NEVER raises a customer price by itself — the price row
// is a separate proposal a person approves.

import type { ReconRow } from './reconcile.js';
import type { PlanRowInput } from '../change-plans/store.js';

export type ChangeKind = 'cost' | 'price' | 'quantity' | 'missing_line' | 'term' | 'end_line' | 'backbill';
export const CHANGE_KINDS: ChangeKind[] = ['cost', 'price', 'quantity', 'missing_line', 'term', 'end_line', 'backbill'];

export interface ContractInfo { contractName: string; companyID: number; startDate: string | null; endDate: string | null; contractType?: number | null }

export interface ContractPlanInput {
  rows: ReconRow[];
  include: ChangeKind[];
  effectiveDate: string; // YYYY-MM-DD
  /** Contract id/name/dates by id (for date validation and labels). */
  contracts: Map<number, ContractInfo>;
  /** Latest posted billing item date per contract service (an invoiced period can't be re-priced here). */
  lastPostedThrough: Map<number, string>;
  /** …and per contract service BUNDLE line. */
  lastPostedBundle?: Map<number, string>;
  /** For a missing line: the customer's Recurring Service contracts in effect on the effective date holding other services of the same manufacturer. */
  licenceContracts: Map<number, number[]>;
  /** The standard Autotask service for (offering, cadence). */
  standardService: (offeringId: number, cadence: string) => number | null;
  /** Service names (labels). */
  serviceName?: (serviceId: number) => string | null;
  /** Lines already on each contract: contractId → serviceID → contract service id (units go onto an existing line, never a second one). */
  contractLines?: Map<number, Map<number, number>>;
  /** Rows by number to include (default: every actionable row). */
  rowNos?: number[];
  /** Override the target contract for a missing line, per exception key. */
  contractChoices?: Record<string, number>;
  /** Back-bill from this month (YYYY-MM-01) up to the effective date: a one-time charge for the units the vendor charged but the customer was not billed. */
  backbillFrom?: string;
  /** Price the back-bill at the contract price (default — what the customer agreed) or the target price. */
  backbillPrice?: 'contract' | 'target' | number;
  /** Latest billing item per contract service on / after backbillFrom (billing inside the window means those months need a look first). */
  lastPostedFrom?: Map<number, string>;
  /** The MATERIAL COST billing code for a back-bill charge of this service (a contract charge refuses a recurring-service code). */
  billingCode?: (serviceId: number) => number | null;
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;
/** Report amounts are per the VENDOR term basis; write them in the contract line's own basis (a yearly service holds per-year amounts). */
const nativeOf = (r: ReconRow, v: number | null): number | null => {
  if (v == null) return null;
  const to = r.serviceBasis ?? r.basis;
  return r4(r.basis === to ? v : r.basis === 'year' ? v / 12 : v * 12);
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthName = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1] ?? ym} ${ym.slice(0, 4)}`;
const isBundlePriceRow = (r: ReconRow) => r.lineKind === 'bundle' && r.serviceSku.startsWith('bundle:');

/** Moving units from one contract line to another service: add (or top up) the new line, then end the old one. */
export interface MoveSpec {
  contractId: number; label: string; customer: string | null; contractName: string;
  fromLineId: number; fromName: string; units: number; oldUnitPrice: number | null;
  toServiceId: number; toName: string; toLineId: number | null; newUnits: number; unitPrice: number | null; unitCost: number | null;
  effectiveDate: string; blocked: string | null; reason: string; meta: Record<string, unknown>;
}
export function moveRows(m: MoveSpec, firstRowNo: number): PlanRowInput[] {
  const add: PlanRowInput = {
    meta: { ...m.meta, move: 'add' }, action: 'create', entity: 'ContractServiceAdjustments', targetId: null,
    label: `MOVE 1/2 ${m.customer} / ${m.contractName}: ${m.toLineId ? `add ${m.newUnits} unit(s) to` : `add`} ${m.toName}${m.toLineId ? '' : ` with ${m.newUnits} unit(s)`}${m.unitPrice != null ? ` at ${m.unitPrice}` : ''} from ${m.effectiveDate} (${m.label})`,
    before: m.toLineId ? null : { units: 0 },
    after: { contractID: m.contractId, ...(m.toLineId ? { contractServiceID: m.toLineId } : {}), serviceID: m.toServiceId, effectiveDate: m.effectiveDate, unitChange: m.newUnits, ...(m.unitPrice != null ? { adjustedUnitPrice: m.unitPrice } : {}), ...(m.unitCost != null ? { adjustedUnitCost: m.unitCost } : {}) },
    reason: m.reason, blocked: m.blocked,
  };
  const end: PlanRowInput = {
    meta: { ...m.meta, move: 'end', dependsOn: [firstRowNo] }, action: 'create', entity: 'ContractServiceAdjustments', targetId: null,
    label: `MOVE 2/2 ${m.customer} / ${m.contractName}: end ${m.fromName} (${m.units} → 0) from ${m.effectiveDate} — runs only after row ${firstRowNo}`,
    before: { units: m.units, ...(m.oldUnitPrice != null ? { unitPrice: m.oldUnitPrice } : {}) },
    after: { contractID: m.contractId, contractServiceID: m.fromLineId, effectiveDate: m.effectiveDate, unitChange: -m.units },
    reason: `${m.reason} The old line ends only after row ${firstRowNo} is in, so the customer is never left without the service.`, blocked: m.blocked,
  };
  return [add, end];
}

/**
 * The reconciliation counted each line's units in the INVOICE month; a plan changes things from the
 * effective date. Re-base every standalone line to its units the day before the effective date, so a
 * change made since (a seat added from the 1st of next month) isn't added a second time, and the
 * product's contract total follows. Lines with no period on that day bill 0.
 */
export function rebaseToEffectiveDate(rows: ReconRow[], unitsNow: Map<number, { units: number }>): ReconRow[] {
  const delta = new Map<number, number>();
  for (const r of rows) {
    if (r.lineKind !== 'service' || r.contractServiceId == null || delta.has(r.contractServiceId)) continue;
    delta.set(r.contractServiceId, (unitsNow.get(r.contractServiceId)?.units ?? 0) - (r.contractQuantity ?? 0));
  }
  // The product's total over every line of it at that customer (what the primary row compares with the vendor).
  const groupKey = (r: ReconRow) => `${r.autotaskCompanyId}|${r.offeringId}`;
  const groupDelta = new Map<string, number>();
  const seen = new Set<string>();
  for (const r of rows) {
    if (r.contractServiceId == null || !delta.has(r.contractServiceId)) continue;
    const k = `${groupKey(r)}|${r.contractServiceId}`; if (seen.has(k)) continue; seen.add(k);
    groupDelta.set(groupKey(r), (groupDelta.get(groupKey(r)) ?? 0) + delta.get(r.contractServiceId)!);
  }
  return rows.map((r) => {
    const d = r.contractServiceId != null ? delta.get(r.contractServiceId) : undefined;
    const g = groupDelta.get(groupKey(r));
    if (!d && !g) return r;
    return { ...r, ...(d ? { contractQuantity: r4((r.contractQuantity ?? 0) + d) } : {}), ...(g && r.contractQuantityTotal != null ? { contractQuantityTotal: r4(r.contractQuantityTotal + g) } : {}) };
  });
}

export function buildContractPlan(i: ContractPlanInput): { rows: PlanRowInput[]; summary: Record<string, number> } {
  const out: PlanRowInput[] = [];
  const sum: Record<string, number> = { cost: 0, price: 0, quantity: 0, missing_line: 0, term: 0, end_line: 0, backbill: 0, blocked: 0 };
  const want = (k: ChangeKind) => i.include.includes(k);
  const pick = i.rowNos?.length ? i.rows.filter((r) => i.rowNos!.includes(r.rowNo)) : i.rows;
  const nameOf = (sid: number | null) => (sid == null ? '?' : i.serviceName?.(sid) ?? `service ${sid}`);
  const lineOf = (contractId: number | null, serviceId: number | null) => (contractId != null && serviceId != null ? i.contractLines?.get(contractId)?.get(serviceId) ?? null : null);
  // Every row carries its kind (the customer-notice list and the execution gate read it).
  const push = (kind: keyof typeof sum, row: PlanRowInput) => { sum[kind] = (sum[kind] ?? 0) + 1; if (row.blocked) sum.blocked++; out.push({ ...row, meta: { ...(row.meta ?? {}), kind } }); };

  const dateBlock = (lineId: number | null, contractId: number | null, bundle = false): string | null => {
    const c = contractId != null ? i.contracts.get(contractId) : undefined;
    if (contractId != null && !c) return `contract ${contractId} is not an active contract`;
    if (c?.contractType != null && c.contractType !== 7) return `${c.contractName} is not a Recurring Service contract — it can't hold services`;
    if (c?.startDate && i.effectiveDate < c.startDate.slice(0, 10)) return `effective ${i.effectiveDate} is before the contract starts (${c.startDate.slice(0, 10)})`;
    if (c?.endDate && i.effectiveDate > c.endDate.slice(0, 10)) return `effective ${i.effectiveDate} is after the contract ends (${c.endDate.slice(0, 10)}) — renew the contract first`;
    const posted = lineId != null ? (bundle ? i.lastPostedBundle : i.lastPostedThrough)?.get(lineId) : undefined;
    if (posted && posted.slice(0, 10) >= i.effectiveDate) return `already invoiced through ${posted.slice(0, 10)} — historical credits / rebills need a separate approval`;
    return null;
  };

  for (const r of pick) {
    const meta = { reconRow: r.rowNo, exceptionKey: r.exceptionKey, customer: r.customerName, companyId: r.autotaskCompanyId, contract: r.autotaskContract, product: r.offering ?? r.serviceName, per: r.serviceBasis ?? r.basis, contractServiceId: r.contractServiceId, contractServiceBundleId: r.contractServiceBundleId, offeringId: r.offeringId, cadence: r.cadence };
    const where = `${r.customerName} / ${r.autotaskContract} / ${r.serviceName}`;
    const serviceLine = r.lineKind === 'service' && r.contractServiceId != null;
    const delta = r.primary && r.quantity != null ? r4(r.quantity - (r.contractQuantityTotal ?? r.contractQuantity ?? 0)) : 0;

    // Cost: the contract's unit cost behind the vendor's landed cost.
    // A line with no units on the effective date bills nothing — its cost is noise in the plan.
    if (want('cost') && serviceLine && (r.contractQuantity ?? 0) > 0 && r.landedCost != null && r.currentCost != null && Math.abs(r.landedCost - r.currentCost) > 0.005) {
      push('cost', {
        meta, action: 'update', entity: 'ContractServices', targetId: r.contractServiceId,
        label: `Cost ${where}: ${r.currentCost} → ${r.landedCost} per ${r.basis}`,
        before: { unitCost: nativeOf(r, r.currentCost) }, after: { unitCost: nativeOf(r, r.landedCost) },
        reason: `Vendor landed cost (${r.sourceInvoice}). Cost only — the customer price does not change.`, blocked: null,
      });
    }

    // Term: the customer is on a different term than the vendor sells → move the line to the vendor's term
    // (the move carries the target price and the vendor quantity, so no separate price / quantity row).
    let termMoved = false;
    if (want('term') && r.exceptions.includes('term_mismatch')) {
      const std = r.offeringId != null ? i.standardService(r.offeringId, r.cadence) : null;
      if (!serviceLine || std == null || !r.contractQuantity || r.contractId == null) {
        out.push({ meta, action: 'info', entity: 'ContractServices', targetId: r.contractServiceId, label: `TERM ${where}: contract ${r.contractCadence}, vendor ${r.cadence}`, before: null, after: null,
          reason: 'The contract term differs from what the vendor sells.', blocked: !serviceLine ? 'inside a bundle — change the bundle (its other parts may differ)' : std == null ? `no standard ${r.cadence} service for ${r.offering} — run the catalog plan first` : 'no units on the line this period — nothing to move' });
      } else {
        const newUnits = r.primary && delta ? r4(r.contractQuantity + delta) : r.contractQuantity;
        const quantityFolded = r.primary && !!delta;
        const c = i.contracts.get(r.contractId);
        const rows = moveRows({
          contractId: r.contractId, label: `term ${r.contractCadence} → ${r.cadence}`, customer: r.customerName, contractName: c?.contractName ?? r.autotaskContract ?? String(r.contractId),
          fromLineId: r.contractServiceId!, fromName: r.serviceName ?? nameOf(r.serviceId), units: r.contractQuantity, oldUnitPrice: nativeOf(r, r.currentPrice),
          toServiceId: std, toName: nameOf(std), toLineId: lineOf(r.contractId, std), newUnits, unitPrice: r.priceShouldBe != null ? r4(r.priceShouldBe) : null, unitCost: r.landedCost != null ? r4(r.landedCost) : null,
          effectiveDate: i.effectiveDate, blocked: r.exceptions.includes('negotiated') ? 'a negotiated price applies — agree the new term price first' : dateBlock(r.contractServiceId, r.contractId),
          reason: `The vendor sells this as ${r.cadence}; the customer is on ${r.contractCadence} — this changes the customer's commitment, so it needs the customer's agreement.${quantityFolded ? ` The new line carries the vendor quantity (${r.quantity}).` : ''}`,
          meta,
        }, out.length + 1);
        sum.term++; if (rows[0]!.blocked) sum.blocked += 2;
        out.push(...rows.map((x) => ({ ...x, meta: { ...(x.meta ?? {}), kind: 'term' } })));
        termMoved = true;
      }
    }

    // A line's state the day before the change: units, and the unit price only when it bills units (an empty line has none).
    const lineBefore = () => ({ units: r.contractQuantity, ...(r.contractQuantity ? { unitPrice: nativeOf(r, r.currentPrice) } : {}) });
    const qtyWanted = want('quantity') && !termMoved && r.primary && !!delta && r.contractId != null && (r.exceptions.includes('qty_short') || r.exceptions.includes('qty_over'));
    const lineChange = serviceLine ? (delta > 0 ? delta : -Math.min(r.contractQuantity ?? 0, -delta)) : 0;

    // Price: below landed cost / target, or not yet at the customer's negotiated price (the target then IS
    // the negotiated price — policy never overrides it). Never a decrease.
    // On a line whose quantity changes too, ONE adjustment carries both — two adjustments on the same
    // line and date would leave whichever price came last.
    const priceIssue = r.exceptions.some((e) => e === 'below_cost' || e === 'below_target' || e === 'margin_below_policy' || e === 'negotiated');
    let quantityDone = false;
    const billsUnits = (r.contractQuantity ?? 0) > 0 || (qtyWanted && lineChange > 0);
    if (!termMoved && want('price') && priceIssue && billsUnits && r.priceShouldBe != null && r.currentPrice != null && r.priceShouldBe > r.currentPrice + 0.005 && (serviceLine || isBundlePriceRow(r))) {
      const pct = r.currentPrice > 0 ? Math.round(((r.priceShouldBe - r.currentPrice) / r.currentPrice) * 1000) / 10 : null;
      const bundle = isBundlePriceRow(r);
      const blocked = dateBlock(bundle ? r.contractServiceBundleId : r.contractServiceId, r.contractId, bundle);
      const withQty = !bundle && qtyWanted && lineChange !== 0;
      if (withQty) { quantityDone = true; sum.quantity++; }
      push('price', {
        meta, action: 'create', entity: bundle ? 'ContractServiceBundleAdjustments' : 'ContractServiceAdjustments', targetId: null,
        label: `PRICE${withQty ? ' + QUANTITY' : ''} ${where}: ${r.currentPrice} → ${r.priceShouldBe} per ${r.basis}${pct != null ? ` (+${pct}%)` : ''}${withQty ? `, units ${r.contractQuantity} → ${r4((r.contractQuantity ?? 0) + lineChange)}` : ''} from ${i.effectiveDate} — customer price increase${r.exceptions.includes('negotiated') ? ' to the negotiated price' : ''}`,
        before: bundle ? { unitPrice: nativeOf(r, r.currentPrice), units: r.contractQuantity } : lineBefore(),
        after: bundle
          ? { contractID: r.contractId, contractServiceBundleID: r.contractServiceBundleId, serviceBundleID: r.serviceBundleId, effectiveDate: i.effectiveDate, unitChange: 0, adjustedUnitPrice: nativeOf(r, r.priceShouldBe) }
          : { contractID: r.contractId, contractServiceID: r.contractServiceId, serviceID: r.serviceId, effectiveDate: i.effectiveDate, unitChange: withQty ? lineChange : 0, adjustedUnitPrice: nativeOf(r, r.priceShouldBe), ...(r.landedCost != null ? { adjustedUnitCost: nativeOf(r, r.landedCost) } : {}) },
        reason: `${r.exceptions.join(', ')}: ${r.reason}. Target ${r.priceRule}. Monthly exposure ${r.monthlyExposure}.${withQty ? ` Quantity follows the vendor (${r.quantity}) in the same adjustment — build with include=["quantity"] for the quantity alone at the current price.` : ''}`, blocked,
      });
    }

    // Quantity: the primary line follows the vendor's quantity (up or down).
    if (qtyWanted && !quantityDone) {
      if (serviceLine) {
        const change = lineChange;
        if (change) push('quantity', {
          meta, action: 'create', entity: 'ContractServiceAdjustments', targetId: null,
          label: `QUANTITY ${where}: ${r.contractQuantity} → ${r4((r.contractQuantity ?? 0) + change)} (${change > 0 ? '+' : ''}${change}) from ${i.effectiveDate}${change < 0 ? ' — the customer is billed for seats the vendor no longer charges' : ''}`,
          before: lineBefore(),
          after: { contractID: r.contractId, contractServiceID: r.contractServiceId, serviceID: r.serviceId, effectiveDate: i.effectiveDate, unitChange: change, ...(r.currentPrice != null ? { adjustedUnitPrice: nativeOf(r, r.currentPrice) } : {}), ...(r.currentCost != null ? { adjustedUnitCost: nativeOf(r, r.currentCost) } : {}) },
          reason: `The vendor bills ${r.quantity}; the contract line(s) bill ${r.contractQuantityTotal ?? r.contractQuantity} (${r.sourceInvoice}). Price unchanged.`, blocked: dateBlock(r.contractServiceId, r.contractId),
        });
      } else if (delta > 0) {
        // Beyond the bundle's units: the extra seats go on a standalone line next to the bundle.
        const std = r.offeringId != null ? i.standardService(r.offeringId, r.cadence) : null;
        const existing = lineOf(r.contractId, std);
        push('quantity', {
          meta, action: 'create', entity: 'ContractServiceAdjustments', targetId: null,
          label: `EXTRA SEATS ${r.customerName} / ${r.autotaskContract}: ${delta} × ${std != null ? nameOf(std) : r.offering} beyond bundle ${r.bundleName} (${r.contractQuantityTotal} in contract, vendor ${r.quantity}) from ${i.effectiveDate}${r.priceShouldBe != null ? ` at ${r.priceShouldBe}` : ''}`,
          before: existing ? null : { units: 0 },
          after: { contractID: r.contractId, ...(existing ? { contractServiceID: existing } : {}), serviceID: std, effectiveDate: i.effectiveDate, unitChange: delta, ...(r.priceShouldBe != null ? { adjustedUnitPrice: r4(r.priceShouldBe) } : {}), ...(r.landedCost != null ? { adjustedUnitCost: r4(r.landedCost) } : {}) },
          reason: `The vendor bills ${r.quantity}; the bundle covers ${r.contractQuantityTotal}. Raising the bundle's units would add every other part of it too, so the extra seats are billed standalone.`,
          blocked: std == null ? `no standard ${r.cadence} service for ${r.offering} — run the catalog plan first` : dateBlock(existing, r.contractId),
        });
      } else {
        out.push({ meta, action: 'info', entity: 'ContractServiceBundles', targetId: r.contractServiceBundleId, label: `QUANTITY ${where}: bundle has ${r.contractQuantityTotal}, vendor ${r.quantity}`, before: null, after: null,
          reason: 'Fewer vendor seats than bundle units.', blocked: 'reducing a bundle changes every part of it — decide with the customer (build a bundle change by hand)' });
      }
    }

    // Missing line: nothing in effect bills this product → add the standard service, with its units, in one row.
    if (want('missing_line') && r.exceptions.includes('not_billed') && r.autotaskCompanyId != null && r.offeringId != null) {
      const chosen = i.contractChoices?.[r.exceptionKey];
      const options = i.licenceContracts.get(r.autotaskCompanyId) ?? [];
      const contractId = chosen ?? (options.length === 1 ? options[0]! : null);
      const serviceId = i.standardService(r.offeringId, r.cadence);
      const existing = lineOf(contractId, serviceId);
      const blocked = r.companyActive === false ? 'the Autotask company is inactive'
        : serviceId == null ? `no standard ${r.cadence} service for ${r.offering} — run the catalog plan first`
        : contractId == null ? (options.length ? `the customer has ${options.length} licence contracts (${options.join(', ')}) — choose one (contractChoices)` : 'no Recurring Service contract in effect to add it to — choose one (contractChoices) or create the contract first')
        : !r.quantity ? 'the vendor quantity is unknown'
        : dateBlock(existing, contractId);
      push('missing_line', {
        meta, action: 'create', entity: 'ContractServiceAdjustments', targetId: null,
        label: `ADD ${r.offering} (${r.cadence}) to ${contractId != null ? i.contracts.get(contractId)?.contractName ?? contractId : '(choose a contract)'} for ${r.customerName} — ${r.quantity ?? '?'} unit(s) at ${r.priceShouldBe ?? '?'} from ${i.effectiveDate}`,
        before: existing ? null : { units: 0 },
        after: { contractID: contractId, ...(existing ? { contractServiceID: existing } : {}), serviceID: serviceId, effectiveDate: i.effectiveDate, unitChange: r.quantity, ...(r.priceShouldBe != null ? { adjustedUnitPrice: r4(r.priceShouldBe) } : {}), ...(r.landedCost != null ? { adjustedUnitCost: r4(r.landedCost) } : {}) },
        reason: `${r.reason}. Monthly exposure ${r.monthlyExposure}. Added from the effective date — earlier months are not back-billed (that needs a separate approval).`, blocked,
      });
    }

    // Back-bill: the months before the effective date that the vendor charged and the customer was not billed —
    // a one-time contract charge (the forward fix is the quantity / missing-line row from the effective date).
    if (want('backbill') && i.backbillFrom && !r.exceptions.includes('backbilled') && (r.exceptions.includes('not_billed') || (r.primary && r.exceptions.includes('qty_short')))) {
      const missing = r.exceptions.includes('not_billed') ? r.quantity ?? 0 : delta > 0 ? delta : 0;
      const from = i.backbillFrom.slice(0, 7), to = i.effectiveDate.slice(0, 7);
      const months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7));
      const notBilled = r.exceptions.includes('not_billed');
      const contractId = notBilled ? (i.contractChoices?.[r.exceptionKey] ?? ((i.licenceContracts.get(r.autotaskCompanyId ?? -1) ?? []).length === 1 ? i.licenceContracts.get(r.autotaskCompanyId!)![0]! : null)) : r.contractId;
      const serviceId = notBilled ? (r.offeringId != null ? i.standardService(r.offeringId, r.cadence) : null) : r.serviceId;
      const price = typeof i.backbillPrice === 'number' ? i.backbillPrice : i.backbillPrice === 'target' ? r.priceShouldBe : r.currentPrice ?? r.priceShouldBe;
      const code = serviceId != null ? i.billingCode?.(serviceId) ?? null : null;
      const last = new Date(`${i.effectiveDate}T00:00:00Z`); last.setUTCDate(last.getUTCDate() - 1);
      const lastDay = last.toISOString().slice(0, 10);
      const window = `${monthName(from)}${months > 1 ? ` – ${monthName(lastDay.slice(0, 7))}` : ''}`;
      const posted = !notBilled && r.contractServiceId != null ? i.lastPostedFrom?.get(r.contractServiceId) : undefined;
      if (missing > 0) {
        const blocked = months <= 0 ? `back-bill from ${i.backbillFrom} is not before the effective date ${i.effectiveDate}`
          : r.basis === 'year' ? 'billed yearly — back-bill an annual term by hand'
          : serviceId == null ? `no standard ${r.cadence} service for ${r.offering} — run the catalog plan first` : price == null ? 'no price to back-bill at' : contractId == null ? 'choose the contract to charge (contractChoices)'
          : !i.contracts.has(contractId) ? `contract ${contractId} is not active — reactivate it first`
          : code == null ? 'no material cost code for the charge — pass backbillBillingCodeId (a BillingCodes id with useType 4, e.g. Software)' : null;
        const qty = r4(missing * Math.max(months, 0));
        push('backbill', {
          meta, action: 'create', entity: 'ContractCharges', targetId: null,
          label: `BACK-BILL ${r.customerName} / ${contractId != null ? i.contracts.get(contractId)?.contractName ?? contractId : '(choose a contract)'}: ${missing} × ${serviceId != null ? nameOf(serviceId) : r.offering} for ${window} (${qty} × ${price ?? '?'} = ${price != null ? r4(qty * price) : '?'}) — one-time charge`,
          before: null,
          after: { contractID: contractId, ...(!notBilled && r.contractServiceId != null ? { contractServiceID: r.contractServiceId } : {}), name: `${serviceId != null ? nameOf(serviceId) : r.offering ?? 'Service'} — back-bill ${window}`.slice(0, 100), description: `${missing} unit(s) × ${months} month(s) (${window}) charged by ${r.vendor} but not billed. ${r.sourceInvoice}.`.slice(0, 2000), chargeType: 1, datePurchased: lastDay, unitQuantity: qty, unitPrice: price, ...(r.landedCost != null ? { unitCost: r4(r.landedCost) } : {}), billingCodeID: code, isBillableToCompany: true },
          reason: `The vendor charged ${r.quantity} this month and the customer was billed ${notBilled ? 'none' : r.contractQuantityTotal ?? r.contractQuantity}. Assumes the same shortfall for each month from ${i.backbillFrom} — check against the vendor invoices for those months. Priced at ${typeof i.backbillPrice === 'number' ? `${i.backbillPrice} (given)` : `the ${i.backbillPrice === 'target' ? 'target' : 'contract'} price`}. The charge bills at the next Approve & Post.${posted && posted.slice(0, 10) >= i.backbillFrom ? ` Billing was posted on this line on ${posted.slice(0, 10)} (inside the window) — the charge covers only the ${missing} missing unit(s) a month; check those invoices showed the lower quantity.` : ''}`,
          blocked,
        });
      }
    }

    // End line: billed to the customer, no longer charged by the vendor.
    if (want('end_line') && r.exceptions.includes('not_purchased')) {
      if (serviceLine && r.contractQuantity) {
        push('end_line', {
          meta, action: 'create', entity: 'ContractServiceAdjustments', targetId: null,
          label: `END ${where}: ${r.contractQuantity} → 0 from ${i.effectiveDate} — no ${r.vendor} charge for it any more`,
          before: { units: r.contractQuantity, ...(r.currentPrice != null ? { unitPrice: nativeOf(r, r.currentPrice) } : {}) },
          after: { contractID: r.contractId, contractServiceID: r.contractServiceId, serviceID: r.serviceId, effectiveDate: i.effectiveDate, unitChange: -r.contractQuantity },
          reason: `${r.reason}. Only approve once you know it was cancelled (not bought elsewhere).`, blocked: dateBlock(r.contractServiceId, r.contractId),
        });
      } else {
        out.push({ meta, action: 'info', entity: 'ContractServiceBundles', targetId: r.contractServiceBundleId, label: `NOT PURCHASED ${where}`, before: null, after: null, reason: r.reason, blocked: 'inside a bundle — review the bundle with the customer' });
      }
    }
  }
  return { rows: out, summary: sum };
}
