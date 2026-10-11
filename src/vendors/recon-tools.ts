// Tools: reconcile a vendor invoice against customer contracts, work the
// exceptions, set pricing policy, export the workbook, build contract pricing
// change plans, and check for sync drift. Everything here is read-only toward
// Autotask except the plans' execution (autotask_change_plan_execute).

import type { Pool } from 'pg';
import type { AutotaskService } from '../services/autotask.service.js';
import type { CallerContext } from '../types/context.js';
import { VendorStore } from './store.js';
import { PolicyStore, type PolicyMode } from './policy.js';
import { ReconStore } from './recon-store.js';
import { loadReconInput } from './recon-data.js';
import { reconcile, type ReconRow } from './reconcile.js';
import { buildWorkbook } from './workbook.js';
import { buildContractPlan, type ChangeKind } from './contract-plan.js';
import { DriftStore, checkDrift } from './drift.js';
import { createEntityIO, planView } from './catalog-tools.js';
import { PlanStore } from '../change-plans/store.js';
import { notify } from '../services/notifier.js';

type Result = { result: unknown; message: string };
type H = (a: Record<string, any>, ctx: CallerContext) => Promise<Result>;
const who = (ctx: CallerContext) => ctx.trustedActingUserEmail ?? ctx.requestingUserEmail ?? (ctx.source !== 'unknown' ? ctx.source : null);
const unavailable: Result = { result: { status: 'unavailable' }, message: 'Needs the Postgres store (MCP_PG_ENABLED=true and migrations 0010–0012).' };
const money = (n: unknown) => (typeof n === 'number' ? `$${n.toFixed(2)}` : '—');

/** The compact row chat shows: the required columns, then why. */
export function chatRow(r: ReconRow, state?: { status: string; owner: string | null }): Record<string, unknown> {
  return {
    row: r.rowNo, severity: r.severity, exceptions: r.exceptions, customer: r.customerName, contract: r.autotaskContract, vendor: r.vendor, sku: r.serviceSku, offering: r.offering, term: r.cadence,
    unit: r.unit, quantity: r.quantity, contractQuantity: r.contractQuantity, costShouldBe: r.costShouldBe, priceShouldBe: r.priceShouldBe, currentCost: r.currentCost, currentPrice: r.currentPrice,
    differenceOnCost: r.differenceOnCost, differenceOnPrice: r.differenceOnPrice, per: r.basis, billedRate: r.billedRate, billingPosted: r.billingPosted, monthlyExposure: r.monthlyExposure,
    confidence: r.confidence, reason: r.reason, proposedAction: r.proposedAction, exceptionKey: r.exceptionKey, ...(state ? { status: state.status, owner: state.owner } : {}),
  };
}

