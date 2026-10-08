// Auth-failure pause (2026-10-07): a bad secret sent ~15 failed logins in
// seconds and Autotask locked the API user. After a confirmed 401 the tenant's
// calls must stop at the MCP until the pause ends; then exactly one probe is
// sent (no zone-retry), and success clears the pause.

import { AutotaskHttpClient, AutotaskAuthError, _resetRateLimitCooldowns, _resetAuthBlocks, authBlockStatus, clearAuthBlock } from '../src/services/autotask-http';
import { _resetHttpCache } from '../src/services/http-cache';
import { _resetZoneUrlCache } from '../src/utils/config';
import { Logger, recentLogs, _resetRecentLogs } from '../src/utils/logger';
import { toCsv } from '../src/admin/server';

const logger = new Logger('error');
const USER = 'api@example.com';
const BASE = 'https://webservices3.autotask.net/ATServicesRest/';
const client = () => new AutotaskHttpClient(USER, 'secret', 'ic', BASE, logger);
const resp = (status: number, body: unknown) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(body) }) as unknown as Response;
const apiCalls = () => (global.fetch as jest.Mock).mock.calls.filter((c) => !String(c[0]).includes('zoneInformation')).length;

let mode: 'unauthorized' | 'ok' | 'entity-only' = 'unauthorized';
beforeEach(() => {
  _resetHttpCache(); _resetRateLimitCooldowns(); _resetZoneUrlCache(); _resetAuthBlocks(); _resetRecentLogs();
  delete process.env.AUTOTASK_AUTH_PAUSE_SECONDS;
  mode = 'unauthorized';
  global.fetch = jest.fn(async (url: string) => {
    if (String(url).includes('zoneInformation')) return resp(200, { url: BASE, webUrl: 'https://ww3.autotask.net/' });
    if (mode === 'entity-only') return String(url).includes('ThresholdInformation') ? resp(200, { externalRequestThreshold: 10000 }) : resp(401, { errors: ['No access to this entity'] });
    return mode === 'ok' ? resp(200, { item: { id: 1 } }) : resp(401, { errors: ['Unauthorized'] });
  }) as unknown as typeof fetch;
});
afterEach(() => { jest.useRealTimers(); jest.restoreAllMocks(); });

describe('auth pause', () => {
  test('a 401 (after the one zone-retry) pauses the tenant: further calls never leave the MCP', async () => {
    const c = client();
    await expect(c.get('Tickets', 1)).rejects.toThrow(/\(HTTP 401\): Unauthorized\. Autotask calls are now paused for 300s/);
    expect(apiCalls()).toBe(3); // the call + its zone-retry + the ThresholdInformation confirmation
    for (let i = 0; i < 5; i++) await expect(c.get('Tickets', i + 2)).rejects.toThrow(/paused .* NOT sent/);
    expect(apiCalls()).toBe(3);
    const st = authBlockStatus(USER)!;
    expect(st).toMatchObject({ failures: 1, probing: false });
    expect(Date.parse(st.blockedUntil!) - Date.now()).toBeGreaterThan(290_000);
    expect(recentLogs().some((l) => l.level === 'error' && /pausing Autotask calls/.test(l.message))).toBe(true);
  });

  test('after the pause: one probe without zone-retry; a 401 doubles the pause; success clears it', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const c = client();
    await expect(c.get('Tickets', 1)).rejects.toBeInstanceOf(AutotaskAuthError);
    jest.setSystemTime(Date.now() + 301_000);
    await expect(c.get('Tickets', 2)).rejects.toBeInstanceOf(AutotaskAuthError);
    expect(apiCalls()).toBe(4); // probe = a single call (no zone-retry, no confirmation)
    const st = authBlockStatus(USER)!;
    expect(st.failures).toBe(2);
    expect(Date.parse(st.blockedUntil!) - Date.now()).toBeGreaterThan(590_000); // 10 min
    jest.setSystemTime(Date.now() + 601_000);
    mode = 'ok';
    expect(await c.get('Tickets', 3)).toEqual({ id: 1 });
    expect(authBlockStatus(USER)).toBeNull();
  });

  test('only one probe at a time once the pause has ended', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    const c = client();
    await expect(c.get('Tickets', 1)).rejects.toBeInstanceOf(AutotaskAuthError);
    jest.setSystemTime(Date.now() + 301_000);
    mode = 'ok';
    let release!: () => void;
    (global.fetch as jest.Mock).mockImplementationOnce(() => new Promise<Response>((r) => { release = () => r(resp(200, { item: { id: 9 } })); }));
    const probe = c.get('Tickets', 10);
    await expect(c.get('Tickets', 11)).rejects.toBeInstanceOf(AutotaskAuthError); // waits for the probe
    release();
    expect(await probe).toEqual({ id: 9 });
    expect(await c.get('Tickets', 12)).toEqual({ id: 1 });
  });

  test('admin "Retry now" clears the pause; AUTOTASK_AUTH_PAUSE_SECONDS=0 disables it', async () => {
    const c = client();
    await expect(c.get('Tickets', 1)).rejects.toBeInstanceOf(AutotaskAuthError);
    expect(clearAuthBlock(USER)).toBe(true);
    mode = 'ok';
    expect(await c.get('Tickets', 2)).toEqual({ id: 1 });

    _resetAuthBlocks(); mode = 'unauthorized';
    process.env.AUTOTASK_AUTH_PAUSE_SECONDS = '0';
    await expect(c.get('Tickets', 3)).rejects.toThrow(/HTTP 401/);
    expect(authBlockStatus(USER)).toBeNull();
  });
});

test('a 401 on one entity while the login works (ThresholdInformation 200) does NOT pause', async () => {
  mode = 'entity-only';
  const c = client();
  await expect(c.get('Tickets', 1)).rejects.toThrow(/HTTP 401: No access to this entity/);
  expect(authBlockStatus(USER)).toBeNull();
  await expect(c.get('Tickets', 2)).rejects.toThrow(/HTTP 401/); // still sent, not paused
});

describe('server log + export helpers', () => {
  test('warnings/errors are kept with credential-like fields redacted', () => {
    _resetRecentLogs();
    logger.warn('w', { apiSecret: 'xyz', Authorization: 'Bearer abc', ok: 1 });
    const [l] = recentLogs();
    expect(l!.meta).toBe('{"apiSecret":"[redacted]","Authorization":"[redacted]","ok":1}');
  });
  test('CSV quotes, escapes, and neutralises formulas', () => {
    expect(toCsv([{ a: 'x,y', b: '=HYPERLINK("e")', c: null, d: { k: 1 } }])).toBe('a,b,c,d\r\n"x,y","\'=HYPERLINK(""e"")",,"{""k"":1}"\r\n');
    expect(toCsv([])).toBe('');
  });
});
