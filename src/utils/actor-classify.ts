// Who made a change: a person, or automation? (MCP-001, 2026-10-09)
//
// Ticket history and the audit ledger name an Autotask resource as the actor,
// but a resource is not necessarily a person: integrations (RMM, security
// tools) run as API users, the MCP itself writes as its own API user (n8n /
// Nexus / ChatGPT changes), and resource 4 is Autotask's system account.
// Anything that learns "how technicians work" (Hermes) must only learn from
// verified people — and automated changes (including Nexus's, which have been
// caught wrong) are never ground truth.
//
// Rules, first match wins, each with its provenance:
//   registry (console setting, operator truth) → system resource 4 → this MCP's
//   API user → licenseType "API User" → name/email that looks like automation
//   (unknown until confirmed in the registry) → licensed user (human).
//   No resource record → unknown. Unknown is never silently treated as human.
// Separately, "reference" technicians (console setting) are people whose work
// is the trusted standard to learn from.

export type ActorType = 'human' | 'service_account' | 'integration' | 'system' | 'unknown';
export type ClassificationSource =
  | 'no-actor' | 'registry' | 'system-resource' | 'mcp-api-user' | 'license-api-user'
  | 'name-suggests-automation' | 'licensed-user' | 'not-found';

export interface ActorRecord { id: number; firstName?: string | null; lastName?: string | null; email?: string | null; isActive?: boolean | null; licenseType?: number | null }
export interface RegistryEntry { type: ActorType; label: string | null }

export interface ActorInfo {
  resourceId: number | null;
  displayName: string | null;
  actorType: ActorType;
  classificationSource: ClassificationSource;
  /** A reference technician: their work is the trusted standard. */
  reference: boolean;
  isActive: boolean | null;
}

export interface ClassifyContext {
  resources: Map<number, ActorRecord>;
  mcpApiUserId: number | null;
  /** licenseType value meaning "API User" (7 on standard tenants). */
  apiLicenseValue: number | null;
  registry: Map<number, RegistryEntry>;
  reference: Map<number, string | null>;
}

export const SYSTEM_RESOURCE_ID = 4;
export const ACTOR_TYPES: ActorType[] = ['human', 'service_account', 'integration', 'system', 'unknown'];

/** Names/emails that suggest an account is automation, not a person (kept conservative). */
const AUTOMATION_HINT = /\b(api|apiuser|integration|service|svc|bot|robot|automation|automated|noreply|no-reply|donotreply|system|rmm|datto|kaseya|ninja|connectwise|blackpoint|huntress|sentinel|nexus|n8n|monitor|alert|sync|webhook)\b/i;

const nameOf = (r: ActorRecord | undefined): string | null => {
  if (!r) return null;
  const n = `${r.firstName ?? ''} ${r.lastName ?? ''}`.trim();
  return n || r.email || null;
};

export function classifyActor(resourceID: unknown, ctx: ClassifyContext): ActorInfo {
  if (resourceID === null || resourceID === undefined || resourceID === '') {
    return { resourceId: null, displayName: null, actorType: 'unknown', classificationSource: 'no-actor', reference: false, isActive: null };
  }
  const id = Number(resourceID);
  const rec = ctx.resources.get(id);
  const reference = ctx.reference.has(id);
  const base = { resourceId: id, displayName: nameOf(rec) ?? ctx.registry.get(id)?.label ?? ctx.reference.get(id) ?? null, reference, isActive: rec?.isActive ?? null };

  const reg = ctx.registry.get(id);
  if (reg) return { ...base, displayName: base.displayName ?? reg.label, actorType: reg.type, classificationSource: 'registry' };
  // A reference technician is a person by definition (operator-declared).
  if (reference) return { ...base, actorType: 'human', classificationSource: 'registry' };
  if (id === SYSTEM_RESOURCE_ID) return { ...base, displayName: base.displayName ?? 'Autotask Administrator (system)', actorType: 'system', classificationSource: 'system-resource' };
  if (ctx.mcpApiUserId != null && id === ctx.mcpApiUserId) return { ...base, actorType: 'service_account', classificationSource: 'mcp-api-user' };
  if (!rec) return { ...base, actorType: 'unknown', classificationSource: 'not-found' };
  if (ctx.apiLicenseValue != null && Number(rec.licenseType) === ctx.apiLicenseValue) return { ...base, actorType: 'integration', classificationSource: 'license-api-user' };
  if (AUTOMATION_HINT.test(`${rec.firstName ?? ''} ${rec.lastName ?? ''} ${rec.email ?? ''}`.replace(/[._@-]/g, ' '))) {
    return { ...base, actorType: 'unknown', classificationSource: 'name-suggests-automation' };
  }
  return { ...base, actorType: 'human', classificationSource: 'licensed-user' };
}

/** Parse the console's actor registry lines: "123=integration" or "123=integration:Datto RMM". */
export function parseRegistry(lines: string[]): Map<number, RegistryEntry> {
  const m = new Map<number, RegistryEntry>();
  for (const l of lines) {
    const [idPart, rest] = [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()];
    const id = Number(idPart);
    if (!Number.isInteger(id) || id <= 0) continue;
    const i = rest.indexOf(':');
    const type = (i < 0 ? rest : rest.slice(0, i)).trim().toLowerCase() as ActorType;
    if (!ACTOR_TYPES.includes(type)) continue;
    m.set(id, { type, label: i < 0 ? null : rest.slice(i + 1).trim() || null });
  }
  return m;
}

/** Parse the reference-technician lines: "123" or "123=Name". */
export function parseReference(lines: string[]): Map<number, string | null> {
  const m = new Map<number, string | null>();
  for (const l of lines) {
    const i = l.indexOf('=');
    const id = Number((i < 0 ? l : l.slice(0, i)).trim());
    if (Number.isInteger(id) && id > 0) m.set(id, i < 0 ? null : l.slice(i + 1).trim() || null);
  }
  return m;
}

/** Validation for the two settings (used by the console's settings registry). */
export function registryLineProblem(l: string): string | null {
  const i = l.indexOf('=');
  if (i < 1) return `"${l}" must look like resourceId=type or resourceId=type:label`;
  if (!/^\d+$/.test(l.slice(0, i).trim())) return `"${l}": the resource id must be a number`;
  const rest = l.slice(i + 1).trim();
  const type = (rest.includes(':') ? rest.slice(0, rest.indexOf(':')) : rest).trim().toLowerCase();
  if (!ACTOR_TYPES.includes(type as ActorType)) return `"${l}": type must be one of ${ACTOR_TYPES.join(', ')}`;
  return null;
}
export function referenceLineProblem(l: string): string | null {
  const id = (l.includes('=') ? l.slice(0, l.indexOf('=')) : l).trim();
  return /^\d+$/.test(id) ? null : `"${l}" must look like resourceId or resourceId=name`;
}
