// Load what one reconciliation needs from the stores and Autotask (read-only):
// the vendor invoice's lines and mappings, then — only for the mapped
// companies — their active contracts, contract services, the services, the
// unit period covering the invoice month, and the recurring-service billing
// items (type 6) posted for that month. Every Autotask read is chunked
// (≤ 200 ids per query) and served from the shadow when it mirrors the entity.

import type { AutotaskService } from '../services/autotask.service.js';
import type { VendorStore } from './store.js';
import type { PolicyStore } from './policy.js';
import type { ReconInput } from './reconcile.js';

const RECURRING_SERVICE = 6; // BillingItems.billingItemType 6 = Recurring Service / Bundle

export async function loadReconInput(s: AutotaskService, st: { vendor: VendorStore; policy: PolicyStore }, q: { vendor: string; invoiceNumber?: string; documentId?: number }): Promise<{ input: ReconInput; calls: number } | { error: string }> {
  const docs = await st.vendor.listDocuments({ vendor: q.vendor, limit: 200 });
  const doc = q.documentId ? docs.find((d) => d.id === q.documentId) : q.invoiceNumber ? docs.find((d) => d.invoiceNumber === q.invoiceNumber) : docs[0];
  if (!doc) return { error: q.invoiceNumber || q.documentId ? `No imported ${q.vendor} invoice ${q.invoiceNumber ?? q.documentId}.` : `No ${q.vendor} invoice imported yet (autotask_vendor_import_invoice).` };
  const d0 = new Date(`${doc.invoiceDate ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const periodStart = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const periodEnd = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);

  const [lines, customerMappings, offeringMappings, offerings, links, policies, customerExceptions] = await Promise.all([
    st.vendor.lines({ documentId: doc.id, limit: 20000 }), st.vendor.customerMappings(q.vendor), st.vendor.offeringMappings(q.vendor), st.vendor.offerings(), st.vendor.catalogLinks(), st.policy.policies(), st.policy.exceptions(),
  ]);
  const http = await s.httpClient();
  let calls = 0;
  const inChunks = async <T>(entity: string, field: string, ids: number[], extra: Array<Record<string, unknown>> = [], includeFields?: string[]): Promise<T[]> => {
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      calls++;
      out.push(...(await http.query<T>(entity, [{ op: 'in', field, value: ids.slice(i, i + 200) }, ...extra] as never, { maxRecords: 5000, ...(includeFields ? { includeFields } : {}) })));
    }
    return out;
  };
  const companyIds = [...new Set(customerMappings.filter((m) => m.status === 'mapped' && m.autotaskCompanyId != null).map((m) => m.autotaskCompanyId!))];
  const companies = await inChunks<{ id: number; companyName: string; isActive: boolean }>('Companies', 'id', companyIds, [], ['id', 'companyName', 'isActive']);
  const contracts = (await inChunks<Record<string, any>>('Contracts', 'companyID', companyIds, [{ op: 'eq', field: 'status', value: 1 }], ['id', 'companyID', 'contractName', 'status', 'startDate', 'endDate']))
    .map((c) => ({ id: Number(c.id), companyID: Number(c.companyID), contractName: String(c.contractName ?? ''), status: Number(c.status), startDate: c.startDate ?? null, endDate: c.endDate ?? null }));
  const contractServices = (await inChunks<Record<string, any>>('ContractServices', 'contractID', contracts.map((c) => c.id), [], ['id', 'contractID', 'serviceID', 'unitCost', 'unitPrice', 'invoiceDescription']))
    .map((x) => ({ id: Number(x.id), contractID: Number(x.contractID), serviceID: Number(x.serviceID), unitCost: x.unitCost == null ? null : Number(x.unitCost), unitPrice: x.unitPrice == null ? null : Number(x.unitPrice), invoiceDescription: x.invoiceDescription ?? null }));
  const serviceIds = [...new Set(contractServices.map((x) => x.serviceID))];
  const services = (await inChunks<Record<string, any>>('Services', 'id', serviceIds, [], ['id', 'name', 'periodType', 'unitCost', 'unitPrice']))
    .map((x) => ({ id: Number(x.id), name: String(x.name ?? ''), periodType: x.periodType == null ? null : Number(x.periodType), unitCost: x.unitCost == null ? null : Number(x.unitCost), unitPrice: x.unitPrice == null ? null : Number(x.unitPrice) }));
  const csIds = contractServices.map((x) => x.id);
  const units = (await inChunks<Record<string, any>>('ContractServiceUnits', 'contractServiceID', csIds, [{ op: 'lte', field: 'startDate', value: `${periodStart}T00:00:00` }, { op: 'gte', field: 'endDate', value: `${periodStart}T00:00:00` }], ['id', 'contractServiceID', 'units', 'price', 'cost', 'startDate', 'endDate']))
    .map((u) => ({ contractServiceID: Number(u.contractServiceID), units: Number(u.units ?? 0), price: u.price == null ? null : Number(u.price), cost: u.cost == null ? null : Number(u.cost), startDate: String(u.startDate), endDate: String(u.endDate) }));
  const billed = (await inChunks<Record<string, any>>('BillingItems', 'contractServiceID', csIds, [{ op: 'eq', field: 'billingItemType', value: RECURRING_SERVICE }, { op: 'gte', field: 'itemDate', value: `${periodStart}T00:00:00` }, { op: 'lte', field: 'itemDate', value: `${periodEnd}T23:59:59` }], ['id', 'contractServiceID', 'quantity', 'rate', 'extendedPrice', 'ourCost', 'invoiceID', 'itemDate', 'postedDate']))
    .map((b) => ({ contractServiceID: Number(b.contractServiceID), quantity: Number(b.quantity ?? 0), rate: Number(b.rate ?? 0), extendedPrice: Number(b.extendedPrice ?? 0), ourCost: b.ourCost == null ? null : Number(b.ourCost), invoiceID: b.invoiceID == null ? null : Number(b.invoiceID), itemDate: String(b.itemDate), posted: b.postedDate != null || b.invoiceID != null }));
  return {
    calls,
    input: {
      vendor: q.vendor, invoice: { documentId: doc.id, invoiceNumber: doc.invoiceNumber, invoiceDate: doc.invoiceDate, periodStart, periodEnd },
      lines, customerMappings, offeringMappings, offerings, links, services, companies, contracts, contractServices, units, billed, policies, customerExceptions,
    },
  };
}
