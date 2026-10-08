// Shadow consistency check: does the Postgres mirror match Autotask?
//
// Every read now asks the shadow first, so a mirror bug would quietly feed
// wrong data into reports and billing reviews. Per entity this check:
//   1. samples random live mirrored rows and re-reads them from Autotask in ONE
//      query (`id in [...]`, noCache — never answered by the shadow itself),
//      comparing every field;
//   2. compares the mirror's row count with Autotask's for the same window
//      (`/query/count`, one call).
// A difference is classified, so expected lag is not reported as a fault:
//   changed  — Autotask's modified stamp is newer than the copy and recent:
//              the next incremental run picks it up (expected);
//   pending  — no modified stamp (window/full refresh) and the copy is younger
//              than the refresh interval: the next refresh picks it up (expected);
//   differs  — anything else: a real mismatch (missed update, field that
//              changes without the stamp moving, translation bug);
//   missing  — mirrored as live, but Autotask no longer returns it (deleted,
//              not swept yet — the nightly reconcile normally catches it).
// With repair (default), Autotask's version replaces the mirrored row and
// missing rows are marked deleted — Autotask is authoritative.
// Cost: about 2 Autotask calls per entity.

import type { ShadowEntity } from './shadow-entities.js';
import type { ShadowFilter } from './shadow-sql.js';

export type RowStatus = 'ok' | 'changed' | 'pending' | 'differs';

/** Values as JSON for comparison: null and undefined are the same; objects/arrays by content. */
function norm(v: unknown): string { return v === undefined || v === null ? 'null' : JSON.stringify(v); }

/** How long a modified-stamp change may wait for the next incremental run before it counts as missed. */
export const CHANGE_LAG_MS = 20 * 60_000;

/** Compare one mirrored row with Autotask's current version. */
export function compareRow(e: ShadowEntity, mirror: Record<string, unknown>, live: Record<string, unknown>, syncedAt: Date, now: Date): { status: RowStatus; fields: string[] } {
  const fields = [...new Set([...Object.keys(mirror), ...Object.keys(live)])].filter((k) => norm(mirror[k]) !== norm(live[k])).sort();
  if (!fields.length) return { status: 'ok', fields };
  if (e.watermarkField) {
    const lw = Date.parse(String(live[e.watermarkField] ?? '')), mw = Date.parse(String(mirror[e.watermarkField] ?? ''));
    if (Number.isFinite(lw) && (!Number.isFinite(mw) || lw > mw)) {
      return { status: now.getTime() - lw <= CHANGE_LAG_MS ? 'changed' : 'differs', fields };
    }
    return { status: 'differs', fields };
  }
  const intervalMin = e.refreshEveryMinutes ?? e.fullEveryMinutes ?? 60;
  return { status: now.getTime() - syncedAt.getTime() <= (intervalMin + 10) * 60_000 ? 'pending' : 'differs', fields };
}

export interface EntityVerify {
  entity: string;
  skipped?: string;
  sampled: number;
  ok: number;
  /** Expected lag: picked up by the next run. */
  changed: number;
  pending: number;
  /** Real mismatches. */
  differs: number;
  missing: number;
  repaired: number;
  mirrorCount: number | null;
  autotaskCount: number | null;
  countDelta: number | null;
  countOk: boolean | null;
  /** Up to 5 examples of real mismatches: id and the differing fields. */
  examples: Array<{ id: number; status: 'differs' | 'missing'; fields: string[] }>;
  calls: number;
  error?: string;
}

export interface VerifyReport { at: string; trigger: string; status: 'ok' | 'attention' | 'skipped'; calls: number; sample: number; entities: EntityVerify[]; skipped?: string }

/** Row counts may legitimately differ by rows created since the last sync / deleted before the sweep. */
export function countWithinTolerance(mirror: number, autotask: number): boolean {
  return Math.abs(mirror - autotask) <= Math.max(5, Math.ceil(Math.max(mirror, autotask) * 0.005));
}

