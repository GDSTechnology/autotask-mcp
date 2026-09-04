// Deterministic project scheduler (Expansion Spec §Phase 4 §11, #46 Layer 2).
//
// Turns a normalized ProjectBuildPlan into a dated schedule using only
// arithmetic — no Autotask calls, no AI, no reference-project inference. Task
// duration = ceil(estimatedHours / (crew × hoursPerDay)) working days; tasks are
// laid out in dependency order across a configurable working week (skipping
// weekends/holidays); the project's target completion is the latest task finish.
// Same inputs always yield the same schedule.

import { ProjectBuildPlan, PlanTask, validateBuildPlan } from './project-plan';

export interface ScheduleOptions {
  /** Earliest project start, ISO date (YYYY-MM-DD). Rolled forward to the next working day if it falls on a non-working day. */
  startDate: string;
  /** Productive hours per working day (default 8). */
  hoursPerDay?: number;
  /** Parallel resources per task when a task doesn't set its own crewSize (default 1). */
  defaultCrewSize?: number;
  /** Working weekdays as ISO numbers (Mon=1 … Sun=7). Default Mon–Fri [1,2,3,4,5]. */
  workweek?: number[];
  /** Non-working dates (holidays), ISO YYYY-MM-DD. */
  holidays?: string[];
  /** Optional deadline; a target completion beyond it produces a warning. */
  targetCompletionDate?: string;
}

export interface ScheduledTask {
  ref: string;
  title: string;
  phaseRef?: string;
  estimatedHours: number;
  crewSize: number;
  durationDays: number;
  startDate: string;
  endDate: string;
  isMilestone: boolean;
  isCritical: boolean;
  predecessors: string[];
}

export interface ScheduleMilestone {
  ref: string;
  title: string;
  date: string;
}

