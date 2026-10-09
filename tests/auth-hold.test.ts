// Login protection, hardened after the 2026-10-09 production lockout:
// limited automatic tests then HOLD (no more failed logins until an admin
// presses Retry now), the pause saved across restarts, a credentials
// fingerprint (changing the secret clears a saved pause), and the first 401
// stopping every other request while it is checked.

import { AutotaskHttpClient, AutotaskAuthError, _resetRateLimitCooldowns, _resetAuthBlocks, authBlockStatus, clearAuthBlock, setAuthBlockPersistence, restoreAuthBlocks, type PersistedAuthBlock } from '../src/services/autotask-http';
import { _resetHttpCache } from '../src/services/http-cache';
import { _resetZoneUrlCache } from '../src/utils/config';
import { Logger } from '../src/utils/logger';

const logger = new Logger('error');
const USER = 'api@example.com';
const BASE = 'https://webservices3.autotask.net/ATServicesRest/';
const client = (secret = 'secret') => new AutotaskHttpClient(USER, secret, 'ic', BASE, logger);
const resp = (status: number, body: unknown) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(body) }) as unknown as Response;
const sent = () => (global.fetch as jest.Mock).mock.calls.filter((c) => !String(c[0]).includes('zoneInformation')).length;

let mode: 'unauthorized' | 'ok' = 'unauthorized';
let saved: Map<string, PersistedAuthBlock>;
beforeEach(() => {
  _resetHttpCache(); _resetRateLimitCooldowns(); _resetZoneUrlCache(); _resetAuthBlocks();
  delete process.env.AUTOTASK_AUTH_PAUSE_SECONDS; delete process.env.AUTOTASK_AUTH_MAX_PROBES;
  mode = 'unauthorized';
  saved = new Map();
  setAuthBlockPersistence({ save: async (t, b) => { if (b) saved.set(t, b); else saved.delete(t); } });
  global.fetch = jest.fn(async (url: string) => {
    if (String(url).includes('zoneInformation')) return resp(200, { url: BASE });
    return mode === 'ok' ? resp(200, { item: { id: 1 } }) : resp(401, { errors: ['Unauthorized'] });
  }) as unknown as typeof fetch;
});
afterEach(() => { jest.useRealTimers(); });

describe('limited tests, then HOLD', () => {
  test('first rejection + 2 failed tests = held: no further logins until Retry now; whole lockout costs 4 logins', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const c = client();
    await expect(c.get('Tickets', 1)).rejects.toBeInstanceOf(AutotaskAuthError); // call + confirmation = 2
    jest.setSystemTime(Date.now() + 301_000);
    await expect(c.get('Tickets', 2)).rejects.toBeInstanceOf(AutotaskAuthError); // test 1 = 3
    jest.setSystemTime(Date.now() + 601_000);
    await expect(c.get('Tickets', 3)).rejects.toThrow(/HELD until an administrator presses "Retry now"/); // test 2 = 4
    expect(sent()).toBe(4);
    expect(authBlockStatus(USER)).toMatchObject({ held: true, failures: 3, blockedUntil: null, probing: false });
    // Days later: still nothing is sent.
    jest.setSystemTime(Date.now() + 7 * 24 * 3600_000);
    for (let i = 0; i < 5; i++) await expect(c.get('Tickets', 10 + i)).rejects.toThrow(/HELD/);
    expect(sent()).toBe(4);
    // The admin fixes the account and presses Retry now.
    expect(clearAuthBlock(USER)).toBe(true);
    mode = 'ok';
    expect(await c.get('Tickets', 20)).toEqual({ id: 1 });
    expect(saved.size).toBe(0);
  });
});

describe('saved across restarts', () => {
  test('the pause is saved; a new process (restart/deploy) restores it and sends nothing', async () => {
    await expect(client().get('Tickets', 1)).rejects.toBeInstanceOf(AutotaskAuthError);
    const row = saved.get(USER)!;
    expect(row).toMatchObject({ tenant: USER, failures: 1, held: false });
    expect(row.fp).toMatch(/^[0-9a-f]{16}$/);
    // "Restart": memory is gone, the saved row is restored before the first call.
    _resetAuthBlocks(); (global.fetch as jest.Mock).mockClear();
    restoreAuthBlocks([row]);
    await expect(client().get('Tickets', 2)).rejects.toThrow(/NOT sent/);
    expect(sent()).toBe(0);
  });

  test('a saved pause for different credentials (secret changed in the env file) no longer applies', async () => {
    await expect(client('old-secret').get('Tickets', 1)).rejects.toBeInstanceOf(AutotaskAuthError);
    const row = saved.get(USER)!;
    _resetAuthBlocks(); setAuthBlockPersistence({ save: async (t, b) => { if (b) saved.set(t, b); else saved.delete(t); } });
    restoreAuthBlocks([row]);
    mode = 'ok';
    expect(await client('new-secret').get('Tickets', 2)).toEqual({ id: 1 });
    expect(saved.has(USER)).toBe(false);
  });
});

describe('the first 401 stops everything else while it is checked', () => {
  test('requests arriving during the check are not sent; in-flight 401s do not run their own check', async () => {
    let releaseCheck!: () => void;
    const checks: number[] = [];
    (global.fetch as jest.Mock).mockImplementation(async (url: string) => {
      if (String(url).includes('zoneInformation')) return resp(200, { url: BASE });
      if (String(url).includes('ThresholdInformation')) { checks.push(1); await new Promise<void>((r) => { releaseCheck = r; }); return resp(401, {}); }
      return resp(401, { errors: ['Unauthorized'] });
    });
    const c = client();
    // Three lookups in parallel (like get_ticket_by_number): all three are already in flight.
    const all = Promise.allSettled([c.get('Companies', 1), c.get('Contacts', 2), c.get('Resources', 3)]);
    await new Promise((r) => setTimeout(r, 20));
    // A new request while the check runs is stopped at the gate.
    await expect(c.get('Tickets', 9)).rejects.toThrow(/checking whether the API login itself is rejected/);
    releaseCheck();
    const results = await all;
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(checks).toHaveLength(1); // ONE confirmation for the whole burst
    expect(sent()).toBe(4); // 3 in-flight requests + 1 check; nothing more
    expect(authBlockStatus(USER)).toMatchObject({ failures: 1, held: false });
  });
});
