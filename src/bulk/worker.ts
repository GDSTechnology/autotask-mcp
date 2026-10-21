// Bulk job worker: pushes a running job's items to Autotask, ONE write at a time, at the
// job's rate (writes/hour). Backpressure "slow" halves the pace, "stop" waits; a 401 pauses
// the job (auth), repeated failures pause it, and after the canary batch it pauses for a
// person to check. Every item records its result; a restart resumes from the next pending item.

import type { Pool } from 'pg';
import type { AutotaskService } from '../services/autotask.service.js';
import { backpressure, DEFAULT_THRESHOLDS } from '../services/backpressure.js';
import { notify } from '../services/notifier.js';
import type { Logger } from '../utils/logger.js';
import { BulkStore, type BulkItem, type BulkJob } from './store.js';
import { currentRate, type BusinessSchedule } from './schedule.js';
import { settingValue } from '../admin/settings.js';

export const MAX_ATTEMPTS = 3;
/** Bulk jobs yield early: half pace from 40% tenant usage, stop at 65% (Autotask adds +1 s per call from 75%, and 10,000/h is the hard limit). */
export const BULK_THRESHOLDS = { ...DEFAULT_THRESHOLDS, slowPct: 40, stopPct: 65 };
export const PAUSE_AFTER_FAILURES = 20;
/** After a throttled write, at least this long before the next one (on top of the cooldown). */
export const WAIT_AFTER_THROTTLE_MS = 60_000;
const intEnv = (v: string | undefined, d: number): number => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) && n > 0 ? n : d; };

export interface ApplyFns {
  inactivateContact: (id: number, companyId: number) => Promise<void>;
  inactivateCompany: (id: number) => Promise<void>;
}

/** 'wait': Autotask is throttling the tenant (429 / cooldown) — the record is fine; try it again later, no attempt used. */
export type ItemOutcome = { status: 'done' | 'skipped' | 'failed' | 'retry' | 'wait' | 'pause'; error?: string; reason?: string };

const statusOf = (e: unknown): number | null => { const s = (e as { status?: number })?.status; if (typeof s === 'number') return s; const m = /HTTP (\d{3})/.exec(String((e as Error)?.message ?? '')); return m ? Number(m[1]) : null; };

/** One item → one write, classified. */
export async function applyItem(item: BulkItem, fns: ApplyFns): Promise<ItemOutcome> {
  try {
    if (item.entity === 'Contacts') {
      if (item.parentId == null) return { status: 'failed', error: 'no company id for the contact (the child route needs it)' };
      await fns.inactivateContact(item.recordId, item.parentId);
    } else await fns.inactivateCompany(item.recordId);
    return { status: 'done' };
  } catch (e) {
    const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
    const st = statusOf(e);
    if (st === 401 || /auth.*(paused|held)|login/i.test(msg)) return { status: 'pause', error: msg, reason: 'Autotask login problem — check Settings → Autotask login, then resume' };
    if (st === 404) return { status: 'skipped', reason: 'not found in Autotask (deleted or merged already)' };
    if (/protected|refusing/i.test(msg)) return { status: 'failed', error: msg };
    // Throttling says nothing about the record: wait, never a failure (it used to burn attempts and trip the
    // 20-in-a-row pause during a 429 storm).
    if (st === 429 || /\b429\b|cooldown|threshold exceeded/i.test(msg)) return { status: 'wait', error: msg };
    if ((st != null && st >= 500) || st === 0 || /timeout|ECONN|fetch failed/i.test(msg)) return item.attempts + 1 >= MAX_ATTEMPTS ? { status: 'failed', error: msg } : { status: 'retry', error: msg };
    return item.attempts + 1 >= MAX_ATTEMPTS ? { status: 'failed', error: msg } : { status: 'retry', error: msg };
  }
}

/** Minimum gap between writes for a job, given backpressure. null = wait (stop). */
export function writeGapMs(ratePerHour: number, level: 'ok' | 'slow' | 'stop'): number | null {
  if (level === 'stop') return null;
  const gap = 3_600_000 / Math.max(1, ratePerHour);
  return level === 'slow' ? gap * 2 : gap;
}

export interface WorkerDeps { store: BulkStore; fns: ApplyFns; level: () => 'ok' | 'slow' | 'stop'; now: () => number; notify: (e: Parameters<typeof notify>[0]) => void; logger?: Logger }

/** The worker's state between ticks (per process). */
export class BulkWorker {
  private lastWrite = new Map<string, number>();
  private failStreak = new Map<string, number>();
  private busy = false;
  constructor(private readonly d: WorkerDeps) {}

