// Ticket-anchored billing-completeness analysis (weekly leakage sweep, ticket
// scope). Complements the service-call sweep: this looks at ALL recently-active
// tickets, because "if work was possible but not logged, that's an issue" even
// when there's no service call. Pure/HTTP-free so the rules are unit-testable;
// the service layer resolves work-type + contract attributes and passes them in.
//
// Three signals (all confirmed against live schema 2026-09-18):
//  1. work-not-logged  — evidence of work (a tech email reply note, or a
//     completed/closed ticket) but ZERO time entries.
//  2. note-without-time — a tech reply landed as a TicketNote (noteType 101
//     "Email Note", authored by a resource, not the customer) with no time entry
//     by that resource on the same day. The classic "tech CC'd the ticket, a
//     note was added, but the time entry was never finished."
//  3. billable-marked-non-billable — a time entry flagged isNonBillable that
//     looks like it should bill, by any of: the work type is client labor
//     (BillingCodes.useType 1 General Allocation, and not a billingCodeType 2
//     Non-Billable code); the ticket's contract is Time & Materials
//     (Contracts.contractType 1); or the ticket also has billable time (mixed).

export const COMPLETE_TICKET_STATUS = 5;
export const TM_CONTRACT_TYPE = 1;                 // Contracts.contractType
export const GENERAL_ALLOCATION_USETYPE = 1;       // BillingCodes.useType (client labor)
export const NONBILLABLE_BILLINGCODE_TYPE = 2;     // BillingCodes.billingCodeType
/** TicketNote types that represent a human reply/work note (tech CC/email-in). */
export const HUMAN_REPLY_NOTE_TYPES = new Set<number>([101]); // Email Note

export interface TBGTimeEntry {
  resourceID?: number;
  dateWorked?: string;
  hoursWorked?: number;
  hoursToBill?: number;
  isNonBillable?: boolean;
  /** resolved from billingCodeID by the service layer */
  workTypeUseType?: number | undefined;
  workTypeBillingCodeType?: number | undefined;
  workTypeName?: string | undefined;
}

export interface TBGNote {
  creatorResourceID?: number | null;
  createdByContactID?: number | null;
  noteType?: number;
  createDateTime?: string;
}

export interface TBGInput {
  ticket: { id: number; ticketNumber?: string; status?: number; completedDate?: string | null; contractType?: number | null };
  timeEntries: TBGTimeEntry[];
  notes: TBGNote[];
  now?: Date;
}

export interface TBGResult {
  ticketId: number;
  ticketNumber: string | undefined;
  isComplete: boolean;
  timeEntryCount: number;
  totalHours: number;
  flags: {
    workNotLogged: boolean;
    notesWithoutTime: { count: number; noteTypes: number[] };
    nonbillableSuspect: {
      count: number; hours: number;
      items: Array<{ resourceID?: number; dateWorked?: string; hours: number; workTypeName?: string; signals: string[] }>;
    };
  };
  issues: string[];
}

const DAY = (d?: string | null): number | null => {
  if (!d) return null;
  const ms = Date.parse(d);
  return Number.isNaN(ms) ? null : Math.floor(ms / 86_400_000);
};
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** A tech reply/work note: authored by a resource (not the customer) and a human note type. */
function isTechReplyNote(n: TBGNote): boolean {
  return n.creatorResourceID != null && n.createdByContactID == null &&
    n.noteType != null && HUMAN_REPLY_NOTE_TYPES.has(n.noteType);
}

export function analyzeTicketBillingGaps(input: TBGInput): TBGResult {
  const t = input.ticket;
  const isComplete = t.status === COMPLETE_TICKET_STATUS || t.completedDate != null;
  const entries = input.timeEntries ?? [];
  const notes = input.notes ?? [];
  const totalHours = round2(entries.reduce((s, e) => s + (e.hoursWorked ?? 0), 0));

  const techNotes = notes.filter(isTechReplyNote);

  // 1. work-not-logged
  const workNotLogged = entries.length === 0 && (techNotes.length > 0 || isComplete);

  // 2. note-without-time: tech reply note with no time entry by that resource same day
  const uncaptured = techNotes.filter((n) => {
    const nd = DAY(n.createDateTime);
    return !entries.some((e) => e.resourceID === n.creatorResourceID && nd != null && DAY(e.dateWorked) === nd);
  });

  // 3. billable-marked-non-billable
  const hasBillable = entries.some((e) => e.isNonBillable !== true);
  const suspectItems: TBGResult['flags']['nonbillableSuspect']['items'] = [];
  for (const e of entries) {
    if (e.isNonBillable !== true) continue;
    // A work type explicitly designated Non-Billable (billingCodeType 2) is
    // intentionally non-billable (e.g. "General Administration (non-billable)")
    // — never flag it, no matter the contract or that the ticket also bills.
    // (Verified live on ticket 200510, where this removed the false positives.)
    if (e.workTypeBillingCodeType === NONBILLABLE_BILLINGCODE_TYPE) continue;
    const signals: string[] = [];
    if (e.workTypeUseType === GENERAL_ALLOCATION_USETYPE && e.workTypeBillingCodeType !== NONBILLABLE_BILLINGCODE_TYPE) signals.push('work_type_billable');
    if (t.contractType === TM_CONTRACT_TYPE) signals.push('contract_tm');
    if (hasBillable) signals.push('mixed_on_ticket');
    if (signals.length > 0) {
      suspectItems.push({
        ...(e.resourceID !== undefined ? { resourceID: e.resourceID } : {}),
        ...(e.dateWorked !== undefined ? { dateWorked: e.dateWorked } : {}),
        hours: e.hoursWorked ?? 0,
        ...(e.workTypeName !== undefined ? { workTypeName: e.workTypeName } : {}),
        signals,
      });
    }
  }
  const suspectHours = round2(suspectItems.reduce((s, i) => s + i.hours, 0));

  const flags = {
    workNotLogged,
    notesWithoutTime: { count: uncaptured.length, noteTypes: [...new Set(uncaptured.map((n) => n.noteType!).filter((x) => x != null))] },
    nonbillableSuspect: { count: suspectItems.length, hours: suspectHours, items: suspectItems },
  };

  const issues: string[] = [];
  if (flags.workNotLogged) issues.push('work_not_logged');
  if (flags.notesWithoutTime.count > 0) issues.push('note_without_time');
  if (flags.nonbillableSuspect.count > 0) issues.push('billable_marked_nonbillable');

  return {
    ticketId: t.id,
    ticketNumber: t.ticketNumber,
    isComplete,
    timeEntryCount: entries.length,
    totalHours,
    flags,
    issues,
  };
}
