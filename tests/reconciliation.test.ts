// Reconciliation P0b/P0c: matching on the product across ALL of a customer's
// contracts (no cross-matching), exceptions by severity, confirmed vs potential
// loss, policy + negotiated prices, contract change plans (adjustments, never
// automatic), sync drift, the workbook's required columns, and the Pax8 API
// mapping into the same parser.

import ExcelJS from 'exceljs';
import { reconcile, type ReconInput } from '../src/vendors/reconcile';
import { priceShouldBe, policyFor, landedCost, DEFAULT_POLICY } from '../src/vendors/policy';
import { buildContractPlan, rebaseToEffectiveDate } from '../src/vendors/contract-plan';
import { checkDrift } from '../src/vendors/drift';
import { buildWorkbook, REQUIRED_COLUMNS } from '../src/vendors/workbook';
import { pax8ItemToCsvRow, pax8PricingCadence } from '../src/vendors/pax8-api';
import { pax8RowsToDocument } from '../src/vendors/pax8';
import type { VendorLine } from '../src/vendors/types';

const line = (o: Partial<VendorLine>): VendorLine => ({ vendor: 'pax8', vendorAccountId: null, lineKey: Math.random().toString(36), vendorCustomerId: '1', vendorCustomerName: 'Contoso Office Centers', subscriptionId: 's1', sku: 'MST-NCE-104-C100', description: 'Microsoft 365 Business Standard', chargeClass: 'recurring', cadence: 'MM', billingTerm: 'Monthly', commitmentTerm: 'Monthly', unit: 'User', quantity: 4, unitCost: 14.112, costTotal: 56.45, vendorSuggestedUnitPrice: 16.8, periodStart: '2026-10-01', periodEnd: '2026-10-31', renewalDate: null, currency: 'USD', tax: 0, fees: 0, flags: [], raw: {}, ...o });
const map = (sku: string, offeringId: number) => ({ vendor: 'pax8', sku, status: 'mapped' as const, offeringId, method: 'm', confidence: 'confirmed', note: null, decidedBy: null, decidedAt: 'x' });
const link = (sid: number, offeringId: number, cadence: string) => ({ autotaskEntity: 'Services', autotaskId: sid, offeringId, cadence, method: 'manual', confidence: 'confirmed', note: null, decidedBy: null, decidedAt: 'x' });

function input(o: Partial<ReconInput> = {}): ReconInput {
  return {
    vendor: 'pax8', invoice: { documentId: 9, invoiceNumber: '2026-1-1556833', invoiceDate: '2026-10-01', periodStart: '2026-10-01', periodEnd: '2026-10-31' },
    lines: [line({})],
    customerMappings: [{ vendor: 'pax8', vendorCustomerId: '1', vendorCustomerName: 'CEO', status: 'mapped', autotaskCompanyId: 100, method: 'vendor-crosswalk', confidence: 'high', note: null, decidedBy: null, decidedAt: 'x' }],
    offeringMappings: [map('MST-NCE-104-C100', 7), map('DRP-BUP-BBU-C100', 8)],
    offerings: [{ id: 7, manufacturer: 'Microsoft', name: 'Microsoft 365 Business Standard', manufacturerProductId: null, unit: null, kind: 'recurring', notes: null }, { id: 8, manufacturer: 'NinjaOne (Dropsuite)', name: 'NinjaOne SaaS Backup Standard', manufacturerProductId: null, unit: null, kind: 'recurring', notes: null }],
    links: [link(297, 7, 'MM'), link(259, 8, 'monthly')],
    services: [{ id: 297, name: 'Microsoft 365 Business Standard [NCE] - MM', periodType: 2, unitCost: 13.2, unitPrice: 15 }, { id: 259, name: 'NinjaOne SaaS Backup Standard - Monthly', periodType: 2, unitCost: 2.1, unitPrice: 3 }],
    companies: [{ id: 100, companyName: 'Contoso Office Centers', isActive: true }],
    contracts: [{ id: 1, companyID: 100, contractName: '2026-28 - MSA - Licenses', status: 1, startDate: '2026-08-01', endDate: '2028-07-31' }, { id: 2, companyID: 100, contractName: 'PBX - Server - Backup - 2026', status: 1, startDate: '2026-01-01', endDate: '2026-12-31' }, { id: 3, companyID: 200, contractName: 'Other customer', status: 1, startDate: null, endDate: null }],
    contractServices: [{ id: 3482, contractID: 1, serviceID: 297, unitCost: 11, unitPrice: 12.5 }, { id: 9999, contractID: 3, serviceID: 297, unitCost: 14, unitPrice: 20 }],
    units: [{ contractServiceID: 3482, units: 4, price: 50, cost: 44, startDate: '2026-10-01', endDate: '2026-10-31' }],
    billed: [{ contractServiceID: 3482, quantity: 4, rate: 12.5, extendedPrice: 50, ourCost: 44, invoiceID: 43122, itemDate: '2026-10-01', posted: true }],
    policies: [], customerExceptions: [],
    ...o,
  };
}

