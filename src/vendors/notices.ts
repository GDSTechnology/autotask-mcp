// Customer notice for contract changes (billing process step 4). A contract
// plan's customer-facing rows — price increases, new lines, back-bill charges,
// term moves, more seats — change what the customer is invoiced, so the
// customer is told first. Per plan and customer: what changes (old → new, the
// monthly / one-time difference, the effective date) and whether the notice
// went out (price_change_notice, migration 0014). Executing those rows waits
// until a notice (or a waiver) is recorded for the customer.

import type { Pool } from 'pg';
import type { Plan, PlanRow } from '../change-plans/store.js';

/** Row kinds the customer sees on the invoice. Cost updates and line ends (a reduction) need no notice. */
export const NOTICE_KINDS = ['price', 'missing_line', 'backbill', 'term', 'quantity'] as const;
export const NOTICE_METHODS = ['email', 'letter', 'portal', 'call', 'waived', 'other'] as const;

export interface NoticeRecord { planId: string; companyId: number; sentOn: string; method: string; note: string | null; recordedBy: string | null; recordedAt: string }

export interface NoticeLine {
  row: number; kind: string; contract: string | null; product: string | null; label: string;
  effectiveDate: string | null; per: 'month' | 'year';
  unitsBefore: number | null; unitsAfter: number | null; priceBefore: number | null; priceAfter: number | null;
  /** Change in the recurring invoice, per month (a yearly line is shown per month too). */
  monthlyChange: number | null;
  /** A one-time charge (back-bill). */
  oneTime: number | null;
  status: string; blocked: string | null;
}
export interface CustomerNotice {
  companyId: number; customer: string | null; effectiveDate: string | null; lines: NoticeLine[];
  monthlyChange: number; oneTime: number; increase: boolean;
  notice: NoticeRecord | null;
  /** Days between the recorded notice and the effective date (null until sent). */
  noticeDays: number | null;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown): number | null => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const kindOf = (r: Pick<PlanRow, 'meta'>) => String((r.meta as Record<string, unknown> | null)?.kind ?? '');

/** Does executing this row change what the customer is invoiced (so a notice must be recorded first)? */
export function needsNotice(r: Pick<PlanRow, 'meta' | 'action' | 'entity' | 'after' | 'before'>): boolean {
  const k = kindOf(r);
  if (!(NOTICE_KINDS as readonly string[]).includes(k)) return false;
  if (k === 'quantity') return (num((r.after as Record<string, unknown> | null)?.unitChange) ?? 0) > 0; // fewer seats is a reduction
  if (k === 'term') return (r.meta as Record<string, unknown> | null)?.move === 'add'; // the move's end row follows its add row
  return r.action === 'create';
}

/** What one row does to the customer's invoice. */
export function noticeLine(r: PlanRow): NoticeLine | null {
  const k = kindOf(r);
  if (!(NOTICE_KINDS as readonly string[]).includes(k) || r.action !== 'create') return null;
  const m = (r.meta ?? {}) as Record<string, unknown>;
  const a = (r.after ?? {}) as Record<string, unknown>, b = (r.before ?? {}) as Record<string, unknown>;
  const per: 'month' | 'year' = m.per === 'year' ? 'year' : 'month';
  const monthly = (v: number) => (per === 'year' ? v / 12 : v);
  const base = { row: r.rowNo, kind: k, contract: (m.contract as string | null) ?? null, product: (m.product as string | null) ?? null, label: r.label, per, status: r.status, blocked: r.blocked };
  if (r.entity === 'ContractCharges') {
    const q = num(a.unitQuantity), p = num(a.unitPrice);
    return { ...base, effectiveDate: (a.datePurchased as string | null) ?? null, unitsBefore: null, unitsAfter: q, priceBefore: null, priceAfter: p, monthlyChange: null, oneTime: q != null && p != null ? r2(q * p) : null };
  }
  const ub = num(b.units) ?? 0, change = num(a.unitChange) ?? 0, ua = ub + change;
  const pb = num(b.unitPrice), pa = num(a.adjustedUnitPrice) ?? pb;
  const delta = pa == null ? null : r2(monthly(ua * pa - ub * (pb ?? 0)));
  return { ...base, effectiveDate: (a.effectiveDate as string | null) ?? null, unitsBefore: ub, unitsAfter: ua, priceBefore: pb, priceAfter: pa, monthlyChange: delta, oneTime: null };
}

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000);

