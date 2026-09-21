// #102 slice 1 — generate_sla_framework: ITIL SLA setup helper (advisory, pure).
// Priority matrix, clean scheme, target matrix (priority × request type × tier),
// and current-priority migration classification.

import { generateSlaFramework } from '../src/utils/sla-framework';

describe('generateSlaFramework', () => {
  test('defaults: 4-level scheme, Impact×Urgency matrix, both request types, single tier', () => {
    const r = generateSlaFramework();
    expect(r.levels).toBe(4);
    expect(r.priorityScheme.map((p) => p.code)).toEqual(['P1', 'P2', 'P3', 'P4']);
    // matrix is 3×3 with the standard ITIL mapping
    expect(r.priorityMatrix).toHaveLength(9);
    const cell = (i: string, u: string) => r.priorityMatrix.find((c) => c.impact === i && c.urgency === u)!.priority;
    expect(cell('High', 'High')).toBe('P1');
    expect(cell('High', 'Low')).toBe('P3');
    expect(cell('Low', 'Low')).toBe('P4');
    // both request types, one implicit tier → 4 levels × 2 types × 1 tier = 8 rows
    expect(r.targets).toHaveLength(8);
    expect(new Set(r.targets.map((t) => t.tier))).toEqual(new Set(['Standard']));
    expect(r.priorityMigration).toBeNull();
  });

  test('P1 defaults to 24x7 wall-clock targets from the ITIL template', () => {
    const r = generateSlaFramework();
    const p1 = r.priorityScheme.find((p) => p.code === 'P1')!;
    expect(p1.coverage).toBe('24x7');
    expect(p1.firstResponse).toMatchObject({ minutes: 15, businessHours: false, label: '15 min' });
    expect(p1.resolution).toMatchObject({ minutes: 240, businessHours: false, label: '4 hours' });
    const p3 = r.priorityScheme.find((p) => p.code === 'P3')!;
    expect(p3.coverage).toBe('8x5');
    expect(p3.resolution).toMatchObject({ minutes: 1440, businessHours: true, label: '3 bus. days' });
  });

  test('Service Request rows loosen plan/resolution but keep first response', () => {
    const r = generateSlaFramework({ serviceRequestResolutionMultiplier: 2 });
    const inc = r.targets.find((t) => t.priority === 'P3' && t.requestType === 'Incident')!;
    const req = r.targets.find((t) => t.priority === 'P3' && t.requestType === 'ServiceRequest')!;
    expect(req.firstResponse.minutes).toBe(inc.firstResponse.minutes);        // same responsiveness
    expect(req.resolution.minutes).toBe(inc.resolution.minutes * 2);          // looser resolution
  });

  test('tiers multiply durations and can override coverage', () => {
    const r = generateSlaFramework({
      requestTypes: ['Incident'],
      tiers: [
        { name: 'Premier', multiplier: 1 },
        { name: 'Break-Fix', multiplier: 2, coverage: '8x5' },
      ],
    });
    const premP1 = r.targets.find((t) => t.tier === 'Premier' && t.priority === 'P1')!;
    const bfP1 = r.targets.find((t) => t.tier === 'Break-Fix' && t.priority === 'P1')!;
    expect(bfP1.firstResponse.minutes).toBe(premP1.firstResponse.minutes * 2);
    expect(premP1.coverage).toBe('24x7');   // level default
    expect(bfP1.coverage).toBe('8x5');       // tier forces business-hours
    // 4 levels × 1 type × 2 tiers = 8 rows
    expect(r.targets).toHaveLength(8);
  });

  test('5-level scheme adds P5 and routes the calm corner to it', () => {
    const r = generateSlaFramework({ levels: 5 });
    expect(r.priorityScheme.map((p) => p.code)).toContain('P5');
    expect(r.priorityMatrix.find((c) => c.impact === 'Low' && c.urgency === 'Low')!.priority).toBe('P5');
  });

  test('overrides replace default minutes for a priority', () => {
    const r = generateSlaFramework({ overrides: { P1: { resolution: 120 } } });
    expect(r.priorityScheme.find((p) => p.code === 'P1')!.resolution.minutes).toBe(120);
  });

  test('migration classifies a messy priority list into the clean scheme', () => {
    const r = generateSlaFramework({
      currentPriorities: ['Critical', 'High-Next Day', 'Medium', 'Low', 'Repairs', 'Schedule Maintenance', 'High-Same Day'],
    });
    const by = Object.fromEntries(r.priorityMigration!.map((m) => [m.current, m]));
    expect(by['Critical']).toMatchObject({ classify: 'severity', recommend: 'P1' });
    expect(by['Medium']).toMatchObject({ classify: 'severity', recommend: 'P3' });
    expect(by['Low']).toMatchObject({ classify: 'severity', recommend: 'P4' });
    // severity + a time qualifier → stays a severity but notes the timing moves to the SLA
    expect(by['High-Next Day']).toMatchObject({ classify: 'severity', recommend: 'P2' });
    expect(by['High-Next Day'].rationale).toMatch(/SLA/i);
    // work-type and planned are not severities
    expect(by['Repairs'].classify).toBe('work-type');
    expect(by['Schedule Maintenance']).toMatchObject({ classify: 'planned' });
    expect(by['Schedule Maintenance'].recommend).toMatch(/Change/);
  });

  test('advisory notes make the UI-only constraint explicit', () => {
    const r = generateSlaFramework();
    expect(r.notes.join(' ')).toMatch(/ADVISORY ONLY/);
    expect(r.uiSteps.some((s) => /Service Level Management/.test(s))).toBe(true);
  });
});
