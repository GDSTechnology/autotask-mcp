// When does the TEAM work? From the mirror (no Autotask calls): time entries and ticket notes
// per local hour, over the last weeks, split by WHO wrote them:
//   person       a licensed user, writing in Autotask themselves;
//   integration  an API user (RMM, an integration platform, Nexus…) or other automation;
//   mcp          written THROUGH THIS MCP (n8n, Nexus, ChatGPT — from its operation log),
//                even when Autotask credits a person (impersonated writes look human);
//   unknown      a resource the actor classification can't place.
// Only "person" work sets the business window. This MCP's own traffic can't say it — technicians
// work in the Autotask UI, and the bulk worker's writes made the evenings look busy. Resource 4
// (Autotask Administrator) is left out.

import type { Pool } from 'pg';
import { suggestWindow } from './schedule.js';
import { classifyActor, parseReference, parseRegistry, type ActorRecord, type ClassifyContext } from '../utils/actor-classify.js';
import { settingValue } from '../admin/settings.js';

export const ACTIVITY_DAYS = 28;
export type ActorKind = 'person' | 'integration' | 'mcp' | 'unknown';
export type Classify = (resourceId: number) => { name: string | null; kind: Exclude<ActorKind, 'mcp'> };

/** The events (kind, record, resource, written through this MCP?, local time) of the window; $1 = time zone, $2 = days. */
const EVENTS = `
    WITH ev AS (
      SELECT 'time entry' AS kind, 'timeEntry' AS op_type, id, (data->>'resourceID') AS who, (data->>'createDateTime')::timestamptz AS ts, data->>'ticketID' AS ticket
        FROM shadow_record
       WHERE entity = 'TimeEntries' AND deleted_at IS NULL AND data->>'createDateTime' ~ '^\\d{4}-\\d\\d-\\d\\dT'
      UNION ALL
      SELECT 'ticket note', 'ticketNote', id, (data->>'creatorResourceID'), (data->>'createDateTime')::timestamptz, data->>'ticketID'
        FROM shadow_record
       WHERE entity = 'TicketNotes' AND deleted_at IS NULL AND data->>'createDateTime' ~ '^\\d{4}-\\d\\d-\\d\\dT'
         AND coalesce(data->>'creatorResourceID', '') ~ '^\\d+$' AND (data->>'creatorResourceID')::bigint <> 4
    ), loc AS (
      SELECT ev.kind, ev.id, ev.who, ev.ticket, ev.ts, ev.ts AT TIME ZONE $1 AS t,
             (SELECT o.source FROM mcp_operation_write w JOIN mcp_operation o USING (operation_id)
               WHERE w.entity_type = ev.op_type AND w.entity_id = ev.id LIMIT 1) AS via
        FROM ev WHERE ev.ts >= now() - make_interval(days => $2::int) AND ev.ts <= now()
    )`;

const label = (kind: ActorKind, name: string | null, who: string, via: string | null) =>
  kind === 'mcp' ? `${name ?? `#${who}`} via this MCP${via && via !== 'unknown' ? ` (${via})` : ''}` : (name ?? `#${who}`);

export async function teamActivityProfile(pool: Pool, tz: string, classify: Classify, days = ACTIVITY_DAYS): Promise<Record<string, unknown>> {
  const r = await pool.query<{ dow: number; hour: number; who: string; via: string | null; n: number; events: number }>(`${EVENTS}
    -- per person-day: one person catching up 27 entries in an hour counts once for "people active".
    SELECT extract(dow FROM t)::int AS dow, extract(hour FROM t)::int AS hour, who, via, count(DISTINCT t::date)::int AS n, count(*)::int AS events
      FROM loc GROUP BY 1, 2, 3, 4`, [tz, days]);
  return profileFromRows(r.rows, tz, classify, days);
}

interface Series { key: string; label: string; kind: ActorKind; weekday: number[]; weekend: number[]; total: number }

