// #21 §9 staff tools: start_work_on_ticket, add_ticket_update, and the
// my_day upgrade (service calls, open To-Dos, missing-time gaps, sequential
// reads). Asserts the filters sent upstream and that nothing is written when
// validation fails.

jest.mock('autotask-node', () => ({
  AutotaskClient: { create: jest.fn().mockRejectedValue(new Error('Mock: no API')) },
}));

import { AutotaskService } from '../src/services/autotask.service';
import { AutotaskToolHandler } from '../src/handlers/tool.handler';
import { TOOL_DEFINITIONS } from '../src/handlers/tool.definitions';
import { Logger } from '../src/utils/logger';
import { findDuplicateNote, matchPicklist, serviceCallTimeGaps, windowStart } from '../src/utils/staff-tools';
import type { McpServerConfig } from '../src/types/mcp';

const logger = new Logger('error');
const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://x/ATServicesRest/' } };
const pv = (pairs: Array<[number, string]>) => pairs.map(([value, label]) => ({ value: String(value), label, isDefaultValue: false, sortOrder: 0, isActive: true, isSystem: false }));
const PICKLISTS: Record<string, any[]> = {
  'Tickets.status': pv([[1, 'New'], [5, 'Complete'], [7, 'Waiting Customer'], [8, 'In Progress'], [39, 'Waiting Customer stage 2']]),
  'TicketNotes.publish': pv([[1, 'All Autotask Users'], [2, 'Internal Project Team'], [4, 'Internal & Co-Managed']]),
  'TicketNotes.noteType': pv([[1, 'Task Summary'], [2, 'Task Detail'], [3, 'Task Notes']]),
};

function mkService(http: Record<string, any> = {}) {
  const s = new AutotaskService(config, logger);
  jest.spyOn(s as any, 'ensureClient').mockResolvedValue(http);
  jest.spyOn(s, 'getPicklistValues').mockImplementation(async (e: string, f: string) => PICKLISTS[`${e}.${f}`] ?? []);
  return s;
}
afterEach(() => jest.restoreAllMocks());

describe('staff-tools helpers', () => {
  const status = PICKLISTS['Tickets.status'];
  test('matchPicklist: id, exact label, unique partial; ambiguous/unknown → choices', () => {
    expect(matchPicklist(status, 8)).toMatchObject({ ok: true, value: 8, label: 'In Progress' });
    expect(matchPicklist(status, '8')).toMatchObject({ ok: true, value: 8 });
    expect(matchPicklist(status, 'in progress')).toMatchObject({ ok: true, value: 8 });
    expect(matchPicklist(status, 'progress')).toMatchObject({ ok: true, value: 8 });
    expect(matchPicklist(status, 'Waiting Customer')).toMatchObject({ ok: true, value: 7 }); // exact beats the "stage 2" partial
    const amb = matchPicklist(status, 'waiting');
    expect(amb.ok).toBe(false);
    expect(matchPicklist(status, 'Nope')).toMatchObject({ ok: false, requested: 'Nope' });
  });

  test('findDuplicateNote: same text (whitespace/case-insensitive) within 24 h only', () => {
    const now = new Date('2026-10-02T12:00:00Z');
    const notes = [
      { id: 1, title: 'Update', description: 'Replaced  the PSU', createDateTime: '2026-10-02T09:00:00Z' },
      { id: 2, title: 'Update', description: 'old', createDateTime: '2026-09-30T09:00:00Z' },
    ];
    expect(findDuplicateNote(notes, 'Update', 'replaced the psu', now)?.id).toBe(1);
    expect(findDuplicateNote(notes, 'Other title', 'Replaced the PSU', now)).toBeUndefined();
    expect(findDuplicateNote(notes, 'Update', 'old', now)).toBeUndefined(); // > 24 h ago
  });

  test('serviceCallTimeGaps: logged tickets and cancelled calls are not gaps', () => {
    const gaps = serviceCallTimeGaps([
      { serviceCallID: 1, ticketIDs: [10, 11], durationHours: 2, isComplete: false, canceled: false, startDateTime: '2026-10-02T14:00:00Z' },
      { serviceCallID: 2, ticketIDs: [12], durationHours: 1, isComplete: false, canceled: true },
    ], [{ ticketID: 10 }]);
    expect(gaps).toEqual([{ ticketID: 11, serviceCallIDs: [1], startDateTime: '2026-10-02T14:00:00Z', scheduledHours: 2, reason: 'service_call_without_time' }]);
  });

  test('serviceCallTimeGaps: one ticket on two calls is ONE gap (calls listed, hours summed, span widened)', () => {
    const gaps = serviceCallTimeGaps([
      { serviceCallID: 4818, ticketIDs: [208847], durationHours: 0.75, isComplete: true, canceled: false, startDateTime: '2026-09-30T18:00:00Z', endDateTime: '2026-09-30T18:45:00Z' },
      { serviceCallID: 4817, ticketIDs: [208847], durationHours: 1, isComplete: true, canceled: false, startDateTime: '2026-09-30T13:00:00Z', endDateTime: '2026-09-30T14:00:00Z' },
    ], []);
    expect(gaps).toEqual([{
      ticketID: 208847, serviceCallIDs: [4818, 4817], startDateTime: '2026-09-30T13:00:00Z', endDateTime: '2026-09-30T18:45:00Z',
      scheduledHours: 1.75, reason: 'service_call_without_time',
    }]);
  });

  test('windowStart: a 7-day window ending on the day', () => {
    expect(windowStart('2026-10-02', 7)).toBe('2026-09-26T00:00:00Z');
    expect(windowStart('2026-03-01', 1)).toBe('2026-03-01T00:00:00Z');
  });
});

