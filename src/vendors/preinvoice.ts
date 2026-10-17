// Pre-invoice check (billing process step 7): run BEFORE Approve & Post.
// Read-only. For the posting month it lists what is about to be invoiced and
// what could make that invoice wrong:
//   pending charges   unbilled contract charges dated on / before the posting date
//                     — they bill at this Approve & Post
//   double billing    a back-bill charge ("… — back-bill Sep 2026 – Oct 2026") for
//                     months another line of the same product ALREADY bills (e.g. a
//                     prepaid annual line) — STOP: delete the charge or end the line
//   duplicate lines   one customer billed for the same product on two lines in the
//                     posting month (two contracts, or an annual + a monthly line)
//   price changes     contract plan changes taking effect in the month, and whether
//                     the customer notice was recorded
//   open exceptions   undecided critical findings of the latest reconciliation
// Verdict: stop (double billing) | review (anything else to look at) | ready.

import { productKey } from './offerings.js';
import { backbillWindow } from './reconcile.js';
import { needsNotice, noticeLine, type NoticeRecord } from './notices.js';
import type { Plan } from '../change-plans/store.js';
import type { QueryFn } from './contract-io.js';
import { inChunks } from './contract-context.js';

export interface PreChargeRow { id: number; contractID: number; contractServiceID: number | null; name: string; datePurchased: string | null; unitQuantity: number | null; unitPrice: number | null; unitCost: number | null }
export interface PreContractRow { id: number; companyID: number; contractName: string; startDate: string | null; endDate: string | null }
export interface PreLineRow { id: number; contractID: number; serviceID: number }
export interface PreUnitRow { contractServiceID: number; startDate: string; endDate: string; units: number; price: number | null }

export interface PreinvoiceInput {
  throughDate: string; // YYYY-MM-DD, the Approve & Post date
  companyNames: Map<number, string>;
  contracts: PreContractRow[];
  lines: PreLineRow[];
  serviceNames: Map<number, string>;
  /** Autotask service id → manufacturer offering (catalog links); unlinked services group by product name. */
  offeringOfService: Map<number, number>;
  units: PreUnitRow[];
  charges: PreChargeRow[];
  plans: Plan[];
  notices: NoticeRecord[];
  openCritical: Array<{ customer: string | null; offering: string | null; exceptions: string[]; monthlyExposure: number | null; exceptionKey: string }>;
}

export interface PreinvoiceReport {
  throughDate: string; month: string; verdict: 'ready' | 'review' | 'stop';
  pendingCharges: Array<{ chargeId: number; customer: string | null; contract: string | null; name: string; date: string | null; quantity: number | null; unitPrice: number | null; amount: number | null; warning: string | null }>;
  doubleBilling: Array<{ chargeId: number; customer: string | null; charge: string; window: string; line: number; contract: string | null; service: string | null; months: string[]; units: number; why: string }>;
  duplicateLines: Array<{ customer: string | null; product: string; lines: Array<{ line: number; contract: string | null; service: string | null; units: number; price: number | null; period: string }> }>;
  priceChanges: Array<{ planId: string; row: number; customer: string | null; label: string; effectiveDate: string | null; status: string; monthlyChange: number | null; noticeRecorded: boolean | null }>;
  openCritical: PreinvoiceInput['openCritical'];
  totals: { pendingChargeAmount: number; priceChangeMonthly: number };
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const ym = (d: string) => d.slice(0, 7);
const monthsBetween = (from: string, to: string): string[] => {
  const out: string[] = []; let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  while (`${y}-${String(m).padStart(2, '0')}` <= to && out.length < 36) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } }
  return out;
};

