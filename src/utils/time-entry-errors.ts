/**
 * Turn an Autotask rejection of a time-entry CREATE / UPDATE into an
 * actionable status, instead of passing the raw API error through.
 *
 * GDS backfill audit (2026-09): creating historical time for a resource whose
 * timesheet was already submitted failed with Autotask's generic error, and the
 * caller couldn't tell it was a timesheet lock. There is no timesheet entity in
 * the REST API (see timesheet-lock.ts), so the lock is only knowable from the
 * error — and reopening a timesheet is a UI-only action, so the fix to hand
 * back is "reopen it in Autotask, then re-run".
 *
 * Only write-relevant states are mapped; the delete-only states from
 * classifyLockError (not_owner / no_delete_permission) never apply here.
 */
import { classifyLockError } from './timesheet-lock.js';

export type TimeEntryWriteErrorStatus =
  | 'timesheet_locked'
  | 'billing_posted'
  | 'invalid_work_type'
  | 'task_completed'
  | 'role_required';

export interface ClassifiedTimeEntryError {
  status: TimeEntryWriteErrorStatus;
  reason: string;
  /** Autotask's own wording, kept for the audit trail. */
  autotaskError: string;
}

export function classifyTimeEntryWriteError(error: unknown): ClassifiedTimeEntryError | null {
  const autotaskError = error instanceof Error ? error.message : String(error ?? '');
  const m = autotaskError.toLowerCase();
  if (!m) return null;

  if (/allocation code/.test(m)) {
    return { status: 'invalid_work_type', autotaskError,
      reason: 'Autotask rejected the work type (billingCodeID): it is inactive, missing, or not a ticket/task work type (a Regular Time category cannot be used here). Re-run with an active ticket/task work type, or omit billingCodeID to use the default. Nothing was written.' };
  }
  if (/\btask\b.*\b(complete|completed)\b|\b(complete|completed)\b.*\btask\b/.test(m)) {
    return { status: 'task_completed', autotaskError,
      reason: 'The project task is complete — Autotask does not accept time on a completed task. Log it against an open task, or reopen the task first.' };
  }
  if (/\brole\b/.test(m)) {
    return { status: 'role_required', autotaskError,
      reason: 'Autotask rejected the role for this entry. Re-run with roleID set to one of the resource\'s roles (autotask_get_resource_roles).' };
  }
  const lock = classifyLockError(autotaskError);
  if (lock === 'timesheet_pending_approval' || lock === 'timesheet_approved') {
    const state = lock === 'timesheet_approved' ? 'approved' : 'submitted (waiting for approval)';
    return { status: 'timesheet_locked', autotaskError,
      reason: `The resource's timesheet for that week is ${state}, so Autotask blocks adding or changing time in it. Reopen (reject/unsubmit) the timesheet in the Autotask UI — the REST API has no timesheet endpoint — then re-run, and resubmit it afterwards. Nothing was written.` };
  }
  if (lock === 'billing_posted') {
    return { status: 'billing_posted', autotaskError,
      reason: 'The time entry is already approved/posted for billing, so Autotask blocks changing it. Un-post it in the Autotask UI first. Nothing was written.' };
  }
  return null;
}
