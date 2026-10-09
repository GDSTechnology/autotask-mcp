// Per-tool-call operation scope (gap register MCP-007): every Autotask write
// made while a tool call runs is captured here, so the operation record says
// exactly which entities the call changed. The HTTP client reports each write
// (noteOperationWrite); AsyncLocalStorage keeps concurrent calls apart.
// Pure module — no database or service imports.

import { AsyncLocalStorage } from 'node:async_hooks';

export interface OperationWrite {
  at: string;
  method: string;
  /** Path without the zone base or query string, e.g. /Tickets or /Tickets/123/Notes. */
  path: string;
  /** Audit entity type (ticket, ticketNote, timeEntry, company, contact, …) or the REST entity name when unmapped. */
  entityType: string | null;
  entityId: number | null;
  parentType: string | null;
  parentId: number | null;
}

export interface OperationScope {
  operationId: string;
  writes: OperationWrite[];
}

const als = new AsyncLocalStorage<OperationScope>();

export function runInOperation<T>(scope: OperationScope, fn: () => Promise<T>): Promise<T> {
  return als.run(scope, fn);
}

export function currentOperation(): OperationScope | undefined {
  return als.getStore();
}

/** REST entity (or parent/child route) → audit entity type, as the activity feed names them. */
const TYPE: Record<string, string> = {
  Tickets: 'ticket', TicketNotes: 'ticketNote', 'Tickets/Notes': 'ticketNote',
  TimeEntries: 'timeEntry', Companies: 'company', Contacts: 'contact', 'Companies/Contacts': 'contact',
  CompanyNotes: 'companyNote', 'Companies/Notes': 'companyNote', CompanyToDos: 'todo', 'Companies/ToDos': 'todo',
  Tasks: 'task', 'Projects/Tasks': 'task', Projects: 'project', ServiceCalls: 'serviceCall',
  TicketCharges: 'ticketCharge', 'Tickets/Charges': 'ticketCharge', ConfigurationItems: 'configurationItem',
  TicketChecklistItems: 'ticketChecklistItem', 'Tickets/ChecklistItems': 'ticketChecklistItem',
  TicketAttachments: 'ticketAttachment', 'Tickets/Attachments': 'ticketAttachment',
};
const PARENT_TYPE: Record<string, string> = { Tickets: 'ticket', Companies: 'company', Projects: 'project', Tasks: 'task', Contracts: 'contract' };

const posInt = (v: unknown): number | null => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

/** Which entity a write touched: from the path, the body id, or the create response's itemId. */
export function parseWrite(method: string, path: string, body: unknown, response: unknown, at = new Date()): OperationWrite {
  let p = String(path ?? '').split('?')[0]!;
  if (/^https?:\/\//i.test(p)) { try { p = new URL(p).pathname; } catch { /* keep */ } }
  p = p.replace(/^.*?\/v1\.0(?=\/|$)/i, '');
  const segs = p.split('/').filter(Boolean);
  const b = (body ?? {}) as Record<string, unknown>;
  const r = (response ?? {}) as Record<string, unknown>;
  let entity: string | null = null, entityId: number | null = null, parentType: string | null = null, parentId: number | null = null;
  if (segs.length >= 3) {
    entity = TYPE[`${segs[0]}/${segs[2]}`] ?? `${segs[0]}/${segs[2]}`;
    parentType = PARENT_TYPE[segs[0]!] ?? segs[0]!;
    parentId = posInt(segs[1]);
    entityId = posInt(segs[3]) ?? posInt(b.id) ?? posInt(r.itemId);
  } else if (segs.length >= 1) {
    entity = TYPE[segs[0]!] ?? segs[0]!;
    entityId = posInt(segs[1]) ?? posInt(b.id) ?? posInt(r.itemId);
    if (entity === 'ticketNote' || entity === 'ticketCharge' || entity === 'ticketChecklistItem' || entity === 'ticketAttachment') {
      const tid = posInt(b.ticketID); if (tid) { parentType = 'ticket'; parentId = tid; }
    }
  }
  return { at: at.toISOString(), method: method.toUpperCase(), path: '/' + segs.join('/'), entityType: entity, entityId, parentType, parentId };
}

/** Called by the HTTP client after every successful write; a no-op outside a tool call. */
export function noteOperationWrite(method: string, path: string, body: unknown, response: unknown): void {
  const s = als.getStore();
  if (!s) return;
  try { s.writes.push(parseWrite(method, path, body, response)); } catch { /* never fail a write over bookkeeping */ }
}
