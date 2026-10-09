// Shadow consistency check: sampled mirrored rows vs Autotask, classified so
// expected lag (recent edits, pending refresh) isn't reported as a fault;
// real mismatches and vanished rows are repaired from Autotask; row counts
// compared with a tolerance.

import { compareRow, countWithinTolerance, verifyEntity, overallStatus, CHANGE_LAG_MS, type VerifyDeps } from '../src/db/shadow-verify';
import { shadowEntity } from '../src/db/shadow-entities';

const now = new Date('2026-10-08T12:00:00Z');
const tickets = shadowEntity('Tickets')!;
const invoices = shadowEntity('Invoices')!;

describe('compareRow', () => {
  const wm = 'lastTrackedModificationDateTime';
  test('identical (null and missing are the same) → ok', () => {
    expect(compareRow(tickets, { id: 1, a: null, b: [1] }, { id: 1, b: [1] }, now, now)).toEqual({ status: 'ok', fields: [] });
  });
  test('watermark entity: newer recent stamp = changed (next sync gets it); old newer stamp = missed; same stamp = differs', () => {
    const m = { id: 1, title: 'a', [wm]: '2026-10-08T11:00:00Z' };
    expect(compareRow(tickets, m, { ...m, title: 'b', [wm]: '2026-10-08T11:55:00Z' }, now, now)).toEqual({ status: 'changed', fields: ['lastTrackedModificationDateTime', 'title'] });
    expect(compareRow(tickets, m, { ...m, title: 'b', [wm]: new Date(now.getTime() - CHANGE_LAG_MS - 60_000).toISOString() }, now, now).status).toBe('differs');
    expect(compareRow(tickets, m, { ...m, lastActivityDate: '2026-10-08T11:50:00Z' }, now, now)).toEqual({ status: 'differs', fields: ['lastActivityDate'] });
  });
  test('window-refresh entity: copy younger than the hourly refresh = pending; older = differs', () => {
    const m = { id: 7, paidDate: null };
    expect(compareRow(invoices, m, { id: 7, paidDate: '2026-10-08' }, new Date('2026-10-08T11:30:00Z'), now).status).toBe('pending');
    expect(compareRow(invoices, m, { id: 7, paidDate: '2026-10-08' }, new Date('2026-10-08T10:00:00Z'), now).status).toBe('differs');
  });
  test('count tolerance: 5 rows or 0.5%', () => {
    expect(countWithinTolerance(100, 105)).toBe(true);
    expect(countWithinTolerance(100, 107)).toBe(false);
    expect(countWithinTolerance(10_000, 10_040)).toBe(true);
  });
});

describe('verifyEntity', () => {
  const deps = (over: Partial<VerifyDeps> = {}): VerifyDeps & { upserted: any[]; deleted: number[]; queries: any[] } => {
    const d: any = {
      upserted: [], deleted: [], queries: [],
      state: async () => ({ backfill_done: true, window_from: new Date('2026-04-08T00:00:00Z') }),
      effective: async (e: any) => e,
      sample: async () => [
        { data: { id: 1, title: 'same', lastTrackedModificationDateTime: '2026-10-01T00:00:00Z' }, syncedAt: now },
        { data: { id: 2, title: 'old', lastTrackedModificationDateTime: '2026-10-01T00:00:00Z' }, syncedAt: now },
        { data: { id: 3, title: 'gone', lastTrackedModificationDateTime: '2026-10-01T00:00:00Z' }, syncedAt: now },
      ],
      query: async (entity: string, filter: any[], opts: any) => {
        d.queries.push({ entity, filter, opts });
        return [{ id: 1, title: 'same', lastTrackedModificationDateTime: '2026-10-01T00:00:00Z' }, { id: 2, title: 'new', lastTrackedModificationDateTime: '2026-10-01T00:00:00Z' }];
      },
      count: async () => 1000,
      countMatching: async () => 990,
      upsert: async (_e: any, rows: any[]) => { d.upserted.push(...rows); return rows.length; },
      markDeleted: async (_e: string, ids: number[]) => { d.deleted.push(...ids); return ids.length; },
      ...over,
    };
    return d;
  };

  test('one id-in query bypassing the shadow; differs + missing found, repaired; counts compared over the window', async () => {
    const d = deps();
    const r = await verifyEntity(tickets, d, { sample: 3, repair: true, now });
    expect(d.queries).toEqual([{ entity: 'Tickets', filter: [{ op: 'in', field: 'id', value: [1, 2, 3] }], opts: { maxRecords: 3, noCache: true } }]);
    expect(r).toMatchObject({ sampled: 3, ok: 1, differs: 1, missing: 1, repaired: 2, mirrorCount: 990, autotaskCount: 1000, countDelta: -10, countOk: false, calls: 2 });
    expect(r.examples).toEqual([{ id: 2, status: 'differs', fields: ['title'] }, { id: 3, status: 'missing', fields: [] }]);
    expect(d.upserted.map((x) => x.id)).toEqual([2]);
    expect(d.deleted).toEqual([3]);
    expect(overallStatus([r])).toBe('attention');
  });

  test('repair off changes nothing; a still-backfilling or untranslatable entity is skipped, not failed', async () => {
    const d = deps();
    await verifyEntity(tickets, d, { sample: 3, repair: false, now });
    expect(d.upserted).toEqual([]);
    expect((await verifyEntity(tickets, deps({ state: async () => ({ backfill_done: false, window_from: null }) }), { sample: 3, repair: true, now })).skipped).toBe('still backfilling');
    expect((await verifyEntity(invoices, deps({ effective: async () => ({ error: 'not mirrored on this tenant' }) }), { sample: 3, repair: true, now })).skipped).toBe('not mirrored on this tenant');
  });

  test('all matching → ok', async () => {
    const d = deps({ sample: async () => [{ data: { id: 1, a: 1 }, syncedAt: now }], query: async () => [{ id: 1, a: 1 }], countMatching: async () => 1000 });
    const r = await verifyEntity(tickets, d, { sample: 1, repair: true, now });
    expect(r).toMatchObject({ ok: 1, differs: 0, missing: 0, countOk: true });
    expect(overallStatus([r])).toBe('ok');
  });
});