export interface VerifyDeps {
  /** Autotask reads that bypass the shadow (noCache). */
  query(entity: string, filter: ShadowFilter[], opts: { maxRecords: number; noCache: true }): Promise<Array<Record<string, unknown>>>;
  count(entity: string, filter: ShadowFilter[]): Promise<number | null>;
  sample(entity: string, n: number): Promise<Array<{ data: Record<string, unknown>; syncedAt: Date }>>;
  countMatching(entity: string, filter: ShadowFilter[]): Promise<number>;
  upsert(e: ShadowEntity, rows: Array<Record<string, unknown>>): Promise<number>;
  markDeleted(entity: string, ids: number[]): Promise<number>;
  /** The entity as resolved for this tenant (watermark), or an error. */
  effective(e: ShadowEntity): Promise<ShadowEntity | { error: string }>;
  /** Sync state: backfilled? window start? */
  state(entity: string): Promise<{ backfill_done: boolean; window_from: Date | null } | null>;
}

export async function verifyEntity(e0: ShadowEntity, deps: VerifyDeps, opts: { sample: number; repair: boolean; now: Date }): Promise<EntityVerify> {
  const out: EntityVerify = { entity: e0.name, sampled: 0, ok: 0, changed: 0, pending: 0, differs: 0, missing: 0, repaired: 0, mirrorCount: null, autotaskCount: null, countDelta: null, countOk: null, examples: [], calls: 0 };
  const st = await deps.state(e0.name);
  if (!st?.backfill_done) { out.skipped = 'still backfilling'; return out; }
  const eff = await deps.effective(e0);
  if ('error' in eff) { out.skipped = eff.error; return out; }
  const e = eff;
  try {
    // 1. Sampled rows vs Autotask.
    const rows = await deps.sample(e.name, opts.sample);
    out.sampled = rows.length;
    if (rows.length) {
      out.calls++;
      const live = await deps.query(e.name, [{ op: 'in', field: 'id', value: rows.map((r) => Number(r.data.id)) }], { maxRecords: rows.length, noCache: true });
      const byId = new Map(live.map((r) => [Number(r.id), r]));
      const fix: Array<Record<string, unknown>> = [], gone: number[] = [];
      for (const r of rows) {
        const id = Number(r.data.id);
        const l = byId.get(id);
        if (!l) { out.missing++; gone.push(id); if (out.examples.length < 5) out.examples.push({ id, status: 'missing', fields: [] }); continue; }
        const c = compareRow(e, r.data, l, r.syncedAt, opts.now);
        out[c.status]++;
        if (c.status !== 'ok') fix.push(l);
        if (c.status === 'differs' && out.examples.length < 5) out.examples.push({ id, status: 'differs', fields: c.fields.slice(0, 12) });
      }
      if (opts.repair) {
        if (fix.length) out.repaired += await deps.upsert(e, fix);
        if (gone.length) out.repaired += await deps.markDeleted(e.name, gone);
      }
    }
    // 2. Row counts over the same window.
    const filter: ShadowFilter[] = e.window && st.window_from ? [e.window(new Date(st.window_from).toISOString().slice(0, 10))] : [{ op: 'gte', field: 'id', value: 0 }];
    out.calls++;
    const at = await deps.count(e.name, filter);
    if (at != null) {
      out.autotaskCount = at;
      out.mirrorCount = await deps.countMatching(e.name, filter);
      out.countDelta = out.mirrorCount - at;
      out.countOk = countWithinTolerance(out.mirrorCount, at);
    }
  } catch (err) {
    out.error = (err instanceof Error ? err.message : String(err)).slice(0, 300);
  }
  return out;
}

export function overallStatus(entities: EntityVerify[]): 'ok' | 'attention' {
  return entities.some((x) => x.differs > 0 || x.missing > 0 || x.countOk === false || x.error) ? 'attention' : 'ok';
}
