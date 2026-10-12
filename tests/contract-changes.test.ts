// Contracts & services follow-ups: only Recurring Service contracts in effect
// for the period match; "not purchased" (billed to the customer, no longer
// charged by the vendor); bundles (components counted for quantity, the bundle
// priced against its parts); plan rows for quantity decreases, extra seats
// beyond a bundle, one-row missing lines, term moves (end the old line only
// after the new one) and ending lines; adjustments verified by their EFFECT
// (they can't be queried); dependent rows wait; undo plans; drift only on the
// latest write.

import { reconcile, contractCovers, type ReconInput } from '../src/vendors/reconcile';
import { buildContractPlan, moveRows } from '../src/vendors/contract-plan';
import { adjustmentAlreadyApplied, adjustmentExpect, adjustmentReadBack, adjustmentSnapshot, type QueryFn } from '../src/vendors/contract-io';
import { executePlan, type EntityIO } from '../src/change-plans/execute';
import { buildRevertRows } from '../src/change-plans/revert';
import { checkDrift } from '../src/vendors/drift';
import { startVendorMonitor } from '../src/vendors/monitor';
import type { Plan, PlanRow } from '../src/change-plans/store';
import type { VendorLine } from '../src/vendors/types';

const line = (o: Partial<VendorLine>): VendorLine => ({ vendor: 'pax8', vendorAccountId: null, lineKey: Math.random().toString(36), vendorCustomerId: '1', vendorCustomerName: 'Acme', subscriptionId: 's1', sku: 'M365-BS', description: 'Microsoft 365 Business Standard', chargeClass: 'recurring', cadence: 'MM', billingTerm: 'Monthly', commitmentTerm: 'Monthly', unit: 'User', quantity: 4, unitCost: 14, costTotal: 56, vendorSuggestedUnitPrice: 16.8, periodStart: '2026-10-01', periodEnd: '2026-10-31', renewalDate: null, currency: 'USD', tax: 0, fees: 0, flags: [], raw: {}, ...o });
const map = (sku: string, offeringId: number) => ({ vendor: 'pax8', sku, status: 'mapped' as const, offeringId, method: 'm', confidence: 'confirmed', note: null, decidedBy: null, decidedAt: 'x' });
const link = (sid: number, offeringId: number, cadence: string, method = 'manual') => ({ autotaskEntity: 'Services', autotaskId: sid, offeringId, cadence, method, confidence: 'confirmed', note: null, decidedBy: null, decidedAt: 'x' });

function input(o: Partial<ReconInput> = {}): ReconInput {
  return {
    vendor: 'pax8', invoice: { documentId: 9, invoiceNumber: 'INV-10', invoiceDate: '2026-10-01', periodStart: '2026-10-01', periodEnd: '2026-10-31' },
    lines: [line({})],
    customerMappings: [{ vendor: 'pax8', vendorCustomerId: '1', vendorCustomerName: 'Acme', status: 'mapped', autotaskCompanyId: 100, method: 'x', confidence: 'high', note: null, decidedBy: null, decidedAt: 'x' }],
    offeringMappings: [map('M365-BS', 7), map('BACKUP', 8)],
    offerings: [{ id: 7, manufacturer: 'Microsoft', name: 'Microsoft 365 Business Standard', manufacturerProductId: null, unit: null, kind: 'recurring', notes: null }, { id: 8, manufacturer: 'NinjaOne', name: 'NinjaOne SaaS Backup', manufacturerProductId: null, unit: null, kind: 'recurring', notes: null }],
    links: [link(297, 7, 'MM', 'standardized'), link(231, 7, 'AM', 'standardized'), link(259, 8, 'monthly', 'standardized')],
    services: [{ id: 297, name: 'Microsoft 365 Business Standard [NCE] - MM', periodType: 2, unitCost: 14, unitPrice: 16.8 }, { id: 231, name: 'Microsoft 365 Business Standard [NCE] - AM', periodType: 2, unitCost: 12.6, unitPrice: 15 }, { id: 259, name: 'NinjaOne SaaS Backup - Monthly', periodType: 2, unitCost: 2.8, unitPrice: 4 }, { id: 500, name: 'Managed Support', periodType: 2, unitCost: 20, unitPrice: 40 }],
    companies: [{ id: 100, companyName: 'Acme', isActive: true }],
    contracts: [{ id: 1, companyID: 100, contractName: 'Licenses 2026', status: 1, contractType: 7, startDate: '2026-01-01', endDate: '2026-12-31' }],
    contractServices: [{ id: 10, contractID: 1, serviceID: 297, unitCost: 14, unitPrice: 16.8 }],
    units: [{ contractServiceID: 10, units: 4, price: 67.2, cost: 56, startDate: '2026-10-01', endDate: '2026-10-31' }],
    billed: [{ contractServiceID: 10, quantity: 4, rate: 16.8, extendedPrice: 67.2, ourCost: 56, invoiceID: 1, itemDate: '2026-10-01', posted: true }],
    policies: [], customerExceptions: [],
    ...o,
  };
}

