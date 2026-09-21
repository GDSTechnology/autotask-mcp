// ITIL SLA framework generator (#102, slice 1) — advisory, deterministic, pure.
//
// Autotask keeps SLA and priority DEFINITIONS as UI-only config (no REST entity
// for ServiceLevelAgreements; the priority picklist is not API-writable). So the
// MCP cannot *create* an SLA — but it can generate the standardized, ITIL-grounded
// spec a human enters in the Autotask UI, and (once entered) the compliance report
// (#101) measures against it. This module produces that spec.
//
// It is tenant-agnostic: ITIL defaults are baked in, everything is overridable, and
// the caller's existing (possibly messy) priority picklist is taken as INPUT to be
// classified/mapped — nothing about any particular tenant is hardcoded.
//
// ITIL model encoded here:
//   • Priority = Impact × Urgency (Autotask has no impact/urgency field, so the
//     matrix is decision guidance; the RESULT is stored in the priority picklist).
//   • A clean P1–P4 (optionally P5) severity scheme replaces a drifted list.
//   • SLA targets per priority × request type (Incident vs Service Request), with
//     service-hours coverage and optional customer-tier multipliers.

export type RequestType = 'Incident' | 'ServiceRequest';
export type Coverage = '24x7' | '8x5';
export type PriorityClass = 'severity' | 'response-time' | 'work-type' | 'planned' | 'unknown';

export interface Duration {
  minutes: number;
  /** true = the clock only runs during business hours (see businessHoursPerDay) */
  businessHours: boolean;
  label: string;
}

export interface PriorityLevel {
  code: string;          // P1..P5
  name: string;          // Critical, High, ...
  description: string;
  /** default incident targets, before request-type / tier adjustment */
  firstResponse: Duration;
  resolutionPlan: Duration;
  resolution: Duration;
  coverage: Coverage;
}

export interface MatrixCell { impact: string; urgency: string; priority: string }

export interface MigrationEntry {
  current: string;
  classify: PriorityClass;
  recommend: string;   // where it should go
  rationale: string;
}

export interface SlaTargetRow {
  priority: string;
  priorityName: string;
  requestType: RequestType;
  tier: string;
  coverage: Coverage;
  firstResponse: Duration;
  resolutionPlan: Duration;
  resolution: Duration;
}

export interface Tier { name: string; multiplier: number; coverage?: Coverage | undefined }

export interface SlaFrameworkInput {
  /** 4 (default, P1–P4) or 5 (adds P5 Planning) */
  levels?: 4 | 5 | undefined;
  /** request types to generate targets for (default both) */
  requestTypes?: RequestType[] | undefined;
  /** customer tiers; omitted = a single implicit "Standard" tier (×1) */
  tiers?: Tier[] | undefined;
  /** the tenant's CURRENT priority picklist values, to classify & map (optional) */
  currentPriorities?: string[] | undefined;
  /** business hours in a working day, for business-day math (default 8) */
  businessHoursPerDay?: number | undefined;
  /** multiply Service Request plan/resolution vs Incident at the same priority (default 2) */
  serviceRequestResolutionMultiplier?: number | undefined;
  /** override default per-priority targets, keyed by code (P1..P5); minutes + businessHours */
  overrides?: Record<string, Partial<{ firstResponse: number; resolutionPlan: number; resolution: number; coverage: Coverage }>> | undefined;
}

