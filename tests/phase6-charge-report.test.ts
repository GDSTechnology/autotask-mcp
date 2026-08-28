// Ticket-charge summary (Expansion Spec §Phase 6). Pure — no tenant.

import { summarizeTicketCharges } from '../src/utils/charge-report';

const charges = [
  { id: 1, ticketID: 100, name: 'US-48', status: 7, isBilled: true, billableAmount: 100, ticketNumber: 'T1', company: 'Acme' },
  { id: 2, ticketID: 100, name: 'Cable', status: 6, isBilled: false, billableAmount: 50, ticketNumber: 'T1', company: 'Acme' },
  { id: 3, ticketID: 200, name: 'Misc', status: 3, isBilled: false, extendedCost: 25, ticketNumber: 'T2', company: 'Beta' },
];

describe('summarizeTicketCharges', () => {
  test('status/billed breakdown, totals, per-ticket rollup sorted by value', () => {
    const s = summarizeTicketCharges(charges as any);
    expect(s.totalCharges).toBe(3);
    expect(s.byStatus).toEqual({ 'Delivered/Shipped Full': 1, 'Ready to Deliver/Ship': 1, 'Need to Order/Fulfill': 1 });
    expect(s.billed).toBe(1);
    expect(s.unbilled).toBe(2);
    expect(s.totalBillable).toBe(175);
    expect(s.unbilledBillable).toBe(75);
    expect(s.ticketsWithCharges).toBe(2);
    expect(s.tickets[0]).toMatchObject({ ticketNumber: 'T1', total: 150 }); // higher total first
    expect(s.tickets[0].charges).toHaveLength(2);
  });

  test('unbilledOnly keeps only not-yet-billed charges', () => {
    const s = summarizeTicketCharges(charges as any, { unbilledOnly: true });
    expect(s.totalCharges).toBe(2);
    expect(s.billed).toBe(0);
    expect(s.totalBillable).toBe(75);
  });

  test('empty input', () => {
    const s = summarizeTicketCharges([]);
    expect(s).toMatchObject({ totalCharges: 0, ticketsWithCharges: 0, totalBillable: 0 });
  });
});
