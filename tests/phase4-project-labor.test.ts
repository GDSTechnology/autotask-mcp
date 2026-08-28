// Project labor summary (Phase 4 §4.5, #45). Pure — no tenant.

import { summarizeProjectLabor } from '../src/utils/project-labor';

describe('summarizeProjectLabor', () => {
  const tasks = [
    { id: 1, phaseID: 100, estimatedHours: 40 },
    { id: 2, phaseID: 100, estimatedHours: 10 },
    { id: 3, phaseID: 200, estimatedHours: 5 },
  ];
  const entries = [
    { taskID: 1, hoursWorked: 24, hoursToBill: 24, isNonBillable: false, dateWorked: '2026-08-28' },
    { taskID: 1, hoursWorked: 20, hoursToBill: 20, isNonBillable: false, dateWorked: '2026-08-29' },
    { taskID: 2, hoursWorked: 3, hoursToBill: 0, isNonBillable: true, dateWorked: '2026-08-27' },
    { taskID: 3, hoursWorked: 8, hoursToBill: 8, isNonBillable: false, dateWorked: '2026-08-30' },
  ];

  test('totals, variance, billable split, per-phase, date range', () => {
    const s = summarizeProjectLabor(tasks as any, entries as any);
    expect(s.estimatedHours).toBe(55);
    expect(s.actualHours).toBe(55);       // 24+20+3+8
    expect(s.billableHours).toBe(52);     // excludes the 3h non-billable
    expect(s.nonBillableHours).toBe(3);
    expect(s.variance).toBe(0);
    expect(s.firstWorked).toBe('2026-08-27');
    expect(s.lastWorked).toBe('2026-08-30');
    const p100 = s.byPhase.find((p) => p.phaseID === 100)!;
    expect(p100).toMatchObject({ estimatedHours: 50, actualHours: 47, billableHours: 44 });
  });

  test('entry on an unknown task falls into the null phase', () => {
    const s = summarizeProjectLabor([], [{ taskID: 999, hoursWorked: 5, isNonBillable: false }] as any);
    expect(s.actualHours).toBe(5);
    expect(s.byPhase[0].phaseID).toBeNull();
  });
});
