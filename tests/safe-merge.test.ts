// Safe company / contact merges — the spec's acceptance tests that apply to
// phase 1 (read-only discovery, inventory, ID-only plans of UI steps, verify).

import { buildMergeRows, evaluateMerge, isPlaceholderCompany, isPlaceholderContact, parseMergeMappings, summarizeInventory, validateMergeIds, type MergeRecord, type RecordInventory, type RefCount } from '../src/merge/model';
import { discover, inventory, type MergeDeps } from '../src/merge/data';
import { mergeToolHandlers } from '../src/merge/tools';
import { executePlan } from '../src/change-plans/execute';
import type { Plan } from '../src/change-plans/store';

const rec = (id: number, o: Partial<MergeRecord> = {}): MergeRecord => ({ id, name: `Company ${id}`, isActive: true, createDate: '2020-01-01', createdBy: null, placeholder: null, fields: {}, link: `https://ww3.example/Open?id=${id}`, ...o });
const ref = (entity: string, count: number, o: Partial<RefCount> = {}): RefCount => ({ entity, label: entity.toLowerCase(), field: 'companyID', count, active: null, ids: Array.from({ length: Math.min(count, 50) }, (_, i) => 1000 + i), money: false, movableByApi: true, error: null, ...o });

describe('ids only (acceptance 11, 12, 14)', () => {
  test('names, emails, non-integers, zero, repeats and survivor-as-source are refused', () => {
    expect(validateMergeIds('company', 'Gmail', [1])).toMatchObject({ ok: false });
    expect(validateMergeIds('contact', 5, ['someone@gmail.com'])).toMatchObject({ ok: false });
    expect(validateMergeIds('company', 0, [5])).toMatchObject({ ok: false, error: expect.stringMatching(/your own company/) });
    expect(validateMergeIds('company', 5, [0])).toMatchObject({ ok: false });
    expect(validateMergeIds('company', 5, [6.5])).toMatchObject({ ok: false });
    expect(validateMergeIds('company', 5, [6, 6])).toMatchObject({ ok: false, error: expect.stringMatching(/twice/) });
    expect(validateMergeIds('company', 5, [6, 5])).toMatchObject({ ok: false, error: expect.stringMatching(/into itself/) });
    expect(validateMergeIds('company', 5, [])).toMatchObject({ ok: false });
    expect(validateMergeIds('company', '40000009', ['40000002', 40000001])).toEqual({ ok: true, survivor: 40000009, sources: [40000001, 40000002] });
  });

  test('a CSV of old id → correct id: grouped by survivor; chains, repeats and non-numbers fail closed', () => {
    const ok = parseMergeMappings('company', { csv: 'old_id,new_id\n40000002,40000009\n40000001,40000009\n50000001,50000099\n' });
    expect(ok).toEqual({ ok: true, groups: [{ survivor: 40000009, sources: [40000001, 40000002] }, { survivor: 50000099, sources: [50000001] }] });
    expect(parseMergeMappings('company', { csv: '1,2\n2,3' })).toMatchObject({ ok: false, errors: [expect.stringMatching(/chain/)] });
    expect(parseMergeMappings('company', { csv: '1,2\n1,3' })).toMatchObject({ ok: false, errors: [expect.stringMatching(/more than once/)] });
    expect(parseMergeMappings('company', { csv: 'Gmail,2' })).toMatchObject({ ok: false });
    expect(parseMergeMappings('contact', { mappings: [{ sourceId: 10, survivorId: 11 }] })).toEqual({ ok: true, groups: [{ survivor: 11, sources: [10] }] });
  });
});

describe('placeholders', () => {
  test('"Gmail" and "Unknown Contact" are placeholders; a real name is not', () => {
    expect(isPlaceholderCompany({ companyName: 'Gmail' })).toMatch(/webmail/);
    expect(isPlaceholderCompany({ companyName: 'Unknown Company' })).toMatch(/placeholder/);
    expect(isPlaceholderCompany({ companyName: 'Contoso Office Centers' })).toBeNull();
    expect(isPlaceholderContact({ firstName: 'Unknown', lastName: 'Contact' })).toMatch(/placeholder/);
    expect(isPlaceholderContact({ firstName: 'Avery', lastName: 'Lee' })).toBeNull();
  });
});

