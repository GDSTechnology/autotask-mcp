// Change plans + catalog standardization: rows parse; execution only writes
// approved rows, re-reads first (stale → skipped, never overwritten), verifies,
// is re-run safe, and stops on 401 / 429; the standardizer keeps one service
// per product + term, never deactivates an in-use service, never prices below
// cost, and blocks what it can't price.

import { parseRows, type Plan, type PlanRow } from '../src/change-plans/store';
import { executePlan, type EntityIO } from '../src/change-plans/execute';
import { buildStandardizePlan, standardService } from '../src/vendors/catalog-standard';

describe('row selection', () => {
  test('"all", ranges, lists; malformed is refused', () => {
    expect(parseRows('all', 4)).toEqual([1, 2, 3, 4]);
    expect(parseRows('1-3, 7, 9-10', 9)).toEqual([1, 2, 3, 7, 9]);
    expect(parseRows([2, '4', 4], 5)).toEqual([2, 4]);
    expect(parseRows('rows 1 to 3', 5)).toBeNull();
  });
});

/** In-memory PlanStore for the executor. */
function fakePlans(rows: Array<Partial<PlanRow>>) {
  const plan: Plan = { id: 'p1', kind: 'catalog_standardize', title: 't', params: null, hash: 'h', status: 'open', createdBy: null, createdAt: 'x', rows: rows.map((r, i) => ({ rowNo: i + 1, action: 'update', entity: 'Services', targetId: null, label: `row ${i + 1}`, before: null, after: null, reason: null, blocked: null, meta: null, status: 'approved', approvedBy: 'u', approvedAt: 'x', result: null, executedAt: null, ...r })) };
  return {
    plan,
    store: {
      setStatus: async (_: string, s: string) => { plan.status = s; },
      setRowResult: async (_: string, n: number, status: string, result: Record<string, unknown>) => { const r = plan.rows.find((x) => x.rowNo === n)!; r.status = status as never; r.result = result; },
      get: async () => plan,
    } as never,
  };
}
function fakeIO(records: Record<number, Record<string, unknown>>, o: { failUpdate?: string; ignoreField?: string } = {}) {
  const writes: Array<[string, number | null, Record<string, unknown>]> = [];
  let next = 1000;
  const io: EntityIO = {
    get: async (_e, id) => (records[id] ? { ...records[id] } : null),
    update: async (_e, id, f) => { if (o.failUpdate) throw new Error(o.failUpdate); writes.push(['update', id, f]); const { [o.ignoreField ?? '']: _drop, ...keep } = f; Object.assign(records[id]!, keep); },
    create: async (_e, f) => { const id = next++; records[id] = { ...f }; writes.push(['create', id, f]); return id; },
    findExisting: async (_e, f) => Number(Object.entries(records).find(([, r]) => r.name === f.name)?.[0] ?? NaN) || null,
  };
  return { io, writes, records };
}

describe('executePlan', () => {
  test('writes only approved rows, verifies by read-back, and a re-run never writes twice', async () => {
    const { plan, store } = fakePlans([
      { targetId: 1, before: { name: 'Old' }, after: { name: 'New' } },
      { targetId: 2, before: { name: 'X' }, after: { name: 'Y' }, status: 'excluded' },
      { action: 'create', after: { name: 'Fresh', unitCost: 1 } },
    ]);
    const { io, writes } = fakeIO({ 1: { name: 'Old' }, 2: { name: 'X' } });
    const rep = await executePlan(store, plan, io);
    expect(rep).toMatchObject({ attempted: 2, applied: 2, failed: 0 });
    expect(writes.map((w) => w[0])).toEqual(['update', 'create']);
    expect(plan.rows[1]!.status).toBe('excluded');
    const again = await executePlan(store, plan, io); // applied rows are not approved any more
    expect(again.attempted).toBe(0);
    expect(writes).toHaveLength(2);
  });

  test('a target changed since the plan is STALE — skipped, never overwritten; already-as-planned is skipped', async () => {
    const { plan, store } = fakePlans([
      { targetId: 1, before: { unitPrice: 10 }, after: { unitPrice: 12 } },
      { targetId: 2, before: { name: 'A' }, after: { name: 'B' } },
    ]);
    const { io, writes } = fakeIO({ 1: { unitPrice: 11 }, 2: { name: 'B' } });
    const rep = await executePlan(store, plan, io);
    expect(rep).toMatchObject({ stale: 1, skipped: 1, applied: 0 });
    expect(writes).toHaveLength(0);
    expect(plan.rows[0]!.result).toMatchObject({ changedSincePlan: ['unitPrice'] });
  });

  test('a value Autotask did not apply fails the row; a create of an existing record is skipped', async () => {
    const { plan, store } = fakePlans([
      { targetId: 1, before: { name: 'Old', description: 'd' }, after: { name: 'New', description: 'e' } },
      { action: 'create', after: { name: 'Already there' } },
    ]);
    const { io, writes } = fakeIO({ 1: { name: 'Old', description: 'd' }, 7: { name: 'Already there' } }, { ignoreField: 'description' });
    const rep = await executePlan(store, plan, io);
    expect(rep).toMatchObject({ failed: 1, skipped: 1 });
    expect(plan.rows[0]!.result).toMatchObject({ notApplied: ['description'] });
    expect(writes.filter((w) => w[0] === 'create')).toHaveLength(0);
  });

  test('an Autotask 401 / 429 stops the run', async () => {
    const { plan, store } = fakePlans([{ targetId: 1, before: { name: 'a' }, after: { name: 'b' } }, { targetId: 2, before: { name: 'c' }, after: { name: 'd' } }]);
    const { io } = fakeIO({ 1: { name: 'a' }, 2: { name: 'c' } }, { failUpdate: 'Autotask API threshold exceeded (HTTP 429)' });
    const rep = await executePlan(store, plan, io);
    expect(rep.attempted).toBe(1);
    expect(rep.stoppedBy).toMatch(/429/);
    expect(plan.rows[1]!.status).toBe('approved'); // untouched, runs next time
  });
});

