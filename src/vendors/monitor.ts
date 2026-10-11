// Vendor monitoring (requirements §11 "a monitoring job detects stale imports,
// renewals, … and overwritten approved changes"). One pass:
//   stale import     no invoice from a vendor for over 35 days
//   renewals         subscriptions on the latest invoice renewing within 30 days (AM / AA / annual)
//   contract ending  a contract matched in the latest run ends within 45 days (plans
//                    can't change a contract past its end — renew it first)
//   sync drift       an applied plan change that no longer holds
// Each finding is a notification with a dedupe key, so a daily run repeats
// nothing that is already known. Reads only (Autotask: contracts + drift).
// Runs on demand (autotask_vendor_monitor) and, when MCP_VENDOR_MONITOR_HOUR_UTC
// is set, once a day at that hour.

import type { Pool } from 'pg';
import type { AutotaskService } from '../services/autotask.service.js';
import { notify as defaultNotify, type NotifyEvent } from '../services/notifier.js';
import { VendorStore } from './store.js';
import { ReconStore } from './recon-store.js';
import { DriftStore, checkDrift, type DriftFinding } from './drift.js';
import { PlanStore, type Plan } from '../change-plans/store.js';
import { createEntityIO } from './catalog-tools.js';
import { inChunks } from './contract-context.js';
import type { Logger } from '../utils/logger.js';

export const STALE_IMPORT_DAYS = 35, RENEWAL_DAYS = 30, CONTRACT_END_DAYS = 45;
export const PLAN_KINDS_WITH_WRITES = ['catalog_standardize', 'contract_pricing', 'contract_moves', 'contract_wording', 'revert'];

const addDays = (d: string, n: number) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export interface MonitorReport {
  at: string; staleImports: Array<{ vendor: string; latestInvoice: string | null; days: number | null }>;
  renewals: Array<{ vendor: string; customer: string | null; description: string; quantity: number | null; renewalDate: string }>;
  contractsEnding: Array<{ contractId: number; contractName: string; customer: string | null; endDate: string; days: number }>;
  drift: { checked: number; findings: DriftFinding[]; new: number } | null; events: number;
}

/** Plans whose applied rows should still hold (the drift check's input). */
export async function plansToCheck(plans: PlanStore, days: number): Promise<Plan[]> {
  const since = Date.now() - days * 86_400_000;
  const list = (await plans.list(200)).filter((p) => Date.parse(p.createdAt) >= since && PLAN_KINDS_WITH_WRITES.includes(p.kind));
  return (await Promise.all(list.map((p) => plans.get(p.id)))).filter((p): p is Plan => !!p);
}