export function reconToolHandlers(s: AutotaskService, getPool: () => Pool | null): Array<[string, H]> {
  const stores = () => { const p = getPool(); return p ? { vendor: new VendorStore(p), policy: new PolicyStore(p), recon: new ReconStore(p), plans: new PlanStore(p), drift: new DriftStore(p) } : null; };
  const runOf = async (st: NonNullable<ReturnType<typeof stores>>, a: Record<string, any>) => (a.runId ? st.recon.getRun(String(a.runId)) : st.recon.latestRun(a.vendor ? String(a.vendor) : undefined));

  return [
    ['autotask_reconcile_vendor_to_autotask', async (a, ctx) => {
      const st = stores(); if (!st) return unavailable;
      const vendor = String(a.vendor ?? 'pax8');
      const loaded = await loadReconInput(s, st, { vendor, ...(a.invoiceNumber ? { invoiceNumber: String(a.invoiceNumber) } : {}), ...(a.documentId ? { documentId: Number(a.documentId) } : {}) });
      if ('error' in loaded) return { result: { status: 'not_found' }, message: loaded.error };
      const { rows, summary } = reconcile(loaded.input);
      const inv = loaded.input.invoice;
      const runId = await st.recon.saveRun({ vendor, documentId: inv.documentId, invoiceNumber: inv.invoiceNumber, periodStart: inv.periodStart, periodEnd: inv.periodEnd, params: { autotaskCalls: loaded.calls }, summary, rows, by: who(ctx) });
      const sm = summary as Record<string, number>;
      if (sm.critical) notify({ type: 'reconcile.critical', severity: 'warning', title: `${vendor} reconciliation: ${sm.critical} critical exception(s)`, detail: `Invoice ${inv.invoiceNumber ?? inv.documentId} (${inv.periodStart} – ${inv.periodEnd}): monthly exposure ${money(sm.monthlyExposure)}; ${sm.belowCost} below landed cost (${sm.belowCostConfirmed} confirmed by a posted invoice), ${sm.notBilled} vendor charge(s) not billed back, ${sm.qtyShort} short on quantity.`, fields: { run: runId }, dedupeKey: `reconcile.critical:${inv.documentId}` });
      const limit = Math.min(Math.max(Number(a.limit) || 50, 1), 500);
      const top = rows.filter((r) => a.includeOk === true || (r.severity !== 'ok' && r.severity !== 'info')).slice(0, limit);
      return {
        result: { runId, invoice: inv, summary, rows: top.map((r) => chatRow(r)), totalRows: rows.length, autotaskCalls: loaded.calls },
        message: `Run ${runId} — ${vendor} ${inv.invoiceNumber ?? ''} (${inv.periodStart} – ${inv.periodEnd}): ${sm.critical} critical, ${sm.high} high, ${sm.review} review, ${sm.ok} matching. Monthly exposure ${money(sm.monthlyExposure)} (critical ${money(sm.monthlyExposureCritical)}). ${sm.belowCost} below landed cost (${sm.belowCostConfirmed} confirmed by a posted invoice), ${sm.notBilled} not billed back, ${sm.qtyShort} short on quantity. Nothing was changed. Next: autotask_reconcile_get_exceptions, autotask_reconcile_export_workbook, autotask_pricing_build_change_plan.`,
      };
    }],

    ['autotask_reconcile_get_exceptions', async (a, ctx) => {
      const st = stores(); if (!st) return unavailable;
      const action = String(a.action ?? 'list');
      if (action === 'update') {
        const keys = Array.isArray(a.keys) ? a.keys.map(String) : [];
        if (!keys.length) return { result: { status: 'invalid_value', field: 'keys' }, message: 'keys: the exceptionKey of each row to update.' };
        if (a.status && !['open', 'acknowledged', 'resolved', 'accepted'].includes(String(a.status))) return { result: { status: 'invalid_value', field: 'status' }, message: 'status: open | acknowledged | resolved | accepted (accepted = an expected variance).' };
        const n = await st.recon.updateState(keys, { ...(a.status ? { status: a.status } : {}), ...(a.owner !== undefined ? { owner: a.owner === null ? null : String(a.owner) } : {}), ...(a.note ? { note: String(a.note) } : {}), by: who(ctx) });
        return { result: { updated: n }, message: `Updated ${n} exception(s); the change is added to each one's history.` };
      }
      const run = await runOf(st, a);
      if (!run) return { result: { status: 'not_found' }, message: 'No reconciliation run yet — autotask_reconcile_vendor_to_autotask.' };
      let rows = await st.recon.rows(run.id);
      const sev = Array.isArray(a.severity) && a.severity.length ? a.severity.map(String) : ['critical', 'high', 'review'];
      rows = rows.filter((r) => sev.includes(r.severity));
      if (a.customer) rows = rows.filter((r) => String(r.customerName ?? '').toLowerCase().includes(String(a.customer).toLowerCase()));
      if (a.exceptionType) rows = rows.filter((r) => r.exceptions.includes(String(a.exceptionType)));
      if (a.sku) rows = rows.filter((r) => r.serviceSku === String(a.sku));
      if (a.minExposure != null) rows = rows.filter((r) => (r.monthlyExposure ?? 0) >= Number(a.minExposure));
      const states = await st.recon.states(rows.map((r) => r.exceptionKey));
      const withState = rows.map((r) => ({ r, s: states.get(r.exceptionKey) ?? { status: 'open', owner: null, history: [] } }));
      const filtered = a.status ? withState.filter((x) => x.s.status === String(a.status)) : withState;
      const limit = Math.min(Math.max(Number(a.limit) || 100, 1), 1000);
      return {
        result: { runId: run.id, invoice: run.invoiceNumber, period: `${run.periodStart} – ${run.periodEnd}`, total: filtered.length, rows: filtered.slice(0, limit).map((x) => ({ ...chatRow(x.r, x.s), history: a.includeHistory === true ? (x.s as { history?: unknown }).history : undefined })) },
        message: `${filtered.length} exception(s) in run ${run.id} (${run.invoiceNumber ?? ''}), monthly exposure ${money(filtered.reduce((t, x) => t + (x.r.monthlyExposure ?? 0), 0))}.`,
      };
    }],

    ['autotask_vendor_pricing_policy', async (a, ctx) => {
      const st = stores(); if (!st) return unavailable;
      const action = String(a.action ?? 'list');
      if (action === 'set') {
        const mode = String(a.mode ?? 'vendor_suggested') as PolicyMode;
        if (!['vendor_suggested', 'margin', 'markup'].includes(mode)) return { result: { status: 'invalid_value', field: 'mode' }, message: 'mode: vendor_suggested | margin | markup.' };
        const pct = a.pct == null ? null : Number(a.pct) > 1 ? Number(a.pct) / 100 : Number(a.pct);
        const floor = a.marginFloor == null ? null : Number(a.marginFloor) > 1 ? Number(a.marginFloor) / 100 : Number(a.marginFloor);
        if ((mode !== 'vendor_suggested' && (pct == null || !Number.isFinite(pct))) || (floor != null && (floor < 0 || floor >= 1))) return { result: { status: 'invalid_value' }, message: 'pct is required for margin / markup (e.g. 20 or 0.2); marginFloor must be 0–<1.' };
        const fee = String(a.feePolicy ?? 'overhead');
        if (!['overhead', 'allocate'].includes(fee)) return { result: { status: 'invalid_value', field: 'feePolicy' }, message: 'feePolicy: overhead | allocate.' };
        await st.policy.setPolicy({ scope: String(a.scope ?? '*'), mode, pct, marginFloor: floor, feePolicy: fee as 'overhead' | 'allocate', note: a.note ? String(a.note) : null, decidedBy: who(ctx) });
        return { result: { saved: true }, message: `Pricing policy for ${a.scope ?? '*'} saved (${mode}${pct != null ? ` ${Math.round(pct * 100)}%` : ''}${floor != null ? `, floor ${Math.round(floor * 100)}%` : ''}, fees ${fee}). It applies from the next reconciliation run.` };
      }
      if (action === 'set_negotiated' || action === 'remove_negotiated') {
        const company = Number(a.companyId), offering = Number(a.offeringId);
        if (!Number.isInteger(company) || !Number.isInteger(offering)) return { result: { status: 'invalid_value' }, message: 'companyId and offeringId are required.' };
        if (action === 'remove_negotiated') { await st.policy.setException({ autotaskCompanyId: company, offeringId: offering, cadence: String(a.cadence ?? ''), remove: true, decidedBy: who(ctx) }); return { result: { removed: true }, message: 'Negotiated price removed.' }; }
        if (a.price == null || !a.reason) return { result: { status: 'invalid_value' }, message: 'price and reason are required (expiresOn optional).' };
        await st.policy.setException({ autotaskCompanyId: company, offeringId: offering, cadence: String(a.cadence ?? ''), agreedUnitPrice: Number(a.price), reason: String(a.reason), expiresOn: a.expiresOn ? String(a.expiresOn) : null, decidedBy: who(ctx) });
        return { result: { saved: true }, message: 'Negotiated price saved — it is honoured as the target, not flagged as below target.' };
      }
      const [policies, exceptions] = await Promise.all([st.policy.policies(), st.policy.exceptions()]);
      return { result: { policies, negotiated: exceptions, default: 'vendor suggested price, never below cost; fees as overhead' }, message: `${policies.length} policy rule(s), ${exceptions.length} negotiated customer price(s).` };
    }],

    ['autotask_reconcile_export_workbook', async (a) => {
      const st = stores(); if (!st) return unavailable;
      const run = await runOf(st, a);
      if (!run) return { result: { status: 'not_found' }, message: 'No reconciliation run yet.' };
      const rows = await st.recon.rows(run.id);
      const [states, lines, policies, exceptions, planList] = await Promise.all([st.recon.states(rows.map((r) => r.exceptionKey)), run.documentId ? st.vendor.lines({ documentId: run.documentId, limit: 20000 }) : Promise.resolve([]), st.policy.policies(), st.policy.exceptions(), st.plans.list(20)]);
      const plans = (await Promise.all(planList.filter((p) => p.kind === 'contract_pricing' || p.kind === 'catalog_standardize').slice(0, 10).map((p) => st.plans.get(p.id)))).filter((p): p is NonNullable<typeof p> => !!p);
      const buf = await buildWorkbook({ run, rows, states, lines, policies, customerExceptions: exceptions, plans });
      const fileName = `GDS_${run.vendor}_Autotask_Reconciliation_${run.invoiceNumber ?? run.periodStart}.xlsx`;
      return { result: { fileName, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', bytes: buf.length, contentBase64: buf.toString('base64') }, message: `${fileName} (${Math.round(buf.length / 1024)} KB): Executive Summary, Exceptions, All Vendor Lines, Customer Contracts, Unmatched Internal NFR, Approved Changes, Execution Audit, Pricing Policy. contentBase64 holds the file.` };
    }],

    ['autotask_pricing_build_change_plan', async (a, ctx) => {
      const st = stores(); if (!st) return unavailable;
      const run = await runOf(st, a);
      if (!run) return { result: { status: 'not_found' }, message: 'No reconciliation run yet — autotask_reconcile_vendor_to_autotask.' };
      const rows = await st.recon.rows(run.id);
      const include = (Array.isArray(a.include) && a.include.length ? a.include.map(String) : ['cost', 'price', 'quantity', 'missing_line']).filter((k: string): k is ChangeKind => ['cost', 'price', 'quantity', 'missing_line'].includes(k));
      const now = new Date();
      const effectiveDate = a.effectiveDate ? String(a.effectiveDate).slice(0, 10) : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) return { result: { status: 'invalid_value', field: 'effectiveDate' }, message: 'effectiveDate: YYYY-MM-DD.' };
      const http = await s.httpClient();
      const companyIds = [...new Set(rows.map((r) => r.autotaskCompanyId).filter((x): x is number => x != null))];
      const contracts = new Map<number, { contractName: string; companyID: number; startDate: string | null; endDate: string | null }>();
      const licence = new Map<number, number[]>();
      const csRows: Array<{ id: number; contractID: number; serviceID: number }> = [];
      for (let k = 0; k < companyIds.length; k += 200) {
        const cs = await http.query<Record<string, any>>('Contracts', [{ op: 'in', field: 'companyID', value: companyIds.slice(k, k + 200) }, { op: 'eq', field: 'status', value: 1 }], { maxRecords: 5000, includeFields: ['id', 'companyID', 'contractName', 'startDate', 'endDate'] });
        for (const c of cs) contracts.set(Number(c.id), { contractName: String(c.contractName ?? ''), companyID: Number(c.companyID), startDate: c.startDate ?? null, endDate: c.endDate ?? null });
      }
      const contractIds = [...contracts.keys()];
      for (let k = 0; k < contractIds.length; k += 200) csRows.push(...(await http.query<{ id: number; contractID: number; serviceID: number }>('ContractServices', [{ op: 'in', field: 'contractID', value: contractIds.slice(k, k + 200) }], { maxRecords: 5000, includeFields: ['id', 'contractID', 'serviceID'] })));
      const [links, offerings] = await Promise.all([st.vendor.catalogLinks(), st.vendor.offerings()]);
      const offeringOfService = new Map(links.filter((l) => l.autotaskEntity === 'Services').map((l) => [l.autotaskId, l.offeringId]));
      const manufacturerOf = new Map(offerings.map((o) => [o.id, o.manufacturer]));
      // Licence contracts: the customer's active contracts already holding a service of the same manufacturer.
      for (const r of rows.filter((x) => x.exceptions.includes('not_billed') && x.autotaskCompanyId != null && x.offeringId != null)) {
        const mfr = manufacturerOf.get(r.offeringId!);
        const ids = [...new Set(csRows.filter((c) => contracts.get(c.contractID)?.companyID === r.autotaskCompanyId && manufacturerOf.get(offeringOfService.get(c.serviceID) ?? -1) === mfr).map((c) => c.contractID))];
        licence.set(r.autotaskCompanyId!, ids);
      }
      // Already invoiced at/after the effective date?
      const lastPosted = new Map<number, string>();
      const csIds = [...new Set(rows.map((r) => r.contractServiceId).filter((x): x is number => x != null))];
      for (let k = 0; k < csIds.length; k += 200) {
        const bi = await http.query<{ contractServiceID: number; itemDate: string }>('BillingItems', [{ op: 'in', field: 'contractServiceID', value: csIds.slice(k, k + 200) }, { op: 'eq', field: 'billingItemType', value: 6 }, { op: 'gte', field: 'itemDate', value: `${effectiveDate}T00:00:00` }], { maxRecords: 5000, includeFields: ['id', 'contractServiceID', 'itemDate'] });
        for (const b of bi) { const cur = lastPosted.get(b.contractServiceID); if (!cur || b.itemDate > cur) lastPosted.set(b.contractServiceID, b.itemDate); }
      }
      const standard = (offeringId: number, cadence: string) => links.filter((l) => l.autotaskEntity === 'Services' && l.offeringId === offeringId && (l.cadence === cadence || (cadence === 'monthly' && l.cadence === 'MM'))).sort((x, y) => Number(y.method === 'standardized') - Number(x.method === 'standardized'))[0]?.autotaskId ?? null;
      const rowNos = Array.isArray(a.rows) ? a.rows.map(Number) : undefined;
      const plan = buildContractPlan({ rows, include, effectiveDate, contracts, lastPostedThrough: lastPosted, licenceContracts: licence, standardService: standard, ...(rowNos ? { rowNos } : {}), ...(a.contractChoices && typeof a.contractChoices === 'object' ? { contractChoices: a.contractChoices } : {}) });
      if (!plan.rows.length) return { result: { summary: plan.summary }, message: 'Nothing to change for the selected rows.' };
      const saved = await st.plans.create({ kind: 'contract_pricing', title: `Contract pricing from ${run.vendor} ${run.invoiceNumber ?? ''} (effective ${effectiveDate})`, params: { runId: run.id, include, effectiveDate, summary: plan.summary }, rows: plan.rows, by: who(ctx) });
      const sm = plan.summary;
      return { result: { ...planView(saved), summary: sm }, message: `Plan ${saved.id} (hash ${saved.hash}), effective ${effectiveDate}: ${sm.cost} cost update(s), ${sm.price} customer price change(s), ${sm.quantity} quantity change(s), ${sm.missing_line} missing line(s)${sm.blocked ? `; ${sm.blocked} blocked` : ''}. Nothing written — customer prices change only for rows a person approves (autotask_change_plan_review action=approve), then autotask_change_plan_execute.` };
    }],

    ['autotask_reconcile_check_sync_drift', async (a) => {
      const st = stores(); if (!st) return unavailable;
      const days = Math.min(Math.max(Number(a.days) || 120, 1), 730);
      const since = Date.now() - days * 86_400_000;
      const list = (await st.plans.list(200)).filter((p) => Date.parse(p.createdAt) >= since && (p.kind === 'contract_pricing' || p.kind === 'catalog_standardize'));
      const plans = (await Promise.all(list.map((p) => st.plans.get(p.id)))).filter((p): p is NonNullable<typeof p> => !!p);
      const io = await createEntityIO(s);
      const { checked, findings } = await checkDrift(plans, { get: io.get, unitsOn: io.unitsOn });
      const fresh = await st.drift.record(findings);
      for (const f of fresh) notify({ type: 'sync.drift', severity: 'critical', title: `Approved change overwritten: ${f.label.slice(0, 120)}`, detail: `${f.entity} ${f.targetId ?? ''} ${f.field} is ${String(f.current)} but plan ${f.planId} row ${f.row} set it to ${String(f.approved)}. Not re-applied automatically — decide which system owns this field.`, fields: { plan: f.planId, row: String(f.row) }, dedupeKey: `sync.drift:${f.planId}:${f.row}:${f.field}:${String(f.current)}` });
      return { result: { checked, drift: findings, newSinceLastCheck: fresh.length }, message: `${checked} applied change(s) checked: ${findings.length} drifted (${fresh.length} new). ${findings.length ? 'Nothing is re-applied automatically — decide which system owns each field.' : ''}` };
    }],
  ];
}
