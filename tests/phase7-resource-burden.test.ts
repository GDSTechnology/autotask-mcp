// report_resource_burden: per-resource labour-burden basis (internalCost) +
// employment basis (payrollType/resourceType) for cost/utilisation pages.

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API')),
  },
}));

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';
import { _resetZoneUrlCache } from '../src/utils/config';

const logger = new Logger('error');
const config: McpServerConfig = {
  name: 'test-server', version: '0.0.0',
  autotask: { username: 'user@example.com', secret: 'secret', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' },
};

function res(status: number, body?: any): Response {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => (body !== undefined ? JSON.stringify(body) : '') } as unknown as Response;
}

// Mirrors the live payrollType picklist + resource rows.
function mockBurden(rows: any[]): { fetchMock: jest.SpyInstance; bodies: any[] } {
  const bodies: any[] = [];
  const fetchMock = jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
    const url = args[0] as string; const init = (args[1] || {}) as RequestInit;
    if (/\/Resources\/query$/.test(url)) { bodies.push(JSON.parse(String(init.body))); return Promise.resolve(res(200, { items: rows })); }
    if (/\/Resources\/entityInformation\/fields$/.test(url)) return Promise.resolve(res(200, { fields: [
      { name: 'payrollType', isPickList: true, picklistValues: [
        { value: '1', label: 'Salary', isActive: true }, { value: '2', label: 'Hourly', isActive: true },
        { value: '3', label: 'Contractor', isActive: true }, { value: '4', label: 'Salary Non Exempt', isActive: true },
      ] },
    ] }));
    return Promise.resolve(res(200, { items: [] }));
  });
  return { fetchMock, bodies };
}

beforeEach(() => _resetZoneUrlCache());
afterEach(() => jest.restoreAllMocks());

const ROWS = [
  { id: 30683829, firstName: 'Jonathan', lastName: 'Fitzgerald', email: 'jf@gds.com', isActive: true, internalCost: 150, payrollType: 1, resourceType: 'Employee', hireDate: '2015-07-01T00:00:00.000Z' },
  { id: 200, firstName: 'Bookkeeper', lastName: 'B', email: 'bk@gds.com', isActive: true, internalCost: 0, payrollType: 4, resourceType: 'Employee', hireDate: null },
  { id: 300, firstName: 'Contractor', lastName: 'C', email: 'cc@x.com', isActive: true, internalCost: 90, payrollType: 3, resourceType: 'Contractor', hireDate: null },
];

describe('reportResourceBurden', () => {
  test('active-only by default; resolves payrollType labels; flags missing cost', async () => {
    const svc = new AutotaskService(config, logger);
    const { bodies } = mockBurden(ROWS);
    const out = await svc.reportResourceBurden();

    // default filter is isActive = true
    expect(bodies[0].filter).toEqual([{ op: 'eq', field: 'isActive', value: true }]);
    expect(out.count).toBe(3);
    expect(out.withCost).toBe(2);
    expect(out.missingCost).toBe(1); // the bookkeeper with internalCost 0

    const jf = out.resources.find((r) => r.id === 30683829)!;
    expect(jf.internalCost).toBe(150);
    expect(jf.hasInternalCost).toBe(true);
    expect(jf.payrollTypeLabel).toBe('Salary');
    expect(jf.resourceType).toBe('Employee');
    expect(jf.hireDate).toBe('2015-07-01T00:00:00.000Z');

    const bk = out.resources.find((r) => r.id === 200)!;
    expect(bk.hasInternalCost).toBe(false); // internalCost 0
    expect(bk.payrollTypeLabel).toBe('Salary Non Exempt');
  });

  test('surfaces the fully-loaded-vs-wage caveat in notes', async () => {
    const svc = new AutotaskService(config, logger);
    mockBurden(ROWS);
    const out = await svc.reportResourceBurden();
    expect(out.notes.join(' ')).toMatch(/fully loaded|wage-only/i);
    expect(out.notes.join(' ')).toMatch(/per-hour/i);
  });

  test('includeInactive drops the isActive filter; resourceType + resourceIDs filter', async () => {
    const svc = new AutotaskService(config, logger);
    const { bodies } = mockBurden(ROWS);
    await svc.reportResourceBurden({ includeInactive: true, resourceType: 'Contractor', resourceIDs: [300] });
    const f = bodies[0].filter;
    expect(f).toContainEqual({ op: 'eq', field: 'resourceType', value: 'Contractor' });
    expect(f).toContainEqual({ op: 'in', field: 'id', value: [300] });
    expect(f.find((x: any) => x.field === 'isActive')).toBeUndefined();
  });
});

describe('autotask_report_resource_burden tool', () => {
  test('dispatches and summarises', async () => {
    const svc = new AutotaskService(config, logger);
    mockBurden(ROWS);
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_report_resource_burden', {});
    expect(r.content[0].text).toMatch(/3 resource\(s\): 2 with internalCost, 1 without/);
  });
});
