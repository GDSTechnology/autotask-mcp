// The opinionated end-of-day labor reconciliation view of one resource's
// events (report_resource_daily_audit). Pure: takes the normalized events the
// collector produced and arranges them into the sections the EOD auditor
// reads. Timestamps are EVIDENCE of activity, not proof of continuous work —
// nothing here decides how long anyone worked.

import { AuditEvent, isAfterHours, localClock } from './audit-events';
import { dayIn } from './staff-tools';

export interface DailyAuditOptions { date: string; timeZone: string; businessHoursStart: string; businessHoursEnd: string }

interface WorkItem { key: string; type: 'ticket' | 'task'; id: number; reference: string | null; companyName: string | null; first: string; last: string; actions: string[]; eventCount: number }

/** The ticket / task an event is about (notes, charges and time attach to their parent). */
export function workItemOf(e: AuditEvent): { type: 'ticket' | 'task'; id: number; reference: string | null } | null {
  if (e.entityType === 'ticket') return { type: 'ticket', id: e.entityId, reference: e.entityReference ?? null };
  if (e.entityType === 'task') return { type: 'task', id: e.entityId, reference: e.entityReference ?? null };
  if ((e.parentEntityType === 'ticket' || e.parentEntityType === 'task') && e.parentEntityId != null) {
    return { type: e.parentEntityType, id: e.parentEntityId, reference: e.parentReference ?? null };
  }
  return null;
}

const label = (e: AuditEvent): string =>
  e.action === 'note' ? `${(e.details?.publish as string) ?? ''} note`.trim()
    : e.field ? `${e.field}: ${e.oldValue ?? '∅'} → ${e.newValue ?? '∅'}` : `${e.action} ${e.entityType}`;