describe('which contracts match', () => {
  test('only active Recurring Service contracts whose dates overlap the period', () => {
    expect(contractCovers({ status: 1, contractType: 7, startDate: '2026-01-01', endDate: '2026-12-31' }, '2026-10-01', '2026-10-31')).toBe(true);
    expect(contractCovers({ status: 1, contractType: 7, startDate: '2027-05-01', endDate: null }, '2026-10-01', '2026-10-31')).toBe(false);
    expect(contractCovers({ status: 1, contractType: 7, startDate: null, endDate: '2026-09-30' }, '2026-10-01', '2026-10-31')).toBe(false);
    expect(contractCovers({ status: 1, contractType: 4, startDate: null, endDate: null }, '2026-10-01', '2026-10-31')).toBe(false); // block hours
    expect(contractCovers({ status: 0, contractType: 7, startDate: null, endDate: null }, '2026-10-01', '2026-10-31')).toBe(false);
  });

  test('a line on a FUTURE contract does not count — not billed now, and the reason names that contract', () => {
    const r = reconcile(input({ contracts: [{ id: 1, companyID: 100, contractName: '2027 - Monthly - Microsoft', status: 1, contractType: 7, startDate: '2027-05-01', endDate: '2028-04-30' }] })).rows;
    const nb = r.find((x) => x.exceptions.includes('not_billed'))!;
    expect(nb.severity).toBe('critical');
    expect(nb.reason).toMatch(/NOT in effect for this period has it: 2027 - Monthly - Microsoft \(2027-05-01 – 2028-04-30\)/);
    expect(r.some((x) => x.exceptions.includes('not_purchased'))).toBe(false); // the future line bills nothing now
  });
});

describe('not purchased (contract → vendor)', () => {
  test('a billed line for a product this vendor supplies, with no vendor charge, is high; annual ones use the 13-month lookback', () => {
    const base = input({
      contractServices: [{ id: 10, contractID: 1, serviceID: 297, unitCost: 14, unitPrice: 16.8 }, { id: 11, contractID: 1, serviceID: 259, unitCost: 2.8, unitPrice: 4 }],
      units: [{ contractServiceID: 10, units: 4, price: 67.2, cost: 56, startDate: '2026-10-01', endDate: '2026-10-31' }, { contractServiceID: 11, units: 6, price: 24, cost: 16.8, startDate: '2026-10-01', endDate: '2026-10-31' }],
    });
    const np = reconcile(base).rows.find((x) => x.exceptions.includes('not_purchased'))!;
    expect(np).toMatchObject({ severity: 'high', contractServiceId: 11, contractQuantity: 6, quantity: 0, monthlyExposure: 0, currentPrice: 4 });
    expect(np.reason).toMatch(/bills 6 × NinjaOne SaaS Backup - Monthly \(24\/month\)/);
    // An AA line is on one invoice a year: seen in the last 13 months → not flagged.
    const annual = input({ ...base, links: [...base.links.filter((l) => l.autotaskId !== 259), link(259, 8, 'AA')], recentAnnual: ['100|8'] });
    expect(reconcile(annual).rows.some((x) => x.exceptions.includes('not_purchased'))).toBe(false);
    // Lines with no units this period are not "billed".
    expect(reconcile({ ...base, units: base.units.slice(0, 1) }).rows.some((x) => x.exceptions.includes('not_purchased'))).toBe(false);
  });
});

