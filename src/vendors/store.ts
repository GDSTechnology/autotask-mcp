// Postgres store for vendor documents, lines and mapping decisions (migration
// 0010). Imports are idempotent: the same file (sha256) is not imported twice,
// and a line is unique per (document, line_key). Mapping changes supersede the
// current row instead of overwriting it — the history of every decision stays.

import type { Pool, PoolClient } from 'pg';
import type { ParsedDocument, VendorLine } from './types.js';

export interface DocumentRow {
  id: number; vendor: string; vendorAccountId: string | null; invoiceNumber: string | null; invoiceDate: string | null;
  fileName: string | null; sha256: string; format: string; lineCount: number; lineTotal: number | null; warnings: string[];
  importedBy: string | null; importedAt: string;
}
export interface CustomerMapping { vendor: string; vendorCustomerId: string; vendorCustomerName: string | null; status: 'mapped' | 'internal' | 'ignore'; autotaskCompanyId: number | null; method: string; confidence: string; note: string | null; decidedBy: string | null; decidedAt: string }
export interface Offering { id: number; manufacturer: string; name: string; manufacturerProductId: string | null; unit: string | null; kind: string; notes: string | null }
export interface OfferingMapping { vendor: string; sku: string; status: 'mapped' | 'not_billable' | 'ignore'; offeringId: number | null; method: string; confidence: string; note: string | null; decidedBy: string | null; decidedAt: string }
export interface CatalogLink { autotaskEntity: string; autotaskId: number; offeringId: number; cadence: string; method: string; confidence: string; note: string | null; decidedBy: string | null; decidedAt: string }
export interface CrosswalkRow { vendor: string; vendorCustomerRef: string; vendorCustomerName: string; autotaskCompanyId: number | null; autotaskCompanyName: string | null }

const iso = (d: Date | string | null | undefined): string | null => (d == null ? null : new Date(d).toISOString());
const day = (d: Date | string | null | undefined): string | null => (d == null ? null : new Date(d).toISOString().slice(0, 10));
const n = (v: string | number | null): number | null => (v == null ? null : Number(v));

