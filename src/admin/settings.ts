// Runtime settings the admin console can change without a restart.
//
// Each setting's DEFAULT comes from the environment (so a server without the
// console behaves exactly as configured); a value saved in the console
// (admin_setting) overrides it until it is reset. Pure in-memory registry — no
// database or runtime imports here, so the hot paths (tool dispatch, the HTTP
// cache) can read settings cheaply. admin/apply.ts pushes values into the
// shadow runtime.

export type SettingType = 'boolean' | 'integer' | 'string[]';

export interface SettingDef {
  key: string;
  group: 'Tools' | 'Postgres shadow' | 'Autotask API';
  label: string;
  description: string;
  type: SettingType;
  min?: number;
  max?: number;
  /** Allowed values for string[] settings (filled in by the console at startup). */
  choices?: string[];
  /** Only meaningful when this subsystem is running. */
  requires?: 'shadow';
  envDefault: (env: NodeJS.ProcessEnv) => unknown;
}

const boolEnv = (v: string | undefined, d: boolean): boolean => (v == null || v === '' ? d : /^(true|1|yes|on)$/i.test(v));
const intEnv = (v: string | undefined, d: number): number => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) && n >= 0 ? Math.floor(n) : d; };

export const SETTINGS: SettingDef[] = [
  {
    key: 'tools.writesEnabled', group: 'Tools', type: 'boolean', label: 'Allow write tools',
    description: 'Off = read-only MCP: every tool that creates, updates or deletes Autotask data is hidden and refused. Reads keep working.',
    envDefault: () => true,
  },
  {
    key: 'tools.disabledCategories', group: 'Tools', type: 'string[]', label: 'Disabled tool groups',
    description: 'Tool groups hidden from agents and refused if called. A tool listed in several groups is disabled when any of them is.',
    envDefault: () => [],
  },
  {
    key: 'shadow.syncEnabled', group: 'Postgres shadow', type: 'boolean', requires: 'shadow', label: 'Scheduled sync',
    description: 'Off pauses the background sync (no Autotask calls). The mirror goes stale; once it is older than the max age, reads fall back to the live API.',
    envDefault: () => true,
  },
  {
    key: 'shadow.serveReads', group: 'Postgres shadow', type: 'boolean', requires: 'shadow', label: 'Serve searches from the shadow',
    description: 'Answer search tools from Postgres instead of the Autotask API while the mirror is fresh.',
    envDefault: (env) => boolEnv(env.MCP_PG_SHADOW_SERVE_READS, false),
  },
  {
    key: 'shadow.maxAgeSeconds', group: 'Postgres shadow', type: 'integer', min: 60, max: 86_400, requires: 'shadow', label: 'Max mirror age (seconds)',
    description: 'Searches use the shadow only while its last sync is at most this old.',
    envDefault: (env) => intEnv(env.MCP_PG_SHADOW_MAX_AGE_SECONDS, 900),
  },
  {
    key: 'shadow.pauseAtPct', group: 'Postgres shadow', type: 'integer', min: 1, max: 100, requires: 'shadow', label: 'Pause sync at API usage %',
    description: "Skip a sync run while the tenant's hourly Autotask API usage is at or above this percentage.",
    envDefault: (env) => intEnv(env.MCP_PG_SHADOW_PAUSE_AT_PCT, 50),
  },
  {
    key: 'cache.enabled', group: 'Autotask API', type: 'boolean', label: 'Read cache',
    description: 'Short-lived cache of Autotask reads (writes always clear it). Off sends every read to Autotask.',
    envDefault: (env) => !/^(off|false|0|no)$/i.test(env.AUTOTASK_CACHE ?? ''),
  },
];

const byKey = new Map(SETTINGS.map((s) => [s.key, s]));
let overrides = new Map<string, unknown>();

export function settingDef(key: string): SettingDef | undefined { return byKey.get(key); }

/** The effective value: the console's saved value, else the env default. */
export function settingValue<T = unknown>(key: string, env: NodeJS.ProcessEnv = process.env): T {
  if (overrides.has(key)) return overrides.get(key) as T;
  const def = byKey.get(key);
  if (!def) throw new Error(`Unknown setting ${key}`);
  return def.envDefault(env) as T;
}

export function isOverridden(key: string): boolean { return overrides.has(key); }

/** Validate and normalise a value for a setting; throws with a user-facing message. */
export function coerceSetting(key: string, value: unknown): unknown {
  const def = byKey.get(key);
  if (!def) throw new Error(`Unknown setting "${key}".`);
  switch (def.type) {
    case 'boolean':
      if (typeof value !== 'boolean') throw new Error(`${def.label} must be true or false.`);
      return value;
    case 'integer': {
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isInteger(n)) throw new Error(`${def.label} must be a whole number.`);
      if (def.min != null && n < def.min) throw new Error(`${def.label} must be at least ${def.min}.`);
      if (def.max != null && n > def.max) throw new Error(`${def.label} must be at most ${def.max}.`);
      return n;
    }
    case 'string[]': {
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw new Error(`${def.label} must be a list.`);
      const bad = def.choices ? value.filter((v) => !def.choices!.includes(v)) : [];
      if (bad.length) throw new Error(`Unknown value(s) for ${def.label}: ${bad.join(', ')}.`);
      return [...new Set(value)].sort();
    }
  }
}

/**
 * Replace every override from a saved map (database load). Invalid saved
 * values (e.g. a category that no longer exists) are dropped, not fatal.
 */
export function loadOverrides(saved: Record<string, unknown>): string[] {
  const next = new Map<string, unknown>();
  const dropped: string[] = [];
  for (const [k, v] of Object.entries(saved)) {
    try { next.set(k, coerceSetting(k, v)); } catch { dropped.push(k); }
  }
  overrides = next;
  return dropped;
}

export function setOverride(key: string, value: unknown): unknown {
  const v = coerceSetting(key, value);
  overrides.set(key, v);
  return v;
}

export function clearOverride(key: string): void { overrides.delete(key); }

/** Tests only. */
export function _resetSettings(): void { overrides = new Map(); }
