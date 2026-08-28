// Project structure assembly (Expansion Spec §Phase 4 §4.3/§6, #45).
//
// Normalizes a flat project + phases + tasks into the nested outline Autotask
// shows (project → phases → child phases → tasks, plus unphased tasks), preserving
// the native fields needed to reproduce the project. Pure/HTTP-free: the service
// fetches the entities and feeds them here so it is unit-testable without a tenant.

export interface StructTask {
  [k: string]: any;
}
export interface StructPhase {
  [k: string]: any;
  tasks: StructTask[];
  children: StructPhase[];
}

export interface ProjectStructure {
  project: Record<string, any> | null;
  phases: StructPhase[];
  unphasedTasks: StructTask[];
  summary: {
    phaseCount: number;
    taskCount: number;
    unphasedTaskCount: number;
    maxPhaseDepth: number;
    estimatedHours: number;
  };
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** Assemble the nested project outline from flat phases + tasks. */
export function buildProjectHierarchy(
  project: Record<string, any> | null,
  phases: Array<Record<string, any>>,
  tasks: Array<Record<string, any>>
): ProjectStructure {
  const phaseIds = new Set<number>((phases ?? []).map((p) => p.id));

  // Bucket tasks under their phase; anything without a matching phase is unphased.
  const tasksByPhase = new Map<number, StructTask[]>();
  const unphasedTasks: StructTask[] = [];
  for (const t of tasks ?? []) {
    if (t.phaseID != null && phaseIds.has(t.phaseID)) {
      let arr = tasksByPhase.get(t.phaseID);
      if (!arr) { arr = []; tasksByPhase.set(t.phaseID, arr); }
      arr.push(t);
    } else {
      unphasedTasks.push(t);
    }
  }

  // Build phase nodes, then nest by parentPhaseID.
  const nodes = new Map<number, StructPhase>();
  for (const p of phases ?? []) {
    nodes.set(p.id, { ...p, tasks: tasksByPhase.get(p.id) ?? [], children: [] });
  }
  const roots: StructPhase[] = [];
  for (const p of phases ?? []) {
    const node = nodes.get(p.id)!;
    const parent = p.parentPhaseID != null ? nodes.get(p.parentPhaseID) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  const depth = (node: StructPhase): number =>
    1 + node.children.reduce((m, c) => Math.max(m, depth(c)), 0);
  const maxPhaseDepth = roots.reduce((m, r) => Math.max(m, depth(r)), 0);
  const estimatedHours =
    Math.round((phases ?? []).reduce((s, p) => s + num(p.estimatedHours), 0) * 100) / 100;

  return {
    project,
    phases: roots,
    unphasedTasks,
    summary: {
      phaseCount: (phases ?? []).length,
      taskCount: (tasks ?? []).length,
      unphasedTaskCount: unphasedTasks.length,
      maxPhaseDepth,
      estimatedHours,
    },
  };
}
