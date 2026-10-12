// Read-only Autotask context the contract plan builders share: active
// contracts (type + dates), their service and bundle lines, the lines'
// units the day before an effective date, and what was already invoiced on /
// after it. Chunked (≤ 200 ids per query).

import type { QueryFn } from './contract-io.js';
import { dayBefore } from './contract-io.js';
import type { ContractInfo } from './contract-plan.js';

export interface ContractLine { id: number; contractID: number; serviceID: number; unitCost: number | null; invoiceDescription: string | null }
export interface BundleLine { id: number; contractID: number; serviceBundleID: number; invoiceDescription: string | null }
export interface ContractContext {
  contracts: Map<number, ContractInfo>;
  lines: ContractLine[];
  bundleLines: BundleLine[];
  /** contractId → serviceID → contract service id */
  contractLines: Map<number, Map<number, number>>;
  calls: number;
}

const num = (v: unknown) => (v == null ? null : Number(v));

export async function inChunks<T>(q: QueryFn, entity: string, field: string, ids: number[], extra: Array<{ op: string; field: string; value: unknown }> = [], includeFields?: string[], count?: { calls: number }): Promise<T[]> {
  const out: T[] = [];
  const uniq = [...new Set(ids)];
  for (let i = 0; i < uniq.length; i += 200) {
    if (count) count.calls++;
    out.push(...(await q<T>(entity, [{ op: 'in', field, value: uniq.slice(i, i + 200) }, ...extra], { maxRecords: 5000, ...(includeFields ? { includeFields } : {}) })));
  }
  return out;
}

/** Active contracts of these companies (or these contract ids) with their lines. */
export async function loadContractContext(q: QueryFn, by: { companyIds?: number[]; contractIds?: number[] }): Promise<ContractContext> {
  const count = { calls: 0 };
  const cRows = by.contractIds
    ? await inChunks<Record<string, any>>(q, 'Contracts', 'id', by.contractIds, [{ op: 'eq', field: 'status', value: 1 }], ['id', 'companyID', 'contractName', 'contractType', 'startDate', 'endDate'], count)
    : await inChunks<Record<string, any>>(q, 'Contracts', 'companyID', by.companyIds ?? [], [{ op: 'eq', field: 'status', value: 1 }], ['id', 'companyID', 'contractName', 'contractType', 'startDate', 'endDate'], count);
  const contracts = new Map<number, ContractInfo>(cRows.map((c) => [Number(c.id), { contractName: String(c.contractName ?? ''), companyID: Number(c.companyID), startDate: c.startDate ?? null, endDate: c.endDate ?? null, contractType: num(c.contractType) }]));
  const ids = [...contracts.keys()];
  const lines = (await inChunks<Record<string, any>>(q, 'ContractServices', 'contractID', ids, [], ['id', 'contractID', 'serviceID', 'unitCost', 'invoiceDescription'], count))
    .map((x) => ({ id: Number(x.id), contractID: Number(x.contractID), serviceID: Number(x.serviceID), unitCost: num(x.unitCost), invoiceDescription: x.invoiceDescription ?? null }));
  const bundleLines = (await inChunks<Record<string, any>>(q, 'ContractServiceBundles', 'contractID', ids, [], ['id', 'contractID', 'serviceBundleID', 'invoiceDescription'], count))
    .map((x) => ({ id: Number(x.id), contractID: Number(x.contractID), serviceBundleID: Number(x.serviceBundleID), invoiceDescription: x.invoiceDescription ?? null }));
  const contractLines = new Map<number, Map<number, number>>();
  for (const l of lines) { const m = contractLines.get(l.contractID) ?? new Map<number, number>(); if (!m.has(l.serviceID) || l.id > m.get(l.serviceID)!) m.set(l.serviceID, l.id); contractLines.set(l.contractID, m); }
  return { contracts, lines, bundleLines, contractLines, calls: count.calls };
}

/** Latest billing item date on / after a date, per contract service and per bundle line (an invoiced period can't be changed by a plan). */
export async function lastPostedFrom(q: QueryFn, serviceLineIds: number[], bundleLineIds: number[], fromDate: string): Promise<{ service: Map<number, string>; bundle: Map<number, string> }> {
  const service = new Map<number, string>(), bundle = new Map<number, string>();
  const latest = (m: Map<number, string>, id: number, d: string) => { const cur = m.get(id); if (!cur || d > cur) m.set(id, d); };
  for (const b of await inChunks<{ contractServiceID: number; itemDate: string }>(q, 'BillingItems', 'contractServiceID', serviceLineIds, [{ op: 'eq', field: 'billingItemType', value: 6 }, { op: 'gte', field: 'itemDate', value: `${fromDate}T00:00:00` }], ['id', 'contractServiceID', 'itemDate'])) latest(service, Number(b.contractServiceID), String(b.itemDate));
  for (const b of await inChunks<{ contractServiceBundleID: number; itemDate: string }>(q, 'BillingItems', 'contractServiceBundleID', bundleLineIds, [{ op: 'eq', field: 'billingItemType', value: 6 }, { op: 'gte', field: 'itemDate', value: `${fromDate}T00:00:00` }], ['id', 'contractServiceBundleID', 'itemDate'])) latest(bundle, Number(b.contractServiceBundleID), String(b.itemDate));
  return { service, bundle };
}

/** Units and unit price per contract service the day before a date. */
export async function unitsBefore(q: QueryFn, lineIds: number[], date: string): Promise<Map<number, { units: number; unitPrice: number | null }>> {
  const d = dayBefore(date);
  const out = new Map<number, { units: number; unitPrice: number | null }>();
  for (const u of await inChunks<Record<string, any>>(q, 'ContractServiceUnits', 'contractServiceID', lineIds, [{ op: 'lte', field: 'startDate', value: `${d}T00:00:00` }, { op: 'gte', field: 'endDate', value: `${d}T00:00:00` }], ['id', 'contractServiceID', 'units', 'price'])) {
    const units = Number(u.units ?? 0);
    out.set(Number(u.contractServiceID), { units, unitPrice: units ? Math.round((Number(u.price ?? 0) / units) * 10000) / 10000 : null });
  }
  return out;
}

/** Recurring Service contracts in effect on a date. */
export const inEffect = (c: ContractInfo, date: string) => (c.contractType == null || c.contractType === 7) && (!c.startDate || c.startDate.slice(0, 10) <= date) && (!c.endDate || c.endDate.slice(0, 10) >= date);
