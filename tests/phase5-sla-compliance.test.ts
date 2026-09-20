// #100 — SLA compliance: per-stage met/missed/pending/breached/no_target,
// compliance %, breach queue, next-event, grouping. Pure.

import { evaluateTicketSla, computeSlaCompliance } from '../src/utils/sla-compliance';

const NOW = new Date('2026-09-20T12:00:00Z');
// helper to build a ticket with stage due/actual
const tk = (id: number, o: Partial<Record<string, any>> = {}): Record<string, any> => ({ id, createDate: '2026-09-01', ...o });

describe('evaluateTicketSla', () => {
  test('met = actual on/before due; missed = actual after due', () => {
    const ev = evaluateTicketSla(tk(1, {
      firstResponseDueDateTime: '2026-09-10T10:00:00Z', firstResponseDateTime: '2026-09-10T09:00:00Z', // met
      resolutionPlanDueDateTime: '2026-09-11T10:00:00Z', resolutionPlanDateTime: '2026-09-12T10:00:00Z', // missed
    }), NOW);
    expect(ev.stages.triage.status).toBe('met');
    expect(ev.stages.engagement.status).toBe('missed');
    expect(ev.stages.resolved.status).toBe('no_target'); // no due set
  });

  test('open stages: pending (future due) vs breached (past due); next event = earliest open', () => {
    const ev = evaluateTicketSla(tk(2, {
      firstResponseDueDateTime: '2026-09-19T12:00:00Z', // past, no actual → breached (24h overdue)
      resolvedDueDateTime: '2026-09-25T12:00:00Z',      // future → pending
    }), NOW);
    expect(ev.stages.triage.status).toBe('breached');
    expect(ev.stages.triage.hoursOverdue).toBe(24);
    expect(ev.stages.resolved.status).toBe('pending');
    expect(ev.nextEvent).toMatchObject({ stage: 'triage', breached: true, hoursOverdue: 24 }); // breached triage is earliest
  });
});

describe('computeSlaCompliance', () => {
  const tickets = [
    tk(1, { firstResponseDueDateTime: '2026-09-10T10:00:00Z', firstResponseDateTime: '2026-09-10T09:00:00Z' }), // triage met
    tk(2, { firstResponseDueDateTime: '2026-09-10T10:00:00Z', firstResponseDateTime: '2026-09-10T11:00:00Z' }), // triage missed
    tk(3, { firstResponseDueDateTime: '2026-09-19T12:00:00Z' }), // triage breached (open, overdue)
    tk(4, { firstResponseDueDateTime: '2026-09-25T12:00:00Z' }), // triage pending
    tk(5, {}), // triage no_target
  ];

  test('per-stage counts + compliance % (met / met+missed)', () => {
    const r = computeSlaCompliance(tickets, NOW);
    const tr = r.stages.triage;
    expect(tr).toMatchObject({ met: 1, missed: 1, breached: 1, pending: 1, noTarget: 1, total: 5 });
    expect(tr.compliancePct).toBe(50); // 1 met / (1+1) closed
    expect(r.stages.resolved.compliancePct).toBeNull(); // nothing closed
  });

  test('breach queue lists open+overdue, worst first', () => {
    const r = computeSlaCompliance([
      tk(10, { resolvedDueDateTime: '2026-09-18T12:00:00Z' }), // 48h overdue
      tk(11, { firstResponseDueDateTime: '2026-09-20T06:00:00Z' }), // 6h overdue
    ], NOW);
    expect(r.breaches.map((b) => b.id)).toEqual([10, 11]); // worst (48h) first
    expect(r.breaches[0]).toMatchObject({ stage: 'resolved', hoursOverdue: 48 });
  });

  test('response metrics from actuals + targetsConfigured (works with no SLA targets)', () => {
    const r = computeSlaCompliance([
      tk(1, { createDate: '2026-09-01T00:00:00Z', firstResponseDateTime: '2026-09-01T02:00:00Z', resolvedDateTime: '2026-09-01T10:00:00Z' }), // no due targets
      tk(2, { createDate: '2026-09-01T00:00:00Z', firstResponseDateTime: '2026-09-01T04:00:00Z', resolvedDateTime: '2026-09-02T00:00:00Z' }),
    ], NOW);
    expect(r.targetsConfigured).toBe(0); // no due dates set
    expect(r.responseMetrics.respondedCount).toBe(2);
    expect(r.responseMetrics.avgHoursToFirstResponse).toBe(3);  // (2+4)/2
    expect(r.responseMetrics.medianHoursToResolve).toBe(17);    // median(10,24)
    expect(r.stages.triage.compliancePct).toBeNull();           // still no compliance without targets
  });

  test('groupBy queue produces per-group aggregates', () => {
    const r = computeSlaCompliance([
      tk(1, { queueID: 8, firstResponseDueDateTime: '2026-09-10T10:00:00Z', firstResponseDateTime: '2026-09-10T09:00:00Z' }),
      tk(2, { queueID: 9, firstResponseDueDateTime: '2026-09-10T10:00:00Z', firstResponseDateTime: '2026-09-10T11:00:00Z' }),
    ], NOW, { groupBy: 'queue' });
    expect(r.groups!.map((g) => g.key).sort()).toEqual(['queue:8', 'queue:9']);
    expect(r.groups!.find((g) => g.key === 'queue:8')!.stages.triage.compliancePct).toBe(100);
    expect(r.groups!.find((g) => g.key === 'queue:9')!.stages.triage.compliancePct).toBe(0);
  });
});
