// Keeps the Postgres shadow in step with Autotask, within an API budget.
//
//   backfill     first load: walk `id > cursor` in 500-row pages (ids come back
//                ascending — verified live), resumable across runs. The
//                watermark is stamped BEFORE the backfill starts, so changes
//                made while it runs are picked up by the first incremental.
//   incremental  rows whose modified (or created) stamp is ≥ watermark − 2 min,
//                paged by id; the watermark advances to the newest stamp seen
//                (Autotask's clock, not ours).
//   full         small tables without a modified stamp (contract services /
//                blocks, resources): re-read whole on an interval; rows that
//                vanished are marked deleted.
//   reconcile    id-only walk of the big tables to catch DELETIONS (Autotask has
//                no delete feed); run rarely (default nightly).
//   refreshIds   rows the MCP just wrote — re-read right away so the mirror
//                never lags its own writes.
//
// Every Autotask call is counted against the run's budget; a run is skipped
// entirely when the tenant's hourly API usage is already high.

import { Logger } from '../utils/logger.js';
import { SHADOW_ENTITIES, ShadowEntity, WATERMARK_OVERLAP_MS, modifiedAt, shadowEntity } from './shadow-entities.js';
import { ShadowStore } from './shadow-store.js';
import type { ShadowFilter } from './shadow-sql.js';

export interface SyncHttp {
  query<T>(entity: string, filter: ShadowFilter[], opts?: { maxRecords?: number; includeFields?: string[]; noCache?: boolean }): Promise<T[]>;
}

export interface SyncOptions {
  maxCallsPerRun: number;
  /** Skip the run when the tenant's hourly usage is at/above this %. */
  pauseAtPct: number;
  /** Current hourly usage %, or null if unknown (then the run proceeds). */
  usagePct?: () => Promise<number | null>;
  /** Backfill only this many months of history for windowed entities (0/absent = everything). */
  historyMonths?: number;
}

export interface EntityReport { entity: string; mode: 'backfill' | 'incremental' | 'full' | 'skip'; calls: number; rows: number; done?: boolean; deleted?: number; error?: string }
export interface RunReport { skipped?: string; calls: number; entities: EntityReport[] }

const PAGE = 500;
type Row = Record<string, unknown> & { id: number };

export class ShadowSync {
  private calls = 0;
  private readonly dirty = new Map<string, Set<number>>();

  constructor(private readonly http: () => Promise<SyncHttp>, private readonly store: ShadowStore, private readonly logger: Logger, private readonly opts: SyncOptions) {}

  /** Queue a row the MCP just wrote; the next run re-reads it first. */
  markDirty(entity: string, id: number): void {
    const e = shadowEntity(entity);
    if (!e || !Number.isFinite(id)) return;
    (this.dirty.get(e.name) ?? this.dirty.set(e.name, new Set()).get(e.name)!).add(id);
  }
  /** Change the usage threshold at runtime (admin console). */
  setPauseAtPct(pct: number): void { this.opts.pauseAtPct = pct; }
  get pauseAtPct(): number { return this.opts.pauseAtPct; }
  dirtyCount(): number { let n = 0; for (const s of this.dirty.values()) n += s.size; return n; }

  private budgetLeft(): number { return this.opts.maxCallsPerRun - this.calls; }

  private async page(e: ShadowEntity, filter: ShadowFilter[], includeFields?: string[]): Promise<Row[]> {
    this.calls++;
    const h = await this.http();
    return h.query<Row>(e.name, filter, { maxRecords: PAGE, noCache: true, ...(includeFields ? { includeFields } : {}) });
  }

