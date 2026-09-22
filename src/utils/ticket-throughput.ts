// Ticket throughput / work-queue KPIs (#100). Pure aggregation.
//
// Two views the service desk actually runs on:
//   FLOW (over a window): created vs completed vs completion ratio + net backlog
//     change — is the team keeping up with intake?
//   BACKLOG (now): open tickets by age bucket, by status, oldest-open — where the
//     backlog is piling up and how stale it is.
// Status is left as the raw value + resolved label (open/waiting/on-hold splits are
// tenant-specific), so the report stays tenant-agnostic. Optional grouping by
// queue / resource / company gives per-team throughput. Read-only; service fetches.

export interface RawT {
  id: number;
  createDate?: string | null;
  completedDate?: string | null;
  status?: number | null;
  queueID?: number | null;
  assignedResourceID?: number | null;
  companyID?: number | null;
}

export interface AgingBucket { bucket: string; count: number }
export interface StatusCount { status: number | null; label: string | null; count: number }

export interface ThroughputGroup {
  key: string;
  open: number;
  created: number;
  completed: number;
  completionRatio: number | null;
}

export interface TicketThroughputResult {
  from: string;
  to: string;
  flow: { created: number; completed: number; completionRatio: number | null; netBacklogChange: number };
  backlog: {
    open: number;
    aging: AgingBucket[];
    oldestOpenDays: number | null;
    byStatus: StatusCount[];
  };
  groups?: ThroughputGroup[] | undefined;
  truncated?: { created?: boolean; completed?: boolean; open?: boolean } | undefined;
}

const DAY = 86_400_000;

function ageDays(createDate: string | null | undefined, nowMs: number): number | null {
  if (!createDate) return null;
  const c = Date.parse(createDate);
  if (Number.isNaN(c)) return null;
  return Math.max(0, Math.floor((nowMs - c) / DAY));
}

/** Build labels like "0-7", "8-30", "31-90", "90+" from ascending thresholds. */
function bucketLabels(thresholds: number[]): string[] {
  const labels: string[] = [];
  let lo = 0;
  for (const t of thresholds) { labels.push(`${lo}-${t}`); lo = t + 1; }
  labels.push(`${lo}+`);
  return labels;
}
function bucketIndex(age: number, thresholds: number[]): number {
  for (let i = 0; i < thresholds.length; i++) if (age <= thresholds[i]) return i;
  return thresholds.length;
}

const ratio = (num: number, den: number): number | null => den > 0 ? Math.round((num / den) * 1000) / 1000 : null;

export function computeTicketThroughput(
  input: {
    created: RawT[]; completed: RawT[]; open: RawT[];
    from: string; to: string; now?: Date;
    agingThresholds?: number[] | undefined;
    groupBy?: 'queue' | 'resource' | 'company' | undefined;
    statusLabels?: Map<number, string> | undefined;
  },
): TicketThroughputResult {
  const nowMs = (input.now ?? new Date()).getTime();
  const thresholds = (input.agingThresholds && input.agingThresholds.length ? input.agingThresholds : [7, 30, 90])
    .slice().sort((a, b) => a - b);
  const labels = bucketLabels(thresholds);

  const createdN = input.created.length;
  const completedN = input.completed.length;

  // Backlog aging + by-status
  const aging = labels.map((bucket) => ({ bucket, count: 0 }));
  const statusMap = new Map<number | null, number>();
  let oldest: number | null = null;
  for (const t of input.open) {
    const a = ageDays(t.createDate, nowMs);
    if (a != null) {
      aging[bucketIndex(a, thresholds)].count++;
      if (oldest == null || a > oldest) oldest = a;
    }
    const key = t.status ?? null;
    statusMap.set(key, (statusMap.get(key) ?? 0) + 1);
  }
  const byStatus: StatusCount[] = [...statusMap.entries()]
    .map(([status, count]) => ({ status, label: status != null ? (input.statusLabels?.get(status) ?? null) : null, count }))
    .sort((a, b) => b.count - a.count);

  let groups: ThroughputGroup[] | undefined;
  if (input.groupBy) {
    const keyOf = (t: RawT): string => {
      switch (input.groupBy) {
        case 'queue': return t.queueID != null ? `queue:${t.queueID}` : 'queue:none';
        case 'resource': return t.assignedResourceID != null ? `resource:${t.assignedResourceID}` : 'resource:unassigned';
        case 'company': return t.companyID != null ? `company:${t.companyID}` : 'company:none';
        default: return '';
      }
    };
    const m = new Map<string, { open: number; created: number; completed: number }>();
    const bump = (t: RawT, field: 'open' | 'created' | 'completed') => {
      const k = keyOf(t);
      let g = m.get(k);
      if (!g) { g = { open: 0, created: 0, completed: 0 }; m.set(k, g); }
      g[field]++;
    };
    for (const t of input.open) bump(t, 'open');
    for (const t of input.created) bump(t, 'created');
    for (const t of input.completed) bump(t, 'completed');
    groups = [...m.entries()]
      .map(([key, g]) => ({ key, ...g, completionRatio: ratio(g.completed, g.created) }))
      .sort((a, b) => b.open - a.open || b.created - a.created);
  }

  return {
    from: input.from,
    to: input.to,
    flow: {
      created: createdN,
      completed: completedN,
      completionRatio: ratio(completedN, createdN),
      netBacklogChange: createdN - completedN,
    },
    backlog: {
      open: input.open.length,
      aging,
      oldestOpenDays: oldest,
      byStatus,
    },
    ...(groups ? { groups } : {}),
  };
}
