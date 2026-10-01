// Ticket-card payload builder for the MCP Apps (SEP-1865) UI surface.
//
// autotask_get_ticket_details results get a normalized `_card` object attached
// (see tool.handler.ts) that the ui:// ticket card renders from. The card is
// progressive enhancement: every step here is best-effort, and a null return
// simply means the host renders no card while the JSON payload is unchanged.

import { AutotaskService } from '../services/autotask.service.js';
import { PicklistCache } from '../services/picklist.cache.js';
import { Logger } from '../utils/logger.js';
import { partitionTicketNotes } from '../utils/ticket-note-kind.js';
import type { AutotaskQueryOptionsExtended } from '../types/autotask.js';

export const TICKET_CARD_RESOURCE_URI = 'ui://autotask/ticket-card.html';

/** MCP Apps resource MIME (RESOURCE_MIME_TYPE in @modelcontextprotocol/ext-apps). */
export const MCP_APP_RESOURCE_MIME = 'text/html;profile=mcp-app';

/**
 * Tool `_meta` advertising the card. Carries both the canonical flat key
 * (RESOURCE_URI_META_KEY in ext-apps) and the nested form ext-apps'
 * registerAppTool emits, so any MCP Apps host revision finds it.
 */
export const TICKET_CARD_META = {
  'ui/resourceUri': TICKET_CARD_RESOURCE_URI,
  ui: { resourceUri: TICKET_CARD_RESOURCE_URI },
} as const;

/** Mirror of Brand in ui/ticket-card.ts — keep in sync. */
export interface CardBrand {
  name?: string;
  logoUrl?: string;
  primaryColor?: string;
  accentColor?: string;
  bg?: string;
  text?: string;
}

const BRAND_INJECT_MARKER = /<!--\s*BRAND_INJECT[\s\S]*?-->/;

/**
 * Operator branding from MCP_BRAND_* env vars. The card ships neutral (this is
 * a published server); self-hosters brand it without rebuilding by setting
 * these, and a gateway can inject window.__BRAND__ per-org the same way.
 */
export function resolveBrandFromEnv(
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): CardBrand {
  const brand: CardBrand = {};
  if (env.MCP_BRAND_NAME) brand.name = env.MCP_BRAND_NAME;
  if (env.MCP_BRAND_LOGO_URL) brand.logoUrl = env.MCP_BRAND_LOGO_URL;
  if (env.MCP_BRAND_PRIMARY_COLOR) brand.primaryColor = env.MCP_BRAND_PRIMARY_COLOR;
  if (env.MCP_BRAND_ACCENT_COLOR) brand.accentColor = env.MCP_BRAND_ACCENT_COLOR;
  if (env.MCP_BRAND_BG) brand.bg = env.MCP_BRAND_BG;
  if (env.MCP_BRAND_TEXT) brand.text = env.MCP_BRAND_TEXT;
  return brand;
}

/**
 * Replace the card's BRAND_INJECT marker with a window.__BRAND__ script.
 * An empty brand returns the HTML unchanged (neutral defaults). "<" is
 * escaped so brand values can never break out of the script element.
 */
export function applyBrandInjection(html: string, brand: CardBrand): string {
  if (Object.keys(brand).length === 0) return html;
  const json = JSON.stringify(brand).replace(/</g, '\\u003c');
  return html.replace(BRAND_INJECT_MARKER, `<script>window.__BRAND__=${json}</script>`);
}

/** Mirror of TicketCard in ui/ticket-card.ts — keep in sync. */
export interface TicketCard {
  id: number;
  ticketNumber: string;
  title: string;
  status?: string;
  priority?: string;
  company?: string;
  assignedTo?: string;
  queue?: string;
  createDate?: string;
  dueDateTime?: string;
  estimatedHours?: number;
  /** At-a-glance work totals — the card is a summary, not the full record. */
  summary: CardSummary;
  /** Newest activity, one headline line each, oldest→newest. */
  activity: CardActivity[];
  /** Opens the ticket in the Autotask web UI for the full detail. */
  ticketUrl?: string;
  noteDefaults?: { noteType: number; publish: number };
}

export interface CardSummary {
  hoursLogged: number;
  timeEntries: number;
  /** Distinct people who logged time, most hours first. */
  techs: string[];
  lastActivity?: string;
  /** Autotask/integration bookkeeping notes left off the card. */
  systemNotesHidden: number;
}

export interface CardActivity {
  kind: 'time' | 'note';
  when?: string;
  who?: string;
  hours?: number;
  /** One-line headline of the entry/note — never the full body. */
  text: string;
}

