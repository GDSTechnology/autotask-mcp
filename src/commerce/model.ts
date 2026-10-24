// Commerce: sell, bill and deliver through Autotask (migration 0017).
//
// An OFFERING is something sold — a recurring plan / add-on (an Autotask Service on a recurring
// service contract, priced per unit, e.g. per user) or a one-time service (a charge on its delivery
// ticket, with a material billing code). An ORDER is one sign-up. Placing it builds ONE change plan
// (kind commerce_order) that a person approves by hash; the executor then creates, in order:
//   company (new customers) → contacts (their users) → recurring contract → its services (an
//   adjustment per line, units = quantity, from the start date) → delivery ticket(s) → one-time charges.
// Rows refer to ids created by earlier rows (meta.refs), and every create is re-run safe.
// Invoicing stays in Autotask (the REST API can't create invoices); tracking then follows the order's
// charges to their invoice and its paid date (Invoices.paidDate, set when the payment syncs back).
//
// Pure: no I/O here (the tools resolve prices and check Autotask, then call buildOrderPlan).

import type { PlanRowInput } from '../change-plans/store.js';
import { isUnsafeCompanyName } from '../utils/company-guard.js';

export type OfferingKind = 'recurring' | 'one_time';

export interface Offering {
  code: string; platform: string | null; name: string; kind: OfferingKind;
  perUnit: boolean; unitLabel: string;
  autotaskServiceId: number | null; billingCodeId: number | null; unitPrice: number | null;
  delivery: Delivery | null; contract: Record<string, unknown> | null; charge: Record<string, unknown> | null;
  modules: string[]; active: boolean;
}
/** How an offering is delivered: a ticket. title / description may use {company}, {quantity}, {unitLabel}, {offering}. */
export interface Delivery { queueID: number; status?: number; priority?: number; issueType?: number; subIssueType?: number; title?: string; description?: string; estimatedHours?: number }

export interface OrderLineInput { offering: string; quantity?: number; unitPrice?: number }
export interface ContactInput { firstName: string; lastName: string; emailAddress: string; phone?: string; title?: string }
export interface NewCompany { companyName: string; phone?: string; address1?: string; city?: string; state?: string; postalCode?: string; webAddress?: string; ownerResourceID?: number }
export interface OrderInput {
  customer: { companyId: number } | NewCompany;
  contacts?: ContactInput[];
  lines: OrderLineInput[];
  /** YYYY-MM-DD; contract and services start here (default today). */
  startDate?: string;
  /** Use this existing contract for recurring lines instead of creating one. */
  contractId?: number;
  notes?: string;
}

/** A line as quoted: price resolved, totals computed. */
export interface QuotedLine { offering: string; name: string; kind: OfferingKind; quantity: number; unitLabel: string; unitPrice: number; total: number; perUnit: boolean; modules: string[] }
export interface Quote { lines: QuotedLine[]; oneTime: number; recurring: number; modules: string[]; problems: string[] }

const r2 = (n: number) => Math.round(n * 100) / 100;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const CODE = /^[a-z0-9][a-z0-9-]{1,62}$/;
const fill = (t: string, v: Record<string, string | number>) => t.replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m));
const addMonthsMinusDay = (d: string, months: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + months); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); };

/** Validate an offering definition (before it is saved). Returns problems, empty when fine. */
export function offeringProblems(o: Partial<Offering>): string[] {
  const p: string[] = [];
  if (!o.code || !CODE.test(o.code)) p.push('code: lowercase letters, digits and dashes (e.g. "psarelay-pro").');
  if (!o.name?.trim()) p.push('name is required.');
  if (o.kind !== 'recurring' && o.kind !== 'one_time') p.push('kind: "recurring" or "one_time".');
  if (o.kind === 'recurring' && !(Number(o.autotaskServiceId) > 0)) p.push('a recurring offering needs autotaskServiceId (the Autotask Service it bills).');
  if (o.kind === 'one_time') {
    if (!(Number(o.billingCodeId) > 0)) p.push('a one-time offering needs billingCodeId (a MATERIAL cost code — BillingCodes useType 4 — for its charge).');
    if (!(Number(o.unitPrice) >= 0) || o.unitPrice == null) p.push('a one-time offering needs unitPrice.');
    if (!o.delivery) p.push('a one-time offering needs delivery { queueID, … }: its charge sits on the delivery ticket.');
  }
  if (o.delivery && !(Number(o.delivery.queueID) > 0)) p.push('delivery.queueID is required.');
  if (o.modules && (!Array.isArray(o.modules) || o.modules.some((m) => typeof m !== 'string'))) p.push('modules: a list of module names.');
  return p;
}