export async function runVendorMonitor(s: AutotaskService, pool: Pool, o: { now?: Date; notify?: (e: NotifyEvent) => void; drift?: boolean } = {}): Promise<MonitorReport> {
  const send = o.notify ?? defaultNotify;
  const today = (o.now ?? new Date()).toISOString().slice(0, 10);
  const vendor = new VendorStore(pool), recon = new ReconStore(pool), plans = new PlanStore(pool), driftStore = new DriftStore(pool);
  const rep: MonitorReport = { at: new Date().toISOString(), staleImports: [], renewals: [], contractsEnding: [], drift: null, events: 0 };
  const emit = (e: NotifyEvent) => { rep.events++; send(e); };

  const docs = await vendor.listDocuments({ limit: 200 });
  const latestByVendor = new Map<string, (typeof docs)[number]>();
  for (const d of docs) { const cur = latestByVendor.get(d.vendor); if (!cur || (d.invoiceDate ?? '') > (cur.invoiceDate ?? '')) latestByVendor.set(d.vendor, d); }

  for (const [v, d] of latestByVendor) {
    const days = d.invoiceDate ? daysBetween(d.invoiceDate, today) : null;
    if (days == null || days > STALE_IMPORT_DAYS) {
      rep.staleImports.push({ vendor: v, latestInvoice: d.invoiceDate, days });
      emit({ type: 'vendor.import_stale', severity: 'warning', title: `No ${v} invoice imported for ${days ?? '?'} days`, detail: `The latest ${v} invoice is ${d.invoiceNumber ?? d.id} (${d.invoiceDate ?? 'no date'}). Import the newest one (autotask_vendor_import_invoice, or autotask_vendor_sync what=invoices) and reconcile it.`, fields: { vendor: v }, dedupeKey: `vendor.import_stale:${v}:${d.invoiceDate ?? d.id}` });
    }
    const lines = await vendor.lines({ documentId: d.id, limit: 20000 });
    const soon = lines.filter((l) => l.renewalDate && l.renewalDate >= today && l.renewalDate <= addDays(today, RENEWAL_DAYS) && ['AM', 'AA', 'annual'].includes(l.cadence) && l.chargeClass === 'recurring');
    for (const l of soon) rep.renewals.push({ vendor: v, customer: l.vendorCustomerName, description: l.description, quantity: l.quantity, renewalDate: l.renewalDate! });
    if (soon.length) {
      const top = rep.renewals.filter((r) => r.vendor === v).sort((a, b) => a.renewalDate.localeCompare(b.renewalDate)).slice(0, 10);
      emit({ type: 'vendor.renewal', severity: 'info', title: `${soon.length} ${v} subscription(s) renew within ${RENEWAL_DAYS} days`, detail: top.map((r) => `${r.renewalDate} — ${r.customer ?? '?'}: ${r.description} × ${r.quantity ?? '?'}`).join('\n') + (soon.length > top.length ? `\n… and ${soon.length - top.length} more` : '') + '\nAnnual commitments can only be reduced at renewal — confirm seat counts with the customer now.', fields: { vendor: v }, dedupeKey: `vendor.renewal:${v}:${today}` });
    }
  }

  const io = await createEntityIO(s);
  // Contracts matched in the latest run of each vendor, ending soon.
  const contractIds = new Set<number>(); const customerOf = new Map<number, string | null>();
  for (const v of latestByVendor.keys()) {
    const run = await recon.latestRun(v); if (!run) continue;
    for (const r of await recon.rows(run.id)) if (r.contractId != null) { contractIds.add(r.contractId); customerOf.set(r.contractId, r.customerName); }
  }
  if (contractIds.size) {
    const cs = await inChunks<{ id: number; contractName: string; endDate: string | null }>(io.query, 'Contracts', 'id', [...contractIds], [{ op: 'eq', field: 'status', value: 1 }], ['id', 'contractName', 'endDate']);
    for (const c of cs) {
      const end = c.endDate ? String(c.endDate).slice(0, 10) : null;
      if (!end || end < today || end > addDays(today, CONTRACT_END_DAYS)) continue;
      const days = daysBetween(today, end);
      rep.contractsEnding.push({ contractId: Number(c.id), contractName: String(c.contractName), customer: customerOf.get(Number(c.id)) ?? null, endDate: end, days });
      emit({ type: 'vendor.contract_ending', severity: 'warning', title: `${customerOf.get(Number(c.id)) ?? 'Contract'}: "${c.contractName}" ends in ${days} days`, detail: `Contract ${c.id} ends ${end} and bills vendor products. Renew it before then — price, quantity and move plans are blocked past a contract's end, and the vendor keeps charging.`, fields: { contract: String(c.id) }, dedupeKey: `vendor.contract_ending:${c.id}:${end}` });
    }
  }

  if (o.drift !== false) {
    const { checked, findings } = await checkDrift(await plansToCheck(plans, 120), { get: io.get, unitsOn: io.unitsOn }, today);
    const fresh = await driftStore.record(findings);
    for (const f of fresh) emit(driftEvent(f));
    rep.drift = { checked, findings, new: fresh.length };
  }
  return rep;
}

export function driftEvent(f: DriftFinding): NotifyEvent {
  return { type: 'sync.drift', severity: 'critical', title: `Approved change overwritten: ${f.label.slice(0, 120)}`, detail: `${f.entity} ${f.targetId ?? ''} ${f.field} is ${String(f.current)} but plan ${f.planId} row ${f.row} set it to ${String(f.approved)}. Not re-applied automatically — decide which system owns this field.`, fields: { plan: f.planId, row: String(f.row) }, dedupeKey: `sync.drift:${f.planId}:${f.row}:${f.field}:${String(f.current)}` };
}

/** Daily at MCP_VENDOR_MONITOR_HOUR_UTC (0–23); off when unset. Returns a stop function. */
export function startVendorMonitor(s: AutotaskService, getPool: () => Pool | null, logger: Logger, env: NodeJS.ProcessEnv = process.env): () => void {
  const raw = env.MCP_VENDOR_MONITOR_HOUR_UTC;
  const hour = raw == null || raw === '' ? NaN : Number(raw);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return () => undefined;
  let lastDay = '';
  const tick = async () => {
    const now = new Date();
    const d = now.toISOString().slice(0, 10);
    if (now.getUTCHours() !== hour || lastDay === d) return;
    const pool = getPool(); if (!pool) return;
    lastDay = d;
    try { const r = await runVendorMonitor(s, pool, { now }); logger.info(`Vendor monitor: ${r.events} notification(s); ${r.staleImports.length} stale import(s), ${r.renewals.length} renewal(s), ${r.contractsEnding.length} contract(s) ending, ${r.drift?.findings.length ?? 0} drift`); }
    catch (e) { logger.warn('Vendor monitor failed (continuing)', e); }
  };
  const t = setInterval(() => { void tick(); }, 5 * 60_000);
  t.unref?.();
  logger.info(`Vendor monitor: daily at ${hour}:00 UTC`);
  return () => clearInterval(t);
}
