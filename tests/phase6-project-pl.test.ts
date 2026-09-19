// #98 — project/task/ticket P&L: burden cost (all time) vs posted revenue,
// week/month buckets, posted-vs-pending, cost-coverage guardrail. Pure.

import { computeProjectPL, bucketKey } from '../src/utils/project-pl';

describe('bucketKey', () => {
  test('month key', () => expect(bucketKey('2026-08-14T00:00:00Z', 'month')).toBe('2026-08'));
  test('week key = Monday of that week', () => {
    expect(bucketKey('2026-08-14T00:00:00Z', 'week')).toBe('2026-08-10'); // Fri 8/14 → Mon 8/10
    expect(bucketKey('2026-08-10T12:00:00Z', 'week')).toBe('2026-08-10'); // Mon stays
    expect(bucketKey('2026-08-16T00:00:00Z', 'week')).toBe('2026-08-10'); // Sun 8/16 → Mon 8/10
  });
});

describe('computeProjectPL', () => {
  const burden = new Map<number, number>([[1, 50], [2, 100]]); // resource 3 has none

  test('cost from ALL hours (billable + non-billable); revenue from posted only', () => {
    const r = computeProjectPL({
      scope: 'project', entityId: 177, bucket: 'month',
      burdenByResource: burden,
      timeEntries: [
        { resourceID: 1, hoursWorked: 10, isNonBillable: false, billingApprovalDateTime: '2026-08-05T00:00:00Z', dateWorked: '2026-08-04' }, // 10*50=500 cost, billable+approved
        { resourceID: 2, hoursWorked: 4, isNonBillable: true, dateWorked: '2026-08-06' },  // 4*100=400 cost, non-billable → drag
      ],
      billingItems: [
        { totalAmount: 1200, ourCost: 0, billingItemType: 1, nonBillable: 0, postedDate: '2026-08-10' }, // labor revenue, posted
        { totalAmount: 300, ourCost: 180, billingItemType: 3, nonBillable: 0, postedDate: '2026-08-10' }, // materials: rev 300, cost 180
        { totalAmount: 999, ourCost: 0, billingItemType: 1, nonBillable: 0, postedDate: null },           // NOT posted → ignored
      ],
    });
    const m = r.buckets.find((b) => b.period === '2026-08')!;
    expect(m.laborHours).toBe(14);
    expect(m.laborCost).toBe(900);        // 500 + 400 (non-billable still costs)
    expect(m.materialsCost).toBe(180);
    expect(m.totalCost).toBe(1080);
    expect(m.postedRevenue).toBe(1500);   // 1200 + 300 (the null-posted 999 excluded)
    expect(m.realizedMargin).toBe(420);   // 1500 - 1080
    expect(r.totals.realizedMargin).toBe(420);
  });

  test('pending billable hours = billable + not yet approved', () => {
    const r = computeProjectPL({
      scope: 'ticket', entityId: 5, bucket: 'month', burdenByResource: burden,
      timeEntries: [
        { resourceID: 1, hoursWorked: 3, isNonBillable: false, billingApprovalDateTime: null, dateWorked: '2026-08-01' }, // pending
        { resourceID: 1, hoursWorked: 2, isNonBillable: false, billingApprovalDateTime: '2026-08-02T00:00:00Z', dateWorked: '2026-08-01' }, // approved
        { resourceID: 1, hoursWorked: 1, isNonBillable: true, dateWorked: '2026-08-01' }, // non-billable, not pending revenue
      ],
      billingItems: [],
    });
    expect(r.totals.pendingBillableHours).toBe(3);
  });

  test('cost-coverage flag: hours from a resource with no burden are surfaced', () => {
    const r = computeProjectPL({
      scope: 'task', entityId: 9, bucket: 'month', burdenByResource: burden,
      timeEntries: [
        { resourceID: 3, hoursWorked: 8, isNonBillable: false, dateWorked: '2026-08-01' }, // resource 3 = no burden
        { resourceID: 1, hoursWorked: 2, isNonBillable: false, dateWorked: '2026-08-01' },
      ],
      billingItems: [],
    });
    expect(r.costCoverage.hoursNoBurden).toBe(8);
    expect(r.costCoverage.resourcesMissingBurden).toEqual([3]);
    // resource 3's 8h contribute 0 cost (unknown), resource 1's 2h = 100
    expect(r.totals.laborCost).toBe(100);
    expect(r.totals.laborHours).toBe(10);
  });

  test('buckets split by week', () => {
    const r = computeProjectPL({
      scope: 'project', entityId: 1, bucket: 'week', burdenByResource: burden,
      timeEntries: [
        { resourceID: 1, hoursWorked: 5, dateWorked: '2026-08-04' }, // week of 8/03
        { resourceID: 1, hoursWorked: 5, dateWorked: '2026-08-11' }, // week of 8/10
      ],
      billingItems: [],
    });
    expect(r.buckets.map((b) => b.period)).toEqual(['2026-08-03', '2026-08-10']);
  });

  test('marginPct null when no revenue', () => {
    const r = computeProjectPL({ scope: 'task', entityId: 1, bucket: 'month', burdenByResource: burden,
      timeEntries: [{ resourceID: 1, hoursWorked: 1, dateWorked: '2026-08-01' }], billingItems: [] });
    expect(r.totals.postedRevenue).toBe(0);
    expect(r.totals.marginPct).toBeNull();
    expect(r.totals.realizedMargin).toBe(-50); // pure cost, no revenue
  });
});