/** Price the order lines against the catalog (servicePrice: the Autotask Service unit price for recurring lines). */
export function quoteOrder(lines: OrderLineInput[], catalog: Map<string, Offering>, servicePrice: (serviceId: number) => number | null): Quote {
  const problems: string[] = [];
  const out: QuotedLine[] = [];
  if (!Array.isArray(lines) || !lines.length) problems.push('lines: at least one { offering, quantity }.');
  for (const [i, l] of (lines ?? []).entries()) {
    const o = catalog.get(String(l?.offering ?? ''));
    if (!o) { problems.push(`line ${i + 1}: no offering "${l?.offering}" (autotask_commerce_offerings action=list).`); continue; }
    if (!o.active) { problems.push(`line ${i + 1}: offering "${o.code}" is archived.`); continue; }
    const quantity = o.perUnit ? Number(l.quantity ?? 1) : 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10_000) { problems.push(`line ${i + 1}: quantity must be a whole number from 1 (${o.unitLabel}s).`); continue; }
    const unitPrice = l.unitPrice != null ? Number(l.unitPrice) : o.unitPrice != null ? Number(o.unitPrice) : o.autotaskServiceId != null ? servicePrice(o.autotaskServiceId) : null;
    if (unitPrice == null || !Number.isFinite(unitPrice) || unitPrice < 0) { problems.push(`line ${i + 1}: no price for "${o.code}" (set unitPrice on the offering, or a price on Autotask Service ${o.autotaskServiceId}).`); continue; }
    out.push({ offering: o.code, name: o.name, kind: o.kind, quantity, unitLabel: o.unitLabel, unitPrice: r2(unitPrice), total: r2(unitPrice * quantity), perUnit: o.perUnit, modules: o.modules });
  }
  const dup = out.map((l) => l.offering).find((c, i, a) => a.indexOf(c) !== i);
  if (dup) problems.push(`offering "${dup}" is on the order twice — use one line with the quantity.`);
  return {
    lines: out,
    oneTime: r2(out.filter((l) => l.kind === 'one_time').reduce((t, l) => t + l.total, 0)),
    recurring: r2(out.filter((l) => l.kind === 'recurring').reduce((t, l) => t + l.total, 0)),
    modules: [...new Set(out.flatMap((l) => l.modules))].sort(),
    problems,
  };
}

