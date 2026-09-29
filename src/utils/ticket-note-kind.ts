/**
 * Autotask writes its own bookkeeping onto a ticket as notes — "Workflow Rule
 * … fired." audit notes, "Service Desk Notification" email-recipient logs,
 * forward/modify records. On a typical GDS ticket they are two thirds of the
 * notes (T20260928.0084: 15 of 24), and in a chat or ticket card they bury what
 * people actually wrote. This classifies them so user-facing views can hide
 * them by default.
 *
 * noteType values are Autotask SYSTEM picklist entries (isSystem on
 * TicketNotes.noteType, verified live 2026-09-29), so they are stable across
 * tenants — unlike tenant-defined picklists.
 *
 * Deliberately NOT hidden: merge/copy/duplicate history (93/94/95/15),
 * outsource (16), RMM (99) and backup (100) alerts — system-originated, but
 * they carry ticket history or diagnostics a tech may need.
 */

/** noteType 13 / 91: workflow rule notes; 92: forward/modify record. */
const SYSTEM_NOTE_TYPES = new Set([13, 91, 92]);

/** Autotask's title for the "who was emailed" log (noteType 2, Task Detail). */
const NOTIFICATION_TITLE = 'service desk notification';

export function isSystemTicketNote(note: { noteType?: unknown; title?: unknown }): boolean {
  if (SYSTEM_NOTE_TYPES.has(Number(note.noteType))) return true;
  return String(note.title ?? '').trim().toLowerCase() === NOTIFICATION_TITLE;
}

/** Split notes into what people wrote vs Autotask bookkeeping. */
export function partitionTicketNotes<T extends { noteType?: unknown; title?: unknown }>(notes: T[]): { human: T[]; systemHidden: number } {
  const human = notes.filter((n) => !isSystemTicketNote(n));
  return { human, systemHidden: notes.length - human.length };
}
