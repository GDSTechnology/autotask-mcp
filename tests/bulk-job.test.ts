// Bulk placeholder cleanup: prepared from the mirror (paging, history exclusions, never a
// real company), paced writes (business hours slower, backpressure, canary pause, failure
// handling), approval by hash, and the tool's guards.

import { preparePlaceholderJob } from '../src/bulk/prepare';
import { activityProfile, currentRate, inBusinessHours, weeklyCapacity, DEFAULT_SCHEDULE } from '../src/bulk/schedule';
import { BulkWorker, applyItem, writeGapMs } from '../src/bulk/worker';
import { itemsHash, type BulkItem, type BulkJob } from '../src/bulk/store';
import { bulkToolHandlers } from '../src/bulk/tools';

type Row = Record<string, any>;
function fakeQ(tables: Record<string, Row[]>, o: { fail?: string } = {}) {
  const calls: Array<[string, any[]]> = [];
  const q = async <T>(entity: string, filters: Array<{ op: string; field: string; value: any }>, opts: { maxRecords?: number }) => {
    calls.push([entity, filters]);
    if (o.fail === entity) throw new Error(`${entity}: field not queryable`);
    let rows = tables[entity] ?? [];
    for (const f of filters) rows = rows.filter((r) => f.op === 'eq' ? r[f.field] === f.value : f.op === 'gt' ? r[f.field] > f.value : f.op === 'in' ? f.value.includes(r[f.field]) : true);
    return rows.sort((a, b) => a.id - b.id).slice(0, opts.maxRecords ?? 500) as T[];
  };
  return { q, calls };
}

describe('prepare', () => {
  const companies = Array.from({ length: 6000 }, (_, i) => ({ id: 100000 + i, companyName: 'Gmail', isActive: i !== 5, createDate: '2026-09-01', createdByResourceID: 77 }));
  const contacts = companies.map((c, i) => ({ id: 500000 + i, companyID: c.id, isActive: i !== 7, firstName: 'Unknown', lastName: 'Contact' }));
  contacts[9] = { ...contacts[9]!, firstName: 'Avery', lastName: 'Lee' }; // a real-looking person on company 100009
  const tables = { Companies: companies, Contacts: contacts, Tickets: [{ id: 1, companyID: 100003 }, { id: 2, companyID: 100003 }], Invoices: [{ id: 3, companyID: 100004 }] };

  test('pages past 4,999, excludes companies with history or a real-named contact, inactivates contacts before their company', async () => {
    const { q, calls } = fakeQ(tables);
    const r = await preparePlaceholderJob(q, { companyName: 'Gmail' });
    expect(calls.filter(([e, f]) => e === 'Companies' && f.some((x: any) => x.op === 'gt')).length).toBe(2); // 4,999 + 1,001
    expect(r.stats).toMatchObject({ companies: 6000, excludedCompanies: 3, companiesAlreadyInactive: 1 });
    const ex = r.items.filter((i) => i.status === 'excluded');
    expect(ex.map((i) => [i.recordId, i.reason])).toEqual([[100003, '2 tickets'], [100004, '1 invoices'], [100009, expect.stringMatching(/real name/)]]);
    // company 100005 is already inactive: its contact is inactivated, the company is not written
    expect(r.items.filter((i) => i.recordId === 100005 || i.parentId === 100005).map((i) => i.entity)).toEqual(['Contacts']);
    // contact of 100007 is already inactive: only the company
    expect(r.items.filter((i) => i.recordId === 100007 || i.parentId === 100007).map((i) => i.entity)).toEqual(['Companies']);
    // order: contact first, then its company
    const k = r.items.findIndex((i) => i.recordId === 100000);
    expect(r.items[k - 1]).toMatchObject({ entity: 'Contacts', parentId: 100000 });
    expect(r.stats.writes).toBe((r.stats.companyWrites as number) + (r.stats.contactWrites as number));
  });

  test('a history check that fails stops everything — never "no history"', async () => {
    const { q } = fakeQ(tables, { fail: 'Quotes' });
    await expect(preparePlaceholderJob(q, { companyName: 'Gmail' })).rejects.toThrow(/history check on quotes failed/);
  });

  test('a selection that includes a real company is refused', async () => {
    const { q } = fakeQ({ Companies: [{ id: 1, companyName: 'Contoso Office Centers', isActive: true }] });
    await expect(preparePlaceholderJob(q, { companyName: 'Contoso Office Centers' })).rejects.toThrow(/not placeholders/);
  });

  test('the approval hash binds the records to write (excluded ones are not part of it)', () => {
    const a = [{ entity: 'Companies' as const, recordId: 1, action: 'inactivate' as const }, { entity: 'Companies' as const, recordId: 2, action: 'inactivate' as const, status: 'excluded' as const }];
    expect(itemsHash('k', a)).toBe(itemsHash('k', [a[0]!]));
    expect(itemsHash('k', a)).not.toBe(itemsHash('k', [{ ...a[0]!, recordId: 3 }]));
  });
});

