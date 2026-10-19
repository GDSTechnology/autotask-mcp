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

/** Writes possible in a week under the schedule (for an ETA). */
export function weeklyCapacity(offHoursRate: number, s: BusinessSchedule | null | undefined): number {
  if (!s) return offHoursRate * 168;
  const businessHours = s.days.length * Math.max(0, s.end - s.start);
  return businessHours * Math.min(s.businessRate, offHoursRate) + (168 - businessHours) * offHoursRate;
}

/**
 * Busy hours from traffic: average Autotask calls per local hour of the day, weekdays and
 * weekends apart, and the weekday hours at or above half the weekday peak — a suggested
 * business window (a person confirms it).
 */
export function activityProfile(hourly: Array<{ hour: number; upstream: number; writes: number }>, tz: string): Record<string, unknown> {
  const sum = { weekday: new Array(24).fill(0), weekend: new Array(24).fill(0) };
  const n = { weekday: new Array(24).fill(0), weekend: new Array(24).fill(0) };
  for (const h of hourly) {
    const { day, hour } = localDayHour(new Date(h.hour * 3_600_000), tz);
    const k = day === 0 || day === 6 ? 'weekend' : 'weekday';
    sum[k][hour] += h.upstream + h.writes; n[k][hour]++;
  }
  const avg = (k: 'weekday' | 'weekend') => sum[k].map((v, i) => (n[k][i] ? Math.round(v / n[k][i]) : null));
  const wd = avg('weekday');
  const peak = Math.max(0, ...wd.map((v) => v ?? 0));
  const busy = wd.map((v, i) => (v != null && peak > 0 && v >= peak / 2 ? i : -1)).filter((i) => i >= 0);
  return {
    tz, hoursOfData: hourly.length,
    weekdayAvgPerHour: wd, weekendAvgPerHour: avg('weekend'),
    suggested: busy.length ? { days: [1, 2, 3, 4, 5], start: Math.min(...busy), end: Math.max(...busy) + 1 } : null,
    note: 'This MCP’s own Autotask calls per hour (the largest share of the tenant’s usage); other integrations add to it. Hours with no data are null.',
  };
}