export interface SlaFrameworkResult {
  levels: number;
  businessHoursPerDay: number;
  priorityMatrix: MatrixCell[];
  priorityScheme: PriorityLevel[];
  priorityMigration: MigrationEntry[] | null;
  targets: SlaTargetRow[];
  uiSteps: string[];
  notes: string[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function fmt(minutes: number, businessHours: boolean, bhpd: number): Duration {
  const label = labelFor(minutes, businessHours, bhpd);
  return { minutes, businessHours, label };
}
function labelFor(minutes: number, businessHours: boolean, bhpd: number): string {
  if (minutes < 60) return `${minutes} min`;
  const dayMin = bhpd * 60;
  // express as business days only at 2+ full days, to keep "8 bus. hours" readable
  if (businessHours && minutes >= dayMin * 2 && minutes % dayMin === 0) {
    return `${minutes / dayMin} bus. days`;
  }
  const hrs = round1(minutes / 60);
  return `${hrs} ${businessHours ? 'bus. hours' : (hrs === 1 ? 'hour' : 'hours')}`;
}

// ITIL-typical MSP defaults (minutes). P1 runs 24x7 (wall-clock); P2–P5 are 8x5
// (business-hours clock). These match docs/ITIL-ALIGNMENT.md §3.
interface RawLevel { code: string; name: string; description: string; fr: number; plan: number; res: number; coverage: Coverage; bh: boolean }
const BASE_LEVELS: RawLevel[] = [
  { code: 'P1', name: 'Critical', description: 'Whole company or a site down; no workaround. Business-critical.', fr: 15,  plan: 60,   res: 240,  coverage: '24x7', bh: false },
  { code: 'P2', name: 'High',     description: 'A department or many users affected, or a critical function degraded.', fr: 30,  plan: 240,  res: 480,  coverage: '8x5',  bh: true },
  { code: 'P3', name: 'Medium',   description: 'A single user or a non-critical function; a workaround exists.',      fr: 60,  plan: 480,  res: 1440, coverage: '8x5',  bh: true },
  { code: 'P4', name: 'Low',      description: 'Minor issue, question, or cosmetic; no material business impact.',    fr: 240, plan: 480,  res: 2400, coverage: '8x5',  bh: true },
];
const P5: RawLevel = { code: 'P5', name: 'Planning', description: 'Scheduled/planned work; fulfil on an agreed date, not against a live clock.', fr: 480, plan: 2400, res: 4800, coverage: '8x5', bh: true };

function buildScheme(levels: number, bhpd: number, overrides: SlaFrameworkInput['overrides']): PriorityLevel[] {
  const raw = levels === 5 ? [...BASE_LEVELS, P5] : BASE_LEVELS;
  return raw.map((l) => {
    const ov = overrides?.[l.code];
    const coverage = ov?.coverage ?? l.coverage;
    const bh = coverage === '24x7' ? false : l.bh; // 24x7 coverage means wall-clock
    return {
      code: l.code,
      name: l.name,
      description: l.description,
      firstResponse: fmt(ov?.firstResponse ?? l.fr, bh, bhpd),
      resolutionPlan: fmt(ov?.resolutionPlan ?? l.plan, bh, bhpd),
      resolution: fmt(ov?.resolution ?? l.res, bh, bhpd),
      coverage,
    };
  });
}

// Impact × Urgency → Priority (standard 3×3). With 5 levels the calmest cell
// drops to P5 to give planned/low-low work its own lane.
function buildMatrix(levels: number): MatrixCell[] {
  const impacts = ['High', 'Medium', 'Low'];
  const urgencies = ['High', 'Medium', 'Low'];
  const grid: Record<string, string[]> = {
    High:   ['P1', 'P2', 'P3'],
    Medium: ['P2', 'P3', 'P4'],
    Low:    ['P3', 'P4', levels === 5 ? 'P5' : 'P4'],
  };
  const cells: MatrixCell[] = [];
  for (const impact of impacts) for (let u = 0; u < urgencies.length; u++) {
    cells.push({ impact, urgency: urgencies[u], priority: grid[impact][u] });
  }
  return cells;
}

const SEVERITY_WORDS: Array<[RegExp, string]> = [
  [/\b(critical|crit|p1|sev\s*1|emergency|urgent)\b/i, 'P1'],
  [/\b(high|p2|sev\s*2|major)\b/i, 'P2'],
  [/\b(medium|normal|moderate|p3|sev\s*3|standard)\b/i, 'P3'],
  [/\b(low|minor|p4|sev\s*4|cosmetic)\b/i, 'P4'],
  [/\b(planning|planned|deferred|p5|whenever)\b/i, 'P5'],
];
const TIME_WORDS = /\b(same[-\s]?day|next[-\s]?day|hour|hr|hrs|min|minute|24|48|72|business day|bus\.?\s*day|day)\b/i;
const PLANNED_WORDS = /\b(schedule|scheduled|maintenance|planned|preventive|pm)\b/i;
const WORKTYPE_WORDS = /\b(repair|repairs|install|installation|onsite|on-site|remote|project|dispatch|rma|return)\b/i;

function classifyPriority(value: string, levels: number): MigrationEntry {
  const v = value.trim();
  // planned/maintenance is really a Change, not a severity — check first
  if (PLANNED_WORDS.test(v) && !/\b(high|critical|low|medium)\b/i.test(v)) {
    return { current: value, classify: 'planned', recommend: 'ticketType = Change (or P5 if you run a Planning lane)', rationale: 'Planned/scheduled work belongs to Change enablement, not a severity level.' };
  }
  // severity words → map to a clean level
  for (const [re, code] of SEVERITY_WORDS) {
    if (re.test(v)) {
      const mapped = (code === 'P5' && levels !== 5) ? 'P4' : code;
      // "High-Next Day" style: severity present AND a time qualifier → note the time part moves to SLA
      const hasTime = TIME_WORDS.test(v.replace(SEVERITY_WORDS[0][0], '').replace(/\bhigh|medium|low|critical\b/i, ''));
      const rationale = hasTime
        ? `Severity "${v}" also encodes a response time — keep the severity as ${mapped}; move the timing into the SLA target (§ targets).`
        : `Severity value maps to ${mapped} in the clean scheme.`;
      return { current: value, classify: 'severity', recommend: mapped, rationale };
    }
  }
  if (WORKTYPE_WORDS.test(v)) {
    return { current: value, classify: 'work-type', recommend: 'Issue/Sub-issue or a Queue', rationale: 'Describes the kind of work, not its severity — model it as issue type or queue.' };
  }
  if (TIME_WORDS.test(v)) {
    return { current: value, classify: 'response-time', recommend: 'SLA target, not priority', rationale: 'Expresses a response time — belongs in the SLA definition, not the priority picklist.' };
  }
  return { current: value, classify: 'unknown', recommend: 'Review manually', rationale: 'Could not classify automatically; decide whether it is a severity, a work type, or an SLA.' };
}

/** Generate an ITIL-standard SLA framework to enter in the Autotask UI. Pure. */
export function generateSlaFramework(input: SlaFrameworkInput = {}): SlaFrameworkResult {
  const levels = input.levels === 5 ? 5 : 4;
  const bhpd = input.businessHoursPerDay && input.businessHoursPerDay > 0 ? input.businessHoursPerDay : 8;
  const requestTypes: RequestType[] = input.requestTypes?.length ? input.requestTypes : ['Incident', 'ServiceRequest'];
  const tiers: Tier[] = input.tiers?.length ? input.tiers : [{ name: 'Standard', multiplier: 1 }];
  const srMult = input.serviceRequestResolutionMultiplier && input.serviceRequestResolutionMultiplier > 0 ? input.serviceRequestResolutionMultiplier : 2;

  const scheme = buildScheme(levels, bhpd, input.overrides);
  const matrix = buildMatrix(levels);

  const targets: SlaTargetRow[] = [];
  for (const lvl of scheme) {
    for (const rt of requestTypes) {
      for (const tier of tiers) {
        const coverage = tier.coverage ?? lvl.coverage;
        const bh = coverage === '24x7' ? false : lvl.firstResponse.businessHours;
        const m = tier.multiplier > 0 ? tier.multiplier : 1;
        // Service Requests: same responsiveness, looser plan/resolution (catalog may override).
        const planMult = rt === 'ServiceRequest' ? srMult : 1;
        const resMult = rt === 'ServiceRequest' ? srMult : 1;
        targets.push({
          priority: lvl.code,
          priorityName: lvl.name,
          requestType: rt,
          tier: tier.name,
          coverage,
          firstResponse: fmt(Math.round(lvl.firstResponse.minutes * m), bh, bhpd),
          resolutionPlan: fmt(Math.round(lvl.resolutionPlan.minutes * m * planMult), bh, bhpd),
          resolution: fmt(Math.round(lvl.resolution.minutes * m * resMult), bh, bhpd),
        });
      }
    }
  }

  const priorityMigration = input.currentPriorities?.length
    ? input.currentPriorities.map((p) => classifyPriority(p, levels))
    : null;

  const uiSteps = [
    'Admin → Features & Settings → Service Desk → Priorities: create the clean P1–P' + levels + ' values; retire drifted values once open tickets are migrated.',
    'Admin → Features & Settings → Service Desk → Service Level Management: create one SLA per customer tier, entering the response / resolution-plan / resolution targets from the targets matrix.',
    'Admin → Internal → set business hours & holidays so business-hours targets compute correctly.',
    'Contracts: set serviceLevelAgreementID on each contract to the matching tier SLA (this step IS API-writable — a later MCP slice can bulk-assign it).',
    'Run autotask_report_sla_compliance to confirm due-dates now populate and compliance is measured, not just actuals.',
  ];
  const notes = [
    'ADVISORY ONLY — this tool writes nothing to Autotask. SLA and priority DEFINITIONS are UI-only (no REST entity for ServiceLevelAgreements; the priority picklist is not API-writable).',
    'Impact × Urgency is decision guidance: Autotask has no impact/urgency field, so dispatch runs the matrix and stores the resulting priority.',
    'Targets are ITIL-typical starting values — tune them to what you can commit to. Set them against your observed medians (autotask_report_sla_compliance surfaces actuals even before SLAs exist).',
    'Service Request rows loosen plan/resolution vs Incidents at the same priority (×' + srMult + '); individual catalog items can carry their own fulfilment times.',
  ];

  return { levels, businessHoursPerDay: bhpd, priorityMatrix: matrix, priorityScheme: scheme, priorityMigration, targets, uiSteps, notes };
}
