// The reconciliation workbook (requirements §10): the required columns first,
// in order, then the recommended extras; one worksheet per view. Excel is an
// export — approvals happen in chat. Text that could be read as a formula is
// neutralised (a leading ' for = + - @).

import ExcelJS from 'exceljs';
import type { ReconRow } from './reconcile.js';
import type { RunInfo, ExceptionState } from './recon-store.js';
import type { VendorLine } from './types.js';
import type { CustomerPriceException, PricingPolicy } from './policy.js';
import type { Plan } from '../change-plans/store.js';

export const REQUIRED_COLUMNS: Array<[string, keyof ReconRow]> = [
  ['Customer Name', 'customerName'], ['Autotask Contract', 'autotaskContract'], ['Vendor', 'vendor'], ['Service / SKU', 'serviceSku'],
  ['Commitment / Billing Term', 'commitmentTerm'], ['Unit', 'unit'], ['Quantity', 'quantity'], ['Cost Should Be', 'costShouldBe'], ['Price Should Be', 'priceShouldBe'],
  ['Current Cost', 'currentCost'], ['Current Price', 'currentPrice'], ['Difference on Cost', 'differenceOnCost'], ['Difference on Price', 'differenceOnPrice'],
];
const EXTRA_COLUMNS: Array<[string, keyof ReconRow]> = [
  ['Severity', 'severity'], ['Exceptions', 'exceptions'], ['Reason', 'reason'], ['Proposed Action', 'proposedAction'], ['Confidence', 'confidence'],
  ['Monthly Exposure', 'monthlyExposure'], ['Annual Exposure', 'annualExposure'], ['Gross Margin (monthly $)', 'grossMarginMonthly'], ['Gross Margin %', 'grossMarginPct'],
  ['Autotask Company ID', 'autotaskCompanyId'], ['Contract ID', 'contractId'], ['Contract Service ID', 'contractServiceId'], ['Autotask Service', 'serviceName'], ['Service ID', 'serviceId'],
  ['Offering', 'offering'], ['Vendor Customer', 'vendorCustomerName'], ['Vendor Subscription IDs', 'subscriptionIds'], ['Vendor Description', 'vendorDescription'],
  ['Contract Term', 'contractCadence'], ['Contract Quantity', 'contractQuantity'], ['Contract Quantity (all lines)', 'contractQuantityTotal'], ['Line Kind', 'lineKind'], ['Bundle', 'bundleName'], ['Contract Service Bundle ID', 'contractServiceBundleId'], ['Primary Line', 'primary'], ['Billed Quantity', 'billedQuantity'], ['Billed Unit Price', 'billedRate'], ['Billed Invoice ID', 'billedInvoiceId'], ['Billing Posted', 'billingPosted'],
  ['Catalog Cost', 'catalogCost'], ['Catalog Price', 'catalogPrice'], ['Vendor Unit Cost', 'vendorUnitCost'], ['Vendor Suggested Price', 'vendorSuggestedPrice'], ['Landed Cost', 'landedCost'], ['Price Rule', 'priceRule'],
  ['Amounts Per', 'basis'], ['Match', 'matchMethod'], ['Also Billed On', 'otherContractServices'], ['Source Invoice', 'sourceInvoice'], ['Period', 'period'], ['Exception Key', 'exceptionKey'],
];

const safe = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.join(', ');
  if (typeof v === 'string' && /^[=+\-@]/.test(v)) return `'${v}`;
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  return v ?? '';
};

function sheet(wb: ExcelJS.Workbook, name: string, header: string[], rows: unknown[][], widths?: number[]): void {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.addRow(header).font = { bold: true };
  for (const r of rows) ws.addRow(r.map(safe));
  ws.columns.forEach((c, i) => { c.width = widths?.[i] ?? Math.min(48, Math.max(10, header[i]!.length + 2)); });
  if (rows.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: header.length } };
}

