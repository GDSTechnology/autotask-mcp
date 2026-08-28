// Project structure assembly (Expansion Spec §Phase 4, #45). Pure — no tenant.

import { buildProjectHierarchy } from '../src/utils/project-structure';

describe('buildProjectHierarchy', () => {
  const project = { id: 152, projectName: 'WPM LV 2025' };
  const phases = [
    { id: 100, parentPhaseID: null, title: 'Rough In', estimatedHours: 96 },
    { id: 101, parentPhaseID: 100, title: 'Rough In - Level 1', estimatedHours: 40 }, // child of 100
    { id: 102, parentPhaseID: null, title: 'Administrative', estimatedHours: 9 },
  ];
  const tasks = [
    { id: 1, phaseID: 100, title: 'Cabling', status: 5 },
    { id: 2, phaseID: 101, title: 'Level 1 drops', status: 5 },
    { id: 3, phaseID: 102, title: 'Site walk', status: 5 },
    { id: 4, phaseID: null, title: 'Loose end', status: 1 },   // unphased
    { id: 5, phaseID: 999, title: 'Orphan phase ref', status: 1 }, // phase not present → unphased
  ];

  test('nests child phases, buckets tasks, collects unphased, computes summary', () => {
    const s = buildProjectHierarchy(project, phases as any, tasks as any);

    expect(s.phases).toHaveLength(2); // 100, 102 are roots
    const roughIn = s.phases.find((p) => p.id === 100)!;
    expect(roughIn.tasks.map((t) => t.id)).toEqual([1]);
    expect(roughIn.children).toHaveLength(1);
    expect(roughIn.children[0].id).toBe(101);
    expect(roughIn.children[0].tasks.map((t) => t.id)).toEqual([2]);

    expect(s.unphasedTasks.map((t) => t.id).sort()).toEqual([4, 5]);
    expect(s.summary).toMatchObject({
      phaseCount: 3, taskCount: 5, unphasedTaskCount: 2, maxPhaseDepth: 2, estimatedHours: 145,
    });
  });

  test('empty project', () => {
    const s = buildProjectHierarchy(null, [], []);
    expect(s.phases).toEqual([]);
    expect(s.summary).toMatchObject({ phaseCount: 0, taskCount: 0, maxPhaseDepth: 0 });
  });
});
