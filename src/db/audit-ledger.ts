// Postgres store for the normalized audit event ledger (migration 0003).
// Inserts are idempotent on eventId, so re-reading a ticket's history or a
// re-delivered webhook never duplicates an event.

import { Pool } from 'pg';
import type { AuditEvent, AuditEntityType } from '../utils/audit-events.js';

interface Row {
  event_key: string; occurred_at: Date; resource_id: string | null; action: string; entity_type: string; entity_id: string;
  entity_reference: string | null; parent_entity_type: string | null; parent_entity_id: string | null; company_id: string | null;
  field: string | null; old_value: string | null; new_value: string | null; source: string; system_generated: boolean; details: Record<string, unknown> | null;
}

const n = (v: string | null): number | null => (v == null ? null : Number(v));

export class AuditLedger {
  constructor(private readonly pool: Pool) {}

  async insert(events: AuditEvent[]): Promise<number> {
    if (!events.length) return 0;
    const cols = {
      key: [] as string[], at: [] as string[], rid: [] as Array<number | null>, action: [] as string[], et: [] as string[], eid: [] as number[],
      ref: [] as Array<string | null>, pet: [] as Array<string | null>, pid: [] as Array<number | null>, cid: [] as Array<number | null>,
      field: [] as Array<string | null>, ov: [] as Array<string | null>, nv: [] as Array<string | null>, src: [] as string[], sys: [] as boolean[], det: [] as Array<string | null>,
    };
    for (const e of events) {
      cols.key.push(e.eventId); cols.at.push(e.timestamp); cols.rid.push(e.resourceId); cols.action.push(e.action); cols.et.push(e.entityType); cols.eid.push(e.entityId);
      cols.ref.push(e.entityReference ?? null); cols.pet.push(e.parentEntityType ?? null); cols.pid.push(e.parentEntityId ?? null); cols.cid.push(e.companyId ?? null);
      cols.field.push(e.field ?? null); cols.ov.push(e.oldValue ?? null); cols.nv.push(e.newValue ?? null); cols.src.push(e.source); cols.sys.push(e.systemGenerated);
      cols.det.push(e.details ? JSON.stringify(e.details) : null);
    }
    const r = await this.pool.query(
      `INSERT INTO audit_event (event_key, occurred_at, resource_id, action, entity_type, entity_id, entity_reference, parent_entity_type,
         parent_entity_id, company_id, field, old_value, new_value, source, system_generated, details)
       SELECT * FROM unnest($1::text[], $2::timestamptz[], $3::bigint[], $4::text[], $5::text[], $6::bigint[], $7::text[], $8::text[],
         $9::bigint[], $10::bigint[], $11::text[], $12::text[], $13::text[], $14::text[], $15::boolean[], $16::jsonb[])
       ON CONFLICT (event_key) DO NOTHING`,
      [cols.key, cols.at, cols.rid, cols.action, cols.et, cols.eid, cols.ref, cols.pet, cols.pid, cols.cid, cols.field, cols.ov, cols.nv, cols.src, cols.sys, cols.det],
    );
    return r.rowCount ?? 0;
  }

  /** Events in [start, end) — by resource when given; optionally only these sources / entity types. */
  async query(opts: { start: string; end: string; resourceIds?: number[]; sources?: string[]; entityTypes?: AuditEntityType[]; entityIds?: number[]; unattributed?: boolean }): Promise<AuditEvent[]> {
    const where = ['occurred_at >= $1', 'occurred_at < $2'];
    const params: unknown[] = [opts.start, opts.end];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (opts.resourceIds?.length) {
      if (opts.unattributed) add('(resource_id = ANY(?::bigint[]) OR resource_id IS NULL)', opts.resourceIds);
      else add('resource_id = ANY(?::bigint[])', opts.resourceIds);
    }
    if (opts.sources?.length) add('source = ANY(?::text[])', opts.sources);
    if (opts.entityTypes?.length) add('entity_type = ANY(?::text[])', opts.entityTypes);
    if (opts.entityIds?.length) add('entity_id = ANY(?::bigint[])', opts.entityIds);
    const r = await this.pool.query<Row>(`SELECT * FROM audit_event WHERE ${where.join(' AND ')} ORDER BY occurred_at, event_key LIMIT 20000`, params);
    return r.rows.map((x) => ({
      eventId: x.event_key, timestamp: new Date(x.occurred_at).toISOString(), resourceId: n(x.resource_id), action: x.action as AuditEvent['action'],
      entityType: x.entity_type as AuditEntityType, entityId: Number(x.entity_id), entityReference: x.entity_reference,
      parentEntityType: x.parent_entity_type as AuditEntityType | null, parentEntityId: n(x.parent_entity_id), companyId: n(x.company_id),
      field: x.field, oldValue: x.old_value, newValue: x.new_value, source: x.source as AuditEvent['source'], systemGenerated: x.system_generated,
      ...(x.details ? { details: x.details } : {}),
    }));
  }

  /** When each ticket's history was last fetched into the ledger. */
  async historyFetched(ticketIds: number[]): Promise<Map<number, Date>> {
    const m = new Map<number, Date>();
    if (!ticketIds.length) return m;
    const r = await this.pool.query<{ ticket_id: string; fetched_at: Date }>(`SELECT ticket_id, fetched_at FROM ticket_history_fetch WHERE ticket_id = ANY($1::bigint[])`, [ticketIds]);
    for (const x of r.rows) m.set(Number(x.ticket_id), new Date(x.fetched_at));
    return m;
  }

  async markHistoryFetched(ticketId: number, at: Date): Promise<void> {
    await this.pool.query(
      `INSERT INTO ticket_history_fetch (ticket_id, fetched_at) VALUES ($1, $2) ON CONFLICT (ticket_id) DO UPDATE SET fetched_at = EXCLUDED.fetched_at`,
      [ticketId, at],
    );
  }
}
