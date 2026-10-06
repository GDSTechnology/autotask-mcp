// Per-endpoint concurrency gate (Autotask thread limiting: 3 concurrent per
// integration per object endpoint, the 4th gets 429). Calls beyond the cap
// must WAIT, not fail; other endpoints are independent.

import { acquireEndpointSlot, endpointOf, endpointQueueDepth } from '../src/services/autotask-http';

describe('endpointOf', () => {
  test('object endpoint from relative paths, query/next pages and absolute URLs', () => {
    expect(endpointOf('/Tickets/query')).toBe('Tickets');
    expect(endpointOf('/Tickets/query/next?paging=abc')).toBe('Tickets');
    expect(endpointOf('/TimeEntries/55')).toBe('TimeEntries');
    expect(endpointOf('https://webservices3.autotask.net/atservicesrest/v1.0/Companies/5/Contacts')).toBe('Companies');
  });
});

describe('acquireEndpointSlot', () => {
  test('default cap 2: the third call on the same endpoint waits until one releases; others are independent', async () => {
    const a = await acquireEndpointSlot('t Tickets');
    const b = await acquireEndpointSlot('t Tickets');
    let thirdIn = false;
    const third = acquireEndpointSlot('t Tickets').then((rel) => { thirdIn = true; return rel; });
    const other = await acquireEndpointSlot('t Companies'); // a different endpoint is not blocked
    await new Promise((r) => setTimeout(r, 5));
    expect(thirdIn).toBe(false);
    expect(endpointQueueDepth()).toBe(1);
    a();
    const c = await third;
    expect(thirdIn).toBe(true);
    b(); c(); other();
    a(); // releasing twice is a no-op
    expect(endpointQueueDepth()).toBe(0);
  });

  test('AUTOTASK_MAX_CONCURRENT_PER_ENDPOINT=1 serialises; out-of-range values fall back to 2', async () => {
    process.env.AUTOTASK_MAX_CONCURRENT_PER_ENDPOINT = '1';
    try {
      const a = await acquireEndpointSlot('u Tasks');
      let second = false;
      const p = acquireEndpointSlot('u Tasks').then((r) => { second = true; return r; });
      await new Promise((r) => setTimeout(r, 5));
      expect(second).toBe(false);
      a(); (await p)();
      process.env.AUTOTASK_MAX_CONCURRENT_PER_ENDPOINT = '9'; // > Autotask's 3 → ignored
      const x = await acquireEndpointSlot('v Tasks'), y = await acquireEndpointSlot('v Tasks');
      let z = false;
      const pz = acquireEndpointSlot('v Tasks').then((r) => { z = true; return r; });
      await new Promise((r) => setTimeout(r, 5));
      expect(z).toBe(false);
      x(); (await pz)(); y();
    } finally { delete process.env.AUTOTASK_MAX_CONCURRENT_PER_ENDPOINT; }
  });
});
