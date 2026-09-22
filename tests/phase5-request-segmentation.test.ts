// #100 — request segmentation dimension: classify tickets into delivery segments
// (caller rules, ITIL default) + per-segment KPIs. Pure.

import { classifyRequestSegment, computeRequestSegmentation, DEFAULT_ITIL_SEGMENTS } from '../src/utils/request-segmentation';

const NOW = new Date('2026-09-30T12:00:00Z');

describe('classifyRequestSegment', () => {
  const rules = [
    { name: 'Project', queueID: [10] },
    { name: 'Install', titleContains: ['install', 'deployment'] },
    { name: 'Managed', ticketType: [1], priority: [3] },
  ];
  test('first matching rule wins; AND across criteria', () => {
    expect(classifyRequestSegment({ id: 1, queueID: 10 }, rules, 'Support')).toBe('Project');
    expect(classifyRequestSegment({ id: 2, title: 'New PBX Install' }, rules, 'Support')).toBe('Install');
    expect(classifyRequestSegment({ id: 3, ticketType: 1, priority: 3 }, rules, 'Support')).toBe('Managed');
    expect(classifyRequestSegment({ id: 4, ticketType: 1, priority: 1 }, rules, 'Support')).toBe('Support'); // priority mismatch
    expect(classifyRequestSegment({ id: 5 }, rules, 'Support')).toBe('Support'); // no match
  });
});

describe('computeRequestSegmentation', () => {
  test('falls back to ITIL classification by ticketType when no rules', () => {
    const r = computeRequestSegmentation([
      { id: 1, ticketType: 2, completedDate: null, createDate: '2026-09-20' }, // Incident, open
      { id: 2, ticketType: 1, completedDate: '2026-09-25' },                    // Service Request, done
      { id: 3, ticketType: 4 },                                                 // Change
      { id: 4, ticketType: 99 },                                                // unknown → Other
    ], '2026-09-01', '2026-09-30', { now: NOW });
    expect(r.rulesUsed).toBe('default-itil');
    const by = Object.fromEntries(r.segments.map((s) => [s.name, s]));
    expect(by['Incident'].total).toBe(1);
    expect(by['Incident'].open).toBe(1);
    expect(by['Service Request'].completed).toBe(1);
    expect(by['Other'].total).toBe(1);
  });

  test('per-segment KPIs: open/completed, avg open age, share %', () => {
    const r = computeRequestSegmentation([
      { id: 1, queueID: 10, createDate: '2026-09-20', completedDate: null }, // Project, open 10d
      { id: 2, queueID: 10, createDate: '2026-09-10', completedDate: null }, // Project, open 20d
      { id: 3, completedDate: '2026-09-15' },                                 // Support, completed
    ], '2026-09-01', '2026-09-30', { segments: [{ name: 'Project', queueID: [10] }], now: NOW });
    expect(r.rulesUsed).toBe('custom');
    const proj = r.segments.find((s) => s.name === 'Project')!;
    expect(proj).toMatchObject({ total: 2, open: 2, completed: 0 });
    expect(proj.avgAgeDaysOpen).toBe(15.5);     // (10.5+20.5)/2 — fractional from noon "now"
    expect(proj.sharePct).toBeCloseTo(66.7, 1);
    const sup = r.segments.find((s) => s.name === 'Unsegmented')!;
    expect(sup.total).toBe(1);
  });

  test('empty default bucket is hidden; declared order preserved', () => {
    const r = computeRequestSegmentation([
      { id: 1, queueID: 10 }, { id: 2, queueID: 11 },
    ], 'a', 'b', { segments: [{ name: 'A', queueID: [10] }, { name: 'B', queueID: [11] }], now: NOW });
    expect(r.segments.map((s) => s.name)).toEqual(['A', 'B']); // no empty "Unsegmented"
  });

  test('DEFAULT_ITIL_SEGMENTS covers the five ticket types', () => {
    expect(DEFAULT_ITIL_SEGMENTS.map((s) => s.name)).toEqual(['Service Request', 'Incident', 'Problem', 'Change', 'Alert']);
  });
});
