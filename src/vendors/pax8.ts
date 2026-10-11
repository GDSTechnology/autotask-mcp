// Pax8 adapter: the invoice CSV export ("csv-p<account>-<invoice>-<date>.csv",
// Pax8 Platform → Billing → Invoices → Export CSV). EVERY row becomes a line —
// Microsoft and non-Microsoft (NinjaOne/Dropsuite, Addigy, SentinelOne,
// LastPass, …), prorations, arrears, minimum-commitment charges, the card
// surcharge, credits and zero-quantity rows. Nothing is dropped; what can't be
// interpreted is reported as a warning on the document.

import { parse } from 'csv-parse/sync';
import type { Cadence, ChargeClass, VendorAdapter, VendorLine } from './types.js';

const num = (v: unknown): number | null => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => { const s = String(v ?? '').trim(); return s && s !== 'N/A' ? s : null; };

/** The account and invoice number from Pax8's export file name. */
export function pax8FileMeta(fileName: string | undefined): { account: string | null; invoice: string | null; date: string | null } {
  const m = /csv-p(\d+)-(\d{4}-\d+-\d+)-(\d{4}-\d{2}-\d{2})/i.exec(String(fileName ?? ''));
  return { account: m?.[1] ?? null, invoice: m?.[2] ?? null, date: m?.[3] ?? null };
}

/** Charge class + cadence from Pax8's type / term / commitment_term (+ description cues). */
export function pax8Classify(r: Record<string, string>): { chargeClass: ChargeClass; cadence: Cadence; flags: string[] } {
  const type = String(r.type ?? '').toLowerCase();
  const term = String(r.term ?? '').toLowerCase();
  const commit = String(r.commitment_term ?? '').toLowerCase();
  const desc = String(r.description ?? '');
  const flags: string[] = [];
  if (/\bNFR\b|not for resale/i.test(desc)) flags.push('nfr');
  const total = num(r.cost_total) ?? num(r.total) ?? 0;
  const qty = num(r.quantity);
  if (qty === 0) flags.push('zero_quantity');

  let chargeClass: ChargeClass;
  if (type === 'surcharge' || /surcharge/i.test(desc)) chargeClass = 'vendor_fee';
  else if (total < 0 || type === 'credit' || type === 'refund') chargeClass = 'credit';
  else if (type === 'prorate' || /\bpartial\b/i.test(desc)) chargeClass = 'proration';
  else if (/minimum commitment/i.test(desc)) chargeClass = 'minimum_commitment';
  else if (term === 'arrears' || /arrears/i.test(desc)) chargeClass = 'usage';
  else if (type === 'one-time' || term === 'one-time') chargeClass = 'one_time';
  else chargeClass = 'recurring';
  if (flags.includes('nfr')) chargeClass = 'nfr_internal';

  let cadence: Cadence = 'none';
  if (chargeClass === 'one_time' || chargeClass === 'vendor_fee' || chargeClass === 'minimum_commitment') cadence = 'one_time';
  else if (commit === 'monthly' && term === 'monthly') cadence = 'MM';
  else if (commit === '1-year' && term === 'monthly') cadence = 'AM';
  else if (commit === '1-year' && (term === 'annual' || term === 'yearly')) cadence = 'AA';
  else if (term === 'monthly') cadence = 'monthly';
  else if (term === 'annual' || term === 'yearly') cadence = 'annual';
  return { chargeClass, cadence, flags };
}

export const pax8Adapter: VendorAdapter = {
  vendor: 'pax8',
  label: 'Pax8 (invoice CSV export)',
  formats: ['csv'],
  detect: (fileName, head) => /^csv-p\d+-/i.test(fileName.replace(/^.*[\\/]/, '')) || /record_id,purchase_order_number,type,company_id,company_name/.test(head),
  parse(content, meta) {
    const rows = parse(content, { columns: true, bom: true, skip_empty_lines: true, relax_column_count: true, trim: false }) as Array<Record<string, string>>;
    const fm = pax8FileMeta(meta.fileName);
    const warnings: string[] = [];
    const invoiceDate = str(rows[0]?.invoice_date) ?? fm.date;
    const invoiceNumber = meta.invoiceNumber ?? fm.invoice;
    const currency = str(rows[0]?.currency_code) ?? 'USD';
    if (!rows.length) warnings.push('the file has no rows');
    if (rows.length && !('record_id' in rows[0]!)) warnings.push('not the Pax8 invoice CSV layout (no record_id column)');
    const seen = new Map<string, number>();
    const lines: VendorLine[] = rows.map((r, i) => {
      const { chargeClass, cadence, flags } = pax8Classify(r);
      // record_id is the subscription for subscription rows; a proration / one-time row can share it — the key keeps rows apart.
      const base = [r.record_id || `row${i + 2}`, r.type, r.sku, r.start_period, r.end_period].map((x) => String(x ?? '')).join('|');
      const dup = seen.get(base) ?? 0;
      seen.set(base, dup + 1);
      const lineKey = dup ? `${base}#${dup + 1}` : base;
      if (!str(r.company_name) && chargeClass !== 'vendor_fee') warnings.push(`row ${i + 2}: no customer (${r.description?.slice(0, 60)})`);
      if (num(r.cost) == null && num(r.cost_total) == null) warnings.push(`row ${i + 2}: no cost`);
      return {
        vendor: 'pax8', vendorAccountId: fm.account, lineKey,
        vendorCustomerId: str(r.company_id), vendorCustomerName: str(r.company_name),
        subscriptionId: r.type === 'subscription' ? str(r.record_id) : str(r.arrears_subscription_id),
        // A fee row has no SKU and a per-month description; give it one stable SKU so it maps once, not monthly.
        sku: str(r.sku) ?? (chargeClass === 'vendor_fee' ? (/credit card surcharge/i.test(String(r.description)) ? 'PAX8-FEE-CARD-SURCHARGE' : 'PAX8-FEE-OTHER') : null),
        description: String(r.description ?? '').replace(/\s*\[options:\s*\]\s*$/, '').trim(),
        chargeClass, cadence,
        billingTerm: str(r.term), commitmentTerm: str(r.commitment_term),
        unit: str(r.unit_of_measure), quantity: num(r.quantity), unitCost: num(r.cost), costTotal: num(r.cost_total) ?? num(r.total),
        vendorSuggestedUnitPrice: num(r.price),
        periodStart: str(r.start_period), periodEnd: str(r.end_period), renewalDate: str(r.billing_renewal),
        currency: str(r.currency_code) ?? currency, tax: num(r.sales_tax), fees: num(r.billing_fee),
        flags, raw: r,
      };
    });
    const lineTotal = Math.round(lines.reduce((s, l) => s + (l.costTotal ?? 0), 0) * 100) / 100;
    return { vendor: 'pax8', vendorAccountId: fm.account, invoiceNumber, invoiceDate, currency, lines, lineTotal, warnings };
  },
};
