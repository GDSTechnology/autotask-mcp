// Deterministic project labor plan (#46 §10, Phase 4 Layer 2).
//
// Compares three views of labor per phase — QUOTED (what was sold, from the
// SOW/quote), CALCULATED (derived from BOM/scope quantities, §9), and PLANNED
// (what the build plan's tasks actually add up to) — and flags material variance
// so it surfaces for review rather than silently overwriting quoted labor. Pure /
// HTTP-free; the caller supplies quoted/calculated (from the pipeline) and the
// planned view is read from the ProjectBuildPlan. Feeds calculate_project_schedule.

import { ProjectBuildPlan, validateBuildPlan } from './project-plan.js';

export interface LaborPlanInput {
  plan: ProjectBuildPlan;
  /** Quoted labor hours keyed by phase ref (what was sold). */
  quotedHoursByPhase?: Record<string, number>;
  /** Labor hours calculated from BOM/scope quantities, keyed by phase ref. */
  calculatedHoursByPhase?: Record<string, number>;
  /** Totals when a per-phase breakdown isn't available. */
  quotedHoursTotal?: number;
  calculatedHoursTotal?: number;
  /** Fractional variance that counts as "material" (default 0.15 = 15%). */
  varianceThresholdPct?: number;
}

export interface LaborDelta { deltaHours: number; deltaPct: number | null }

export interface PhaseLaborPlan {
  phaseRef: string | null; // null = unphased tasks
  title: string;
  taskCount: number;
  plannedHours: number;
  quotedHours: number | null;
  calculatedHours: number | null;
  plannedVsQuoted: LaborDelta | null;
  plannedVsCalculated: LaborDelta | null;
  flags: string[];
  flagged: boolean;
}

export interface ProjectLaborPlanResult {
  phases: PhaseLaborPlan[];
  totals: {
    plannedHours: number;
    quotedHours: number | null;
    calculatedHours: number | null;
    plannedVsQuoted: LaborDelta | null;
    plannedVsCalculated: LaborDelta | null;
  };
  flaggedPhases: number;
  varianceThresholdPct: number;
  planWarnings: string[];
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function delta(planned: number, other: number | null): LaborDelta | null {
  if (other == null) return null;
  return { deltaHours: round2(planned - other), deltaPct: other === 0 ? null : round2((planned - other) / other) };
}

/** Flags for a delta beyond the threshold: over/under the reference. */
function flagsFor(kind: 'quoted' | 'calculated', d: LaborDelta | null, threshold: number): string[] {
  if (!d) return [];
  // A brand-new reference of 0 hours with planned > 0 is always material.
  const material = d.deltaPct == null ? d.deltaHours !== 0 : Math.abs(d.deltaPct) > threshold;
  if (!material) return [];
  return [d.deltaHours > 0 ? `over_${kind}` : `under_${kind}`];
}

/**
 * Build the labor plan: planned hours per phase (from task estimates) compared to
 * quoted and calculated hours, with material-variance flags. Pure — never mutates
 * the plan or the quoted figures.
 */
export function generateProjectLaborPlan(input: LaborPlanInput): ProjectLaborPlanResult {
  const threshold = input.varianceThresholdPct ?? 0.15;
  const plan = input.plan;
  const planWarnings = validateBuildPlan(plan).warnings;

  const phaseTitle = new Map<string, string>((plan.phases ?? []).map((p) => [p.ref, p.title]));
  // Sum planned hours + task counts per phase ref (null bucket = unphased).
  const planned = new Map<string | null, { hours: number; tasks: number }>();
  for (const t of plan.tasks ?? []) {
    const key = t.phaseRef ?? null;
    const g = planned.get(key) ?? { hours: 0, tasks: 0 };
    g.hours += t.estimatedHours ?? 0;
    g.tasks += 1;
    planned.set(key, g);
  }

  // Every phase in the plan is represented even if it has no tasks (planned 0),
  // plus any phase that only appears in the quoted/calculated inputs.
  const phaseRefs = new Set<string | null>([
    ...(plan.phases ?? []).map((p) => p.ref),
    ...planned.keys(),
    ...Object.keys(input.quotedHoursByPhase ?? {}),
    ...Object.keys(input.calculatedHoursByPhase ?? {}),
  ]);

  const phases: PhaseLaborPlan[] = [];
  for (const ref of phaseRefs) {
    const p = planned.get(ref) ?? { hours: 0, tasks: 0 };
    const plannedHours = round2(p.hours);
    const quoted = ref != null && input.quotedHoursByPhase ? input.quotedHoursByPhase[ref] ?? null : null;
    const calculated = ref != null && input.calculatedHoursByPhase ? input.calculatedHoursByPhase[ref] ?? null : null;
    const pvq = delta(plannedHours, quoted);
    const pvc = delta(plannedHours, calculated);
    const flags = [...flagsFor('quoted', pvq, threshold), ...flagsFor('calculated', pvc, threshold)];
    phases.push({
      phaseRef: ref,
      title: ref == null ? 'Unphased' : phaseTitle.get(ref) ?? ref,
      taskCount: p.tasks,
      plannedHours,
      quotedHours: quoted,
      calculatedHours: calculated,
      plannedVsQuoted: pvq,
      plannedVsCalculated: pvc,
      flags,
      flagged: flags.length > 0,
    });
  }
  phases.sort((a, b) => Number(b.flagged) - Number(a.flagged) || b.plannedHours - a.plannedHours);

  const plannedTotal = round2(phases.reduce((s, p) => s + p.plannedHours, 0));
  const quotedTotal = input.quotedHoursTotal ?? sumOrNull(phases.map((p) => p.quotedHours));
  const calcTotal = input.calculatedHoursTotal ?? sumOrNull(phases.map((p) => p.calculatedHours));

  return {
    phases,
    totals: {
      plannedHours: plannedTotal,
      quotedHours: quotedTotal,
      calculatedHours: calcTotal,
      plannedVsQuoted: delta(plannedTotal, quotedTotal),
      plannedVsCalculated: delta(plannedTotal, calcTotal),
    },
    flaggedPhases: phases.filter((p) => p.flagged).length,
    varianceThresholdPct: threshold,
    planWarnings,
  };
}

/** Sum, or null when there is no non-null contribution (keeps "unknown" honest). */
function sumOrNull(vals: Array<number | null>): number | null {
  const present = vals.filter((v): v is number => v != null);
  return present.length ? round2(present.reduce((s, v) => s + v, 0)) : null;
}