export interface ProjectSchedule {
  startDate: string;
  targetCompletionDate: string;
  durationWorkingDays: number;
  durationCalendarDays: number;
  hoursPerDay: number;
  defaultCrewSize: number;
  totalEstimatedHours: number;
  taskCount: number;
  /** Ordered task refs on the driving (longest) path to target completion. */
  criticalPath: string[];
  milestones: ScheduleMilestone[];
  tasks: ScheduledTask[];
  warnings: string[];
}

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const DAY_MS = 86_400_000;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parseISODate(s: string, label: string): number {
  if (typeof s !== 'string' || !ISO_DATE.test(s)) {
    throw new Error(`${label} must be an ISO date (YYYY-MM-DD), got ${JSON.stringify(s)}`);
  }
  const t = Date.parse(`${s}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new Error(`${label} is not a valid date: ${s}`);
  return t;
}

function formatISODate(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** ISO weekday for a UTC timestamp: Mon=1 … Sun=7. */
function isoWeekday(t: number): number {
  return ((new Date(t).getUTCDay() + 6) % 7) + 1;
}

function makeIsWorkingDay(workweek: Set<number>, holidays: Set<string>) {
  return (t: number): boolean => workweek.has(isoWeekday(t)) && !holidays.has(formatISODate(t));
}

/** The given day if it's a working day, else the next working day. */
function rollToWorkingDay(t: number, isWorking: (t: number) => boolean): number {
  let d = t;
  for (let i = 0; i < 3660 && !isWorking(d); i++) d += DAY_MS;
  return d;
}

/** Advance `n` working days from a working day `t` (n=0 returns t). */
function advanceWorkingDays(t: number, n: number, isWorking: (t: number) => boolean): number {
  let d = t;
  let remaining = n;
  let guard = 0;
  while (remaining > 0 && guard < 366_000) {
    d += DAY_MS;
    if (isWorking(d)) remaining--;
    guard++;
  }
  return d;
}

/** Count working days in the inclusive calendar range [from, to]. */
function workingDaysBetween(from: number, to: number, isWorking: (t: number) => boolean): number {
  if (to < from) return 0;
  let count = 0;
  for (let d = from; d <= to; d += DAY_MS) if (isWorking(d)) count++;
  return count;
}

function durationDaysFor(task: PlanTask, crew: number, hoursPerDay: number): number {
  if (task.milestone) return 0;
  const hours = num(task.estimatedHours);
  if (hours <= 0) return 0;
  return Math.max(1, Math.ceil(hours / (crew * hoursPerDay)));
}

/**
 * Compute a deterministic schedule for a build plan. Throws on a structurally
 * invalid plan (unknown/cyclic dependencies, duplicate refs, …) or bad options.
 */
export function calculateProjectSchedule(plan: ProjectBuildPlan, options: ScheduleOptions): ProjectSchedule {
  const v = validateBuildPlan(plan);
  if (!v.valid) {
    throw new Error(`cannot schedule an invalid plan: ${v.errors.join('; ')}`);
  }

  const hoursPerDay = options.hoursPerDay ?? 8;
  if (hoursPerDay <= 0) throw new Error('hoursPerDay must be > 0');
  const defaultCrewSize = options.defaultCrewSize ?? 1;
  if (defaultCrewSize <= 0) throw new Error('defaultCrewSize must be > 0');

  const workweek = new Set(options.workweek ?? [1, 2, 3, 4, 5]);
  for (const d of workweek) if (d < 1 || d > 7) throw new Error(`workweek entries must be ISO weekdays 1–7, got ${d}`);
  if (workweek.size === 0) throw new Error('workweek must contain at least one working day');
  const holidays = new Set(options.holidays ?? []);
  const isWorking = makeIsWorkingDay(workweek, holidays);

  const projectStart = rollToWorkingDay(parseISODate(options.startDate, 'startDate'), isWorking);
  const targetDeadline = options.targetCompletionDate
    ? parseISODate(options.targetCompletionDate, 'targetCompletionDate')
    : null;

  const tasks = plan.tasks ?? [];
  const byRef = new Map<string, PlanTask>(tasks.map((t) => [t.ref, t]));

  // Kahn topological order over resolvable predecessors.
  const order = topoOrder(tasks);

  const start = new Map<string, number>();
  const end = new Map<string, number>();
  const drivingPred = new Map<string, string | null>();

  for (const ref of order) {
    const task = byRef.get(ref)!;
    const crew = task.crewSize ?? defaultCrewSize;
    const dur = durationDaysFor(task, crew, hoursPerDay);
    const lag = Math.max(0, num(task.lagDays));

    const preds = (task.predecessors ?? []).filter((p) => end.has(p));
    let s = projectStart;
    let driver: string | null = null;
    for (const p of preds) {
      // Successor starts the working day after the predecessor's last day, + lag.
      const candidate = advanceWorkingDays(end.get(p)!, 1 + lag, isWorking);
      if (candidate > s) { s = candidate; driver = p; }
    }
    s = rollToWorkingDay(s, isWorking);
    const e = dur <= 0 ? s : advanceWorkingDays(s, dur - 1, isWorking);
    start.set(ref, s);
    end.set(ref, e);
    drivingPred.set(ref, driver);
  }

  // Target completion = latest finish; tie-break toward the later start.
  let finishRef: string | null = null;
  let finishTs = projectStart;
  for (const ref of order) {
    const e = end.get(ref)!;
    if (finishRef === null || e > finishTs || (e === finishTs && start.get(ref)! > start.get(finishRef)!)) {
      finishRef = ref;
      finishTs = e;
    }
  }

  // Driving/critical path: walk back through the binding predecessors.
  const criticalPath: string[] = [];
  const criticalSet = new Set<string>();
  let cursor = finishRef;
  let guard = 0;
  while (cursor && guard++ < order.length + 1) {
    criticalPath.unshift(cursor);
    criticalSet.add(cursor);
    cursor = drivingPred.get(cursor) ?? null;
  }

  const scheduledTasks: ScheduledTask[] = order
    .map((ref) => {
      const t = byRef.get(ref)!;
      const crew = t.crewSize ?? defaultCrewSize;
      const st: ScheduledTask = {
        ref,
        title: String(t.title ?? ''),
        estimatedHours: num(t.estimatedHours),
        crewSize: crew,
        durationDays: durationDaysFor(t, crew, hoursPerDay),
        startDate: formatISODate(start.get(ref)!),
        endDate: formatISODate(end.get(ref)!),
        isMilestone: !!t.milestone,
        isCritical: criticalSet.has(ref),
        predecessors: [...(t.predecessors ?? [])],
      };
      if (t.phaseRef != null) st.phaseRef = t.phaseRef;
      return st;
    })
    .sort((a, b) => (a.startDate < b.startDate ? -1 : a.startDate > b.startDate ? 1 : a.ref < b.ref ? -1 : 1));

  const milestones: ScheduleMilestone[] = scheduledTasks
    .filter((t) => t.isMilestone)
    .map((t) => ({ ref: t.ref, title: t.title, date: t.startDate }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const targetCompletionTs = tasks.length > 0 ? finishTs : projectStart;
  const warnings = [...v.warnings];
  if (targetDeadline != null && targetCompletionTs > targetDeadline) {
    const over = workingDaysBetween(targetDeadline + DAY_MS, targetCompletionTs, isWorking);
    warnings.push(
      `target completion ${formatISODate(targetCompletionTs)} is ${over} working day(s) past the requested ${formatISODate(targetDeadline)}`
    );
  }

  return {
    startDate: formatISODate(projectStart),
    targetCompletionDate: formatISODate(targetCompletionTs),
    durationWorkingDays: tasks.length > 0 ? workingDaysBetween(projectStart, targetCompletionTs, isWorking) : 0,
    durationCalendarDays: tasks.length > 0 ? Math.round((targetCompletionTs - projectStart) / DAY_MS) + 1 : 0,
    hoursPerDay,
    defaultCrewSize,
    totalEstimatedHours: Math.round(tasks.reduce((sum, t) => sum + num(t.estimatedHours), 0) * 100) / 100,
    taskCount: tasks.length,
    criticalPath,
    milestones,
    tasks: scheduledTasks,
    warnings,
  };
}

/** Kahn topological sort; ties broken by original plan order for determinism. */
function topoOrder(tasks: PlanTask[]): string[] {
  const refs = tasks.map((t) => t.ref);
  const known = new Set(refs);
  const indeg = new Map<string, number>(refs.map((r) => [r, 0]));
  const successors = new Map<string, string[]>(refs.map((r) => [r, []]));

  for (const t of tasks) {
    for (const p of t.predecessors ?? []) {
      if (!known.has(p)) continue;
      indeg.set(t.ref, (indeg.get(t.ref) ?? 0) + 1);
      successors.get(p)!.push(t.ref);
    }
  }

  // Seed the queue in plan order so equal-rank tasks keep a stable sequence.
  const queue = refs.filter((r) => (indeg.get(r) ?? 0) === 0);
  const out: string[] = [];
  while (queue.length > 0) {
    const ref = queue.shift()!;
    out.push(ref);
    for (const s of successors.get(ref) ?? []) {
      indeg.set(s, (indeg.get(s) ?? 0) - 1);
      if ((indeg.get(s) ?? 0) === 0) queue.push(s);
    }
  }

  if (out.length !== refs.length) {
    // validateBuildPlan already rejects cycles; this is a defensive guard.
    throw new Error('dependency cycle detected while ordering tasks');
  }
  return out;
}