describe('bundles', () => {
  const bundled = (o: Partial<ReconInput> = {}) => input({
    contractServices: [],
    units: [],
    billed: [],
    bundles: [{ id: 70, name: 'Modern Workplace', periodType: 2, unitCost: 34, unitPrice: 30, serviceIds: [297, 500] }],
    bundleLines: [{ id: 700, contractID: 1, serviceBundleID: 70, unitPrice: 30, adjustedPrice: null }],
    bundleUnits: [{ contractServiceBundleID: 700, units: 4, price: 120, cost: 136, startDate: '2026-10-01', endDate: '2026-10-31' }],
    ...o,
  });

  test('a component inside a bundle counts for quantity (no price of its own); the bundle is priced against its parts', () => {
    const { rows, summary } = reconcile(bundled());
    const comp = rows.find((r) => r.offeringId === 7)!;
    expect(comp).toMatchObject({ lineKind: 'bundle', contractServiceBundleId: 700, contractServiceId: null, contractQuantity: 4, currentPrice: null, priceShouldBe: 16.8, differenceOnPrice: null, primary: true });
    expect(comp.exceptions).not.toContain('qty_short');
    expect(comp.exceptions).not.toContain('below_cost');
    expect(comp.serviceName).toBe('Modern Workplace › Microsoft 365 Business Standard [NCE] - MM');
    const b = rows.find((r) => r.serviceSku === 'bundle:70')!;
    // 14 (pax8 landed) + 20 (catalog cost of the labour service) = 34 > 30
    expect(b).toMatchObject({ severity: 'critical', costShouldBe: 34, currentPrice: 30, priceShouldBe: 34, monthlyExposure: 16 });
    expect(b.exceptions).toContain('below_cost');
    expect(b.reason).toMatch(/Microsoft 365 Business Standard \[NCE\] - MM 14 \(pax8\) \+ Managed Support 20 \(catalog cost\)/);
    expect(summary).toMatchObject({ bundles: 1 });
  });

  test('vendor seats beyond the bundle → qty_short on the bundle component; the plan bills the extras standalone', () => {
    const rows = reconcile(bundled({ lines: [line({ quantity: 6, costTotal: 84 })] })).rows;
    const comp = rows.find((r) => r.offeringId === 7)!;
    expect(comp.exceptions).toContain('qty_short');
    const plan = buildContractPlan({ rows, include: ['quantity'], effectiveDate: '2026-11-01', contracts: new Map([[1, { contractName: 'Licenses 2026', companyID: 100, startDate: '2026-01-01', endDate: '2026-12-31', contractType: 7 }]]), lastPostedThrough: new Map(), licenceContracts: new Map(), standardService: () => 297 });
    const extra = plan.rows.find((r) => r.label.startsWith('EXTRA SEATS'))!;
    expect(extra).toMatchObject({ entity: 'ContractServiceAdjustments', blocked: null, before: { units: 0 }, after: { contractID: 1, serviceID: 297, unitChange: 2, adjustedUnitPrice: 16.8 } });
  });

  test('fewer vendor seats than bundle units is never shrunk automatically', () => {
    const rows = reconcile(bundled({ lines: [line({ quantity: 3, costTotal: 42 })] })).rows;
    const plan = buildContractPlan({ rows, include: ['quantity'], effectiveDate: '2026-11-01', contracts: new Map([[1, { contractName: 'L', companyID: 100, startDate: null, endDate: null, contractType: 7 }]]), lastPostedThrough: new Map(), licenceContracts: new Map(), standardService: () => 297 });
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]).toMatchObject({ action: 'info', blocked: expect.stringMatching(/reducing a bundle/) });
  });
});

