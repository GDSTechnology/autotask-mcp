// Regression (2026-10-09): n8n changes tickets with raw_request PATCH /Tickets
// and reads them back to verify. The write reached the shadow's write listener
// as an absolute URL, so the row was never marked dirty and the read-back was
// served from the stale mirror ("companyID update did not verify"). A raw write
// must make the following raw read go to Autotask.

import { AutotaskHttpClient, setReadInterceptor, setWriteListener, _resetRateLimitCooldowns } from '../src/services/autotask-http';
import { writtenRow } from '../src/db/shadow-runtime';
import { Logger } from '../src/utils/logger';

const logger = new Logger('error');
afterEach(() => { setReadInterceptor(null); setWriteListener(null); });

test('raw PATCH marks the row written; the raw read-back then goes live and sees the new value', async () => {
  _resetRateLimitCooldowns();
  let autotaskPriority = 2; // what Autotask holds
  global.fetch = jest.fn(async (_url: string, init: RequestInit) => {
    if (init.method === 'PATCH') { autotaskPriority = JSON.parse(String(init.body)).priority; return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ itemId: 210669 }) } as unknown as Response; }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ item: { id: 210669, priority: autotaskPriority } }) } as unknown as Response;
  }) as unknown as typeof fetch;

  // Minimal shadow wiring, as initShadow does it: writes mark rows dirty; dirty rows aren't served.
  const dirty = new Set<string>();
  setWriteListener((method, path, body, response) => {
    const w = writtenRow(path, body, response);
    if (method !== 'GET' && w) dirty.add(`${w.entity}:${w.id}`);
  });
  const stale = { id: 210669, priority: 2 }; // the mirror's copy from before the write
  setReadInterceptor({ query: async () => null, get: async (_t, e, id) => (dirty.has(`${e}:${id}`) ? undefined : stale) });

  const c = new AutotaskHttpClient('api@example.com', 's', 'ic', 'https://webservices3.autotask.net/ATServicesRest/', logger);
  expect(await c.rawRequest('GET', '/Tickets/210669')).toEqual({ item: stale }); // before any write: mirror answers
  await c.rawRequest('PATCH', '/Tickets', { id: 210669, priority: 1 });
  expect(dirty.has('Tickets:210669')).toBe(true);
  expect(await c.rawRequest('GET', '/Tickets/210669')).toEqual({ item: { id: 210669, priority: 1 } }); // verified against Autotask
});
