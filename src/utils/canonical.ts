// Canonical resolution layer (Expansion Spec §3.3, issue #16).
//
// One place that turns whatever a caller typed — a raw id, an Autotask deep-link
// URL, an email, a ticket/task display number, or a free-text name — into a typed
// lookup hint, and turns a set of candidate records into a single
// { id, canonicalName } or a short choice list. Pure and HTTP-free: the service
// layer supplies the actual live lookups and feeds the candidates back here.
//
// Complements `reference.resolver.ts` (which owns ticket-vs-task display-number
// disambiguation); this module handles the wider set of reference forms and the
// generic "one id + human name, or choose" shape every entity shares.

import { isRecordReferenceShape } from './reference.resolver';

export type ReferenceKind = 'id' | 'url' | 'email' | 'entity-number' | 'name';

export interface ParsedReference {
  kind: ReferenceKind;
  /** Trimmed original input. */
  raw: string;
  /** Present for kind 'id', and for 'url' when an id was extracted. */
  id?: number;
  /** Present for 'url' (and possible future typed numbers) — the Autotask entity the reference points at. */
  entity?: string;
  /** Present for kind 'email'. */
  email?: string;
  /** Present for kind 'entity-number' — the display number, e.g. T20260825.0006. */
  number?: string;
}

// Autotask deep-link query params → the entity they identify. Autotask URLs look
// like `.../ServiceDesk/TicketDetail.mvc?ticketId=12345`.
const URL_PARAM_ENTITY: Record<string, string> = {
  ticketid: 'ticket',
  taskid: 'task',
  accountid: 'company',
  companyid: 'company',
  contactid: 'contact',
  projectid: 'project',
  opportunityid: 'opportunity',
  quoteid: 'quote',
  contractid: 'contract',
  resourceid: 'resource',
  configurationitemid: 'configurationItem',
  installedproductid: 'configurationItem',
};

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Classify an arbitrary reference into a typed lookup hint. Never throws. */
export function parseReference(input: string | number): ParsedReference {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return { kind: 'id', raw: String(input), id: input };
  }
  const raw = String(input ?? '').trim();

  // Bare id.
  if (/^\d+$/.test(raw)) {
    return { kind: 'id', raw, id: Number(raw) };
  }

  // Autotask URL — pull the entity + id out of the query string.
  if (/^https?:\/\//i.test(raw)) {
    const parsed = parseAutotaskUrl(raw);
    if (parsed) return parsed;
    return { kind: 'url', raw };
  }

  // Email.
  if (EMAIL_SHAPE.test(raw)) {
    return { kind: 'email', raw, email: raw };
  }

  // Ticket/task display number (T20260825.0006). Entity is intentionally left
  // unset — the prefix does not identify ticket vs task (see reference.resolver).
  if (isRecordReferenceShape(raw)) {
    return { kind: 'entity-number', raw, number: raw };
  }

  return { kind: 'name', raw };
}

function parseAutotaskUrl(raw: string): ParsedReference | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  for (const [param, value] of url.searchParams) {
    const entity = URL_PARAM_ENTITY[param.toLowerCase()];
    if (entity && /^\d+$/.test(value)) {
      return { kind: 'url', raw, entity, id: Number(value) };
    }
  }
  return undefined;
}

export interface CanonicalRef {
  id: number;
  /** Human-facing name/number for the record (never just the id). */
  canonicalName: string;
  entity?: string;
}

export interface CanonicalResolution {
  status: 'matched' | 'ambiguous' | 'not-found';
  reference: string;
  match?: CanonicalRef;
  /** Present when status is 'ambiguous' — the short choice list for the caller. */
  candidates?: CanonicalRef[];
}

/**
 * Collapse candidate records into one canonical decision:
 *  - exactly one → matched
 *  - none        → not-found
 *  - more than one → ambiguous (choice list; no id chosen)
 * Ambiguity is a normal outcome, never an exception — callers must not guess.
 */
export function resolveCanonical(reference: string, candidates: CanonicalRef[]): CanonicalResolution {
  const ref = reference.trim();
  if (candidates.length === 0) return { status: 'not-found', reference: ref };
  if (candidates.length === 1) return { status: 'matched', reference: ref, match: candidates[0] };
  return { status: 'ambiguous', reference: ref, candidates };
}

/**
 * Best-effort human name for a record, trying the fields Autotask entities
 * commonly carry. Falls back to the id so a candidate always has a label.
 */
export function pickCanonicalName(record: Record<string, any>): string {
  if (!record || typeof record !== 'object') return '';
  const number =
    record.ticketNumber ?? record.taskNumber ?? record.quoteNumber ?? record.opportunityNumber ?? record.contractNumber;
  const title = record.title ?? record.name ?? record.contractName ?? record.companyName;
  if (number && title) return `${number} — ${title}`;
  if (title) return String(title);
  const fullName = [record.firstName, record.lastName].filter(Boolean).join(' ').trim();
  if (fullName) return fullName;
  if (number) return String(number);
  if (record.emailAddress || record.email) return String(record.emailAddress ?? record.email);
  return record.id !== undefined ? `#${record.id}` : '';
}