describe('contract plan rows', () => {
  const contracts = new Map([[1, { contractName: 'Licenses 2026', companyID: 100, startDate: '2026-01-01', endDate: '2026-12-31', contractType: 7 }]]);
  const base = { include: ['cost', 'price', 'quantity', 'missing_line', 'term', 'end_line'] as Array<'cost' | 'price' | 'quantity' | 'missing_line' | 'term' | 'end_line'>, effectiveDate: '2026-11-01', contracts, lastPostedThrough: new Map<number, string>(), licenceContracts: new Map<number, number[]>(), standardService: (_o: number, c: string) => (c === 'AM' ? 231 : 297) };

  test('quantity DOWN when the vendor bills fewer seats; the total across lines is used', () => {
    const rows = reconcile(input({ lines: [line({ quantity: 3, costTotal: 42 })] })).rows;
    const q = buildContractPlan({ ...base, rows }).rows.find((r) => r.label.startsWith('QUANTITY'))!;
    expect(q).toMatchObject({ before: { units: 4 }, after: { contractServiceID: 10, unitChange: -1 } });
    expect(q.label).toMatch(/no longer charges/);
  });

  test('term move: add the line on the vendor term, then end the old one — the second row depends on the first', () => {
    const rows = reconcile(input({ lines: [line({ cadence: 'AM', commitmentTerm: '1-Year', quantity: 5, costTotal: 63, unitCost: 12.6, vendorSuggestedUnitPrice: 15 })] })).rows;
    const plan = buildContractPlan({ ...base, rows, include: ['term', 'quantity'] }).rows;
    expect(plan).toHaveLength(2); // the +1 seat is folded into the move, no separate quantity row
    expect(plan[0]).toMatchObject({ entity: 'ContractServiceAdjustments', before: { units: 0 }, after: { contractID: 1, serviceID: 231, unitChange: 5, adjustedUnitPrice: 15 } });
    expect(plan[1]).toMatchObject({ before: { units: 4 }, after: { contractServiceID: 10, unitChange: -4 }, meta: expect.objectContaining({ dependsOn: [1] }) });
  });

  test('a move onto a service the contract already has tops up that line', () => {
    const [add] = moveRows({ contractId: 1, label: 'dup', customer: 'Acme', contractName: 'L', fromLineId: 10, fromName: 'old', units: 3, oldUnitPrice: 15, toServiceId: 297, toName: 'new', toLineId: 77, newUnits: 3, unitPrice: 15, unitCost: 12, effectiveDate: '2026-11-01', blocked: null, reason: 'r', meta: {} }, 1);
    expect(add).toMatchObject({ before: null, after: { contractServiceID: 77, unitChange: 3 } });
  });

  test('end a line the vendor no longer charges for', () => {
    const rows = reconcile(input({ lines: [line({ sku: 'BACKUP', quantity: 2, unitCost: 2.8, costTotal: 5.6 })], links: [link(297, 7, 'MM'), link(259, 8, 'monthly')], contractServices: [{ id: 10, contractID: 1, serviceID: 297, unitCost: 14, unitPrice: 16.8 }] })).rows;
    const end = buildContractPlan({ ...base, rows, include: ['end_line'] }).rows[0]!;
    expect(end).toMatchObject({ before: { units: 4, unitPrice: 16.8 }, after: { contractServiceID: 10, unitChange: -4 }, blocked: null });
  });

  test('blocked: a contract that is not Recurring Service, or invoiced already', () => {
    const rows = reconcile(input({ lines: [line({ quantity: 3, costTotal: 42 })] })).rows;
    const t = buildContractPlan({ ...base, rows, include: ['quantity'], contracts: new Map([[1, { ...contracts.get(1)!, contractType: 4 }]]) }).rows[0]!;
    expect(t.blocked).toMatch(/not a Recurring Service contract/);
    const inv = buildContractPlan({ ...base, rows, include: ['quantity'], lastPostedThrough: new Map([[10, '2026-11-01']]) }).rows[0]!;
    expect(inv.blocked).toMatch(/already invoiced/);
  });
});