describe('business hours', () => {
  const s = DEFAULT_SCHEDULE; // Mon–Fri 07:00–18:59 America/New_York, 1,000/hour
  test('slower inside the window, full rate outside; time-zone aware', () => {
    expect(inBusinessHours(new Date('2026-10-20T14:00:00Z'), s)).toBe(true);   // Tue 10:00 EDT
    expect(inBusinessHours(new Date('2026-10-20T23:30:00Z'), s)).toBe(false);  // Tue 19:30 EDT
    expect(inBusinessHours(new Date('2026-10-18T14:00:00Z'), s)).toBe(false);  // Sunday
    expect(currentRate(new Date('2026-10-20T14:00:00Z'), 3000, s)).toEqual({ rate: 1000, business: true });
    expect(currentRate(new Date('2026-10-20T02:00:00Z'), 3000, s)).toEqual({ rate: 3000, business: false });
    expect(currentRate(new Date('2026-10-20T14:00:00Z'), 3000, null)).toEqual({ rate: 3000, business: false });
    expect(weeklyCapacity(3000, s)).toBe(60 * 1000 + 108 * 3000);
  });
  test('activity profile suggests the busy weekday window from traffic', () => {
    // Weekdays: busy 08:00–17:59 local (12–21 UTC in EDT), quiet otherwise.
    const hourly = [];
    for (let d = 0; d < 5; d++) for (let h = 0; h < 24; h++) { const t = Date.UTC(2026, 9, 19 + d, h) / 3_600_000; hourly.push({ hour: t, upstream: h >= 12 && h <= 21 ? 2000 : 200, writes: 0 }); }
    const p = activityProfile(hourly, 'America/New_York') as { suggested: { start: number; end: number } };
    expect(p.suggested).toMatchObject({ start: 8, end: 18 });
  });
});

