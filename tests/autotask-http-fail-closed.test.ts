// Fail-closed read guard for AutotaskHttpClient (consolidated plan §2/§29/§31).
//
// A successful HTTP status is not the same as a usable entity payload. When a
// 2xx response carries an empty body, a body that aborts mid-read, or text that
// won't JSON.parse (truncation), the client must FAIL CLOSED with a distinct,
// retryable AutotaskResponseError — never return undefined/null/[], which reads
// as "not found" / "zero records" and hides successful writes (the exact
// Sanctuary Park read-back failure). Genuine emptiness (`{items:[]}`, a real
// 404, a void write's empty 2xx) must still pass through unharmed.

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
    // Pre-set apiUrl so baseUrl() resolves without a zone-info network round-trip.
    'https://webservices2.autotask.net/ATServicesRest/',
    logger
  );
}

interface MockResponseSpec {
  status: number;
  body?: any;
  text?: string;
  /** When true, response.text() rejects (aborted / dropped mid-stream). */
  textRejects?: boolean;
}

function res(spec: MockResponseSpec): Response {
  return {
    ok: spec.status >= 200 && spec.status < 300,
    status: spec.status,
    headers: { get: () => null },
    text: spec.textRejects
      ? async () => {
          throw new Error('The operation was aborted');
        }
      : async () =>
          spec.text !== undefined ? spec.text : spec.body !== undefined ? JSON.stringify(spec.body) : '',
  } as unknown as Response;
}

function mockFetch(spec: MockResponseSpec): jest.SpyInstance {
  return jest.spyOn(global, 'fetch' as any).mockResolvedValue(res(spec) as any);
}

/** Capture the (method, path) each write actually sent, for assertions. */
function mockFetchCapturing(spec: MockResponseSpec): { spy: jest.SpyInstance; calls: Array<{ method: string; url: string }> } {
  const calls: Array<{ method: string; url: string }> = [];
  const spy = jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
    const url = args[0] as string;
    const init = (args[1] || {}) as RequestInit;
    calls.push({ method: (init.method as string) || 'GET', url });
    return Promise.resolve(res(spec) as any);
  });
  return { spy, calls };
}

beforeEach(() => {
  _resetRateLimitCooldowns();
  _resetZoneUrlCache();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('get() — single-entity read fails closed on payload anomaly', () => {
  it('throws AutotaskResponseError on an empty 200 body (not null)', async () => {
    mockFetch({ status: 200, text: '' });
    await expect(client().get('Projects', 177)).rejects.toBeInstanceOf(AutotaskResponseError);
  });

  it('throws on a truncated JSON 200 body (not null)', async () => {
    mockFetch({ status: 200, text: '{"item":{"id":177,"projectName":"Camera Ser' });
    const err: any = await client().get("Projects", 177).catch((e: any) => e);
    expect(err).toBeInstanceOf(AutotaskResponseError);
    expect(err.message).toMatch(/truncated/i);
    expect(err.retryable).toBe(true);
  });

  it('throws when the body read aborts mid-stream (not null)', async () => {
    mockFetch({ status: 200, textRejects: true });
    await expect(client().get('Projects', 177)).rejects.toBeInstanceOf(AutotaskResponseError);
  });

  it('still returns the entity on a valid { item } 200 (regression)', async () => {
    mockFetch({ status: 200, body: { item: { id: 177, projectName: 'Camera Server Upgrades' } } });
    const proj = await client().get<{ id: number; projectName: string }>('Projects', 177);
    expect(proj).toMatchObject({ id: 177, projectName: 'Camera Server Upgrades' });
  });

  it('still returns null on a genuine 404 (regression)', async () => {
    mockFetch({ status: 404, text: '{"errors":["not found"]}' });
    await expect(client().get('Projects', 999999)).resolves.toBeNull();
  });
});

describe('query() — collection read fails closed on payload anomaly', () => {
  it('throws AutotaskResponseError on an empty 200 body (not [])', async () => {
    mockFetch({ status: 200, text: '' });
    await expect(
      client().query('Tasks', [{ op: 'eq', field: 'projectID', value: 177 }])
    ).rejects.toBeInstanceOf(AutotaskResponseError);
  });

  it('throws on a truncated JSON 200 body (not [])', async () => {
    mockFetch({ status: 200, text: '{"items":[{"id":207184},{"id":2071' });
    await expect(
      client().query('Tasks', [{ op: 'eq', field: 'projectID', value: 177 }])
    ).rejects.toBeInstanceOf(AutotaskResponseError);
  });

  it('returns rows on a valid { items } 200 (regression)', async () => {
    mockFetch({ status: 200, body: { items: [{ id: 207184 }, { id: 207185 }] } });
    const rows = await client().query<{ id: number }>('Tasks', [{ op: 'eq', field: 'projectID', value: 177 }]);
    expect(rows.map((r) => r.id)).toEqual([207184, 207185]);
  });

  it('returns [] on a genuine empty result set (must NOT over-fire)', async () => {
    mockFetch({ status: 200, body: { items: [] } });
    const rows = await client().query('Tasks', [{ op: 'eq', field: 'projectID', value: 424242 }]);
    expect(rows).toEqual([]);
  });
});

describe('void writes tolerate a legitimately empty 2xx body (no regression)', () => {
  it('update() resolves on an empty 200 body', async () => {
    const { calls } = mockFetchCapturing({ status: 200, text: '' });
    await expect(client().update('Tasks', 207184, { estimatedHours: 16 })).resolves.toBeUndefined();
    expect(calls[0].method).toBe('PATCH');
  });

  it('delete() resolves on an empty 200 body', async () => {
    mockFetch({ status: 200, text: '' });
    await expect(client().delete('TaskPredecessors', 5)).resolves.toBeUndefined();
  });

  it('update() still resolves when the body IS present', async () => {
    mockFetch({ status: 200, body: { itemId: 207184 } });
    await expect(client().update('Tasks', 207184, { title: 'x' })).resolves.toBeUndefined();
  });
});

describe('create() stays strict (fail closed, needs an itemId)', () => {
  it('throws AutotaskResponseError on an empty 200 body', async () => {
    mockFetch({ status: 200, text: '' });
    await expect(client().create('Tasks', { title: 'x', projectID: 177 })).rejects.toBeInstanceOf(
      AutotaskResponseError
    );
  });

  it('throws on a truncated create response', async () => {
    mockFetch({ status: 201, text: '{"itemI' });
    await expect(client().create('Tasks', { title: 'x' })).rejects.toBeInstanceOf(AutotaskResponseError);
  });

  it('returns the id on a valid create response (regression)', async () => {
    mockFetch({ status: 201, body: { itemId: 207193 } });
    await expect(client().create('Tasks', { title: 'x' })).resolves.toBe(207193);
  });
});

describe('error (non-2xx) responses are unchanged by the guard', () => {
  it('surfaces HTTP 500 as an Error, not an AutotaskResponseError', async () => {
    mockFetch({ status: 500, text: 'internal error' });
    const err: any = await client().get("Projects", 177).catch((e: any) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AutotaskResponseError);
    expect(err.message).toMatch(/HTTP 500/);
  });
});
