// Autotask read cache + request coalescing + upstream usage metrics.
//
// Why (2026-09-30): every caller — n8n, ChatGPT, automations — shares ONE
// Autotask API user, and Autotask limits per-integration requests per hour AND
// concurrent requests (HTTP 429, then the whole tenant sits in cooldown). Much
// of the traffic re-pulls the same data: the same resources/roles/departments
// on every role check, the same ticket several times in one chat turn.
//
// Three layers, all keyed per API user + impersonated identity:
//   1. Reference data (resources, roles, departments, work types, field info…)
//      cached for minutes — it rarely changes.
//   2. Identical reads already in flight share ONE upstream call (coalescing).
//   3. Everything else read (tickets, notes, time entries…) cached ~30 s, so a
//      conversation re-reading a ticket doesn't re-hit Autotask.
// Safety: any write through the MCP clears all short-lived entries and the
// reference entries of the written entity; "not found" ({item:null}) and empty
// results are NEVER cached (a just-created record can briefly read as missing —
// caching that would defeat read-after-write retries); errors are never cached.
// AUTOTASK_CACHE=off disables caching (coalescing + metrics stay on).

import { settingValue } from '../admin/settings.js';
import { noteCacheHit } from './call-log.js';

export type CacheClass ='fields' | 'reference' | 'slow-reference' | 'volatile' | 'never';

/** Entities whose data changes rarely (people / org structure / catalogs). */
const REFERENCE = new Set([
  'Resources', 'ResourceRoles', 'Roles', 'Departments', 'BillingCodes', 'InternalLocations',
  'Countries', 'Currencies', 'Holidays', 'HolidaySets', 'WorkTypeModifiers', 'TaxCategories',
  'ServiceBundles', 'Services', 'Products', 'ClassificationIcons', 'ShippingTypes', 'Skills',
]);
/** Changes occasionally and a person may just have added one in the UI — keep it short-ish. */
const SLOW_REFERENCE = new Set(['Companies', 'CompanyLocations', 'Contracts', 'ContractServices', 'Contacts']);
/** Never cache: live counters and anything an operator expects to be instantaneous. */
const NEVER = new Set(['ThresholdInformation', 'Version', 'zoneInformation']);

const MAX_ENTRIES = 1500;
const MAX_CACHEABLE_BYTES = 2_000_000;

