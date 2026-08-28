// Project labor summary (Expansion Spec §Phase 4 §4.5, #45).
//
// Autotask's project-scoped TimeEntry query is unreliable, so project labor is
// aggregated through the task hierarchy: Project → Tasks → (task) TimeEntries.
// Pure: the service fetches tasks + their time entries and feeds them here.

export interface LaborTask {
  id: number;
  phaseID?: number | null;
  estimatedHours?: number;
}
export interface LaborEntry {
  taskID?: number | null;
  hoursWorked?: number;
  hoursToBill?: number;
  isNonBillable?: boolean;
  dateWorked?: string;
  resourceID?: number | null;
}

export interface PhaseLabor {
  phaseID: number | null;
  estimatedHours: number;
  actualHours: number;
  billableHours: number;
}
export interface ProjectLaborSummary {
  taskCount: number;
  entryCount: number;
  estimatedHours: number;
  actualHours: number;
  billableHours: number;
  nonBillableHours: number;
  hoursToBill: number;
  variance: number; // actual - estimated
  firstWorked: string | null;
  lastWorked: string | null;
  byPhase: PhaseLabor[];
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const r2 = (n: number) => Math.round(n * 100) / 100;

export function summarizeProjectLabor(
  tasks: Array<Record<string, any>>,
  entries: Array<Record<string, any>>
): ProjectLaborSummary {
  const taskPhase = new Map<number, number | null>();
  const phase = new Map<string, PhaseLabor>();
  const ensurePhase = (pid: number | null): PhaseLabor => {
    const key = String(pid);
    let p = phase.get(key);
    if (!p) { p = { phaseID: pid, estimatedHours: 0, actualHours: 0, billableHours: 0 }; phase.set(key, p); }
    return p;
  };

  let estimatedHours = 0;
  for (const t of tasks ?? []) {
    taskPhase.set(t.id, t.phaseID ?? null);
    const est = num(t.estimatedHours);
    estimatedHours += est;
    ensurePhase(t.phaseID ?? null).estimatedHours += est;
  }

  let actualHours = 0, billableHours = 0, nonBillableHours = 0, hoursToBill = 0;
  let first: string | null = null, last: string | null = null;
  for (const e of entries ?? []) {
    const worked = num(e.hoursWorked);
    actualHours += worked;
    hoursToBill += num(e.hoursToBill);
    if (e.isNonBillable) nonBillableHours += worked; else billableHours += worked;
    const pid = e.taskID != null && taskPhase.has(e.taskID) ? taskPhase.get(e.taskID)! : null;
    const p = ensurePhase(pid);
    p.actualHours += worked;
    if (!e.isNonBillable) p.billableHours += worked;
    if (e.dateWorked) {
      if (!first || e.dateWorked < first) first = e.dateWorked;
      if (!last || e.dateWorked > last) last = e.dateWorked;
    }
  }

  const byPhase = [...phase.values()]
    .map((p) => ({ phaseID: p.phaseID, estimatedHours: r2(p.estimatedHours), actualHours: r2(p.actualHours), billableHours: r2(p.billableHours) }))
    .sort((a, b) => b.actualHours - a.actualHours);

  return {
    taskCount: (tasks ?? []).length,
    entryCount: (entries ?? []).length,
    estimatedHours: r2(estimatedHours),
    actualHours: r2(actualHours),
    billableHours: r2(billableHours),
    nonBillableHours: r2(nonBillableHours),
    hoursToBill: r2(hoursToBill),
    variance: r2(actualHours - estimatedHours),
    firstWorked: first,
    lastWorked: last,
    byPhase,
  };
}