describe('getMyDay — service calls, To-Dos, gaps, sequential', () => {
  test('chains call → ticket → my resource rows, finds the gap, and never runs two reads at once', async () => {
    let inFlight = 0, maxInFlight = 0;
    const rows: Record<string, any[]> = {
      TimeEntries: [{ id: 1, ticketID: 100, hoursWorked: 1 }],
      ServiceCalls: [
        { id: 7, startDateTime: '2026-10-02T14:00:00Z', endDateTime: '2026-10-02T16:00:00Z', isComplete: false },
        { id: 8, startDateTime: '2026-10-02T18:00:00Z', endDateTime: '2026-10-02T19:00:00Z' },
      ],
      ServiceCallTickets: [{ id: 70, serviceCallID: 7, ticketID: 100 }, { id: 71, serviceCallID: 7, ticketID: 101 }, { id: 80, serviceCallID: 8, ticketID: 102 }],
      ServiceCallTicketResources: [{ id: 1, serviceCallTicketID: 70, resourceID: 5 }, { id: 2, serviceCallTicketID: 71, resourceID: 5 }], // not on call 8
      CompanyToDos: [{ id: 300, activityDescription: 'Call back' }],
    };
    const query = jest.fn(async (entity: string) => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      return rows[entity] ?? [];
    });
    const s = mkService({ query });
    jest.spyOn(s, 'searchTickets').mockResolvedValue({ items: [], page: 1, pageSize: 100, hasMore: false });
    jest.spyOn(s, 'searchTasks').mockResolvedValue({ items: [], page: 1, pageSize: 100, hasMore: false });

    const r = await s.getMyDay(5, '2026-10-02');
    expect(maxInFlight).toBe(1);
    expect(r.serviceCalls).toEqual([expect.objectContaining({ serviceCallID: 7, ticketIDs: [100, 101], durationHours: 2 })]);
    expect(r.missingTime).toEqual([expect.objectContaining({ ticketID: 101, serviceCallIDs: [7], reason: 'service_call_without_time' })]);
    expect(r.openTodos).toHaveLength(1);
    expect(r.totals).toMatchObject({ serviceCalls: 1, openTodos: 1, missingTime: 1 });

    const call = (e: string) => query.mock.calls.find((c) => c[0] === e) as any[];
    expect(call('ServiceCalls')[1]).toEqual([
      { op: 'gte', field: 'startDateTime', value: '2026-10-02T00:00:00Z' },
      { op: 'lte', field: 'startDateTime', value: '2026-10-02T23:59:59Z' },
    ]);
    expect(call('ServiceCallTickets')[1]).toEqual([{ op: 'in', field: 'serviceCallID', value: [7, 8] }]);
    expect(call('ServiceCallTicketResources')[1]).toEqual([
      { op: 'in', field: 'serviceCallTicketID', value: [70, 71, 80] },
      { op: 'eq', field: 'resourceID', value: 5 },
    ]);
    expect(call('CompanyToDos')[1]).toEqual([
      { op: 'eq', field: 'assignedToResourceID', value: 5 },
      { op: 'notExist', field: 'completedDate' },
      { op: 'gte', field: 'startDateTime', value: '2026-09-26T00:00:00Z' }, // 7-day window, not every stale open To-Do
      { op: 'lte', field: 'startDateTime', value: '2026-10-02T23:59:59Z' },
    ]);
    expect(r.todoWindowDays).toBe(7);
  });

  test('no service calls in the window → no further service-call queries', async () => {
    const query = jest.fn(async () => []);
    const s = mkService({ query });
    jest.spyOn(s, 'searchTickets').mockResolvedValue({ items: [], page: 1, pageSize: 100, hasMore: false });
    jest.spyOn(s, 'searchTasks').mockResolvedValue({ items: [], page: 1, pageSize: 100, hasMore: false });
    await s.getMyDay(5, '2026-10-02');
    expect(query.mock.calls.map((c: any[]) => c[0])).toEqual(['TimeEntries', 'ServiceCalls', 'CompanyToDos']);
  });
});