function envSeconds(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export function ttlMs(cls: CacheClass): number {
  switch (cls) {
    case 'fields': return envSeconds('AUTOTASK_CACHE_TTL_FIELDS_SECONDS', 3600) * 1000;
    case 'reference': return envSeconds('AUTOTASK_CACHE_TTL_REFERENCE_SECONDS', 900) * 1000;
    case 'slow-reference': return envSeconds('AUTOTASK_CACHE_TTL_SLOW_REFERENCE_SECONDS', 300) * 1000;
    case 'volatile': return envSeconds('AUTOTASK_CACHE_TTL_VOLATILE_SECONDS', 30) * 1000;
    default: return 0;
  }
}

/** AUTOTASK_CACHE, unless the admin console overrides it ("Read cache"). */
export function cacheEnabled(): boolean {
  return settingValue<boolean>('cache.enabled');
}

/** Top-level entity of a REST path: "/Tickets/123/Notes/query" → "Tickets". */
export function entityOf(path: string): string {
  const p = path.startsWith('http') ? new URL(path).pathname.replace(/^.*?\/v1\.0/i, '') : path;
  return p.replace(/^\/+/, '').split(/[/?]/)[0] ?? '';
}

export function isRead(method: string, path: string): boolean {
  const m = method.toUpperCase();
  if (m === 'GET') return true;
  // Searches are POSTs: /Entity/query, /query/count, and continuation pages
  // (pageDetails.nextPageUrl → …/query/next?…). Treating those as writes would
  // flush the cache on every multi-page read.
  return m === 'POST' && /\/query(\/|\?|$)/i.test(path);
}

export function classify(path: string): CacheClass {
  const entity = entityOf(path);
  if (!entity || NEVER.has(entity)) return 'never';
  if (/\/entityInformation(\/|$)/i.test(path)) return 'fields';
  if (REFERENCE.has(entity)) return 'reference';
  if (SLOW_REFERENCE.has(entity)) return 'slow-reference';
  return 'volatile';
}

/** A response that may be cached: not a miss, not empty. */
export function isCacheableValue(v: unknown): boolean {
  if (v == null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  if ('item' in o) return o.item != null;
  if ('items' in o) return Array.isArray(o.items) && o.items.length > 0;
  return true;
}

interface Entry { value: unknown; expires: number; cls: CacheClass; entity: string }

interface Stats {
  since: number;
  upstream: Map<string, number>;
  cacheHits: number;
  coalesced: number;
  rateLimited: number;
  /** Upstream calls per minute for the last 60 minutes (ring of [minute, count]). */
  minutes: Array<[number, number]>;
}

const caches = new Map<string, Map<string, Entry>>();
const inFlight = new Map<string, Promise<unknown>>();
const stats = new Map<string, Stats>();

function statsFor(tenant: string): Stats {
  let s = stats.get(tenant);
  if (!s) { s = { since: Date.now(), upstream: new Map(), cacheHits: 0, coalesced: 0, rateLimited: 0, minutes: [] }; stats.set(tenant, s); }
  return s;
}

function cacheFor(tenant: string): Map<string, Entry> {
  let c = caches.get(tenant);
  if (!c) { c = new Map(); caches.set(tenant, c); }
  return c;
}

export function recordUpstream(tenant: string, method: string, path: string): void {
  const s = statsFor(tenant);
  const key = `${method.toUpperCase()} ${entityOf(path) || '?'}`;
  s.upstream.set(key, (s.upstream.get(key) ?? 0) + 1);
  const minute = Math.floor(Date.now() / 60_000);
  const last = s.minutes[s.minutes.length - 1];
  if (last && last[0] === minute) last[1]++;
  else s.minutes.push([minute, 1]);
  while (s.minutes.length && s.minutes[0]![0] <= minute - 60) s.minutes.shift();
}

export function recordRateLimited(tenant: string): void { statsFor(tenant).rateLimited++; }

/**
 * Run a READ through the cache: a fresh hit returns without going upstream;
 * an identical read already in flight is shared; otherwise `fetch` runs once
 * and a cacheable result is stored.
 */
export async function cachedRead<T>(tenant: string, key: string, path: string, fetch: () => Promise<{ value: T; bytes: number }>): Promise<T> {
  const cls = classify(path);
  const cache = cacheFor(tenant);
  const now = Date.now();
  if (cls !== 'never' && cacheEnabled()) {
    const hit = cache.get(key);
    if (hit && hit.expires > now) {
      statsFor(tenant).cacheHits++;
      noteCacheHit(path);
      cache.delete(key); cache.set(key, hit); // LRU touch
      return structuredClone(hit.value) as T; // callers mutate results (e.g. _card) — never share the cached object
    }
    if (hit) cache.delete(key);
  }
  const flightKey = `${tenant}\u0000${key}`;
  const pending = inFlight.get(flightKey);
  if (pending) {
    statsFor(tenant).coalesced++;
    noteCacheHit(path);
    return structuredClone(await pending) as T;
  }
  const p = (async () => {
    const { value, bytes } = await fetch();
    const ttl = ttlMs(cls);
    if (cls !== 'never' && ttl > 0 && cacheEnabled() && bytes <= MAX_CACHEABLE_BYTES && isCacheableValue(value)) {
      cache.set(key, { value: structuredClone(value), expires: Date.now() + ttl, cls, entity: entityOf(path) });
      while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
    }
    return value;
  })();
  inFlight.set(flightKey, p);
  try {
    return structuredClone(await p) as T; // the shared result is never handed out itself
  } finally {
    inFlight.delete(flightKey);
  }
}

/**
 * After a successful WRITE: drop every short-lived entry (anything volatile may
 * reflect it — notes on a ticket, a ticket's time, …) plus cached reference
 * data of the written entity (e.g. a created company must be findable at once).
 */
export function invalidateAfterWrite(tenant: string, path: string): void {
  const cache = caches.get(tenant);
  if (!cache) return;
  const written = entityOf(path);
  for (const [k, e] of cache) {
    if (e.cls === 'volatile' || e.entity === written) cache.delete(k);
  }
}

export interface ApiUsageSnapshot {
  since: string;
  cacheEnabled: boolean;
  upstreamCalls: number;
  upstreamLastHour: number;
  upstreamLastFiveMinutes: number;
  cacheHits: number;
  coalesced: number;
  rateLimited: number;
  /** Share of reads served without going upstream. */
  savedPct: number | null;
  cachedEntries: number;
  topUpstream: Array<{ call: string; count: number }>;
}

export function usageSnapshot(tenant: string, top = 15): ApiUsageSnapshot {
  const s = statsFor(tenant);
  const minute = Math.floor(Date.now() / 60_000);
  const upstreamCalls = [...s.upstream.values()].reduce((a, b) => a + b, 0);
  const inWindow = (mins: number) => s.minutes.filter(([m]) => m > minute - mins).reduce((a, [, c]) => a + c, 0);
  const saved = s.cacheHits + s.coalesced;
  return {
    since: new Date(s.since).toISOString(),
    cacheEnabled: cacheEnabled(),
    upstreamCalls,
    upstreamLastHour: inWindow(60),
    upstreamLastFiveMinutes: inWindow(5),
    cacheHits: s.cacheHits,
    coalesced: s.coalesced,
    rateLimited: s.rateLimited,
    savedPct: upstreamCalls + saved > 0 ? Math.round((saved / (upstreamCalls + saved)) * 1000) / 10 : null,
    cachedEntries: caches.get(tenant)?.size ?? 0,
    topUpstream: [...s.upstream.entries()].sort((a, b) => b[1] - a[1]).slice(0, top).map(([call, count]) => ({ call, count })),
  };
}

/** Tests only. */
export function _resetHttpCache(): void {
  caches.clear();
  inFlight.clear();
  stats.clear();
}
