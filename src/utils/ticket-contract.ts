// Move a ticket (and its labor) to the right contract — the plan, pure.
//
// A ticket's contractID does NOT carry its time entries with it: every
// TimeEntry has its own contractID (live: a ticket on contract A had two
// entries on A and three on NO contract). Fixing the ticket alone leaves the
// labor billed against the wrong / no contract, so the plan covers both.
// Posted (approved & posted) entries are never touched: their billing items
// already exist and must be corrected in Autotask's billing workflow.

export interface ContractRow { id: number; companyID?: number; contractName?: string; contractNumber?: string; status?: number; contractType?: number; startDate?: string | null; endDate?: string | null }
export interface TicketContractRow { id: number; ticketNumber?: string; companyID?: number; contractID?: number | null; contractServiceID?: number | null; contractServiceBundleID?: number | null }
export interface EntryRow { id: number; contractID?: number | null; dateWorked?: string; hoursWorked?: number; isNonBillable?: boolean; billingApprovalDateTime?: string | null }

/** Which time entries follow the ticket to the new contract. */
export type EntryScope = 'none' | 'old_or_none' | 'all_unposted';

export type EntryAction = 'move' | 'already_on_target' | 'skip_posted' | 'skip_other_contract' | 'skip_scope_none';

export interface ContractMovePlan {
  errors: string[];
  warnings: string[];
  ticketPatch: Record<string, number | null> | null;
  entries: Array<{ id: number; dateWorked: string | null; hoursWorked: number | null; nonBillable: boolean; from: number | null; action: EntryAction }>;
  counts: Record<EntryAction, number>;
}

const day = (s: string | null | undefined): string | null => (s ? String(s).slice(0, 10) : null);

export function planContractMove(t: TicketContractRow, target: ContractRow | null, entries: EntryRow[], scope: EntryScope, opts: { allowInactive?: boolean; fromContractID?: number } = {}): ContractMovePlan {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!target) errors.push('target contract not found');
  else {
    if (t.companyID != null && target.companyID != null && Number(target.companyID) !== Number(t.companyID)) {
      errors.push(`contract ${target.id} belongs to company ${target.companyID}, the ticket to company ${t.companyID}`);
    }
    if (Number(target.status) === 0) (opts.allowInactive ? warnings : errors).push(`contract ${target.id} is INACTIVE${opts.allowInactive ? '' : ' — pass allowInactive:true if that is intended'}`);
  }
  const targetID = target ? Number(target.id) : null;
  // The contract the labor is moving OFF: given explicitly, else the ticket's
  // current one. When the ticket was already moved (e.g. in the UI) its current
  // contract IS the target, so the old one must be named via fromContractID.
  const ticketCurrent = t.contractID != null ? Number(t.contractID) : null;
  const oldID = opts.fromContractID != null ? Number(opts.fromContractID) : ticketCurrent;

  let ticketPatch: Record<string, number | null> | null = null;
  if (targetID != null && ticketCurrent !== targetID) {
    ticketPatch = { contractID: targetID };
    // A contract service / bundle belongs to ONE contract — a leftover from the
    // old contract would be inconsistent with the new one, so it is cleared.
    if (t.contractServiceID != null) { ticketPatch.contractServiceID = null; warnings.push(`ticket contractServiceID ${t.contractServiceID} (from the old contract) will be cleared`); }
    if (t.contractServiceBundleID != null) { ticketPatch.contractServiceBundleID = null; warnings.push(`ticket contractServiceBundleID ${t.contractServiceBundleID} (from the old contract) will be cleared`); }
  }

  const planned = entries.map((e) => {
    const from = e.contractID != null ? Number(e.contractID) : null;
    let action: EntryAction;
    if (e.billingApprovalDateTime) action = 'skip_posted';
    else if (targetID != null && from === targetID) action = 'already_on_target';
    else if (scope === 'none') action = 'skip_scope_none';
    else if (scope === 'all_unposted' || from === null || from === oldID) action = 'move';
    else action = 'skip_other_contract';
    return { id: Number(e.id), dateWorked: day(e.dateWorked), hoursWorked: e.hoursWorked ?? null, nonBillable: e.isNonBillable === true, from, action };
  });

  if (target) {
    const start = day(target.startDate), end = day(target.endDate);
    const outside = planned.filter((p) => p.action === 'move' && p.dateWorked && ((start && p.dateWorked < start) || (end && p.dateWorked > end)));
    if (outside.length) warnings.push(`${outside.length} time entr(ies) to move fall outside contract ${target.id}'s dates (${start ?? '…'} – ${end ?? '…'}): ${outside.map((o) => `${o.id} on ${o.dateWorked}`).join(', ')}`);
  }
  const posted = planned.filter((p) => p.action === 'skip_posted');
  if (posted.length) warnings.push(`${posted.length} POSTED time entr(ies) (${posted.map((p) => p.id).join(', ')}) are not changed — correct those through Autotask billing (unpost / credit)`);
  const other = planned.filter((p) => p.action === 'skip_other_contract');
  if (other.length && ticketCurrent === targetID && opts.fromContractID == null) warnings.push(`the ticket is already on contract ${targetID}, so its old contract is unknown — pass fromContractID (e.g. ${[...new Set(other.map((o) => o.from))].join(' or ')}) to move entries off it`);
  if (other.length) warnings.push(`${other.length} time entr(ies) on a third contract are left alone (${other.map((p) => `${p.id}→${p.from}`).join(', ')}); use entries:"all_unposted" to move them too`);

  const counts = { move: 0, already_on_target: 0, skip_posted: 0, skip_other_contract: 0, skip_scope_none: 0 } as Record<EntryAction, number>;
  for (const p of planned) counts[p.action]++;
  return { errors, warnings, ticketPatch, entries: planned, counts };
}