  /** One scheduled run: dirty rows, then each entity in turn, until the budget is spent. */
  async runOnce(now: Date = new Date()): Promise<RunReport> {
    this.calls = 0;
    if (this.opts.usagePct) {
      const pct = await this.opts.usagePct().catch(() => null);
      if (pct != null && pct >= this.opts.pauseAtPct) return { skipped: `Autotask API usage ${pct}% ≥ ${this.opts.pauseAtPct}% — sync paused this run`, calls: 0, entities: [] };
    }
    const entities: EntityReport[] = [];
    for (const [name, ids] of [...this.dirty.entries()]) {
      this.dirty.delete(name);
      try { await this.refreshIds(name, [...ids]); } catch (err) { this.logger.warn(`shadow: refreshing ${ids.size} written ${name} row(s) failed`, err); }
    }
    for (const e of SHADOW_ENTITIES) {
      if (this.budgetLeft() <= 0) { entities.push({ entity: e.name, mode: 'skip', calls: 0, rows: 0, error: 'run budget spent' }); continue; }
      const before = this.calls;
      try {
        entities.push(await this.syncEntity(e, now));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.store.saveState(e.name, { last_error: msg.slice(0, 500), last_error_at: now, apiCalls: this.calls - before });
        entities.push({ entity: e.name, mode: 'skip', calls: this.calls - before, rows: 0, error: msg });
      }
    }
    return { calls: this.calls, entities };
  }

  private async syncEntity(e: ShadowEntity, now: Date): Promise<EntityReport> {
    const st = await this.store.getState(e.name);
    if (!e.watermarkField) return this.fullRefresh(e, st?.last_full_at ?? null, now);
    if (!st?.backfill_done) return this.backfill(e, st?.backfill_cursor ?? 0, st?.watermark ?? null, st?.window_from ?? null, now);
    return this.incremental(e, st.watermark, now);
  }

  private async backfill(e: ShadowEntity, cursor: number, watermark: Date | null, windowFrom: Date | null, now: Date): Promise<EntityReport> {
    const before = this.calls;
    // Stamp the watermark (and fix the history window) when the backfill STARTS,
    // so edits made during it are caught later and the window doesn't drift.
    if (cursor === 0 && !watermark) {
      const months = this.opts.historyMonths ?? 0;
      if (e.window && months > 0) { windowFrom = new Date(now); windowFrom.setUTCMonth(windowFrom.getUTCMonth() - months); windowFrom.setUTCHours(0, 0, 0, 0); }
      await this.store.saveState(e.name, { watermark: now, window_from: windowFrom });
    }
    const windowFilter = e.window && windowFrom ? [e.window(new Date(windowFrom).toISOString().slice(0, 10))] : [];
    let rows = 0, done = false;
    while (this.budgetLeft() > 0) {
      const page = await this.page(e, [...windowFilter, { op: 'gt', field: 'id', value: cursor }]);
      rows += await this.store.upsert(e, page);
      if (page.length) cursor = Math.max(...page.map((r) => Number(r.id)));
      if (page.length < PAGE) { done = true; break; }
      await this.store.saveState(e.name, { backfill_cursor: cursor, apiCalls: 0 });
    }
    await this.store.saveState(e.name, { backfill_cursor: cursor, ...(done ? { backfill_done: true, last_backfill_at: now, last_error: null } : {}), apiCalls: this.calls - before });
    return { entity: e.name, mode: 'backfill', calls: this.calls - before, rows, done };
  }

  private async incremental(e: ShadowEntity, watermark: Date | null, now: Date): Promise<EntityReport> {
    const before = this.calls;
    const since = new Date((watermark ?? now).getTime() - WATERMARK_OVERLAP_MS).toISOString();
    const changed: ShadowFilter = e.createField
      ? { op: 'or', items: [{ op: 'gte', field: e.watermarkField!, value: since }, { op: 'gte', field: e.createField, value: since }] }
      : { op: 'gte', field: e.watermarkField!, value: since };
    let cursor = 0, rows = 0, newest = watermark?.getTime() ?? 0, complete = false;
    while (this.budgetLeft() > 0) {
      const page = await this.page(e, [changed, { op: 'gt', field: 'id', value: cursor }]);
      rows += await this.store.upsert(e, page);
      for (const r of page) { const m = modifiedAt(e, r)?.getTime(); if (m && m > newest) newest = m; }
      if (page.length) cursor = Math.max(...page.map((r) => Number(r.id)));
      if (page.length < PAGE) { complete = true; break; }
    }
    // Only move the watermark when every changed row was read; otherwise the next run resumes from the same point.
    await this.store.saveState(e.name, { ...(complete ? { watermark: new Date(newest || now.getTime()), last_incremental_at: now, last_error: null } : {}), apiCalls: this.calls - before });
    return { entity: e.name, mode: 'incremental', calls: this.calls - before, rows, done: complete };
  }

