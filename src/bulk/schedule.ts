// Business-hours pacing for bulk jobs: a slower rate while people (and n8n, and the other
// integrations) are busy, the full rate outside. And "when are we busy?" — an hour-of-day
// profile from this MCP's own Autotask traffic (kept 7 days), to choose the window from data.

export interface BusinessSchedule {
  /** IANA time zone, e.g. America/New_York. */
  tz: string;
  /** Days that have business hours: 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** Local hours [start, end): 7 → 19 is 07:00–18:59. */
  start: number; end: number;
  /** Writes per hour inside business hours (the job's ratePerHour applies outside). */
  businessRate: number;
}

export const DEFAULT_SCHEDULE: BusinessSchedule = { tz: 'America/New_York', days: [1, 2, 3, 4, 5], start: 7, end: 19, businessRate: 1000 };

/**
 * Quiet hours: local hours when a bulk job writes NOTHING — another integration's burst window
 * (Autotask's API Activity By Hour, 2026-10-20/21: an email-to-ticket connector made 6,000–9,200
 * calls at 21:00 and 00:00–03:59; with the Gmail cleanup on top, 02:00 reached 12,481 → 429s).
 * [start, end) in the job's time zone; days optional (default every day).
 */
export interface QuietWindow { start: number; end: number; days?: number[] }
export const DEFAULT_QUIET_HOURS: QuietWindow[] = [{ start: 0, end: 4 }, { start: 21, end: 22 }];

/** "0-4, 21-22" (or an array of windows, or [] / "none" for no quiet hours) → validated windows. Throws on nonsense. */
export function parseQuietHours(v: unknown): QuietWindow[] {
  if (v == null || v === '') return DEFAULT_QUIET_HOURS;
  if (v === false || (typeof v === 'string' && /^\s*(none|off|no)\s*$/i.test(v))) return [];
  const list: unknown[] = Array.isArray(v) ? v : String(v).split(/[,;]+/).map((s) => s.trim()).filter(Boolean);
  return list.map((x) => {
    let start: number, end: number, days: number[] | undefined;
    if (typeof x === 'string') {
      const m = /^(\d{1,2})(?::00)?\s*[-–]\s*(\d{1,2})(?::00)?$/.exec(x);
      if (!m) throw new Error(`quietHours: "${x}" — use local hours like "0-4, 21-22" (end not included; "none" for no quiet hours).`);
      start = Number(m[1]); end = Number(m[2]);
    } else {
      const o = x as Record<string, unknown>;
      start = Number(o.start); end = Number(o.end);
      if (Array.isArray(o.days)) days = o.days.map(Number);
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > 24 || start >= end) throw new Error(`quietHours: ${start}-${end} — hours 0–24, start before end (split a window that crosses midnight: "22-24, 0-4").`);
    if (days && days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('quietHours: days are 0 (Sunday) … 6 (Saturday).');
    return days ? { start, end, days } : { start, end };
  });
}

/** A job's quiet hours: params.quietHours, or the defaults when the job predates them (absent). [] = none. */
export function quietOf(params: Record<string, unknown> | null | undefined): QuietWindow[] {
  const q = params?.quietHours;
  return Array.isArray(q) ? (q as QuietWindow[]) : DEFAULT_QUIET_HOURS;
}

/** The quiet window covering this instant, if any. */
export function quietWindowAt(at: Date, quiet: QuietWindow[], tz: string): QuietWindow | null {
  if (!quiet.length) return null;
  const { day, hour } = localDayHour(at, tz);
  return quiet.find((w) => hour >= w.start && hour < w.end && (!w.days || w.days.includes(day))) ?? null;
}

/** Local weekday (0–6) and hour (0–23) of an instant in a time zone. */
export function localDayHour(at: Date, tz: string): { day: number; hour: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(at);
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun';
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  return { day: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd), hour };
}

export function inBusinessHours(at: Date, s: BusinessSchedule): boolean {
  const { day, hour } = localDayHour(at, s.tz);
  return s.days.includes(day) && hour >= s.start && hour < s.end;
}

