// Billing / financial mirror (Invoices, BillingItems, charges): tenant field
// resolution, window-refresh mode (new rows by id, recent edits hourly, whole
// window daily, deletions inside the re-read range), charge writes, and the
// client-level read path (every query / by-id GET asks the shadow first).

import { ShadowSync } from '../src/db/shadow-sync';
import { shadowEntity } from '../src/db/shadow-entities';
import { writtenRow, shadowGet, _setShadowRuntime } from '../src/db/shadow-runtime';
import { AutotaskHttpClient, setReadInterceptor, _resetRateLimitCooldowns } from '../src/services/autotask-http';
import { runWithRequestContext } from '../src/utils/request-context';
import { Logger } from '../src/utils/logger';

const logger = new Logger('error');
afterEach(() => { _setShadowRuntime(null); setReadInterceptor(null); jest.restoreAllMocks(); });

const match = (r: any, f: any): boolean => {
  if (f.op === 'or') return f.items.some((i: any) => match(r, i));
  if (f.op === 'gt') return Number(r[f.field]) > f.value;
  if (f.op === 'gte') return String(r[f.field] ?? '') >= f.value;
  if (f.op === 'in') return f.value.includes(r[f.field]);
  return true;
};

function memStore() {
  const rows = new Map<string, Map<number, any>>(), deleted = new Map<string, Set<number>>(), states = new Map<string, any>();
  const tbl = (e: string) => rows.get(e) ?? rows.set(e, new Map()).get(e)!;
  const live = (e: string) => [...tbl(e).keys()].filter((i) => !deleted.get(e)?.has(i));
  return {
    rows, deleted, states,
    upsert: jest.fn(async (e: any, rs: any[]) => { for (const r of rs) { tbl(e.name).set(Number(r.id), r); deleted.get(e.name)?.delete(Number(r.id)); } return rs.length; }),
    markDeleted: jest.fn(async (e: string, ids: number[]) => { const d = deleted.get(e) ?? deleted.set(e, new Set()).get(e)!; ids.forEach((i) => d.add(i)); return ids.length; }),
    liveIds: jest.fn(async (e: string) => live(e)),
    liveIdsMatching: jest.fn(async (e: string, fs: any[]) => live(e).filter((i) => fs.every((f) => match(tbl(e).get(i), f)))),
    maxId: jest.fn(async (e: string) => Math.max(0, ...tbl(e).keys())),
    getState: jest.fn(async (e: string) => states.get(e) ?? null),
    saveState: jest.fn(async (e: string, p: any) => { const { apiCalls = 0, ...f } = p; const s = states.get(e) ?? { entity: e, backfill_cursor: 0, backfill_done: false, api_calls_total: 0 }; states.set(e, { ...s, ...f, api_calls_total: s.api_calls_total + apiCalls }); }),
  };
}

function fakeAutotask(tables: Record<string, any[]>, fieldsOf: Record<string, string[]> = {}) {
  const calls: Array<{ entity: string; filter: any[] }> = [];
  return {
    calls,
    http: async () => ({
      query: async (entity: string, filter: any[]) => { calls.push({ entity, filter }); return (tables[entity] ?? []).filter((r) => filter.every((f) => match(r, f))).sort((a, b) => a.id - b.id).slice(0, 500); },
      fieldInfo: async (entity: string) => ({ fields: (fieldsOf[entity] ?? ['id', 'invoiceDateTime', 'itemDate', 'datePurchased', 'createDateTime']).map((name) => ({ name, isQueryable: true })) }),
    }),
  };
}

describe('tenant field resolution', () => {
  test('a candidate watermark that exists turns the entity incremental; a missing required field skips it with a clear error', async () => {
    const at = fakeAutotask({}, { Invoices: ['id', 'invoiceDateTime', 'lastModifiedDateTime'], BillingItems: ['id', 'postedDate'] });
    const sync = new ShadowSync(at.http as any, memStore() as any, logger, { maxCallsPerRun: 50, pauseAtPct: 50 });
    expect(await sync.effective(shadowEntity('Invoices')!)).toMatchObject({ name: 'Invoices', watermarkField: 'lastModifiedDateTime' });
    expect(await sync.effective(shadowEntity('BillingItems')!)).toEqual({ error: 'not mirrored on this tenant: field(s) itemDate not available on BillingItems' });
    expect(await sync.effective(shadowEntity('TicketCharges')!)).toMatchObject({ watermarkField: null }); // no watermark → window refresh
  });
});

