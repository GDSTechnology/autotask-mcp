// The monthly billing process around the reconciliation: customer notices
// (who is told about a contract plan's invoice changes; customer-facing rows
// wait for it), the pre-invoice check (double billing from a back-bill next to
// a line that already bills those months, duplicate lines, pending charges,
// changes without a notice), exception outcomes (overdue), and capability gaps.

import { buildNotices, needsNotice, noticeLine, noticesCsv, rowsAwaitingNotice, type NoticeRecord } from '../src/vendors/notices';
import { analyzePreinvoice, type PreinvoiceInput } from '../src/vendors/preinvoice';
import { isOverdue } from '../src/vendors/recon-tools';
import { gapKey } from '../src/gaps/store';
import { gapToolHandlers } from '../src/gaps/tools';
import type { Plan, PlanRow } from '../src/change-plans/store';

const row = (n: number, o: Partial<PlanRow>): PlanRow => ({ rowNo: n, action: 'create', entity: 'ContractServiceAdjustments', targetId: null, label: `row ${n}`, before: null, after: null, reason: null, blocked: null, meta: null, status: 'pending', approvedBy: null, approvedAt: null, result: null, executedAt: null, ...o });
const meta = (companyId: number, kind: string, extra: Record<string, unknown> = {}) => ({ kind, companyId, customer: `Customer ${companyId}`, contract: 'Licenses', product: 'Microsoft 365 Business Standard', per: 'month', ...extra });
const plan = (rows: PlanRow[]): Plan => ({ id: 'plan-1', kind: 'contract_pricing', title: 't', params: null, hash: 'h', status: 'open', createdBy: null, createdAt: '2026-10-17T00:00:00Z', rows });

describe('customer notices', () => {
  const rows = [
    row(1, { meta: meta(100, 'cost'), action: 'update', entity: 'ContractServices', before: { unitCost: 11 }, after: { unitCost: 14.11 } }),
    row(2, { meta: meta(100, 'price'), before: { units: 4, unitPrice: 12.5 }, after: { effectiveDate: '2026-12-01', unitChange: 0, adjustedUnitPrice: 17.64 } }),
    row(3, { meta: meta(100, 'missing_line', { product: 'Exchange Online (Plan 2)' }), before: { units: 0 }, after: { effectiveDate: '2026-12-01', unitChange: 1, adjustedUnitPrice: 10.08 } }),
    row(4, { meta: meta(200, 'backbill'), entity: 'ContractCharges', after: { datePurchased: '2026-11-30', unitQuantity: 2, unitPrice: 9.96 } }),
    row(5, { meta: meta(200, 'quantity'), before: { units: 6, unitPrice: 11.2 }, after: { effectiveDate: '2026-12-01', unitChange: -1 } }),
    row(6, { meta: meta(300, 'price', { per: 'year' }), before: { units: 1, unitPrice: 99.6 }, after: { effectiveDate: '2026-12-01', unitChange: 0, adjustedUnitPrice: 112 } }),
    row(7, { meta: meta(400, 'price'), status: 'excluded', before: { units: 1, unitPrice: 5 }, after: { effectiveDate: '2026-12-01', unitChange: 0, adjustedUnitPrice: 6 } }),
  ];

  test('per customer: old → new, monthly and one-time change; cost rows and excluded rows are left out; a yearly line is shown per month', () => {
    const list = buildNotices(plan(rows), []);
    const by = Object.fromEntries(list.map((c) => [c.companyId, c]));
    expect(Object.keys(by).sort()).toEqual(['100', '200', '300']);
    expect(by[100]).toMatchObject({ effectiveDate: '2026-12-01', monthlyChange: 30.64, oneTime: 0, increase: true, notice: null }); // 4 × (17.64 − 12.5) + 10.08
    expect(by[100]!.lines.map((l) => l.kind)).toEqual(['price', 'missing_line']);
    expect(by[200]).toMatchObject({ monthlyChange: -11.2, oneTime: 19.92, increase: true });
    expect(by[300]!.monthlyChange).toBeCloseTo((112 - 99.6) / 12, 2);
    expect(noticeLine(rows[0]!)).toBeNull();
  });

  test('which rows need a notice: increases and new charges — not cost, not fewer seats, not a move’s end row', () => {
    expect(rows.map((r) => needsNotice(r))).toEqual([false, true, true, true, false, true, true]);
    expect(needsNotice(row(9, { meta: meta(1, 'term', { move: 'add' }) }))).toBe(true);
    expect(needsNotice(row(10, { meta: meta(1, 'term', { move: 'end' }) }))).toBe(false);
    expect(needsNotice(row(11, { meta: meta(1, 'quantity'), after: { unitChange: 2 } }))).toBe(true);
  });

  test('approved customer-facing rows wait until that customer’s notice (or waiver) is recorded', () => {
    const approved = plan(rows.map((r) => (r.status === 'excluded' ? r : { ...r, status: 'approved' as const })));
    expect(rowsAwaitingNotice(approved, []).map((h) => h.row)).toEqual([2, 3, 4, 6]);
    const sent: NoticeRecord[] = [{ planId: 'plan-1', companyId: 100, sentOn: '2026-10-20', method: 'email', note: null, recordedBy: 'x', recordedAt: 'x' }, { planId: 'other', companyId: 200, sentOn: '2026-10-20', method: 'email', note: null, recordedBy: 'x', recordedAt: 'x' }];
    expect(rowsAwaitingNotice(approved, sent).map((h) => h.row)).toEqual([4, 6]); // a notice on another plan doesn't count
    const c100 = buildNotices(approved, sent).find((c) => c.companyId === 100)!;
    expect(c100).toMatchObject({ noticeDays: 42, notice: { method: 'email' } });
  });

  test('CSV for a mail merge: one line per change; spreadsheet formulas neutralised', () => {
    const csv = noticesCsv(buildNotices(plan([row(1, { meta: meta(1, 'price', { customer: '=HYPERLINK("x")' }), before: { units: 1, unitPrice: 1 }, after: { effectiveDate: '2026-12-01', unitChange: 0, adjustedUnitPrice: 2 } })]), []));
    const [head, line] = csv.trim().split('\r\n');
    expect(head).toMatch(/^Company ID,Customer,Contract,Product,Change,Effective/);
    expect(line).toContain(`"'=HYPERLINK(""x"")"`);
  });
});