describe('reconcile', () => {
  test('billed below landed cost on a POSTED invoice → critical, confirmed; another customer’s contract never matches', () => {
    const { rows, summary } = reconcile(input());
    const r = rows[0]!;
    expect(rows).toHaveLength(1); // contract service 9999 belongs to company 200 — not cross-matched
    expect(r).toMatchObject({ severity: 'critical', customerName: 'Contoso Office Centers', autotaskContract: '2026-28 - MSA - Licenses', contractServiceId: 3482, quantity: 4, contractQuantity: 4, currentPrice: 12.5, currentCost: 11, costShouldBe: 14.112, priceShouldBe: 16.8, billingPosted: true, confidence: 'verified' });
    expect(r.exceptions).toEqual(expect.arrayContaining(['below_cost', 'cost_stale']));
    expect(r.monthlyExposure).toBeCloseTo((14.112 - 12.5) * 4, 2);
    expect(r.differenceOnPrice).toBeCloseTo(4.3, 4);
    expect(summary).toMatchObject({ critical: 1, belowCostConfirmed: 1 });
  });

  test('not billed anywhere → critical with the vendor cost as exposure; without a posted invoice a loss is only "unverified"', () => {
    const nb = reconcile(input({ lines: [line({ sku: 'DRP-BUP-BBU-C100', description: 'NinjaOne SaaS Backup Standard', cadence: 'monthly', commitmentTerm: null, quantity: 5, unitCost: 2.1, costTotal: 10.5, vendorSuggestedUnitPrice: 3 })] })).rows[0]!;
    expect(nb).toMatchObject({ severity: 'critical', exceptions: ['not_billed'], monthlyExposure: 10.5 });
    const unposted = reconcile(input({ billed: [] })).rows[0]!;
    expect(unposted.confidence).toBe('unverified');
    expect(unposted.reason).toMatch(/not yet confirmed by a posted invoice/);
  });

  test('not billed, but an unlinked look-alike line is on a contract in effect → review "link it", not critical', () => {
    const r = reconcile(input({ links: [link(259, 8, 'monthly')] , services: [{ id: 297, name: 'MS 365 Business Standard (legacy)', periodType: 2, unitCost: 13.2, unitPrice: 15 }] })).rows[0]!;
    expect(r).toMatchObject({ severity: 'review', confidence: 'unverified', proposedAction: 'link the service, then re-run' });
    expect(r.exceptions).toEqual(['not_billed', 'unlinked_service']);
    expect(r.reason).toMatch(/"MS 365 Business Standard \(legacy\)" on 2026-28 - MSA - Licenses is not linked/);
    // sharing only "Microsoft 365 … for" is not a look-alike (Copilot is not Business Standard)
    const other = reconcile(input({ links: [link(259, 8, 'monthly')], services: [{ id: 297, name: 'Microsoft Copilot for Microsoft 365 [NCE] - Annual', periodType: 5, unitCost: 30, unitPrice: 36 }] })).rows[0]!;
    expect(other).toMatchObject({ severity: 'critical', exceptions: ['not_billed'] });
  });

  test('a back-bill charge covering the month turns "not billed" / "quantity short" into info', () => {
    const charges = [{ id: 501, contractID: 1, contractServiceID: null, name: 'Microsoft 365 Business Standard [NCE] - MM — back-bill Sep 2026 – Oct 2026', unitQuantity: 8, unitPrice: 15, isBilled: false }];
    const nb = reconcile(input({ contractServices: [], units: [], billed: [], charges })).rows[0]!;
    expect(nb).toMatchObject({ severity: 'info', monthlyExposure: 0, proposedAction: 'none — back-billed; make sure the charge is posted' });
    expect(nb.exceptions).toEqual(expect.arrayContaining(['not_billed', 'backbilled']));
    expect(nb.reason).toMatch(/back-bill charge 501 .*not invoiced yet/);
    // a window that ends before the month doesn't cover it; another company's contract never does
    expect(reconcile(input({ contractServices: [], units: [], billed: [], charges: [{ ...charges[0]!, name: 'Microsoft 365 Business Standard — back-bill September 2026' }] })).rows[0]!.severity).toBe('critical');
    expect(reconcile(input({ contractServices: [], units: [], billed: [], charges: [{ ...charges[0]!, contractID: 3 }] })).rows[0]!.severity).toBe('critical');
  });

  test('quantity short, term mismatch, billed on several lines', () => {
    const r = reconcile(input({
      lines: [line({ quantity: 6, costTotal: 84.67, cadence: 'AM', commitmentTerm: '1-Year', unitCost: 11.03 })],
      links: [link(297, 7, 'MM'), link(231, 7, 'AM')],
      services: [{ id: 297, name: 'M365 BS [NCE] - MM', periodType: 2, unitCost: 13.2, unitPrice: 15 }, { id: 231, name: 'M365 BS [NCE] - AM', periodType: 2, unitCost: 11, unitPrice: 12.5 }],
      contractServices: [{ id: 3482, contractID: 1, serviceID: 297, unitCost: 13.2, unitPrice: 15 }, { id: 4000, contractID: 2, serviceID: 231, unitCost: 11.03, unitPrice: 12.5 }],
      units: [{ contractServiceID: 3482, units: 2, price: 30, cost: 26.4, startDate: '2026-10-01', endDate: '2026-10-31' }, { contractServiceID: 4000, units: 2, price: 25, cost: 22.06, startDate: '2026-10-01', endDate: '2026-10-31' }],
      billed: [],
    })).rows;
    const primary = r.find((x) => x.contractServiceId === 4000)!; // same term (AM) wins
    const other = r.find((x) => x.contractServiceId === 3482)!;
    expect(primary.exceptions).toContain('qty_short');
    expect(primary.reason).toMatch(/vendor bills 6 but the contract line\(s\) bill 4/);
    expect(other.exceptions).toEqual(expect.arrayContaining(['billed_on_multiple_lines', 'term_mismatch']));
  });

  test('internal / fees / prorations / unmapped are classified, never claimed as losses', () => {
    const rows = reconcile(input({
      lines: [line({ chargeClass: 'vendor_fee', sku: 'PAX8-FEE-CARD-SURCHARGE', vendorCustomerId: null }), line({ chargeClass: 'proration', description: 'Jun Partial: M365' }), line({ vendorCustomerId: '2', vendorCustomerName: 'Unknown Co' }), line({ sku: 'NEW-SKU' })],
      offeringMappings: [map('MST-NCE-104-C100', 7), { ...map('PAX8-FEE-CARD-SURCHARGE', 0), status: 'not_billable', offeringId: null }],
    })).rows;
    const t = rows.map((r) => [r.severity, r.exceptions[0]]);
    expect(t).toEqual(expect.arrayContaining([['info', 'not_customer_billable'], ['review', 'proration_credit'], ['review', 'unmapped_customer'], ['review', 'unmapped_sku']]));
    expect(rows.filter((r) => r.severity === 'info' || r.exceptions[0]?.startsWith('unmapped')).every((r) => !r.monthlyExposure)).toBe(true);
  });

  test('a negotiated price is the target — not flagged as below target', () => {
    const r = reconcile(input({ billed: [{ contractServiceID: 3482, quantity: 4, rate: 15, extendedPrice: 60, ourCost: 56, invoiceID: 1, itemDate: '2026-10-01', posted: true }], units: [{ contractServiceID: 3482, units: 4, price: 60, cost: 56.45, startDate: '2026-10-01', endDate: '2026-10-31' }], contractServices: [{ id: 3482, contractID: 1, serviceID: 297, unitCost: 14.112, unitPrice: 15 }], customerExceptions: [{ autotaskCompanyId: 100, offeringId: 7, cadence: '', agreedUnitPrice: 15, reason: '2026 MSA rate', expiresOn: null, decidedBy: 'jf' }] })).rows[0]!;
    expect(r.priceShouldBe).toBe(15);
    expect(r.exceptions).not.toContain('below_target');
    expect(r.severity).toBe('ok');
  });
});

