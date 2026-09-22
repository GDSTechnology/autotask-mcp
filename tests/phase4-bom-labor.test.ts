// #46 §9 — calculate_bom_labor: BOM quantities + rate catalog → calculated hours
// per phase + repeated tasks. Pure.

import { computeBomLabor } from '../src/utils/bom-labor';

const items = [
  { item: 'Cat6 data drops', quantity: 48 },
  { item: 'wireless access points', quantity: 12 },
  { item: 'core switch', quantity: 1 },
];

describe('computeBomLabor', () => {
  test('computes hours from matched rates and groups by phase', () => {
    const r = computeBomLabor({
      items,
      rates: [
        { match: 'data drop', minutesPerUnit: 30, phaseRef: 'rough-in', taskTitle: 'Pull & terminate drops' },
        { match: 'access point', hoursPerUnit: 1, phaseRef: 'install' },
        { match: 'switch', hoursPerUnit: 4, phaseRef: 'install' },
      ],
    });
    const drops = r.lines.find((l) => /data drops/i.test(l.item))!;
    expect(drops.hours).toBe(24);          // 48 × 30min = 24h
    expect(drops.phaseRef).toBe('rough-in');
    expect(r.byPhase['rough-in']).toBe(24);
    expect(r.byPhase['install']).toBe(16); // 12×1 + 1×4
    expect(r.totalHours).toBe(40);
    expect(r.matchedItems).toBe(3);
    expect(r.calculatedHoursByPhase).toEqual(r.byPhase); // alias for §10
  });

  test('laborMultiplier scales hours (e.g. 2 terminations per drop)', () => {
    const r = computeBomLabor({
      items: [{ item: 'data drops', quantity: 10 }],
      rates: [{ match: 'drop', minutesPerUnit: 30, laborMultiplier: 2, phaseRef: 'p1' }],
    });
    expect(r.byPhase['p1']).toBe(10);      // 10 × 0.5h × 2 = 10
    expect(r.lines[0].hoursPerUnit).toBe(1); // 0.5 × 2
  });

  test('emits repeated tasks with refs + phase for the build plan', () => {
    const r = computeBomLabor({
      items: [{ item: 'cameras', quantity: 8 }],
      rates: [{ match: 'camera', hoursPerUnit: 1.5, phaseRef: 'install', taskTitle: 'Mount & aim cameras' }],
    });
    expect(r.tasks[0]).toMatchObject({ ref: 'bom-1', title: 'Mount & aim cameras', estimatedHours: 12, phaseRef: 'install', quantity: 8 });
  });

  test('unmatched items are flagged, never guessed', () => {
    const r = computeBomLabor({
      items: [{ item: 'mystery widget', quantity: 5 }],
      rates: [{ match: 'drop', minutesPerUnit: 30 }],
    });
    expect(r.unmatched).toEqual([{ item: 'mystery widget', quantity: 5 }]);
    expect(r.totalHours).toBe(0);
    expect(r.warnings.some((w) => /matched no rate/.test(w))).toBe(true);
  });

  test('defaultHoursPerUnit covers unmatched items when set', () => {
    const r = computeBomLabor({
      items: [{ item: 'mystery widget', quantity: 4 }],
      rates: [],
      defaultHoursPerUnit: 0.25,
      defaultPhaseRef: 'misc',
    });
    expect(r.unmatched).toHaveLength(0);
    expect(r.byPhase['misc']).toBe(1);     // 4 × 0.25
    expect(r.lines[0].matched).toBe(false); // used default, not a real rate match
  });

  test('warns when no rate catalog supplied', () => {
    const r = computeBomLabor({ items, rates: [] });
    expect(r.warnings.some((w) => /No labor rate catalog/.test(w))).toBe(true);
    expect(r.totalHours).toBe(0);
  });

  test('matchAny matches any listed keyword', () => {
    const r = computeBomLabor({
      items: [{ item: 'AP', quantity: 3 }],
      rates: [{ matchAny: ['access point', 'ap', 'wifi'], hoursPerUnit: 1, phaseRef: 'install' }],
    });
    expect(r.byPhase['install']).toBe(3);
  });
});