const CARD_ACTIVITY_LIMIT = 5;
/** One child-query page — enough to find the newest human notes past the system ones. */
const CARD_FETCH = 500;
const CARD_HEADLINE_MAX = 160;

/**
 * One line from a multi-line note/summary: lines joined with " · ", bullet
 * markers dropped, capped at CARD_HEADLINE_MAX. "Remote Support\n- Remotely
 * accessed …" → "Remote Support · Remotely accessed …".
 */
export function headline(text: unknown): string {
  const line = String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*[-*•]+\s*/, '').trim())
    .filter(Boolean)
    .join(' · ')
    .replace(/\s+/g, ' ');
  return line.length > CARD_HEADLINE_MAX ? `${line.slice(0, CARD_HEADLINE_MAX - 1).trimEnd()}…` : line;
}

/**
 * Build the renderable card from an (already enhanced) ticket. `ticket` is the
 * enhanceItems output, so `company` / `assignedTo` are resolved name strings
 * when the mapping succeeded.
 */
export async function buildTicketCard(
  ticket: Record<string, any>,
  picklists: PicklistCache,
  service: AutotaskService,
  logger: Logger,
): Promise<TicketCard | null> {
  if (typeof ticket?.id !== 'number' || !ticket.ticketNumber || !ticket.title) {
    return null;
  }

  const card: TicketCard = {
    id: ticket.id,
    ticketNumber: String(ticket.ticketNumber),
    title: String(ticket.title),
    summary: { hoursLogged: 0, timeEntries: 0, techs: [], systemNotesHidden: 0 },
    activity: [],
  };
  if (typeof ticket.company === 'string') card.company = ticket.company;
  if (typeof ticket.assignedTo === 'string') card.assignedTo = ticket.assignedTo;
  if (ticket.createDate) card.createDate = String(ticket.createDate);
  if (ticket.dueDateTime) card.dueDateTime = String(ticket.dueDateTime);
  if (typeof ticket.estimatedHours === 'number') card.estimatedHours = ticket.estimatedHours;

  // Picklist labels — one cached getFieldInfo('Tickets') behind all three.
  const status = await picklistLabel(picklists, 'Tickets', 'status', ticket.status, logger);
  const priority = await picklistLabel(picklists, 'Tickets', 'priority', ticket.priority, logger);
  const queue = await picklistLabel(picklists, 'Tickets', 'queueID', ticket.queueID, logger);
  if (status) card.status = status;
  if (priority) card.priority = priority;
  if (queue) card.queue = queue;

  // The card is an at-a-glance SUMMARY of what has been done — totals plus a
  // one-line headline per recent item — with a link to the ticket in Autotask
  // for the full detail. Techs record their work in time-entry summaries, not
  // notes, and most of a ticket's note stream is Autotask / integration
  // bookkeeping (T20260921.0086: 17 notes, none human; the work is in 3 time
  // entries). Each source is best-effort — one failing never blanks the other.
  type Raw = { at: number; seq: number; kind: CardActivity['kind']; when?: string | undefined; resourceID?: unknown; contact: boolean; hours?: number | undefined; text: string };
  const raw: Raw[] = [];
  let seq = 0;
  let timeRows: Array<{ resourceID?: unknown; hours: number }> = [];
  try {
    const { human, systemHidden } = partitionTicketNotes(await service.searchTicketNotes(ticket.id, { pageSize: CARD_FETCH }));
    card.summary.systemNotesHidden = systemHidden;
    for (const n of human) {
      const text = headline(n.title && !/^\[external\]/i.test(String(n.title)) ? `${n.title}\n${n.description ?? ''}` : n.description);
      if (!text) continue;
      raw.push({ at: Date.parse(String(n.createDateTime ?? '')), seq: seq++, kind: 'note', when: n.createDateTime ? String(n.createDateTime) : undefined,
        resourceID: n.creatorResourceID, contact: n.createdByContactID != null, text });
    }
  } catch (error) {
    logger.debug('Ticket card: note fetch failed, rendering without notes', error);
  }
  try {
    const query: AutotaskQueryOptionsExtended & { ticketId: number } = { ticketId: ticket.id, pageSize: CARD_FETCH };
    const entries = (await service.searchTimeEntries(query)).items;
    timeRows = entries.map((e) => ({ resourceID: e.resourceID, hours: Number(e.hoursWorked) || 0 }));
    for (const e of entries) {
      const when = e.startDateTime ?? e.createDateTime ?? e.dateWorked;
      raw.push({ at: Date.parse(String(when ?? '')), seq: seq++, kind: 'time', when: when ? String(when) : undefined,
        resourceID: e.resourceID, contact: false, hours: e.hoursWorked != null ? Number(e.hoursWorked) : undefined,
        text: headline(e.summaryNotes) || '(no summary)' });
    }
  } catch (error) {
    logger.debug('Ticket card: time-entry fetch failed, rendering without time entries', error);
  }

  const ordered = raw.sort((a, b) => (Number.isNaN(a.at) || Number.isNaN(b.at) ? a.seq - b.seq : a.at - b.at || a.seq - b.seq));
  const recent = ordered.slice(-CARD_ACTIVITY_LIMIT);
  const names = await resourceNames(service, [...recent.map((r) => r.resourceID), ...timeRows.map((t) => t.resourceID)]);
  card.activity = recent.map((r) => {
    const a: CardActivity = { kind: r.kind, text: r.text };
    if (r.when) a.when = r.when;
    const who = r.contact ? 'Client contact' : names.get(Number(r.resourceID));
    if (who) a.who = who;
    if (r.hours != null) a.hours = Math.round(r.hours * 100) / 100;
    return a;
  });
  const byTech = new Map<string, number>();
  for (const t of timeRows) {
    const who = names.get(Number(t.resourceID)) ?? `Resource ${t.resourceID}`;
    byTech.set(who, (byTech.get(who) ?? 0) + t.hours);
  }
  card.summary.timeEntries = timeRows.length;
  card.summary.hoursLogged = Math.round(timeRows.reduce((s, t) => s + t.hours, 0) * 100) / 100;
  card.summary.techs = [...byTech.entries()].sort((a, b) => b[1] - a[1]).map(([who]) => who);
  const last = ordered[ordered.length - 1];
  if (last?.when) card.summary.lastActivity = last.when;

  try {
    const ticketUrl = service.getTicketWebUrl(ticket.id);
    if (ticketUrl) card.ticketUrl = ticketUrl;
  } catch (error) {
    logger.debug('Ticket card: web URL unavailable, rendering without the Autotask link', error);
  }

  const noteDefaults = await resolveNoteDefaults(picklists, logger);
  if (noteDefaults) card.noteDefaults = noteDefaults;

  return card;
}

