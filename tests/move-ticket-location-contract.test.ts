// move_ticket_to_company for n8n's Blackpoint sorting flow (2026-10-09): a
// chosen location of the target company (the matched contact's site), and the
// contract cleared — validated and reported — when it belongs to another
// company. update_ticket verifies UDFs (BP-Status / Nexus-Status) on read-back.

jest.mock('autotask-node', () => ({
  AutotaskClient: { create: jest.fn().mockRejectedValue(new Error('Mock: no API')) },
}));

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import { _resetZoneUrlCache } from '../src/utils/config';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices3.autotask.net/ATServicesRest/' } };
const res = (status: number, body: unknown) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(body) }) as unknown as Response;

function mock(initial: Record<string, unknown>, locations: unknown[], contracts: Record<number, { companyID: number }> = {}) {
  let ticket = { ...initial };
  const patches: unknown[] = [];
  const spy = jest.spyOn(global, 'fetch' as any).mockImplementation((...args: unknown[]) => {
    const url = args[0] as string; const init = (args[1] || {}) as RequestInit;
    const path = new URL(url).pathname; const method = init.method || 'GET';
    if (method === 'GET' && /\/Tickets\/\d+$/.test(path)) return Promise.resolve(res(200, { item: ticket }));
    if (method === 'POST' && /\/CompanyLocations\/query$/.test(path)) return Promise.resolve(res(200, { items: locations }));
    const c = /\/Contracts\/(\d+)$/.exec(path);
    if (method === 'GET' && c) return Promise.resolve(res(200, { item: contracts[Number(c[1])] ? { id: Number(c[1]), ...contracts[Number(c[1])] } : null }));
    if (method === 'PATCH' && /\/Tickets$/.test(path)) { const b = JSON.parse(init.body as string); patches.push(b); ticket = { ...ticket, ...b }; return Promise.resolve(res(200, { itemId: ticket.id })); }
    return Promise.resolve(res(599, { errors: [`unexpected ${method} ${path}`] }));
  });
  return { spy, patches, current: () => ticket };
}

beforeEach(() => _resetZoneUrlCache());
afterEach(() => jest.restoreAllMocks());

const LOCS = [{ id: 900, companyID: 222, isPrimary: true, isActive: true }, { id: 901, companyID: 222, isPrimary: false, isActive: true }];

describe('move_ticket_to_company', () => {
  test('a given location of the target company is used (not the primary)', async () => {
    const m = mock({ id: 1, companyID: 111, companyLocationID: 5, contactID: null }, LOCS);
    const out = await new AutotaskService(config, logger).moveTicketToCompany(1, 222, { companyLocationID: 901, contactID: 77 });
    expect(m.patches[0]).toMatchObject({ companyID: 222, companyLocationID: 901, contactID: 77 });
    expect(out).toMatchObject({ status: 'updated', verified: true, locationSource: 'given', companyLocationID: 901 });
  });

  test('a location of ANOTHER company is refused; nothing written', async () => {
    const m = mock({ id: 1, companyID: 111 }, LOCS);
    await expect(new AutotaskService(config, logger).moveTicketToCompany(1, 222, { companyLocationID: 5 })).rejects.toThrow(/not a location of company 222/);
    expect(m.patches).toHaveLength(0);
  });

  test("the old company's contract is cleared with the move and reported", async () => {
    const m = mock({ id: 1, companyID: 111, contractID: 55, contractServiceID: 66, contractServiceBundleID: null }, LOCS, { 55: { companyID: 111 } });
    const out = await new AutotaskService(config, logger).moveTicketToCompany(1, 222);
    expect(m.patches[0]).toMatchObject({ companyID: 222, contractID: null, contractServiceID: null, contractServiceBundleID: null });
    expect(out).toMatchObject({ status: 'updated', verified: true, contractID: null, contractCleared: { contractID: 55, contractServiceID: 66, contractCompanyID: 111 } });
    expect(String(out.message)).toMatch(/contract 55 cleared/);
  });

  test("a contract that already belongs to the target company is kept", async () => {
    const m = mock({ id: 1, companyID: 111, contractID: 77 }, LOCS, { 77: { companyID: 222 } });
    const out = await new AutotaskService(config, logger).moveTicketToCompany(1, 222);
    expect(m.patches[0]).not.toHaveProperty('contractID');
    expect(out.contractCleared).toBeUndefined();
    expect(out.contractID).toBe(77);
  });
});

describe('update_ticket verifies UDFs', () => {
  test('applied and not-applied UDFs are reported; verified reflects both', async () => {
    const s = new AutotaskService(config, logger);
    jest.spyOn(s, 'getFieldInfo').mockResolvedValue([]);
    jest.spyOn(s, 'updateTicket').mockResolvedValue(undefined);
    jest.spyOn(s, 'getTicket').mockResolvedValue({ id: 7, ticketNumber: 'T1', priority: 1, userDefinedFields: [{ name: 'BP-Status', value: '2' }, { name: 'Nexus-Status', value: '1' }] } as any);
    const call = async (args: Record<string, unknown>) => JSON.parse((await new AutotaskToolHandler(s, logger).callTool('autotask_update_ticket', { ticketId: 7, ...args })).content[0]!.text);
    const ok = await call({ priority: 1, userDefinedFields: [{ name: 'BP-Status', value: '2' }] });
    expect(ok.data.verified).toBe(true);
    expect(ok.data.changes).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'udf:BP-Status', to: '2', applied: true })]));
    const bad = await call({ userDefinedFields: [{ name: 'Nexus-Status', value: '4' }] });
    expect(bad.data.verified).toBe(false);
    expect(bad.message).toMatch(/did not apply: udf:Nexus-Status \(now 1\)/);
  });
});
