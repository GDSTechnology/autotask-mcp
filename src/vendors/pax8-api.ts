// Pax8 Partner API adapter (OFF until PAX8_CLIENT_ID + PAX8_CLIENT_SECRET are
// set — Pax8 → Integrations → Credentials → generate an API key). Pulls:
//   invoices  — every invoice item, mapped to the CSV export's columns and fed
//               through the SAME parser, so API and CSV imports are identical
//   pricing   — partner cost + suggested retail price per product, billing
//               term and commitment (→ MM / AM / AA / monthly), plus the
//               manufacturer's own SKU (vendorSku) for the offering
// Endpoints / auth per Pax8's public API docs (client-credentials token,
// paged `content` responses). NOT yet exercised against GDS's account — the
// first sync reports exactly what it received; adjust the field mapping there.

export interface Pax8Config { clientId: string; clientSecret: string; tokenUrl: string; audience: string; apiUrl: string }

export function pax8Config(env: NodeJS.ProcessEnv = process.env): Pax8Config | null {
  if (!env.PAX8_CLIENT_ID || !env.PAX8_CLIENT_SECRET) return null;
  return {
    clientId: env.PAX8_CLIENT_ID, clientSecret: env.PAX8_CLIENT_SECRET,
    tokenUrl: env.PAX8_TOKEN_URL || 'https://login.pax8.com/oauth/token',
    audience: env.PAX8_AUDIENCE || 'api://p8p.client',
    apiUrl: (env.PAX8_API_URL || 'https://api.pax8.com/v1').replace(/\/$/, ''),
  };
}

type Fetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; text(): Promise<string> }>;

export class Pax8Client {
  private token: { value: string; until: number } | null = null;
  calls = 0;
  constructor(private readonly cfg: Pax8Config, private readonly fetchImpl: Fetch = globalThis.fetch as unknown as Fetch) {}

  private async auth(): Promise<string> {
    if (this.token && this.token.until > Date.now() + 60_000) return this.token.value;
    const r = await this.fetchImpl(this.cfg.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, audience: this.cfg.audience, grant_type: 'client_credentials' }) });
    this.calls++;
    // A rejected key is never retried (no repeated failed logins).
    if (!r.ok) throw new Error(`Pax8 token request failed: HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    const j = await r.json();
    this.token = { value: String(j.access_token), until: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }

  async get(path: string, query: Record<string, string | number> = {}): Promise<any> {
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
    const r = await this.fetchImpl(`${this.cfg.apiUrl}${path}${qs ? `?${qs}` : ''}`, { headers: { Authorization: `Bearer ${await this.auth()}`, Accept: 'application/json' } });
    this.calls++;
    if (r.status === 401) { this.token = null; throw new Error('Pax8 API: 401 — the API key was rejected (not retried)'); }
    if (r.status === 429) throw new Error('Pax8 API: 429 — rate limited (not retried)');
    if (!r.ok) throw new Error(`Pax8 API ${path}: HTTP ${r.status} ${(await r.text().catch(() => '')).slice(0, 200)}`);
    return r.json();
  }

  /** Every page of a paged endpoint (`{ content, page: { totalPages } }`), capped. */
  async all(path: string, query: Record<string, string | number> = {}, maxPages = 50): Promise<any[]> {
    const out: any[] = [];
    for (let page = 0; page < maxPages; page++) {
      const j = await this.get(path, { ...query, page, size: 200 });
      const items = Array.isArray(j?.content) ? j.content : Array.isArray(j) ? j : [];
      out.push(...items);
      const total = Number(j?.page?.totalPages ?? 1);
      if (page + 1 >= total || !items.length) break;
    }
    return out;
  }
}

/** A Pax8 API invoice item → the invoice CSV export's columns (the parser is shared). */
export function pax8ItemToCsvRow(it: Record<string, any>, invoice: Record<string, any>): Record<string, string> {
  const s = (v: unknown) => (v == null ? '' : String(v));
  return {
    record_id: s(it.subscriptionId ?? it.recordId ?? it.id), purchase_order_number: s(it.purchaseOrderNumber), type: s(it.type).toLowerCase(),
    company_id: s(it.companyId), company_name: s(it.companyName), arrears_subscription_id: s(it.arrearsSubscriptionId),
    start_period: s(it.startPeriod).slice(0, 10), end_period: s(it.endPeriod).slice(0, 10), quantity: s(it.quantity), unit_of_measure: s(it.unitOfMeasure),
    term: s(it.term), sku: s(it.sku), description: s(it.description), details: s(it.details), rate_type: s(it.rateType), charge_type: s(it.chargeType),
    price: s(it.price), subtotal: s(it.subTotal ?? it.subtotal), cost: s(it.cost), cost_total: s(it.costTotal), offered_by: s(it.offeredBy), billed_by_pax8: s(it.billedByPax8),
    sales_tax: s(it.salesTax), total: s(it.total), billing_fee: s(it.billingFee), currency_code: s(it.currencyCode ?? invoice.currencyCode ?? 'USD'),
    invoice_date: s(invoice.invoiceDate).slice(0, 10), totalDue: '', commitment_term: s(it.commitmentTerm), billing_renewal: s(it.billingRenewal).slice(0, 10),
  };
}

/** A Pax8 product pricing entry → our cadence. */
export function pax8PricingCadence(p: { billingTerm?: string; commitmentTerm?: string; commitmentTermInMonths?: number }): string | null {
  const bill = String(p.billingTerm ?? '').toLowerCase();
  const months = Number(p.commitmentTermInMonths ?? (/1\s*year|annual|12/i.test(String(p.commitmentTerm ?? '')) ? 12 : /month/i.test(String(p.commitmentTerm ?? '')) ? 1 : 0));
  if (months >= 12 && bill.startsWith('month')) return 'AM';
  if (months >= 12 && (bill.startsWith('annual') || bill.startsWith('year'))) return 'AA';
  if (months === 1 && bill.startsWith('month')) return 'MM';
  if (!months && bill.startsWith('month')) return 'monthly';
  if (!months && (bill.startsWith('annual') || bill.startsWith('year'))) return 'annual';
  return null;
}
