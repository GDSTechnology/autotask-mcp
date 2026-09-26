// report_unbilled_time: billable time not yet approved for billing, per resource,
// aged, valued at the role's bill rate (null-survives when no rate).

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API')),
  },
}));

import { summarizeUnbilledTime, UnbilledTimeEntry } from '../src/utils/unbilled-time';
import { AutotaskService } from '../src/services/autotask.service';
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

describe('summarizeUnbilledTime (pure)', () => {
  const asOf = new Date('2026-09-25T00:00:00Z');
  const entries: UnbilledTimeEntry[] = [
    { id: 1, resourceID: 100, roleID: 9, dateWorked: '2026-09-20', createDateTime: '2026-09-22T00:00:00Z', hoursToBill: 2 }, // 5d old, lag 2
    { id: 2, resourceID: 100, roleID: 9, dateWorked: '2026-05-01', createDateTime: '2026-05-10T00:00:00Z', hoursToBill: 1 }, // >90d, lag 9
    { id: 3, resourceID: 200, roleID: 5, dateWorked: '2026-09-01', hoursWorked: 3 }, // 24d, no hoursToBill -> uses hoursWorked; no rate for role 5
    { id: 4, resourceID: 200, dateWorked: '2026-09-24', hoursToBill: 0 }, // 0 hours -> skipped
  ];

  test('aggregates hours, buckets, value at role rate, write-up lag, at-risk', () => {
    const out = summarizeUnbilledTime(entries, {
      asOf,
      rateByRole: new Map([[9, 150]]), // role 5 has NO rate
      nameByResource: new Map([[100, 'Jonathan Fitzgerald'], [200, 'Tech Two']]),
    });
    expect(out.totals.entries).toBe(3); // entry 4 skipped (0h)
    expect(out.totals.billableHours).toBe(6); // 2+1+3
    // value: role 9 -> 150; (2+1)*150 = 450; role 5 unrated
    expect(out.totals.estValue).toBe(450);
    expect(out.totals.hoursMissingRate).toBe(3); // the 3h at unrated role 5

    const jf = out.byResource.find((r) => r.resourceID === 100)!;
    expect(jf.resourceName).toBe('Jonathan Fitzgerald');
    expect(jf.billableHours).toBe(3);
    expect(jf.estValue).toBe(450);
    expect(jf.buckets['0-30']).toBe(2);
    expect(jf.buckets['90+']).toBe(1);
    expect(jf.avgWriteUpLagDays).toBe(5.5); // (2 + 9) / 2

    // at-risk = >30d hours = the 1h from 90+
    expect(out.totals.atRiskHours).toBe(1);
    // sorted by billableHours desc: 200 (3h) before 100 (3h) tie — both 3; order stable enough, just check presence
    expect(out.byResource.map((r) => r.resourceID).sort()).toEqual([100, 200]);
  });

  test('no rates anywhere -> estValue null, all hours in hoursMissingRate', () => {
    const out = summarizeUnbilledTime([{ id: 1, resourceID: 1, roleID: 9, dateWorked: '2026-09-20', hoursToBill: 4 }], { asOf });
    expect(out.totals.estValue).toBeNull();
    expect(out.totals.hoursMissingRate).toBe(4);
  });
});

describe('AutotaskService.reportUnbilledTime', () => {
  beforeEach(() => _resetZoneUrlCache());
  afterEach(() => jest.restoreAllMocks());

  test('queries unapproved billable time, resolves rates + names', async () => {
    const bodies: any[] = [];
    jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
      const url = args[0] as string; const init = (args[1] || {}) as RequestInit;
      if (/\/TimeEntries\/query$/.test(url)) {
        bodies.push(JSON.parse(String(init.body)));
        // return once, then empty (id-paged)
        if (bodies.length === 1) return Promise.resolve(res(200, { items: [
          { id: 11, resourceID: 100, roleID: 9, dateWorked: '2026-09-20', hoursToBill: 2, isNonBillable: false },
        ] }));
        return Promise.resolve(res(200, { items: [] }));
      }
      if (/\/Roles\/query$/.test(url)) return Promise.resolve(res(200, { items: [{ id: 9, name: 'Engineer', hourlyRate: 175 }] }));
      if (/\/Resources\/query$/.test(url)) return Promise.resolve(res(200, { items: [{ id: 100, firstName: 'Jonathan', lastName: 'Fitzgerald' }] }));
      return Promise.resolve(res(200, { items: [] }));
    });

    const out = await new AutotaskService(config, logger).reportUnbilledTime({ fromDate: '2026-09-01' });
    // the isNonBillable=false + notExist billingApprovalDateTime filters are present
    const f = bodies[0].filter;
    expect(f).toContainEqual({ op: 'eq', field: 'isNonBillable', value: false });
    expect(f).toContainEqual({ op: 'notExist', field: 'billingApprovalDateTime' });
    expect(out.totals.billableHours).toBe(2);
    expect(out.totals.estValue).toBe(350); // 2h * 175
    expect(out.byResource[0].resourceName).toBe('Jonathan Fitzgerald');
  });

  test('includeApproved drops the notExist filter', async () => {
    const bodies: any[] = [];
    jest.spyOn(global, 'fetch' as any).mockImplementation((...args: any[]) => {
      const url = args[0] as string; const init = (args[1] || {}) as RequestInit;
      if (/\/TimeEntries\/query$/.test(url)) { bodies.push(JSON.parse(String(init.body))); return Promise.resolve(res(200, { items: [] })); }
      return Promise.resolve(res(200, { items: [] }));
    });
    await new AutotaskService(config, logger).reportUnbilledTime({ includeApproved: true });
    expect(bodies[0].filter.find((x: any) => x.field === 'billingApprovalDateTime')).toBeUndefined();
    // guardrail: a default dateWorked lower bound is applied when no fromDate given
    expect(bodies[0].filter.find((x: any) => x.field === 'dateWorked' && x.op === 'gte')).toBeDefined();
  });
});