describe('plan rows (acceptance 4, 5, 13)', () => {
  const inv = (id: number, refs: RefCount[]) => summarizeInventory(id, refs, 'company');
  test('an ACTIVE contract blocks the merge step until billing has reviewed; financial history is flagged, never reparented', () => {
    const i = new Map<number, RecordInventory>([[2, inv(2, [ref('Contracts', 1, { active: 1 }), ref('Invoices', 3, { money: true }), ref('Contacts', 2)])], [1, inv(1, [])]]);
    const rows = buildMergeRows('company', rec(1), [rec(2)], i);
    const merge = rows.find((r) => (r.meta as any).step === 'merge')!;
    expect(merge).toMatchObject({ action: 'manual', targetId: 2, after: { mergedInto: 1 } });
    expect(merge.blocked).toMatch(/ACTIVE contract/);
    expect(merge.reason).toMatch(/financial history/);
    expect(buildMergeRows('company', rec(1), [rec(2)], i, { billingReviewed: true }).find((r) => (r.meta as any).step === 'merge')!.blocked).toBeNull();
    // the delete step waits for the merge step; contacts are decided separately
    const del = rows.find((r) => (r.meta as any).step === 'delete')!;
    expect((del.meta as any).dependsOn).toEqual([1]);
    expect(rows.find((r) => (r.meta as any).step === 'contacts')).toMatchObject({ action: 'info', label: expect.stringMatching(/does NOT decide them/) });
  });

  test('survivor gaps are suggested from a REAL source only; placeholder values never', () => {
    const rows = buildMergeRows('company', rec(1, { fields: { phone: '000-000-0000' } }), [rec(2, { fields: { phone: '404-555-0100' } }), rec(3, { placeholder: 'x', fields: { webAddress: 'gmail.com' } })], new Map());
    const enrich = rows.filter((r) => (r.meta as any).step === 'enrich');
    expect(enrich.map((r) => r.after)).toEqual([{ phone: '404-555-0100' }]);
  });

  test('batched groups keep row numbers right for the delete dependency', () => {
    const a = buildMergeRows('company', rec(1), [rec(2)], new Map());
    const b = buildMergeRows('company', rec(9), [rec(8)], new Map(), { firstRowNo: a.length + 1 });
    expect((b.find((r) => (r.meta as any).step === 'delete')!.meta as any).dependsOn).toEqual([a.length + 1]);
  });

  test('the executor never runs a manual (UI) step', async () => {
    const plan: Plan = { id: 'p', kind: 'merge_company', title: 't', params: null, hash: 'h', status: 'open', createdBy: null, createdAt: 'x',
      rows: [{ rowNo: 1, action: 'manual', entity: 'Companies', targetId: 2, label: 'MERGE', before: null, after: { mergedInto: 1 }, reason: null, blocked: null, meta: null, status: 'approved', approvedBy: 'u', approvedAt: 'x', result: null, executedAt: null }] };
    const writes: unknown[] = [];
    const io = { get: async () => ({}), update: async (...x: unknown[]) => { writes.push(x); }, create: async (...x: unknown[]) => { writes.push(x); return 1; }, findExisting: async () => null };
    const rep = await executePlan({ setStatus: async () => undefined, setRowResult: async () => undefined, get: async () => plan } as never, plan, io as never);
    expect(rep.attempted).toBe(0);
    expect(writes).toEqual([]);
  });
});

describe('verify (acceptance 7, 10)', () => {
  test('gone = done; empty but present = delete it; records left = not merged; a missing survivor fails', () => {
    const r = evaluateMerge({ survivor: { exists: true, isActive: true }, sources: [{ id: 2, state: 'gone', remaining: 0, remainingByLabel: {} }, { id: 3, state: 'inactive', remaining: 0, remainingByLabel: {} }, { id: 4, state: 'inactive', remaining: 2, remainingByLabel: { tickets: 2 } }] });
    expect(r).toMatchObject({ status: 'partial', done: [2], mergedNotDeleted: [3], pending: [4], remnants: [{ id: 4, remaining: { tickets: 2 } }] });
    expect(evaluateMerge({ survivor: { exists: true, isActive: true }, sources: [{ id: 2, state: 'gone', remaining: 0, remainingByLabel: {} }] }).status).toBe('passed');
    expect(evaluateMerge({ survivor: { exists: false, isActive: false }, sources: [{ id: 2, state: 'gone', remaining: 0, remainingByLabel: {} }] }).status).toBe('failed');
    // deactivated with history still attached is NOT a merge
    expect(evaluateMerge({ survivor: { exists: true, isActive: true }, sources: [{ id: 2, state: 'inactive', remaining: 5, remainingByLabel: { tickets: 5 } }] }).status).toBe('not_started');
  });
});

