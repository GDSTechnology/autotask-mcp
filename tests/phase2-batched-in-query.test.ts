// Tests for AutotaskHttpClient.queryByIds() — batched `in` queries (brief §7.19).
//
// Autotask's hourly workflow chunks ID lists into groups of 200 before querying
// (ServiceCallTickets by serviceCallID, Tickets by id, etc.). queryByIds
// centralizes that: dedupe + deterministic sort → 200-sized `in` chunks → bounded
// concurrency → paginate each chunk → dedupe results by id → surface per-chunk
// failures instead of silently dropping them.

import { AutotaskHttpClient, _resetRateLimitCooldowns } from '../src/services/autotask-http';
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
}

function res(spec: MockResponseSpec): Response {
  return {
    ok: spec.status >= 200 && spec.status < 300,
    status: spec.status,
    headers: { get: () => null },
    text: async () =>
      spec.text !== undefined ? spec.text : spec.body !== undefined ? JSON.stringify(spec.body) : '',
  } as unknown as Response;
}

/**
 * Body-aware mock for POST /{entity}/query. `handler` receives the entity name
 * and the `in` filter's value array so each chunk can return tailored rows.
 */
function mockQuery(
  handler: (entity: string, inValues: Array<number | string>) => MockResponseSpec
): jest.SpyInstance {
  return jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
    const url = args[0] as string;
    const init = (args[1] || {}) as RequestInit;
    const m = new URL(url).pathname.match(/\/v1\.0\/([A-Za-z]+)\/query$/);
    if (init.method !== 'POST' || !m) {
      return Promise.resolve(res({ status: 599, text: `unexpected: ${init.method} ${url}` }));
    }
    const body = JSON.parse(init.body as string);
    const inFilter = (body.filter || []).find((f: any) => f.op === 'in');
    return Promise.resolve(res(handler(m[1], inFilter?.value ?? [])));
  });
}

/** The `in` value array sent by each POST /query call, in call order. */
function inValuesPerCall(fetchMock: jest.SpyInstance): Array<Array<number | string>> {
  return fetchMock.mock.calls.map((c: any[]) => {
    const body = JSON.parse((c[1] as RequestInit).body as string);
    return (body.filter || []).find((f: any) => f.op === 'in')?.value ?? [];
  });
}

beforeEach(() => {
  _resetZoneUrlCache();
  _resetRateLimitCooldowns();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('queryByIds() batching (§7.19)', () => {
  test('chunks a >200 id list into 200-sized `in` queries and merges results', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => i + 1);
    const fetchMock = mockQuery((_entity, values) => ({
      status: 200,
      body: { items: values.map((id) => ({ id, name: `n${id}` })) },
    }));

    const result = await client().queryByIds<{ id: number; name: string }>('Tickets', 'id', ids);

    expect(result.failedChunks).toEqual([]);
    expect(result.items).toHaveLength(450);
    // 3 chunks: 200 + 200 + 50.
    const sizes = inValuesPerCall(fetchMock).map((v) => v.length);
    expect(sizes).toEqual([200, 200, 50]);
  });

  test('deduplicates and deterministically sorts input ids before chunking', async () => {
    const fetchMock = mockQuery((_entity, values) => ({
      status: 200,
      body: { items: values.map((id) => ({ id })) },
    }));

    await client().queryByIds('Tickets', 'id', [5, 5, 3, 3, 1, 2]);

    // One chunk (default size 200), ids deduped and ascending.
    expect(inValuesPerCall(fetchMock)).toEqual([[1, 2, 3, 5]]);
  });

  test('respects a custom chunkSize', async () => {
    const fetchMock = mockQuery((_entity, values) => ({
      status: 200,
      body: { items: values.map((id) => ({ id })) },
    }));

    await client().queryByIds('ServiceCallTickets', 'serviceCallID', [1, 2, 3, 4, 5], { chunkSize: 2 });

    expect(inValuesPerCall(fetchMock)).toEqual([[1, 2], [3, 4], [5]]);
  });

  test('surfaces a failed chunk in failedChunks without aborting the others', async () => {
    const fetchMock = mockQuery((_entity, values) => {
      if (values.includes(3)) return { status: 500, body: { errors: ['boom'] } };
      return { status: 200, body: { items: values.map((id) => ({ id })) } };
    });

    const result = await client().queryByIds<{ id: number }>('Tickets', 'id', [1, 2, 3, 4], {
      chunkSize: 2,
    });

    // Chunk [1,2] succeeds; chunk [3,4] fails.
    expect(result.items.map((r) => r.id)).toEqual([1, 2]);
    expect(result.failedChunks).toHaveLength(1);
    expect(result.failedChunks[0].ids).toEqual([3, 4]);
    expect(result.failedChunks[0].error).toMatch(/500/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('deduplicates returned rows by id across chunks', async () => {
    // Every chunk returns a shared row id 99 plus a chunk-specific row.
    const fetchMock = mockQuery((_entity, values) => ({
      status: 200,
      body: { items: [{ id: 99 }, { id: Number(values[0]) * 10 }] },
    }));

    const result = await client().queryByIds<{ id: number }>('Tickets', 'id', [1, 2], { chunkSize: 1 });

    const idCounts = result.items.reduce<Record<number, number>>((acc, r) => {
      acc[r.id] = (acc[r.id] || 0) + 1;
      return acc;
    }, {});
    expect(idCounts[99]).toBe(1); // shared row appears once
    expect(result.items.map((r) => r.id).sort((a, b) => a - b)).toEqual([10, 20, 99]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('empty id list makes no request', async () => {
    const fetchMock = mockQuery(() => ({ status: 200, body: { items: [] } }));

    const result = await client().queryByIds('Tickets', 'id', []);

    expect(result).toEqual({ items: [], failedChunks: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