describe('catalog standardization plan', () => {
  const MS = { id: 1, manufacturer: 'Microsoft', name: 'Microsoft 365 Business Standard', manufacturerProductId: null, unit: null, kind: 'recurring', notes: null };
  const NJ = { id: 2, manufacturer: 'NinjaOne (Dropsuite)', name: 'NinjaOne SaaS Backup Standard', manufacturerProductId: null, unit: null, kind: 'recurring', notes: null };
  const base = {
    vendor: 'pax8',
    offerings: [MS, NJ],
    offeringMappings: [{ vendor: 'pax8', sku: 'MST-NCE-104-C100', status: 'mapped' as const, offeringId: 1, method: 'm', confidence: 'high', note: null, decidedBy: null, decidedAt: 'x' }, { vendor: 'pax8', sku: 'DRP-BUP-BBU-C100', status: 'mapped' as const, offeringId: 2, method: 'm', confidence: 'high', note: null, decidedBy: null, decidedAt: 'x' }],
    soldSkus: new Map([['MST-NCE-104-C100', { cadences: new Set(['MM']), chargeClasses: new Set(['recurring']) }], ['DRP-BUP-BBU-C100', { cadences: new Set(['monthly']), chargeClasses: new Set(['recurring']) }]]),
    links: [{ autotaskEntity: 'Services', autotaskId: 200, offeringId: 2, cadence: 'monthly', method: 'manual', confidence: 'confirmed', note: null, decidedBy: null, decidedAt: 'x' }, { autotaskEntity: 'Services', autotaskId: 259, offeringId: 2, cadence: 'monthly', method: 'manual', confidence: 'confirmed', note: null, decidedBy: null, decidedAt: 'x' }],
    services: [
      { id: 297, name: 'Microsoft 365 Business Standard [NCE] Monthly - Billed Monthly', periodType: 2, unitCost: 13.2, unitPrice: 15, billingCodeID: 9, isActive: true },
      { id: 231, name: 'Microsoft 365 Business Standard [NCE] Annual - Billed Monthly', periodType: 2, unitCost: 11, unitPrice: 12.5, billingCodeID: 9, isActive: true },
      { id: 241, name: 'Microsoft 365 Business Standard [New Commerce Experience] - Monthly - 1YR Commit', periodType: 2, billingCodeID: 9, isActive: true },
      { id: 331, name: 'Microsoft 365 Business Standard - Monthly - 1YR Commit', periodType: 2, billingCodeID: 9, isActive: true },
      { id: 200, name: 'Dropsuite Business Backup', periodType: 2, billingCodeID: 4, isActive: true },
      { id: 259, name: 'Dropsuite Business Backup - Monthly', periodType: 2, billingCodeID: 4, isActive: true },
    ],
    activeUses: new Map([[297, 3], [331, 2], [259, 2]]),
    prices: [
      { vendor: 'pax8', sku: 'MST-NCE-104-C100', cadence: 'MM', unitCost: 14.112, suggestedPrice: 16.8, per: 'month' as const, source: 'invoice:1', effectiveDate: '2026-10-01' },
      { vendor: 'pax8', sku: 'MST-NCE-104-C100', cadence: 'AA', unitCost: 140, suggestedPrice: 130, per: 'year' as const, source: 'price_list', effectiveDate: '2026-10-01' },
    ],
  };

  test('one service per product + term: keep the most-used, rename it, deactivate only UNUSED duplicates', () => {
    const r = buildStandardizePlan(base);
    const labels = r.rows.map((x) => `${x.action}:${x.targetId ?? x.after?.name}:${x.blocked ? 'BLOCKED' : ''}`);
    // AM group: 331 (2 uses) is the keeper, not 231; 231 and 241 are unused → deactivated
    expect(r.rows.find((x) => x.action === 'update' && x.targetId === 331)?.after).toMatchObject({ name: 'Microsoft 365 Business Standard [NCE] - AM', invoiceDescription: 'Microsoft 365 Business Standard — Annual commitment, billed monthly' });
    expect(labels).toEqual(expect.arrayContaining(['deactivate:231:', 'deactivate:241:']));
    expect(r.rows.find((x) => x.targetId === 297 && x.action === 'update' && x.after?.name)?.after?.name).toBe('Microsoft 365 Business Standard [NCE] - MM');
    // the Dropsuite services are the NinjaOne product (decided links) — renamed, the unused one deactivated
    expect(r.rows.find((x) => x.targetId === 259 && x.after?.name)?.after?.name).toBe('NinjaOne SaaS Backup Standard - Monthly');
    expect(labels).toContain('deactivate:200:');
  });

  test('a duplicate in use is listed, never deactivated', () => {
    const r = buildStandardizePlan({ ...base, activeUses: new Map([[297, 3], [331, 2], [231, 1], [259, 2]]) });
    const row = r.rows.find((x) => x.targetId === 231)!;
    expect(row).toMatchObject({ action: 'info', blocked: 'in use by active contracts' });
  });

  test('missing terms are created from the vendor price — blocked without one, and never priced below cost', () => {
    const r = buildStandardizePlan(base);
    const aa = r.rows.find((x) => x.action === 'create' && String(x.after?.name).endsWith('- AA'))!;
    expect(aa.blocked).toMatch(/BELOW its cost/); // suggested 130 < cost 140
    // bought on AA but no price → blocked create
    const boughtAA = new Map([...base.soldSkus, ['MST-NCE-104-C100', { cadences: new Set(['MM', 'AA']), chargeClasses: new Set(['recurring']) }]]);
    const noPrice = buildStandardizePlan({ ...base, soldSkus: boughtAA, prices: base.prices.slice(0, 1) }).rows.find((x) => x.action === 'create' && String(x.after?.name).endsWith('- AA'))!;
    expect(noPrice.blocked).toMatch(/no pax8 price for AA/);
    expect(noPrice.after).toMatchObject({ periodType: 5, billingCodeID: 9 }); // yearly period; sibling's work type
  });

  test('a term nobody buys, with no service and no price, is skipped — not a blocked create', () => {
    const r = buildStandardizePlan({ ...base, prices: base.prices.slice(0, 1) });
    expect(r.rows.find((x) => x.action === 'create' && String(x.after?.name).endsWith('- AA'))).toBeUndefined();
    expect(r.summary.skippedTerms).toBe(1);
  });

  test('a product with no service of its own borrows the work type across "NinjaOne (Dropsuite)" / "NinjaOne"', () => {
    const NEW = { id: 3, manufacturer: 'NinjaOne', name: 'NinjaOne SaaS Backup + Archiver', manufacturerProductId: null, unit: null, kind: 'recurring', notes: null };
    const r = buildStandardizePlan({ ...base, offerings: [MS, NJ, NEW], offeringMappings: [...base.offeringMappings, { vendor: 'pax8', sku: 'DRP-ARC-BAR-C100', status: 'mapped' as const, offeringId: 3, method: 'm', confidence: 'high', note: null, decidedBy: null, decidedAt: 'x' }],
      soldSkus: new Map([...base.soldSkus, ['DRP-ARC-BAR-C100', { cadences: new Set(['monthly']), chargeClasses: new Set(['recurring']) }]]),
      prices: [...base.prices, { vendor: 'pax8', sku: 'DRP-ARC-BAR-C100', cadence: 'monthly', unitCost: 4.2, suggestedPrice: 6, per: 'month' as const, source: 'invoice:1', effectiveDate: '2026-10-01' }] });
    const c = r.rows.find((x) => x.action === 'create' && x.after?.name === 'NinjaOne SaaS Backup + Archiver - Monthly')!;
    expect(c).toMatchObject({ blocked: null, after: { billingCodeID: 4 } });
  });

  test('catalog price rows are reference-only and use the term price', () => {
    const r = buildStandardizePlan(base);
    const p = r.rows.find((x) => x.targetId === 297 && x.after?.unitCost !== undefined)!;
    expect(p.after).toEqual({ unitCost: 14.112, unitPrice: 16.8 });
    expect(p.reason).toMatch(/customer contract prices are NOT changed/);
  });

  test('naming standard', () => {
    expect(standardService(MS, 'AA', true)).toEqual({ name: 'Microsoft 365 Business Standard [NCE] - AA', description: 'Microsoft 365 Business Standard (New Commerce Experience). Annual commitment, billed annually.', invoiceDescription: 'Microsoft 365 Business Standard — Annual commitment, billed annually', manufacturerServiceProvider: 'Microsoft' });
    expect(standardService(NJ, 'monthly', false).name).toBe('NinjaOne SaaS Backup Standard - Monthly');
    expect(standardService(NJ, 'monthly', false).description).toBe('NinjaOne SaaS Backup Standard. Month to month, billed monthly.'); // "NinjaOne (Dropsuite)" not repeated
    expect(standardService({ manufacturer: 'Addigy', name: 'MSP iOS' }, 'monthly', false).description).toBe('Addigy MSP iOS. Month to month, billed monthly.');
  });
});
