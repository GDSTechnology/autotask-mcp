// autotask_bulk_inactivate — clean up placeholder companies ("Gmail") and their contacts in
// bulk: prepared from the mirror, approved by hash, pushed by the background worker at a set
// pace (slower in business hours), canary first. ChatGPT starts / pauses / checks it; it never
// loops thousands of writes itself.

import type { Pool } from 'pg';
import type { AutotaskService } from '../services/autotask.service.js';
import type { CallerContext } from '../types/context.js';
import { hourlyActivity } from '../services/call-log.js';
import { isPlaceholderCompany } from '../merge/model.js';
import { BulkStore, itemsHash, type BulkJob } from './store.js';
import { preparePlaceholderJob } from './prepare.js';
import { DEFAULT_SCHEDULE, activityProfile, currentRate, weeklyCapacity, type BusinessSchedule } from './schedule.js';

type Result = { result: unknown; message: string };
type H = (a: Record<string, any>, ctx: CallerContext) => Promise<Result>;
const who = (ctx: CallerContext) => ctx.trustedActingUserEmail ?? ctx.requestingUserEmail ?? (ctx.source !== 'unknown' ? ctx.source : null);
const MAX_RATE = 6000;

function scheduleOf(a: Record<string, any>): BusinessSchedule | null {
  if (a.businessHours === false) return null;
  const b = (a.businessHours && typeof a.businessHours === 'object' ? a.businessHours : {}) as Partial<BusinessSchedule>;
  return { tz: b.tz ?? DEFAULT_SCHEDULE.tz, days: Array.isArray(b.days) ? b.days.map(Number) : DEFAULT_SCHEDULE.days, start: b.start ?? DEFAULT_SCHEDULE.start, end: b.end ?? DEFAULT_SCHEDULE.end, businessRate: Number(b.businessRate ?? a.businessRate ?? DEFAULT_SCHEDULE.businessRate) };
}

async function view(st: BulkStore, j: BulkJob): Promise<Record<string, unknown>> {
  const counts = await st.counts(j.id);
  const pending = Object.values(counts).reduce((t, c) => t + (c.pending ?? 0), 0);
  const schedule = (j.params as { schedule?: BusinessSchedule | null }).schedule ?? null;
  const now = currentRate(new Date(), j.ratePerHour, schedule);
  const perWeek = weeklyCapacity(j.ratePerHour, schedule);
  const lastHour = await st.doneSince(j.id, new Date(Date.now() - 3_600_000).toISOString());
  return {
    id: j.id, title: j.title, status: j.status, hash: j.hash, pauseReason: j.pauseReason, lastError: j.lastError,
    rate: { offHours: j.ratePerHour, businessHours: schedule ? Math.min(schedule.businessRate, j.ratePerHour) : null, now: now.rate, inBusinessHours: now.business, doneLastHour: lastHour },
    schedule, canary: { size: j.canarySize, done: !!(j.stats as { canaryDone?: boolean }).canaryDone },
    counts, pending, etaDays: pending ? Math.round((pending / perWeek) * 7 * 10) / 10 : 0, stats: j.stats, createdBy: j.createdBy, approvedBy: j.approvedBy, startedAt: j.startedAt, finishedAt: j.finishedAt,
  };
}

