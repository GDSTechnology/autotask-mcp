// Read-only ticket audit helpers (PR A of the ticket-audit tools): ticket
// number normalisation, picklist/UDF labelling, TicketHistory parsing and
// actor attribution, and the email-context summary. Pure, so the rules that
// decide "who changed what" are unit-tested directly.

import type { FieldInfo } from '../services/picklist.cache';

/** "t20261005.0123" / "20261005.0123" / " T20261005.0123 " → "T20261005.0123"; anything else → null. */
export function normalizeTicketNumber(input: unknown): string | null {
  const s = String(input ?? '').trim().toUpperCase();
  const m = s.match(/^T?(\d{8}\.\d{4})$/);
  return m ? `T${m[1]}` : null;
}

/** Labels for every picklist field set on a record: { status: 'In Progress', queueID: 'Service Desk', … }. */
export function picklistLabels(record: Record<string, unknown>, fields: FieldInfo[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fields) {
    if (!f.isPickList || !f.picklistValues?.length) continue;
    const v = record[f.name];
    if (v === null || v === undefined || v === '') continue;
    const hit = f.picklistValues.find((p) => String(p.value) === String(v));
    if (hit) out[f.name] = hit.label;
  }
  return out;
}

export interface UdfOut { name: string; value: unknown; label?: string }

/** UDF values with the list label resolved for list (picklist) UDFs. Empty values are dropped. */
export function labelUdfs(udfs: unknown, defs: Array<{ name: string; isPickList?: boolean; picklistValues?: Array<{ value: unknown; label: string }> }>): UdfOut[] {
  if (!Array.isArray(udfs)) return [];
  const byName = new Map(defs.map((d) => [d.name, d]));
  const out: UdfOut[] = [];
  for (const u of udfs as Array<{ name?: string; value?: unknown }>) {
    if (!u?.name || u.value === null || u.value === undefined || u.value === '') continue;
    const def = byName.get(u.name);
    const hit = def?.isPickList ? def.picklistValues?.find((p) => String(p.value) === String(u.value)) : undefined;
    out.push({ name: u.name, value: u.value, ...(hit ? { label: hit.label } : {}) });
  }
  return out;
}

/** History actions that only move a timestamp — hidden by default (counted, not dropped silently). */
export const NOISE_HISTORY_ACTIONS = new Set(['Last Activity Date Changed', 'Last Tracked Modification Date Changed']);

/** Autotask's built-in system account (workflow rules, triage rules, notifications). */
export const SYSTEM_RESOURCE_ID = 4;

export type ActorKind = 'system' | 'mcp-api-user' | 'resource' | 'unknown';

export function actorKind(resourceID: unknown, mcpApiUserId: number | null): ActorKind {
  if (resourceID === null || resourceID === undefined || resourceID === '') return 'unknown';
  const id = Number(resourceID);
  if (id === SYSTEM_RESOURCE_ID) return 'system';
  if (mcpApiUserId != null && id === mcpApiUserId) return 'mcp-api-user';
  return 'resource';
}

export interface ParsedChange { field: string; from: string | null; to: string | null; ambiguous: boolean }

const blankToNull = (s: string): string | null => {
  const t = s.trim();
  return t === '' || /^\[none\b.*\]$/i.test(t) ? null : t;
};

/**
 * "Status changed from New to In Progress" → { field: 'Status', from: 'New', to: 'In Progress' }.
 * Values can themselves contain " to " (company names, status labels), so the
 * split point is chosen with the field's known labels when given (a split where
 * a side IS a known label wins); with several " to " and nothing to anchor on,
 * the change is marked ambiguous and the raw detail stays the source of truth.
 */
export function parseHistoryChange(detail: string, knownValues: string[] = []): ParsedChange | null {
  const m = String(detail ?? '').match(/^\s*(.+?) changed from ([\s\S]*)$/i);
  if (!m) return null;
  const field = m[1]!.trim();
  const rest = m[2]!;
  const cuts: number[] = [];
  for (let i = rest.indexOf(' to '); i >= 0; i = rest.indexOf(' to ', i + 1)) cuts.push(i);
  if (!cuts.length) return { field, from: blankToNull(rest), to: null, ambiguous: true };
  const split = (i: number) => ({ from: rest.slice(0, i), to: rest.slice(i + 4) });
  if (cuts.length === 1) { const s = split(cuts[0]!); return { field, from: blankToNull(s.from), to: blankToNull(s.to), ambiguous: false }; }
  const known = new Set(knownValues.map((v) => v.trim().toLowerCase()));
  const anchored = cuts.map(split).filter((s) => known.has(s.from.trim().toLowerCase()) || known.has(s.to.trim().toLowerCase()));
  if (anchored.length === 1) return { field, from: blankToNull(anchored[0]!.from), to: blankToNull(anchored[0]!.to), ambiguous: false };
  const first = split(cuts[0]!);
  return { field, from: blankToNull(first.from), to: blankToNull(first.to), ambiguous: true };
}

/** History field name → the Tickets picklist whose labels anchor its parse. */
export const HISTORY_FIELD_PICKLIST: Record<string, string> = {
  status: 'status', queue: 'queueID', priority: 'priority', source: 'source',
  'issue type': 'issueType', 'sub-issue type': 'subIssueType', 'ticket type': 'ticketType',
};

/** Reference fields on Tickets resolved to names, grouped by the entity that names them. */
export const TICKET_RESOURCE_FIELDS = [
  'assignedResourceID', 'creatorResourceID', 'completedByResourceID', 'lastActivityResourceID',
  'firstResponseAssignedResourceID', 'firstResponseInitiatingResourceID', 'impersonatorCreatorResourceID',
] as const;
export const TICKET_CONTACT_FIELDS = ['contactID', 'createdByContactID'] as const;

/** Columns the audit tools read from related entities. */
export interface ContactRow { id: number; firstName?: string; lastName?: string; emailAddress?: string; companyID?: number; isActive?: boolean }
export interface HistoryRow { id: number; date?: string; action?: string; detail?: string | null; resourceID?: number | null }
export interface AttachmentRow { id: number; title?: string; contentType?: string; fileSize?: number; attachDate?: string; data?: string; ticketID?: number }
export interface UdfDef { name: string; isPickList?: boolean; picklistValues?: Array<{ value: unknown; label: string }> }
export const contactName = (c: ContactRow | undefined): string | null => (c ? [c.firstName, c.lastName].filter(Boolean).join(' ') || null : null);

/** The source labels that mean "came in by email". */
export const isEmailSource = (label: string | undefined): boolean => !!label && /e-?mail|voice ?mail/i.test(label);
