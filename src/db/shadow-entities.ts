// Which Autotask entities the Postgres shadow mirrors, and how each stays fresh.
// Verified live (2026-10-06): every entity pages in ascending id order (so a
// backfill can walk `id > cursor`), and these are the queryable change fields.

export type ShadowEntityName = 'Tickets' | 'TimeEntries' | 'Tasks' | 'Projects' | 'Companies' | 'Contacts' | 'Contracts' | 'ContractServices' | 'ContractBlocks' | 'Resources';

import type { ShadowFilter } from './shadow-sql.js';

export interface ShadowEntity {
  name: ShadowEntityName;
  /** Queryable last-modified field for incremental sync; null = small table, refreshed in full. */
  watermarkField: string | null;
  /** Creation field, OR-ed into the incremental filter in case a new row has no modified stamp yet. */
  createField: string | null;
  /** Full refresh interval for entities without a watermark. */
  fullEveryMinutes?: number;
  /**
   * History window for the backfill (big transactional tables only): the rows
   * worth mirroring when work is about the last N months. Absent = everything.
   */
  window?: (cutoffDay: string) => ShadowFilter;
  /** Whether a query's filters stay inside the window (otherwise it must go live). */
  windowCovers?: (filters: ShadowFilter[], cutoffDay: string) => boolean;
}

const lowerBoundAtLeast = (filters: ShadowFilter[], fields: string[], cutoffDay: string): boolean =>
  filters.some((f) => (f.op === 'gte' || f.op === 'gt') && fields.includes(String(f.field)) && String(f.value ?? '').slice(0, 10) >= cutoffDay);

export const SHADOW_ENTITIES: ShadowEntity[] = [
  {
    name: 'Tickets', watermarkField: 'lastTrackedModificationDateTime', createField: 'createDate',
    // Active or created in the window, plus EVERY open ticket however old.
    window: (c) => ({ op: 'or', items: [{ op: 'gte', field: 'lastActivityDate', value: c }, { op: 'gte', field: 'createDate', value: c }, { op: 'noteq', field: 'status', value: 5 }] }),
    windowCovers: (fs, c) => lowerBoundAtLeast(fs, ['lastActivityDate', 'createDate'], c) || fs.some((f) =>
      (f.op === 'noteq' && f.field === 'status' && Number(f.value) === 5) ||
      (f.op === 'eq' && f.field === 'status' && f.value != null && Number(f.value) !== 5) ||
      (f.op === 'in' && f.field === 'status' && Array.isArray(f.value) && f.value.length > 0 && !f.value.map(Number).includes(5))),
  },
  {
    name: 'TimeEntries', watermarkField: 'lastModifiedDateTime', createField: 'createDateTime',
    window: (c) => ({ op: 'gte', field: 'dateWorked', value: c }),
    windowCovers: (fs, c) => lowerBoundAtLeast(fs, ['dateWorked'], c),
  },
  // Project work: small (≈1.9k tasks / 160 projects at GDS) — mirrored whole, no window.
  { name: 'Tasks', watermarkField: 'lastActivityDateTime', createField: 'createDateTime' },
  { name: 'Projects', watermarkField: 'lastActivityDateTime', createField: 'createDateTime' },
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
