// Project blueprint export (Phase 4 §2.3, #46). Pure — no tenant.

import { toProjectBlueprint } from '../src/utils/project-blueprint';

describe('toProjectBlueprint', () => {
  const structure = {
    project: { id: 152, projectName: 'WPM LV 2025', companyID: 999, status: 5 },
    phases: [
      {
        id: 100, parentPhaseID: null, title: 'Rough In', estimatedHours: 96,
        tasks: [{ id: 1, phaseID: 100, title: 'Cabling', estimatedHours: 24, taskType: 1, assignedResourceID: 5, startDateTime: '2025-08-28' }],
        children: [
          { id: 101, parentPhaseID: 100, title: 'Level 1', estimatedHours: 40, tasks: [{ id: 2, title: 'Drops', estimatedHours: 10 }], children: [] },
        ],
      },
    ],
    unphasedTasks: [{ id: 9, phaseID: null, title: 'Loose end', estimatedHours: 2 }],
    summary: { phaseCount: 2, taskCount: 3, estimatedHours: 146 },
  };

  test('strips tenant-specific ids/resources/dates; keeps structure + hours', () => {
    const bp = toProjectBlueprint(structure as any);
    expect(bp).toMatchObject({ name: 'WPM LV 2025', sourceProjectID: 152, phaseCount: 2, taskCount: 3, estimatedHours: 146 });

    const rough = bp.phases[0];
    expect(rough).toMatchObject({ title: 'Rough In', estimatedHours: 96 });
    expect(rough.tasks[0]).toEqual({ title: 'Cabling', estimatedHours: 24, taskType: 1 }); // no id/resource/date
    expect(rough.tasks[0]).not.toHaveProperty('assignedResourceID');
    expect(rough.tasks[0]).not.toHaveProperty('startDateTime');
    expect(rough.children[0]).toMatchObject({ title: 'Level 1', estimatedHours: 40 });
    expect(rough.children[0].tasks[0]).toEqual({ title: 'Drops', estimatedHours: 10 });

    expect(bp.unphasedTasks).toEqual([{ title: 'Loose end', estimatedHours: 2 }]);
    // no phase id leaked anywhere
    expect(JSON.stringify(bp)).not.toContain('"id"');
    expect(JSON.stringify(bp)).not.toContain('parentPhaseID');
  });

  test('empty structure', () => {
    const bp = toProjectBlueprint({});
    expect(bp).toMatchObject({ name: 'Untitled Project', sourceProjectID: null, phases: [], unphasedTasks: [] });
  });
});
