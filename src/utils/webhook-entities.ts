// Autotask webhook entity catalog (#23 §16). Pure — no I/O.
//
// Autotask supports outbound webhooks on a LIMITED set of entities. Each webhook-
// capable entity has a parent `<Entity>Webhooks` record plus three child
// collections: the standard FIELDS to monitor, the USER-DEFINED fields, and the
// EXCLUDED RESOURCES — resources whose changes do NOT fire the webhook. That last
// one is the loop-prevention hook: exclude the MCP's own integration resource so
// the MCP's own writes don't trigger the webhook back into itself.
//
// This catalog maps a friendly entity name → the REST entity names, so the tools
// take `entity: "tickets"` instead of making callers memorize "TicketWebhooks".

export interface WebhookEntityMap {
  /** friendly key used by the tools */
  key: string;
  /** the business entity the webhook watches */
  targetEntity: string;
  /** parent webhook record entity */
  parent: string;
  /** child: standard fields monitored */
  fields: string;
  /** child: user-defined fields monitored */
  udfFields: string;
  /** child: resources whose changes are excluded (loop prevention) */
  excludedResources: string;
}

// The webhook-capable entities in Autotask. (Autotask exposes webhooks for this
// limited set; if a tenant surfaces more, add them here.)
export const WEBHOOK_ENTITIES: Record<string, WebhookEntityMap> = {
  tickets: { key: 'tickets', targetEntity: 'Tickets', parent: 'TicketWebhooks', fields: 'TicketWebhookFields', udfFields: 'TicketWebhookUdfFields', excludedResources: 'TicketWebhookExcludedResources' },
  companies: { key: 'companies', targetEntity: 'Companies', parent: 'CompanyWebhooks', fields: 'CompanyWebhookFields', udfFields: 'CompanyWebhookUdfFields', excludedResources: 'CompanyWebhookExcludedResources' },
  contacts: { key: 'contacts', targetEntity: 'Contacts', parent: 'ContactWebhooks', fields: 'ContactWebhookFields', udfFields: 'ContactWebhookUdfFields', excludedResources: 'ContactWebhookExcludedResources' },
  configurationItems: { key: 'configurationItems', targetEntity: 'ConfigurationItems', parent: 'ConfigurationItemWebhooks', fields: 'ConfigurationItemWebhookFields', udfFields: 'ConfigurationItemWebhookUdfFields', excludedResources: 'ConfigurationItemWebhookExcludedResources' },
  ticketNotes: { key: 'ticketNotes', targetEntity: 'TicketNotes', parent: 'TicketNoteWebhooks', fields: 'TicketNoteWebhookFields', udfFields: 'TicketNoteWebhookUdfFields', excludedResources: 'TicketNoteWebhookExcludedResources' },
};

export const WEBHOOK_ENTITY_KEYS = Object.keys(WEBHOOK_ENTITIES);

/** Resolve a friendly key (case-insensitive; a few aliases) to its entity map. */
export function resolveWebhookEntity(name: string | undefined | null): WebhookEntityMap | null {
  if (!name) return null;
  const n = String(name).trim().toLowerCase().replace(/\s+/g, '');
  const alias: Record<string, string> = {
    ticket: 'tickets', tickets: 'tickets',
    company: 'companies', companies: 'companies', account: 'companies', accounts: 'companies',
    contact: 'contacts', contacts: 'contacts',
    configurationitem: 'configurationItems', configurationitems: 'configurationItems', ci: 'configurationItems', asset: 'configurationItems', assets: 'configurationItems',
    ticketnote: 'ticketNotes', ticketnotes: 'ticketNotes',
  };
  const key = alias[n];
  return key ? WEBHOOK_ENTITIES[key] : null;
}

/** The child-collection foreign key back to the parent webhook. */
export const WEBHOOK_PARENT_FK = 'webhookID';

export interface WebhookParams {
  name?: string | undefined;
  webhookUrl?: string | undefined;
  isActive?: boolean | undefined;
  subscribeCreate?: boolean | undefined;
  subscribeUpdate?: boolean | undefined;
  subscribeDelete?: boolean | undefined;
  sendThresholdExceededNotification?: boolean | undefined;
  notificationEmailAddress?: string | undefined;
  ownerResourceID?: number | undefined;
  secretKey?: string | undefined;
}

// Friendly param → Autotask field name. Kept in one place so the create/update
// mapping is testable without hitting the API.
const FIELD_MAP: Array<[keyof WebhookParams, string]> = [
  ['name', 'name'],
  ['webhookUrl', 'webhookUrl'],
  ['isActive', 'isActive'],
  ['subscribeCreate', 'isSubscribedToCreateEvents'],
  ['subscribeUpdate', 'isSubscribedToUpdateEvents'],
  ['subscribeDelete', 'isSubscribedToDeleteEvents'],
  ['sendThresholdExceededNotification', 'sendThresholdExceededNotification'],
  ['notificationEmailAddress', 'notificationEmailAddress'],
  ['ownerResourceID', 'ownerResourceID'],
  ['secretKey', 'secretKey'],
];

/** Build the Autotask webhook payload from friendly params (only provided keys). */
export function buildWebhookPayload(p: WebhookParams): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, field] of FIELD_MAP) {
    if (p[k] !== undefined) out[field] = p[k];
  }
  return out;
}

/** Validate create params. Returns human-readable errors (empty = valid). */
export function validateWebhookCreate(p: WebhookParams): string[] {
  const errors: string[] = [];
  if (!p.name || !p.name.trim()) errors.push('name is required');
  if (!p.webhookUrl || !p.webhookUrl.trim()) errors.push('webhookUrl is required');
  else if (!/^https:\/\//i.test(p.webhookUrl.trim())) errors.push('webhookUrl must be an https:// URL');
  if (!p.subscribeCreate && !p.subscribeUpdate && !p.subscribeDelete) {
    errors.push('subscribe to at least one event (subscribeCreate / subscribeUpdate / subscribeDelete)');
  }
  return errors;
}
