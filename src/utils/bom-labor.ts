// BOM → calculated labor (#46 §9). Deterministic, pure.
//
// Turns BOM/scope quantities (from extract_project_scope, or supplied directly)
// into CALCULATED labor hours using a caller-provided rate catalog, and normalizes
// the quantities into repeated tasks. This produces the `calculatedHoursByPhase`
// (and a task list) that generate_project_labor_plan (§10) compares against QUOTED
// and PLANNED — never overwriting quoted labor, only giving the bottom-up number.
//
// Tenant-agnostic: labor rates are caller-provided (minutes/hours per unit per item
// type). Nothing about any tenant's catalog is baked in; unmatched items are flagged,
// never guessed.

export interface BomItem { item: string; quantity: number; unit?: string | undefined }

export interface LaborRate {
  /** case-insensitive substring matched against the item name (or use matchAny) */
  match?: string | undefined;
  matchAny?: string[] | undefined;
  minutesPerUnit?: number | undefined;
  hoursPerUnit?: number | undefined;
  /** multiplies the computed hours (e.g. 2 ends per drop = terminations) */
  laborMultiplier?: number | undefined;
  phaseRef?: string | undefined;
  taskTitle?: string | undefined;
}

export interface BomLaborLine {
  item: string;
  quantity: number;
  matched: boolean;
  hoursPerUnit: number | null;
  hours: number;
  phaseRef: string | null;
  taskTitle: string | null;
}

export interface BomTask { ref: string; title: string; estimatedHours: number; phaseRef?: string | undefined; quantity: number }

export interface BomLaborResult {
  lines: BomLaborLine[];
  byPhase: Record<string, number>;
  calculatedHoursByPhase: Record<string, number>; // alias — feeds generate_project_labor_plan
  tasks: BomTask[];
  totalHours: number;
  matchedItems: number;
  unmatched: Array<{ item: string; quantity: number }>;
  warnings: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function findRate(item: string, rates: LaborRate[]): LaborRate | null {
  const name = item.toLowerCase();
  for (const r of rates) {
    const keys = [r.match, ...(r.matchAny ?? [])].filter((x): x is string => !!x);
    if (keys.some((k) => name.includes(k.toLowerCase()))) return r;
  }
  return null;
}

function rateHoursPerUnit(r: LaborRate): number | null {
  if (r.hoursPerUnit != null && r.hoursPerUnit >= 0) return r.hoursPerUnit;
  if (r.minutesPerUnit != null && r.minutesPerUnit >= 0) return r.minutesPerUnit / 60;
  return null;
}

export interface BomLaborInput {
  items: BomItem[];
  rates: LaborRate[];
  /** hours-per-unit fallback for items no rate matches (default: none → flagged) */
  defaultHoursPerUnit?: number | undefined;
  /** phaseRef for lines whose matched rate has none (default 'unphased') */
  defaultPhaseRef?: string | undefined;
}

/** Compute calculated labor from a BOM + rate catalog. Pure/deterministic. */
export function computeBomLabor(input: BomLaborInput): BomLaborResult {
  const rates = input.rates ?? [];
  const defaultPhase = input.defaultPhaseRef ?? 'unphased';
  const lines: BomLaborLine[] = [];
  const byPhase: Record<string, number> = {};
  const tasks: BomTask[] = [];
  const unmatched: Array<{ item: string; quantity: number }> = [];
  const warnings: string[] = [];
  let total = 0;
  let matchedItems = 0;

  input.items.forEach((it, i) => {
    const qty = Number(it.quantity) || 0;
    const rate = findRate(it.item, rates);
    let hpu = rate ? rateHoursPerUnit(rate) : null;
    let matched = rate != null && hpu != null;
    if (hpu == null && input.defaultHoursPerUnit != null) { hpu = input.defaultHoursPerUnit; }

    if (hpu == null) {
      unmatched.push({ item: it.item, quantity: qty });
      lines.push({ item: it.item, quantity: qty, matched: false, hoursPerUnit: null, hours: 0, phaseRef: null, taskTitle: null });
      return;
    }

    const mult = rate?.laborMultiplier != null && rate.laborMultiplier > 0 ? rate.laborMultiplier : 1;
    const hours = round2(qty * hpu * mult);
    const phaseRef = rate?.phaseRef ?? defaultPhase;
    const taskTitle = rate?.taskTitle ?? it.item;
    if (matched) matchedItems++;

    lines.push({ item: it.item, quantity: qty, matched, hoursPerUnit: round2(hpu * mult), hours, phaseRef, taskTitle });
    byPhase[phaseRef] = round2((byPhase[phaseRef] ?? 0) + hours);
    total = round2(total + hours);
    tasks.push({ ref: `bom-${i + 1}`, title: taskTitle, estimatedHours: hours, ...(phaseRef ? { phaseRef } : {}), quantity: qty });
  });

  if (input.items.length === 0) warnings.push('No BOM items supplied.');
  if (rates.length === 0) warnings.push('No labor rate catalog supplied — nothing can be calculated. Provide rates (minutes/hours per unit per item type).');
  if (unmatched.length > 0) warnings.push(`${unmatched.length} item(s) matched no rate${input.defaultHoursPerUnit == null ? ' and no defaultHoursPerUnit was set — they contribute 0 hours. Add rates or a default.' : ''}.`);

  return {
    lines,
    byPhase,
    calculatedHoursByPhase: byPhase,
    tasks,
    totalHours: total,
    matchedItems,
    unmatched,
    warnings,
  };
}
