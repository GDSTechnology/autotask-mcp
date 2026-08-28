// Block-hour usage accounting (monthly, use-it-or-lose-it). Pure — no tenant.

import { computeBlockHourUsage } from '../src/utils/block-hours';

const asOf = new Date('2026-03-15T00:00:00Z'); // Jan+Feb ended; Mar current; later = future

describe('computeBlockHourUsage', () => {
  test('overage, forfeited (ended only), and current-month in-progress', () => {
    const blocks = [
      { hours: 10, startDate: '2026-01-01' },
      { hours: 10, startDate: '2026-02-01' },
      { hours: 10, startDate: '2026-03-01' },
      { hours: 10, startDate: '2026-05-01' }, // future
    ];
    const entries = [
      { dateWorked: '2026-01-10', hoursWorked: 15 }, // over by 5
      { dateWorked: '2026-02-10', hoursWorked: 4 },  // under → forfeit 6 (ended)
      { dateWorked: '2026-03-10', hoursWorked: 3 },  // current → not forfeited
    ];
    const u = computeBlockHourUsage(blocks, entries, asOf);

    const jan = u.months.find((m) => m.month === '2026-01')!;
    expect(jan).toMatchObject({ allocated: 10, used: 15, overage: 5, forfeited: 0, ended: true });
    const feb = u.months.find((m) => m.month === '2026-02')!;
    expect(feb).toMatchObject({ allocated: 10, used: 4, overage: 0, forfeited: 6, ended: true });
    const mar = u.months.find((m) => m.month === '2026-03')!;
    expect(mar).toMatchObject({ allocated: 10, used: 3, overage: 0, forfeited: 0, remaining: 7, ended: false });
    const may = u.months.find((m) => m.month === '2026-05')!;
    expect(may).toMatchObject({ allocated: 10, used: 0, forfeited: 0, ended: false }); // future not forfeited

    expect(u.totalAllocated).toBe(40);
    expect(u.totalUsed).toBe(22);
    expect(u.billableOverageHours).toBe(5);
    expect(u.forfeitedHours).toBe(6); // only Feb
    expect(u.monthsOver).toBe(1);
    expect(u.currentMonth).toBe('2026-03');
  });

  test('non-billable time does not consume the block', () => {
    const blocks = [{ hours: 5, startDate: '2026-01-01' }];
    const entries = [
      { dateWorked: '2026-01-05', hoursWorked: 4, isNonBillable: true },
      { dateWorked: '2026-01-06', hoursWorked: 3 },
    ];
    const u = computeBlockHourUsage(blocks, entries, asOf);
    expect(u.months[0]).toMatchObject({ used: 3, overage: 0, forfeited: 2 });
  });

  test('usage in a month with no block is all overage', () => {
    const u = computeBlockHourUsage([], [{ dateWorked: '2026-01-09', hoursWorked: 8 }], asOf);
    expect(u.months[0]).toMatchObject({ month: '2026-01', allocated: 0, used: 8, overage: 8 });
    expect(u.billableOverageHours).toBe(8);
  });

  test('empty inputs → zeroed current month', () => {
    const u = computeBlockHourUsage([], [], asOf);
    expect(u.months).toEqual([]);
    expect(u.totalAllocated).toBe(0);
    expect(u.currentMonth).toBe('2026-03');
  });

  test('malformed dates are skipped', () => {
    const u = computeBlockHourUsage([{ hours: 5, startDate: 'nope' }], [{ dateWorked: '', hoursWorked: 2 }], asOf);
    expect(u.months).toEqual([]);
  });
});
