// Contract labour-billing basis — the "is labour included in the fee" flag the
// billing/unbilled reports need to tell a real leak from a contract working as
// designed. Autotask has no direct boolean; it is DERIVED from contractType.
//
// contractType (live picklist): 1=Time & Materials, 3=Fixed Price, 4=Block Hours,
// 6=Retainer, 7=Recurring Service, 8=Per Ticket, 9=Umbrella.

export type LabourBasis = 'billed' | 'block' | 'absorbed' | 'umbrella' | 'unknown';

export interface LabourClassification {
  basis: LabourBasis;
  /** true = labour billed on top; false = absorbed in the fee; null = depends (block overage / umbrella / unknown). */
  labourBilled: boolean | null;
  /** true when unbilled/unapproved time on this contract is a potential revenue leak worth chasing. */
  leakageRelevant: boolean;
  description: string;
}

export function classifyContractLabourBilling(contractType: number | null | undefined): LabourClassification {
  switch (Number(contractType)) {
    case 1:
      return { basis: 'billed', labourBilled: true, leakageRelevant: true, description: 'Time & Materials — labour is billed on top; unbilled/unapproved time here is potential revenue leakage.' };
    case 8:
      return { basis: 'billed', labourBilled: true, leakageRelevant: true, description: 'Per Ticket — labour is billed per ticket; unbilled time here is potential leakage.' };
    case 4:
      return { basis: 'block', labourBilled: null, leakageRelevant: true, description: 'Block Hours — labour draws down a prepaid block; hours within the block are covered, overage is billable (overageBillingRate). Compare used vs purchased, not raw unbilled.' };
    case 6:
      return { basis: 'absorbed', labourBilled: false, leakageRelevant: false, description: 'Retainer — labour is absorbed in the retainer fee; unbilled time is expected, not a leak (overage may bill separately).' };
    case 7:
      return { basis: 'absorbed', labourBilled: false, leakageRelevant: false, description: 'Recurring Service — labour is included in the recurring fee; unbilled time is by design.' };
    case 3:
      return { basis: 'absorbed', labourBilled: false, leakageRelevant: false, description: 'Fixed Price — labour is included in the fixed fee; unbilled time is by design.' };
    case 9:
      return { basis: 'umbrella', labourBilled: null, leakageRelevant: false, description: 'Umbrella — bills through its child contracts; assess labour on the children.' };
    default:
      return { basis: 'unknown', labourBilled: null, leakageRelevant: false, description: 'Unknown/other contract type — cannot determine the labour-billing basis; verify in Autotask.' };
  }
}