export async function buildWorkbook(d: {
  run: RunInfo; rows: ReconRow[]; states: Map<string, ExceptionState>; lines: VendorLine[];
  policies: PricingPolicy[]; customerExceptions: CustomerPriceException[]; plans: Plan[];
}): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PSArelay'; wb.created = new Date();
  const s = d.run.summary as Record<string, number>;
  const cols = [...REQUIRED_COLUMNS, ...EXTRA_COLUMNS];
  const withState = (r: ReconRow) => { const st = d.states.get(r.exceptionKey); return [...cols.map(([, k]) => r[k]), st?.status ?? (r.severity === 'ok' || r.severity === 'info' ? '' : 'open'), st?.owner ?? '']; };
  const header = [...cols.map(([h]) => h), 'Status', 'Owner'];

  // Executive Summary
  const byCustomer = new Map<string, number>();
  for (const r of d.rows) if (r.monthlyExposure) byCustomer.set(r.customerName ?? '(unknown)', (byCustomer.get(r.customerName ?? '(unknown)') ?? 0) + r.monthlyExposure);
  sheet(wb, 'Executive Summary', ['Item', 'Value'], [
    ['Vendor', d.run.vendor], ['Invoice', d.run.invoiceNumber ?? ''], ['Period', `${d.run.periodStart} – ${d.run.periodEnd}`], ['Run', d.run.id], ['Built', d.run.createdAt], ['By', d.run.createdBy ?? ''],
    ['Vendor cost on the invoice', s.vendorCost], ['Rows', s.rows], ['Critical', s.critical], ['High', s.high], ['Review', s.review], ['Informational', s.info], ['Matching', s.ok],
    ['Monthly exposure (all)', s.monthlyExposure], ['Monthly exposure (critical)', s.monthlyExposureCritical],
    ['Below landed cost (rows)', s.belowCost], ['…confirmed by a posted invoice', s.belowCostConfirmed], ['Vendor charge not billed back (rows)', s.notBilled], ['Quantity short (rows)', s.qtyShort],
    ['', ''], ['Top customers by monthly exposure', ''],
    ...[...byCustomer.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([c, v]) => [c, Math.round(v * 100) / 100]),
    ['', ''], ['Note', 'A loss is only "confirmed" when a POSTED billing item shows the billed rate below landed cost; otherwise it is a contract-price exposure. Unknown quantities are "unverified", never zero.'],
  ], [44, 60]);

  sheet(wb, 'Exceptions', header, d.rows.filter((r) => r.severity === 'critical' || r.severity === 'high' || r.severity === 'review').map(withState));
  sheet(wb, 'All Vendor Lines', ['Invoice', 'Invoice Date', 'Vendor Customer', 'Subscription', 'SKU', 'Description', 'Charge Class', 'Term', 'Commitment', 'Billing Term', 'Unit', 'Quantity', 'Unit Cost', 'Total Cost', 'Vendor Suggested Price', 'Period Start', 'Period End', 'Renewal', 'Flags'],
    d.lines.map((l) => [d.run.invoiceNumber, (l as VendorLine & { invoiceDate?: string }).invoiceDate ?? '', l.vendorCustomerName, l.subscriptionId, l.sku, l.description, l.chargeClass, l.cadence, l.commitmentTerm, l.billingTerm, l.unit, l.quantity, l.unitCost, l.costTotal, l.vendorSuggestedUnitPrice, l.periodStart, l.periodEnd, l.renewalDate, l.flags]));
  sheet(wb, 'Customer Contracts', header, d.rows.filter((r) => r.contractServiceId != null || r.contractServiceBundleId != null).map(withState));
  sheet(wb, 'Unmatched Internal NFR', header, d.rows.filter((r) => r.exceptions.some((e) => ['unmapped_customer', 'unmapped_sku', 'not_billed', 'not_customer_billable', 'proration_credit'].includes(e))).map(withState));
  const planRows = d.plans.flatMap((p) => p.rows.map((r) => ({ p, r })));
  sheet(wb, 'Approved Changes', ['Plan', 'Kind', 'Row', 'Action', 'Change', 'Before', 'After', 'Reason', 'Status', 'Approved By', 'Approved At'],
    planRows.filter(({ r }) => ['approved', 'applied', 'failed', 'stale', 'skipped'].includes(r.status) && r.action !== 'info').map(({ p, r }) => [p.id, p.kind, r.rowNo, r.action, r.label, JSON.stringify(r.before ?? {}), JSON.stringify(r.after ?? {}), r.reason, r.status, r.approvedBy, r.approvedAt]));
  sheet(wb, 'Execution Audit', ['Plan', 'Row', 'Change', 'Status', 'Executed At', 'Result'],
    planRows.filter(({ r }) => r.executedAt).map(({ p, r }) => [p.id, r.rowNo, r.label, r.status, r.executedAt, JSON.stringify(r.result ?? {})]));
  sheet(wb, 'Pricing Policy', ['Scope', 'Mode', 'Pct', 'Margin Floor', 'Fee Policy', 'Note', 'Decided By', 'Decided At'],
    [...(d.policies.length ? d.policies : [{ scope: '*', mode: 'vendor_suggested', pct: null, marginFloor: 0, feePolicy: 'overhead', note: 'built-in default (no policy set)', decidedBy: null, decidedAt: '' }]).map((p) => [p.scope, p.mode, p.pct, p.marginFloor, p.feePolicy, p.note, p.decidedBy, p.decidedAt]),
      [], ['Negotiated customer prices'], ...d.customerExceptions.map((e) => [`company ${e.autotaskCompanyId}`, `offering ${e.offeringId} ${e.cadence}`, e.agreedUnitPrice, '', '', e.reason, e.decidedBy, e.expiresOn ?? ''])]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