describe('pricing policy', () => {
  test('vendor suggested (never below cost), margin, markup, floor, fee allocation, scope precedence', () => {
    expect(priceShouldBe(10, 12, DEFAULT_POLICY, null)).toEqual({ price: 12, rule: 'vendor suggested (*)' });
    expect(priceShouldBe(10.08, 9.96, DEFAULT_POLICY, null).price).toBe(10.08);
    expect(priceShouldBe(10, 12, { ...DEFAULT_POLICY, mode: 'margin', pct: 0.2 }, null).price).toBe(12.5);
    expect(priceShouldBe(10, 12, { ...DEFAULT_POLICY, mode: 'markup', pct: 0.3 }, null).price).toBe(13);
    expect(priceShouldBe(10, 10.5, { ...DEFAULT_POLICY, marginFloor: 0.2 }, null).price).toBe(12.5);
    // retail + a small uplift; when retail is below cost the margin floor (on cost) wins
    expect(priceShouldBe(10, 12, { ...DEFAULT_POLICY, pct: 0.05, marginFloor: 0.1 }, null)).toEqual({ price: 12.6, rule: 'vendor suggested + 5% (*)' });
    expect(priceShouldBe(10.08, 9.96, { ...DEFAULT_POLICY, pct: 0.05, marginFloor: 0.1 }, null)).toEqual({ price: 11.2, rule: 'vendor suggested + 5% (*) → raised to the 10% margin floor' });
    expect(landedCost(10, 0.028, { ...DEFAULT_POLICY, feePolicy: 'allocate' })).toBe(10.28);
    const ps = [{ ...DEFAULT_POLICY, scope: '*' }, { ...DEFAULT_POLICY, scope: 'Microsoft', mode: 'margin' as const, pct: 0.15 }, { ...DEFAULT_POLICY, scope: 'offering:7', mode: 'markup' as const, pct: 0.1 }];
    expect(policyFor(ps, 7, 'Microsoft').scope).toBe('offering:7');
    expect(policyFor(ps, 8, 'Microsoft').scope).toBe('Microsoft');
    expect(policyFor(ps, 9, 'Addigy').scope).toBe('*');
  });
});

