// Load what one reconciliation needs from the stores and Autotask (read-only):
// the vendor invoice's lines and mappings, then — only for the mapped
// companies — their active contracts (with type and dates; which ones are in
// effect for the period is decided by reconcile), contract services and
// service bundles, the services (bundle components included), the unit
// periods covering the invoice month, and the recurring billing items
// (type 6) for that month. Every Autotask read is chunked (≤ 200 ids per
// query) and served from the shadow when it mirrors the entity.

import type { AutotaskService } from '../services/autotask.service.js';
import type { VendorStore } from './store.js';
import type { PolicyStore } from './policy.js';
import type { ReconInput } from './reconcile.js';

const RECURRING_SERVICE = 6; // BillingItems.billingItemType 6 = Recurring Service / Bundle

const num = (v: unknown) => (v == null ? null : Number(v));

export async function loadReconInput(s: AutotaskService, st: { vendor: VendorStore; policy: PolicyStore }, q: { vendor: string; invoiceNumber?: string; documentId?: number }): Promise<{ input: ReconInput; calls: number } | { error: string }> {
  const docs = await st.vendor.listDocuments({ vendor: q.vendor, limit: 200 });
  const doc = q.documentId ? docs.find((d) => d.id === q.documentId) : q.invoiceNumber ? docs.find((d) => d.invoiceNumber === q.invoiceNumber) : docs[0];
  if (!doc) return { error: q.invoiceNumber || q.documentId ? `No imported ${q.vendor} invoice ${q.invoiceNumber ?? q.documentId}.` : `No ${q.vendor} invoice imported yet (autotask_vendor_import_invoice).` };
  const d0 = new Date(`${doc.invoiceDate ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const periodStart = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const periodEnd = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  const yearAgo = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() - 13, 1)).toISOString().slice(0, 10);

  const [lines, customerMappings, offeringMappings, offerings, links, policies, customerExceptions, allLines] = await Promise.all([
    st.vendor.lines({ documentId: doc.id, limit: 20000 }), st.vendor.customerMappings(q.vendor), st.vendor.offeringMappings(q.vendor), st.vendor.offerings(), st.vendor.catalogLinks(), st.policy.policies(), st.policy.exceptions(),
    st.vendor.lines({ vendor: q.vendor, limit: 20000 }),
  ]);
  // Annual-billed subscriptions appear on one invoice a year — remember who had one in the last 13 months.
  const custCompany = new Map(customerMappings.filter((m) => m.status === 'mapped' && m.autotaskCompanyId != null).map((m) => [m.vendorCustomerId, m.autotaskCompanyId!]));
  const offeringOfSku = new Map(offeringMappings.filter((m) => m.status === 'mapped' && m.offeringId != null).map((m) => [m.sku, m.offeringId!]));
  const recentAnnual = [...new Set(allLines.filter((l) => (l.cadence === 'AA' || l.cadence === 'annual') && (l.invoiceDate ?? '') >= yearAgo && l.vendorCustomerId && l.sku && custCompany.has(l.vendorCustomerId) && offeringOfSku.has(l.sku))
    .map((l) => `${custCompany.get(l.vendorCustomerId!)}|${offeringOfSku.get(l.sku!)}`))];

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
  const covering = [{ op: 'lte', field: 'startDate', value: `${periodStart}T00:00:00` }, { op: 'gte', field: 'endDate', value: `${periodStart}T00:00:00` }];
  const inMonth = [{ op: 'eq', field: 'billingItemType', value: RECURRING_SERVICE }, { op: 'gte', field: 'itemDate', value: `${periodStart}T00:00:00` }, { op: 'lte', field: 'itemDate', value: `${periodEnd}T23:59:59` }];
  const billedOf = (b: Record<string, any>) => ({ quantity: Number(b.quantity ?? 0), rate: Number(b.rate ?? 0), extendedPrice: Number(b.extendedPrice ?? 0), ourCost: num(b.ourCost), invoiceID: num(b.invoiceID), itemDate: String(b.itemDate), posted: b.postedDate != null || b.invoiceID != null });

  const companyIds = [...new Set(custCompany.values())];
  const companies = await inChunks<{ id: number; companyName: string; isActive: boolean }>('Companies', 'id', companyIds, [], ['id', 'companyName', 'isActive']);
  const contracts = (await inChunks<Record<string, any>>('Contracts', 'companyID', companyIds, [{ op: 'eq', field: 'status', value: 1 }], ['id', 'companyID', 'contractName', 'status', 'contractType', 'startDate', 'endDate']))
    .map((c) => ({ id: Number(c.id), companyID: Number(c.companyID), contractName: String(c.contractName ?? ''), status: Number(c.status), contractType: num(c.contractType), startDate: c.startDate ?? null, endDate: c.endDate ?? null }));
  const contractIds = contracts.map((c) => c.id);
  const contractServices = (await inChunks<Record<string, any>>('ContractServices', 'contractID', contractIds, [], ['id', 'contractID', 'serviceID', 'unitCost', 'unitPrice', 'invoiceDescription']))
    .map((x) => ({ id: Number(x.id), contractID: Number(x.contractID), serviceID: Number(x.serviceID), unitCost: num(x.unitCost), unitPrice: num(x.unitPrice), invoiceDescription: x.invoiceDescription ?? null }));
  const bundleLines = (await inChunks<Record<string, any>>('ContractServiceBundles', 'contractID', contractIds, [], ['id', 'contractID', 'serviceBundleID', 'unitPrice', 'adjustedPrice', 'invoiceDescription']))
    .map((x) => ({ id: Number(x.id), contractID: Number(x.contractID), serviceBundleID: Number(x.serviceBundleID), unitPrice: num(x.unitPrice), adjustedPrice: num(x.adjustedPrice), invoiceDescription: x.invoiceDescription ?? null }));
  const bundleIds = [...new Set(bundleLines.map((x) => x.serviceBundleID))];
  const bundleRows = await inChunks<Record<string, any>>('ServiceBundles', 'id', bundleIds, [], ['id', 'name', 'periodType', 'unitCost', 'unitPrice']);
  const components = await inChunks<{ serviceBundleID: number; serviceID: number }>('ServiceBundleServices', 'serviceBundleID', bundleIds, [], ['id', 'serviceBundleID', 'serviceID']);
  const bundles = bundleRows.map((b) => ({ id: Number(b.id), name: String(b.name ?? ''), periodType: num(b.periodType), unitCost: num(b.unitCost), unitPrice: num(b.unitPrice), serviceIds: components.filter((c) => Number(c.serviceBundleID) === Number(b.id)).map((c) => Number(c.serviceID)) }));
  const serviceIds = [...new Set([...contractServices.map((x) => x.serviceID), ...bundles.flatMap((b) => b.serviceIds)])];
  const services = (await inChunks<Record<string, any>>('Services', 'id', serviceIds, [], ['id', 'name', 'periodType', 'unitCost', 'unitPrice']))
    .map((x) => ({ id: Number(x.id), name: String(x.name ?? ''), periodType: num(x.periodType), unitCost: num(x.unitCost), unitPrice: num(x.unitPrice) }));
  const csIds = contractServices.map((x) => x.id);
  const units = (await inChunks<Record<string, any>>('ContractServiceUnits', 'contractServiceID', csIds, covering, ['id', 'contractServiceID', 'units', 'price', 'cost', 'startDate', 'endDate']))
    .map((u) => ({ contractServiceID: Number(u.contractServiceID), units: Number(u.units ?? 0), price: num(u.price), cost: num(u.cost), startDate: String(u.startDate), endDate: String(u.endDate) }));
  const billed = (await inChunks<Record<string, any>>('BillingItems', 'contractServiceID', csIds, inMonth, ['id', 'contractServiceID', 'quantity', 'rate', 'extendedPrice', 'ourCost', 'invoiceID', 'itemDate', 'postedDate']))
    .map((b) => ({ contractServiceID: Number(b.contractServiceID), ...billedOf(b) }));
  const cbIds = bundleLines.map((x) => x.id);
  const bundleUnits = (await inChunks<Record<string, any>>('ContractServiceBundleUnits', 'contractServiceBundleID', cbIds, covering, ['id', 'contractServiceBundleID', 'units', 'price', 'cost', 'startDate', 'endDate']))
    .map((u) => ({ contractServiceBundleID: Number(u.contractServiceBundleID), units: Number(u.units ?? 0), price: num(u.price), cost: num(u.cost), startDate: String(u.startDate), endDate: String(u.endDate) }));
  const billedBundles = (await inChunks<Record<string, any>>('BillingItems', 'contractServiceBundleID', cbIds, inMonth, ['id', 'contractServiceBundleID', 'quantity', 'rate', 'extendedPrice', 'ourCost', 'invoiceID', 'itemDate', 'postedDate']))
    .map((b) => ({ contractServiceBundleID: Number(b.contractServiceBundleID), ...billedOf(b) }));
  return {
    calls,
    input: {
      vendor: q.vendor, invoice: { documentId: doc.id, invoiceNumber: doc.invoiceNumber, invoiceDate: doc.invoiceDate, periodStart, periodEnd },
      lines, customerMappings, offeringMappings, offerings, links, services, companies, contracts, contractServices, units, billed,
      bundleLines, bundles, bundleUnits, billedBundles, recentAnnual, policies, customerExceptions,
    },
  };
}