describe('window refresh (Invoices)', () => {
  const inv = (id: number, day: string, extra: any = {}) => ({ id, invoiceDateTime: `${day}T00:00:00Z`, createDateTime: `${day}T00:00:00Z`, ...extra });
  test('backfill the window → new rows by id each run → recent edits hourly → whole window daily, with deletions', async () => {
    const table = [inv(1, '2026-01-10'), inv(2, '2026-05-01'), inv(3, '2026-09-20'), inv(4, '2026-10-01')];
    const at = fakeAutotask({ Invoices: table });
    const store = memStore();
    const only = (now: string) => new ShadowSync(at.http as any, store as any, logger, { maxCallsPerRun: 50, pauseAtPct: 50, historyMonths: 6, refreshDays: 30 })
      .runOnce(new Date(now)).then((r) => r.entities.find((e) => e.entity === 'Invoices')!);

    const r1 = await only('2026-10-08T10:00:00Z');
    expect(r1).toMatchObject({ mode: 'backfill', rows: 3, done: true }); // 2026-01-10 is outside the 6-month window
    expect([...store.rows.get('Invoices')!.keys()]).toEqual([2, 3, 4]);

    // 10 minutes later: one new invoice; no re-read yet (the backfill counts as the last refresh).
    table.push(inv(5, '2026-10-08'));
    at.calls.length = 0;
    const r2 = await only('2026-10-08T10:10:00Z');
    expect(r2).toMatchObject({ mode: 'incremental', rows: 1 });
    expect(at.calls.filter((c) => c.entity === 'Invoices').map((c) => c.filter)).toEqual([[{ op: 'gt', field: 'id', value: 4 }]]);

    // An hour later: #3 was paid, #4 removed: the recent-days re-read picks both up.
    table[2] = inv(3, '2026-09-20', { paidDate: '2026-10-08' });
    table.splice(3, 1);
    at.calls.length = 0;
    const r3 = await only('2026-10-08T11:05:00Z');
    expect(r3).toMatchObject({ mode: 'refresh', deleted: 1 });
    expect(at.calls.filter((c) => c.entity === 'Invoices')[1]!.filter[0]).toEqual({ op: 'gte', field: 'invoiceDateTime', value: '2026-09-08' });
    expect(store.rows.get('Invoices')!.get(3).paidDate).toBe('2026-10-08');
    expect(store.deleted.get('Invoices')!.has(4)).toBe(true);
    expect(store.deleted.get('Invoices')?.has(2) ?? false).toBe(false); // older than the recent range: untouched

    // Next day: the whole window is re-read.
    at.calls.length = 0;
    await only('2026-10-09T10:30:00Z');
    expect(at.calls.filter((c) => c.entity === 'Invoices')[1]!.filter[0]).toEqual({ op: 'gte', field: 'invoiceDateTime', value: '2026-04-08' });
  });
});

describe('writes + client read path', () => {
  test('charges created on any parent map to the right mirror', () => {
    expect(writtenRow('/Tickets/7/Charges', {}, { itemId: 3 })).toEqual({ entity: 'TicketCharges', id: 3 });
    expect(writtenRow('/Projects/9/Charges', {}, { itemId: 4 })).toEqual({ entity: 'ProjectCharges', id: 4 });
    expect(writtenRow('/Contracts/2/Charges', {}, { itemId: 5 })).toEqual({ entity: 'ContractCharges', id: 5 });
  });

  test('shadowGet: fresh + present gives the row; written-since-sync or absent goes live', async () => {
    const query = jest.fn(async (_e: string, f: any[]) => ({ rows: f[0].value === 42 ? [{ id: 42, invoiceNumber: 'A' }] : [], total: 0 }));
    const isDirty = jest.fn((_e: string, id: number) => id === 7);
    _setShadowRuntime({ store: { freshness: async () => ({ ready: true, ageSeconds: 10 }), query }, sync: { isDirty, writtenWithin: () => false }, serveReads: true, maxAgeSeconds: 900 } as any);
    expect(await shadowGet('Invoices', 42)).toEqual({ id: 42, invoiceNumber: 'A' });
    expect(await shadowGet('Invoices', 43)).toBeUndefined();
    expect(await shadowGet('Invoices', 7)).toBeUndefined();
    expect(await shadowGet('Opportunities', 1)).toBeUndefined();
  });

  test('AutotaskHttpClient asks the interceptor first; projects includeFields; skips it for noCache, impersonation and huge reads', async () => {
    _resetRateLimitCooldowns();
    const upstream = jest.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ items: [{ id: 99 }], pageDetails: {} }) }));
    global.fetch = upstream as unknown as typeof fetch;
    const query = jest.fn(async () => [{ id: 1, invoiceNumber: 'X', companyID: 5, invoiceTotal: 10 }]);
    const get = jest.fn(async (_t: string, _e: string, id: number) => (id === 1 ? { id: 1, invoiceNumber: 'X' } : undefined));
    setReadInterceptor({ query, get });
    const c = new AutotaskHttpClient('Api@Example.com', 's', 'ic', 'https://webservices3.autotask.net/ATServicesRest/', logger);
    expect(await c.query('Invoices', [{ op: 'eq', field: 'companyID', value: 5 }], { maxRecords: 25, includeFields: ['invoiceNumber'] })).toEqual([{ id: 1, invoiceNumber: 'X' }]);
    expect(query).toHaveBeenCalledWith('api@example.com', 'Invoices', [{ op: 'eq', field: 'companyID', value: 5 }], 25);
    expect(await c.get('Invoices', 1)).toEqual({ id: 1, invoiceNumber: 'X' });
    expect(upstream).not.toHaveBeenCalled();
    await c.query('Invoices', [], { noCache: true });
    await c.query('Invoices', [], { maxRecords: 10_000 });
    await runWithRequestContext({ impersonationResourceId: 30 }, () => c.query('Invoices', [], { maxRecords: 5 }));
    expect(upstream).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
