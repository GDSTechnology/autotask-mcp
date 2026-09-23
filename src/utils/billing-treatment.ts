/**
 * High-level billing intent for a time entry, resolved to the Autotask field
 * combination that actually produces it.
 *
 * Live-test finding (RPO closeout): setting showOnInvoice=false ALONE leaves an
 * entry billable — Autotask rejected the inconsistent state. Non-billable needs
 * isNonBillable=true (with showOnInvoice=false). And hoursToBill did NOT reliably
 * stick to 0, so it is deliberately NOT set here — verify billable state via
 * isNonBillable + showOnInvoice, not hoursToBill.
 */
export type BillingTreatment = 'billable' | 'non_billable' | 'contract_included';

export function billingTreatmentFields(
  treatment: BillingTreatment
): { isNonBillable?: boolean; showOnInvoice?: boolean } {
  switch (treatment) {
    case 'billable':
      return { isNonBillable: false };
    case 'non_billable':
      return { isNonBillable: true, showOnInvoice: false };
    case 'contract_included':
      // Delivered under a contract: billable work, but not separately invoiced.
      return { isNonBillable: false, showOnInvoice: false };
    default:
      return {};
  }
}

/**
 * Merge a billingTreatment into a time-entry payload WITHOUT overriding fields
 * the caller set explicitly (explicit isNonBillable/showOnInvoice always win).
 * Mutates and returns `target` for convenience.
 */
export function applyBillingTreatment(
  target: Record<string, any>,
  treatment: BillingTreatment | undefined
): Record<string, any> {
  if (!treatment) return target;
  const fields = billingTreatmentFields(treatment);
  if (target.isNonBillable === undefined && fields.isNonBillable !== undefined) {
    target.isNonBillable = fields.isNonBillable;
  }
  if (target.showOnInvoice === undefined && fields.showOnInvoice !== undefined) {
    target.showOnInvoice = fields.showOnInvoice;
  }
  return target;
}
