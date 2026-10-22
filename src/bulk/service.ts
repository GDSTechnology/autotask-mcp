// Bulk jobs, shared by the ChatGPT tool (autotask_bulk_inactivate) and the admin console's
// Bulk jobs page: create + prepare a placeholder cleanup in the background, and the job view
// (counts, pace now, ETA). Writing is always the background worker's job.

import type { AutotaskService } from '../services/autotask.service.js';
import { isPlaceholderCompany } from '../merge/model.js';
import { BulkStore, itemsHash, type BulkJob } from './store.js';
import { preparePlaceholderJob, type PlaceholderSelector } from './prepare.js';
import { prepareCompanyContactsJob, type CompanyContactsSelector } from './prepare-contacts.js';
import { patientQuery } from './patient.js';

/** The preparation's reads, waiting out Autotask throttling (the job shows "waiting" meanwhile). */
function preparationQuery(http: Awaited<ReturnType<AutotaskService['httpClient']>>, st: BulkStore, jobId: string) {
  return patientQuery((e, f, o) => http.query(e, f as never, o), {
    onWait: ({ untilIso, waitedMs }) => st.setStatus(jobId, 'preparing', { lastError: `[${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC] waiting out Autotask throttling (HTTP 429) — the preparation continues by itself after ${untilIso.slice(11, 16)} UTC${waitedMs ? ` (waited ${Math.round(waitedMs / 60_000)} min so far)` : ''}` }).catch(() => undefined),
  });
}
import { DEFAULT_SCHEDULE, currentRate, parseQuietHours, quietOf, quietWindowAt, weeklyCapacity, type BusinessSchedule, type QuietWindow } from './schedule.js';

export const MAX_RATE = 6000;

export interface PrepareRequest {
  companyName: string; createdByResourceId?: number | null; createdFrom?: string | null; createdTo?: string | null;
  includeContacts?: boolean; ratePerHour?: number; canary?: number;
  /** false = no business hours (one rate all day). */
  businessHours?: Partial<BusinessSchedule> | false;
  businessRate?: number;
  /** Local hours with no writes: "0-4, 21-22" (default), windows, or "none". */
  quietHours?: string | QuietWindow[] | false | null;
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
  const quietHours = parseQuietHours(r.quietHours);
  const job = await st.create({ kind: 'inactivate_placeholders', title: `Inactivate "${companyName}" placeholder companies${includeContacts ? ' and their contacts' : ''}`, params: { selector: sel, includeContacts, schedule, quietHours }, ratePerHour: rate, canarySize: Math.min(Math.max(Number(r.canary) || 50, 1), 1000), by });
  // Preparation reads tens of thousands of rows: in the background, paced like the job itself.
  void (async () => {
    try {
      const http = await s.httpClient();
      const p = await preparePlaceholderJob(preparationQuery(http, st, job.id), sel, { includeContacts, paceMs: Math.round(3_600_000 / rate), mirrored: (e) => e === 'Companies' || e === 'Contacts' });
      await st.fill(job.id, p.items, p.stats, itemsHash(job.kind, p.items));
    } catch (e) { await st.setStatus(job.id, 'failed', { lastError: (e instanceof Error ? e.message : String(e)).slice(0, 500), finished: true }).catch(() => undefined); }
  })();
  return job;
}

export interface CompanyContactsRequest extends Omit<PrepareRequest, 'companyName' | 'createdByResourceId' | 'includeContacts'> {
  companyId: number; contactIds?: number[] | null; keepDomains?: string[] | null; onlyDomains?: string[] | null; includeNoEmail?: boolean; ticketsOk?: boolean;
}

const list = <T>(v: unknown, f: (x: unknown) => T): T[] | undefined => (Array.isArray(v) ? v.map(f) : typeof v === 'string' && v.trim() ? v.split(/[\s,;]+/).filter(Boolean).map(f) : undefined);