/** The plan's customer-facing changes, per customer, with each customer's notice status. Excluded rows are left out. */
export function buildNotices(plan: Plan, notices: NoticeRecord[]): CustomerNotice[] {
  const by = new Map<number, CustomerNotice>();
  for (const r of plan.rows) {
    if (r.status === 'excluded') continue;
    const line = noticeLine(r); if (!line) continue;
    const m = (r.meta ?? {}) as Record<string, unknown>;
    const companyId = num(m.companyId); if (companyId == null) continue;
    const c = by.get(companyId) ?? { companyId, customer: (m.customer as string | null) ?? null, effectiveDate: null, lines: [], monthlyChange: 0, oneTime: 0, increase: false, notice: null, noticeDays: null };
    c.lines.push(line);
    c.monthlyChange = r2(c.monthlyChange + (line.monthlyChange ?? 0));
    c.oneTime = r2(c.oneTime + (line.oneTime ?? 0));
    if (line.kind !== 'backbill' && line.effectiveDate && (!c.effectiveDate || line.effectiveDate < c.effectiveDate)) c.effectiveDate = line.effectiveDate;
    by.set(companyId, c);
  }
  for (const c of by.values()) {
    c.increase = c.monthlyChange > 0.005 || c.oneTime > 0.005;
    c.notice = notices.find((n) => n.planId === plan.id && n.companyId === c.companyId) ?? null;
    c.noticeDays = c.notice && c.effectiveDate && c.notice.method !== 'waived' ? daysBetween(c.notice.sentOn, c.effectiveDate) : null;
  }
  return [...by.values()].sort((a, b) => b.monthlyChange + b.oneTime - (a.monthlyChange + a.oneTime));
}

/** Approved rows that must wait: customer-facing, and no notice recorded for that customer on this plan. */
export function rowsAwaitingNotice(plan: Plan, notices: NoticeRecord[]): Array<{ row: number; companyId: number | null; customer: string | null }> {
  const told = new Set(notices.filter((n) => n.planId === plan.id).map((n) => n.companyId));
  const out: Array<{ row: number; companyId: number | null; customer: string | null }> = [];
  for (const r of plan.rows) {
    if (r.status !== 'approved' || !needsNotice(r)) continue;
    const m = (r.meta ?? {}) as Record<string, unknown>;
    const companyId = num(m.companyId);
    if (companyId == null || !told.has(companyId)) out.push({ row: r.rowNo, companyId, customer: (m.customer as string | null) ?? null });
  }
  return out;
}

/** CSV for a mail merge: one line per change, the customer's totals repeated. */
export function noticesCsv(list: CustomerNotice[]): string {
  const esc = (v: unknown) => { const s = v == null ? '' : String(v); const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe; };
  const head = ['Company ID', 'Customer', 'Contract', 'Product', 'Change', 'Effective', 'Units before', 'Units after', 'Price before', 'Price after', 'Per', 'Monthly change', 'One-time', 'Customer monthly total change', 'Customer one-time total', 'Notice sent', 'Notice method'];
  const rows = list.flatMap((c) => c.lines.map((l) => [c.companyId, c.customer, l.contract, l.product, l.kind, l.effectiveDate, l.unitsBefore, l.unitsAfter, l.priceBefore, l.priceAfter, l.per, l.monthlyChange, l.oneTime, c.monthlyChange, c.oneTime, c.notice?.sentOn ?? '', c.notice?.method ?? '']));
  return [head, ...rows].map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

export class NoticeStore {
  constructor(private readonly pool: Pool) {}
  async list(planId?: string): Promise<NoticeRecord[]> {
    const r = planId ? await this.pool.query('SELECT * FROM price_change_notice WHERE plan_id = $1', [planId]) : await this.pool.query('SELECT * FROM price_change_notice ORDER BY recorded_at DESC LIMIT 1000');
    return r.rows.map((x) => ({ planId: x.plan_id, companyId: Number(x.company_id), sentOn: new Date(x.sent_on).toISOString().slice(0, 10), method: x.method, note: x.note ?? null, recordedBy: x.recorded_by ?? null, recordedAt: new Date(x.recorded_at).toISOString() }));
  }
  async record(planId: string, companyIds: number[], n: { sentOn: string; method: string; note: string | null; by: string | null }): Promise<number> {
    let k = 0;
    for (const id of companyIds) {
      const r = await this.pool.query(`INSERT INTO price_change_notice (plan_id, company_id, sent_on, method, note, recorded_by) VALUES ($1, $2, $3::date, $4, $5, $6)
        ON CONFLICT (plan_id, company_id) DO UPDATE SET sent_on = EXCLUDED.sent_on, method = EXCLUDED.method, note = EXCLUDED.note, recorded_by = EXCLUDED.recorded_by, recorded_at = now()`, [planId, id, n.sentOn, n.method, n.note, n.by]);
      k += r.rowCount ?? 0;
    }
    return k;
  }
  async remove(planId: string, companyIds: number[]): Promise<number> {
    const r = await this.pool.query('DELETE FROM price_change_notice WHERE plan_id = $1 AND company_id = ANY($2::bigint[])', [planId, companyIds]);
    return r.rowCount ?? 0;
  }
}
