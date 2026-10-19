// Bulk jobs, shared by the ChatGPT tool (autotask_bulk_inactivate) and the admin console's
// Bulk jobs page: create + prepare a placeholder cleanup in the background, and the job view
// (counts, pace now, ETA). Writing is always the background worker's job.

import type { AutotaskService } from '../services/autotask.service.js';
import { isPlaceholderCompany } from '../merge/model.js';
import { BulkStore, itemsHash, type BulkJob } from './store.js';
import { preparePlaceholderJob, type PlaceholderSelector } from './prepare.js';
import { DEFAULT_SCHEDULE, currentRate, weeklyCapacity, type BusinessSchedule } from './schedule.js';

export const MAX_RATE = 6000;

export interface PrepareRequest {
  companyName: string; createdByResourceId?: number | null; createdFrom?: string | null; createdTo?: string | null;
  includeContacts?: boolean; ratePerHour?: number; canary?: number;
  /** false = no business hours (one rate all day). */
  businessHours?: Partial<BusinessSchedule> | false;
  businessRate?: number;
}

export function scheduleOf(r: Pick<PrepareRequest, 'businessHours' | 'businessRate'>): BusinessSchedule | null {
  if (r.businessHours === false) return null;
  const b = (r.businessHours && typeof r.businessHours === 'object' ? r.businessHours : {}) as Partial<BusinessSchedule>;
  return { tz: b.tz ?? DEFAULT_SCHEDULE.tz, days: Array.isArray(b.days) ? b.days.map(Number) : DEFAULT_SCHEDULE.days, start: b.start != null ? Number(b.start) : DEFAULT_SCHEDULE.start, end: b.end != null ? Number(b.end) : DEFAULT_SCHEDULE.end, businessRate: Number(b.businessRate ?? r.businessRate ?? DEFAULT_SCHEDULE.businessRate) };
}

/** Create the job and prepare it in the background. Throws a user-facing error for a bad request. */
export async function startPrepare(s: AutotaskService, st: BulkStore, r: PrepareRequest, by: string | null): Promise<BulkJob> {
  const companyName = String(r.companyName ?? '').trim();
  if (!companyName) throw new Error('companyName: the placeholder name to clean up, e.g. "Gmail".');
  if (!isPlaceholderCompany({ companyName })) throw new Error(`"${companyName}" is not a placeholder name (webmail provider, Unknown…, greeting) — a bulk cleanup never targets real company names.`);
  const rate = Math.min(Math.max(Number(r.ratePerHour) || 3000, 60), MAX_RATE);
  const schedule = scheduleOf(r);
  if (schedule && (schedule.start < 0 || schedule.end > 24 || schedule.start >= schedule.end)) throw new Error('businessHours: start must be before end (hours 0–24).');
  const sel: PlaceholderSelector = { companyName, ...(r.createdByResourceId != null ? { createdByResourceId: Number(r.createdByResourceId) } : {}), ...(r.createdFrom ? { createdFrom: String(r.createdFrom) } : {}), ...(r.createdTo ? { createdTo: String(r.createdTo) } : {}) };
  const includeContacts = r.includeContacts !== false;
  const job = await st.create({ kind: 'inactivate_placeholders', title: `Inactivate "${companyName}" placeholder companies${includeContacts ? ' and their contacts' : ''}`, params: { selector: sel, includeContacts, schedule }, ratePerHour: rate, canarySize: Math.min(Math.max(Number(r.canary) || 50, 1), 1000), by });
  // Preparation reads tens of thousands of rows: in the background, paced like the job itself.
  void (async () => {
    try {
      const http = await s.httpClient();
      const p = await preparePlaceholderJob((e, f, o) => http.query(e, f as never, o), sel, { includeContacts, paceMs: Math.round(3_600_000 / rate), mirrored: (e) => e === 'Companies' || e === 'Contacts' });
      await st.fill(job.id, p.items, p.stats, itemsHash(job.kind, p.items));
    } catch (e) { await st.setStatus(job.id, 'failed', { lastError: (e instanceof Error ? e.message : String(e)).slice(0, 500), finished: true }).catch(() => undefined); }
  })();
  return job;
}

