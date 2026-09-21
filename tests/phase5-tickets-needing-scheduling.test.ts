// #100 — tickets needing scheduling: open tickets with no usable service call,
// classified unscheduled / past_service_call / scheduled. Pure.

import { computeTicketsNeedingScheduling, ServiceCallLite } from '../src/utils/tickets-needing-scheduling';

const NOW = new Date('2026-09-21T12:00:00Z');
const tk = (id: number, o: Record<string, any> = {}) => ({ id, ticketNumber: `T${id}`, hoursToBeScheduled: 4, createDate: '2026-09-01', ...o });

describe('computeTicketsNeedingScheduling', () => {
  test('classifies unscheduled / past / future service calls', () => {
    const calls = new Map<number, ServiceCallLite[]>([
      [2, [{ id: 20, startDateTime: '2026-09-10T09:00:00Z' }]],  // past only
      [3, [{ id: 30, startDateTime: '2026-09-25T09:00:00Z' }]],  // future
    ]);
    const r = computeTicketsNeedingScheduling([tk(1), tk(2), tk(3)], calls, NOW);
    expect(r.counts).toEqual({ unscheduled: 1, pastServiceCall: 1, scheduled: 1 });
    expect(r.needsScheduling.map((n) => n.id).sort()).toEqual([1, 2]); // 3 excluded (scheduled)
    const t1 = r.needsScheduling.find((n) => n.id === 1)!;
    const t2 = r.needsScheduling.find((n) => n.id === 2)!;
    expect(t1.reason).toBe('unscheduled');
    expect(t2.reason).toBe('past_service_call');
    expect(t2.lastServiceCallDate).toBe('2026-09-10T09:00:00Z');
  });

  test('a future call among past ones still counts as scheduled', () => {
    const calls = new Map<number, ServiceCallLite[]>([
      [1, [{ id: 10, startDateTime: '2026-09-01T09:00:00Z' }, { id: 11, startDateTime: '2026-09-30T09:00:00Z' }]],
    ]);
    const r = computeTicketsNeedingScheduling([tk(1)], calls, NOW);
    expect(r.counts.scheduled).toBe(1);
    expect(r.needsScheduling).toHaveLength(0);
  });

  test('sorts worst backlog first (most hours, then oldest) and totals hours', () => {
    const r = computeTicketsNeedingScheduling([
      tk(1, { hoursToBeScheduled: 4, createDate: '2026-09-01' }),
      tk(2, { hoursToBeScheduled: 10, createDate: '2026-09-15' }),
      tk(3, { hoursToBeScheduled: 4, createDate: '2026-08-01' }), // same hours as 1 but older
    ], new Map(), NOW);
    expect(r.needsScheduling.map((n) => n.id)).toEqual([2, 3, 1]);
    expect(r.totalHoursToSchedule).toBe(18);
    expect(r.needsScheduling[1].ageDays).toBeGreaterThan(r.needsScheduling[2].ageDays!);
  });

  test('age computed from createDate', () => {
    const r = computeTicketsNeedingScheduling([tk(1, { createDate: '2026-09-11' })], new Map(), NOW);
    expect(r.needsScheduling[0].ageDays).toBe(10); // 09-11 → 09-21
  });

  test('groupBy queue summarizes count + hours per group', () => {
    const r = computeTicketsNeedingScheduling([
      tk(1, { queueID: 8, hoursToBeScheduled: 4 }),
      tk(2, { queueID: 8, hoursToBeScheduled: 6 }),
      tk(3, { queueID: 9, hoursToBeScheduled: 5 }),
    ], new Map(), NOW, { groupBy: 'queue' });
    const q8 = r.groups!.find((g) => g.key === 'queue:8')!;
    expect(q8).toMatchObject({ count: 2, hoursToSchedule: 10 });
    expect(r.groups![0].key).toBe('queue:8'); // most hours first
  });
});