/** Validate the customer and contacts. existingCompanyName: what Autotask already has under the new company's name (blocks it). */
export function orderProblems(input: OrderInput, o: { existingCompanyWithName?: { id: number; companyName: string } | null } = {}): string[] {
  const p: string[] = [];
  const c = input.customer as Partial<NewCompany> & { companyId?: number };
  if (c?.companyId != null) {
    if (!Number.isInteger(Number(c.companyId)) || Number(c.companyId) <= 0) p.push('customer.companyId: a customer company id (company 0 is your own).');
  } else {
    const name = String(c?.companyName ?? '').trim();
    if (!name) p.push('customer: { companyId } for an existing customer, or { companyName, phone, … } for a new one.');
    else {
      const g = isUnsafeCompanyName(name);
      if (!g.safe) p.push(`customer.companyName "${name}": ${g.reason ?? 'not a company name'}.`);
      if (o.existingCompanyWithName) p.push(`a company named "${o.existingCompanyWithName.companyName}" already exists (#${o.existingCompanyWithName.id}) — order for it with customer: { companyId: ${o.existingCompanyWithName.id} } instead of creating a duplicate.`);
    }
    if (!String(c?.phone ?? '').trim()) p.push('customer.phone is required for a new company (Autotask requires it).');
  }
  const contacts = input.contacts ?? [];
  if (contacts.length > 50) p.push('contacts: at most 50 per order.');
  const seen = new Set<string>();
  for (const [i, ct] of contacts.entries()) {
    if (!String(ct?.firstName ?? '').trim() || !String(ct?.lastName ?? '').trim()) p.push(`contact ${i + 1}: firstName and lastName are required.`);
    const e = String(ct?.emailAddress ?? '').trim().toLowerCase();
    if (!EMAIL.test(e)) p.push(`contact ${i + 1}: a valid emailAddress is required.`);
    else if (seen.has(e)) p.push(`contact ${i + 1}: ${e} is listed twice.`);
    seen.add(e);
  }
  if (input.startDate && !/^\d{4}-\d{2}-\d{2}$/.test(input.startDate)) p.push('startDate: YYYY-MM-DD.');
  if (input.contractId != null && !(Number(input.contractId) > 0)) p.push('contractId: an existing contract id.');
  return p;
}

/**
 * The plan rows for an order (call only when quote and order have no problems).
 * Row order matters: each row may refer to ids created by earlier rows (meta.refs).
 */