describe('contract change plan', () => {
  const rows = reconcile(input()).rows;
  const base = { rows, include: ['cost', 'price', 'quantity', 'missing_line'] as const, effectiveDate: '2026-11-01', contracts: new Map([[1, { contractName: '2026-28 - MSA - Licenses', companyID: 100, startDate: '2026-08-01', endDate: '2028-07-31' }]]), lastPostedThrough: new Map<number, string>(), licenceContracts: new Map<number, number[]>(), standardService: () => 297 };

  test('units are re-based to the day before the effective date: a seat added since is not added again; a 0-unit line gets no price row', () => {
    // October: the vendor bills 1, the line has no units (it starts in November) → quantity short.
    const r = reconcile(input({ lines: [line({ quantity: 1, costTotal: 14.112 })], units: [], billed: [] })).rows;
    expect(r[0]!.exceptions).toContain('qty_short');
    const short = buildContractPlan({ ...base, include: [...base.include], rows: r, effectiveDate: '2026-12-01' });
    expect(short.rows.some((x) => /QUANTITY/.test(x.label))).toBe(true);
    // …but the line already has 1 unit from November: nothing to add in December.
    const now = rebaseToEffectiveDate(r, new Map([[3482, { units: 1 }]]));
    expect(now[0]).toMatchObject({ contractQuantity: 1, contractQuantityTotal: 1 });
    const p = buildContractPlan({ ...base, include: [...base.include], rows: now, effectiveDate: '2026-12-01' });
    expect(p.rows.some((x) => /QUANTITY/.test(x.label))).toBe(false);
    // a line with 0 units on the effective date: a price change on it changes no invoice
    const zero = rebaseToEffectiveDate(reconcile(input()).rows, new Map());
    expect(buildContractPlan({ ...base, rows: zero, include: ['price'] }).rows.filter((x) => x.entity === 'ContractServiceAdjustments')).toEqual([]);
  });

  test('cost and price are separate rows; price is a ContractServiceAdjustment effective next month', () => {
    const p = buildContractPlan({ ...base, include: [...base.include] });
    const cost = p.rows.find((r) => r.entity === 'ContractServices')!;
    const price = p.rows.find((r) => r.entity === 'ContractServiceAdjustments')!;
    expect(cost).toMatchObject({ action: 'update', targetId: 3482, before: { unitCost: 11 }, after: { unitCost: 14.112 } });
    expect(price).toMatchObject({ action: 'create', blocked: null, before: { unitPrice: 12.5, units: 4 }, after: { contractID: 1, contractServiceID: 3482, effectiveDate: '2026-11-01', unitChange: 0, adjustedUnitPrice: 16.8 } });
    expect(price.label).toMatch(/customer price increase/);
    // the customer-notice list and the execution gate read these
    expect(cost.meta).toMatchObject({ kind: 'cost', companyId: 100 });
    expect(price.meta).toMatchObject({ kind: 'price', companyId: 100, customer: 'Contoso Office Centers', per: 'month' });
  });

  test('blocked: already invoiced, outside the contract; a negotiated price is moved TO, never blocked', () => {
    expect(buildContractPlan({ ...base, include: ['price'], lastPostedThrough: new Map([[3482, '2026-11-01T00:00:00Z']]) }).rows[0]!.blocked).toMatch(/already invoiced/);
    expect(buildContractPlan({ ...base, include: ['price'], effectiveDate: '2028-09-01' }).rows[0]!.blocked).toMatch(/after the contract ends/);
    const neg = rows.map((r) => ({ ...r, exceptions: [...r.exceptions, 'negotiated'] }));
    const n = buildContractPlan({ ...base, rows: neg, include: ['price'] }).rows[0]!;
    expect(n.blocked).toBeNull();
    expect(n.label).toMatch(/to the negotiated price/);
  });

  test('a yearly service is written in per-year amounts', () => {
    const y = rows.map((r) => ({ ...r, serviceBasis: 'year' as const }));
    const price = buildContractPlan({ ...base, rows: y, include: ['price'] }).rows[0]!;
    expect(price.after).toMatchObject({ adjustedUnitPrice: 201.6 }); // 16.8 × 12
  });

  test('a missing line needs a single licence contract (or a choice)', () => {
    const nb = reconcile(input({ lines: [line({ sku: 'DRP-BUP-BBU-C100', cadence: 'monthly', quantity: 5 })], contractServices: [] })).rows;
    const two = buildContractPlan({ ...base, rows: nb, include: ['missing_line'], licenceContracts: new Map([[100, [1, 2]]]) }).rows[0]!;
    expect(two.blocked).toMatch(/2 licence contracts/);
    const one = buildContractPlan({ ...base, rows: nb, include: ['missing_line'], licenceContracts: new Map([[100, [1]]]) }).rows[0]!;
    // One row: an adjustment that ADDS the service to the contract with its units and price.
    expect(one).toMatchObject({ entity: 'ContractServiceAdjustments', action: 'create', blocked: null, before: { units: 0 }, after: { contractID: 1, serviceID: 297, effectiveDate: '2026-11-01', unitChange: 5 } });
    expect(one.after).not.toHaveProperty('contractServiceID');
  });
});