/** Junk contacts on ONE real company: create the job and prepare it in the background. */
export async function startPrepareCompanyContacts(s: AutotaskService, st: BulkStore, r: CompanyContactsRequest, by: string | null): Promise<BulkJob> {
  const companyId = Number(r.companyId);
  if (!Number.isInteger(companyId) || companyId <= 0) throw new Error('companyId: the customer company whose junk contacts to inactivate (company 0, your own, is never cleaned in bulk).');
  const contactIds = list(r.contactIds, Number);
  if (contactIds?.some((n) => !Number.isInteger(n) || n <= 0)) throw new Error('contactIds: contact ID numbers only.');
  const rate = Math.min(Math.max(Number(r.ratePerHour) || 3000, 60), MAX_RATE);
  const schedule = scheduleOf(r);
  if (schedule && (schedule.start < 0 || schedule.end > 24 || schedule.start >= schedule.end)) throw new Error('businessHours: start must be before end (hours 0–24).');
  const keepDomains = list(r.keepDomains, String), onlyDomains = list(r.onlyDomains, String);
  const sel: CompanyContactsSelector = { companyId, ...(contactIds?.length ? { contactIds } : {}), ...(keepDomains?.length ? { keepDomains } : {}), ...(onlyDomains?.length ? { onlyDomains } : {}),
    ...(r.createdFrom ? { createdFrom: String(r.createdFrom) } : {}), ...(r.createdTo ? { createdTo: String(r.createdTo) } : {}), ...(r.includeNoEmail ? { includeNoEmail: true } : {}), ...(r.ticketsOk ? { ticketsOk: true } : {}) };
  const quietHours = parseQuietHours(r.quietHours);
  const job = await st.create({ kind: 'inactivate_company_contacts', title: `Inactivate junk contacts on company #${companyId}${contactIds?.length ? ` (${contactIds.length} listed)` : ''}`, params: { selector: sel, schedule, quietHours }, ratePerHour: rate, canarySize: Math.min(Math.max(Number(r.canary) || 25, 1), 1000), by });
  void (async () => {
    try {
      const http = await s.httpClient();
      const p = await prepareCompanyContactsJob(preparationQuery(http, st, job.id), sel, { fieldNames: async (e) => { const f = await s.getFieldInfo(e).catch(() => null); return f && f.length ? new Set(f.map((x) => x.name)) : null; }, paceMs: Math.round(3_600_000 / rate), mirrored: (e) => e === 'Companies' || e === 'Contacts' || e === 'Tickets' || e === 'Contracts' });
      const name = (p.stats.company as { name?: string } | undefined)?.name;
      if (name) await st.setTitle(job.id, `Inactivate junk contacts on ${name} (#${companyId})${contactIds?.length ? ` — ${contactIds.length} listed` : ''}`);
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
  const quietHours = quietOf(j.params);
  const quiet = quietWindowAt(now, quietHours, (schedule ?? DEFAULT_SCHEDULE).tz);
  const pace = quiet ? { rate: 0, business: false } : currentRate(now, j.ratePerHour, schedule);
  const perWeek = weeklyCapacity(j.ratePerHour, schedule, quietHours);
  const lastHour = await st.doneSince(j.id, new Date(now.getTime() - 3_600_000).toISOString());
  return {
    id: j.id, title: j.title, kind: j.kind, status: j.status, hash: j.hash, pauseReason: j.pauseReason, lastError: j.lastError,
    rate: { offHours: j.ratePerHour, businessHours: schedule ? Math.min(schedule.businessRate, j.ratePerHour) : null, now: pace.rate, inBusinessHours: pace.business, quietUntil: quiet ? quiet.end : null, doneLastHour: lastHour },
    schedule, quietHours, canary: { size: j.canarySize, done: !!(j.stats as { canaryDone?: boolean }).canaryDone },
    counts, progress: { total, done, skipped, failed, pending, excluded, pct: total ? Math.round(((done + skipped) / total) * 1000) / 10 : 0 },
    pending, etaDays: pending ? Math.round((pending / perWeek) * 7 * 10) / 10 : 0,
    archived: !!(j.stats as { archivedAt?: string }).archivedAt, archivedAt: (j.stats as { archivedAt?: string }).archivedAt ?? null, archivedBy: (j.stats as { archivedBy?: string }).archivedBy ?? null,
    stats: j.stats, params: j.params, createdBy: j.createdBy, createdAt: j.createdAt, approvedBy: j.approvedBy, approvedAt: j.approvedAt, startedAt: j.startedAt, finishedAt: j.finishedAt,
  };
}

export type JobAction = 'approve' | 'start' | 'pause' | 'resume' | 'cancel' | 'retry_failed' | 'archive' | 'unarchive';
export const JOB_ACTIONS: JobAction[] = ['approve', 'start', 'pause', 'resume', 'cancel', 'retry_failed', 'archive', 'unarchive'];
/** Only a finished job can be archived (hidden from the list; kept in full). */
export const ARCHIVABLE = ['done', 'cancelled', 'failed'];

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
    case 'archive':
      if (!ARCHIVABLE.includes(j.status)) return { ok: false, status: j.status, message: `Only a finished job (done, cancelled or failed) can be archived — this one is ${j.status}.` };
      await st.setArchived(j.id, true, by);
      return { ok: true, status: j.status, message: 'Archived — hidden from the list ("Show archived" brings it back). Nothing in Autotask changes.' };
    case 'unarchive':
      await st.setArchived(j.id, false, by);
      return { ok: true, status: j.status, message: 'Restored to the list.' };
  }
}
