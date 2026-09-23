// #10 — log_ticket_collaboration: per-tech time entries + optional ticket note in
// one call (capture a Teams triage thread). dry-run-first, idempotent, email→
// resource resolve, role auto-resolve, issues (not guesses). Service mocked.

jest.mock('autotask-node', () => ({
  AutotaskClient: { create: jest.fn().mockRejectedValue(new Error('Mock: no API')) },
}));

import { AutotaskService } from '../src/services/autotask.service';
import { Logger } from '../src/utils/logger';
import type { McpServerConfig } from '../src/types/mcp';

const config: McpServerConfig = { name: 't', version: '0', autotask: { username: 'u@e.com', secret: 's', integrationCode: 'ic', apiUrl: 'https://webservices2.autotask.net/ATServicesRest/' } };
const mk = () => new AutotaskService(config, new Logger('error'));

describe('logTicketCollaboration', () => {
  test('missing ticket → validation_failed, nothing written', async () => {
    const s = mk();
    jest.spyOn(s, 'getTicket').mockResolvedValue(null as any);
    const log = jest.spyOn(s, 'logTimeIdempotent').mockResolvedValue({ created: true, id: 1 } as any);
    const r = await s.logTicketCollaboration({ ticketID: 999, participants: [{ resourceID: 1, hoursWorked: 1 }], sharedSummaryNotes: 'x', dryRun: false });
    expect(r.status).toBe('validation_failed');
    expect(log).not.toHaveBeenCalled();
  });

  test('dry run: plans per-tech entries (email resolved, role auto), writes nothing', async () => {
    const s = mk();
    jest.spyOn(s, 'getTicket').mockResolvedValue({ id: 100, ticketNumber: 'T1' } as any);
    jest.spyOn(s as any, 'ensureClient').mockResolvedValue({ query: async () => [{ id: 42, email: 'tech@x.com' }] });
    jest.spyOn(s, 'resolveWorkTimeEntryRole').mockResolvedValue({ roleID: 7 } as any);
    const log = jest.spyOn(s, 'logTimeIdempotent').mockResolvedValue({ created: true, id: 1 } as any);
    const r = await s.logTicketCollaboration({
      ticketID: 100,
      participants: [{ resourceID: 1, hoursWorked: 1 }, { email: 'tech@x.com', hoursWorked: 0.5 }],
      sharedSummaryNotes: 'Resolved VPN blocker together',
    });
    expect(r.status).toBe('dry_run');
    expect((r.plannedTimeEntries as any[]).map((p) => p.resourceID)).toEqual([1, 42]); // email → 42
    expect((r.plannedTimeEntries as any[])[0].roleID).toBe(7); // auto-resolved
    expect(log).not.toHaveBeenCalled();
  });

  test('execute: logs each tech idempotently + creates the ticket note', async () => {
    const s = mk();
    jest.spyOn(s, 'getTicket').mockResolvedValue({ id: 100, ticketNumber: 'T1' } as any);
    jest.spyOn(s, 'resolveWorkTimeEntryRole').mockResolvedValue({ roleID: 7 } as any);
    const log = jest.spyOn(s, 'logTimeIdempotent')
      .mockResolvedValueOnce({ created: true, id: 501 } as any)
      .mockResolvedValueOnce({ created: false, id: 400, duplicateOf: 400 } as any);
    const note = jest.spyOn(s, 'createTicketNote').mockResolvedValue(900 as any);
    const r = await s.logTicketCollaboration({
      ticketID: 100,
      participants: [{ resourceID: 1, hoursWorked: 1 }, { resourceID: 2, hoursWorked: 0.5 }],
      sharedSummaryNotes: 'Worked the blocker',
      ticketNote: { description: 'Teams thread: ...' },
      dryRun: false,
    });
    expect(r.status).toBe('logged');
    expect(r.created).toBe(1);
    expect(r.duplicates).toBe(1);
    expect(r.noteId).toBe(900);
    expect(log).toHaveBeenCalledTimes(2);
    // internal-only note by default (not visible to client portal)
    expect(note.mock.calls[0][1]).toMatchObject({ isVisibleToClientPortal: false });
  });

  test('a participant needing a role choice is reported as an issue, not guessed', async () => {
    const s = mk();
    jest.spyOn(s, 'getTicket').mockResolvedValue({ id: 100 } as any);
    jest.spyOn(s, 'resolveWorkTimeEntryRole').mockResolvedValue({ needsSelection: [{ roleID: 7, roleName: 'A', isDefault: false }, { roleID: 8, roleName: 'B', isDefault: false }] } as any);
    const log = jest.spyOn(s, 'logTimeIdempotent').mockResolvedValue({ created: true, id: 1 } as any);
    const r = await s.logTicketCollaboration({ ticketID: 100, participants: [{ resourceID: 1, hoursWorked: 1 }], sharedSummaryNotes: 'x', dryRun: false });
    expect(r.status).toBe('validation_failed'); // no loggable participants
    expect((r.detail as any).issues[0].issue).toMatch(/multiple roles/);
    expect(log).not.toHaveBeenCalled();
  });

  test('missing summaryNotes (no shared) → participant issue', async () => {
    const s = mk();
    jest.spyOn(s, 'getTicket').mockResolvedValue({ id: 100 } as any);
    jest.spyOn(s, 'resolveWorkTimeEntryRole').mockResolvedValue({ roleID: 7 } as any);
    const r = await s.logTicketCollaboration({ ticketID: 100, participants: [{ resourceID: 1, hoursWorked: 1 }] });
    expect(r.status).toBe('validation_failed');
    expect((r.detail as any).issues[0].issue).toMatch(/summaryNotes required/);
  });
});
