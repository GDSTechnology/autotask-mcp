// Contract pricing change plan (requirements §8): proposed corrections from a
// reconciliation run, frozen for row-level approval. Nothing here writes.
//
// In Autotask a contract service's PRICE and QUANTITY are changed with a
// ContractServiceAdjustment (effective date, unit change, adjusted unit price /
// cost) — ContractServices.unitPrice itself is read-only. Its COST
// (ContractServices.unitCost) is writable. So:
//   cost rows      → update ContractServices.unitCost            (cost-only, separate)
//   price rows     → create a ContractServiceAdjustment           (customer price change)
//   quantity rows  → create a ContractServiceAdjustment           (unit change)
//   missing line   → create a ContractService on the customer's licence contract
// Defaults are prospective: effective the 1st of next month. A row is blocked
// when the effective date is outside the contract, the period is already
// invoiced, the price is negotiated, or the target contract is ambiguous.
// Vendor cost going up NEVER raises a customer price by itself — the price row
// is a separate proposal a person approves.

import type { ReconRow } from './reconcile.js';
import type { PlanRowInput } from '../change-plans/store.js';

export type ChangeKind = 'cost' | 'price' | 'quantity' | 'missing_line';

export interface ContractPlanInput {
  rows: ReconRow[];
  include: ChangeKind[];
  effectiveDate: string; // YYYY-MM-DD
  /** Contract id/name/dates by id (for date validation and labels). */
  contracts: Map<number, { contractName: string; companyID: number; startDate: string | null; endDate: string | null }>;
  /** Latest posted billing item date per contract service (an invoiced period can't be re-priced here). */
  lastPostedThrough: Map<number, string>;
  /** For a missing line: the customer's active contracts holding other services of the same manufacturer. */
  licenceContracts: Map<number, number[]>;
  /** The standard Autotask service for (offering, cadence). */
  standardService: (offeringId: number, cadence: string) => number | null;
  /** Rows by number to include (default: every actionable row). */
  rowNos?: number[];
  /** Override the target contract for a missing line, per exception key. */
  contractChoices?: Record<string, number>;
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;
/** Report amounts are per the VENDOR term basis; write them in the contract service's own basis (a yearly service holds per-year amounts). */
const nativeOf = (r: ReconRow, v: number | null): number | null => {
  if (v == null) return null;
  const to = r.serviceBasis ?? r.basis;
  return r4(r.basis === to ? v : r.basis === 'year' ? v / 12 : v * 12);
};

export function buildContractPlan(i: ContractPlanInput): { rows: PlanRowInput[]; summary: Record<string, number> } {
  const out: PlanRowInput[] = [];
  const sum: Record<string, number> = { cost: 0, price: 0, quantity: 0, missing_line: 0, blocked: 0 };
  const want = (k: ChangeKind) => i.include.includes(k);
  const pick = i.rowNos?.length ? i.rows.filter((r) => i.rowNos!.includes(r.rowNo)) : i.rows;

  for (const r of pick) {
    const meta = { reconRow: r.rowNo, exceptionKey: r.exceptionKey, customer: r.customerName, contractServiceId: r.contractServiceId, offeringId: r.offeringId, cadence: r.cadence };
    const contract = r.contractId != null ? i.contracts.get(r.contractId) : undefined;
    const dateBlock = (csId: number | null, contractId: number | null): string | null => {
      const c = contractId != null ? i.contracts.get(contractId) : undefined;
      if (c?.startDate && i.effectiveDate < c.startDate.slice(0, 10)) return `effective ${i.effectiveDate} is before the contract starts (${c.startDate.slice(0, 10)})`;
      if (c?.endDate && i.effectiveDate > c.endDate.slice(0, 10)) return `effective ${i.effectiveDate} is after the contract ends (${c.endDate.slice(0, 10)}) — renew the contract first`;
      const posted = csId != null ? i.lastPostedThrough.get(csId) : undefined;
      if (posted && posted.slice(0, 10) >= i.effectiveDate) return `already invoiced through ${posted.slice(0, 10)} — historical credits / rebills need a separate approval`;
      return null;
    };

    // Cost: the contract's unit cost behind the vendor's landed cost.
    if (want('cost') && r.contractServiceId != null && r.landedCost != null && r.currentCost != null && Math.abs(r.landedCost - r.currentCost) > 0.005) {
      sum.cost++;
      out.push({
        meta, action: 'update', entity: 'ContractServices', targetId: r.contractServiceId,
        label: `Cost ${r.customerName} / ${r.autotaskContract} / ${r.serviceName}: ${r.currentCost} → ${r.landedCost} per ${r.basis}`,
        before: { unitCost: nativeOf(r, r.currentCost) }, after: { unitCost: nativeOf(r, r.landedCost) },
        reason: `Vendor landed cost (${r.sourceInvoice}). Cost only — the customer price does not change.`, blocked: null,
      });
    }

    // Price: below landed cost / target. Never when negotiated; never a decrease.
    const priceIssue = r.exceptions.some((e) => e === 'below_cost' || e === 'below_target' || e === 'margin_below_policy');
    if (want('price') && priceIssue && r.contractServiceId != null && r.priceShouldBe != null && r.currentPrice != null && r.priceShouldBe > r.currentPrice + 0.005) {
      sum.price++;
      const pct = r.currentPrice > 0 ? Math.round(((r.priceShouldBe - r.currentPrice) / r.currentPrice) * 1000) / 10 : null;
      const blocked = r.exceptions.includes('negotiated') ? 'a negotiated price applies — change it in the pricing policy first' : dateBlock(r.contractServiceId, r.contractId);
      if (blocked) sum.blocked++;
      out.push({
        meta, action: 'create', entity: 'ContractServiceAdjustments', targetId: null,
        label: `PRICE ${r.customerName} / ${r.autotaskContract} / ${r.serviceName}: ${r.currentPrice} → ${r.priceShouldBe} per ${r.basis}${pct != null ? ` (+${pct}%)` : ''} from ${i.effectiveDate} — customer price increase`,
        before: { unitPrice: nativeOf(r, r.currentPrice), units: r.contractQuantity },
        after: { contractID: r.contractId, contractServiceID: r.contractServiceId, serviceID: r.serviceId, effectiveDate: i.effectiveDate, unitChange: 0, adjustedUnitPrice: nativeOf(r, r.priceShouldBe), ...(r.landedCost != null ? { adjustedUnitCost: nativeOf(r, r.landedCost) } : {}) },
        reason: `${r.exceptions.join(', ')}: ${r.reason}. Target ${r.priceRule}. Monthly exposure ${r.monthlyExposure}.`, blocked,
      });
    }

    // Quantity: the vendor bills more units than the contract.
    if (want('quantity') && r.exceptions.includes('qty_short') && r.contractServiceId != null && r.quantity != null && r.contractQuantity != null) {
      sum.quantity++;
      const delta = r4(r.quantity - r.contractQuantity);
      const blocked = dateBlock(r.contractServiceId, r.contractId);
      if (blocked) sum.blocked++;
      out.push({
        meta, action: 'create', entity: 'ContractServiceAdjustments', targetId: null,
        label: `QUANTITY ${r.customerName} / ${r.autotaskContract} / ${r.serviceName}: ${r.contractQuantity} → ${r.quantity} (+${delta}) from ${i.effectiveDate}`,
        before: { unitPrice: nativeOf(r, r.currentPrice), units: r.contractQuantity },
        after: { contractID: r.contractId, contractServiceID: r.contractServiceId, serviceID: r.serviceId, effectiveDate: i.effectiveDate, unitChange: delta, ...(r.currentPrice != null ? { adjustedUnitPrice: nativeOf(r, r.currentPrice) } : {}), ...(r.currentCost != null ? { adjustedUnitCost: nativeOf(r, r.currentCost) } : {}) },
        reason: `The vendor bills ${r.quantity}; the contract bills ${r.contractQuantity} (${r.sourceInvoice}). Price unchanged.`, blocked,
      });
    }

    // Missing line: nothing on any active contract bills this product.
    if (want('missing_line') && r.exceptions.includes('not_billed') && r.autotaskCompanyId != null && r.offeringId != null) {
      sum.missing_line++;
      const chosen = i.contractChoices?.[r.exceptionKey];
      const options = i.licenceContracts.get(r.autotaskCompanyId) ?? [];
      const contractId = chosen ?? (options.length === 1 ? options[0]! : null);
      const serviceId = i.standardService(r.offeringId, r.cadence);
      const blocked = r.companyActive === false ? 'the Autotask company is inactive'
        : serviceId == null ? `no standard ${r.cadence} service for ${r.offering} — run the catalog plan first`
        : contractId == null ? (options.length ? `the customer has ${options.length} licence contracts (${options.join(', ')}) — choose one (contractChoices)` : 'no active contract to add it to — choose one (contractChoices)')
        : dateBlock(null, contractId);
      if (blocked) sum.blocked++;
      out.push({
        meta: { ...meta, followUp: 'set the quantity with the next plan (the new line starts with no units)' }, action: 'create', entity: 'ContractServices', targetId: null,
        label: `ADD ${r.offering} (${r.cadence}) to ${contractId != null ? i.contracts.get(contractId)?.contractName ?? contractId : '(choose a contract)'} for ${r.customerName} — ${r.quantity ?? '?'} unit(s) at ${r.priceShouldBe ?? '?'}`,
        before: null,
        after: { contractID: contractId, serviceID: serviceId, unitPrice: r.priceShouldBe, ...(r.landedCost != null ? { unitCost: r.landedCost } : {}) },
        reason: `${r.reason}. Monthly exposure ${r.monthlyExposure}. After it is added, rebuild the plan to set its quantity.`, blocked,
      });
    }

    if (r.exceptions.includes('term_mismatch') && r.contractServiceId != null) {
      out.push({ meta, action: 'info', entity: 'ContractServices', targetId: r.contractServiceId, label: `TERM ${r.customerName} / ${r.autotaskContract} / ${r.serviceName}: contract ${r.contractCadence}, vendor ${r.cadence}`, before: null, after: null, reason: 'Move the customer to the service for the matching term (end this line, add the other) — not automated: it changes what the customer is committed to.', blocked: 'term change needs a person' });
    }
    void contract;
  }
  return { rows: out, summary: sum };
}