export function analyzePreinvoice(i: PreinvoiceInput): PreinvoiceReport {
  const month = ym(i.throughDate);
  const contracts = new Map(i.contracts.map((c) => [c.id, c]));
  const lineById = new Map(i.lines.map((l) => [l.id, l]));
  const customerOf = (contractId: number) => { const c = contracts.get(contractId); return c ? i.companyNames.get(c.companyID) ?? `company ${c.companyID}` : null; };
  // A product's identity: its offering when linked, else its name without the term words.
  const productOf = (serviceId: number): string => { const o = i.offeringOfService.get(serviceId); return o != null ? `o:${o}` : `n:${productKey(i.serviceNames.get(serviceId) ?? String(serviceId))}`; };
  const productOfName = (name: string): string => {
    const exact = [...i.serviceNames.entries()].find(([, n]) => n === name);
    return exact ? productOf(exact[0]) : `n:${productKey(name)}`;
  };
  const unitsByLine = new Map<number, PreUnitRow[]>();
  for (const u of i.units) (unitsByLine.get(u.contractServiceID) ?? unitsByLine.set(u.contractServiceID, []).get(u.contractServiceID)!).push(u);
  const billsIn = (lineId: number, m: string) => (unitsByLine.get(lineId) ?? []).find((u) => u.units > 0 && ym(u.startDate) <= m && ym(u.endDate) >= m) ?? null;

  // 1. Pending charges — they bill at this Approve & Post.
  const pending = i.charges.filter((c) => contracts.has(c.contractID) && (!c.datePurchased || c.datePurchased.slice(0, 10) <= i.throughDate));
  const pendingCharges = pending.map((c) => {
    const amount = c.unitQuantity != null && c.unitPrice != null ? r2(c.unitQuantity * c.unitPrice) : null;
    const warning = c.unitPrice == null || c.unitPrice <= 0 ? 'no price — it bills $0' : c.unitCost != null && c.unitPrice < c.unitCost ? `priced below its cost (${c.unitPrice} < ${c.unitCost})` : null;
    return { chargeId: c.id, customer: customerOf(c.contractID), contract: contracts.get(c.contractID)?.contractName ?? null, name: c.name, date: c.datePurchased?.slice(0, 10) ?? null, quantity: c.unitQuantity, unitPrice: c.unitPrice, amount, warning };
  });

  // 2. Double billing: a back-bill window another line of the same product already bills.
  const doubleBilling: PreinvoiceReport['doubleBilling'] = [];
  for (const c of pending) {
    const w = backbillWindow(c.name); if (!w) continue;
    const company = contracts.get(c.contractID)!.companyID;
    const productName = c.name.split(/\s+[—-]\s+back-bill/i)[0]!.trim();
    const want = c.contractServiceID != null && lineById.has(c.contractServiceID) ? productOf(lineById.get(c.contractServiceID)!.serviceID) : productOfName(productName);
    const months = monthsBetween(w[0], w[1]);
    for (const l of i.lines) {
      const lc = contracts.get(l.contractID);
      if (!lc || lc.companyID !== company || l.id === c.contractServiceID || productOf(l.serviceID) !== want) continue; // the charge's own line: a shortfall top-up by design
      const hit = months.filter((m) => billsIn(l.id, m));
      if (!hit.length) continue;
      const u = billsIn(l.id, hit[0]!)!;
      doubleBilling.push({ chargeId: c.id, customer: customerOf(c.contractID), charge: c.name, window: `${w[0]} – ${w[1]}`, line: l.id, contract: lc.contractName, service: i.serviceNames.get(l.serviceID) ?? null, months: hit, units: u.units,
        why: `line ${l.id} already bills ${u.units} unit(s) for ${hit.join(', ')} (period ${u.startDate.slice(0, 10)} – ${u.endDate.slice(0, 10)}) — the back-bill would invoice those months twice. Delete the charge in Autotask, or confirm the line's units are a different seat.` });
    }
  }

  // 3. Duplicate lines in the posting month: one customer, one product, two lines with units.
  const groups = new Map<string, PreLineRow[]>();
  for (const l of i.lines) {
    const c = contracts.get(l.contractID); if (!c || !billsIn(l.id, month)) continue;
    const k = `${c.companyID}|${productOf(l.serviceID)}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(l);
  }
  const duplicateLines = [...groups.values()].filter((g) => g.length > 1).map((g) => ({
    customer: customerOf(g[0]!.contractID), product: i.serviceNames.get(g[0]!.serviceID) ?? String(g[0]!.serviceID),
    lines: g.map((l) => { const u = billsIn(l.id, month)!; return { line: l.id, contract: contracts.get(l.contractID)?.contractName ?? null, service: i.serviceNames.get(l.serviceID) ?? null, units: u.units, price: u.price, period: `${u.startDate.slice(0, 10)} – ${u.endDate.slice(0, 10)}` }; }),
  }));

  // 4. Plan changes taking effect this month (approved or applied), with the customer notice.
  const priceChanges: PreinvoiceReport['priceChanges'] = [];
  for (const p of i.plans) {
    if (p.kind !== 'contract_pricing') continue;
    for (const r of p.rows) {
      if (r.status !== 'approved' && r.status !== 'applied') continue;
      const line = noticeLine(r); if (!line || line.kind === 'backbill') continue;
      if (!line.effectiveDate || ym(line.effectiveDate) !== month) continue;
      const m = (r.meta ?? {}) as Record<string, unknown>;
      const companyId = m.companyId == null ? null : Number(m.companyId);
      priceChanges.push({ planId: p.id, row: r.rowNo, customer: (m.customer as string | null) ?? null, label: r.label, effectiveDate: line.effectiveDate, status: r.status, monthlyChange: line.monthlyChange,
        noticeRecorded: needsNotice(r) ? i.notices.some((n) => n.planId === p.id && n.companyId === companyId) : null });
    }
  }

  const verdict: PreinvoiceReport['verdict'] = doubleBilling.length ? 'stop'
    : duplicateLines.length || pendingCharges.some((c) => c.warning) || priceChanges.some((c) => c.noticeRecorded === false) || i.openCritical.length ? 'review' : 'ready';
  return {
    throughDate: i.throughDate, month, verdict, pendingCharges, doubleBilling, duplicateLines, priceChanges, openCritical: i.openCritical,
    totals: { pendingChargeAmount: r2(pendingCharges.reduce((t, c) => t + (c.amount ?? 0), 0)), priceChangeMonthly: r2(priceChanges.reduce((t, c) => t + (c.monthlyChange ?? 0), 0)) },
  };
}

/** Read what the check needs: unbilled charges, the active contracts and lines (of one company or the charges' + reconciled customers'), their unit periods. */
export async function loadPreinvoice(q: QueryFn, o: { throughDate: string; companyId?: number; companyIds?: number[] }): Promise<Omit<PreinvoiceInput, 'offeringOfService' | 'plans' | 'notices' | 'openCritical' | 'throughDate'> & { calls: number }> {
  const count = { calls: 0 };
  const from = new Date(`${o.throughDate}T00:00:00Z`); from.setUTCMonth(from.getUTCMonth() - 13);
  const windowStart = from.toISOString().slice(0, 10);
  // Unbilled charges dated in the last 13 months, on / before the posting date.
  count.calls++;
  const chargeRows = await q<Record<string, any>>('ContractCharges', [{ op: 'eq', field: 'isBilled', value: false }, { op: 'gte', field: 'datePurchased', value: `${windowStart}T00:00:00` }, { op: 'lte', field: 'datePurchased', value: `${o.throughDate}T23:59:59` }],
    { maxRecords: 5000, includeFields: ['id', 'contractID', 'contractServiceID', 'name', 'datePurchased', 'unitQuantity', 'unitPrice', 'unitCost'] });
  let charges: PreChargeRow[] = chargeRows.map((x) => ({ id: Number(x.id), contractID: Number(x.contractID), contractServiceID: x.contractServiceID == null ? null : Number(x.contractServiceID), name: String(x.name ?? ''), datePurchased: x.datePurchased ?? null, unitQuantity: x.unitQuantity == null ? null : Number(x.unitQuantity), unitPrice: x.unitPrice == null ? null : Number(x.unitPrice), unitCost: x.unitCost == null ? null : Number(x.unitCost) }));
  // Companies in scope: the one asked for, else every company with a pending charge plus the reconciled customers.
  const chargeContracts = charges.length ? await inChunks<Record<string, any>>(q, 'Contracts', 'id', charges.map((c) => c.contractID), [], ['id', 'companyID'], count) : [];
  const companyIds = o.companyId != null ? [o.companyId] : [...new Set([...chargeContracts.map((c) => Number(c.companyID)), ...(o.companyIds ?? [])])];
  const contractRows = await inChunks<Record<string, any>>(q, 'Contracts', 'companyID', companyIds, [{ op: 'eq', field: 'status', value: 1 }], ['id', 'companyID', 'contractName', 'contractType', 'startDate', 'endDate'], count);
  const contracts: PreContractRow[] = contractRows.filter((c) => c.contractType == null || Number(c.contractType) === 7)
    .map((c) => ({ id: Number(c.id), companyID: Number(c.companyID), contractName: String(c.contractName ?? ''), startDate: c.startDate ?? null, endDate: c.endDate ?? null }));
  const contractIds = new Set(contracts.map((c) => c.id));
  charges = charges.filter((c) => contractIds.has(c.contractID));
  const lines: PreLineRow[] = (await inChunks<Record<string, any>>(q, 'ContractServices', 'contractID', [...contractIds], [], ['id', 'contractID', 'serviceID'], count))
    .map((x) => ({ id: Number(x.id), contractID: Number(x.contractID), serviceID: Number(x.serviceID) }));
  const services = await inChunks<Record<string, any>>(q, 'Services', 'id', [...new Set(lines.map((l) => l.serviceID))], [], ['id', 'name'], count);
  const companies = await inChunks<Record<string, any>>(q, 'Companies', 'id', companyIds, [], ['id', 'companyName'], count);
  // Unit periods overlapping the 13 months before the posting date (back-bill windows + the posting month).
  const units: PreUnitRow[] = (await inChunks<Record<string, any>>(q, 'ContractServiceUnits', 'contractServiceID', lines.map((l) => l.id),
    [{ op: 'lte', field: 'startDate', value: `${o.throughDate}T23:59:59` }, { op: 'gte', field: 'endDate', value: `${windowStart}T00:00:00` }], ['id', 'contractServiceID', 'startDate', 'endDate', 'units', 'price'], count))
    .map((u) => ({ contractServiceID: Number(u.contractServiceID), startDate: String(u.startDate), endDate: String(u.endDate), units: Number(u.units ?? 0), price: u.price == null ? null : Number(u.price) }));
  return { companyNames: new Map(companies.map((c) => [Number(c.id), String(c.companyName ?? '')])), contracts, lines, serviceNames: new Map(services.map((x) => [Number(x.id), String(x.name ?? '')])), units, charges, calls: count.calls };
}
