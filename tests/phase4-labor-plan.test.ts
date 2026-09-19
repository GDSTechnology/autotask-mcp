// #46 §10 — generate_project_labor_plan: planned vs quoted vs calculated hours
// per phase with material-variance flags. Pure.

import { generateProjectLaborPlan } from '../src/utils/project-labor-plan';
import type { ProjectBuildPlan } from '../src/utils/project-plan';

const plan: ProjectBuildPlan = {
  name: 'Cabling job',
  phases: [{ ref: 'p1', title: 'Rough-in' }, { ref: 'p2', title: 'Trim & Test' }],
  tasks: [
    { ref: 't1', title: 'Pull cable', estimatedHours: 40, phaseRef: 'p1' },
    { ref: 't2', title: 'Terminate', estimatedHours: 20, phaseRef: 'p2' },
    { ref: 't3', title: 'Test', estimatedHours: 4, phaseRef: 'p2' },
    { ref: 't4', title: 'Punch list', estimatedHours: 3 }, // unphased
  ],
};

describe('generateProjectLaborPlan', () => {
  test('sums planned hours per phase (+ unphased) and totals', () => {
    const r = generateProjectLaborPlan({ plan });
    const p1 = r.phases.find((p) => p.phaseRef === 'p1')!;
    const p2 = r.phases.find((p) => p.phaseRef === 'p2')!;
    const un = r.phases.find((p) => p.phaseRef === null)!;
    expect(p1.plannedHours).toBe(40);
    expect(p2.plannedHours).toBe(24);
    expect(un.title).toBe('Unphased');
    expect(un.plannedHours).toBe(3);
    expect(r.totals.plannedHours).toBe(67);
    expect(r.totals.quotedHours).toBeNull(); // none supplied
  });

  test('flags phases over/under quoted beyond the threshold', () => {
    const r = generateProjectLaborPlan({
      plan,
      quotedHoursByPhase: { p1: 32, p2: 24 }, // p1 planned 40 vs 32 = +25% (>15%); p2 exact
      varianceThresholdPct: 0.15,
    });
    const p1 = r.phases.find((p) => p.phaseRef === 'p1')!;
    const p2 = r.phases.find((p) => p.phaseRef === 'p2')!;
    expect(p1.plannedVsQuoted).toEqual({ deltaHours: 8, deltaPct: 0.25 });
    expect(p1.flags).toContain('over_quoted');
    expect(p1.flagged).toBe(true);
    expect(p2.flagged).toBe(false); // exact match
    expect(r.flaggedPhases).toBe(1);
    expect(r.totals.quotedHours).toBe(56);
    expect(r.totals.plannedVsQuoted!.deltaHours).toBe(11); // 67 - 56
  });

  test('under_quoted flag when planned is materially below quote', () => {
    const r = generateProjectLaborPlan({ plan, quotedHoursByPhase: { p1: 60 } }); // planned 40 vs 60 = -33%
    const p1 = r.phases.find((p) => p.phaseRef === 'p1')!;
    expect(p1.flags).toContain('under_quoted');
  });

  test('calculated view flagged independently', () => {
    const r = generateProjectLaborPlan({ plan, calculatedHoursByPhase: { p1: 40, p2: 40 } });
    const p2 = r.phases.find((p) => p.phaseRef === 'p2')!;
    expect(p2.plannedVsCalculated!.deltaHours).toBe(-16);
    expect(p2.flags).toContain('under_calculated');
  });

  test('quoted phase with 0 hours but planned > 0 is always material', () => {
    const r = generateProjectLaborPlan({ plan, quotedHoursByPhase: { p1: 0 } });
    const p1 = r.phases.find((p) => p.phaseRef === 'p1')!;
    expect(p1.plannedVsQuoted).toEqual({ deltaHours: 40, deltaPct: null });
    expect(p1.flags).toContain('over_quoted');
  });

  test('totals fall back to supplied totals over per-phase sums', () => {
    const r = generateProjectLaborPlan({ plan, quotedHoursTotal: 70 });
    expect(r.totals.quotedHours).toBe(70);
    expect(r.totals.plannedVsQuoted!.deltaHours).toBe(-3); // 67 - 70
  });
});
