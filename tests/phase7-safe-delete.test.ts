// Guarded deletion of time entries and tasks: dry-run-first, destructive
// (confirm on execute), timesheet/posted lock detection with a clear reason,
// no-cascade task delete, orchestrated task+time cleanup, idempotency.

jest.mock('autotask-node', () => ({
  AutotaskClient: {
    create: jest.fn().mockRejectedValue(new Error('Mock: Cannot connect to Autotask API')),
  },
}));

import { classifyTimesheetStatusLabel, classifyLockError, isLocked } from '../src/utils/timesheet-lock';
import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = {
  name: 'test-server', version: '0.0.0',
  autotask: { username: 'user@example.com', secret: 'secret', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' },
};

function res(status: number, body?: any): Response {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => (body !== undefined ? JSON.stringify(body) : '') } as unknown as Response;
}
// Handler dispatch triggers MappingService enrichment — keep it offline.
beforeEach(() => { jest.spyOn(global, 'fetch' as any).mockImplementation(() => Promise.resolve(res(200, { items: [] }))); });
afterEach(() => jest.restoreAllMocks());

function textOf(r: any) { return r.content[0].text as string; }

describe('timesheet-lock util', () => {
  test('classifies status labels', () => {
    expect(classifyTimesheetStatusLabel('Open')).toBe('open');
    expect(classifyTimesheetStatusLabel('Locked waiting for approval')).toBe('timesheet_pending_approval');
    expect(classifyTimesheetStatusLabel('Locked has been approved')).toBe('timesheet_approved');
    expect(classifyTimesheetStatusLabel('')).toBe('unknown');
  });
  test('classifies Autotask lock error messages', () => {
    expect(classifyLockError('Cannot delete: the timesheet has been approved')).toBe('timesheet_approved');
    expect(classifyLockError('Timesheet is submitted and awaiting approval')).toBe('timesheet_pending_approval');
    expect(classifyLockError('This time has been posted')).toBe('billing_posted');
    expect(classifyLockError('some unrelated error')).toBeNull();
  });
  test('isLocked', () => {
    expect(isLocked('open')).toBe(false);
    expect(isLocked('billing_posted')).toBe(true);
  });
});

describe('confirm gate exempts dry-run', () => {
  test('delete_time_entry dry-run needs no confirm; execute without confirm is gated', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'getTimeEntry').mockResolvedValue({ id: 54827, resourceID: 1, dateWorked: '2026-08-12', hoursWorked: 0.6667 } as any);
    jest.spyOn(svc, 'assessTimeEntryLock').mockResolvedValue({ locked: false, state: 'open' });
    const del = jest.spyOn(svc, 'deleteTimeEntry').mockResolvedValue();
    const handler = new AutotaskToolHandler(svc, logger);

    const dry = await handler.callTool('autotask_delete_time_entry', { id: 54827 }); // dryRun defaults true
    expect(textOf(dry)).toContain('DRY RUN');
    expect(del).not.toHaveBeenCalled();

    const noConfirm = await handler.callTool('autotask_delete_time_entry', { id: 54827, dryRun: false });
    expect(textOf(noConfirm).toLowerCase()).toContain('confirm');
    expect(del).not.toHaveBeenCalled();
  });
});

describe('delete_time_entry', () => {
  test('blocks a posted (billing-approved) entry with a clear reason', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'getTimeEntry').mockResolvedValue({ id: 5, resourceID: 1, dateWorked: '2026-08-12', billingApprovalDateTime: '2026-08-13T00:00:00Z' } as any);
    // assessTimeEntryLock is real: billingApprovalDateTime -> billing_posted
    const del = jest.spyOn(svc, 'deleteTimeEntry').mockResolvedValue();
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_delete_time_entry', { id: 5, dryRun: false, confirm: true });
    expect(textOf(r)).toMatch(/posted|billing-approved/i);
    expect(del).not.toHaveBeenCalled();
  });

  test('executes on an open entry and verifies removal', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'getTimeEntry').mockResolvedValueOnce({ id: 54827, resourceID: 1, dateWorked: '2026-08-12' } as any).mockResolvedValueOnce(null);
    jest.spyOn(svc, 'assessTimeEntryLock').mockResolvedValue({ locked: false, state: 'open' });
    const del = jest.spyOn(svc, 'deleteTimeEntry').mockResolvedValue();
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_delete_time_entry', { id: 54827, dryRun: false, confirm: true });
    expect(del).toHaveBeenCalledWith(54827, { asResourceID: 1 }); // as the owner
    expect(textOf(r)).toContain('Deleted time entry 54827');
  });

  test("deletes AS the entry's owner (impersonation) — Autotask allows only the owner", async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'getTimeEntry').mockResolvedValueOnce({ id: 54827, resourceID: 30683880, dateWorked: '2026-08-12' } as any).mockResolvedValueOnce(null);
    jest.spyOn(svc, 'assessTimeEntryLock').mockResolvedValue({ locked: false, state: 'open' });
    // Capture the impersonation context active during the delete.
    let impersonatedAs: number | undefined;
    jest.spyOn(svc, 'deleteTimeEntry').mockImplementation(async (_id: number, opts?: { asResourceID?: number }) => { impersonatedAs = opts?.asResourceID; });
    const handler = new AutotaskToolHandler(svc, logger);
    await handler.callTool('autotask_delete_time_entry', { id: 54827, dryRun: false, confirm: true });
    expect(impersonatedAs).toBe(30683880); // the owner, not the caller
  });

  test('maps a timesheet-lock error thrown by Autotask at delete time', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'getTimeEntry').mockResolvedValue({ id: 9, resourceID: 1, dateWorked: '2026-08-12' } as any);
    jest.spyOn(svc, 'assessTimeEntryLock').mockResolvedValue({ locked: false, state: 'unknown' });
    jest.spyOn(svc, 'deleteTimeEntry').mockRejectedValue(new Error('The timesheet has been approved and is locked'));
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_delete_time_entry', { id: 9, dryRun: false, confirm: true });
    expect(textOf(r)).toMatch(/approved/i);
  });

  test('idempotent: missing entry -> already_deleted', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'getTimeEntry').mockResolvedValue(null);
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_delete_time_entry', { id: 123, dryRun: false, confirm: true });
    expect(textOf(r)).toContain('already deleted');
  });
});