  private async fullRefresh(e: ShadowEntity, lastFull: Date | null, now: Date): Promise<EntityReport> {
    const due = !lastFull || now.getTime() - new Date(lastFull).getTime() >= (e.fullEveryMinutes ?? 60) * 60_000;
    if (!due) return { entity: e.name, mode: 'skip', calls: 0, rows: 0 };
    const before = this.calls;
    const seen = new Set<number>();
    let cursor = 0, rows = 0, complete = false;
    while (this.budgetLeft() > 0) {
      const page = await this.page(e, [{ op: 'gt', field: 'id', value: cursor }]);
      rows += await this.store.upsert(e, page);
      for (const r of page) seen.add(Number(r.id));
      if (page.length) cursor = Math.max(...page.map((r) => Number(r.id)));
      if (page.length < PAGE) { complete = true; break; }
    }
    let deleted = 0;
    if (complete) deleted = await this.store.markDeleted(e.name, (await this.store.liveIds(e.name)).filter((id) => !seen.has(id)));
    await this.store.saveState(e.name, { ...(complete ? { last_full_at: now, backfill_done: true, last_backfill_at: now, last_error: null } : {}), apiCalls: this.calls - before });
    return { entity: e.name, mode: 'full', calls: this.calls - before, rows, done: complete, deleted };
  }

  /** Catch deletions in a big table: id-only walk, rows Autotask no longer returns are marked deleted. */
  async reconcile(entityName: string, maxCalls: number, now: Date = new Date()): Promise<EntityReport> {
    const e = shadowEntity(entityName);
    if (!e) throw new Error(`Not a shadow entity: ${entityName}`);
    const saved = this.opts.maxCallsPerRun;
    (this.opts as { maxCallsPerRun: number }).maxCallsPerRun = maxCalls;
    this.calls = 0;
    try {
      const seen = new Set<number>();
      let cursor = 0, complete = false;
      while (this.budgetLeft() > 0) {
        const page = await this.page(e, [{ op: 'gt', field: 'id', value: cursor }], ['id']);
        for (const r of page) seen.add(Number(r.id));
        if (page.length) cursor = Math.max(...page.map((r) => Number(r.id)));
        if (page.length < PAGE) { complete = true; break; }
      }
      let deleted = 0;
      if (complete) deleted = await this.store.markDeleted(e.name, (await this.store.liveIds(e.name)).filter((id) => !seen.has(id)));
      await this.store.saveState(e.name, { ...(complete ? { last_reconcile_at: now } : {}), apiCalls: this.calls });
      return { entity: e.name, mode: 'full', calls: this.calls, rows: seen.size, done: complete, deleted };
    } finally {
      (this.opts as { maxCallsPerRun: number }).maxCallsPerRun = saved;
    }
  }

  /** Re-read specific rows (e.g. just written by the MCP); ids Autotask no longer has are marked deleted. */
  async refreshIds(entityName: string, ids: number[]): Promise<number> {
    const e = shadowEntity(entityName);
    if (!e || !ids.length) return 0;
    let n = 0;
    for (let i = 0; i < ids.length; i += PAGE) {
      const chunk = ids.slice(i, i + PAGE);
      const rows = await this.page(e, [{ op: 'in', field: 'id', value: chunk }]);
      n += await this.store.upsert(e, rows);
      const found = new Set(rows.map((r) => Number(r.id)));
      await this.store.markDeleted(e.name, chunk.filter((id) => !found.has(id)));
    }
    return n;
  }
}
