/**
 * Autotask blocks deleting/editing a time entry for several reasons, ALL of
 * which (except billing-posted) are invisible to the REST API and only surface
 * as an error when the write/delete is attempted (confirmed by GDS live tests):
 *
 *  1. timesheet submitted            -> "…time entries that have been submitted"
 *  2. timesheet approved             -> approved lock
 *  3. billing-posted / contract auto-approve -> billingApprovalDateTime set
 *       (the ONLY one visible on the TimeEntry record, so the only one a
 *        dry-run can pre-detect)
 *  4. not the creator                -> "…time entries that you did not create"
 *       (Autotask allows delete only by the owner — impersonate the owner)
 *  5. owner lacks delete permission  -> "does not have adequate permissions to
 *        delete this entity timeEntryType" (the owner's security level must
 *        grant time-entry delete)
 *
 * IMPORTANT: there is NO timesheet entity in the REST API and no timesheet/lock
 * field on TimeEntry, so the timesheet-submitted/approved lock CANNOT be queried
 * ahead of time — `classifyLockError` on the actual failure is the authoritative
 * gate.
 */
export type TimeEntryLockState =
  | 'open'
  | 'timesheet_pending_approval' // timesheet submitted, waiting for approval
  | 'timesheet_approved' // timesheet approved
  | 'billing_posted' // billingApprovalDateTime set (incl. contract auto-approve)
  | 'not_owner' // API user is not the creator; must impersonate the owner
  | 'no_delete_permission' // the (impersonated) owner's level can't delete time
  | 'unknown';

export function isLocked(state: TimeEntryLockState): boolean {
  return (
    state === 'timesheet_pending_approval' ||
    state === 'timesheet_approved' ||
    state === 'billing_posted' ||
    state === 'not_owner' ||
    state === 'no_delete_permission'
  );
}

/** Classify a timesheet status LABEL (only if a source ever exposes one). */
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
 * Map an Autotask error from a failed time-entry write/delete to a lock/permission
 * state, or null when it isn't one. Authoritative gate — order matters
 * (specific ownership/permission phrasing before generic "permission").
 */
export function classifyLockError(
  message: string | undefined | null
): TimeEntryLockState | null {
  const m = (message ?? '').toLowerCase();
  if (!m) return null;
  if (/did not create|you did not create|not the creator/.test(m)) return 'not_owner';
  if (/have been submitted|been submitted|timesheet.*submit|submit.*timesheet/.test(m)) return 'timesheet_pending_approval';
  if (/time ?sheet/.test(m)) return /approved/.test(m) ? 'timesheet_approved' : 'timesheet_pending_approval';
  if (/posted/.test(m)) return 'billing_posted';
  if (/adequate permission|do not have permission to delete|not have.*permission.*delete|timeentrytype/.test(m)) return 'no_delete_permission';
  if (/approved/.test(m)) return 'timesheet_approved';
  return null;
}

/** Human explanation for a lock/permission state, including how to clear it. */
export function lockReason(state: TimeEntryLockState): string {
  switch (state) {
    case 'timesheet_pending_approval':
      return 'The timesheet for this resource/week is submitted (waiting for approval). Autotask blocks adding, editing, or deleting time in that week until the timesheet is rejected/re-opened.';
    case 'timesheet_approved':
      return 'The timesheet for this resource/week is approved. Autotask blocks changes in that week until the timesheet is re-opened.';
    case 'billing_posted':
      return 'This entry is posted / billing-approved (billingApprovalDateTime is set — also happens when the contract auto-approves time). Autotask locks posted time; it must be un-posted first.';
    case 'not_owner':
      return 'Autotask allows a time entry to be deleted only by the resource who created it — an admin/API user cannot delete another user\'s time. Delete as the owner (impersonation).';
    case 'no_delete_permission':
      return 'The owner\'s Autotask security level does not grant permission to delete time entries. Grant time-entry delete on that security level, or delete it in the UI.';
    default:
      return 'The time is locked in Autotask; re-open the timesheet, un-post the entry, or delete it in the UI.';
  }
}
