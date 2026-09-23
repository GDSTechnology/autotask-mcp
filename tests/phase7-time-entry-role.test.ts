// Ticket/task time entries require a roleID. resolveWorkTimeEntryRole picks the
// resource's default role, or its sole role, else returns a selection list
// (roleID → canonical name) — never guesses. Service mocked.

jest.mock('autotask-node', () => ({
  AutotaskClient: { create: jest.fn().mockRejectedValue(new Error('Mock: no API')) },
}));

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' } };
const mk = () => new AutotaskService(config, new Logger('error'));

describe('resolveWorkTimeEntryRole', () => {
  test('uses the default service-desk role when the resource has one', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue([
      { roleID: 10, roleName: 'Tech', isDefaultServiceDeskRole: false },
      { roleID: 20, roleName: 'Lead', isDefaultServiceDeskRole: true },
    ]);
    expect(await s.resolveWorkTimeEntryRole(1)).toEqual({ roleID: 20 });
  });

  test('uses the sole role when there is only one (no default flagged)', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue([{ roleID: 10, roleName: 'Tech', isDefaultServiceDeskRole: false }]);
    expect(await s.resolveWorkTimeEntryRole(1)).toEqual({ roleID: 10 });
  });

  test('returns a selection list when multiple roles and no default — never guesses', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue([
      { roleID: 10, roleName: 'Tech', isDefaultServiceDeskRole: false },
      { roleID: 20, roleName: 'Lead', isDefaultServiceDeskRole: false },
    ]);
    const r = await s.resolveWorkTimeEntryRole(1) as any;
    expect(r.needsSelection).toEqual([
      { roleID: 10, roleName: 'Tech', isDefault: false },
      { roleID: 20, roleName: 'Lead', isDefault: false },
    ]);
    expect(r.roleID).toBeUndefined();
  });

  test('errors (does not guess) when the resource has no roles', async () => {
    const s = mk();
    jest.spyOn(s, 'getResourceRoles').mockResolvedValue([]);
    const r = await s.resolveWorkTimeEntryRole(1) as any;
    expect(r.error).toMatch(/no roles assigned/);
  });
});

describe('create_time_entry handler role wiring', () => {
  const { AutotaskToolHandler } = require('../src/handlers/tool.handler');
  test('auto-fills the default role for a ticket time entry, then creates', async () => {
    const s = mk();
    jest.spyOn(s, 'resolveWorkTimeEntryRole').mockResolvedValue({ roleID: 20 } as any);
    const create = jest.spyOn(s, 'createTimeEntry').mockResolvedValue(555 as any);
    const h = new AutotaskToolHandler(s, new Logger('error'));
    await h.callTool('autotask_create_time_entry', { resourceID: 1, ticketID: 204722, dateWorked: '2026-09-22', hoursWorked: 0.25, summaryNotes: 'x' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][0]).toEqual(expect.objectContaining({ roleID: 20, ticketID: 204722 }));
  });

  test('returns a pick (no write) when the resource has multiple roles', async () => {
    const s = mk();
    jest.spyOn(s, 'resolveWorkTimeEntryRole').mockResolvedValue({ needsSelection: [{ roleID: 10, roleName: 'Tech', isDefault: false }, { roleID: 20, roleName: 'Lead', isDefault: false }] } as any);
    const create = jest.spyOn(s, 'createTimeEntry').mockResolvedValue(555 as any);
    const h = new AutotaskToolHandler(s, new Logger('error'));
    const res = await h.callTool('autotask_create_time_entry', { resourceID: 1, ticketID: 204722, hoursWorked: 0.25 });
    expect(create).not.toHaveBeenCalled();
    const text = JSON.stringify(res);
    expect(text).toMatch(/multiple roles/);
    expect(text).toMatch(/10 = Tech/);
    expect(text).toMatch(/20 = Lead/);
  });

  test('an explicit roleID is respected without resolution', async () => {
    const s = mk();
    const resolve = jest.spyOn(s, 'resolveWorkTimeEntryRole');
    const create = jest.spyOn(s, 'createTimeEntry').mockResolvedValue(556 as any);
    const h = new AutotaskToolHandler(s, new Logger('error'));
    await h.callTool('autotask_create_time_entry', { resourceID: 1, ticketID: 204722, roleID: 99, hoursWorked: 0.25 });
    expect(resolve).not.toHaveBeenCalled();
    expect(create.mock.calls[0][0]).toEqual(expect.objectContaining({ roleID: 99 }));
  });
});