export function buildDailyAudit(resource: { id: number; name: string | null }, events: AuditEvent[], tickets: Map<number, { status: number | null; ticketNumber: string | null }>, o: DailyAuditOptions) {
  const mine = events.filter((e) => e.resourceId === resource.id);
  const local = (ts: string) => `${localClock(ts, o.timeZone).hm}`;
  const onDay = (ts: string) => dayIn(new Date(ts), o.timeZone) === o.date;

  // TIME ENTERED — entries for the day (by date worked).
  const time = mine.filter((e) => e.entityType === 'timeEntry' && e.details?.dateWorked === o.date);
  const timeKeys = new Set(time.map((e) => (e.parentEntityType && e.parentEntityId != null ? `${e.parentEntityType}:${e.parentEntityId}` : '')));
  const hours = Math.round(time.reduce((s, e) => s + (Number(e.details?.hoursWorked) || 0), 0) * 100) / 100;

  // Activity (everything that isn't a time entry), on the day. Weakly-attributed
  // events (e.g. a To-Do completed while assigned — Autotask doesn't record the
  // completer, and automations complete them) are shown but never counted as work.
  const onDayAll = mine.filter((e) => e.entityType !== 'timeEntry' && onDay(e.timestamp));
  const activity = onDayAll.filter((e) => !e.details?.weakAttribution);
  const items = new Map<string, WorkItem>();
  for (const e of activity) {
    const w = workItemOf(e);
    if (!w) continue;
    const key = `${w.type}:${w.id}`;
    const it = items.get(key) ?? { key, ...w, companyName: e.companyName ?? null, first: e.timestamp, last: e.timestamp, actions: [], eventCount: 0 };
    it.reference = it.reference ?? w.reference; it.companyName = it.companyName ?? e.companyName ?? null;
    if (e.timestamp < it.first) it.first = e.timestamp;
    if (e.timestamp > it.last) it.last = e.timestamp;
    it.eventCount++;
    it.actions.push(`${local(e.timestamp)} ${label(e)}`);
    items.set(key, it);
  }
  const view = (it: WorkItem) => ({ [it.type === 'ticket' ? 'ticketNumber' : 'task']: it.reference, id: it.id, company: it.companyName, firstActivity: local(it.first), lastActivity: local(it.last), activityCount: it.eventCount, hasTimeEntry: timeKeys.has(it.key), actions: it.actions });
  const all = [...items.values()].sort((a, b) => a.first.localeCompare(b.first));
  const tickets_ = all.filter((i) => i.type === 'ticket');
  const tasks_ = all.filter((i) => i.type === 'task');
  const missing = all.filter((i) => !timeKeys.has(i.key));

  const closedMissing = missing.filter((i) => i.type === 'ticket' && tickets.get(i.id)?.status === 5).map((i) => ({
    ticketNumber: i.reference, id: i.id, status: 'Complete', activityWithoutTime: true, requiresReopenForBackfill: true,
    lastActivity: local(i.last),
  }));

  const afterHours = activity.filter((e) => isAfterHours(e.timestamp, o.timeZone, o.businessHoursStart, o.businessHoursEnd)).map((e) => {
    const w = workItemOf(e);
    return { time: local(e.timestamp), reference: w?.reference ?? e.entityReference ?? null, entityType: e.entityType, action: label(e), afterHoursTimeEntry: w ? time.some((t) => `${t.parentEntityType}:${t.parentEntityId}` === `${w.type}:${w.id}` && !!t.details?.startDateTime && isAfterHours(String(t.details.startDateTime), o.timeZone, o.businessHoursStart, o.businessHoursEnd)) : false };
  });

  const late = time.filter((e) => e.details?.enteredLate).map((e) => ({ timeEntryId: e.entityId, reference: e.parentReference ?? null, dateWorked: e.details?.dateWorked, enteredAt: e.details?.enteredAt, hours: e.details?.hoursWorked, ...(e.details?.enteredByResourceID ? { enteredByResourceID: e.details.enteredByResourceID } : {}) }));
  const otherEntered = time.filter((e) => e.details?.enteredByResourceID || e.details?.lastModifiedByResourceID).map((e) => ({ timeEntryId: e.entityId, reference: e.parentReference ?? null, enteredByResourceID: e.details?.enteredByResourceID ?? null, lastModifiedByResourceID: e.details?.lastModifiedByResourceID ?? null }));
  const timeWithoutEvidence = time.filter((e) => e.parentEntityType && e.parentEntityId != null && !items.has(`${e.parentEntityType}:${e.parentEntityId}`))
    .map((e) => ({ timeEntryId: e.entityId, reference: e.parentReference ?? null, hours: e.details?.hoursWorked, note: 'time logged, but no other activity by this resource on it that day' }));

  const scheduling = activity.filter((e) => e.entityType === 'serviceCall' || e.entityType === 'appointment').map((e) => ({ time: local(e.timestamp), entityType: e.entityType, id: e.entityId, action: label(e), company: e.companyName ?? null }));
  const crmAdmin = onDayAll.filter((e) => e.entityType === 'todo' || e.entityType === 'company' || e.entityType === 'contact').map((e) => ({ time: local(e.timestamp), entityType: e.entityType, id: e.entityId, action: label(e), company: e.companyName ?? null, ...(e.details?.weakAttribution ? { attribution: 'assigned to this resource — completer unknown; not counted as work' } : {}) }));
  const configuration = activity.filter((e) => e.entityType === 'configurationItem').map((e) => ({ time: local(e.timestamp), id: e.entityId, action: label(e), company: e.companyName ?? null }));
  const deletes = activity.filter((e) => e.action === 'delete').map((e) => ({ time: local(e.timestamp), entityType: e.entityType, id: e.entityId, parent: e.parentReference ?? e.parentEntityId ?? null }));

  return {
    resource: { id: resource.id, name: resource.name },
    date: o.date,
    timeZone: o.timeZone,
    businessHours: `${o.businessHoursStart}–${o.businessHoursEnd}`,
    summary: {
      hoursEntered: hours, timeEntries: time.length,
      ticketsTouched: tickets_.length, tasksTouched: tasks_.length,
      schedulingChanges: scheduling.length, crmAdminActions: crmAdmin.length, configurationChanges: configuration.length,
      afterHoursEvents: afterHours.length, itemsWithoutTime: missing.length, closedItemsMissingLabor: closedMissing.length,
      lateEntries: late.length, deletes: deletes.length,
      reviewItems: missing.length + late.length + timeWithoutEvidence.length,
    },
    timeEntered: time.map((e) => ({ timeEntryId: e.entityId, reference: e.parentReference ?? null, company: e.companyName ?? null, hours: e.details?.hoursWorked, start: e.details?.startDateTime ? local(String(e.details.startDateTime)) : null, end: e.details?.endDateTime ? local(String(e.details.endDateTime)) : null, nonBillable: e.details?.nonBillable, approved: e.details?.approved, enteredAt: e.details?.enteredAt, summary: e.details?.summary })),
    ticketsTouched: tickets_.map(view),
    projectsTasksTouched: tasks_.map(view),
    schedulingActivity: scheduling,
    crmAdminActivity: crmAdmin,
    configurationActivity: configuration,
    afterHoursActivity: afterHours,
    activityWithNoCorrespondingTime: missing.map(view),
    potentialTimeEntryMismatches: [...timeWithoutEvidence, ...otherEntered.map((x) => ({ ...x, note: 'entered or last changed by someone other than the resource' }))],
    lateOrBackfilledTime: late,
    closedItemsWithPossibleMissingLabor: closedMissing,
    deletes,
    timesheet: { status: 'unknown', note: 'Autotask does not expose timesheet status through the API — a locked timesheet only shows up as the error when time is added.' },
  };
}