export function buildOrderPlan(input: OrderInput, quote: Quote, catalog: Map<string, Offering>, today: string): { rows: PlanRowInput[]; startDate: string } {
  const startDate = input.startDate ?? today;
  const rows: PlanRowInput[] = [];
  const add = (r: PlanRowInput) => { rows.push(r); return rows.length; };
  const cust = input.customer as NewCompany & { companyId?: number };
  const companyName = cust.companyId != null ? `company #${cust.companyId}` : cust.companyName.trim();
  // Fixed company id, or a ref to the row that creates it.
  let companyRow: number | null = null;
  const companyField = (): { fixed?: Record<string, unknown>; refs?: Record<string, number> } =>
    companyRow != null ? { refs: { companyID: companyRow } } : { fixed: { companyID: Number(cust.companyId) } };

  if (cust.companyId == null) {
    const after: Record<string, unknown> = { companyName: cust.companyName.trim(), companyType: 1, phone: cust.phone };
    for (const k of ['address1', 'city', 'state', 'postalCode', 'webAddress', 'ownerResourceID'] as const) if (cust[k] != null && cust[k] !== '') after[k] = cust[k];
    companyRow = add({ action: 'create', entity: 'Companies', targetId: null, label: `New customer: ${after.companyName}`, before: null, after, reason: 'order: new customer', blocked: null, meta: { step: 'company' } });
  }

  let primaryContactRow: number | null = null;
  for (const [i, ct] of (input.contacts ?? []).entries()) {
    const cf = companyField();
    const after: Record<string, unknown> = { ...(cf.fixed ?? {}), firstName: ct.firstName.trim(), lastName: ct.lastName.trim(), emailAddress: ct.emailAddress.trim().toLowerCase(), isActive: 1, ...(i === 0 ? { primaryContact: true } : {}) };
    if (ct.phone) after.phone = ct.phone; if (ct.title) after.title = ct.title;
    const n = add({ action: 'create', entity: 'Contacts', targetId: null, label: `User: ${after.firstName} ${after.lastName} <${after.emailAddress}>`, before: null, after, reason: `order: user ${i + 1} of ${(input.contacts ?? []).length}`, blocked: null, meta: { step: 'contact', ...(cf.refs ? { refs: cf.refs } : {}) } });
    if (i === 0) primaryContactRow = n;
  }
  const contactRef = primaryContactRow != null ? { contactID: primaryContactRow } : {};

  // Recurring lines → one recurring service contract, a service line per offering.
  const recurring = quote.lines.filter((l) => l.kind === 'recurring');
  let contractRow: number | null = null;
  if (recurring.length && input.contractId == null) {
    const first = catalog.get(recurring[0]!.offering)!;
    const c = { ...(first.contract ?? {}) } as Record<string, unknown>;
    const termMonths = Number(c.termMonths ?? 12); delete c.termMonths;
    const cf = companyField();
    const after: Record<string, unknown> = { ...(cf.fixed ?? {}), contractName: `${first.platform ? `${first.platform} — ` : ''}${recurring.map((l) => l.name).join(' + ')}`.slice(0, 100), contractType: 7, status: 1, startDate, endDate: addMonthsMinusDay(startDate, termMonths > 0 ? termMonths : 12), ...c };
    contractRow = add({ action: 'create', entity: 'Contracts', targetId: null, label: `Recurring contract for ${companyName}: ${after.contractName}`, before: null, after, reason: `order: ${recurring.length} recurring line(s), ${termMonths}-month term`, blocked: after.contractCategory == null ? 'the offering has no contract.contractCategory (Autotask requires one) — set it on the offering' : null, meta: { step: 'contract', refs: { ...(cf.refs ?? {}), ...contactRef } } });
  }
  for (const l of recurring) {
    const o = catalog.get(l.offering)!;
    const contract = contractRow != null ? { refs: { contractID: contractRow } } : { fixed: { contractID: Number(input.contractId) } };
    add({ action: 'create', entity: 'ContractServiceAdjustments', targetId: null, label: `${o.name}: ${l.quantity} ${l.unitLabel}${l.quantity === 1 ? '' : 's'} × ${l.unitPrice} from ${startDate}`, before: null,
      after: { ...(contract.fixed ?? {}), serviceID: o.autotaskServiceId, unitChange: l.quantity, adjustedUnitPrice: l.unitPrice, effectiveDate: startDate },
      reason: 'order: recurring line — added to the contract by an adjustment (Autotask prorates from the start date)', blocked: null, meta: { step: 'service', offering: o.code, ...(contract.refs ? { refs: contract.refs } : {}) } });
  }

  // Delivery: a ticket per offering that has one; one-time lines are charged on their ticket.
  for (const l of quote.lines) {
    const o = catalog.get(l.offering)!;
    if (!o.delivery) continue;
    const v = { company: companyName, quantity: l.quantity, unitLabel: l.unitLabel, offering: o.name };
    const cf = companyField();
    const d = o.delivery;
    const after: Record<string, unknown> = { ...(cf.fixed ?? {}), title: fill(d.title ?? '{offering} — {company}', v).slice(0, 255), description: fill(d.description ?? 'Order: {offering} for {company} ({quantity} {unitLabel}).', v) + (input.notes ? `\n\nNotes: ${input.notes}` : ''), queueID: d.queueID, status: d.status ?? 1, priority: d.priority ?? 2 };
    for (const k of ['issueType', 'subIssueType', 'estimatedHours'] as const) if (d[k] != null) after[k] = d[k];
    const ticketRow = add({ action: 'create', entity: 'Tickets', targetId: null, label: `Delivery ticket: ${after.title}`, before: null, after, reason: 'order: delivery', blocked: null, meta: { step: 'ticket', offering: o.code, refs: { ...(cf.refs ?? {}), ...contactRef } } });
    if (l.kind === 'one_time') {
      add({ action: 'create', entity: 'TicketCharges', targetId: null, label: `Charge: ${o.name} × ${l.quantity} @ ${l.unitPrice}`, before: null,
        after: { name: o.name, billingCodeID: o.billingCodeId, unitQuantity: l.quantity, unitPrice: l.unitPrice, unitCost: 0, isBillableToCompany: true, chargeType: 1, status: 1, datePurchased: startDate, ...(o.charge ?? {}) },
        reason: 'order: one-time charge — invoice it from the ticket', blocked: null, meta: { step: 'charge', offering: o.code, refs: { ticketID: ticketRow } } });
    }
  }
  return { rows, startDate };
}