describe('sync drift', () => {
  test('an approved value that no longer holds is a finding; an adjustment is checked by its effect', async () => {
    const plan = { id: 'p', kind: 'contract_pricing', title: '', params: null, hash: 'h', status: 'done', createdBy: null, createdAt: 'x', rows: [
      { rowNo: 1, action: 'update' as const, entity: 'ContractServices', targetId: 3482, label: 'cost', before: { unitCost: 11 }, after: { unitCost: 14.112 }, reason: null, blocked: null, meta: null, status: 'applied' as const, approvedBy: null, approvedAt: null, result: null, executedAt: 'x' },
      { rowNo: 2, action: 'create' as const, entity: 'ContractServiceAdjustments', targetId: null, label: 'price', before: { unitPrice: 12.5, units: 4 }, after: { contractServiceID: 3482, effectiveDate: '2026-11-01', unitChange: 0, adjustedUnitPrice: 16.8 }, reason: null, blocked: null, meta: null, status: 'applied' as const, approvedBy: null, approvedAt: null, result: { id: 5 }, executedAt: 'x' },
    ] };
    const r = await checkDrift([plan], { get: async () => ({ unitCost: 11 }), unitsOn: async () => ({ units: 4, unitPrice: 12.5 }) }, '2026-11-15');
    expect(r.findings.map((f) => [f.row, f.field, f.approved, f.current])).toEqual([[1, 'unitCost', 14.112, 11], [2, 'unitPrice', 16.8, 12.5]]);
    const ok = await checkDrift([plan], { get: async () => ({ unitCost: 14.112 }), unitsOn: async () => ({ units: 4, unitPrice: 16.8 }) }, '2026-11-15');
    expect(ok.findings).toEqual([]);
  });
});