describe('pre-invoice check', () => {
  const base = (o: Partial<PreinvoiceInput> = {}): PreinvoiceInput => ({
    throughDate: '2026-10-31',
    companyNames: new Map([[1, 'Contoso Office Centers'], [2, 'Fabrikam']]),
    contracts: [{ id: 10, companyID: 1, contractName: 'Annual licences', startDate: '2026-05-01', endDate: '2027-04-30' }, { id: 11, companyID: 1, contractName: 'Monthly licences', startDate: '2026-01-01', endDate: '2027-12-31' }, { id: 20, companyID: 2, contractName: 'Licenses', startDate: null, endDate: null }],
    lines: [{ id: 100, contractID: 10, serviceID: 7 }, { id: 101, contractID: 11, serviceID: 8 }, { id: 200, contractID: 20, serviceID: 7 }],
    serviceNames: new Map([[7, 'Microsoft 365 Apps for Business [NCE] - AA'], [8, 'Microsoft 365 Apps for Business [NCE] - Monthly']]),
    offeringOfService: new Map([[7, 5], [8, 5]]),
    units: [{ contractServiceID: 100, startDate: '2026-05-01T00:00:00', endDate: '2027-04-30T00:00:00', units: 1, price: 120 }, { contractServiceID: 101, startDate: '2026-11-01T00:00:00', endDate: '2026-11-30T00:00:00', units: 1, price: 12 }],
    charges: [{ id: 900, contractID: 11, contractServiceID: null, name: 'Microsoft 365 Apps for Business [NCE] - Monthly — back-bill Sep 2026 – Oct 2026', datePurchased: '2026-10-31T00:00:00', unitQuantity: 2, unitPrice: 9.96, unitCost: 10.08 }],
    plans: [], notices: [], openCritical: [],
    ...o,
  });

  test('a back-bill for months a prepaid annual line already bills → STOP', () => {
    const r = analyzePreinvoice(base());
    expect(r.verdict).toBe('stop');
    expect(r.doubleBilling).toHaveLength(1);
    expect(r.doubleBilling[0]).toMatchObject({ chargeId: 900, customer: 'Contoso Office Centers', line: 100, contract: 'Annual licences', months: ['2026-09', '2026-10'] });
    expect(r.pendingCharges[0]).toMatchObject({ chargeId: 900, amount: 19.92, warning: 'priced below its cost (9.96 < 10.08)' });
  });

  test('the line the back-bill tops up is not a double bill; another customer’s line never is; a window the line doesn’t cover is fine', () => {
    expect(analyzePreinvoice(base({ charges: [{ ...base().charges[0]!, contractServiceID: 100 }] })).doubleBilling).toEqual([]);
    expect(analyzePreinvoice(base({ units: [{ contractServiceID: 200, startDate: '2026-01-01T00:00:00', endDate: '2026-12-31T00:00:00', units: 3, price: 10 }] })).doubleBilling).toEqual([]);
    expect(analyzePreinvoice(base({ units: [{ contractServiceID: 100, startDate: '2026-11-01T00:00:00', endDate: '2027-10-31T00:00:00', units: 1, price: 120 }] })).doubleBilling).toEqual([]);
  });

  test('one customer billed for the same product on two lines this month → review', () => {
    const r = analyzePreinvoice(base({ charges: [], units: [{ contractServiceID: 100, startDate: '2026-05-01T00:00:00', endDate: '2027-04-30T00:00:00', units: 1, price: 120 }, { contractServiceID: 101, startDate: '2026-10-01T00:00:00', endDate: '2026-10-31T00:00:00', units: 1, price: 12 }] }));
    expect(r.verdict).toBe('review');
    expect(r.duplicateLines).toHaveLength(1);
    expect(r.duplicateLines[0]!.lines.map((l) => l.line)).toEqual([100, 101]);
  });

  test('a plan change taking effect this month without a notice → review; nothing found → ready', () => {
    const p = plan([row(1, { status: 'applied', meta: meta(2, 'price'), before: { units: 1, unitPrice: 10 }, after: { effectiveDate: '2026-10-01', unitChange: 0, adjustedUnitPrice: 12 } })]);
    const r = analyzePreinvoice(base({ charges: [], units: [], plans: [p] }));
    expect(r.priceChanges).toEqual([expect.objectContaining({ row: 1, monthlyChange: 2, noticeRecorded: false })]);
    expect(r.verdict).toBe('review');
    expect(analyzePreinvoice(base({ charges: [], units: [], plans: [p], notices: [{ planId: 'plan-1', companyId: 2, sentOn: '2026-09-01', method: 'email', note: null, recordedBy: null, recordedAt: 'x' }] })).verdict).toBe('ready');
  });
});

