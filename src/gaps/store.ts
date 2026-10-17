// Capability gaps (migration 0014 capability_gap): what the MCP couldn't do, so
// it can be built. Three ways in:
//   agent    an AI client called autotask_report_gap ("no tool does X")
//   console  a person added it on the console's Requests page
//   auto     captured by the server (an unknown tool was called)
// The same gap reported again (same dedupe key) counts an occurrence and
// refreshes last_seen instead of adding a row. A gap marked built / declined
// that is reported again reopens (it wasn't solved for the caller).

import type { Pool } from 'pg';
import { createHash } from 'node:crypto';

export const GAP_STATUSES = ['open', 'planned', 'built', 'declined', 'duplicate'] as const;
export const GAP_PRIORITIES = ['low', 'normal', 'high'] as const;
export type GapStatus = typeof GAP_STATUSES[number];
export type GapPriority = typeof GAP_PRIORITIES[number];

export interface Gap {
  id: number; dedupeKey: string; title: string; detail: string | null; source: string; reporter: string | null; toolTried: string | null; example: unknown;
  status: GapStatus; priority: GapPriority; resolution: string | null; occurrences: number; firstSeen: string; lastSeen: string; updatedAt: string; updatedBy: string | null;
}

export interface GapInput { title: string; detail?: string | null; source: 'agent' | 'console' | 'auto'; reporter?: string | null; toolTried?: string | null; example?: unknown; priority?: GapPriority; dedupeKey?: string }

/** Same title (case, spacing and punctuation ignored) → the same gap. */
export function gapKey(title: string): string {
  const norm = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `t:${createHash('sha256').update(norm).digest('hex').slice(0, 24)}`;
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const row = (x: Record<string, any>): Gap => ({
  id: Number(x.id), dedupeKey: x.dedupe_key, title: x.title, detail: x.detail ?? null, source: x.source, reporter: x.reporter ?? null, toolTried: x.tool_tried ?? null, example: x.example ?? null,
  status: x.status, priority: x.priority, resolution: x.resolution ?? null, occurrences: Number(x.occurrences), firstSeen: iso(x.first_seen)!, lastSeen: iso(x.last_seen)!, updatedAt: iso(x.updated_at)!, updatedBy: x.updated_by ?? null,
});

export class GapStore {
  constructor(private readonly pool: Pool) {}

  /** Add a gap, or count another occurrence of the same one. Returns it and whether it was new. */
  async report(g: GapInput): Promise<{ gap: Gap; created: boolean }> {
    const key = g.dedupeKey ?? gapKey(g.title);
    const r = await this.pool.query(`INSERT INTO capability_gap (dedupe_key, title, detail, source, reporter, tool_tried, example, priority)
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
      ON CONFLICT (dedupe_key) DO UPDATE SET occurrences = capability_gap.occurrences + 1, last_seen = now(),
        detail = COALESCE(capability_gap.detail, EXCLUDED.detail), example = COALESCE(EXCLUDED.example, capability_gap.example),
        tool_tried = COALESCE(EXCLUDED.tool_tried, capability_gap.tool_tried),
        status = CASE WHEN capability_gap.status IN ('built', 'declined') THEN 'open' ELSE capability_gap.status END
      RETURNING *, (xmax = 0) AS created`,
      [key, g.title.slice(0, 300), g.detail?.slice(0, 4000) ?? null, g.source, g.reporter ?? null, g.toolTried?.slice(0, 200) ?? null, g.example == null ? null : JSON.stringify(g.example).slice(0, 8000), g.priority ?? 'normal']);
    return { gap: row(r.rows[0]), created: r.rows[0].created === true };
  }

  async list(q: { status?: string[]; limit?: number; search?: string } = {}): Promise<Gap[]> {
    const where: string[] = []; const args: unknown[] = [];
    if (q.status?.length) { args.push(q.status); where.push(`status = ANY($${args.length}::text[])`); }
    if (q.search) { args.push(`%${q.search}%`); where.push(`(title ILIKE $${args.length} OR detail ILIKE $${args.length} OR tool_tried ILIKE $${args.length})`); }
    args.push(Math.min(Math.max(q.limit ?? 200, 1), 1000));
    const r = await this.pool.query(`SELECT * FROM capability_gap ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, last_seen DESC LIMIT $${args.length}`, args);
    return r.rows.map(row);
  }

  async update(id: number, u: { status?: GapStatus; priority?: GapPriority; resolution?: string | null; title?: string; detail?: string | null; by: string | null }): Promise<Gap | null> {
    const r = await this.pool.query(`UPDATE capability_gap SET status = COALESCE($2, status), priority = COALESCE($3, priority),
        resolution = CASE WHEN $4 THEN $5 ELSE resolution END, title = COALESCE($6, title), detail = CASE WHEN $7 THEN $8 ELSE detail END, updated_at = now(), updated_by = $9
      WHERE id = $1 RETURNING *`,
      [id, u.status ?? null, u.priority ?? null, u.resolution !== undefined, u.resolution ?? null, u.title ?? null, u.detail !== undefined, u.detail ?? null, u.by]);
    return r.rows[0] ? row(r.rows[0]) : null;
  }

  async counts(): Promise<Record<string, number>> {
    const r = await this.pool.query('SELECT status, count(*)::int n FROM capability_gap GROUP BY status');
    return Object.fromEntries(r.rows.map((x) => [x.status, x.n]));
  }
}