describe('workbook', () => {
  test('the required columns come first, in order, on every row sheet; formulas are neutralised', async () => {
    const { rows, summary } = reconcile(input({ lines: [line({ vendorCustomerName: '=HYPERLINK("x")' }), line({ sku: 'DRP-BUP-BBU-C100', cadence: 'monthly', quantity: 5 })] }));
    const buf = await buildWorkbook({ run: { id: 'r', vendor: 'pax8', documentId: 9, invoiceNumber: 'I', periodStart: '2026-10-01', periodEnd: '2026-10-31', summary, createdBy: 'jf', createdAt: 'x' }, rows, states: new Map(), lines: [line({ description: '=cmd' })], policies: [], customerExceptions: [], plans: [] });
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf as never);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Executive Summary', 'Exceptions', 'All Vendor Lines', 'Customer Contracts', 'Unmatched Internal NFR', 'Approved Changes', 'Execution Audit', 'Pricing Policy']);
    const hdr = (wb.getWorksheet('Exceptions')!.getRow(1).values as unknown[]).slice(1, 14);
    expect(hdr).toEqual(REQUIRED_COLUMNS.map(([h]) => h));
    expect(wb.getWorksheet('All Vendor Lines')!.getRow(2).getCell(6).value).toBe("'=cmd");
  });
});

describe('Pax8 API → the same parser as the CSV', () => {
  test('an API invoice item becomes a CSV-shaped row and parses identically', () => {
    const row = pax8ItemToCsvRow({ id: 1, subscriptionId: 'S1', type: 'Subscription', companyId: 10, companyName: 'Acme', startPeriod: '2026-10-01T00:00:00Z', endPeriod: '2026-10-31', quantity: 4, unitOfMeasure: 'User', term: 'Monthly', sku: 'MST-NCE-104-C100', description: 'Microsoft 365 Business Standard', price: 16.8, cost: 14.112, costTotal: 56.45, commitmentTerm: '1-Year' }, { invoiceDate: '2026-10-01', currencyCode: 'USD' });
    const doc = pax8RowsToDocument([row], { account: '886317', invoiceNumber: '2026-1-1556833', invoiceDate: '2026-10-01' });
    expect(doc.lines[0]).toMatchObject({ subscriptionId: 'S1', chargeClass: 'recurring', cadence: 'AM', quantity: 4, unitCost: 14.112, costTotal: 56.45, periodStart: '2026-10-01' });
  });
  test('pricing terms → cadence', () => {
    expect(pax8PricingCadence({ billingTerm: 'Monthly', commitmentTermInMonths: 12 })).toBe('AM');
    expect(pax8PricingCadence({ billingTerm: 'Annual', commitmentTerm: '1 Year' })).toBe('AA');
    expect(pax8PricingCadence({ billingTerm: 'Monthly', commitmentTerm: 'Monthly' })).toBe('MM');
    expect(pax8PricingCadence({ billingTerm: 'Monthly' })).toBe('monthly');
  });
});
