// autotask_bulk_inactivate — clean up placeholder companies ("Gmail") and their contacts in
// bulk: prepared from the mirror, approved by hash, pushed by the background worker at a set
// pace (slower in business hours), canary first. ChatGPT starts / pauses / checks it; it never
// loops thousands of writes itself.

import type { Pool } from 'pg';
import type { AutotaskService } from '../services/autotask.service.js';
import type { CallerContext } from '../types/context.js';
import { hourlyActivity } from '../services/call-log.js';
import { BulkStore } from './store.js';
import { DEFAULT_SCHEDULE, activityProfile } from './schedule.js';
import { JOB_ACTIONS, jobAction, jobView, startPrepare, type JobAction } from './service.js';

type Result = { result: unknown; message: string };
type H = (a: Record<string, any>, ctx: CallerContext) => Promise<Result>;
// Who asked: the user, else the declared client, else how it connected (ChatGPT's tunnel says Go-http-client).
const who = (ctx: CallerContext) => ctx.trustedActingUserEmail ?? ctx.requestingUserEmail ?? (ctx.source !== 'unknown' ? ctx.source : ctx.origin?.userAgent ? `client ${ctx.origin.userAgent.slice(0, 60)}` : null);

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
        let job;
        try {
          job = await startPrepare(s, st, { companyName: String(a.companyName ?? ''), createdByResourceId: a.createdByResourceId ?? null, createdFrom: a.createdFrom ?? null, createdTo: a.createdTo ?? null, includeContacts: a.includeContacts !== false, ratePerHour: Number(a.ratePerHour) || 3000, canary: Number(a.canary) || 50, ...(a.businessHours === false ? { businessHours: false as const } : a.businessHours && typeof a.businessHours === 'object' ? { businessHours: a.businessHours } : {}), ...(a.businessRate != null ? { businessRate: Number(a.businessRate) } : {}) }, who(ctx));
        } catch (e) { return { result: { status: 'refused' }, message: e instanceof Error ? e.message : String(e) }; }
        return { result: { jobId: job.id, status: 'preparing' }, message: `Preparing job ${job.id} in the background (reads the mirror; history checks are paced). Check it with action=status — when it is "ready", a person reviews and approves it (console → Bulk jobs, or approve with its hash).` };
      }

      const j = a.jobId ? await st.get(String(a.jobId)) : null;
      if (!j) return { result: { status: 'not_found' }, message: `No bulk job ${a.jobId ?? ''} (action=list shows them).` };

      if (action === 'status') { const v = await jobView(st, j); return { result: v, message: `Job ${j.id}: ${j.status}${j.pauseReason ? ` (${j.pauseReason})` : ''} — ${v.pending} write(s) pending, ${JSON.stringify(v.counts)}; now ${(v.rate as { now: number }).now}/hour${(v.rate as { inBusinessHours: boolean }).inBusinessHours ? ' (business hours)' : ''}, ~${v.etaDays} day(s) left.` }; }
      if (action === 'excluded') { const ex = await st.items(j.id, 'excluded', Math.min(Number(a.limit) || 200, 2000)); return { result: { excluded: ex.map((x) => ({ companyId: x.recordId, reason: x.reason, before: x.before })) }, message: `${ex.length} excluded compan(ies) shown — they have history; merge them into the right account in the UI (autotask_merge_build_plan).` }; }
      if (action === 'items') {
        // What the job did (or will do) — e.g. the canary's records to spot-check in Autotask.
        const status = ['done', 'pending', 'skipped', 'failed', 'excluded'].includes(String(a.status)) ? String(a.status) as 'done' : 'done';
        const list = await st.items(j.id, status, Math.min(Number(a.limit) || 50, 1000));
        return { result: { status, items: list.map((x) => ({ seq: x.seq, entity: x.entity, id: x.recordId, companyId: x.parentId, doneAt: x.doneAt, reason: x.reason, error: x.error, link: s.getRecordWebUrl(x.entity === 'Companies' ? 'company' : 'contact', x.recordId) })) }, message: `${list.length} ${status} item(s) of job ${j.id} (in order), with Autotask links — open a few to check them.` };
      }
      if (action === 'failed') { const f = await st.items(j.id, 'failed', Math.min(Number(a.limit) || 100, 1000)); return { result: { failed: f.map((x) => ({ seq: x.seq, entity: x.entity, id: x.recordId, error: x.error, attempts: x.attempts })) }, message: `${f.length} failed item(s) shown.` }; }

      if ((JOB_ACTIONS as string[]).includes(action)) {
        if ((action === 'start' || action === 'resume') && a.confirm !== true) return { result: { status: 'confirmation_required' }, message: `This writes to Autotask (inactivates records, paced). Repeat with confirm: true once the person has said to ${action} — or they can do it on the console's Bulk jobs page.` };
        const r = await jobAction(st, j, action as JobAction, { hash: a.hash != null ? String(a.hash) : undefined, by: who(ctx) });
        return { result: { status: r.status, ok: r.ok }, message: `Job ${j.id}: ${r.message}` };
      }
      return { result: { status: 'invalid_value', field: 'action' }, message: 'action: prepare | status | approve | start | pause | resume | cancel | items | excluded | failed | retry_failed | list | activity.' };
    }],
  ];
}