export function bulkToolHandlers(s: AutotaskService, getPool: () => Pool | null): Array<[string, H]> {
  return [
    ['autotask_bulk_inactivate', async (a, ctx) => {
      const action = String(a.action ?? 'status');
      if (action === 'activity') {
        const tz = String(a.tz ?? DEFAULT_SCHEDULE.tz);
        const p = activityProfile(hourlyActivity(), tz) as { suggested: unknown; hoursOfData: number };
        return { result: p, message: `Autotask traffic by local hour (${tz}) over ${p.hoursOfData} hour(s) of data; suggested business window: ${JSON.stringify(p.suggested)} — confirm it, then pass businessHours on prepare.` };
      }
      const pool = getPool(); if (!pool) return { result: { status: 'unavailable' }, message: 'Needs the Postgres store (migration 0015).' };
      const st = new BulkStore(pool);
      if (action === 'list') { const jobs = await st.list(20); return { result: { jobs: jobs.map((j) => ({ id: j.id, title: j.title, status: j.status, createdAt: j.createdAt })) }, message: `${jobs.length} bulk job(s).` }; }

      if (action === 'prepare') {
        const companyName = String(a.companyName ?? '').trim();
        if (!companyName) return { result: { status: 'invalid_value', field: 'companyName' }, message: 'companyName: the placeholder name to clean up, e.g. "Gmail".' };
        if (!isPlaceholderCompany({ companyName })) return { result: { status: 'refused' }, message: `"${companyName}" is not a placeholder name (webmail provider, Unknown…, greeting) — a bulk cleanup never targets real company names.` };
        const rate = Math.min(Math.max(Number(a.ratePerHour) || 3000, 60), MAX_RATE);
        const schedule = scheduleOf(a);
        const sel = { companyName, ...(a.createdByResourceId != null ? { createdByResourceId: Number(a.createdByResourceId) } : {}), ...(a.createdFrom ? { createdFrom: String(a.createdFrom) } : {}), ...(a.createdTo ? { createdTo: String(a.createdTo) } : {}) };
        const job = await st.create({ kind: 'inactivate_placeholders', title: `Inactivate "${companyName}" placeholder companies${a.includeContacts === false ? '' : ' and their contacts'}`, params: { selector: sel, includeContacts: a.includeContacts !== false, schedule }, ratePerHour: rate, canarySize: Math.min(Math.max(Number(a.canary) || 50, 1), 1000), by: who(ctx) });
        // Preparation reads tens of thousands of rows: run it in the background, paced like the job itself.
        void (async () => {
          try {
            const http = await s.httpClient();
            const r = await preparePlaceholderJob((e, f, o) => http.query(e, f as never, o), sel, { includeContacts: a.includeContacts !== false, paceMs: Math.round(3_600_000 / rate), mirrored: (e) => e === 'Companies' || e === 'Contacts' });
            await st.fill(job.id, r.items, r.stats, itemsHash(job.kind, r.items));
          } catch (e) { await st.setStatus(job.id, 'failed', { lastError: (e instanceof Error ? e.message : String(e)).slice(0, 500), finished: true }).catch(() => undefined); }
        })();
        return { result: { jobId: job.id, status: 'preparing' }, message: `Preparing job ${job.id} in the background (reads the mirror; history checks are paced at ${rate}/hour). Check it with action=status — when it is "ready", review the counts and exclusions, then approve with its hash.` };
      }

      const j = a.jobId ? await st.get(String(a.jobId)) : null;
      if (!j) return { result: { status: 'not_found' }, message: `No bulk job ${a.jobId ?? ''} (action=list shows them).` };

      if (action === 'status') { const v = await view(st, j); return { result: v, message: `Job ${j.id}: ${j.status}${j.pauseReason ? ` (${j.pauseReason})` : ''} — ${v.pending} write(s) pending, ${JSON.stringify(v.counts)}; now ${(v.rate as { now: number }).now}/hour${(v.rate as { inBusinessHours: boolean }).inBusinessHours ? ' (business hours)' : ''}, ~${v.etaDays} day(s) left.` }; }
      if (action === 'excluded') { const ex = await st.items(j.id, 'excluded', Math.min(Number(a.limit) || 200, 2000)); return { result: { excluded: ex.map((x) => ({ companyId: x.recordId, reason: x.reason, before: x.before })) }, message: `${ex.length} excluded compan(ies) shown — they have history; merge them into the right account in the UI (autotask_merge_build_plan).` }; }
      if (action === 'items') {
        // What the job did (or will do) — e.g. the canary's records to spot-check in Autotask.
        const status = ['done', 'pending', 'skipped', 'failed', 'excluded'].includes(String(a.status)) ? String(a.status) as 'done' : 'done';
        const list = await st.items(j.id, status, Math.min(Number(a.limit) || 50, 1000));
        return { result: { status, items: list.map((x) => ({ seq: x.seq, entity: x.entity, id: x.recordId, companyId: x.parentId, doneAt: x.doneAt, reason: x.reason, error: x.error, link: s.getRecordWebUrl(x.entity === 'Companies' ? 'company' : 'contact', x.recordId) })) }, message: `${list.length} ${status} item(s) of job ${j.id} (in order), with Autotask links — open a few to check them.` };
      }
      if (action === 'failed') { const f = await st.items(j.id, 'failed', Math.min(Number(a.limit) || 100, 1000)); return { result: { failed: f.map((x) => ({ seq: x.seq, entity: x.entity, id: x.recordId, error: x.error, attempts: x.attempts })) }, message: `${f.length} failed item(s) shown.` }; }

      if (action === 'approve') {
        if (j.status !== 'ready') return { result: { status: j.status }, message: `Only a "ready" job can be approved (this one is ${j.status}).` };
        if (String(a.hash ?? '') !== j.hash) return { result: { status: 'hash_mismatch', hash: j.hash }, message: 'hash does not match the prepared job — show the person the job (action=status) and approve with its hash.' };
        const recheck = itemsHash(j.kind, await st.allItemKeys(j.id));
        if (recheck !== j.hash) return { result: { status: 'hash_mismatch' }, message: 'The job’s items changed since it was prepared — prepare it again.' };
        await st.setStatus(j.id, 'approved', { approvedBy: who(ctx) ?? 'unknown' });
        return { result: { status: 'approved' }, message: `Job ${j.id} approved. Start it with action=start, confirm=true — it runs the canary (${j.canarySize}) first and pauses for a check.` };
      }
      if (action === 'start' || action === 'resume') {
        if (a.confirm !== true) return { result: { status: 'confirmation_required' }, message: `This writes to Autotask (inactivates records, paced). Repeat with confirm: true once the person has said to ${action}.` };
        if (!(action === 'start' ? ['approved'] : ['paused']).includes(j.status)) return { result: { status: j.status }, message: action === 'start' ? `Start needs an approved job (this one is ${j.status}).` : `Resume needs a paused job (this one is ${j.status}).` };
        await st.setStatus(j.id, 'running', { started: true, pauseReason: null });
        return { result: { status: 'running' }, message: `Job ${j.id} running — the server pushes the writes in the background. Check progress with action=status.` };
      }
      if (action === 'pause') { if (j.status !== 'running') return { result: { status: j.status }, message: `Not running (${j.status}).` }; await st.setStatus(j.id, 'paused', { pauseReason: `paused by ${who(ctx) ?? 'a user'}` }); return { result: { status: 'paused' }, message: `Job ${j.id} paused; nothing more is written until resume.` }; }
      if (action === 'cancel') { if (['done', 'cancelled'].includes(j.status)) return { result: { status: j.status }, message: `Already ${j.status}.` }; await st.setStatus(j.id, 'cancelled', { finished: true, pauseReason: `cancelled by ${who(ctx) ?? 'a user'}` }); return { result: { status: 'cancelled' }, message: `Job ${j.id} cancelled. Records already written stay as they are (inactive); the rest are untouched.` }; }
      if (action === 'retry_failed') { const n = await st.requeueFailed(j.id); return { result: { requeued: n }, message: `${n} failed item(s) back in the queue — resume the job to run them.` }; }
      return { result: { status: 'invalid_value', field: 'action' }, message: 'action: prepare | status | approve | start | pause | resume | cancel | items | excluded | failed | retry_failed | list | activity.' };
    }],
  ];
}
