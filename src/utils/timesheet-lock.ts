/**
 * Autotask locks time so it can't be added, edited, or deleted for a
 * resource/week from three sources (all surfaced by GDS live testing):
 *  1. the timesheet was submitted   -> "Locked waiting for approval"
 *  2. the timesheet was approved     -> "Locked has been approved"
 *  3. the entry is posted/billing-approved (billingApprovalDateTime set) —
 *     including when a CONTRACT is set to auto-approve time, which posts the
 *     entry immediately even while the timesheet is still open.
 *
 * These helpers classify the state (for a dry-run pre-check) and map Autotask's
 * own write/delete error (the authoritative gate) to the same states, so a
 * caller always gets a clear reason instead of a raw 500.
 */
export type TimeEntryLockState =
  | 'open'
  | 'timesheet_pending_approval' // timesheet submitted, waiting for approval
  | 'timesheet_approved' // timesheet approved
  | 'billing_posted' // billingApprovalDateTime set (incl. contract auto-approve)
  | 'unknown';

export function isLocked(state: TimeEntryLockState): boolean {
  return state === 'timesheet_pending_approval' || state === 'timesheet_approved' || state === 'billing_posted';
}

/** Classify a TimeSheets.status picklist LABEL into a lock state (tenant-agnostic). */
export function classifyTimesheetStatusLabel(
  label: string | undefined | null
): 'open' | 'timesheet_pending_approval' | 'timesheet_approved' | 'unknown' {
  const l = (label ?? '').trim().toLowerCase();
  if (!l) return 'unknown';
  const looksLocked = /lock|submit|approv|pending|waiting/.test(l);
  if (!looksLocked) return 'open';
  if (/approved|has been approved/.test(l)) return 'timesheet_approved';
  return 'timesheet_pending_approval';
}

/**
 * Map an Autotask error message from a failed write/delete to a lock state, or
 * null when it is not a lock error. This is the authoritative gate — it catches
 * every lock source even when the dry-run pre-check couldn't see it.
 */
export function classifyLockError(
  message: string | undefined | null
): TimeEntryLockState | null {
  const m = (message ?? '').toLowerCase();
  if (!m) return null;
  const isLockError = /time ?sheet|\block(ed)?\b|posted|approv/.test(m);
  if (!isLockError) return null;
  if (/time ?sheet/.test(m)) {
    return /approved/.test(m) ? 'timesheet_approved' : 'timesheet_pending_approval';
  }
  if (/post/.test(m) || /approved/.test(m)) return 'billing_posted';
  return 'timesheet_pending_approval';
}

/** Human explanation for a lock state, including how to clear it. */
export function lockReason(state: TimeEntryLockState): string {
  switch (state) {
    case 'timesheet_pending_approval':
      return 'The timesheet for this resource/week is locked (submitted, waiting for approval). Autotask blocks adding, editing, or deleting time in that week until the timesheet is rejected/re-opened.';
    case 'timesheet_approved':
      return 'The timesheet for this resource/week is locked (approved). Autotask blocks adding, editing, or deleting time in that week until the timesheet is re-opened.';
    case 'billing_posted':
      return 'This entry is posted / billing-approved (billingApprovalDateTime is set — this also happens when the contract auto-approves time). Autotask locks posted time; it must be un-posted before it can be changed or deleted.';
    default:
      return 'The time for this resource/week is locked in Autotask; re-open the timesheet or un-post the entry to modify it.';
  }
}
