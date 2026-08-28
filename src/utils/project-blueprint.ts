// Project blueprint export (Expansion Spec §Phase 4 §2.3, #46).
//
// Turns a concrete project structure (from getProjectStructure) into a reusable,
// tenant-agnostic template: the phase/task hierarchy with titles, estimated hours,
// and task type — but WITHOUT tenant-specific object ids, resource assignments, or
// absolute dates, so it can seed a new project in any tenant. Pure/HTTP-free.

export interface BlueprintTask {
  title: string;
  estimatedHours: number;
  taskType?: number;
}
export interface BlueprintPhase {
  title: string;
  estimatedHours: number;
  tasks: BlueprintTask[];
  children: BlueprintPhase[];
}
export interface ProjectBlueprint {
  name: string;
  sourceProjectID: number | null;
  phaseCount: number;
  taskCount: number;
  estimatedHours: number;
  phases: BlueprintPhase[];
  unphasedTasks: BlueprintTask[];
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2 = (n: number) => Math.round(n * 100) / 100;

function taskToBlueprint(t: Record<string, any>): BlueprintTask {
  const bt: BlueprintTask = { title: String(t.title ?? ''), estimatedHours: r2(num(t.estimatedHours)) };
  if (t.taskType != null) bt.taskType = Number(t.taskType);
  return bt;
}

function phaseToBlueprint(p: Record<string, any>): BlueprintPhase {
  return {
    title: String(p.title ?? ''),
    estimatedHours: r2(num(p.estimatedHours)),
    tasks: (p.tasks ?? []).map(taskToBlueprint),
    children: (p.children ?? []).map(phaseToBlueprint),
  };
}

/**
 * Build a reusable blueprint from a project structure. `structure` is the shape
 * returned by getProjectStructure ({ project, phases, unphasedTasks, summary }).
 */
export function toProjectBlueprint(structure: Record<string, any>): ProjectBlueprint {
  const project = structure?.project ?? {};
  const phases = (structure?.phases ?? []).map(phaseToBlueprint);
  const unphasedTasks = (structure?.unphasedTasks ?? []).map(taskToBlueprint);
  const summary = structure?.summary ?? {};
  return {
    name: String(project.projectName ?? project.name ?? 'Untitled Project'),
    sourceProjectID: project.id ?? null,
    phaseCount: num(summary.phaseCount) || phases.length,
    taskCount: num(summary.taskCount),
    estimatedHours: r2(num(summary.estimatedHours)),
    phases,
    unphasedTasks,
  };
}
