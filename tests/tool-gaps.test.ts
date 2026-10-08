// "Tool gaps": raw_request use per request shape (who, how often, failures),
// the existing tool that covers each shape (or none — a tool to build),
// fallbacks (a tool failed, then the same caller used raw_request), and the
// estimate of tenant traffic that never went through this MCP.

import { runToolCall, noteToolAudit, noteRawRequest, toolGapStats, rawShape, noteTenantUsage, outsideTraffic, _resetCallLog } from '../src/services/call-log';
import { coveringTool, toolGapReport } from '../src/admin/server';

beforeEach(() => _resetCallLog());

const raw = (method: string, path: string, outcome = 'ok', who = { source: 'unknown', ip: '172.19.0.3', userAgent: 'n8n' }, error?: string) =>
  runToolCall('autotask_raw_request', async () => { noteRawRequest(method, path); noteToolAudit({ outcome, durationMs: 1, ...who, error }); return { isError: outcome !== 'ok' }; });
const tool = (name: string, outcome: string, who = { source: 'unknown', ip: '172.19.0.3', userAgent: 'n8n' }, error?: string) =>
  runToolCall(name, async () => { noteToolAudit({ outcome, durationMs: 1, ...who, error }); return { isError: outcome !== 'ok' }; });

describe('tool gaps', () => {
  test('request shapes generalise ids and drop host/query', () => {
    expect(rawShape('post', '/Tickets/query')).toBe('POST /Tickets/query');
    expect(rawShape('GET', 'https://ws.autotask.net/ATServicesRest/v1.0/Tickets/210669/Notes?x=1')).toBe('GET /Tickets/{id}/Notes');
  });

  test('raw_request use is tallied per shape with callers and failures', async () => {
    for (let i = 0; i < 3; i++) await raw('POST', '/Tickets/query');
    await raw('PATCH', '/TicketNotes', 'error', undefined, 'HTTP 500: x');
    const g = toolGapStats(24);
    expect(g.raw.map((r) => [r.shape, r.calls, r.errors])).toEqual([['POST /Tickets/query', 3, 0], ['PATCH /TicketNotes', 1, 1]]);
    expect(g.raw[0]!.callers).toEqual([{ caller: 'unknown · 172.19.0.3 · n8n', count: 3 }]);
    expect(g.raw[1]!.lastError).toBe('HTTP 500: x');
  });

  test('fallback: a failed tool followed by raw_request from the same caller; another caller does not count', async () => {
    await tool('autotask_update_ticket', 'error', undefined, 'queueID is not writable');
    await raw('PATCH', '/Tickets');
    await tool('autotask_search_tickets', 'error', { source: 'chatgpt', ip: '10.0.0.9', userAgent: 'x' });
    await raw('POST', '/Tickets/query'); // n8n again — the chatgpt failure is not its fallback
    await tool('autotask_get_company', 'ok');
    await raw('GET', '/Companies/5'); // previous call succeeded — not a fallback
    expect(toolGapStats(24).fallbacks).toEqual([expect.objectContaining({ failedTool: 'autotask_update_ticket', thenRaw: 'PATCH /Tickets', count: 1, lastError: 'queueID is not writable' })]);
  });

  test('covering tool by naming convention, or none', () => {
    expect(coveringTool('POST /Tickets/query')).toBe('autotask_search_tickets');
    expect(coveringTool('GET /Tickets/{id}')).toBe('autotask_get_ticket_details');
    expect(coveringTool('PATCH /Tickets')).toBe('autotask_update_ticket');
    expect(coveringTool('POST /Tickets/{id}/Notes')).toBe('autotask_create_ticket_note');
    expect(coveringTool('POST /CompanyToDos/query')).toBe('autotask_search_company_todos');
    expect(coveringTool('PATCH /TicketNotes')).toBeNull();
  });

  test('not through this MCP: tenant total minus this MCP, with a 24 h average and peak', async () => {
    expect(outsideTraffic()).toBeNull();
    noteTenantUsage({ tenantUsed: 2600, limit: 10000, windowMinutes: 60, mcpLastHour: 2300 });
    noteTenantUsage({ tenantUsed: 3000, limit: 10000, windowMinutes: 60, mcpLastHour: 2000 });
    expect(outsideTraffic()).toMatchObject({ tenantCalls: 3000, mcpCalls: 2000, otherCalls: 1000, otherPct: 33.3, otherAvg24h: 650, otherMax24h: 1000, samples24h: 2 });
    await raw('POST', '/Tickets/query');
    const r = toolGapReport(24) as { raw: Array<{ coveredBy: string | null }>; outside: { otherCalls: number } };
    expect(r.raw[0]!.coveredBy).toBe('autotask_search_tickets');
    expect(r.outside.otherCalls).toBe(1000);
  });
});
