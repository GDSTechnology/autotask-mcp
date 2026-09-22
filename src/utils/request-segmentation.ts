// Request segmentation dimension (#100). Pure aggregation.
//
// The "what kind of work is this?" lens the other #100 reports can be read
// through: split tickets into delivery segments — project / install / recurring
// (managed) / support (reactive), or any scheme the tenant runs — and report KPIs
// per segment (volume, open backlog, completion, age, share).
//
// Tenant-agnostic: segment RULES are caller-provided (queues/types/priorities are
// tenant-specific). When none are given it falls back to the universal ITIL
// request classification by ticketType (1=Service Request, 2=Incident, 3=Problem,
// 4=Change, 5=Alert). First matching rule wins; a rule matches when EVERY criterion
// it specifies is satisfied (OR within each criterion's value set).

export interface SegmentRule {
  name: string;
  ticketType?: number[] | undefined;
  queueID?: number[] | undefined;
  priority?: number[] | undefined;
  issueType?: number[] | undefined;
  /** case-insensitive substrings matched against the ticket title */
  titleContains?: string[] | undefined;
}

export interface SegRawTicket {
  id: number;
  ticketType?: number | null;
  queueID?: number | null;
  priority?: number | null;
  issueType?: number | null;
  title?: string | null;
  status?: number | null;
  createDate?: string | null;
  completedDate?: string | null;
}

export interface SegmentKpi {
  name: string;
  total: number;
  open: number;
  completed: number;
  avgAgeDaysOpen: number | null;
  sharePct: number | null;
}

export interface RequestSegmentationResult {
  from: string;
  to: string;
  openOnly: boolean;
  ticketsEvaluated: number;
  rulesUsed: 'custom' | 'default-itil';
  defaultSegmentName: string;
  segments: SegmentKpi[];
  truncated?: boolean | undefined;
}

const DAY = 86_400_000;
const round1 = (n: number) => Math.round(n * 10) / 10;

export const DEFAULT_ITIL_SEGMENTS: SegmentRule[] = [
  { name: 'Service Request', ticketType: [1] },
  { name: 'Incident', ticketType: [2] },
  { name: 'Problem', ticketType: [3] },
  { name: 'Change', ticketType: [4] },
  { name: 'Alert', ticketType: [5] },
];

function inSet(v: number | null | undefined, set: number[] | undefined): boolean | null {
  if (!set || set.length === 0) return null; // criterion not specified
  return v != null && set.includes(v);
}

function ruleMatches(t: SegRawTicket, rule: SegmentRule): boolean {
  const checks = [
    inSet(t.ticketType, rule.ticketType),
    inSet(t.queueID, rule.queueID),
    inSet(t.priority, rule.priority),
    inSet(t.issueType, rule.issueType),
  ];
  let specified = 0;
  for (const c of checks) {
    if (c === null) continue;
    specified++;
    if (c === false) return false;
  }
  if (rule.titleContains && rule.titleContains.length) {
    specified++;
    const title = (t.title ?? '').toLowerCase();
    if (!rule.titleContains.some((s) => title.includes(s.toLowerCase()))) return false;
  }
  return specified > 0; // an empty rule matches nothing
}

/** Assign a ticket to the first matching segment, else the default. Pure. */
export function classifyRequestSegment(t: SegRawTicket, rules: SegmentRule[], defaultSegment: string): string {
  for (const r of rules) if (ruleMatches(t, r)) return r.name;
  return defaultSegment;
}

export function computeRequestSegmentation(
  tickets: SegRawTicket[],
  from: string,
  to: string,
  opts: { segments?: SegmentRule[] | undefined; defaultSegmentName?: string | undefined; openOnly?: boolean | undefined; now?: Date | undefined } = {},
): RequestSegmentationResult {
  const nowMs = (opts.now ?? new Date()).getTime();
  const custom = opts.segments && opts.segments.length > 0;
  const rules = custom ? opts.segments! : DEFAULT_ITIL_SEGMENTS;
  const defaultSegmentName = opts.defaultSegmentName ?? (custom ? 'Unsegmented' : 'Other');

  // Preserve declared order, with the default bucket last.
  const order = [...rules.map((r) => r.name), defaultSegmentName];
  const agg = new Map<string, { total: number; open: number; completed: number; ageSum: number; ageN: number }>();
  const ensure = (name: string) => {
    let a = agg.get(name);
    if (!a) { a = { total: 0, open: 0, completed: 0, ageSum: 0, ageN: 0 }; agg.set(name, a); }
    return a;
  };

  for (const t of tickets) {
    const seg = classifyRequestSegment(t, rules, defaultSegmentName);
    const a = ensure(seg);
    a.total++;
    const isOpen = t.completedDate == null;
    if (isOpen) {
      a.open++;
      if (t.createDate) { const c = Date.parse(t.createDate); if (!Number.isNaN(c)) { a.ageSum += Math.max(0, (nowMs - c) / DAY); a.ageN++; } }
    } else a.completed++;
  }

  const total = tickets.length;
  const segments: SegmentKpi[] = order
    .filter((name, i) => order.indexOf(name) === i) // dedupe
    .map((name) => {
      const a = agg.get(name);
      if (!a) return { name, total: 0, open: 0, completed: 0, avgAgeDaysOpen: null, sharePct: total > 0 ? 0 : null };
      return {
        name,
        total: a.total,
        open: a.open,
        completed: a.completed,
        avgAgeDaysOpen: a.ageN > 0 ? round1(a.ageSum / a.ageN) : null,
        sharePct: total > 0 ? Math.round((a.total / total) * 1000) / 10 : null,
      };
    })
    .filter((s) => s.total > 0 || s.name !== defaultSegmentName); // hide an empty default bucket

  return {
    from, to,
    openOnly: opts.openOnly ?? false,
    ticketsEvaluated: total,
    rulesUsed: custom ? 'custom' : 'default-itil',
    defaultSegmentName,
    segments,
  };
}
