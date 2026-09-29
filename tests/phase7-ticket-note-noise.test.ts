// Autotask's own bookkeeping notes (workflow-rule, Service Desk Notification,
// forward/modify) are hidden from user-facing note views by default. Shapes
// below mirror T20260928.0084's live notes (2026-09-29): 24 notes, 15 system.

jest.mock('autotask-node', () => ({
  AutotaskClient: { create: jest.fn().mockRejectedValue(new Error('Mock: no API')) },
}));

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import { buildTicketCard } from '../src/handlers/card.builder';
import { isSystemTicketNote, partitionTicketNotes } from '../src/utils/ticket-note-kind';
import type { McpServerConfig } from '../src/types/mcp';

const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' } };
const logger = new Logger('error');

const human = (id: number, at: string, title = '[External] -  - Shippan Landing =-290 EV Chargers') =>
  ({ id, noteType: 1, publish: 2, title, description: `human ${id}`, createDateTime: at });
const notif = (id: number, at: string) =>
  ({ id, noteType: 2, publish: 4, title: 'Service Desk Notification', description: 'kaden.hausinger@gdstech.tech', createDateTime: at });
const workflow = (id: number, at: string) =>
  ({ id, noteType: 13, publish: 1, title: 'Workflow Rule "Note from End User" fired.', description: 'When a ticket is:', createDateTime: at });

describe('isSystemTicketNote', () => {
  test.each([
    [{ noteType: 13, title: 'Workflow Rule "Route Ticket to T1 Que" fired.' }, true],
    [{ noteType: 91, title: 'x' }, true],
    [{ noteType: 92, title: 'x' }, true],
    [{ noteType: 2, title: 'Service Desk Notification' }, true],
    [{ noteType: 2, title: '  service desk notification ' }, true],
    [{ noteType: 1, title: '- Shippan Landing =-290 EV Chargers' }, false],
    [{ noteType: 2, title: 'Task detail a tech wrote' }, false],
    [{ noteType: 18, title: 'Client Portal Note' }, false],
    [{ noteType: 99, title: 'RMM alert' }, false], // diagnostics stay visible
    [{ noteType: 93, title: 'Merged Into Ticket' }, false], // history stays visible
  ])('%j -> %s', (note, expected) => {
    expect(isSystemTicketNote(note)).toBe(expected);
  });

  test('partition counts what it hid', () => {
    const r = partitionTicketNotes([human(1, 'a'), notif(2, 'b'), workflow(3, 'c')]);
    expect(r.human.map((n) => n.id)).toEqual([1]);
    expect(r.systemHidden).toBe(2);
  });
});

describe('ticket card notes', () => {
  const picklists = { getPicklistValues: jest.fn(async () => []) };
  const ticket = { id: 209477, ticketNumber: 'T20260928.0084', title: 'Shippan Landing =-290 EV Chargers' };

  test('shows the NEWEST 5 human notes, oldest→newest, with system notes dropped', async () => {
    // Oldest-first like Autotask: creation workflow noise first, 7 human notes interleaved with logs.
    const notes = [
      workflow(1, '2026-09-28T13:00:00Z'), notif(2, '2026-09-28T13:00:01Z'),
      human(3, '2026-09-28T13:05:00Z'), notif(4, '2026-09-28T13:05:01Z'),
      human(5, '2026-09-28T14:00:00Z'), workflow(6, '2026-09-28T14:00:01Z'),
      human(7, '2026-09-28T15:00:00Z'), human(8, '2026-09-28T16:00:00Z'),
      notif(9, '2026-09-28T16:00:01Z'), human(10, '2026-09-28T17:00:00Z'),
      human(11, '2026-09-28T18:00:00Z'), human(12, '2026-09-28T19:00:00Z'),
    ];
    const service = { searchTicketNotes: jest.fn(async () => notes) };
    const card = await buildTicketCard(ticket, picklists as never, service as never, logger);
    expect(card!.notes.map((n) => n.description)).toEqual(['human 7', 'human 8', 'human 10', 'human 11', 'human 12']);
    expect(card!.notes.some((n) => n.title === 'Service Desk Notification')).toBe(false);
  });

  test('a ticket with only system notes renders an empty notes list', async () => {
    const service = { searchTicketNotes: jest.fn(async () => [workflow(1, 'a'), notif(2, 'b')]) };
    const card = await buildTicketCard(ticket, picklists as never, service as never, logger);
    expect(card!.notes).toEqual([]);
  });
});

describe('autotask_search_ticket_notes', () => {
  const { AutotaskToolHandler } = require('../src/handlers/tool.handler');
  const body = (res: any) => JSON.parse(res.content[0].text) as { message: string; data: any };
  const notes = [workflow(1, 'a'), human(2, 'b'), notif(3, 'c'), human(4, 'd'), notif(5, 'e')];

  test('hides system notes by default and says how many', async () => {
    const s = new AutotaskService(config, logger);
    jest.spyOn(s, 'searchTicketNotes').mockResolvedValue(notes as any);
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_search_ticket_notes', { ticketId: 209477 }));
    expect(b.message).toMatch(/Found 2 ticket notes \(3 system note\(s\) hidden/);
    expect(b.message).toMatch(/includeSystemNotes:true/);
  });

  test('pageSize counts HUMAN notes (a full page is read before filtering)', async () => {
    const s = new AutotaskService(config, logger);
    const search = jest.spyOn(s, 'searchTicketNotes').mockResolvedValue(notes as any);
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_search_ticket_notes', { ticketId: 209477, pageSize: 1 }));
    expect(search).toHaveBeenCalledWith(209477, { pageSize: 500 });
    expect(b.message).toMatch(/^Found 1 ticket notes/);
  });

  test('includeSystemNotes:true returns the raw stream', async () => {
    const s = new AutotaskService(config, logger);
    const search = jest.spyOn(s, 'searchTicketNotes').mockResolvedValue(notes as any);
    const b = body(await new AutotaskToolHandler(s, logger).callTool('autotask_search_ticket_notes', { ticketId: 209477, includeSystemNotes: true }));
    expect(search).toHaveBeenCalledWith(209477, { pageSize: 25 });
    expect(b.message).toMatch(/Found 5 ticket notes \(system notes included\)/);
  });
});
