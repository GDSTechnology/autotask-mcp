// Which Autotask entities the Postgres shadow mirrors, and how each stays fresh.
// Verified live (2026-10-06): every entity pages in ascending id order (so a
// backfill can walk `id > cursor`), and these are the queryable change fields.

export type ShadowEntityName = 'Tickets' | 'TimeEntries' | 'Companies' | 'Contacts' | 'Contracts' | 'ContractServices' | 'ContractBlocks' | 'Resources';

export interface ShadowEntity {
  name: ShadowEntityName;
  /** Queryable last-modified field for incremental sync; null = small table, refreshed in full. */
  watermarkField: string | null;
  /** Creation field, OR-ed into the incremental filter in case a new row has no modified stamp yet. */
  createField: string | null;
  /** Full refresh interval for entities without a watermark. */
  fullEveryMinutes?: number;
}

export const SHADOW_ENTITIES: ShadowEntity[] = [
  { name: 'Tickets', watermarkField: 'lastTrackedModificationDateTime', createField: 'createDate' },
  { name: 'TimeEntries', watermarkField: 'lastModifiedDateTime', createField: 'createDateTime' },
  { name: 'Companies', watermarkField: 'lastTrackedModifiedDateTime', createField: 'createDate' },
  { name: 'Contacts', watermarkField: 'lastModifiedDate', createField: 'createDate' },
  { name: 'Contracts', watermarkField: 'lastModifiedDateTime', createField: null },
  { name: 'ContractServices', watermarkField: null, createField: null, fullEveryMinutes: 60 },
  { name: 'ContractBlocks', watermarkField: null, createField: null, fullEveryMinutes: 60 },
  { name: 'Resources', watermarkField: null, createField: null, fullEveryMinutes: 60 },
];

export const shadowEntity = (name: string): ShadowEntity | undefined =>
  SHADOW_ENTITIES.find((e) => e.name.toLowerCase() === String(name).toLowerCase());

/** Re-read this far behind the watermark: Autotask stamps can land slightly out of order. */
export const WATERMARK_OVERLAP_MS = 2 * 60_000;

/** The record's modified stamp (or creation stamp) as a Date, for the row's modified_at and the next watermark. */
export function modifiedAt(e: ShadowEntity, row: Record<string, unknown>): Date | null {
  for (const f of [e.watermarkField, e.createField]) {
    const v = f ? row[f] : null;
    if (typeof v === 'string' && v) { const d = new Date(v); if (!Number.isNaN(d.getTime())) return d; }
  }
  return null;
}
