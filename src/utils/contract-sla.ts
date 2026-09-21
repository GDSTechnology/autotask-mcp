// Contract SLA coverage + assignment planning (#102, slices 2 & 3). Pure.
//
// Slice 2 (coverage/readiness): which active contracts have no SLA linked, and
// whether any SLA definitions exist at all. `Contracts.serviceLevelAgreementID`
// is a picklist with ZERO values until SLAs are defined in the UI — that empty
// picklist is the root of the "SLA hole", so the coverage check reports it first.
//
// Slice 3 (assignment planning): once SLAs exist, `serviceLevelAgreementID` IS
// API-writable, so we can bulk-assign the right SLA to each contract. This module
// plans the change (dry-run-first); the service applies it.
//
// Tenant-agnostic: active-status detection is derived from picklist LABELS, and
// valid SLA values come from the live picklist — nothing tenant-specific is baked in.

export interface ContractLite {
  id: number;
  contractName?: string | undefined;
  companyID?: number | undefined;
  contractType?: number | undefined;
  status?: number | undefined;
  endDate?: string | undefined;
  serviceLevelAgreementID?: number | string | null | undefined;
}

export interface PicklistOption { value: string; label: string }

export interface UnlinkedContract {
  id: number;
  name: string | null;
  companyID: number | null;
  contractType: number | null;
  status: number | null;
  endDate: string | null;
}

export type CoverageReadiness = 'no_sla_definitions' | 'unlinked_contracts' | 'all_linked';

export interface SlaCoverageResult {
  slaDefinitionsAvailable: PicklistOption[];
  slaDefinitionsCount: number;
  contractsEvaluated: number;
  linked: number;
  unlinked: number;
  unlinkedContracts: UnlinkedContract[];
  readiness: CoverageReadiness;
  message: string;
  truncated?: boolean | undefined;
}

const hasLink = (v: ContractLite['serviceLevelAgreementID']): boolean =>
  v != null && v !== '' && !(typeof v === 'number' && v === 0) && !(typeof v === 'string' && v.trim() === '0');

/** Classify SLA coverage across a set of contracts. Pure. */
export function classifyContractSlaCoverage(
  contracts: ContractLite[],
  slaValues: PicklistOption[],
): SlaCoverageResult {
  const linkedContracts = contracts.filter((c) => hasLink(c.serviceLevelAgreementID));
  const unlinked = contracts.filter((c) => !hasLink(c.serviceLevelAgreementID));
  const readiness: CoverageReadiness = slaValues.length === 0
    ? 'no_sla_definitions'
    : unlinked.length > 0 ? 'unlinked_contracts' : 'all_linked';
  const message = readiness === 'no_sla_definitions'
    ? `No SLA definitions exist in this tenant yet — Contracts.serviceLevelAgreementID has 0 picklist values. Generate a spec with autotask_generate_sla_framework, create the SLAs in the Autotask UI, then assign them.`
    : readiness === 'unlinked_contracts'
      ? `${unlinked.length} of ${contracts.length} contract(s) have no SLA linked. Assign with autotask_assign_contract_sla (dry-run first).`
      : `All ${contracts.length} contract(s) have an SLA linked.`;
  return {
    slaDefinitionsAvailable: slaValues,
    slaDefinitionsCount: slaValues.length,
    contractsEvaluated: contracts.length,
    linked: linkedContracts.length,
    unlinked: unlinked.length,
    unlinkedContracts: unlinked.map((c) => ({
      id: c.id,
      name: c.contractName ?? null,
      companyID: c.companyID ?? null,
      contractType: c.contractType ?? null,
      status: c.status ?? null,
      endDate: c.endDate ?? null,
    })),
    readiness,
    message,
  };
}

/** Picklist status values whose label reads as "active" — derived, not hardcoded. */
export function activeStatusValues(statusPicklist: PicklistOption[]): Set<number> {
  const out = new Set<number>();
  for (const p of statusPicklist) {
    if (/\bactive\b/i.test(p.label) && !/inactive/i.test(p.label)) {
      const n = Number(p.value);
      if (!Number.isNaN(n)) out.add(n);
    }
  }
  return out;
}

export interface AssignInput { contractID: number; serviceLevelAgreementID: number | string }
export type AssignItemStatus = 'planned' | 'noop' | 'not_found' | 'invalid_sla';
export interface AssignPlanItem {
  contractID: number;
  from: number | string | null;
  to: number | string;
  toLabel: string | null;
  status: AssignItemStatus;
}
export interface AssignPlan {
  items: AssignPlanItem[];
  planned: AssignPlanItem[];
  noop: number[];
  notFound: number[];
  invalidSla: Array<{ contractID: number; serviceLevelAgreementID: number | string }>;
}

const sameValue = (a: unknown, b: unknown): boolean => String(a ?? '') === String(b ?? '');

/** Plan SLA assignments against fetched contracts + the valid SLA picklist. Pure. */
export function planContractSlaAssignment(
  contracts: Map<number, ContractLite>,
  assignments: AssignInput[],
  slaValues: PicklistOption[],
): AssignPlan {
  const validByValue = new Map(slaValues.map((v) => [String(v.value), v]));
  const items: AssignPlanItem[] = [];
  for (const a of assignments) {
    const to = a.serviceLevelAgreementID;
    const c = contracts.get(a.contractID);
    const opt = validByValue.get(String(to));
    if (!opt) {
      items.push({ contractID: a.contractID, from: null, to, toLabel: null, status: 'invalid_sla' });
      continue;
    }
    if (!c) {
      items.push({ contractID: a.contractID, from: null, to, toLabel: opt.label, status: 'not_found' });
      continue;
    }
    const from = c.serviceLevelAgreementID ?? null;
    const status: AssignItemStatus = sameValue(from, to) ? 'noop' : 'planned';
    items.push({ contractID: a.contractID, from, to, toLabel: opt.label, status });
  }
  return {
    items,
    planned: items.filter((i) => i.status === 'planned'),
    noop: items.filter((i) => i.status === 'noop').map((i) => i.contractID),
    notFound: items.filter((i) => i.status === 'not_found').map((i) => i.contractID),
    invalidSla: items.filter((i) => i.status === 'invalid_sla').map((i) => ({ contractID: i.contractID, serviceLevelAgreementID: i.to })),
  };
}
