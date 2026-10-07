// Assemble every attributable Autotask event for a set of resources in a time
// window — the engine under search_audit_activity / report_resource_activity /
// report_resource_daily_audit.
//
// Autotask can't query TicketHistory by resource ("ResourceID is not
// queryable"), so tickets are found first — those changed since the window
// opened (from the Postgres shadow when it covers the window: 0 calls) — and
// their history is read per ticket and CACHED in the ledger: a past day's
// history never changes, so one pass serves every resource and every later
// report. Notes are searched by creator for all resources in one query per
// note type. Everything is sequential and capped by maxApiCalls; whatever the
// cap cut off is listed under meta.incomplete, never silently dropped.

import type { AutotaskService } from '../services/autotask.service.js';
import type { ShadowFilter } from './shadow-sql.js';
import { getShadowRuntime } from './shadow-runtime.js';
import {
  AuditEntityType, AuditEvent, historyEvent, noteEvent, timeEntryEvent,
} from '../utils/audit-events.js';
import { HISTORY_FIELD_PICKLIST, SYSTEM_RESOURCE_ID } from '../utils/ticket-audit.js';
import { dayIn } from '../utils/staff-tools.js';

export interface CollectOptions {
  resourceIds: number[];
  /** UTC instants, [start, end). */
  start: string;
  end: string;
  timeZone: string;
  entityTypes?: AuditEntityType[];
  includeSystemGenerated?: boolean;
  /** Also return events with no known actor (e.g. a service call rescheduled — Autotask doesn't record by whom). */
  includeUnattributed?: boolean;
  maxApiCalls?: number;
}

export interface TicketInfo { id: number; ticketNumber: string | null; companyID: number | null; status: number | null; title: string | null }

export interface CollectResult {
  events: AuditEvent[];
  tickets: Map<number, TicketInfo>;
  meta: {
    apiCallsUsed: number; recordsScanned: number; recordsReturned: number;
    ticketsChecked: number; historyFetched: number; historyFromCache: number;
    sources: Record<string, 'shadow' | 'live' | 'ledger' | 'skipped'>;
    incomplete: string[];
  };
}

