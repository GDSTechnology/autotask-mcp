/**
 * Autotask InternalLocation.timeZone stores the Windows/.NET timezone id
 * (e.g. "Eastern Standard Time"), NOT an IANA id. The Windows name already
 * encodes DST rules — "Eastern Standard Time" is the Eastern zone including EDT,
 * i.e. IANA "America/New_York". Intl (used by our zoned conversion) only accepts
 * IANA, so map before converting.
 *
 * Curated from the CLDR windowsZones mapping — US zones plus common
 * international ones. Tenant-agnostic; extend as needed.
 */
const WINDOWS_TO_IANA: Record<string, string> = {
  'Dateline Standard Time': 'Etc/GMT+12',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Alaskan Standard Time': 'America/Anchorage',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Pacific Standard Time (Mexico)': 'America/Tijuana',
  'US Mountain Standard Time': 'America/Phoenix', // Arizona (no DST)
  'Mountain Standard Time': 'America/Denver',
  'Mountain Standard Time (Mexico)': 'America/Chihuahua',
  'Central Standard Time': 'America/Chicago',
  'Central Standard Time (Mexico)': 'America/Mexico_City',
  'Canada Central Standard Time': 'America/Regina',
  'Eastern Standard Time': 'America/New_York',
  'Eastern Standard Time (Mexico)': 'America/Cancun',
  'US Eastern Standard Time': 'America/Indiana/Indianapolis',
  'Atlantic Standard Time': 'America/Halifax',
  'Newfoundland Standard Time': 'America/St_Johns',
  'SA Pacific Standard Time': 'America/Bogota',
  'UTC': 'Etc/UTC',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Romance Standard Time': 'Europe/Paris',
  'Central European Standard Time': 'Europe/Warsaw',
  'GTB Standard Time': 'Europe/Bucharest',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Singapore Standard Time': 'Asia/Singapore',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'AUS Central Standard Time': 'Australia/Darwin',
  'E. Australia Standard Time': 'Australia/Brisbane',
  'New Zealand Standard Time': 'Pacific/Auckland',
};

/**
 * Resolve a timezone string to an IANA id usable by Intl.
 *  - a Windows name (from Autotask) -> its IANA equivalent
 *  - an already-IANA id (contains "/", e.g. "America/New_York") -> unchanged
 *  - "UTC" -> "Etc/UTC"; anything unknown -> null
 */
export function windowsToIana(tz: string | undefined | null): string | null {
  if (!tz) return null;
  const t = tz.trim();
  if (!t) return null;
  if (WINDOWS_TO_IANA[t]) return WINDOWS_TO_IANA[t];
  if (t.includes('/')) return t; // already IANA
  if (t.toUpperCase() === 'UTC') return 'Etc/UTC';
  return null;
}