describe('billing that stopped (a line with no billing period) — restore, re-price and back-bill', () => {
  // The customer moved from annual to monthly; the monthly line's billing stopped after August
  // while the vendor kept charging 10.08 a month. Contract price 9.96 is also below cost.
  const stopped = () => input({
    lines: [line({ sku: 'APPS', description: 'Microsoft 365 Apps for Business', quantity: 1, unitCost: 10.08, costTotal: 10.08, vendorSuggestedUnitPrice: 9.96 })],
    offeringMappings: [map('APPS', 9)],
    offerings: [{ id: 9, manufacturer: 'Microsoft', name: 'Microsoft 365 Apps for Business', manufacturerProductId: null, unit: null, kind: 'recurring', notes: null }],
    links: [link(3358, 9, 'MM', 'standardized')],
    services: [{ id: 3358, name: 'Microsoft 365 Apps for Business [NCE] - Monthly', periodType: 2, unitCost: 8.37, unitPrice: 9.96 }],
    contractServices: [{ id: 33, contractID: 1, serviceID: 3358, unitCost: 8.37, unitPrice: 9.96 }],
    units: [], billed: [],
  });
  const plan = (o: Partial<Parameters<typeof buildContractPlan>[0]> = {}) => buildContractPlan({
    rows: reconcile(stopped()).rows, include: ['cost', 'price', 'quantity', 'backbill'], effectiveDate: '2026-11-01',
    contracts: new Map([[1, { contractName: 'Monthly - Managed services - 2026', companyID: 100, startDate: '2026-05-01', endDate: '2027-04-30', contractType: 7 }]]),
    lastPostedThrough: new Map(), licenceContracts: new Map(), standardService: () => 3358, serviceName: () => 'Microsoft 365 Apps for Business [NCE] - Monthly', billingCode: () => 29683360,
    backbillFrom: '2026-09-01', ...o,
  }).rows;

  test('the line counts as 0 units → short by 1, below cost', () => {
    const r = reconcile(stopped()).rows[0]!;
    expect(r).toMatchObject({ contractServiceId: 33, contractQuantity: 0, quantity: 1, currentPrice: 9.96, landedCost: 10.08 });
    expect(r.exceptions).toEqual(expect.arrayContaining(['qty_short', 'below_cost']));
    expect(r.reason).toMatch(/no billing period for this month/);
  });

  test('ONE adjustment restores the seat at the new price (never a second one putting the old price back); a one-time charge back-bills Sep–Oct', () => {
    const rows = plan();
    const adj = rows.filter((x) => x.entity === 'ContractServiceAdjustments');
    expect(adj).toHaveLength(1);
    expect(adj[0]).toMatchObject({ before: { units: 0 }, after: { contractServiceID: 33, effectiveDate: '2026-11-01', unitChange: 1, adjustedUnitPrice: 10.08 } });
    expect(adj[0]!.before).not.toHaveProperty('unitPrice'); // an empty line has no current unit price to be stale against
    expect(adj[0]!.label).toMatch(/^PRICE \+ QUANTITY/);
    const bb = rows.find((x) => x.entity === 'ContractCharges')!;
    expect(bb).toMatchObject({ action: 'create', blocked: null, after: { contractID: 1, contractServiceID: 33, chargeType: 1, datePurchased: '2026-10-31', unitQuantity: 2, unitPrice: 9.96, unitCost: 10.08, billingCodeID: 29683360, isBillableToCompany: true, name: 'Microsoft 365 Apps for Business [NCE] - Monthly — back-bill Sep 2026 – Oct 2026' } });
    expect(plan({ backbillPrice: 'target' }).find((x) => x.entity === 'ContractCharges')!.after).toMatchObject({ unitPrice: 10.08 });
  });

  test('billing inside the window is noted (the charge covers only the shortfall); an inactive contract blocks', () => {
    const noted = plan({ lastPostedFrom: new Map([[33, '2026-09-01']]) }).find((x) => x.entity === 'ContractCharges')!;
    expect(noted.blocked).toBeNull();
    expect(noted.reason).toMatch(/covers only the 1 missing unit/);
    expect(plan({ contracts: new Map() }).find((x) => x.entity === 'ContractCharges')!.blocked).toMatch(/not active — reactivate it first/);
  });

  test('a given back-bill price (the price in effect then); no material cost code blocks the charge', () => {
    expect(plan({ backbillPrice: 9.5 }).find((x) => x.entity === 'ContractCharges')!.after).toMatchObject({ unitPrice: 9.5 });
    expect(plan({ billingCode: () => null }).find((x) => x.entity === 'ContractCharges')!.blocked).toMatch(/material cost code/);
  });

  test('quantity alone (no price row) keeps the current price', () => {
    const q = plan({ include: ['quantity'] }).find((x) => x.entity === 'ContractServiceAdjustments')!;
    expect(q).toMatchObject({ after: { unitChange: 1, adjustedUnitPrice: 9.96 } });
  });
});