describe('delete_task (no cascade)', () => {
  test('blocked when time entries are attached', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'inspectTaskForDelete').mockResolvedValue({
      task: { id: 191111, taskNumber: 'T20260407.0062', title: 'RPO Meeting - 8/12/2026', projectID: 169 } as any,
      timeEntries: [{ id: 54827 }, { id: 54981 }], notes: [], attachments: [], secondaryResources: [], dependencies: [],
    });
    const del = jest.spyOn(svc, 'deleteTaskById').mockResolvedValue();
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_delete_task', { id: 191111, dryRun: false, confirm: true });
    expect(textOf(r)).toContain('54827');
    expect(textOf(r)).toContain('54981');
    expect(del).not.toHaveBeenCalled();
  });

  test('deletes an unattached task and verifies', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'inspectTaskForDelete').mockResolvedValue({
      task: { id: 5, taskNumber: 'T1', title: 'x', projectID: 9 } as any,
      timeEntries: [], notes: [], attachments: [], secondaryResources: [], dependencies: [],
    });
    const del = jest.spyOn(svc, 'deleteTaskById').mockResolvedValue();
    jest.spyOn(svc, 'getTask').mockResolvedValue(null);
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_delete_task', { id: 5, dryRun: false, confirm: true });
    expect(del).toHaveBeenCalledWith(5, 9);
    expect(textOf(r)).toContain('Deleted task 5');
  });
});

describe('delete_task_with_time (orchestrated)', () => {
  const invOpen = {
    task: { id: 191111, taskNumber: 'T20260407.0062', title: 'RPO Meeting - 8/12/2026', projectID: 169 } as any,
    timeEntries: [{ id: 54827, resourceID: 1, dateWorked: '2026-08-12', hoursWorked: 0.6667 }, { id: 54981, resourceID: 2, dateWorked: '2026-08-24', hoursWorked: 0.6667 }],
    notes: [], attachments: [], secondaryResources: [], dependencies: [],
  };

  test('dry-run returns the ordered plan, deletes nothing', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'inspectTaskForDelete').mockResolvedValue(invOpen);
    jest.spyOn(svc, 'getTimeEntry').mockResolvedValue({ id: 0, resourceID: 1, dateWorked: '2026-08-12' } as any);
    jest.spyOn(svc, 'assessTimeEntryLock').mockResolvedValue({ locked: false, state: 'open' });
    const delTE = jest.spyOn(svc, 'deleteTimeEntry').mockResolvedValue();
    const delTask = jest.spyOn(svc, 'deleteTaskById').mockResolvedValue();
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_delete_task_with_time', { taskId: 191111 });
    expect(textOf(r)).toContain('DRY RUN');
    expect(delTE).not.toHaveBeenCalled();
    expect(delTask).not.toHaveBeenCalled();
  });

  test('executes: deletes both entries then the task', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'inspectTaskForDelete')
      .mockResolvedValueOnce(invOpen) // initial
      .mockResolvedValueOnce({ ...invOpen, timeEntries: [] }); // recheck: no time left
    jest.spyOn(svc, 'getTimeEntry').mockResolvedValue({ id: 0, resourceID: 1, dateWorked: '2026-08-12' } as any);
    jest.spyOn(svc, 'assessTimeEntryLock').mockResolvedValue({ locked: false, state: 'open' });
    const delTE = jest.spyOn(svc, 'deleteTimeEntry').mockResolvedValue();
    const delTask = jest.spyOn(svc, 'deleteTaskById').mockResolvedValue();
    jest.spyOn(svc, 'getTask').mockResolvedValue(null);
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_delete_task_with_time', { taskId: 191111, dryRun: false, confirm: true });
    expect(delTE).toHaveBeenCalledTimes(2);
    expect(delTask).toHaveBeenCalledWith(191111, 169);
    expect(textOf(r)).toContain('Deleted 2 time entr');
  });

  test('locked entry blocks the whole cleanup (task not deleted)', async () => {
    const svc = new AutotaskService(config, logger);
    jest.spyOn(svc, 'inspectTaskForDelete').mockResolvedValue(invOpen);
    jest.spyOn(svc, 'getTimeEntry').mockResolvedValue({ id: 0, resourceID: 1, dateWorked: '2026-08-12' } as any);
    jest.spyOn(svc, 'assessTimeEntryLock').mockResolvedValue({ locked: true, state: 'timesheet_approved', reason: 'locked (approved)' });
    const delTask = jest.spyOn(svc, 'deleteTaskById').mockResolvedValue();
    const handler = new AutotaskToolHandler(svc, logger);
    const r = await handler.callTool('autotask_delete_task_with_time', { taskId: 191111, dryRun: false, confirm: true });
    expect(delTask).not.toHaveBeenCalled();
    expect(textOf(r).toLowerCase()).toContain('not deleted');
  });
});
