// Price policy (requirements §5): "Cost should be" = landed vendor unit cost
// for the same term and unit; "Price should be" = the GDS target under policy,
// with where it came from. Separate from the CURRENT contract values and from
// what was actually BILLED. A negotiated customer price is honoured, never
// flagged as "below target" every month.

import type { Pool } from 'pg';

export type PolicyMode = 'vendor_suggested' | 'margin' | 'markup';
export interface PricingPolicy { scope: string; mode: PolicyMode; pct: number | null; marginFloor: number | null; feePolicy: 'overhead' | 'allocate'; note: string | null; decidedBy: string | null; decidedAt: string }
export interface CustomerPriceException { autotaskCompanyId: number; offeringId: number; cadence: string; agreedUnitPrice: number; reason: string; expiresOn: string | null; decidedBy: string | null }

/** The built-in default until GDS sets one: the vendor's suggested price, never below cost. */
export const DEFAULT_POLICY: PricingPolicy = { scope: '*', mode: 'vendor_suggested', pct: null, marginFloor: 0, feePolicy: 'overhead', note: 'built-in default', decidedBy: null, decidedAt: '1970-01-01T00:00:00.000Z' };

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** The most specific policy: offering, then manufacturer, then '*'. */
export function policyFor(policies: PricingPolicy[], offeringId: number | null, manufacturer: string | null): PricingPolicy {
  return policies.find((p) => offeringId != null && p.scope === `offering:${offeringId}`)
    ?? policies.find((p) => manufacturer != null && p.scope.toLowerCase() === manufacturer.toLowerCase())
    ?? policies.find((p) => p.scope === '*')
    ?? DEFAULT_POLICY;
}

/** Target price per unit (same basis as the cost) and how it was derived. */
export function priceShouldBe(cost: number | null, vendorSuggested: number | null, p: PricingPolicy, negotiated: CustomerPriceException | null): { price: number | null; rule: string } {
  if (negotiated && (!negotiated.expiresOn || negotiated.expiresOn >= new Date().toISOString().slice(0, 10))) return { price: negotiated.agreedUnitPrice, rule: `negotiated: ${negotiated.reason}` };
  if (cost == null) return { price: vendorSuggested, rule: 'vendor suggested (no cost known)' };
  let price: number | null; let rule: string;
  if (p.mode === 'margin' && p.pct != null && p.pct < 1) { price = cost / (1 - p.pct); rule = `${Math.round(p.pct * 100)}% margin (${p.scope})`; }
  else if (p.mode === 'markup' && p.pct != null) { price = cost * (1 + p.pct); rule = `${Math.round(p.pct * 100)}% markup (${p.scope})`; }
  else if (p.pct && vendorSuggested != null) { price = vendorSuggested * (1 + p.pct); rule = `vendor suggested + ${Math.round(p.pct * 1000) / 10}% (${p.scope})`; }
  else { price = vendorSuggested; rule = `vendor suggested (${p.scope})`; }
  const floor = p.marginFloor != null && p.marginFloor < 1 ? cost / (1 - p.marginFloor) : cost;
  if (price == null || price < floor) { price = floor; rule += p.marginFloor ? ` → raised to the ${Math.round(p.marginFloor * 100)}% margin floor` : ' → raised to cost (suggested price is below cost)'; }
  return { price: customerPrice(price), rule };
}

/**
 * A price a customer sees: whole cents, rounded UP so a floor is never undercut ($11.7333 → $11.74).
 * Sub-dollar unit prices (per-GB storage, $0.252) keep 4 decimals, also rounded up.
 */
export function customerPrice(p: number): number {
  const step = p >= 1 ? 100 : 10000;
  return Math.ceil(p * step - 1e-6) / step;
}

/** Landed cost: the vendor unit cost, plus an allocated share of vendor fees when the policy says so. */
export function landedCost(unitCost: number | null, feeRate: number, p: PricingPolicy): number | null {
  if (unitCost == null) return null;
  return r6(p.feePolicy === 'allocate' ? unitCost * (1 + feeRate) : unitCost);
}

export class PolicyStore {
  constructor(private readonly pool: Pool) {}
  async policies(): Promise<PricingPolicy[]> {
    const r = await this.pool.query('SELECT * FROM pricing_policy WHERE superseded_at IS NULL ORDER BY scope');
    return r.rows.map((x) => ({ scope: x.scope, mode: x.mode, pct: x.pct == null ? null : Number(x.pct), marginFloor: x.margin_floor == null ? null : Number(x.margin_floor), feePolicy: x.fee_policy, note: x.note, decidedBy: x.decided_by, decidedAt: new Date(x.decided_at).toISOString() }));
  }
  async setPolicy(p: Omit<PricingPolicy, 'decidedAt'>): Promise<void> {
    await this.pool.query('UPDATE pricing_policy SET superseded_at = now() WHERE scope = $1 AND superseded_at IS NULL', [p.scope]);
    await this.pool.query('INSERT INTO pricing_policy (scope, mode, pct, margin_floor, fee_policy, note, decided_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [p.scope, p.mode, p.pct, p.marginFloor, p.feePolicy, p.note, p.decidedBy]);
  }
  async exceptions(): Promise<CustomerPriceException[]> {
    const r = await this.pool.query('SELECT * FROM customer_pricing_exception WHERE superseded_at IS NULL');
    return r.rows.map((x) => ({ autotaskCompanyId: Number(x.autotask_company_id), offeringId: Number(x.offering_id), cadence: x.cadence, agreedUnitPrice: Number(x.agreed_unit_price), reason: x.reason, expiresOn: x.expires_on ? new Date(x.expires_on).toISOString().slice(0, 10) : null, decidedBy: x.decided_by }));
  }
  async setException(e: CustomerPriceException | { autotaskCompanyId: number; offeringId: number; cadence: string; remove: true; decidedBy: string | null }): Promise<void> {
    await this.pool.query('UPDATE customer_pricing_exception SET superseded_at = now() WHERE autotask_company_id = $1 AND offering_id = $2 AND cadence = $3 AND superseded_at IS NULL', [e.autotaskCompanyId, e.offeringId, e.cadence]);
    if ('remove' in e) return;
    await this.pool.query('INSERT INTO customer_pricing_exception (autotask_company_id, offering_id, cadence, agreed_unit_price, reason, expires_on, decided_by) VALUES ($1,$2,$3,$4,$5,$6,$7)', [e.autotaskCompanyId, e.offeringId, e.cadence, e.agreedUnitPrice, e.reason, e.expiresOn, e.decidedBy]);
  }
}