/** A fake Autotask query over unit periods and lines. */
function fakeQuery(t: { lines?: Array<Record<string, unknown>>; units: Array<Record<string, unknown>> }): QueryFn {
  return (async (entity: string, filters: Array<{ op: string; field: string; value: unknown }>) => {
    const src = entity.endsWith('Units') ? t.units : t.lines ?? [];
    return src.filter((r) => filters.every((f) => {
      const v = r[f.field];
      if (f.op === 'eq') return v === f.value;
      if (f.op === 'in') return (f.value as unknown[]).includes(v);
      if (f.op === 'lte') return String(v) <= String(f.value).slice(0, 10) + 'T99';
      if (f.op === 'gte') return String(v) >= String(f.value).slice(0, 10);
      return true;
    })) as never;
  }) as QueryFn;
}

describe('adjustments are verified by their effect (nothing on them is queryable)', () => {
  const row = { entity: 'ContractServiceAdjustments', after: { contractID: 1, contractServiceID: 10, effectiveDate: '2026-11-01', unitChange: 2, adjustedUnitPrice: 16.8 } };
  const before = [{ contractServiceID: 10, units: 4, price: 60, startDate: '2026-10-01', endDate: '2026-10-31' }];

  test('snapshot = the day before; expect = before + change; read-back = the first period from the effective date', async () => {
    const q = fakeQuery({ units: [...before, { contractServiceID: 10, units: 6, price: 100.8, startDate: '2026-11-01', endDate: '2026-11-30' }] });
    const snap = await adjustmentSnapshot(q, row);
    expect(snap).toEqual({ units: 4, unitPrice: 15, lineId: 10 });
    expect(adjustmentExpect(row, snap)).toEqual({ units: 6, unitPrice: 16.8 });
    expect(await adjustmentReadBack(q, row, snap)).toEqual({ record: { units: 6, unitPrice: 16.8 }, expect: { units: 6, unitPrice: 16.8 }, lineId: 10 });
    expect(await adjustmentAlreadyApplied(q, row, snap)).toBe(10); // a re-run sees it is done
  });

  test('not applied yet → no match; no period from the effective date yet → "not verifiable yet"', async () => {
    const q = fakeQuery({ units: [...before, { contractServiceID: 10, units: 4, price: 60, startDate: '2026-11-01', endDate: '2026-11-30' }] });
    const snap = await adjustmentSnapshot(q, row);
    expect(await adjustmentAlreadyApplied(q, row, snap)).toBeNull();
    const none = fakeQuery({ units: before });
    expect(await adjustmentReadBack(none, row, await adjustmentSnapshot(none, row))).toEqual({ unverifiable: 'line 10 has no unit period on or after 2026-11-01 yet' });
    const empty = fakeQuery({ units: [] });
    expect(await adjustmentReadBack(empty, row, null)).toEqual({ unverifiable: expect.stringMatching(/no unit period/) });
  });

  test('an adjustment ADDING a service finds its new line by contract + service', async () => {
    const add = { entity: 'ContractServiceAdjustments', after: { contractID: 1, serviceID: 231, effectiveDate: '2026-11-01', unitChange: 5, adjustedUnitPrice: 15 } };
    const q0 = fakeQuery({ lines: [], units: [] });
    expect(await adjustmentSnapshot(q0, add)).toEqual({ units: 0, unitPrice: null, lineId: null });
    const q1 = fakeQuery({ lines: [{ id: 88, contractID: 1, serviceID: 231 }], units: [{ contractServiceID: 88, units: 5, price: 75, startDate: '2026-11-01', endDate: '2026-11-30' }] });
    expect(await adjustmentReadBack(q1, add, { units: 0 })).toEqual({ record: { units: 5, unitPrice: 15 }, expect: { units: 5, unitPrice: 15 }, lineId: 88 });
  });
});