/** The write rate right now: business rate inside the window, the job's rate outside. */
export function currentRate(at: Date, offHoursRate: number, s: BusinessSchedule | null | undefined): { rate: number; business: boolean } {
  if (!s) return { rate: offHoursRate, business: false };
  const business = inBusinessHours(at, s);
  return { rate: business ? Math.min(s.businessRate, offHoursRate) : offHoursRate, business };
}

/** Writes possible in a week under the schedule, quiet hours writing nothing (for an ETA). */
export function weeklyCapacity(offHoursRate: number, s: BusinessSchedule | null | undefined, quiet: QuietWindow[] = []): number {
  let total = 0;
  for (let day = 0; day < 7; day++) for (let hour = 0; hour < 24; hour++) {
    if (quiet.some((w) => hour >= w.start && hour < w.end && (!w.days || w.days.includes(day)))) continue;
    total += s && s.days.includes(day) && hour >= s.start && hour < s.end ? Math.min(s.businessRate, offHoursRate) : offHoursRate;
  }
  return total;
}

/**
 * The business window from an hourly profile: the longest run of consecutive hours at or above
 * 35% of the peak. No suggestion when nothing stands out (20+ hours qualify — a flat profile; the
 * old "every hour above half the peak, first to last" rule answered 00:00–24:00 then).
 */
export function suggestWindow(perHour: Array<number | null>): { days: number[]; start: number; end: number } | null {
  const v = perHour.map((x) => x ?? 0);
  const peak = Math.max(0, ...v);
  if (peak <= 0) return null;
  let best = { start: 0, len: 0 }, cur = { start: 0, len: 0 };
  for (let i = 0; i < 24; i++) {
    if (v[i]! >= peak * 0.35) { cur = cur.len ? { start: cur.start, len: cur.len + 1 } : { start: i, len: 1 }; if (cur.len > best.len) best = cur; }
    else cur = { start: 0, len: 0 };
  }
  if (best.len === 0 || best.len >= 20) return null;
  return { days: [1, 2, 3, 4, 5], start: best.start, end: best.start + best.len };
}

/**
 * Busy hours from traffic: average Autotask calls per local hour of the day, weekdays and
 * weekends apart, and the weekday hours at or above half the weekday peak — a suggested
 * business window (a person confirms it).
 */
export function activityProfile(hourly: Array<{ hour: number; upstream: number; writes: number; byTools?: number }>, tz: string): Record<string, unknown> {
  const sum = { weekday: new Array(24).fill(0), weekend: new Array(24).fill(0) };
  const n = { weekday: new Array(24).fill(0), weekend: new Array(24).fill(0) };
  for (const h of hourly) {
    const { day, hour } = localDayHour(new Date(h.hour * 3_600_000), tz);
    const k = day === 0 || day === 6 ? 'weekend' : 'weekday';
    // What people and their tools cause (n8n, agents, the console) — background mirror jobs run at night and say nothing about business hours.
    // Writes are left out: the bulk worker's own writes would measure the job itself (faster off hours).
    sum[k][hour] += h.byTools ?? h.upstream; n[k][hour]++;
  }
  const avg = (k: 'weekday' | 'weekend') => sum[k].map((v, i) => (n[k][i] ? Math.round(v / n[k][i]) : null));
  const wd = avg('weekday');
  // Too little traffic to say (e.g. right after a restart, or a quiet tenant): no suggestion.
  const enough = hourly.length >= 72;
  return {
    tz, hoursOfData: hourly.length,
    weekdayAvgPerHour: wd, weekendAvgPerHour: avg('weekend'),
    source: 'MCP traffic', suggested: enough ? suggestWindow(wd) : null,
    note: 'Autotask calls per hour caused by tool calls through this MCP (n8n, agents, people) — the mirror’s background sync / check jobs are left out. Other integrations add to the tenant’s usage. Hours with no data are null. The suggested window is the BUSY hours: the slower business rate applies there.',
  };
}
