// Translate Autotask-style query filters into parameterised SQL over the
// shadow table (data jsonb). Same filter shape callers already use against the
// Autotask API: { op, field, value } leaves and { op: 'and'|'or', items } groups.
// Pure (no database) — unit-tested directly. Field names are validated, every
// value is a bind parameter; nothing user-supplied is spliced into SQL.

export interface ShadowFilter { op: string; field?: string; value?: unknown; items?: ShadowFilter[] }

const FIELD = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
export function assertField(f: unknown): string {
  if (typeof f !== 'string' || !FIELD.test(f)) throw new Error(`Invalid field name: ${JSON.stringify(f)}`);
  return f;
}

/** Escape LIKE wildcards so a "contains 50%" filter means a literal %. */
const likeEscape = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class SqlBuilder {
  params: unknown[] = [];
  bind(v: unknown): string { this.params.push(v); return `$${this.params.length}`; }
}

const text = (f: string) => `(data->>'${f}')`;

/**
 * One filter → a SQL boolean expression. Strings compare case-insensitively
 * (as Autotask does); numbers numerically; ISO dates compare as text, which
 * orders correctly for Autotask's "YYYY-MM-DDTHH:MM:SS" values.
 */
export function filterToSql(f: ShadowFilter, b: SqlBuilder): string {
  const op = String(f.op ?? '').toLowerCase();
  if (op === 'and' || op === 'or') {
    const parts = (f.items ?? []).map((i) => filterToSql(i, b));
    if (!parts.length) return op === 'and' ? 'TRUE' : 'FALSE';
    return `(${parts.join(op === 'and' ? ' AND ' : ' OR ')})`;
  }
  const field = assertField(f.field);
  const v = f.value;
  const t = text(field);
  switch (op) {
    case 'eq':
      if (v === null) return `${t} IS NULL`;
      if (typeof v === 'string') return `lower(${t}) = lower(${b.bind(v)})`;
      return `data @> ${b.bind(JSON.stringify({ [field]: v }))}::jsonb`;
    case 'noteq':
      if (v === null) return `${t} IS NOT NULL`;
      if (typeof v === 'string') return `(${t} IS NULL OR lower(${t}) <> lower(${b.bind(v)}))`;
      return `NOT (data @> ${b.bind(JSON.stringify({ [field]: v }))}::jsonb)`;
    case 'gt': case 'gte': case 'lt': case 'lte': {
      const sym = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[op];
      if (typeof v === 'number') return `(${t})::numeric ${sym} ${b.bind(v)}`;
      return `${t} ${sym} ${b.bind(String(v))}`;
    }
    case 'beginswith': return `${t} ILIKE ${b.bind(likeEscape(String(v)) + '%')}`;
    case 'endswith': return `${t} ILIKE ${b.bind('%' + likeEscape(String(v)))}`;
    case 'contains': return `${t} ILIKE ${b.bind('%' + likeEscape(String(v)) + '%')}`;
    case 'exist': case 'isnotnull': return `${t} IS NOT NULL`;
    case 'notexist': case 'isnull': return `${t} IS NULL`;
    case 'in': case 'notin': {
      const list = Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : [];
      const expr = `lower(${t}) = ANY(${b.bind(list)}::text[])`;
      return op === 'in' ? expr : `(${t} IS NULL OR NOT ${expr})`;
    }
    default: throw new Error(`Unsupported filter op "${f.op}"`);
  }
}

/** A list of top-level filters is AND-ed, like the Autotask API. */
export function whereClause(filters: ShadowFilter[], b: SqlBuilder): string {
  return filters.length ? filters.map((f) => filterToSql(f, b)).join(' AND ') : 'TRUE';
}

/** Group key: a field, or "month:field" / "day:field" / "year:field" on a date field. */
export function groupExpr(spec: string): { sql: string; alias: string } {
  const m = spec.match(/^(month|day|year):(.+)$/);
  if (m) {
    const f = assertField(m[2]);
    const len = { year: 4, month: 7, day: 10 }[m[1] as 'year' | 'month' | 'day'];
    return { sql: `substr(${text(f)}, 1, ${len})`, alias: `${m[1]}_${f}` };
  }
  const f = assertField(spec);
  return { sql: text(f), alias: f };
}