function fakePlans(rows: Array<Partial<PlanRow>>, kind = 'contract_pricing') {
  const plan: Plan = { id: 'p1', kind, title: 't', params: null, hash: 'h', status: 'open', createdBy: null, createdAt: '2026-10-11T00:00:00Z', rows: rows.map((r, i) => ({ rowNo: i + 1, action: 'create', entity: 'ContractServiceAdjustments', targetId: null, label: `row ${i + 1}`, before: null, after: null, reason: null, blocked: null, meta: null, status: 'approved', approvedBy: 'u', approvedAt: 'x', result: null, executedAt: null, ...r })) };
  return { plan, store: { setStatus: async (_: string, s: string) => { plan.status = s; }, setRowResult: async (_: string, n: number, status: string, result: Record<string, unknown>) => { const r = plan.rows.find((x) => x.rowNo === n)!; r.status = status as never; r.result = result; }, get: async () => plan } as never };
}

describe('executor', () => {
  test('a dependent row waits (nothing written) until its row is applied; an unverifiable create is applied but flagged', async () => {
    const created: Array<Record<string, unknown>> = [];
    let verifiable = false;
    const io: EntityIO = {
      get: async () => null, update: async () => undefined,
      create: async (_e, f) => { created.push(f); return 900 + created.length; },
      findExisting: async () => null, snapshot: async () => ({ units: 0 }),
      readBack: async (r) => (verifiable ? { record: { units: 5 }, expect: { units: 5 }, lineId: 88 } : r.rowNo === 1 ? { unverifiable: 'no unit period yet' } : { record: { units: 0 }, expect: { units: 0 } }),
    };
    const { plan, store } = fakePlans([{ before: { units: 0 }, after: { contractID: 1, serviceID: 231, effectiveDate: '2026-11-01', unitChange: 5 } }, { before: { units: 0 }, after: { contractServiceID: 10, unitChange: -4 }, meta: { dependsOn: [1] } }]);
    plan.rows[0]!.status = 'pending'; // row 1 not approved yet
    const r1 = await executePlan(store, plan, io);
    expect(r1).toMatchObject({ attempted: 0, waiting: 1 });
    expect(created).toHaveLength(0);
    plan.rows[0]!.status = 'approved';
    const r2 = await executePlan(store, plan, io);
    expect(r2).toMatchObject({ applied: 2, waiting: 0 });
    expect(plan.rows[0]!.result).toMatchObject({ verified: false, note: 'no unit period yet' });
    verifiable = true;
  });

  test('rowNos runs only the pilot row', async () => {
    const io: EntityIO = { get: async () => ({ unitCost: 1 }), update: async () => undefined, create: async () => 1, findExisting: async () => null };
    const { plan, store } = fakePlans([{ action: 'update', entity: 'ContractServices', targetId: 10, before: { unitCost: 1 }, after: { unitCost: 1 } }, { action: 'update', entity: 'ContractServices', targetId: 11, before: { unitCost: 1 }, after: { unitCost: 1 } }]);
    const rep = await executePlan(store, plan, io, { rowNos: [2] });
    expect(rep.rows.map((r) => r.row)).toEqual([2]);
    expect(plan.rows[0]!.status).toBe('approved');
  });
});

