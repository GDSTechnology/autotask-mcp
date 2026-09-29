/**
 * Autotask and its integrations write their bookkeeping onto a ticket as
 * notes — workflow-rule audits, "Service Desk Notification" recipient logs,
 * forward / merge / absorb records, integration audit notes (TimeZest,
 * ThreatLocker, Nexus automation). In a chat or ticket card they bury what
 * techs and contacts actually wrote: T20260921.0086 (live, 2026-09-29) has 17
 * notes and NOT ONE written by a person — the tech work is all in its time
 * entries. This classifies them so user-facing views hide them by default
 * (always counted, and recoverable with includeSystemNotes).
 *
 * Signals, from a survey of this tenant's September notes (live 2026-09-29):
 *  - noteType 2 "Task Detail": overwhelmingly machine-written — Service Desk
 *    Notification logs, Nexus audit/triage notes, ThreatLocker sync, TimeZest.
 *    People write Task Summary (1) / Task Notes (3). A rare hand-picked Task
 *    Detail note is hidden too — counted, never silently.
 *  - noteType 13/91 workflow rule, 92 forward/modify, 93/94/95 merged /
 *    absorbed / copied-to-project, 15 duplicate: system history records.
 *  - creatorResourceID 4 "Autotask Administrator", Autotask's built-in system
 *    account: it writes "Notification sent via Workflow Rule" notes as
 *    noteType 1 (the human type), so the type alone can't catch them.
 * noteType values are Autotask SYSTEM picklist entries (stable across tenants).
 * Still visible: RMM (99) / backup (100) alerts and monitoring notes — alert
 * content a tech may need.
 */

const SYSTEM_NOTE_TYPES = new Set([2, 13, 15, 91, 92, 93, 94, 95]);

/** Autotask's built-in system account ("Autotask Administrator"). */
const AUTOTASK_SYSTEM_RESOURCE_ID = 4;

const SYSTEM_TITLES = [/^service desk notification$/i, /^notification sent via workflow rule/i];

export function isSystemTicketNote(note: { noteType?: unknown; title?: unknown; creatorResourceID?: unknown }): boolean {
  if (SYSTEM_NOTE_TYPES.has(Number(note.noteType))) return true;
  if (Number(note.creatorResourceID) === AUTOTASK_SYSTEM_RESOURCE_ID) return true;
  const title = String(note.title ?? '').trim();
  return SYSTEM_TITLES.some((re) => re.test(title));
}

/** Split notes into what people wrote vs Autotask/integration bookkeeping. */
export function partitionTicketNotes<T extends { noteType?: unknown; title?: unknown; creatorResourceID?: unknown }>(notes: T[]): { human: T[]; systemHidden: number } {
  const human = notes.filter((n) => !isSystemTicketNote(n));
  return { human, systemHidden: notes.length - human.length };
}
