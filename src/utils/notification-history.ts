// Notification history — what e-mails Autotask sent, to whom, and why. Pure.
//
// Autotask records every notification e-mail in NotificationHistory, ONE ROW
// PER RECIPIENT (the entity is query-only — the API cannot send one). A single
// "notify the contact + techs" on a time entry is seven rows a second apart,
// so for "was the customer told?" the useful unit is the SEND: same template,
// same initiator, same subject entity, within a few seconds. This groups rows
// into sends, newest first.

export interface NotificationRow {
  id: number;
  notificationSentTime?: string | null;
  notificationHistoryTypeID?: number | null;
  templateName?: string | null;
  recipientEmailAddress?: string | null;
  recipientDisplayName?: string | null;
  initiatingResourceID?: number | null;
  initiatingContactID?: number | null;
  ticketID?: number | null;
  timeEntryID?: number | null;
  taskID?: number | null;
  projectID?: number | null;
  opportunityID?: number | null;
  quoteID?: number | null;
  companyID?: number | null;
  entityNumber?: string | null;
  entityTitle?: string | null;
}

export interface NotificationSend {
  sentAt: string;
  type: string | null;
  template: string | null;
  /** Who triggered it: a resource name, "Contact <id>", or "Autotask (workflow/system)". */
  initiatedBy: string;
  initiatingResourceID?: number;
  initiatingContactID?: number;
  subject: { ticketID?: number; timeEntryID?: number; taskID?: number; projectID?: number; opportunityID?: number; quoteID?: number; number?: string; title?: string };
  recipients: Array<{ email: string | null; name: string | null }>;
  recipientCount: number;
  /** A recipient outside the given internal domains — i.e. the customer was e-mailed. */
  toExternal?: boolean;
}

/**
 * Domain of an address as Autotask stores it — bare ("a@x.com") or with a
 * display name ("Kaden H <a@x.com>", seen live). Lowercased; null if none.
 */
export function emailDomain(raw: string | null | undefined): string | null {
  const s = String(raw ?? '');
  const addr = (s.match(/<([^>]+)>/)?.[1] ?? s).trim();
  const dom = addr.split('@')[1]?.trim().toLowerCase();
  return dom || null;
}

/** Rows this close together with the same template/initiator/subject are one send. */
const SAME_SEND_MS = 60_000;

const subjectKey = (r: NotificationRow) =>
  [r.ticketID, r.timeEntryID, r.taskID, r.projectID, r.opportunityID, r.quoteID].map((x) => x ?? '').join('|');

export function groupNotificationSends(
  rows: NotificationRow[],
  opts: { typeLabels?: Map<number, string>; resourceNames?: Map<number, string>; internalDomains?: string[] } = {},
): NotificationSend[] {
  const sorted = rows
    .filter((r) => r.notificationSentTime)
    .sort((a, b) => Date.parse(String(a.notificationSentTime)) - Date.parse(String(b.notificationSentTime)) || a.id - b.id);
  const domains = (opts.internalDomains ?? []).map((d) => d.toLowerCase().replace(/^@/, ''));
  const sends: Array<NotificationSend & { _key: string; _last: number }> = [];
  for (const r of sorted) {
    const t = Date.parse(String(r.notificationSentTime));
    const key = [r.templateName ?? '', r.initiatingResourceID ?? '', r.initiatingContactID ?? '', subjectKey(r)].join('#');
    const open = [...sends].reverse().find((s) => s._key === key && t - s._last <= SAME_SEND_MS);
    const recipient = { email: r.recipientEmailAddress ?? null, name: r.recipientDisplayName ?? null };
    if (open) {
      if (!open.recipients.some((x) => x.email === recipient.email && x.name === recipient.name)) open.recipients.push(recipient);
      open._last = t;
      continue;
    }
    const subject: NotificationSend['subject'] = {};
    for (const k of ['ticketID', 'timeEntryID', 'taskID', 'projectID', 'opportunityID', 'quoteID'] as const) if (r[k] != null) subject[k] = Number(r[k]);
    if (r.entityNumber) subject.number = r.entityNumber;
    if (r.entityTitle) subject.title = String(r.entityTitle).replace(/\s+/g, ' ').trim().slice(0, 120);
    const initiatedBy = r.initiatingResourceID != null
      ? (opts.resourceNames?.get(Number(r.initiatingResourceID)) ?? `Resource ${r.initiatingResourceID}`)
      : r.initiatingContactID != null ? `Contact ${r.initiatingContactID}` : 'Autotask (workflow/system)';
    sends.push({
      sentAt: String(r.notificationSentTime),
      type: r.notificationHistoryTypeID != null ? (opts.typeLabels?.get(Number(r.notificationHistoryTypeID)) ?? String(r.notificationHistoryTypeID)) : null,
      template: r.templateName ?? null,
      initiatedBy,
      ...(r.initiatingResourceID != null ? { initiatingResourceID: Number(r.initiatingResourceID) } : {}),
      ...(r.initiatingContactID != null ? { initiatingContactID: Number(r.initiatingContactID) } : {}),
      subject,
      recipients: [recipient],
      recipientCount: 0,
      _key: key,
      _last: t,
    });
  }
  return sends
    .map(({ _key, _last, ...s }) => {
      const out: NotificationSend = { ...s, recipientCount: s.recipients.length };
      if (domains.length) {
        out.toExternal = s.recipients.some((x) => {
          const dom = emailDomain(x.email);
          return !!dom && !domains.includes(dom);
        });
      }
      return out;
    })
    .sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt));
}
