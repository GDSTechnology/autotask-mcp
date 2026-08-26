// Canonical record-reference resolution (GDS brief §7.30).
//
// Autotask shows both Tickets and project Tasks with a display number of the
// form `T20260825.0006` (T + YYYYMMDD + "." + sequence). The prefix does NOT
// identify the entity — a `T…` reference can be a ticket OR a task — so a
// reference must be resolved by searching BOTH entity types and is only usable
// when it maps to exactly one record. This module holds the pure, HTTP-free
// classification logic; AutotaskService.resolveRecordReference() supplies the
// two queries.

export type ReferenceEntityType = 'ticket' | 'task';

export interface ReferenceCandidate {
  entityType: ReferenceEntityType;
  id: number;
  /** The record's own display number (ticketNumber / taskNumber). */
  reference: string;
  title?: string;
}

export interface RecordReferenceResult {
  status: 'matched' | 'ambiguous' | 'not-found';
  /** The reference that was looked up (trimmed). */
  reference: string;
  entityType?: ReferenceEntityType;
  id?: number;
  title?: string;
  /** Present when status is 'ambiguous' — every record the reference matched. */
  candidates?: ReferenceCandidate[];
}

// Loose shape check: a letter, a run of digits (the date), a dot, then a
// sequence. Deliberately permissive on digit counts across zones; used only to
// short-circuit obviously-non-reference input, never to pick an entity type.
const REFERENCE_SHAPE = /^[A-Za-z]\d{6,10}\.\d{1,}$/;

export function isRecordReferenceShape(reference: string): boolean {
  return REFERENCE_SHAPE.test(reference.trim());
}

/**
 * Turn the combined ticket + task matches into a single decision:
 *  - exactly one record  → matched (typed id)
 *  - none                → not-found
 *  - more than one       → ambiguous (all candidates returned, no id chosen)
 *
 * Ambiguity is a normal structured outcome, never an exception — callers must
 * not guess when a reference is ambiguous or missing.
 */
export function classifyReferenceMatches(
  reference: string,
  candidates: ReferenceCandidate[]
): RecordReferenceResult {
  const ref = reference.trim();

  if (candidates.length === 0) {
    return { status: 'not-found', reference: ref };
  }
  if (candidates.length === 1) {
    const only = candidates[0];
    return {
      status: 'matched',
      reference: ref,
      entityType: only.entityType,
      id: only.id,
      ...(only.title !== undefined ? { title: only.title } : {}),
    };
  }
  return { status: 'ambiguous', reference: ref, candidates };
}
