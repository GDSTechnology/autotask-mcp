// Tools: vendor price reference, catalog standardization plans, and the generic
// change-plan review / execute path. Building and reviewing never write to
// Autotask; only autotask_change_plan_execute does — approved rows only,
// FINANCIAL (confirm:true), re-reading every target before writing.

import type { Pool } from 'pg';
import type { AutotaskService } from '../services/autotask.service.js';
import type { CallerContext } from '../types/context.js';
import { VendorStore } from './store.js';
import { PriceStore, perOf, pricesFromInvoices } from './prices.js';
import { buildStandardizePlan, type AutotaskServiceRow } from './catalog-standard.js';
import { PlanStore, parseRows, type Plan } from '../change-plans/store.js';
import { executePlan, type EntityIO } from '../change-plans/execute.js';

type Result = { result: unknown; message: string };
type H = (a: Record<string, any>, ctx: CallerContext) => Promise<Result>;
const who = (ctx: CallerContext) => ctx.trustedActingUserEmail ?? ctx.requestingUserEmail ?? (ctx.source !== 'unknown' ? ctx.source : null);
const unavailable: Result = { result: { status: 'unavailable' }, message: 'Needs the Postgres store (MCP_PG_ENABLED=true and migrations 0010 + 0011).' };
const CADENCES = ['MM', 'AM', 'AA', 'monthly', 'annual'];

/** A plan as chat shows it: numbered rows, what each does, and whether it can be approved. */
export function planView(p: Plan, opts: { rows?: 'all' | 'actionable' } = {}): Record<string, unknown> {
  const rows = p.rows.filter((r) => opts.rows !== 'actionable' || (!r.blocked && r.action !== 'info'));
  const counts: Record<string, number> = {};
  for (const r of p.rows) counts[r.blocked ? 'blocked' : r.status] = (counts[r.blocked ? 'blocked' : r.status] ?? 0) + 1;
  return {
    planId: p.id, hash: p.hash, kind: p.kind, title: p.title, status: p.status, createdBy: p.createdBy, createdAt: p.createdAt, counts,
    rows: rows.map((r) => ({ row: r.rowNo, action: r.action, label: r.label, before: r.before, after: r.after, reason: r.reason, ...(r.blocked ? { blocked: r.blocked } : {}), status: r.status, ...(r.approvedBy ? { approvedBy: r.approvedBy } : {}), ...(r.result ? { result: r.result } : {}) })),
  };
}

