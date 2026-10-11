// Vendor price reference (migration 0011 vendor_price): partner cost and the
// vendor's suggested price per SKU and term, each with its source. Filled from
// invoice lines (what we actually paid, per term) and from price lists /
// manual entry (terms we haven't bought yet). Monthly terms are per month;
// AA / annual are per year.

import type { Pool } from 'pg';
import type { VendorStore } from './store.js';

export interface VendorPrice { vendor: string; sku: string; cadence: string; unitCost: number | null; suggestedPrice: number | null; per: 'month' | 'year'; source: string; effectiveDate: string }

export const perOf = (cadence: string): 'month' | 'year' => (cadence === 'AA' || cadence === 'annual' ? 'year' : 'month');

export class PriceStore {
  constructor(private readonly pool: Pool) {}

  async upsert(ps: Array<VendorPrice & { by?: string | null }>): Promise<number> {
    let n = 0;
    for (const p of ps) {
      const r = await this.pool.query(
        `INSERT INTO vendor_price (vendor, sku, cadence, unit_cost, suggested_price, per, source, effective_date, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (vendor, sku, cadence, effective_date, source) DO UPDATE SET unit_cost = EXCLUDED.unit_cost, suggested_price = EXCLUDED.suggested_price, recorded_by = EXCLUDED.recorded_by, recorded_at = now()`,
        [p.vendor, p.sku, p.cadence, p.unitCost, p.suggestedPrice, p.per, p.source, p.effectiveDate, p.by ?? null],
      );
      n += r.rowCount ?? 0;
    }
    return n;
  }

  /** The current price per (vendor, sku, cadence): the newest effective date; on a tie a price list / manual entry beats an invoice. */
  async current(vendor?: string): Promise<VendorPrice[]> {
    const r = await this.pool.query(
      `SELECT DISTINCT ON (vendor, sku, cadence) * FROM vendor_price ${vendor ? 'WHERE vendor = $1' : ''}
       ORDER BY vendor, sku, cadence, effective_date DESC, (source NOT LIKE 'invoice:%') DESC, recorded_at DESC`, vendor ? [vendor] : []);
    return r.rows.map((x) => ({ vendor: x.vendor, sku: x.sku, cadence: x.cadence, unitCost: x.unit_cost == null ? null : Number(x.unit_cost), suggestedPrice: x.suggested_price == null ? null : Number(x.suggested_price), per: x.per, source: x.source, effectiveDate: new Date(x.effective_date).toISOString().slice(0, 10) }));
  }
}

/** Prices observed on imported invoices: one per (sku, cadence, invoice) from full-period recurring lines. */
export async function pricesFromInvoices(store: VendorStore, vendor: string): Promise<VendorPrice[]> {
  const lines = await store.lines({ vendor, limit: 20000 });
  const out = new Map<string, VendorPrice>();
  for (const l of lines) {
    if (l.chargeClass !== 'recurring' || !l.sku || !['MM', 'AM', 'AA', 'monthly', 'annual'].includes(l.cadence) || l.unitCost == null) continue;
    const key = `${l.sku}|${l.cadence}|${l.invoiceNumber}`;
    if (out.has(key)) continue;
    out.set(key, { vendor, sku: l.sku, cadence: l.cadence, unitCost: l.unitCost, suggestedPrice: l.vendorSuggestedUnitPrice, per: perOf(l.cadence), source: `invoice:${l.invoiceNumber ?? l.documentId}`, effectiveDate: l.invoiceDate ?? l.periodStart ?? new Date().toISOString().slice(0, 10) });
  }
  return [...out.values()];
}