/** A job with its counts, pace right now, progress and ETA. */
export async function jobView(st: BulkStore, j: BulkJob, now = new Date()): Promise<Record<string, unknown>> {
  const counts = await st.counts(j.id);
  const sum = (k: string) => Object.values(counts).reduce((t, c) => t + (c[k] ?? 0), 0);
  const pending = sum('pending'), done = sum('done'), skipped = sum('skipped'), failed = sum('failed'), excluded = sum('excluded');
  const total = pending + done + skipped + failed;
  const schedule = (j.params as { schedule?: BusinessSchedule | null }).schedule ?? null;
  const pace = currentRate(now, j.ratePerHour, schedule);
  const perWeek = weeklyCapacity(j.ratePerHour, schedule);
  const lastHour = await st.doneSince(j.id, new Date(now.getTime() - 3_600_000).toISOString());
  return {
    id: j.id, title: j.title, kind: j.kind, status: j.status, hash: j.hash, pauseReason: j.pauseReason, lastError: j.lastError,
    rate: { offHours: j.ratePerHour, businessHours: schedule ? Math.min(schedule.businessRate, j.ratePerHour) : null, now: pace.rate, inBusinessHours: pace.business, doneLastHour: lastHour },
    schedule, canary: { size: j.canarySize, done: !!(j.stats as { canaryDone?: boolean }).canaryDone },
    counts, progress: { total, done, skipped, failed, pending, excluded, pct: total ? Math.round(((done + skipped) / total) * 1000) / 10 : 0 },
    pending, etaDays: pending ? Math.round((pending / perWeek) * 7 * 10) / 10 : 0,
    stats: j.stats, params: j.params, createdBy: j.createdBy, createdAt: j.createdAt, approvedBy: j.approvedBy, approvedAt: j.approvedAt, startedAt: j.startedAt, finishedAt: j.finishedAt,
  };
}

export type JobAction = 'approve' | 'start' | 'pause' | 'resume' | 'cancel' | 'retry_failed';
export const JOB_ACTIONS: JobAction[] = ['approve', 'start', 'pause', 'resume', 'cancel', 'retry_failed'];

/**
 * One state change, with the rules: approve only a ready job with its exact hash (re-checked
 * against the items); start an approved job; pause a running one; resume a paused one; cancel
 * anything not finished; failed items back to the queue. Returns ok + a message for a person.
 */
export async function jobAction(st: BulkStore, j: BulkJob, action: JobAction, o: { hash?: string | undefined; by: string | null }): Promise<{ ok: boolean; status: string; message: string }> {
  const by = o.by ?? 'a user';
  switch (action) {
    case 'approve': {
      if (j.status !== 'ready') return { ok: false, status: j.status, message: `Only a "ready" job can be approved (this one is ${j.status}).` };
      if (String(o.hash ?? '') !== j.hash) return { ok: false, status: 'hash_mismatch', message: 'The hash does not match the prepared job — review it again and approve with its hash.' };
      if (itemsHash(j.kind, await st.allItemKeys(j.id)) !== j.hash) return { ok: false, status: 'hash_mismatch', message: 'The job\u2019s items changed since it was prepared — prepare it again.' };
      await st.setStatus(j.id, 'approved', { approvedBy: by });
      return { ok: true, status: 'approved', message: `Approved by ${by}. Start it to run the canary (${j.canarySize}) first.` };
    }
    case 'start':
      if (j.status !== 'approved') return { ok: false, status: j.status, message: `Start needs an approved job (this one is ${j.status}).` };
      await st.setStatus(j.id, 'running', { started: true, pauseReason: null });
      return { ok: true, status: 'running', message: `Running — the canary (${j.canarySize}) first, then it pauses for a check.` };
    case 'pause':
      if (j.status !== 'running') return { ok: false, status: j.status, message: `Not running (${j.status}).` };
      await st.setStatus(j.id, 'paused', { pauseReason: `paused by ${by}` });
      return { ok: true, status: 'paused', message: 'Paused — nothing more is written until it is resumed.' };
    case 'resume':
      if (j.status !== 'paused') return { ok: false, status: j.status, message: `Resume needs a paused job (this one is ${j.status}).` };
      await st.setStatus(j.id, 'running', { pauseReason: null });
      return { ok: true, status: 'running', message: 'Resumed.' };
    case 'cancel':
      if (['done', 'cancelled', 'failed'].includes(j.status)) return { ok: false, status: j.status, message: `Already ${j.status}.` };
      await st.setStatus(j.id, 'cancelled', { finished: true, pauseReason: `cancelled by ${by}` });
      return { ok: true, status: 'cancelled', message: 'Cancelled. Records already written stay as they are; the rest are untouched.' };
    case 'retry_failed': {
      const n = await st.requeueFailed(j.id);
      return { ok: true, status: j.status, message: `${n} failed item(s) back in the queue${j.status === 'paused' ? ' — resume to run them' : ''}.` };
    }
  }
}