/** Pure part (tested). Rows: per (day of week, hour, resource, via-MCP source): n person-days, events records. */
export function profileFromRows(rows: Array<{ dow: number; hour: number; who: string; via: string | null; n: number; events: number }>, tz: string, classify: Classify, days = ACTIVITY_DAYS, topPerKind = 8): Record<string, unknown> {
  const weeks = days / 7;
  const per = (v: number, weekend: boolean) => v / Math.max(1, weeks * (weekend ? 2 : 5));
  const series = new Map<string, Series>();
  const people = new Array(24).fill(0); // person-days per weekday hour (people active), persons only
  let events = 0;
  for (const x of rows) {
    const c = classify(Number(x.who));
    const kind: ActorKind = x.via ? 'mcp' : c.kind;
    const key = `${kind}:${x.who}`;
    const s = series.get(key) ?? series.set(key, { key, label: label(kind, c.name, x.who, x.via), kind, weekday: new Array(24).fill(0), weekend: new Array(24).fill(0), total: 0 }).get(key)!;
    const weekend = x.dow === 0 || x.dow === 6;
    (weekend ? s.weekend : s.weekday)[x.hour] += x.events;
    s.total += x.events; events += x.events;
    if (kind === 'person' && !weekend) people[x.hour] += x.n;
  }
  // The biggest few per kind keep their own colour; the rest fold into "Other …".
  const out: Series[] = [];
  for (const kind of ['person', 'mcp', 'integration', 'unknown'] as ActorKind[]) {
    const list = [...series.values()].filter((s) => s.kind === kind).sort((a, b) => b.total - a.total);
    out.push(...list.slice(0, topPerKind));
    const rest = list.slice(topPerKind);
    if (rest.length) out.push(rest.reduce<Series>((acc, s) => { s.weekday.forEach((v, i) => { acc.weekday[i] += v; }); s.weekend.forEach((v, i) => { acc.weekend[i] += v; }); acc.total += s.total; return acc; },
      { key: `${kind}:other`, label: `Other ${kind === 'person' ? 'people' : kind === 'mcp' ? 'via this MCP' : kind === 'integration' ? 'integrations' : 'unknown'} (${rest.length})`, kind, weekday: new Array(24).fill(0), weekend: new Array(24).fill(0), total: 0 }));
  }
  const round = (v: number) => Math.round(v * 100) / 100;
  const personDays = people.reduce((a, b) => a + b, 0);
  return {
    tz, days, events, source: 'team activity', unit: 'records written per hour, average day',
    series: out.map((s) => ({ key: s.key, label: s.label, kind: s.kind, total: s.total, weekday: s.weekday.map((v) => round(per(v, false))), weekend: s.weekend.map((v) => round(per(v, true))) })),
    peopleActivePerHour: people.map((v) => round(per(v, false))),
    // Legacy shape (sum of everything) for clients that read it.
    weekdayAvgPerHour: new Array(24).fill(0).map((_, i) => round(out.reduce((t, s) => t + per(s.weekday[i]!, false), 0))),
    weekendAvgPerHour: new Array(24).fill(0).map((_, i) => round(out.reduce((t, s) => t + per(s.weekend[i]!, true), 0))),
    // The window from PEOPLE only (person-days, exact counts) — integrations and MCP writes run around the clock.
    suggested: personDays >= 100 ? suggestWindow(people) : null,
    note: `Time entries and ticket notes per local hour over the last ${days} days, from the mirror (no Autotask calls), split by who wrote them. "via this MCP" = written through this MCP (n8n, Nexus, ChatGPT), even when Autotask credits a person. Only people set the suggested business hours.`,
  };
}

