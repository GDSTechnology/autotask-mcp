// Contact search + validation helpers (GDS brief §6.2 / §6.3).

import { QueryFilter } from '../services/autotask-http';

/** Max length of the Contacts `note` field in the tested tenant (§6.2). */
export const CONTACT_NOTE_MAX_LENGTH = 50;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Build the OR filter group for a free-text contact search (brief §6.3). The old
 * search applied the entire term to firstName AND lastName independently, so a
 * full name like "Joan Eberly" matched neither. This adds:
 *  - exact email match when the term is an email address,
 *  - a combined firstName+lastName AND-group for multi-word names,
 * while keeping the single-term OR across firstName / lastName / emailAddress.
 */
export function buildContactSearchFilter(searchTerm: string): QueryFilter {
  const term = searchTerm.trim();
  const items: QueryFilter[] = [
    { op: 'contains', field: 'firstName', value: term },
    { op: 'contains', field: 'lastName', value: term },
    { op: 'contains', field: 'emailAddress', value: term },
  ];

  if (EMAIL_RE.test(term)) {
    items.push({ op: 'eq', field: 'emailAddress', value: term });
  }

  const tokens = term.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) {
    // Probable "First … Last": match the first token in firstName AND the last
    // token in lastName together, so a full name resolves.
    items.push({
      op: 'and',
      items: [
        { op: 'contains', field: 'firstName', value: tokens[0] },
        { op: 'contains', field: 'lastName', value: tokens[tokens.length - 1] },
      ],
    });
  }

  return { op: 'or', items };
}

/**
 * Validate the Contacts `note` field length (§6.2). Autotask silently rejects /
 * truncates past the tenant limit, so fail fast with an actionable error unless
 * the caller explicitly opts into truncation.
 */
export function normalizeContactNote(
  note: unknown,
  opts: { truncate?: boolean } = {}
): string | undefined {
  if (note === undefined || note === null) return undefined;
  const str = String(note);
  if (str.length <= CONTACT_NOTE_MAX_LENGTH) return str;
  if (opts.truncate) return str.slice(0, CONTACT_NOTE_MAX_LENGTH);
  throw new Error(
    `Contact note exceeds the ${CONTACT_NOTE_MAX_LENGTH}-character limit (${str.length}). ` +
    `Shorten it, or pass truncateNote: true to truncate.`
  );
}
