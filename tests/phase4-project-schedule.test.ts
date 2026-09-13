// Deterministic scheduler + build-plan validator (Phase 4 §11, #46 Layer 2).
import { validateBuildPlan, ProjectBuildPlan } from '../src/utils/project-plan';
import { calculateProjectSchedule } from '../src/utils/project-schedule';

// 2026-01-05 is a Monday; 01-09 Fri, 01-10 Sat, 01-11 Sun, 01-12 Mon.
const MON = '2026-01-05';

function plan(tasks: ProjectBuildPlan['tasks'], phases: ProjectBuildPlan['phases'] = []): ProjectBuildPlan {
  return { name: 'Test', phases, tasks };
}

describe('validateBuildPlan', () => {
  test('accepts a well-formed plan', () => {
    const r = validateBuildPlan(plan([
      { ref: 'a', title: 'A', estimatedHours: 8 },
      { ref: 'b', title: 'B', estimatedHours: 8, predecessors: ['a'] },
    ]));
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test('flags duplicate task refs', () => {
    const r = validateBuildPlan(plan([
      { ref: 'a', title: 'A', estimatedHours: 1 },
      { ref: 'a', title: 'A2', estimatedHours: 1 },
    ]));
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/duplicate task ref "a"/);
  });

  test('flags unknown predecessor', () => {
    const r = validateBuildPlan(plan([{ ref: 'a', title: 'A', estimatedHours: 1, predecessors: ['ghost'] }]));
    expect(r.errors.join(' ')).toMatch(/unknown predecessor "ghost"/);
  });

  test('flags self-predecessor', () => {
    const r = validateBuildPlan(plan([{ ref: 'a', title: 'A', estimatedHours: 1, predecessors: ['a'] }]));
    expect(r.errors.join(' ')).toMatch(/lists itself as a predecessor/);
  });

  test('detects a dependency cycle', () => {
    const r = validateBuildPlan(plan([
      { ref: 'a', title: 'A', estimatedHours: 1, predecessors: ['b'] },
      { ref: 'b', title: 'B', estimatedHours: 1, predecessors: ['a'] },
    ]));
    expect(r.valid).toBe(false);
    expect(r.errors.join(' ')).toMatch(/dependency cycle/);
  });

  test('flags unknown phaseRef and phase parent cycle', () => {
    const bad = validateBuildPlan(plan(
      [{ ref: 't', title: 'T', estimatedHours: 1, phaseRef: 'nope' }],
      [{ ref: 'p1', title: 'P1', parentRef: 'p2' }, { ref: 'p2', title: 'P2', parentRef: 'p1' }]
    ));
    expect(bad.errors.join(' ')).toMatch(/unknown phaseRef "nope"/);
    expect(bad.errors.join(' ')).toMatch(/phase parent cycle/);
  });

  test('warns on empty task list but stays valid', () => {
    const r = validateBuildPlan(plan([]));
    expect(r.valid).toBe(true);
    expect(r.warnings.join(' ')).toMatch(/no tasks/);
  });
});

describe('calculateProjectSchedule', () => {
  test('linear chain lays tasks out on consecutive working days', () => {
    const s = calculateProjectSchedule(
      plan([
        { ref: 'a', title: 'A', estimatedHours: 8 },
        { ref: 'b', title: 'B', estimatedHours: 8, predecessors: ['a'] },
      ]),
      { startDate: MON }
    );
    const a = s.tasks.find((t) => t.ref === 'a')!;
    const b = s.tasks.find((t) => t.ref === 'b')!;
    expect([a.startDate, a.endDate]).toEqual(['2026-01-05', '2026-01-05']);
    expect([b.startDate, b.endDate]).toEqual(['2026-01-06', '2026-01-06']);
    expect(s.targetCompletionDate).toBe('2026-01-06');
    expect(s.durationWorkingDays).toBe(2);
    expect(s.criticalPath).toEqual(['a', 'b']);
  });

  test('duration = ceil(hours / (crew × hoursPerDay))', () => {
    const s = calculateProjectSchedule(
      plan([
        { ref: 'ceil', title: 'ceil', estimatedHours: 10 },            // ceil(10/8)=2
        { ref: 'crew', title: 'crew', estimatedHours: 16, crewSize: 2 }, // 16/(2*8)=1
      ]),
      { startDate: MON }
    );
    expect(s.tasks.find((t) => t.ref === 'ceil')!.durationDays).toBe(2);
    expect(s.tasks.find((t) => t.ref === 'crew')!.durationDays).toBe(1);
  });

  test('skips weekends between dependent tasks', () => {
    const s = calculateProjectSchedule(
      plan([
        { ref: 'a', title: 'A', estimatedHours: 8 },
        { ref: 'b', title: 'B', estimatedHours: 8, predecessors: ['a'] },
      ]),
      { startDate: '2026-01-09' } // Friday
    );
    expect(s.tasks.find((t) => t.ref === 'a')!.endDate).toBe('2026-01-09');
    expect(s.tasks.find((t) => t.ref === 'b')!.startDate).toBe('2026-01-12'); // Monday
  });

  test('rolls a weekend start forward to the next working day', () => {
    const s = calculateProjectSchedule(plan([{ ref: 'a', title: 'A', estimatedHours: 8 }]), {
      startDate: '2026-01-03', // Saturday
    });
    expect(s.startDate).toBe('2026-01-05');
  });

  test('skips holidays inside a multi-day task', () => {
    const s = calculateProjectSchedule(plan([{ ref: 'a', title: 'A', estimatedHours: 16 }]), {
      startDate: MON,
      holidays: ['2026-01-06'], // Tuesday off
    });
    // 2 working days starting Mon, skipping Tue holiday → Mon + Wed
    expect(s.tasks[0].endDate).toBe('2026-01-07');
  });

  test('parallel independent tasks both start at the project start', () => {
    const s = calculateProjectSchedule(
      plan([
        { ref: 'a', title: 'A', estimatedHours: 8 },
        { ref: 'b', title: 'B', estimatedHours: 8 },
      ]),
      { startDate: MON }
    );
    expect(s.tasks.every((t) => t.startDate === '2026-01-05')).toBe(true);
    expect(s.targetCompletionDate).toBe('2026-01-05');
  });

  test('milestone is zero-duration and lands after its predecessor', () => {
    const s = calculateProjectSchedule(
      plan([
        { ref: 'a', title: 'A', estimatedHours: 8 },
        { ref: 'm', title: 'Phase 1 done', estimatedHours: 0, milestone: true, predecessors: ['a'] },
      ]),
      { startDate: MON }
    );
    const m = s.tasks.find((t) => t.ref === 'm')!;
    expect(m.durationDays).toBe(0);
    expect(m.startDate).toBe('2026-01-06');
    expect(s.milestones).toEqual([{ ref: 'm', title: 'Phase 1 done', date: '2026-01-06' }]);
  });

  test('critical path follows the longest chain, not a shorter parallel one', () => {
    const s = calculateProjectSchedule(
      plan([
        { ref: 'a', title: 'A', estimatedHours: 8 },
        { ref: 'b', title: 'B', estimatedHours: 8, predecessors: ['a'] },
        { ref: 'd', title: 'D', estimatedHours: 8, predecessors: ['b'] },
        { ref: 'c', title: 'C (short)', estimatedHours: 8 }, // parallel, finishes day 1
      ]),
      { startDate: MON }
    );
    expect(s.criticalPath).toEqual(['a', 'b', 'd']);
    expect(s.tasks.find((t) => t.ref === 'c')!.isCritical).toBe(false);
    expect(s.tasks.find((t) => t.ref === 'd')!.isCritical).toBe(true);
    expect(s.targetCompletionDate).toBe('2026-01-07'); // Wed
  });

  test('lagDays inserts working-day gap after predecessors', () => {
    const s = calculateProjectSchedule(
      plan([
        { ref: 'a', title: 'A', estimatedHours: 8 },
        { ref: 'b', title: 'B', estimatedHours: 8, predecessors: ['a'], lagDays: 2 },
      ]),
      { startDate: MON }
    );
    // A finishes Mon 01-05; +1 working day = Tue, +2 lag = Thu 01-08
    expect(s.tasks.find((t) => t.ref === 'b')!.startDate).toBe('2026-01-08');
  });

  test('warns when target completion exceeds the requested deadline', () => {
    const s = calculateProjectSchedule(
      plan([
        { ref: 'a', title: 'A', estimatedHours: 8 },
        { ref: 'b', title: 'B', estimatedHours: 8, predecessors: ['a'] },
      ]),
      { startDate: MON, targetCompletionDate: '2026-01-05' }
    );
    expect(s.warnings.join(' ')).toMatch(/past the requested 2026-01-05/);
  });

  test('is deterministic — identical inputs yield identical output', () => {
    const p = plan([
      { ref: 'a', title: 'A', estimatedHours: 12 },
      { ref: 'b', title: 'B', estimatedHours: 6, predecessors: ['a'] },
      { ref: 'c', title: 'C', estimatedHours: 20, predecessors: ['a'] },
    ]);
    const opts = { startDate: MON, hoursPerDay: 8, defaultCrewSize: 1, holidays: ['2026-01-08'] };
    expect(calculateProjectSchedule(p, opts)).toEqual(calculateProjectSchedule(p, opts));
  });

  test('throws on an invalid plan', () => {
    expect(() =>
      calculateProjectSchedule(
        plan([
          { ref: 'a', title: 'A', estimatedHours: 1, predecessors: ['b'] },
          { ref: 'b', title: 'B', estimatedHours: 1, predecessors: ['a'] },
        ]),
        { startDate: MON }
      )
    ).toThrow(/invalid plan/);
  });

  test('rejects bad options', () => {
    const p = plan([{ ref: 'a', title: 'A', estimatedHours: 8 }]);
    expect(() => calculateProjectSchedule(p, { startDate: 'nope' })).toThrow(/ISO date/);
    expect(() => calculateProjectSchedule(p, { startDate: MON, hoursPerDay: 0 })).toThrow(/hoursPerDay/);
    expect(() => calculateProjectSchedule(p, { startDate: MON, workweek: [] })).toThrow(/at least one working day/);
  });
});
