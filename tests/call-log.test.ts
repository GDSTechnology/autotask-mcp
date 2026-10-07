// Admin console "Calls" log: tool calls carry their caller + outcome, Autotask
// calls are linked to the tool call (or background job) that made them, cache /
// shadow answers are counted, and nothing outside the scope leaks in.

import { runToolCall, runJob, noteToolAudit, noteCacheHit, noteShadowRead, startApiCall, recentToolCalls, recentApiCalls, callerSummary, cleanPath, _resetCallLog } from '../src/services/call-log';

beforeEach(() => _resetCallLog());

describe('call log', () => {
  test('a tool call records caller, outcome and the Autotask calls it made', async () => {
    await runToolCall('autotask_search_tickets', async () => {
      startApiCall('POST', '/Tickets/query')(200);
      startApiCall('GET', 'https://webservices1.autotask.net/ATServicesRest/v1.0/Tickets/5?x=1')(404);
      noteCacheHit(); noteShadowRead();
      noteToolAudit({ outcome: 'ok', durationMs: 12, source: 'n8n', ip: '172.18.0.5', userAgent: 'n8n' });
      return { isError: false };
    });
    const [t] = recentToolCalls();
    expect(t).toMatchObject({ tool: 'autotask_search_tickets', outcome: 'ok', source: 'n8n', ip: '172.18.0.5', apiCalls: 2, cacheHits: 1, shadowReads: 1, durationMs: 12 });
    const calls = recentApiCalls({ toolCallId: t!.id });
    expect(calls.map((c) => `${c.method} ${c.path} ${c.status}`)).toEqual(['GET /Tickets/5 404', 'POST /Tickets/query 200']);
    expect(calls[0]!.tool).toBe('autotask_search_tickets');
  });

  test('a thrown tool call is an error; isError without an audit record is an error', async () => {
    await expect(runToolCall('autotask_x', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await runToolCall('autotask_y', async () => ({ isError: true }));
    expect(recentToolCalls().map((r) => [r.tool, r.outcome])).toEqual([['autotask_y', 'error'], ['autotask_x', 'error']]);
    expect(recentToolCalls({ errorsOnly: true })).toHaveLength(2);
  });

  test('background jobs are labelled; calls outside any scope are "other background"', async () => {
    await runJob('shadow sync', async () => { startApiCall('POST', '/Tickets/query')(200); startApiCall('POST', '/Tickets/query')(429); });
    startApiCall('GET', '/Version')(0, 'timeout');
    const s = callerSummary(60);
    expect(s.background).toEqual(expect.arrayContaining([
      expect.objectContaining({ job: 'shadow sync', apiCalls: 2, errors: 1 }),
      expect.objectContaining({ job: 'other background', apiCalls: 1, errors: 1 }),
    ]));
    expect(recentApiCalls({ errorsOnly: true }).map((c) => c.status)).toEqual([0, 429]);
  });

  test('summary groups by declared source + origin; filters by tool and source', async () => {
    for (const [src, ua] of [['n8n', 'n8n'], ['n8n', 'n8n'], ['chatgpt', 'openai']]) {
      await runToolCall('autotask_get_ticket_by_number', async () => { noteToolAudit({ outcome: 'ok', durationMs: 1, source: src!, userAgent: ua }); return {}; });
    }
    const s = callerSummary(60);
    expect(s.callers.map((c) => [c.source, c.calls])).toEqual([['n8n', 2], ['chatgpt', 1]]);
    expect(recentToolCalls({ source: 'chatgpt' })).toHaveLength(1);
    expect(recentToolCalls({ tool: 'ticket_by' })).toHaveLength(3);
  });

  test('bounded: keeps the newest 500 tool calls', async () => {
    for (let i = 0; i < 520; i++) await runToolCall(`t${i}`, async () => ({}));
    const all = recentToolCalls({ limit: 1000 });
    expect(all).toHaveLength(500);
    expect(all[0]!.tool).toBe('t519');
  });

  test('paths are logged without host or query string', () => {
    expect(cleanPath('https://ws.autotask.net/ATServicesRest/v1.0/Tickets/query/next?paging=abc')).toBe('/Tickets/query/next');
    expect(cleanPath('Companies/5')).toBe('/Companies/5');
  });
});
