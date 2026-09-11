// Read-after-write verification primitive: AutotaskHttpClient.getWithRetry()
// (consolidated plan §2). A just-created entity can briefly 404 (Autotask read
// lag), so a single immediate read can falsely report "not found". getWithRetry
// retries ONLY a genuine null; it does not retry a payload anomaly (a truncated
// 2xx throws and must propagate), and it never blocks the common case where the
// entity is already visible.

import {
  AutotaskHttpClient,
  AutotaskResponseError,
  _resetRateLimitCooldowns,
} from '../src/services/autotask-http';
import { Logger } from '../src/utils/logger';
import { _resetZoneUrlCache } from '../src/utils/config';

const logger = new Logger('error');

function client(): AutotaskHttpClient {
  return new AutotaskHttpClient(
    'user@example.com',
    'secret',
    'integration-code',
    'https://webservices2.autotask.net/ATServicesRest/',
    logger
  );
}

interface Spec {
  status: number;
  body?: any;
  text?: string;
}
function res(spec: Spec): Response {
  return {
    ok: spec.status >= 200 && spec.status < 300,
    status: spec.status,
    headers: { get: () => null },
    text: async () => (spec.text !== undefined ? spec.text : spec.body !== undefined ? JSON.stringify(spec.body) : ''),
  } as unknown as Response;
}

/** Return each queued spec in turn (last one repeats). */
function mockSequence(specs: Spec[]): jest.SpyInstance {
  let i = 0;
  return jest.spyOn(global, 'fetch' as any).mockImplementation(() => {
    const spec = specs[Math.min(i, specs.length - 1)];
    i++;
    return Promise.resolve(res(spec) as any);
  });
}

beforeEach(() => {
  _resetRateLimitCooldowns();
  _resetZoneUrlCache();
});
afterEach(() => jest.restoreAllMocks());

describe('getWithRetry()', () => {
  it('returns the entity on the first read with no extra fetches', async () => {
    const spy = mockSequence([{ status: 200, body: { item: { id: 207193, title: 'x' } } }]);
    const item = await client().getWithRetry<{ id: number }>('Tasks', 207193, { attempts: 4, delayMs: 0 });
    expect(item).toMatchObject({ id: 207193 });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('retries a not-yet-visible entity (404) and succeeds once it appears', async () => {
    const spy = mockSequence([
      { status: 404, text: '{"errors":["not found"]}' },
      { status: 404, text: '{"errors":["not found"]}' },
      { status: 200, body: { item: { id: 207193, title: 'x' } } },
    ]);
    const item = await client().getWithRetry<{ id: number }>('Tasks', 207193, { attempts: 4, delayMs: 0 });
    expect(item).toMatchObject({ id: 207193 });
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('returns null after exhausting the attempt budget', async () => {
    const spy = mockSequence([{ status: 404, text: '{"errors":["not found"]}' }]);
    const item = await client().getWithRetry('Tasks', 207193, { attempts: 3, delayMs: 0 });
    expect(item).toBeNull();
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('treats a 200 { item: null } (Autotask not-found) as not-yet-visible and retries', async () => {
    const spy = mockSequence([{ status: 200, body: { item: null } }]);
    const item = await client().getWithRetry('Tasks', 207193, { attempts: 3, delayMs: 0 });
    expect(item).toBeNull();
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry a payload anomaly — a truncated 200 throws immediately', async () => {
    const spy = mockSequence([{ status: 200, text: '{"item":{"id":2071' }]);
    await expect(
      client().getWithRetry('Tasks', 207193, { attempts: 4, delayMs: 0 })
    ).rejects.toBeInstanceOf(AutotaskResponseError);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