/** Drill-down for one local hour: per kind, per day of week, per resource (with its kind), and the latest records with their ticket. */
export async function teamActivityHour(pool: Pool, tz: string, hour: number, classify: Classify, days = ACTIVITY_DAYS): Promise<Record<string, unknown>> {
  const h = Math.min(Math.max(Math.floor(hour), 0), 23);
  const where = 'WHERE extract(hour FROM t)::int = $3';
  const q = <T extends Record<string, unknown>>(sql: string) => pool.query<T>(`${EVENTS} ${sql}`, [tz, days, h]).then((r) => r.rows);
  const [byKind, byDay, byWho, latest] = await Promise.all([
    q<{ kind: string; n: number }>(`SELECT kind, count(*)::int n FROM loc ${where} GROUP BY 1 ORDER BY 2 DESC`),
    q<{ dow: number; n: number }>(`SELECT extract(dow FROM t)::int dow, count(*)::int n FROM loc ${where} GROUP BY 1 ORDER BY 1`),
    q<{ who: string; via: string | null; n: number }>(`SELECT who, via, count(*)::int n FROM loc ${where} GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 25`),
    // People read the TICKET NUMBER (T2026…), with its title and company — not the record id.
    q<{ kind: string; id: string; who: string; via: string | null; at: string; ticket: string | null; ticketNumber: string | null; title: string | null; company: string | null }>(`
      SELECT loc.kind, loc.id::text, loc.who, loc.via, to_char(loc.t, 'YYYY-MM-DD HH24:MI') AS at, loc.ticket,
             tk.data->>'ticketNumber' AS "ticketNumber", tk.data->>'title' AS title, co.data->>'companyName' AS company
        FROM loc
        LEFT JOIN shadow_record tk ON tk.entity = 'Tickets' AND loc.ticket ~ '^\\d+$' AND tk.id = loc.ticket::bigint
        LEFT JOIN shadow_record co ON co.entity = 'Companies' AND tk.data->>'companyID' ~ '^\\d+$' AND co.id = (tk.data->>'companyID')::bigint
       ${where} ORDER BY loc.ts DESC LIMIT 50`),
  ]);
  const who = (id: string, via: string | null) => { const c = classify(Number(id)); const kind: ActorKind = via ? 'mcp' : c.kind; return { name: label(kind, c.name, id, via), kind }; };
  return {
    tz, days, hour: h, byKind, byDay,
    byWho: byWho.map((x) => ({ ...who(x.who, x.via), resourceId: Number(x.who), n: x.n })),
    latest: latest.map((x) => ({ at: x.at, type: x.kind, record: x.id, ...who(x.who, x.via), ticketId: x.ticket ? Number(x.ticket) : null, ticketNumber: x.ticketNumber, title: x.title, company: x.company })),
  };
}

/** Who is who, from the mirror's Resources and the console's Actors settings (no Autotask call). */
export async function mirrorClassifier(pool: Pool): Promise<Classify> {
  const rows = (await pool.query<{ id: string; data: Record<string, unknown> }>(`SELECT id::text, data FROM shadow_record WHERE entity = 'Resources' AND deleted_at IS NULL`).catch(() => ({ rows: [] as Array<{ id: string; data: Record<string, unknown> }> }))).rows;
  const ctx: ClassifyContext = {
    resources: new Map(rows.map((r) => [Number(r.id), { id: Number(r.id), ...(r.data as Omit<ActorRecord, 'id'>) }])),
    mcpApiUserId: null, apiLicenseValue: 7, // 7 = "API User" on standard tenants
    registry: parseRegistry(settingValue<string[]>('actors.registry') ?? []),
    reference: parseReference(settingValue<string[]>('actors.reference') ?? []),
  };
  return classifierFrom(ctx);
}

/** Actor classification → the chart's kinds. Automation-looking names ("… Z - API") count as integrations. */
export function classifierFrom(ctx: ClassifyContext): Classify {
  const memo = new Map<number, ReturnType<Classify>>();
  return (id) => {
    let v = memo.get(id);
    if (!v) {
      const a = classifyActor(id, ctx);
      const kind = a.actorType === 'human' ? 'person'
        : a.actorType === 'integration' || a.actorType === 'service_account' || a.actorType === 'system' || a.classificationSource === 'name-suggests-automation' ? 'integration'
        : 'unknown';
      v = { name: a.displayName, kind };
      memo.set(id, v);
    }
    return v;
  };
}
