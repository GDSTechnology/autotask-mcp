// Notification channels for the admin console (Notifications page). Stored in
// admin_setting under NOTIFY_SETTING_KEY — deliberately NOT a registered
// setting, so the webhook URLs (bearer secrets) never reach settingsView(),
// the diagnostics export or the setting.changed log. The browser only ever
// sees a masked URL and whether a signing secret is set.

import { randomUUID } from 'node:crypto';
import { NOTIFY_EVENTS, channelUrlProblem, maskUrl, type ChannelKind, type ChannelStatus, type NotifyChannel, type NotifyEventType } from '../services/notifier.js';

export const NOTIFY_SETTING_KEY = 'notify.channels';
export const CHANNEL_KINDS: Array<{ kind: ChannelKind; label: string; help: string }> = [
  { kind: 'discord', label: 'Discord', help: 'Server Settings → Integrations → Webhooks → New Webhook → Copy Webhook URL (https://discord.com/api/webhooks/…).' },
  { kind: 'teams', label: 'Microsoft Teams', help: 'In the channel: ••• → Workflows → "Post to a channel when a webhook request is received" → copy the URL it shows (…logic.azure.com… or …powerplatform.com…).' },
  { kind: 'slack', label: 'Slack', help: 'api.slack.com/apps → your app → Incoming Webhooks → Add New Webhook to Workspace (https://hooks.slack.com/services/…).' },
  { kind: 'generic', label: 'Other (JSON webhook)', help: 'Any https endpoint (n8n Webhook node, PagerDuty, …). Receives { event, severity, title, detail, fields, at, server }; with a signing secret, X-Atmcp-Signature: sha256=<HMAC of the body>.' },
];
const KINDS = new Set(CHANNEL_KINDS.map((k) => k.kind));
const EVENTS = new Set<NotifyEventType>(NOTIFY_EVENTS.map((e) => e.type));
const MAX_CHANNELS = 20;

/** Saved channels, tolerating anything malformed (dropped, not fatal). */
export function parseStoredChannels(v: unknown): NotifyChannel[] {
  if (!Array.isArray(v)) return [];
  const out: NotifyChannel[] = [];
  for (const c of v as Array<Record<string, unknown>>) {
    if (!c || typeof c !== 'object' || typeof c.id !== 'string' || typeof c.url !== 'string' || !KINDS.has(c.kind as ChannelKind)) continue;
    out.push({
      id: c.id, name: String(c.name ?? 'Channel').slice(0, 60), kind: c.kind as ChannelKind, url: c.url,
      events: (Array.isArray(c.events) ? c.events : []).filter((e): e is NotifyEventType => EVENTS.has(e as NotifyEventType)),
      enabled: c.enabled !== false, ...(typeof c.secret === 'string' && c.secret ? { secret: c.secret } : {}),
    });
  }
  return out;
}

export class ChannelInputError extends Error {}

/**
 * A channel from the console form. On edit, an empty url keeps the stored one
 * and secret: '' keeps it (null clears it) — the browser never has them.
 */
export function channelFromInput(b: Record<string, unknown>, existing: NotifyChannel | null, count: number): NotifyChannel {
  if (!existing && count >= MAX_CHANNELS) throw new ChannelInputError(`At most ${MAX_CHANNELS} channels.`);
  const name = String(b.name ?? existing?.name ?? '').trim();
  if (!name || name.length > 60) throw new ChannelInputError('Name is required (at most 60 characters).');
  const kind = (b.kind ?? existing?.kind) as ChannelKind;
  if (!KINDS.has(kind)) throw new ChannelInputError('Type must be discord, teams, slack or generic.');
  const url = typeof b.url === 'string' && b.url.trim() ? b.url.trim() : existing?.url ?? '';
  if (!url) throw new ChannelInputError('Webhook URL is required.');
  const problem = channelUrlProblem(kind, url);
  if (problem) throw new ChannelInputError(`Webhook URL ${problem}.`);
  const events = Array.isArray(b.events) ? b.events.map(String) : existing?.events ?? [];
  const unknown = events.filter((e) => !EVENTS.has(e as NotifyEventType));
  if (unknown.length) throw new ChannelInputError(`Unknown event(s): ${unknown.join(', ')}.`);
  let secret = existing?.secret;
  if (b.secret === null) secret = undefined;
  else if (typeof b.secret === 'string' && b.secret.trim()) {
    if (kind !== 'generic') throw new ChannelInputError('A signing secret applies to "Other (JSON webhook)" channels only.');
    if (b.secret.trim().length < 16) throw new ChannelInputError('Signing secret: at least 16 characters.');
    secret = b.secret.trim();
  }
  return {
    id: existing?.id ?? randomUUID(), name, kind, url, events: events as NotifyEventType[],
    enabled: typeof b.enabled === 'boolean' ? b.enabled : existing?.enabled ?? true,
    ...(secret && kind === 'generic' ? { secret } : {}),
  };
}

/** What the browser sees: never the URL path or the secret. */
export function channelView(c: NotifyChannel, status: ChannelStatus): Record<string, unknown> {
  return { id: c.id, name: c.name, kind: c.kind, url: maskUrl(c.url), events: c.events, enabled: c.enabled, hasSecret: !!c.secret, status };
}

/** Audit-log details for a channel change (no URL, no secret). */
export const channelLogDetails = (c: NotifyChannel) => ({ id: c.id, name: c.name, kind: c.kind, events: c.events, enabled: c.enabled });
