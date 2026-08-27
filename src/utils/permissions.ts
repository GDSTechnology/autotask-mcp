// Permission gating (Expansion Spec §4.2, issue #15).
//
// Effective permission = intersection of (a) the caller's functional role and
// (c) the tool's risk class. GDS/Hermes policy (b) layers on later. Reads are open
// to everyone; mutations are gated by a role→max-risk policy and denied before
// dispatch with a clear reason.
//
// DISABLED BY DEFAULT. Gating only runs when `MCP_PERMISSIONS_ENABLED=true`, so
// the live server keeps its current behavior until roles are mapped. Roles come
// from `AUTOTASK_ROLE_MAP` (config first; PG identity later) keyed by email /
// Teams object id / Autotask resource id; an unmapped caller falls back to
// `AUTOTASK_DEFAULT_ROLE` if set, else mutations are denied (fail-closed).

import { CallerContext } from '../types/context';
import { RiskLevel } from './risk';

export type FunctionalRole =
  | 'staff'
  | 'dispatcher'
  | 'project-manager'
  | 'sales'
  | 'finance'
  | 'executive'
  | 'administrator';

const VALID_ROLES: readonly FunctionalRole[] = [
  'staff',
  'dispatcher',
  'project-manager',
  'sales',
  'finance',
  'executive',
  'administrator',
];

// Risk severity ladder. A role may perform any mutation at or below its ceiling.
const RISK_RANK: Record<RiskLevel, number> = {
  'read-only': 0,
  'reversible-update': 1,
  'external-communication': 2,
  'financial': 3,
  'inventory-movement': 4,
  'destructive': 5,
};

// Highest-risk mutation each role may perform. Conservative v1 — adjust as GDS
// policy firms up. Destructive stays administrator-only; financial opens up at
// sales/finance; inventory at executive.
const ROLE_MAX_RISK: Record<FunctionalRole, RiskLevel> = {
  staff: 'reversible-update',
  dispatcher: 'reversible-update',
  'project-manager': 'reversible-update',
  sales: 'financial',
  finance: 'financial',
  executive: 'inventory-movement',
  administrator: 'destructive',
};

export function isPermissionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.MCP_PERMISSIONS_ENABLED).toLowerCase() === 'true';
}

function normalizeRole(raw: string | undefined): FunctionalRole | undefined {
  if (!raw) return undefined;
  const r = raw.trim().toLowerCase().replace(/[_\s]+/g, '-');
  return VALID_ROLES.includes(r as FunctionalRole) ? (r as FunctionalRole) : undefined;
}

/**
 * Parse `AUTOTASK_ROLE_MAP` — `key=role` pairs separated by `;` or newlines, where
 * key is an email, Teams object id, or resource id. Keys are lowercased; invalid
 * roles are skipped.
 */
export function parseRoleMap(raw: string | undefined): Map<string, FunctionalRole> {
  const map = new Map<string, FunctionalRole>();
  if (!raw) return map;
  for (const pair of raw.split(/[;\n]+/)) {
    const idx = pair.indexOf('=');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim().toLowerCase();
    const role = normalizeRole(pair.slice(idx + 1));
    if (key && role) map.set(key, role);
  }
  return map;
}

/** Candidate lookup keys for a caller, most specific first. */
export function roleMapKeys(ctx: CallerContext): string[] {
  const keys: string[] = [];
  if (ctx.requestingUserEmail) keys.push(ctx.requestingUserEmail.toLowerCase());
  if (ctx.teamsObjectId) keys.push(ctx.teamsObjectId.toLowerCase());
  if (ctx.autotaskResourceId !== undefined) keys.push(String(ctx.autotaskResourceId));
  return keys;
}

/** Resolve the caller's role from the map, or the configured default. */
export function resolveRole(
  ctx: CallerContext,
  roleMap: Map<string, FunctionalRole>,
  env: NodeJS.ProcessEnv = process.env
): FunctionalRole | undefined {
  for (const key of roleMapKeys(ctx)) {
    const role = roleMap.get(key);
    if (role) return role;
  }
  return normalizeRole(env.AUTOTASK_DEFAULT_ROLE);
}

export interface PermissionDecision {
  allowed: boolean;
  role?: FunctionalRole;
  reason?: string;
}

/**
 * Decide whether `role` may invoke a tool of the given risk. Reads (read-only) are
 * always allowed. An unmapped caller may read but not mutate.
 */
export function evaluatePermission(role: FunctionalRole | undefined, risk: RiskLevel): PermissionDecision {
  if (risk === 'read-only') return { allowed: true, ...(role ? { role } : {}) };
  if (!role) {
    return {
      allowed: false,
      reason:
        'No functional role is assigned to the requesting user, so mutations are not permitted. Map the user in AUTOTASK_ROLE_MAP (or set AUTOTASK_DEFAULT_ROLE).',
    };
  }
  if (RISK_RANK[risk] <= RISK_RANK[ROLE_MAX_RISK[role]]) {
    return { allowed: true, role };
  }
  return {
    allowed: false,
    role,
    reason: `Role '${role}' is not permitted to perform a '${risk}' action. This requires a higher-privilege role.`,
  };
}

export interface PermissionDenied {
  status: 'permission_denied';
  tool: string;
  riskLevel: RiskLevel;
  role?: FunctionalRole;
  message: string;
}

export function buildPermissionDenied(
  toolName: string,
  risk: RiskLevel,
  decision: PermissionDecision
): PermissionDenied {
  return {
    status: 'permission_denied',
    tool: toolName,
    riskLevel: risk,
    ...(decision.role ? { role: decision.role } : {}),
    message: decision.reason ?? `Not permitted to invoke ${toolName}.`,
  };
}
