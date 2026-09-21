// #100 — time-entry compliance / team hours: per resource × bucket hours vs
// expected, billable/non-billable, approved/unapproved, late entries + flags. Pure.

import { computeTimeEntryCompliance } from '../src/utils/time-entry-compliance';

// Week buckets are Monday-anchored (UTC). 2026-09-07 is a Monday.
const te = (o: Partial<Record<string, any>>) => ({ resourceID: 1, hoursWorked: 0, isNonBillable: false, dateWorked: '2026-09-07', createDateTime: '2026-09-07T17:00:00Z', ...o });

describe('computeTimeEntryCompliance', () => {
  test('sums hours per resource × week and computes utilization vs expected', () => {
    const r = computeTimeEntryCompliance([
      te({ hoursWorked: 20, dateWorked: '2026-09-07' }),
      te({ hoursWorked: 16, dateWorked: '2026-09-08' }), // same week
      te({ hoursWorked: 40, dateWorked: '2026-09-14' }), // next week, full
    ], '2026-09-07', '2026-09-20', { expectedHoursPerBucket: 40 });
    const res = r.byResource.find((x) => x.resourceID === 1)!;
    const w1 = res.buckets.find((b) => b.bucket === '2026-09-07')!;
    const w2 = res.buckets.find((b) => b.bucket === '2026-09-14')!;
    expect(w1.totalHours).toBe(36);
    expect(w1.utilizationPct).toBe(90);       // 36/40
    expect(w2.utilizationPct).toBe(100);      // 40/40
    expect(res.totals.totalHours).toBe(76);
    expect(res.totals.utilizationPct).toBe(95); // 76 / (40*2)
  });

  test('billable vs non-billable and approved vs unapproved split', () => {
    const r = computeTimeEntryCompliance([
      te({ hoursWorked: 30, isNonBillable: false, billingApprovalDateTime: '2026-09-10T00:00:00Z' }),
      te({ hoursWorked: 10, isNonBillable: true, billingApprovalDateTime: null }),
    ], '2026-09-07', '2026-09-13', { expectedHoursPerBucket: 40 });
    const t = r.byResource[0].totals;
    expect(t.billableHours).toBe(30);
    expect(t.nonBillableHours).toBe(10);
    expect(t.approvedHours).toBe(30);
    expect(t.unapprovedHours).toBe(10);
    expect(r.byResource[0].buckets[0].billableUtilizationPct).toBe(75); // 30/40
  });

  test('late entries: created > threshold days after the day worked', () => {
    const r = computeTimeEntryCompliance([
      te({ hoursWorked: 8, dateWorked: '2026-09-07', createDateTime: '2026-09-07T20:00:00Z' }), // same day, on time
      te({ hoursWorked: 8, dateWorked: '2026-09-07', createDateTime: '2026-09-12T09:00:00Z' }), // 5 days late
    ], '2026-09-07', '2026-09-13', { expectedHoursPerBucket: 40, lateThresholdDays: 2 });
    const b = r.byResource[0].buckets[0];
    expect(b.lateEntries).toBe(1);
    expect(b.lateHours).toBe(8);
  });

  test('flags: no_time, under_logged, low_billable_utilization, chronic_late_entry', () => {
    const r = computeTimeEntryCompliance([
      // resource 1: under-logged + low billable + chronic late (20h, all non-billable, all late)
      te({ resourceID: 1, hoursWorked: 20, isNonBillable: true, createDateTime: '2026-09-20T00:00:00Z' }),
    ], '2026-09-07', '2026-09-13', { expectedHoursPerBucket: 40, lateThresholdDays: 2 });
    const flags = r.byResource[0].buckets[0].flags;
    expect(flags).toContain('under_logged');            // 20 < 40*0.9
    expect(flags).toContain('low_billable_utilization'); // 0 billable
    expect(flags).toContain('chronic_late_entry');       // 20/20 late
    expect(flags).not.toContain('no_time');
    expect(r.flagged).toContain(1);
  });

  test('resource names attached when supplied; worst-logged sorted first', () => {
    const names = new Map([[1, 'Alice A'], [2, 'Bob B']]);
    const r = computeTimeEntryCompliance([
      te({ resourceID: 1, hoursWorked: 40 }),
      te({ resourceID: 2, hoursWorked: 5 }),
    ], '2026-09-07', '2026-09-13', { expectedHoursPerBucket: 40, resourceNames: names });
    expect(r.byResource[0].resourceID).toBe(2);          // worst-logged first
    expect(r.byResource[0].resourceName).toBe('Bob B');
    expect(r.resourcesEvaluated).toBe(2);
  });

  test('data quality: entries missing create date / resource are counted, not fatal', () => {
    const r = computeTimeEntryCompliance([
      te({ hoursWorked: 8, createDateTime: null }),
      { resourceID: null, hoursWorked: 4, dateWorked: '2026-09-07' } as any,
    ], '2026-09-07', '2026-09-13');
    expect(r.dataQuality.entriesMissingCreateDate).toBe(1);
    expect(r.dataQuality.entriesMissingResource).toBe(1);
    expect(r.byResource[0].totals.totalHours).toBe(8);   // the resourceless entry is skipped
  });

  test('month bucket derives expected from expectedHoursPerWeek', () => {
    const r = computeTimeEntryCompliance([te({ hoursWorked: 100 })], '2026-09-01', '2026-09-30', { bucket: 'month', expectedHoursPerWeek: 40 });
    expect(r.bucket).toBe('month');
    expect(r.expectedHoursPerBucket).toBe(173); // round(40*52/12)
    expect(r.byResource[0].buckets[0].bucket).toBe('2026-09');
  });
});
