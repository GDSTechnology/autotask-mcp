// #100 — ticket throughput / work-queue KPIs: flow (created/completed/ratio) +
// backlog snapshot (aging buckets, by status, oldest-open) + grouping. Pure.

import { computeTicketThroughput } from '../src/utils/ticket-throughput';

const NOW = new Date('2026-09-30T12:00:00Z');

describe('computeTicketThroughput', () => {
  test('flow: created vs completed, ratio, net backlog change', () => {
    const r = computeTicketThroughput({
      created: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }],
      completed: [{ id: 5 }, { id: 6 }, { id: 7 }],
      open: [],
      from: '2026-09-01', to: '2026-09-30', now: NOW,
    });
    expect(r.flow).toEqual({ created: 4, completed: 3, completionRatio: 0.75, netBacklogChange: 1 });
  });

  test('completionRatio null when nothing created', () => {
    const r = computeTicketThroughput({ created: [], completed: [{ id: 1 }], open: [], from: 'a', to: 'b', now: NOW });
    expect(r.flow.completionRatio).toBeNull();
    expect(r.flow.netBacklogChange).toBe(-1);
  });

  test('backlog aging buckets from createDate age (default 7/30/90)', () => {
    const r = computeTicketThroughput({
      created: [], completed: [],
      open: [
        { id: 1, createDate: '2026-09-28' }, // 2d → 0-7
        { id: 2, createDate: '2026-09-10' }, // 20d → 8-30
        { id: 3, createDate: '2026-08-15' }, // 46d → 31-90
        { id: 4, createDate: '2026-05-01' }, // >90 → 90+
      ],
      from: 'a', to: 'b', now: NOW,
    });
    const by = Object.fromEntries(r.backlog.aging.map((a) => [a.bucket, a.count]));
    expect(by['0-7']).toBe(1);
    expect(by['8-30']).toBe(1);
    expect(by['31-90']).toBe(1);
    expect(by['91+']).toBe(1);
    expect(r.backlog.open).toBe(4);
    expect(r.backlog.oldestOpenDays).toBeGreaterThan(90);
  });

  test('byStatus counts with resolved labels, busiest first', () => {
    const r = computeTicketThroughput({
      created: [], completed: [],
      open: [{ id: 1, status: 1 }, { id: 2, status: 1 }, { id: 3, status: 8 }],
      from: 'a', to: 'b', now: NOW,
      statusLabels: new Map([[1, 'New'], [8, 'Waiting Customer']]),
    });
    expect(r.backlog.byStatus[0]).toEqual({ status: 1, label: 'New', count: 2 });
    expect(r.backlog.byStatus[1]).toEqual({ status: 8, label: 'Waiting Customer', count: 1 });
  });

  test('custom aging thresholds', () => {
    const r = computeTicketThroughput({
      created: [], completed: [],
      open: [{ id: 1, createDate: '2026-09-29' }], // 1d
      from: 'a', to: 'b', now: NOW, agingThresholds: [1, 3],
    });
    expect(r.backlog.aging.map((a) => a.bucket)).toEqual(['0-1', '2-3', '4+']);
    expect(r.backlog.aging[0].count).toBe(1);
  });

  test('groupBy queue: per-team open/created/completed/ratio, busiest-open first', () => {
    const r = computeTicketThroughput({
      created: [{ id: 1, queueID: 8 }, { id: 2, queueID: 8 }, { id: 3, queueID: 9 }],
      completed: [{ id: 4, queueID: 8 }],
      open: [{ id: 5, queueID: 8 }, { id: 6, queueID: 8 }, { id: 7, queueID: 9 }],
      from: 'a', to: 'b', now: NOW, groupBy: 'queue',
    });
    const q8 = r.groups!.find((g) => g.key === 'queue:8')!;
    expect(q8).toMatchObject({ open: 2, created: 2, completed: 1, completionRatio: 0.5 });
    expect(r.groups![0].key).toBe('queue:8'); // most open first
  });
});