  /** One step: at most one write. Returns what happened (for tests / logs). */
  async tick(): Promise<string> {
    if (this.busy) return 'busy';
    this.busy = true;
    try {
      const job = (await this.d.store.running())[0];
      if (!job) return 'idle';
      // Business hours: a slower rate while people are working (job.params.schedule), the job rate outside.
      const { rate } = currentRate(new Date(this.d.now()), job.ratePerHour, (job.params as { schedule?: BusinessSchedule | null }).schedule ?? null);
      const gap = writeGapMs(rate, this.d.level());
      if (gap == null) return 'backpressure-stop';
      if (this.d.now() - (this.lastWrite.get(job.id) ?? 0) < gap) return 'pacing';
      const stats = job.stats as { canaryDone?: boolean; processed?: number };
      if (!stats.canaryDone && (stats.processed ?? 0) >= job.canarySize) {
        await this.d.store.setStatus(job.id, 'paused', { pauseReason: `canary: the first ${job.canarySize} item(s) are done — check them in Autotask, then resume`, stats: { canaryDone: true } });
        this.d.notify({ type: 'bulk.paused', severity: 'info', title: `Bulk job paused after its canary (${job.canarySize})`, detail: `${job.title}: check the first ${job.canarySize} records in Autotask, then resume (autotask_bulk_inactivate action=resume).`, fields: { job: job.id }, dedupeKey: `bulk.canary:${job.id}` });
        return 'canary-pause';
      }
      const [item] = await this.d.store.next(job.id, 1);
      if (!item) {
        await this.d.store.setStatus(job.id, 'done', { finished: true, pauseReason: null });
        this.d.notify({ type: 'bulk.done', severity: 'info', title: `Bulk job done: ${job.title}`, detail: JSON.stringify(await this.d.store.counts(job.id)), fields: { job: job.id }, dedupeKey: `bulk.done:${job.id}` });
        return 'done';
      }
      this.lastWrite.set(job.id, this.d.now());
      const out = await applyItem(item, this.d.fns);
      return await this.record(job, item, out);
    } catch (e) {
      this.d.logger?.warn?.('Bulk worker tick failed', e);
      return 'error';
    } finally { this.busy = false; }
  }

  private async record(job: BulkJob, item: BulkItem, out: ItemOutcome): Promise<string> {
    const s = this.d.store;
    if (out.status === 'pause') {
      await s.retryLater(job.id, item.seq, out.error ?? '');
      await s.setStatus(job.id, 'paused', { pauseReason: out.reason ?? 'paused', lastError: out.error ?? null });
      this.d.notify({ type: 'bulk.paused', severity: 'warning', title: `Bulk job paused: ${out.reason}`, detail: `${job.title} — item ${item.seq} (${item.entity} ${item.recordId}): ${out.error}`, fields: { job: job.id }, dedupeKey: `bulk.paused:${job.id}:${item.seq}` });
      return 'paused';
    }
    if (out.status === 'wait') {
      // The item stays pending untouched; the 429 armed the cooldown, so backpressure holds the next write.
      this.lastWrite.set(job.id, this.d.now() + WAIT_AFTER_THROTTLE_MS);
      await s.setStatus(job.id, 'running', { lastError: out.error ?? null });
      return 'wait';
    }
    if (out.status === 'retry') { await s.retryLater(job.id, item.seq, out.error ?? ''); }
    else await s.markItem(job.id, item.seq, out.status, { error: out.error ?? null, reason: out.reason ?? null });
    const streak = out.status === 'done' || out.status === 'skipped' ? 0 : (this.failStreak.get(job.id) ?? 0) + 1;
    this.failStreak.set(job.id, streak);
    const processed = ((job.stats as { processed?: number }).processed ?? 0) + (out.status === 'retry' ? 0 : 1);
    await s.setStatus(job.id, 'running', { stats: { processed }, ...(out.error ? { lastError: out.error } : {}) });
    if (streak >= PAUSE_AFTER_FAILURES) {
      await s.setStatus(job.id, 'paused', { pauseReason: `${streak} failures in a row — look at the errors (action=status), then resume or retry_failed` });
      this.d.notify({ type: 'bulk.paused', severity: 'warning', title: `Bulk job paused: ${streak} failures in a row`, detail: `${job.title}: ${out.error}`, fields: { job: job.id }, dedupeKey: `bulk.failstreak:${job.id}:${processed}` });
      this.failStreak.set(job.id, 0);
      return 'paused';
    }
    return out.status;
  }
}

/** Run the worker in the server: a tick every 250 ms while any job is running. Returns a stop function. */
export function startBulkWorker(s: AutotaskService, getPool: () => Pool | null, logger: Logger, tenant: string): () => void {
  const pool = getPool(); if (!pool) return () => undefined;
  const w = new BulkWorker({
    store: new BulkStore(pool),
    fns: {
      inactivateContact: (id, companyId) => s.updateContact(id, { companyID: companyId, isActive: 0 } as never),
      inactivateCompany: (id) => s.updateCompany(id, { isActive: false } as never),
    },
    // The console's read-only switch stops the worker too (it writes in the background, not through a tool call).
    level: () => (settingValue<boolean>('tools.writesEnabled') === false ? 'stop' : backpressure(tenant, { ...BULK_THRESHOLDS, slowPct: intEnv(process.env.MCP_BULK_SLOW_AT_PCT, BULK_THRESHOLDS.slowPct), stopPct: intEnv(process.env.MCP_BULK_STOP_AT_PCT, BULK_THRESHOLDS.stopPct) }).level),
    now: () => Date.now(), notify, logger,
  });
  // A preparation interrupted by a restart can't finish: say so (running jobs simply continue).
  void pool.query(`UPDATE bulk_job SET status = 'failed', last_error = 'interrupted by a server restart — prepare it again', finished_at = now(), updated_at = now() WHERE status = 'preparing'`).catch(() => undefined);
  let stopped = false;
  const loop = async () => { while (!stopped) { const r = await w.tick(); await new Promise((res) => setTimeout(res, r === 'idle' ? 15_000 : r === 'backpressure-stop' ? 30_000 : 250)); } };
  void loop();
  logger.info('Bulk job worker started');
  return () => { stopped = true; };
}