describe('exception outcomes', () => {
  test('overdue = past due and still undecided', () => {
    expect(isOverdue({ status: 'open', dueOn: '2000-01-01' })).toBe(true);
    expect(isOverdue({ status: 'acknowledged', dueOn: '2000-01-01' })).toBe(true);
    for (const s of ['absorbed', 'billed_elsewhere', 'accepted', 'resolved', 'fix_planned']) expect(isOverdue({ status: s, dueOn: '2000-01-01' })).toBe(false);
    expect(isOverdue({ status: 'open', dueOn: '2999-01-01' })).toBe(false);
    expect(isOverdue({ status: 'open', dueOn: null })).toBe(false);
  });
});

describe('capability gaps', () => {
  test('the same request worded with different case / punctuation is one gap', () => {
    expect(gapKey('Delete a contract charge')).toBe(gapKey('  delete a CONTRACT-charge! '));
    expect(gapKey('Delete a contract charge')).not.toBe(gapKey('Delete a contract'));
  });

  test('autotask_report_gap stores an agent request (and refuses an empty one)', async () => {
    const calls: Array<[string, unknown[]]> = [];
    const pool = { query: async (sql: string, args: unknown[]) => { calls.push([sql, args]); return { rows: [{ id: 7, dedupe_key: args[0], title: args[1], detail: args[2], source: args[3], reporter: args[4], tool_tried: args[5], example: null, status: 'open', priority: args[7], resolution: null, occurrences: 1, first_seen: '2026-10-17', last_seen: '2026-10-17', updated_at: '2026-10-17', updated_by: null, created: true }] }; } };
    const h = new Map(gapToolHandlers(() => pool as never)).get('autotask_report_gap')!;
    const ctx = { source: 'chatgpt' } as never;
    expect((await h({ title: 'x' }, ctx)).result).toMatchObject({ status: 'invalid_value' });
    const r = await h({ title: 'Delete a contract charge', detail: 'User asked to remove a duplicate back-bill', toolsTried: ['autotask_raw_request'] }, ctx);
    expect(r.result).toMatchObject({ id: 7, created: true });
    expect(calls[0]![1]).toEqual(expect.arrayContaining(['Delete a contract charge', 'agent', 'chatgpt', 'autotask_raw_request']));
  });
});