describe('startWorkOnTicket', () => {
  const mk = (ticket: Record<string, any> | null) => {
    const s = mkService({});
    jest.spyOn(s, 'getTicket').mockResolvedValue(ticket as any);
    const update = jest.spyOn(s, 'updateTicket').mockResolvedValue(undefined);
    jest.spyOn(s, 'resolveResourceDefaultRole').mockResolvedValue(29682833);
    jest.spyOn(s, 'getResourceNames').mockResolvedValue(new Map([[77, 'Other Tech']]));
    return { s, update };
  };

  test('unassigned New ticket → In Progress + assigned to me with my default role', async () => {
    const { s, update } = mk({ id: 1, ticketNumber: 'T1', status: 1, assignedResourceID: null });
    const r = await s.startWorkOnTicket({ ticketID: 1, resourceID: 5 });
    expect(r).toMatchObject({ status: 'started', assignment: 'assigned_to_you', statusLabel: 'In Progress' });
    expect(update).toHaveBeenCalledWith(1, { assignedResourceID: 5, assignedResourceRoleID: 29682833, status: 8 });
    expect(typeof r.startedAt).toBe('string');
  });

  test('assigned to someone else → nothing written, assignee named; takeOver reassigns', async () => {
    const { s, update } = mk({ id: 1, ticketNumber: 'T1', status: 1, assignedResourceID: 77 });
    const r = await s.startWorkOnTicket({ ticketID: 1, resourceID: 5 });
    expect(r).toMatchObject({ status: 'assigned_to_other', assignedResourceName: 'Other Tech' });
    expect(update).not.toHaveBeenCalled();
    const t = await s.startWorkOnTicket({ ticketID: 1, resourceID: 5, takeOver: true });
    expect(t).toMatchObject({ status: 'started', assignment: 'taken_over' });
    expect(update).toHaveBeenCalledWith(1, expect.objectContaining({ assignedResourceID: 5, status: 8 }));
  });

  test('already In Progress and mine → no write (rerun-safe)', async () => {
    const { s, update } = mk({ id: 1, status: 8, assignedResourceID: 5 });
    expect((await s.startWorkOnTicket({ ticketID: 1, resourceID: 5 })).status).toBe('already_started');
    expect(update).not.toHaveBeenCalled();
  });

  test('Complete ticket, unknown status, dry run → nothing written', async () => {
    const done = mk({ id: 1, status: 5, assignedResourceID: 5 });
    expect((await done.s.startWorkOnTicket({ ticketID: 1, resourceID: 5 })).status).toBe('ticket_complete');
    const bad = mk({ id: 1, status: 1, assignedResourceID: 5 });
    expect((await bad.s.startWorkOnTicket({ ticketID: 1, resourceID: 5, status: 'Bogus' })).status).toBe('invalid_status');
    const dry = mk({ id: 1, status: 1, assignedResourceID: null });
    const r = await dry.s.startWorkOnTicket({ ticketID: 1, resourceID: 5, dryRun: true });
    expect(r).toMatchObject({ status: 'dry_run', plannedChanges: { status: 8, assignedResourceID: 5 } });
    for (const x of [done, bad, dry]) expect(x.update).not.toHaveBeenCalled();
  });
});

