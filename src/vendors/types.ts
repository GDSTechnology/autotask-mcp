// Vendor-neutral purchasing / billing reconciliation (GDS requirements v1.0,
// 2026-10-11). Every vendor adapter turns its invoice format into these
// normalized lines; matching, reconciliation, approval and execution only ever
// see this shape, so a new vendor is an adapter, not a rewrite.

/** What kind of charge a vendor line is (requirements §2 "Charge classes"). */
export type ChargeClass =
  | 'recurring'          // fixed or variable recurring subscription
  | 'usage'              // usage-based / metered / arrears true-up
  | 'one_time'           // one-time hardware / services
  | 'proration'          // partial-term, coterm, quantity-change proration
  | 'credit'             // credits / refunds (negative)
  | 'minimum_commitment' // minimum-commitment enforcement
  | 'vendor_fee'         // vendor fees, taxes, surcharges
  | 'nfr_internal';      // NFR / internal / demo

/**
 * Commitment × billing cadence. MM / AM / AA are Microsoft's NCE terms; other
 * vendors may have none — 'none' is a real value, never assumed to be MM.
 */
export type Cadence = 'MM' | 'AM' | 'AA' | 'monthly' | 'annual' | 'one_time' | 'none';

export interface VendorLine {
  vendor: string;
  vendorAccountId: string | null;
  /** Stable within the document (same line re-imported = same key). */
  lineKey: string;
  vendorCustomerId: string | null;
  vendorCustomerName: string | null;
  /** The vendor's subscription / asset id when it has one. */
  subscriptionId: string | null;
  sku: string | null;
  description: string;
  chargeClass: ChargeClass;
  cadence: Cadence;
  /** Billing term as the vendor states it (e.g. "Monthly", "One-Time", "Arrears") and the commitment ("1-Year"). */
  billingTerm: string | null;
  commitmentTerm: string | null;
  unit: string | null;
  quantity: number | null;
  unitCost: number | null;
  costTotal: number | null;
  /** The vendor's suggested / displayed sell price — never treated as GDS revenue. */
  vendorSuggestedUnitPrice: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  renewalDate: string | null;
  currency: string;
  tax: number | null;
  fees: number | null;
  /** Flags that keep a line out of customer price changes (internal / NFR / nonbillable). */
  flags: string[];
  /** The original row, untouched. */
  raw: Record<string, unknown>;
}

export interface ParsedDocument {
  vendor: string;
  vendorAccountId: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  currency: string;
  lines: VendorLine[];
  /** Sum of line totals as imported (for "every line accounted for"). */
  lineTotal: number;
  /** Anything the adapter could not interpret, with the row number — never silently dropped. */
  warnings: string[];
}

export interface VendorAdapter {
  vendor: string;
  label: string;
  /** File formats this adapter reads. */
  formats: Array<'csv' | 'pdf' | 'api'>;
  /** Does this file look like one of ours? (filename + first bytes) */
  detect(fileName: string, head: string): boolean;
  parse(content: string, meta: { fileName?: string | undefined; invoiceNumber?: string | undefined }): ParsedDocument;
}