/** Best-effort "First Last" for each distinct resource id (misses are simply absent). */
/**
 * Best-effort "First Last" for each distinct resource id — ONE batched,
 * memoised lookup (never a parallel GET per id: that burst tripped Autotask's
 * concurrent-request 429 when a busy caller rendered many cards).
 */
async function resourceNames(service: AutotaskService, ids: unknown[]): Promise<Map<number, string>> {
  try {
    return await service.getResourceNames(ids);
  } catch {
    return new Map();
  }
}

async function picklistLabel(
  picklists: PicklistCache,
  entity: string,
  fieldName: string,
  value: unknown,
  logger: Logger,
): Promise<string | undefined> {
  if (value == null) return undefined;
  try {
    const values = await picklists.getPicklistValues(entity, fieldName);
    return values.find((v) => String(v.value) === String(value))?.label ?? `#${value}`;
  } catch (error) {
    logger.debug(`Ticket card: picklist lookup failed for ${entity}.${fieldName}`, error);
    return undefined;
  }
}

/**
 * Resolve tenant-safe defaults for the card's "Add note" button.
 * autotask_create_ticket_note requires noteType + publish picklist IDs, which
 * are tenant-specific — the card must never guess them.
 *
 * publish controls client-portal visibility, so only an explicitly
 * internal-labeled value is acceptable as a default. No internal option →
 * no noteDefaults → the card renders read-only. Fail-safe by construction.
 */
async function resolveNoteDefaults(
  picklists: PicklistCache,
  logger: Logger,
): Promise<{ noteType: number; publish: number } | undefined> {
  try {
    const [noteTypes, publishValues] = await Promise.all([
      picklists.getPicklistValues('TicketNotes', 'noteType'),
      picklists.getPicklistValues('TicketNotes', 'publish'),
    ]);

    const noteType =
      noteTypes.find((v) => /task note|general|note/i.test(v.label)) ?? noteTypes[0];
    const publish = publishValues.find((v) => /internal/i.test(v.label));
    if (!noteType || !publish) return undefined;

    const noteTypeId = parseInt(noteType.value, 10);
    const publishId = parseInt(publish.value, 10);
    if (!Number.isFinite(noteTypeId) || !Number.isFinite(publishId)) return undefined;

    return { noteType: noteTypeId, publish: publishId };
  } catch (error) {
    logger.debug('Ticket card: note-default resolution failed, card renders read-only', error);
    return undefined;
  }
}