describe('autotask_add_ticket_update', () => {
  const mk = (opts: { existingNotes?: any[]; timeFails?: boolean } = {}) => {
    const query = jest.fn(async () => opts.existingNotes ?? []);
    const s = mkService({ query });
    jest.spyOn(s, 'getTicket').mockResolvedValue({ id: 1, ticketNumber: 'T1', status: 8 } as any);
    const note = jest.spyOn(s, 'createTicketNote').mockResolvedValue(501);
    const update = jest.spyOn(s, 'updateTicket').mockResolvedValue(undefined);
    jest.spyOn(s, 'resolveWorkTimeEntryRole').mockResolvedValue({ roleID: 29682833, roleName: 'Tech', source: 'default' } as any);
    const time = jest.spyOn(s, 'logTimeIdempotent').mockImplementation(async () => {
      if (opts.timeFails) throw new Error('Time entry cannot be created: the timesheet has been submitted');
      return { created: true, id: 900 };
    });
    const h = new AutotaskToolHandler(s, logger);
    const call = async (args: Record<string, any>) => {
      const res = await h.callTool('autotask_add_ticket_update', { ticketID: 1, resourceID: 5, ...args });
      return JSON.parse(res.content[0].text);
    };
    return { s, call, note, update, time, query };
  };

  test('internal note + time + status: validated, then note → time → status', async () => {
    const { call, note, time, update } = mk();
    const r = await call({ update: 'Swapped the PSU', hoursWorked: 1, summaryNotes: 'Replaced power supply', status: 'Waiting Customer' });
    expect(r.data.status).toBe('updated');
    expect(note).toHaveBeenCalledWith(1, { title: 'Update', description: 'Swapped the PSU', noteType: 1, publish: 2 }); // internal by default
    expect(time).toHaveBeenCalledWith(expect.objectContaining({ ticketID: 1, resourceID: 5, roleID: 29682833, hoursWorked: 1, summaryNotes: 'Replaced power supply' }));
    expect(update).toHaveBeenCalledWith(1, { status: 7 });
    const order = [note.mock.invocationCallOrder[0], time.mock.invocationCallOrder[0], update.mock.invocationCallOrder[0]];
    expect([...order].sort((a, b) => a! - b!)).toEqual(order);
  });

  test('internal update + time WITHOUT summaryNotes → refused (no internal text on the invoice), nothing written', async () => {
    const { call, note, time } = mk();
    const r = await call({ update: 'Internal: user is difficult', hoursWorked: 0.5 });
    expect(r.data.status).toBe('summary_required');
    expect(note).not.toHaveBeenCalled();
    expect(time).not.toHaveBeenCalled();
  });

  test('client-visible update reuses its text as the time summary; publish = All Autotask Users', async () => {
    const { call, note, time } = mk();
    await call({ update: 'Your printer is fixed', visibility: 'client', hoursWorked: 0.25 });
    expect(note).toHaveBeenCalledWith(1, expect.objectContaining({ publish: 1 }));
    expect(time).toHaveBeenCalledWith(expect.objectContaining({ summaryNotes: 'Your printer is fixed' }));
  });

  test('a failed time entry stops before the status change (never Complete with missing time)', async () => {
    const { call, update, note } = mk({ timeFails: true });
    const r = await call({ update: 'Done', hoursWorked: 1, summaryNotes: 'Fixed', status: 'Complete' });
    expect(r.data.status).toBe('partial');
    expect(note).toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(r.message).toMatch(/Status left unchanged/);
  });

  test('rerun: the same note within 24 h is not posted twice (searched in the last 24 h)', async () => {
    const recent = new Date(Date.now() - 3600_000).toISOString();
    const { call, note, query } = mk({ existingNotes: [{ id: 444, title: 'Update', description: 'Swapped the PSU', createDateTime: recent }] });
    const r = await call({ update: 'Swapped the PSU' });
    expect(note).not.toHaveBeenCalled();
    expect(r.data.done.note).toEqual({ created: false, noteId: 444 });
    const filter = (query.mock.calls[0] as any[])[1];
    expect(filter[0]).toEqual({ op: 'eq', field: 'ticketID', value: 1 });
    expect(filter[1]).toMatchObject({ op: 'gte', field: 'createDateTime' });
  });

  test('unknown status / bad visibility / dry run → nothing written', async () => {
    const { call, note, update, time } = mk();
    expect((await call({ update: 'x', status: 'Bogus' })).data.status).toBe('invalid_status');
    expect((await call({ update: 'x', visibility: 'public' })).message).toMatch(/visibility must be/);
    const dry = await call({ update: 'x', hoursWorked: 1, summaryNotes: 'y', status: 'Complete', dryRun: true });
    expect(dry.data).toMatchObject({ status: 'dry_run', statusChange: { to: 5 }, note: { visibility: 'internal' } });
    expect(note).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled(); expect(time).not.toHaveBeenCalled();
  });
});

describe('definitions', () => {
  test('both tools are registered and act as the caller by default', () => {
    const { CURRENT_USER_DEFAULT_TOOLS } = require('../src/utils/caller-resolution');
    for (const n of ['autotask_start_work_on_ticket', 'autotask_add_ticket_update']) {
      expect(TOOL_DEFINITIONS.find((t) => t.name === n)).toBeDefined();
      expect(CURRENT_USER_DEFAULT_TOOLS[n]).toBe('resourceID');
    }
  });
});
