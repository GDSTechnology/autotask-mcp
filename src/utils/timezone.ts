/**
 * Timezone helpers for time-entry timestamps.
 *
 * Live-test finding: a meeting logged with only hoursWorked got the wrong clock
 * time, and Eastern must not be assumed to be UTC-5 (2026-09-23 is EDT=UTC-4).
 * Callers may pass either an offset-aware ISO string (…-04:00 / …Z) — used
 * as-is — or a local wall-clock time plus an IANA timeZone, which we convert to
 * the correct UTC instant, DST included.
 */

/** True when the ISO string already carries a UTC offset (Z or ±HH:MM). */
export function hasOffset(iso: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso.trim());
}

const WALL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;

/** The wall-clock (Y,M,D,h,m,s) that `instant` shows in `timeZone`, as a UTC ms. */
function wallMsInZone(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(instant).reduce<Record<string, number>>((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = Number(p.value);
    return acc;
  }, {});
  // Intl can render midnight as hour 24; normalize.
  const hour = parts.hour === 24 ? 0 : parts.hour;
  return Date.UTC(parts.year, parts.month - 1, parts.day, hour, parts.minute, parts.second);
}

/**
 * Convert a local wall-clock ISO (no offset) in `timeZone` to a UTC Date.
 * Uses a two-step fixpoint so the zone's own offset (incl. DST) is applied.
 * Throws on an unparseable local string or invalid timeZone.
 */
export function zonedLocalToUTC(localISO: string, timeZone: string): Date {
  const m = WALL.exec(localISO.trim());
  if (!m) throw new Error(`Unparseable local datetime: "${localISO}" (expected YYYY-MM-DDTHH:MM[:SS])`);
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] ?? 0));
  let guess = wall;
  for (let i = 0; i < 3; i++) {
    const rendered = wallMsInZone(new Date(guess), timeZone); // throws if timeZone invalid
    const diff = wall - rendered;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

/**
 * Normalize a timestamp to a UTC ISO string.
 *  - already offset-aware  -> that exact instant, as UTC ISO
 *  - local + timeZone      -> converted to UTC ISO (DST-correct)
 *  - local, no timeZone    -> returned unchanged (caller/Autotask interprets)
 */
export function normalizeTimestamp(iso: string | undefined, timeZone?: string): string | undefined {
  if (!iso) return iso;
  const s = iso.trim();
  if (hasOffset(s)) return new Date(s).toISOString();
  if (timeZone) return zonedLocalToUTC(s, timeZone).toISOString();
  return s;
}

/** Whole hours between two timestamps (offset-aware or already-UTC), else null. */
export function durationHours(startISO?: string, endISO?: string): number | null {
  if (!startISO || !endISO) return null;
  const a = Date.parse(startISO);
  const b = Date.parse(endISO);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return (b - a) / 3_600_000;
}