type Row = Record<string, unknown> & { id: number };
const n = (v: unknown): number | null => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export async function collectAuditEvents(service: AutotaskService, o: CollectOptions): Promise<CollectResult> {
  const rt = getShadowRuntime();
  const ledger = rt?.ledger ?? null;
  const http = await service.httpClient();
  const budget = Math.min(Math.max(o.maxApiCalls ?? 400, 10), 2000);
  const want = (t: AuditEntityType) => !o.entityTypes?.length || o.entityTypes.includes(t);
  const ids = [...new Set(o.resourceIds.filter((x) => Number.isFinite(x)))];
  const meta: CollectResult['meta'] = { apiCallsUsed: 0, recordsScanned: 0, recordsReturned: 0, ticketsChecked: 0, historyFetched: 0, historyFromCache: 0, sources: {}, incomplete: [] };
  const events: AuditEvent[] = [];
  const tickets = new Map<number, TicketInfo>();
  const startDay = dayIn(new Date(o.start), o.timeZone);
  const endDay = dayIn(new Date(new Date(o.end).getTime() - 1), o.timeZone);
  const inWindow = (ts: string | null | undefined) => !!ts && ts >= o.start && ts < o.end;
  const byRes = (field: string): ShadowFilter[] => (ids.length ? [{ op: 'in', field, value: ids }] : []);

  /** Live query, counted against the budget (one call per 500-row page). */
  const live = async (entity: string, filter: ShadowFilter[], max = 2000): Promise<Row[]> => {
    if (meta.apiCallsUsed >= budget) throw new Error('budget');
    const rows = await http.query<Row>(entity, filter, { maxRecords: max });
    meta.apiCallsUsed += Math.max(1, Math.ceil(rows.length / 500));
    meta.recordsScanned += rows.length;
    return rows;
  };
  /** The shadow, when it mirrors the entity, is backfilled, and its history window covers the request. */
  const shadow = async (entity: string, filter: ShadowFilter[]): Promise<Row[] | null> => {
    if (!rt) return null;
    try {
      const f = await rt.store.freshness(entity);
      // Backfilled, covering the window, and FRESH — a stale mirror would miss
      // tickets changed since its last sync, so it falls back to live.
      if (!f.ready || f.ageSeconds == null || f.ageSeconds > 1800 || (f.windowFrom && startDay < f.windowFrom)) return null;
      const r = await rt.store.query(entity, filter, { limit: 5000, order: 'id_asc' });
      meta.recordsScanned += r.rows.length;
      return r.rows as Row[];
    } catch { return null; }
  };
  const read = async (key: string, entity: string, filter: ShadowFilter[]): Promise<Row[]> => {
    const s = await shadow(entity, filter);
    if (s) { meta.sources[key] = 'shadow'; return s; }
    meta.sources[key] = 'live';
    return live(entity, filter);
  };
  const guard = async (key: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e) {
      meta.sources[key] = 'skipped';
      meta.incomplete.push(e instanceof Error && e.message === 'budget' ? `${key}: API-call budget (${budget}) reached` : `${key}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const remember = (rows: Row[]) => {
    for (const t of rows) tickets.set(Number(t.id), { id: Number(t.id), ticketNumber: (t.ticketNumber as string) ?? null, companyID: n(t.companyID), status: n(t.status), title: (t.title as string) ?? null });
  };
  /** Ticket number / company for parent tickets not already known. */
  const ensureTickets = async (ticketIds: number[]) => {
    const missing = [...new Set(ticketIds)].filter((id) => !tickets.has(id));
    for (let i = 0; i < missing.length; i += 500) {
      const chunk = missing.slice(i, i + 500);
      const f: ShadowFilter[] = [{ op: 'in', field: 'id', value: chunk }];
      remember((await shadow('Tickets', f)) ?? (await live('Tickets', f)));
    }
  };

  // 1. Ticket changes — from TicketHistory, per changed ticket, cached in the ledger.
  if (want('ticket')) await guard('ticketHistory', async () => {
    const cand = await read('ticketCandidates', 'Tickets', [{ op: 'gte', field: 'lastTrackedModificationDateTime', value: o.start }, { op: 'lt', field: 'createDate', value: o.end }]);
    remember(cand);
    meta.ticketsChecked = cand.length;
    let fields: Awaited<ReturnType<AutotaskService['getFieldInfo']>> = [];
    try { fields = await service.getFieldInfo('Tickets'); } catch { /* parse without label anchors */ }
    const labelsFor = (f: string) => (fields.find((x) => x.name === HISTORY_FIELD_PICKLIST[f.toLowerCase()])?.picklistValues ?? []).map((v) => v.label);
    const fetched = ledger ? await ledger.historyFetched(cand.map((t) => Number(t.id))) : new Map<number, Date>();
    const cached: number[] = [];
    for (const t of cand) {
      const id = Number(t.id);
      const lastMod = t.lastTrackedModificationDateTime ? new Date(String(t.lastTrackedModificationDateTime)) : null;
      const at = fetched.get(id);
      if (at && lastMod && at >= lastMod) { cached.push(id); continue; }
      if (meta.apiCallsUsed >= budget) { meta.incomplete.push(`ticketHistory: budget reached — ${cand.length - meta.historyFetched - cached.length} ticket(s) not read`); break; }
      const hist = await live('TicketHistory', [{ op: 'eq', field: 'ticketID', value: id }], 500);
      const evs = hist.map((h) => historyEvent(h as never, tickets.get(id)!, labelsFor)).filter((e): e is AuditEvent => !!e);
      if (ledger) { await ledger.insert(evs); await ledger.markHistoryFetched(id, new Date()); }
      meta.historyFetched++;
      events.push(...evs.filter((e) => inWindow(e.timestamp)));
    }
    meta.historyFromCache = cached.length;
    if (ledger && cached.length) {
      events.push(...await ledger.query({ start: o.start, end: o.end, sources: ['ticket_history'], entityIds: cached, entityTypes: ['ticket'] }));
    }
    meta.sources.ticketHistory = ledger ? 'ledger' : 'live';
  });

  // 2. Notes — by creator, all resources in one query per note type.
  const noteKinds: Array<{ type: 'ticketNote' | 'taskNote' | 'projectNote'; entity: string; parentField: string; parentType: AuditEntityType }> = [
    { type: 'ticketNote', entity: 'TicketNotes', parentField: 'ticketID', parentType: 'ticket' },
    { type: 'taskNote', entity: 'TaskNotes', parentField: 'taskID', parentType: 'task' },
    { type: 'projectNote', entity: 'ProjectNotes', parentField: 'projectID', parentType: 'project' },
  ];
  for (const k of noteKinds) {
    if (!want(k.type)) continue;
    await guard(k.type, async () => {
      const rows = await live(k.entity, [...byRes('creatorResourceID'), { op: 'gte', field: 'createDateTime', value: o.start }, { op: 'lt', field: 'createDateTime', value: o.end }]);
      meta.sources[k.type] = 'live';
      let types: Array<{ value: string; label: string }> = [], pubs: Array<{ value: string; label: string }> = [];
      try { types = await service.getPicklistValues(k.entity, 'noteType'); pubs = await service.getPicklistValues(k.entity, 'publish'); } catch { /* raw values */ }
      if (k.type === 'ticketNote') await ensureTickets(rows.map((r) => Number(r.ticketID)).filter(Number.isFinite));
      for (const r of rows) {
        const pid = n(r[k.parentField]);
        if (pid == null) continue;
        const t = k.type === 'ticketNote' ? tickets.get(pid) : undefined;
        const ev = noteEvent(k.type, r, { type: k.parentType, id: pid, reference: t?.ticketNumber ?? null, companyId: t?.companyID ?? null }, {
          noteType: types.find((x) => String(x.value) === String(r.noteType))?.label ?? null,
          publish: pubs.find((x) => String(x.value) === String(r.publish))?.label ?? null,
        });
        if (ev) events.push(ev);
      }
    });
  }

  // 3. Time entries — worked in the window, or entered / changed in it.
  if (want('timeEntry')) await guard('timeEntries', async () => {
    const rows = await read('timeEntries', 'TimeEntries', [...byRes('resourceID'), { op: 'or', items: [
      { op: 'and', items: [{ op: 'gte', field: 'dateWorked', value: startDay }, { op: 'lte', field: 'dateWorked', value: `${endDay}T23:59:59` }] },
      { op: 'and', items: [{ op: 'gte', field: 'createDateTime', value: o.start }, { op: 'lt', field: 'createDateTime', value: o.end }] },
      { op: 'and', items: [{ op: 'gte', field: 'lastModifiedDateTime', value: o.start }, { op: 'lt', field: 'lastModifiedDateTime', value: o.end }] },
    ] }]);
    await ensureTickets(rows.map((r) => Number(r.ticketID)).filter(Number.isFinite));
    for (const r of rows) {
      const tid = n(r.ticketID), kid = n(r.taskID);
      const t = tid != null ? tickets.get(tid) : undefined;
      const ev = timeEntryEvent(r, { type: tid != null ? 'ticket' : kid != null ? 'task' : null, id: tid ?? kid, reference: t?.ticketNumber ?? null, companyId: t?.companyID ?? null }, o.timeZone);
      if (ev) events.push(ev);
    }
  });

  // 4. Project tasks — created / completed by the resource.
  if (want('task')) await guard('tasks', async () => {
    const rows = await read('tasks', 'Tasks', [{ op: 'or', items: [
      { op: 'and', items: [...byRes('creatorResourceID'), { op: 'gte', field: 'createDateTime', value: o.start }, { op: 'lt', field: 'createDateTime', value: o.end }] },
      { op: 'and', items: [...byRes('completedByResourceID'), { op: 'gte', field: 'completedDateTime', value: o.start }, { op: 'lt', field: 'completedDateTime', value: o.end }] },
    ] }]);
    for (const r of rows) {
      const base = { entityType: 'task' as const, entityId: Number(r.id), entityReference: (r.title as string) ?? null, parentEntityType: 'project' as const, parentEntityId: n(r.projectID), source: 'record' as const };
      const created = typeof r.createDateTime === 'string' ? new Date(r.createDateTime).toISOString() : null;
      const done = typeof r.completedDateTime === 'string' ? new Date(r.completedDateTime).toISOString() : null;
      if (inWindow(created) && (!ids.length || ids.includes(Number(r.creatorResourceID)))) events.push({ ...base, eventId: `task:create:${r.id}`, timestamp: created!, resourceId: n(r.creatorResourceID), action: 'create', systemGenerated: false });
      if (inWindow(done) && (!ids.length || ids.includes(Number(r.completedByResourceID)))) events.push({ ...base, eventId: `task:complete:${r.id}`, timestamp: done!, resourceId: n(r.completedByResourceID), action: 'complete', systemGenerated: false });
    }
  });

  // 5. Scheduling — service calls created / cancelled by the resource (Autotask records who for those two only).
  if (want('serviceCall')) await guard('serviceCalls', async () => {
    const rows = await read('serviceCalls', 'ServiceCalls', [{ op: 'or', items: [
      { op: 'and', items: [...byRes('creatorResourceID'), { op: 'gte', field: 'createDateTime', value: o.start }, { op: 'lt', field: 'createDateTime', value: o.end }] },
      { op: 'and', items: [...byRes('canceledByResourceID'), { op: 'gte', field: 'canceledDateTime', value: o.start }, { op: 'lt', field: 'canceledDateTime', value: o.end }] },
    ] }]);
    for (const r of rows) {
      const base = { entityType: 'serviceCall' as const, entityId: Number(r.id), companyId: n(r.companyID), source: 'record' as const, systemGenerated: false, details: { startDateTime: r.startDateTime ?? null, endDateTime: r.endDateTime ?? null, description: typeof r.description === 'string' ? r.description.slice(0, 300) : null } };
      const created = typeof r.createDateTime === 'string' ? new Date(r.createDateTime).toISOString() : null;
      const canceled = typeof r.canceledDateTime === 'string' ? new Date(r.canceledDateTime).toISOString() : null;
      if (inWindow(created) && (!ids.length || ids.includes(Number(r.creatorResourceID)))) events.push({ ...base, eventId: `sc:create:${r.id}`, timestamp: created!, resourceId: n(r.creatorResourceID), action: 'create' });
      if (inWindow(canceled) && (!ids.length || ids.includes(Number(r.canceledByResourceID)))) events.push({ ...base, eventId: `sc:cancel:${r.id}`, timestamp: canceled!, resourceId: n(r.canceledByResourceID), action: 'cancel' });
    }
  });

  // 6. To-Dos — created by the resource; completed while assigned to them.
  if (want('todo')) await guard('todos', async () => {
    const rows = await read('todos', 'CompanyToDos', [{ op: 'or', items: [
      { op: 'and', items: [...byRes('creatorResourceID'), { op: 'gte', field: 'createDateTime', value: o.start }, { op: 'lt', field: 'createDateTime', value: o.end }] },
      { op: 'and', items: [...byRes('assignedToResourceID'), { op: 'gte', field: 'completedDate', value: o.start }, { op: 'lt', field: 'completedDate', value: o.end }] },
    ] }]);
    for (const r of rows) {
      const base = { entityType: 'todo' as const, entityId: Number(r.id), companyId: n(r.companyID), parentEntityType: n(r.ticketID) != null ? 'ticket' as const : null, parentEntityId: n(r.ticketID), source: 'record' as const, systemGenerated: false };
      const details = { actionType: n(r.actionType), description: typeof r.activityDescription === 'string' ? r.activityDescription.slice(0, 300) : null };
      const created = typeof r.createDateTime === 'string' ? new Date(r.createDateTime).toISOString() : null;
      const done = typeof r.completedDate === 'string' ? new Date(r.completedDate).toISOString() : null;
      if (inWindow(created) && (!ids.length || ids.includes(Number(r.creatorResourceID)))) events.push({ ...base, eventId: `todo:create:${r.id}`, timestamp: created!, resourceId: n(r.creatorResourceID), action: 'create', details });
      if (inWindow(done) && (!ids.length || ids.includes(Number(r.assignedToResourceID)))) events.push({ ...base, eventId: `todo:complete:${r.id}`, timestamp: done!, resourceId: n(r.assignedToResourceID), action: 'complete', details: { ...details, weakAttribution: true, attribution: 'assignee — Autotask does not record who completed a To-Do (automations complete them too), so this is never counted as the assignee work' } });
    }
  });

  // 7. Appointments created by the resource (calendar / scheduling work).
  if (want('appointment')) await guard('appointments', async () => {
    const rows = await live('Appointments', [...byRes('creatorResourceID'), { op: 'gte', field: 'createDateTime', value: o.start }, { op: 'lt', field: 'createDateTime', value: o.end }]);
    meta.sources.appointments = 'live';
    for (const r of rows) {
      events.push({ eventId: `appt:${r.id}`, timestamp: new Date(String(r.createDateTime)).toISOString(), resourceId: n(r.creatorResourceID), action: 'create', entityType: 'appointment', entityId: Number(r.id), entityReference: (r.title as string) ?? null, source: 'record', systemGenerated: false, details: { forResourceID: n(r.resourceID), startDateTime: r.startDateTime ?? null, endDateTime: r.endDateTime ?? null } });
    }
  });

  // 8. Ticket charges created by the resource (billing activity).
  if (want('ticketCharge')) await guard('ticketCharges', async () => {
    const rows = await live('TicketCharges', [...byRes('creatorResourceID'), { op: 'gte', field: 'createDate', value: o.start }, { op: 'lt', field: 'createDate', value: o.end }]);
    meta.sources.ticketCharges = 'live';
    await ensureTickets(rows.map((r) => Number(r.ticketID)).filter(Number.isFinite));
    for (const r of rows) {
      const t = tickets.get(Number(r.ticketID));
      events.push({ eventId: `chg:${r.id}`, timestamp: new Date(String(r.createDate)).toISOString(), resourceId: n(r.creatorResourceID), action: 'create', entityType: 'ticketCharge', entityId: Number(r.id), entityReference: (r.name as string) ?? null, parentEntityType: 'ticket', parentEntityId: n(r.ticketID), parentReference: t?.ticketNumber ?? null, companyId: t?.companyID ?? null, source: 'record', systemGenerated: false, details: { quantity: r.chargeQuantity ?? r.unitQuantity ?? null, unitPrice: r.unitPrice ?? null } });
    }
  });

  // 9. Deletes — Autotask's delete logs (who deleted what, when).
  await guard('deletes', async () => {
    const logs: Array<{ entity: string; parentField: string; parentType: AuditEntityType; types: AuditEntityType[] }> = [
      { entity: 'DeletedTicketActivityLogs', parentField: 'ticketID', parentType: 'ticket', types: ['timeEntry', 'ticketNote'] },
      { entity: 'DeletedTaskActivityLogs', parentField: 'taskID', parentType: 'task', types: ['timeEntry', 'taskNote'] },
      { entity: 'DeletedTicketLogs', parentField: 'ticketID', parentType: 'ticket', types: ['ticket'] },
    ];
    for (const l of logs) {
      if (!l.types.some(want)) continue;
      const rows = await live(l.entity, [...byRes('deletedByResourceID'), { op: 'gte', field: 'deletedDateTime', value: o.start }, { op: 'lt', field: 'deletedDateTime', value: o.end }]);
      for (const r of rows) {
        const te = n(r.timeEntryID), note = n(r.noteID ?? r.ticketNoteID ?? r.taskNoteID);
        const type: AuditEntityType = te != null ? 'timeEntry' : note != null ? (l.parentType === 'task' ? 'taskNote' : 'ticketNote') : l.entity === 'DeletedTicketLogs' ? 'ticket' : l.parentType;
        events.push({
          eventId: `del:${l.entity}:${r.id}`, timestamp: new Date(String(r.deletedDateTime)).toISOString(), resourceId: n(r.deletedByResourceID), action: 'delete',
          entityType: type, entityId: te ?? note ?? n(r[l.parentField]) ?? Number(r.id), parentEntityType: l.parentType, parentEntityId: n(r[l.parentField]),
          entityReference: (r.ticketNumber as string) ?? null, source: 'delete_log', systemGenerated: false, details: { ...r },
        });
      }
    }
    meta.sources.deletes = 'live';
  });

  // 10. Webhook (who changed companies / contacts / CIs / tickets in the UI) + row diffs (scheduling / To-Do changes).
  if (ledger) await guard('ledger', async () => {
    const ev = await ledger.query({ start: o.start, end: o.end, sources: ['webhook', 'row_diff'], ...(ids.length ? { resourceIds: ids } : {}), unattributed: o.includeUnattributed === true });
    const fromHistory = new Set(events.filter((e) => e.source === 'ticket_history').map((e) => `${e.entityId}|${(e.field ?? '').toLowerCase()}|${e.newValue ?? ''}`));
    for (const e of ev) {
      if (o.entityTypes?.length && !o.entityTypes.includes(e.entityType)) continue;
      // A ticket change seen by both TicketHistory and a webhook is reported once (history wins: it has old values).
      if (e.source === 'webhook' && e.entityType === 'ticket' && fromHistory.has(`${e.entityId}|${(e.field ?? '').toLowerCase()}|${e.newValue ?? ''}`)) continue;
      events.push(e);
    }
    meta.sources.ledger = 'ledger';
  });

  // Attribution filter, system filter, dedupe, names, order.
  const seen = new Set<string>();
  let out = events.filter((e) => {
    if (seen.has(e.eventId)) return false;
    seen.add(e.eventId);
    if (!o.includeSystemGenerated && (e.systemGenerated || e.resourceId === SYSTEM_RESOURCE_ID)) return false;
    if (ids.length && (e.resourceId == null ? !o.includeUnattributed : !ids.includes(e.resourceId))) return false;
    return true;
  });
  const names = await service.getResourceNames(out.map((e) => e.resourceId).filter((x) => x != null)).catch(() => new Map<number, string>());
  const companyIds = [...new Set(out.map((e) => e.companyId).filter((x): x is number => x != null))];
  const companies = companyIds.length ? await service.getCompanyNamesByIds(companyIds).catch(() => []) : [];
  out = out.map((e) => ({
    ...e,
    resourceName: e.resourceId != null ? names.get(e.resourceId) ?? null : null,
    companyName: e.companyId != null ? companies.find((c) => c.id === e.companyId)?.companyName ?? null : null,
    ...(e.entityType === 'ticket' && !e.entityReference ? { entityReference: tickets.get(e.entityId)?.ticketNumber ?? null } : {}),
  })).sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.eventId.localeCompare(b.eventId));
  meta.recordsReturned = out.length;
  return { events: out, tickets, meta };
}