export function catalogToolHandlers(s: AutotaskService, getPool: () => Pool | null): Array<[string, H]> {
  const stores = () => { const p = getPool(); return p ? { vendor: new VendorStore(p), prices: new PriceStore(p), plans: new PlanStore(p) } : null; };

  const io = async (): Promise<EntityIO> => {
    const http = await s.httpClient();
    return {
      get: (entity, id) => http.get<Record<string, unknown>>(entity, id) as Promise<Record<string, unknown> | null>,
      update: async (entity, id, fields) => { await http.update(entity, id, fields); },
      create: (entity, fields) => http.create(entity, fields),
      findExisting: async (entity, fields) => {
        if (entity !== 'Services' || typeof fields.name !== 'string') return null;
        const hit = await http.query<{ id: number }>('Services', [{ op: 'eq', field: 'name', value: fields.name }], { maxRecords: 2, includeFields: ['id'], noCache: true });
        return hit[0]?.id ?? null;
      },
    };
  };

  return [
    ['autotask_vendor_prices', async (a, ctx) => {
      const st = stores(); if (!st) return unavailable;
      const vendor = String(a.vendor ?? 'pax8');
      const action = String(a.action ?? 'list');
      if (action === 'refresh') {
        const ps = await pricesFromInvoices(st.vendor, vendor);
        const n = await st.prices.upsert(ps.map((p) => ({ ...p, by: who(ctx) })));
        return { result: { recorded: n }, message: `Recorded ${n} price point(s) from ${vendor} invoices (cost + suggested price per SKU and term).` };
      }
      if (action === 'set') {
        const items = Array.isArray(a.items) ? a.items : [];
        const bad = items.filter((i: any) => !i.sku || !CADENCES.includes(i.cadence) || (i.unitCost == null && i.suggestedPrice == null));
        if (!items.length || bad.length) return { result: { status: 'invalid_value', bad }, message: `items: [{ sku, cadence: ${CADENCES.join('|')}, unitCost, suggestedPrice, effectiveDate? }] — MM/AM/monthly per month, AA/annual per year.` };
        const n = await st.prices.upsert(items.map((i: any) => ({ vendor, sku: String(i.sku), cadence: String(i.cadence), unitCost: i.unitCost != null ? Number(i.unitCost) : null, suggestedPrice: i.suggestedPrice != null ? Number(i.suggestedPrice) : null, per: perOf(String(i.cadence)), source: String(i.source ?? 'price_list'), effectiveDate: String(i.effectiveDate ?? new Date().toISOString().slice(0, 10)), by: who(ctx) })));
        return { result: { recorded: n }, message: `Recorded ${n} ${vendor} price point(s).` };
      }
      const cur = await st.prices.current(vendor);
      return { result: cur, message: `${cur.length} current ${vendor} price point(s) (per SKU and term).` };
    }],

    ['autotask_catalog_plan_standardize', async (a, ctx) => {
      const st = stores(); if (!st) return unavailable;
      const vendor = String(a.vendor ?? 'pax8');
      const http = await s.httpClient();
      const [offerings, offeringMappings, links, prices, lines] = await Promise.all([st.vendor.offerings(), st.vendor.offeringMappings(vendor), st.vendor.catalogLinks(), st.prices.current(vendor), st.vendor.lines({ vendor, limit: 20000 })]);
      if (!offerings.length) return { result: { status: 'no_offerings' }, message: 'No offerings yet — map vendor SKUs first (autotask_reconcile_resolve_mapping kind=offerings).' };
      const soldSkus = new Map<string, { cadences: Set<string>; chargeClasses: Set<string> }>();
      for (const l of lines) { if (!l.sku) continue; const e = soldSkus.get(l.sku) ?? { cadences: new Set<string>(), chargeClasses: new Set<string>() }; e.cadences.add(l.cadence); e.chargeClasses.add(l.chargeClass); soldSkus.set(l.sku, e); }
      const services = await http.query<AutotaskServiceRow>('Services', [{ op: 'gte', field: 'id', value: 0 }], { maxRecords: 2000, includeFields: ['id', 'name', 'description', 'invoiceDescription', 'periodType', 'unitCost', 'unitPrice', 'isActive', 'billingCodeID', 'manufacturerServiceProvider'], noCache: true });
      const activeContracts = new Set((await http.query<{ id: number }>('Contracts', [{ op: 'eq', field: 'status', value: 1 }], { maxRecords: 10000, includeFields: ['id'] })).map((c) => c.id));
      const cs = await http.query<{ contractID: number; serviceID: number }>('ContractServices', [{ op: 'gte', field: 'id', value: 0 }], { maxRecords: 20000, includeFields: ['id', 'contractID', 'serviceID'] });
      const activeUses = new Map<number, number>();
      for (const x of cs) if (activeContracts.has(x.contractID)) activeUses.set(x.serviceID, (activeUses.get(x.serviceID) ?? 0) + 1);
      const r = buildStandardizePlan({ vendor, offerings, offeringMappings, soldSkus, links, services, activeUses, prices, ...(Array.isArray(a.offeringIds) && a.offeringIds.length ? { offeringIds: a.offeringIds.map(Number) } : {}) });
      if (!r.rows.length) return { result: { summary: r.summary }, message: 'The catalog already matches the standard — nothing to change.' };
      const plan = await st.plans.create({ kind: 'catalog_standardize', title: `Standardize Autotask services (${vendor}: ${r.summary.products} product(s))`, params: { vendor, summary: r.summary }, rows: r.rows, by: who(ctx) });
      const sm = r.summary;
      return {
        result: { ...planView(plan), summary: sm },
        message: `Plan ${plan.id} (hash ${plan.hash}): ${sm.products} product(s) — rename ${sm.rename}, catalog reprice ${sm.reprice}, create ${sm.create}${sm.blocked ? ` (${sm.blocked} blocked: missing price / work type)` : ''}, deactivate ${sm.deactivate} unused duplicate(s), ${sm.inUseDuplicates} in-use duplicate(s) kept, ${sm.unknownTerm} service(s) with an unstated term. Nothing written. Review the rows, then approve: autotask_change_plan_review action=approve planId hash rows="1-12" (or "all").`,
      };
    }],

    ['autotask_change_plan_review', async (a, ctx) => {
      const st = stores(); if (!st) return unavailable;
      const action = String(a.action ?? (a.planId ? 'get' : 'list'));
      if (action === 'list') { const l = await st.plans.list(Number(a.limit) || 20); return { result: l, message: `${l.length} plan(s).` }; }
      const plan = a.planId ? await st.plans.get(String(a.planId)) : null;
      if (!plan) return { result: { status: 'not_found' }, message: `No plan ${a.planId ?? ''}.` };
      if (action === 'get') return { result: planView(plan, { rows: a.actionableOnly === true ? 'actionable' : 'all' }), message: `${plan.title}: ${plan.rows.length} row(s), status ${plan.status}.` };
      if (action === 'approve' || action === 'exclude') {
        const rows = parseRows(a.rows, plan.rows.length);
        if (!rows || !rows.length) return { result: { status: 'invalid_value', field: 'rows' }, message: 'rows: "all", "3-15", "1,4,7-9" or an array of row numbers.' };
        if (!a.hash) return { result: { status: 'invalid_value', field: 'hash' }, message: `Pass the plan hash you reviewed (${plan.hash}).` };
        const r = await st.plans.setApproval(plan.id, String(a.hash), rows, action === 'approve', who(ctx));
        return { result: r, message: `${action === 'approve' ? 'Approved' : 'Excluded'} ${r.changed.length} row(s)${r.refused.length ? `; ${r.refused.length} not changeable (${r.refused.slice(0, 5).map((x) => `${x.row}: ${x.why}`).join('; ')})` : ''}. Nothing is written until autotask_change_plan_execute.` };
      }
      return { result: { status: 'invalid_value' }, message: 'action: list | get | approve | exclude.' };
    }],

    ['autotask_change_plan_execute', async (a, ctx) => {
      const st = stores(); if (!st) return unavailable;
      const plan = a.planId ? await st.plans.get(String(a.planId)) : null;
      if (!plan) return { result: { status: 'not_found' }, message: `No plan ${a.planId ?? ''}.` };
      if (plan.status !== 'open' && plan.status !== 'executing') return { result: { status: plan.status }, message: `Plan is ${plan.status} — build a new plan.` };
      if (!plan.rows.some((r) => r.status === 'approved')) return { result: { status: 'nothing_approved' }, message: 'No approved rows — approve rows first (autotask_change_plan_review action=approve).' };
      const by = who(ctx);
      const rep = await executePlan(st.plans, plan, await io(), {
        maxRows: Number(a.maxRows) || 25,
        onApplied: async (row, id) => {
          const m = row.meta as { offeringId?: number; term?: string } | null;
          if (plan.kind === 'catalog_standardize' && id != null && m?.offeringId && row.action !== 'deactivate') {
            await st.vendor.setCatalogLinks([{ autotaskEntity: 'Services', autotaskId: id, offeringId: m.offeringId, cadence: m.term ?? '', method: 'standardized', confidence: 'confirmed', note: `plan ${plan.id} row ${row.rowNo}`, decidedBy: by }]);
          }
        },
      });
      const left = (await st.plans.get(plan.id))!.rows.filter((r) => r.status === 'approved').length;
      return { result: rep, message: `Executed ${rep.attempted} row(s): ${rep.applied} applied and verified, ${rep.skipped} already as planned, ${rep.stale} stale (changed since the plan — rebuild), ${rep.failed} failed${rep.stoppedBy ? ` — STOPPED: ${rep.stoppedBy}` : ''}.${left ? ` ${left} approved row(s) left — call again.` : ''}` };
    }],
  ];
}