describe('discovery and inventory read every page, all three email fields (acceptance 1, 2, 9)', () => {
  const fake = (contacts: Array<Record<string, any>>, companies: Array<Record<string, any>>) => {
    const calls: Array<[string, unknown[]]> = [];
    const d: MergeDeps = {
      q: async <T>(entity: string, filters: Array<{ op: string; field: string; value: any }>) => {
        calls.push([entity, filters]);
        const f = filters[0]!;
        const src = entity === 'Contacts' ? contacts : entity === 'Companies' ? companies : [];
        return src.filter((r) => f.op === 'in' ? f.value.includes(r[f.field]) : String(r[f.field] ?? '').toLowerCase() === String(f.value).toLowerCase()) as T[];
      },
      link: () => null, resourceNames: async () => new Map([[77, 'Some Z - API']]), writable: async () => true, fieldNames: async () => null,
    };
    return { d, calls };
  };

  test('250 contacts on 250 "Gmail" companies, matched in emailAddress2 — all counted, creator and dates reported', async () => {
    const contacts = Array.from({ length: 250 }, (_, i) => ({ id: 5000 + i, firstName: 'Unknown', lastName: 'Contact', emailAddress2: 'someone@gmail.com', companyID: 9000 + i, isActive: true, createDate: `2026-10-0${7 + (i % 2)}T10:00:00` }));
    const companies = contacts.map((c) => ({ id: c.companyID, companyName: 'Gmail', isActive: true, createDate: c.createDate, createdByResourceID: 77 }));
    const { d, calls } = fake(contacts, companies);
    const r = await discover(d, { email: 'Someone@Gmail.com' }) as any;
    expect(r.totals).toMatchObject({ contacts: 250, companies: 250, placeholderCompanies: 250, placeholderContacts: 250, companiesWithOneContact: 250 });
    expect(r.created).toMatchObject({ first: '2026-10-07T10:00:00', latest: '2026-10-08T10:00:00', byCreator: { 'Some Z - API': { companies: 250, active: 250 } } });
    expect(r.survivorHints).toEqual([]); // no real company among them — a person must decide
    expect(calls.filter(([e]) => e === 'Contacts').map(([, f]) => (f[0] as any).field)).toEqual(['emailAddress', 'emailAddress2', 'emailAddress3']);
  });

  test('inventory: counts per entity; a field that cannot be queried is a blocker, not a silent 0', async () => {
    const d: MergeDeps = {
      q: async <T>(entity: string) => { if (entity === 'Quotes') throw new Error('companyID is not queryable'); return (entity === 'Tickets' ? [{ id: 1, companyID: 9 }, { id: 2, companyID: 9 }] : []) as T[]; },
      link: () => null, resourceNames: async () => new Map(), writable: async (e) => e !== 'Invoices', fieldNames: async () => null,
    };
    const i = (await inventory(d, 'company', [9])).get(9)!;
    expect(i.refs.find((r) => r.entity === 'Tickets')).toMatchObject({ count: 2, ids: [1, 2], movableByApi: true });
    expect(i.blockers.join(' ')).toMatch(/quotes: could not be checked/);
    expect(i.total).toBe(2);
  });
});

describe('build_plan refuses before reading anything', () => {
  const h = new Map(mergeToolHandlers({} as never, () => ({}) as never)).get('autotask_merge_build_plan')!;
  const ctx = { source: 'chatgpt' } as never;
  test.each([
    [{}, /entityType/],
    [{ entityType: 'company', name: 'Gmail' }, /numeric ids/],
    [{ entityType: 'company', duplicateCompanyIds: [1, 2] }, /not accepted/],
    [{ entityType: 'company', survivorContactId: 1, sourceContactIds: [2] }, /company ids only/],
    [{ entityType: 'company', survivorCompanyId: 1, sourceCompanyIds: [2], mode: 'api_consolidate' }, /native_ui/],
    [{ entityType: 'company', survivorCompanyId: 'Gmail', sourceCompanyIds: [2] }, /ID number/],
    [{ entityType: 'company', csv: '1,2\n2,3' }, /chain/],
  ])('%j', async (args, msg) => {
    expect((await h(args, ctx)).message).toMatch(msg);
  });
});
