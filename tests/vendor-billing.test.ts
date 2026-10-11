// Vendor billing reconciliation P0: the Pax8 adapter keeps and classifies EVERY
// line, documents prove every line is accounted for, product identity is the
// manufacturer's product (not the channel), and proposals never guess.

import { pax8Adapter, pax8Classify, pax8FileMeta } from '../src/vendors/pax8';
import { cadenceMatches, offeringName, productKey, serviceCadence } from '../src/vendors/offerings';
import { detectFile, documentChecks, parseCrosswalk, proposeCatalogLinks, proposeCustomers, proposeOfferings } from '../src/vendors/service';

const HEADER = 'record_id,purchase_order_number,type,company_id,company_name,arrears_subscription_id,start_period,end_period,quantity,unit_of_measure,term,sku,description,details,rate_type,charge_type,price,subtotal,cost,cost_total,offered_by,billed_by_pax8,tax_collected_from,taxable,sales_tax,total,billing_fee,billing_fee_rate,partner_subtotal,customer_billed_less_tax,amount_due,currency_code,invoice_date,current_balance,totalDue,commitment_term,billing_renewal,for_company_id';
const row = (o: Record<string, string | number>) => {
  const d: Record<string, string | number> = { record_id: 1, type: 'subscription', company_id: 10, company_name: 'Acme', start_period: '2026-10-01', end_period: '2026-10-31', quantity: 1, unit_of_measure: 'User', term: 'Monthly', sku: 'MST-NCE-104-C100', description: 'Microsoft 365 Business Standard [New Commerce Experience]', price: 16.8, cost: 14.112, cost_total: 14.11, currency_code: 'USD', invoice_date: '2026-10-01', totalDue: 0, commitment_term: 'Monthly', ...o };
  return HEADER.split(',').map((k) => { const v = String(d[k] ?? ''); return /[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(',');
};

describe('Pax8 adapter', () => {
  test('classifies every kind of line; nothing dropped', () => {
    const cases: Array<[Record<string, string | number>, string, string]> = [
      [{}, 'recurring', 'MM'],
      [{ commitment_term: '1-Year' }, 'recurring', 'AM'],
      [{ commitment_term: '1-Year', term: 'Annual' }, 'recurring', 'AA'],
      [{ commitment_term: '', sku: 'DRP-BUP-BBU-C100', description: 'NinjaOne SaaS Backup Standard / Powered by Dropsuite' }, 'recurring', 'monthly'],
      [{ type: 'prorate', description: 'Jun Partial: SharePoint (Plan 1)' }, 'proration', 'MM'],
      [{ type: 'one-time', term: 'Arrears', commitment_term: '', description: 'Addigy MSP iOS - Arrears Charge Tier 1 - 22 Each' }, 'usage', 'none'],
      [{ type: 'one-time', term: 'One-Time', commitment_term: '', description: 'Addigy Minimum Commitment Enforcement Charge - 34 User' }, 'minimum_commitment', 'one_time'],
      [{ type: 'surcharge', term: 'One-Time', sku: '', company_name: '', description: '2.8% credit card surcharge for October invoice.' }, 'vendor_fee', 'one_time'],
      [{ cost_total: -3.2 }, 'credit', 'MM'],
      [{ description: 'SentinelOne Complete NFR', sku: 'SEN-END-NFR-A100', commitment_term: '' }, 'nfr_internal', 'monthly'],
    ];
    for (const [o, cls, cad] of cases) {
      const r = Object.fromEntries(HEADER.split(',').map((k) => [k, String(({ type: 'subscription', term: 'Monthly', commitment_term: 'Monthly', cost_total: 1, quantity: 1, ...o } as Record<string, unknown>)[k] ?? '')]));
      expect([pax8Classify(r).chargeClass, pax8Classify(r).cadence]).toEqual([cls, cad]);
    }
  });

  test('parse: invoice number from the file name, stable unique keys, fee SKU, original row kept', () => {
    const csv = [HEADER, row({}), row({}), row({ type: 'surcharge', sku: '', company_name: '', company_id: '', term: 'One-Time', commitment_term: '', description: '2.8% credit card surcharge for October invoice.', cost_total: 4.5 })].join('\n');
    const d = pax8Adapter.parse(csv, { fileName: 'csv-p886317-2026-1-1556833-2026-10-01.csv' });
    expect(d).toMatchObject({ vendor: 'pax8', vendorAccountId: '886317', invoiceNumber: '2026-1-1556833', invoiceDate: '2026-10-01' });
    expect(d.lines).toHaveLength(3);
    expect(new Set(d.lines.map((l) => l.lineKey)).size).toBe(3); // a duplicate row is kept, with its own key
    expect(d.lines[2]).toMatchObject({ chargeClass: 'vendor_fee', sku: 'PAX8-FEE-CARD-SURCHARGE' });
    expect(d.lines[0]!.raw.record_id).toBe('1');
    expect(d.lineTotal).toBe(32.72);
    expect(pax8FileMeta('x.csv')).toEqual({ account: null, invoice: null, date: null });
  });

  test('document check: each customer subtotal printed by the vendor vs the imported lines', () => {
    const ok = pax8Adapter.parse([HEADER, row({ cost_total: 10, totalDue: 15 }), row({ record_id: 2, cost_total: 5, totalDue: 15 })].join('\n'), {});
    expect(documentChecks(ok).subtotalMismatches).toEqual([]);
    const bad = pax8Adapter.parse([HEADER, row({ cost_total: 10, totalDue: 15 })].join('\n'), {});
    expect(documentChecks(bad).subtotalMismatches).toEqual([{ customer: 'Acme', lines: 10, vendorSubtotal: 15 }]);
  });

  test('detects the invoice export and the company report (crosswalk)', () => {
    expect(detectFile('csv-p1-2026-1-2-2026-10-01.csv', HEADER)?.kind).toBe('invoice');
    const xw = 'Company ID, Company Name, PSA Company ID, PSA Company Name, Connection ID, Partner ID\nabc,Fabrikam Realty Services,5001,Northwind Holdings,c,p\ndef,Woodgrove 24,5002,,c,p\n';
    expect(detectFile('6ccf.csv', xw)?.kind).toBe('crosswalk');
    expect(parseCrosswalk(xw)).toEqual([
      { vendor: 'pax8', vendorCustomerRef: 'abc', vendorCustomerName: 'Fabrikam Realty Services', autotaskCompanyId: 5001, autotaskCompanyName: 'Northwind Holdings' },
      { vendor: 'pax8', vendorCustomerRef: 'def', vendorCustomerName: 'Woodgrove 24', autotaskCompanyId: 5002, autotaskCompanyName: null },
    ]);
    expect(detectFile('random.csv', 'a,b,c')).toBeNull();
  });
});

describe('product identity (manufacturer product, not the channel)', () => {
  test('one product across term variants; the term comes from the service name', () => {
    const names: Array<[string, number, string]> = [
      ['Microsoft 365 Business Standard [NCE] Annual - Billed Monthly', 2, 'AM'],
      ['Microsoft 365 Business Standard [New Commerce Experience] - Monthly - 1YR Commit', 2, 'AM'],
      ['Microsoft 365 Business Standard [NCE] Monthly - Billed Monthly', 2, 'MM'],
      ['Microsoft 365 Apps for Business [New Commerce Experience] - Annual', 5, 'AA'],
      ['Dropsuite Business Backup - Monthly', 2, 'monthly'],
      ['Microsoft 365 Business Standard', 2, ''],
    ];
    for (const [n, p, cad] of names) expect(serviceCadence(n, p)).toBe(cad);
    expect(new Set(names.slice(0, 3).concat([names[5]!]).map(([n]) => productKey(n)))).toEqual(new Set(['microsoft 365 business standard']));
  });
  test('offering names drop the billing event and quantity', () => {
    expect(offeringName('Addigy MSP iOS - Arrears Charge Tier 1 - 22 Each')).toBe('Addigy MSP iOS');
    expect(offeringName('Jun Partial: SharePoint (Plan 1) [New Commerce Experience] quantity change')).toBe('SharePoint (Plan 1)');
    expect(offeringName('NinjaOne SaaS Backup Standard / Powered by Dropsuite')).toBe('NinjaOne SaaS Backup Standard');
  });
  test('cadence comparison: an unstated term is unknown, never assumed', () => {
    expect(cadenceMatches('AM', 'AM')).toBe('same');
    expect(cadenceMatches('MM', 'AM')).toBe('different');
    expect(cadenceMatches('MM', '')).toBe('unknown');
    expect(cadenceMatches('monthly', 'MM')).toBe('same');
  });
});

/** Minimal in-memory VendorStore for the proposal functions. */
function fakeStore(o: { lines?: any[]; crosswalk?: any[]; offerings?: any[]; customerMappings?: any[]; offeringMappings?: any[]; catalogLinks?: any[] } = {}) {
  return {
    lines: async () => o.lines ?? [], crosswalk: async () => o.crosswalk ?? [], offerings: async () => o.offerings ?? [],
    customerMappings: async () => o.customerMappings ?? [], offeringMappings: async () => o.offeringMappings ?? [], catalogLinks: async () => o.catalogLinks ?? [],
  } as never;
}
const L = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ vendorCustomerId: id, vendorCustomerName: name, sku: 'MST-NCE-104-C100', description: 'Microsoft 365 Business Standard [New Commerce Experience]', chargeClass: 'recurring', unit: 'User', ...extra });

describe('proposals never guess', () => {
  test('customers: crosswalk first (high), inactive flagged (medium), own company = internal, exact name (medium), else unmatched', async () => {
    const store = fakeStore({
      lines: [L('1', 'Fabrikam Realty Services, LLC'), L('2', 'Lakeview Summit'), L('3', 'GDS Technology'), L('4', 'Tailspin Toys'), L('5', 'GDS - Demo')],
      crosswalk: [
        { vendorCustomerName: 'Fabrikam Realty Services, LLC', autotaskCompanyId: 5001, autotaskCompanyName: 'Northwind Holdings' },
        { vendorCustomerName: 'Lakeview Summit', autotaskCompanyId: 5003, autotaskCompanyName: null },
        { vendorCustomerName: 'GDS Technology', autotaskCompanyId: 0, autotaskCompanyName: 'GDS Technology, LLC' },
      ],
    });
    const lookup = {
      byIds: async () => [{ id: 5001, companyName: 'Northwind Holdings', isActive: true }, { id: 5003, companyName: 'Lakeview Summit Parkway, LLC', isActive: false }, { id: 0, companyName: 'GDS Technology, LLC', isActive: true }],
      byNames: async () => [{ id: 5004, companyName: 'Tailspin Toys', isActive: true }],
    };
    const p = await proposeCustomers(store, lookup, 'pax8');
    const by = Object.fromEntries(p.map((x) => [x.vendorCustomerName, x]));
    expect(by['Fabrikam Realty Services, LLC']).toMatchObject({ confidence: 'high', method: 'vendor-crosswalk', proposed: { status: 'mapped', autotaskCompanyId: 5001, autotaskCompanyName: 'Northwind Holdings' } });
    expect(by['Lakeview Summit']).toMatchObject({ confidence: 'medium', proposed: { active: false } });
    expect(by['Lakeview Summit']!.why).toMatch(/INACTIVE/);
    expect(by['GDS Technology']).toMatchObject({ proposed: { status: 'internal', autotaskCompanyId: 0 } });
    expect(by['Tailspin Toys']).toMatchObject({ confidence: 'medium', method: 'exact-name', proposed: { autotaskCompanyId: 5004 } });
    expect(by['GDS - Demo']).toMatchObject({ proposed: null, confidence: 'none' });
  });

  test('offerings: fees are not billable; an existing offering is reused (high); new ones are medium', async () => {
    const store = fakeStore({
      lines: [L('1', 'A'), L('1', 'A', { sku: 'PAX8-FEE-CARD-SURCHARGE', chargeClass: 'vendor_fee', description: '2.8% credit card surcharge' }), L('1', 'A', { sku: 'MST-NCE-222-C100', chargeClass: 'proration', description: 'Jun Partial: SharePoint (Plan 1) [New Commerce Experience]' })],
      offerings: [{ id: 7, manufacturer: 'Microsoft', name: 'Microsoft 365 Business Standard' }],
    });
    const p = Object.fromEntries((await proposeOfferings(store, 'pax8')).map((x) => [x.sku, x]));
    expect(p['MST-NCE-104-C100']).toMatchObject({ confidence: 'high', proposed: { offering: { id: 7 } } });
    expect(p['PAX8-FEE-CARD-SURCHARGE']).toMatchObject({ proposed: { status: 'not_billable' } });
    expect(p['MST-NCE-222-C100']).toMatchObject({ confidence: 'medium', proposed: { offering: { id: null, manufacturer: 'Microsoft', name: 'SharePoint (Plan 1)' } } });
  });

  test('catalog: every term variant of a product links to the one offering, with its term; similar names only suggest', async () => {
    const store = fakeStore({ offerings: [{ id: 7, manufacturer: 'Microsoft', name: 'Microsoft 365 Business Standard' }, { id: 8, manufacturer: 'NinjaOne (Dropsuite)', name: 'NinjaOne SaaS Backup Standard' }] });
    const p = await proposeCatalogLinks(store, [
      { id: 196, name: 'Microsoft 365 Business Standard', periodType: 2 },
      { id: 231, name: 'Microsoft 365 Business Standard [NCE] Annual - Billed Monthly', periodType: 2 },
      { id: 200, name: 'Dropsuite Business Backup', periodType: 2 },
      { id: 999, name: 'HaaS - EDI Router', periodType: 2 },
    ]);
    const by = Object.fromEntries(p.map((x) => [x.autotaskId, x]));
    expect(by[231]).toMatchObject({ proposed: { offeringId: 7 }, cadence: 'AM', confidence: 'high' });
    expect(by[196]).toMatchObject({ proposed: { offeringId: 7 }, cadence: '', confidence: 'medium' }); // term not stated → confirm
    expect(by[200]?.proposed ?? null).toBeNull(); // Dropsuite vs NinjaOne SaaS Backup: a rename — never linked automatically (set it by hand)
    expect(by[999]).toBeUndefined();
  });
});