describe('undo plan', () => {
  const applied = (r: Partial<PlanRow>): Partial<PlanRow> => ({ status: 'applied', ...r });
  test('fields go back, a created service is deactivated, adjustments are countered and a move unwinds in the safe order', () => {
    const { plan } = fakePlans([
      applied({ action: 'update', entity: 'ContractServices', targetId: 10, before: { unitCost: 11 }, after: { unitCost: 14 } }),
      applied({ action: 'create', entity: 'Services', after: { name: 'X - MM' }, result: { id: 555 } }),
      applied({ before: { units: 0 }, after: { contractID: 1, serviceID: 231, effectiveDate: '2026-11-01', unitChange: 5, adjustedUnitPrice: 15 }, result: { id: 1, lineId: 88 } }),
      applied({ before: { units: 4, unitPrice: 16.8 }, after: { contractID: 1, contractServiceID: 10, effectiveDate: '2026-11-01', unitChange: -4 }, meta: { dependsOn: [3] } }),
      { status: 'skipped', action: 'update', entity: 'ContractServices', targetId: 12, before: { unitCost: 1 }, after: { unitCost: 2 } },
    ]);
    const { rows, skipped } = buildRevertRows(plan, { effectiveDate: '2026-12-01' });
    expect(skipped).toEqual([{ row: 5, why: expect.stringMatching(/nothing was written/) }]);
    // reversed: undo row 4 (old line back), then row 3 (new line off) which waits for it
    expect(rows[0]).toMatchObject({ entity: 'ContractServiceAdjustments', before: { units: 0 }, after: { contractServiceID: 10, effectiveDate: '2026-12-01', unitChange: 4 }, meta: expect.objectContaining({ expect: { units: 4, unitPrice: 16.8 } }) });
    expect(rows[1]).toMatchObject({ before: { units: 5, unitPrice: 15 }, after: { contractServiceID: 88, unitChange: -5 }, meta: expect.objectContaining({ dependsOn: [1], expect: { units: 0, unitPrice: null } }) });
    expect(rows[2]).toMatchObject({ action: 'deactivate', entity: 'Services', targetId: 555, after: { isActive: false } });
    expect(rows[3]).toMatchObject({ action: 'update', targetId: 10, before: { unitCost: 14 }, after: { unitCost: 11 } });
  });

  test('a revert row is verified against the state it restores', () => {
    expect(adjustmentExpect({ after: { unitChange: 4 }, meta: { expect: { units: 4, unitPrice: 16.8 } } }, { units: 0 })).toEqual({ units: 4, unitPrice: 16.8 });
  });
});

describe('drift', () => {
  test('only the latest write to a field / line must hold', async () => {
    const mk = (id: string, createdAt: string, unitCost: number): Plan => ({ id, kind: 'contract_pricing', title: '', params: null, hash: 'h', status: 'done', createdBy: null, createdAt, rows: [{ rowNo: 1, action: 'update', entity: 'ContractServices', targetId: 10, label: 'cost', before: { unitCost: 1 }, after: { unitCost }, reason: null, blocked: null, meta: null, status: 'applied', approvedBy: null, approvedAt: null, result: null, executedAt: 'x' }] });
    const r = await checkDrift([mk('new', '2026-10-02', 14), mk('old', '2026-10-01', 12)], { get: async () => ({ unitCost: 14 }), unitsOn: async () => null });
    expect(r).toEqual({ checked: 1, findings: [] });
  });
});

describe('monitor schedule', () => {
  test('off unless MCP_VENDOR_MONITOR_HOUR_UTC is a valid hour', () => {
    const logger = { info: jest.fn(), warn: jest.fn() } as never;
    expect(startVendorMonitor({} as never, () => null, logger, {})).toEqual(expect.any(Function));
    expect((logger as { info: jest.Mock }).info).not.toHaveBeenCalled();
    const stop = startVendorMonitor({} as never, () => null, logger, { MCP_VENDOR_MONITOR_HOUR_UTC: '9' });
    expect((logger as { info: jest.Mock }).info).toHaveBeenCalledWith('Vendor monitor: daily at 9:00 UTC');
    stop();
  });
});