export class VendorStore {
  constructor(private readonly pool: Pool) {}

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; } catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; } finally { c.release(); }
  }

  async documentBySha(sha256: string): Promise<DocumentRow | null> {
    const r = await this.pool.query('SELECT * FROM vendor_source_document WHERE sha256 = $1', [sha256]);
    return r.rows[0] ? this.doc(r.rows[0]) : null;
  }
  private doc(x: Record<string, any>): DocumentRow {
    return { id: Number(x.id), vendor: x.vendor, vendorAccountId: x.vendor_account_id, invoiceNumber: x.invoice_number, invoiceDate: day(x.invoice_date), fileName: x.file_name, sha256: x.sha256, format: x.format, lineCount: x.line_count, lineTotal: n(x.line_total), warnings: x.warnings ?? [], importedBy: x.imported_by, importedAt: iso(x.imported_at)! };
  }

  /** Store a parsed document and every line in one transaction. Returns the document (existing one when already imported). */
  async importDocument(d: ParsedDocument, meta: { sha256: string; fileName: string | null; format: string; by: string | null }): Promise<{ doc: DocumentRow; created: boolean }> {
    const existing = await this.documentBySha(meta.sha256);
    if (existing) return { doc: existing, created: false };
    return this.tx(async (c) => {
      const r = await c.query(
        `INSERT INTO vendor_source_document (vendor, vendor_account_id, invoice_number, invoice_date, file_name, sha256, format, currency, line_count, line_total, warnings, imported_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [d.vendor, d.vendorAccountId, d.invoiceNumber, d.invoiceDate, meta.fileName, meta.sha256, meta.format, d.currency, d.lines.length, d.lineTotal, JSON.stringify(d.warnings), meta.by],
      );
      const docId = Number(r.rows[0].id);
      for (let i = 0; i < d.lines.length; i += 200) await this.insertLines(c, docId, d.lines.slice(i, i + 200));
      return { doc: this.doc(r.rows[0]), created: true };
    });
  }

  private async insertLines(c: PoolClient, docId: number, ls: VendorLine[]): Promise<void> {
    const col = <K extends keyof VendorLine>(k: K) => ls.map((l) => l[k]);
    await c.query(
      `INSERT INTO vendor_invoice_line (document_id, vendor, line_key, vendor_customer_id, vendor_customer_name, subscription_id, sku, description,
         charge_class, cadence, billing_term, commitment_term, unit, quantity, unit_cost, cost_total, vendor_suggested_price, period_start, period_end,
         renewal_date, currency, tax, fees, flags, raw)
       SELECT $1, u.vendor, u.line_key, u.cid, u.cname, u.sub, u.sku, u.descr, u.cls, u.cad, u.bt, u.ct, u.unit, u.qty, u.uc, u.tot, u.sp, u.ps, u.pe,
         u.rd, u.cur, u.tax, u.fees, COALESCE(string_to_array(NULLIF(u.flags, ''), ','), '{}'), u.raw
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[], $11::text[],
         $12::text[], $13::text[], $14::numeric[], $15::numeric[], $16::numeric[], $17::numeric[], $18::date[], $19::date[], $20::date[], $21::text[],
         $22::numeric[], $23::numeric[], $24::text[], $25::jsonb[])
         AS u(vendor, line_key, cid, cname, sub, sku, descr, cls, cad, bt, ct, unit, qty, uc, tot, sp, ps, pe, rd, cur, tax, fees, flags, raw)
       ON CONFLICT (document_id, line_key) DO NOTHING`,
      [docId, col('vendor'), col('lineKey'), col('vendorCustomerId'), col('vendorCustomerName'), col('subscriptionId'), col('sku'), col('description'),
        col('chargeClass'), col('cadence'), col('billingTerm'), col('commitmentTerm'), col('unit'), col('quantity'), col('unitCost'), col('costTotal'),
        col('vendorSuggestedUnitPrice'), col('periodStart'), col('periodEnd'), col('renewalDate'), col('currency'), col('tax'), col('fees'),
        ls.map((l) => l.flags.map((f) => f.replace(/,/g, ' ')).join(',')), ls.map((l) => JSON.stringify(l.raw))],
    );
  }

  async listDocuments(opts: { vendor?: string; limit?: number } = {}): Promise<DocumentRow[]> {
    const r = await this.pool.query(`SELECT * FROM vendor_source_document ${opts.vendor ? 'WHERE vendor = $2' : ''} ORDER BY invoice_date DESC NULLS LAST, id DESC LIMIT $1`, opts.vendor ? [opts.limit ?? 50, opts.vendor] : [opts.limit ?? 50]);
    return r.rows.map((x) => this.doc(x));
  }

  /** Lines, newest invoice first. */
  async lines(q: { vendor?: string; documentId?: number; invoiceDate?: string; vendorCustomerId?: string; sku?: string; limit?: number } = {}): Promise<Array<VendorLine & { id: number; documentId: number; invoiceNumber: string | null; invoiceDate: string | null }>> {
    const where: string[] = []; const p: unknown[] = [];
    const add = (sql: string, v: unknown) => { p.push(v); where.push(sql.replace('?', `$${p.length}`)); };
    if (q.vendor) add('l.vendor = ?', q.vendor);
    if (q.documentId) add('l.document_id = ?', q.documentId);
    if (q.invoiceDate) add('d.invoice_date = ?', q.invoiceDate);
    if (q.vendorCustomerId) add('l.vendor_customer_id = ?', q.vendorCustomerId);
    if (q.sku) add('l.sku = ?', q.sku);
    p.push(Math.min(q.limit ?? 5000, 20000));
    const r = await this.pool.query(`SELECT l.*, d.invoice_number, d.invoice_date FROM vendor_invoice_line l JOIN vendor_source_document d ON d.id = l.document_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.invoice_date DESC, l.id LIMIT $${p.length}`, p);
    return r.rows.map((x) => ({
      id: Number(x.id), documentId: Number(x.document_id), invoiceNumber: x.invoice_number, invoiceDate: day(x.invoice_date),
      vendor: x.vendor, vendorAccountId: null, lineKey: x.line_key, vendorCustomerId: x.vendor_customer_id, vendorCustomerName: x.vendor_customer_name,
      subscriptionId: x.subscription_id, sku: x.sku, description: x.description, chargeClass: x.charge_class, cadence: x.cadence,
      billingTerm: x.billing_term, commitmentTerm: x.commitment_term, unit: x.unit, quantity: n(x.quantity), unitCost: n(x.unit_cost), costTotal: n(x.cost_total),
      vendorSuggestedUnitPrice: n(x.vendor_suggested_price), periodStart: day(x.period_start), periodEnd: day(x.period_end), renewalDate: day(x.renewal_date),
      currency: x.currency, tax: n(x.tax), fees: n(x.fees), flags: x.flags ?? [], raw: x.raw,
    }));
  }

  // ── crosswalk (vendor's own customer ↔ PSA mapping) ──
  async importCrosswalk(rows: CrosswalkRow[], sha256: string, by: string | null): Promise<number> {
    if (!rows.length) return 0;
    const r = await this.pool.query(
      `INSERT INTO vendor_customer_crosswalk (vendor, vendor_customer_ref, vendor_customer_name, autotask_company_id, autotask_company_name, document_sha256, imported_by)
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::bigint[], $5::text[], $6::text[], $7::text[]) ON CONFLICT DO NOTHING`,
      [rows.map((x) => x.vendor), rows.map((x) => x.vendorCustomerRef), rows.map((x) => x.vendorCustomerName), rows.map((x) => x.autotaskCompanyId), rows.map((x) => x.autotaskCompanyName), rows.map(() => sha256), rows.map(() => by)],
    );
    return r.rowCount ?? 0;
  }
  /** The most recent crosswalk row per vendor customer name. */
  async crosswalk(vendor: string): Promise<CrosswalkRow[]> {
    const r = await this.pool.query(`SELECT DISTINCT ON (lower(vendor_customer_name)) * FROM vendor_customer_crosswalk WHERE vendor = $1 ORDER BY lower(vendor_customer_name), imported_at DESC`, [vendor]);
    return r.rows.map((x) => ({ vendor: x.vendor, vendorCustomerRef: x.vendor_customer_ref, vendorCustomerName: x.vendor_customer_name, autotaskCompanyId: n(x.autotask_company_id), autotaskCompanyName: x.autotask_company_name }));
  }

  // ── decisions (versioned) ──
  async customerMappings(vendor?: string): Promise<CustomerMapping[]> {
    const r = await this.pool.query(`SELECT * FROM vendor_customer_mapping WHERE superseded_at IS NULL ${vendor ? 'AND vendor = $1' : ''} ORDER BY vendor_customer_name`, vendor ? [vendor] : []);
    return r.rows.map((x) => ({ vendor: x.vendor, vendorCustomerId: x.vendor_customer_id, vendorCustomerName: x.vendor_customer_name, status: x.status, autotaskCompanyId: n(x.autotask_company_id), method: x.method, confidence: x.confidence, note: x.note, decidedBy: x.decided_by, decidedAt: iso(x.decided_at)! }));
  }
  async setCustomerMappings(ms: Array<Omit<CustomerMapping, 'decidedAt'>>): Promise<number> {
    return this.tx(async (c) => {
      for (const m of ms) {
        await c.query(`UPDATE vendor_customer_mapping SET superseded_at = now() WHERE vendor = $1 AND vendor_customer_id = $2 AND superseded_at IS NULL`, [m.vendor, m.vendorCustomerId]);
        await c.query(`INSERT INTO vendor_customer_mapping (vendor, vendor_customer_id, vendor_customer_name, status, autotask_company_id, method, confidence, note, decided_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [m.vendor, m.vendorCustomerId, m.vendorCustomerName, m.status, m.autotaskCompanyId, m.method, m.confidence, m.note, m.decidedBy]);
      }
      return ms.length;
    });
  }

  async offerings(): Promise<Offering[]> {
    const r = await this.pool.query('SELECT * FROM canonical_offering ORDER BY manufacturer, name');
    return r.rows.map((x) => ({ id: Number(x.id), manufacturer: x.manufacturer, name: x.name, manufacturerProductId: x.manufacturer_product_id, unit: x.unit, kind: x.kind, notes: x.notes }));
  }
  /** Create an offering (or return the existing one with the same manufacturer + name). */
  async ensureOffering(o: { manufacturer: string; name: string; unit?: string | null; kind?: string; manufacturerProductId?: string | null; by: string | null }): Promise<Offering> {
    const r = await this.pool.query(
      `INSERT INTO canonical_offering (manufacturer, name, unit, kind, manufacturer_product_id, created_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (manufacturer, name) DO UPDATE SET manufacturer = EXCLUDED.manufacturer RETURNING *`,
      [o.manufacturer, o.name, o.unit ?? null, o.kind ?? 'recurring', o.manufacturerProductId ?? null, o.by],
    );
    const x = r.rows[0];
    return { id: Number(x.id), manufacturer: x.manufacturer, name: x.name, manufacturerProductId: x.manufacturer_product_id, unit: x.unit, kind: x.kind, notes: x.notes };
  }

  /** Record the manufacturer's own product id (e.g. from Pax8's vendorSku) on an offering — only when not set yet. */
  async setManufacturerProductId(offeringId: number, productId: string): Promise<boolean> {
    const r = await this.pool.query('UPDATE canonical_offering SET manufacturer_product_id = $2 WHERE id = $1 AND manufacturer_product_id IS NULL', [offeringId, productId]);
    return (r.rowCount ?? 0) > 0;
  }

  async offeringMappings(vendor?: string): Promise<OfferingMapping[]> {
    const r = await this.pool.query(`SELECT * FROM vendor_offering_mapping WHERE superseded_at IS NULL ${vendor ? 'AND vendor = $1' : ''} ORDER BY sku`, vendor ? [vendor] : []);
    return r.rows.map((x) => ({ vendor: x.vendor, sku: x.sku, status: x.status, offeringId: n(x.offering_id), method: x.method, confidence: x.confidence, note: x.note, decidedBy: x.decided_by, decidedAt: iso(x.decided_at)! }));
  }
  async setOfferingMappings(ms: Array<Omit<OfferingMapping, 'decidedAt'>>): Promise<number> {
    return this.tx(async (c) => {
      for (const m of ms) {
        await c.query(`UPDATE vendor_offering_mapping SET superseded_at = now() WHERE vendor = $1 AND sku = $2 AND superseded_at IS NULL`, [m.vendor, m.sku]);
        await c.query(`INSERT INTO vendor_offering_mapping (vendor, sku, status, offering_id, method, confidence, note, decided_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [m.vendor, m.sku, m.status, m.offeringId, m.method, m.confidence, m.note, m.decidedBy]);
      }
      return ms.length;
    });
  }

  async catalogLinks(): Promise<CatalogLink[]> {
    const r = await this.pool.query('SELECT * FROM catalog_offering_link WHERE superseded_at IS NULL ORDER BY offering_id, autotask_id');
    return r.rows.map((x) => ({ autotaskEntity: x.autotask_entity, autotaskId: Number(x.autotask_id), offeringId: Number(x.offering_id), cadence: x.cadence, method: x.method, confidence: x.confidence, note: x.note, decidedBy: x.decided_by, decidedAt: iso(x.decided_at)! }));
  }
  async setCatalogLinks(ls: Array<Omit<CatalogLink, 'decidedAt'>>): Promise<number> {
    return this.tx(async (c) => {
      for (const l of ls) {
        await c.query(`UPDATE catalog_offering_link SET superseded_at = now() WHERE autotask_entity = $1 AND autotask_id = $2 AND superseded_at IS NULL`, [l.autotaskEntity, l.autotaskId]);
        await c.query(`INSERT INTO catalog_offering_link (autotask_entity, autotask_id, offering_id, cadence, method, confidence, note, decided_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [l.autotaskEntity, l.autotaskId, l.offeringId, l.cadence, l.method, l.confidence, l.note, l.decidedBy]);
      }
      return ls.length;
    });
  }
}
