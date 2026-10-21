// When does the TEAM work? From the mirror (no Autotask calls): time entries and ticket notes
// written by people, per local hour, over the last weeks. This MCP's own traffic can't say it —
// technicians work in the Autotask UI, and the bulk worker's own writes made the evenings look
// busy (it runs faster off hours). Resource 4 (Autotask Administrator) writes workflow notes and
// is left out, as are notes with no creator.

import type { Pool } from 'pg';
import { suggestWindow } from './schedule.js';

export const ACTIVITY_DAYS = 28;

/** The events (kind, record id, resource, local time) of the window; $1 = time zone, $2 = days. */
const EVENTS = `
    WITH ev AS (
      SELECT 'time entry' AS kind, id, (data->>'resourceID') AS who, (data->>'createDateTime')::timestamptz AS ts, data->>'ticketID' AS ticket
        FROM shadow_record
       WHERE entity = 'TimeEntries' AND deleted_at IS NULL AND data->>'createDateTime' ~ '^\\d{4}-\\d\\d-\\d\\dT'
      UNION ALL
      SELECT 'ticket note', id, (data->>'creatorResourceID'), (data->>'createDateTime')::timestamptz, data->>'ticketID'
        FROM shadow_record
       WHERE entity = 'TicketNotes' AND deleted_at IS NULL AND data->>'createDateTime' ~ '^\\d{4}-\\d\\d-\\d\\dT'
         AND coalesce(data->>'creatorResourceID', '') ~ '^\\d+$' AND (data->>'creatorResourceID')::bigint <> 4
    ), loc AS (SELECT kind, id, who, ticket, ts, ts AT TIME ZONE $1 AS t FROM ev WHERE ts >= now() - make_interval(days => $2::int) AND ts <= now())`;

/** Drill-down for one local hour: per kind, per day of week, per person, and the latest records. */
export async function teamActivityHour(pool: Pool, tz: string, hour: number, days = ACTIVITY_DAYS): Promise<Record<string, unknown>> {
  const h = Math.min(Math.max(Math.floor(hour), 0), 23);
  const where = 'WHERE extract(hour FROM t)::int = $3';
  const q = <T extends Record<string, unknown>>(sql: string) => pool.query<T>(`${EVENTS} ${sql}`, [tz, days, h]).then((r) => r.rows);
  const name = `(SELECT trim(coalesce(r.data->>'firstName', '') || ' ' || coalesce(r.data->>'lastName', '')) FROM shadow_record r WHERE r.entity = 'Resources' AND r.id::text = loc.who LIMIT 1)`;
  const [byKind, byDay, byPerson, latest] = await Promise.all([
    q<{ kind: string; n: number }>(`SELECT kind, count(*)::int n FROM loc ${where} GROUP BY 1 ORDER BY 2 DESC`),
    q<{ dow: number; n: number }>(`SELECT extract(dow FROM t)::int dow, count(*)::int n FROM loc ${where} GROUP BY 1 ORDER BY 1`),
    q<{ who: string; name: string | null; n: number }>(`SELECT who, ${name} AS name, count(*)::int n FROM loc ${where} GROUP BY who ORDER BY 3 DESC LIMIT 15`),
    q<{ kind: string; id: string; who: string; name: string | null; ticket: string | null; at: string }>(`SELECT kind, id::text, who, ${name} AS name, ticket, to_char(t, 'YYYY-MM-DD HH24:MI') AS at FROM loc ${where} ORDER BY ts DESC LIMIT 25`),
  ]);
  return { tz, days, hour: h, byKind, byDay, byPerson, latest };
}

export async function teamActivityProfile(pool: Pool, tz: string, days = ACTIVITY_DAYS): Promise<Record<string, unknown>> {
  const r = await pool.query<{ dow: number; hour: number; n: number; events: number }>(`${EVENTS}
    -- People active per hour, not events: one person catching up 27 time entries in an hour counts once.
    SELECT extract(dow FROM t)::int AS dow, extract(hour FROM t)::int AS hour, count(DISTINCT (who, t::date))::int AS n, count(*)::int AS events FROM loc GROUP BY 1, 2`, [tz, days]);
  return profileFromCounts(r.rows, tz, days);
}

/** Pure part (tested): counts per (day of week, hour) → average per day, weekday / weekend, and a window. */
/** n = people active in that hour on that day (summed over the days); events = the records behind them. */
export function profileFromCounts(rows: Array<{ dow: number; hour: number; n: number; events?: number }>, tz: string, days = ACTIVITY_DAYS): Record<string, unknown> {
  const wd = new Array(24).fill(0), we = new Array(24).fill(0);
  let total = 0, events = 0;
  for (const x of rows) { (x.dow === 0 || x.dow === 6 ? we : wd)[x.hour] += x.n; total += x.n; events += x.events ?? x.n; }
  // Days in the window of each kind (an average per day, not per hour of data).
  const weeks = days / 7;
  const per = (a: number[], k: number) => a.map((v) => Math.round((v / Math.max(1, weeks * k)) * 100) / 100);
  const weekday = per(wd, 5), weekend = per(we, 2);
  return {
    tz, days, events, personHours: total, unit: 'people active per hour (average per day)', source: 'team activity',
    weekdayAvgPerHour: weekday, weekendAvgPerHour: weekend,
    suggested: total >= 100 ? suggestWindow(wd) : null, // exact counts, not the rounded averages
    note: `People active (writing time entries or ticket notes — not automation) per local hour, average per day, over the last ${days} days — from the mirror, no Autotask calls. Shows when the team works, so bulk jobs run slower then.`,
  };
}