describe('worker', () => {
  const mkJob = (o: Partial<BulkJob> = {}): BulkJob => ({ id: 'j', kind: 'inactivate_placeholders', title: 't', params: { schedule: null }, status: 'running', hash: 'h', ratePerHour: 3600, canarySize: 2, pauseReason: null, lastError: null, stats: {}, createdBy: null, approvedBy: 'u', approvedAt: 'x', startedAt: 'x', finishedAt: null, createdAt: 'x', updatedAt: 'x', ...o });
  const item = (seq: number, o: Partial<BulkItem> = {}): BulkItem => ({ seq, entity: 'Companies', recordId: 1000 + seq, parentId: null, action: 'inactivate', status: 'pending', reason: null, attempts: 0, before: null, error: null, doneAt: null, ...o });
  function harness(items: BulkItem[], job = mkJob(), fail: (it: BulkItem) => Error | null = () => null) {
    const state = { job, items };
    const writes: string[] = [];
    let now = 0;
    const store = {
      running: async () => (state.job.status === 'running' ? [state.job] : []),
      next: async () => state.items.filter((i) => i.status === 'pending').slice(0, 1),
      markItem: async (_: string, seq: number, status: any, o: any = {}) => { const i = state.items.find((x) => x.seq === seq)!; i.status = status; i.attempts++; i.error = o.error ?? null; i.reason = o.reason ?? i.reason; },
      retryLater: async (_: string, seq: number, error: string) => { const i = state.items.find((x) => x.seq === seq)!; i.attempts++; i.error = error; },
      setStatus: async (_: string, status: any, o: any = {}) => { state.job = { ...state.job, status, ...(o.pauseReason !== undefined ? { pauseReason: o.pauseReason } : {}), stats: { ...state.job.stats, ...(o.stats ?? {}) } }; },
      counts: async () => ({}),
    };
    const fns = {
      inactivateCompany: async (id: number) => { const e = fail(state.items.find((i) => i.recordId === id)!); if (e) throw e; writes.push(`co:${id}`); },
      inactivateContact: async (id: number, co: number) => { writes.push(`ct:${id}@${co}`); },
    };
    let level: 'ok' | 'slow' | 'stop' = 'ok';
    const w = new BulkWorker({ store: store as never, fns, level: () => level, now: () => now, notify: () => undefined });
    return { w, state, writes, advance: (ms: number) => { now += ms; }, setLevel: (l: typeof level) => { level = l; } };
  }

  test('paced: at most one write per gap; canary pauses after its size; resume continues; done at the end', async () => {
    const h = harness([item(1), item(2), item(3)]);
    h.advance(10_000);
    expect(await h.w.tick()).toBe('done');      // item 1 written (outcome 'done')
    expect(await h.w.tick()).toBe('pacing');    // 3,600/hour → 1 s gap
    h.advance(1000); expect(await h.w.tick()).toBe('done');
    h.advance(1000); expect(await h.w.tick()).toBe('canary-pause');
    expect(h.state.job.status).toBe('paused');
    h.state.job = { ...h.state.job, status: 'running' };
    h.advance(1000); await h.w.tick();
    h.advance(1000); expect(await h.w.tick()).toBe('done'); // nothing pending → job done
    expect(h.state.job.status).toBe('done');
    expect(h.writes).toEqual(['co:1001', 'co:1002', 'co:1003']);
  });

  test('backpressure: "slow" doubles the gap, "stop" writes nothing', async () => {
    expect(writeGapMs(3000, 'ok')).toBe(1200);
    expect(writeGapMs(3000, 'slow')).toBe(2400);
    expect(writeGapMs(3000, 'stop')).toBeNull();
    const h = harness([item(1)]); h.setLevel('stop'); h.advance(10_000);
    expect(await h.w.tick()).toBe('backpressure-stop');
    expect(h.writes).toEqual([]);
  });

  test('a 401 pauses the job (item kept); 404 is skipped; transient errors retry, then fail after 3 tries', async () => {
    const err = (st: number, m = `HTTP ${st}`) => Object.assign(new Error(m), { status: st });
    expect(await applyItem(item(1), { inactivateCompany: async () => { throw err(401); }, inactivateContact: async () => undefined })).toMatchObject({ status: 'pause' });
    expect(await applyItem(item(1), { inactivateCompany: async () => { throw err(404); }, inactivateContact: async () => undefined })).toMatchObject({ status: 'skipped' });
    expect(await applyItem(item(1), { inactivateCompany: async () => { throw err(500); }, inactivateContact: async () => undefined })).toMatchObject({ status: 'retry' });
    expect(await applyItem(item(1, { attempts: 2 }), { inactivateCompany: async () => { throw err(500); }, inactivateContact: async () => undefined })).toMatchObject({ status: 'failed' });
    const h = harness([item(1), item(2)], mkJob({ canarySize: 99 }), (it) => (it.seq === 1 ? err(401) : null));
    h.advance(10_000); expect(await h.w.tick()).toBe('paused');
    expect(h.state.job.status).toBe('paused');
    expect(h.state.items[0]!.status).toBe('pending');
    expect(h.writes).toEqual([]);
  });

  test('a contact is inactivated through its company (the child route)', async () => {
    const h = harness([item(1, { entity: 'Contacts', recordId: 31, parentId: 900 })], mkJob({ canarySize: 99 }));
    h.advance(10_000); await h.w.tick();
    expect(h.writes).toEqual(['ct:31@900']);
  });
});

describe('tool guards', () => {
  const h = new Map(bulkToolHandlers({} as never, () => ({ query: async () => ({ rows: [] }) }) as never)).get('autotask_bulk_inactivate')!;
  const ctx = { source: 'chatgpt' } as never;
  test('never a real company name; start without confirm writes nothing', async () => {
    expect((await h({ action: 'prepare', companyName: 'Contoso Office Centers' }, ctx)).message).toMatch(/not a placeholder/);
    expect((await h({ action: 'prepare' }, ctx)).message).toMatch(/companyName/);
  });
});
