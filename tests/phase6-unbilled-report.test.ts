// Unbilled-work summary (Expansion Spec §Phase 6). Pure — no tenant.

import { summarizeUnbilled } from '../src/utils/unbilled-report';

const asOf = new Date('2026-08-28T00:00:00Z');

describe('summarizeUnbilled', () => {
  const items = [
    { id: 1, itemDate: '2026-08-20', totalAmount: 100, timeEntryID: 5, companyID: 1, company: 'Acme' }, // ~8d
    { id: 2, itemDate: '2026-06-01', totalAmount: 200, timeEntryID: 6, companyID: 1, company: 'Acme' }, // ~88d → 61-90
    { id: 3, itemDate: '2025-01-01', totalAmount: 500, ticketChargeID: 9, companyID: 2, company: 'Beta' }, // ~600d → 90+
    { id: 4, itemDate: '2026-08-25', totalAmount: 50, contractID: 3, companyID: 2, company: 'Beta' }, // ~3d, other
  ];

  test('age buckets, at-risk (>30d), source split, company rollup', () => {
    const s = summarizeUnbilled(items as any, asOf);
    expect(s.totalCount).toBe(4);
    expect(s.totalAmount).toBe(850);
    expect(s.buckets['0-30'].count).toBe(2);   // items 1,4
    expect(s.buckets['61-90'].amount).toBe(200); // item 2
    expect(s.buckets['90+'].amount).toBe(500);   // item 3
    expect(s.atRiskCount).toBe(2);               // items 2,3
    expect(s.atRiskAmount).toBe(700);
    expect(s.bySource).toEqual({ time: 2, charge: 1, other: 1 });
    // Beta has the biggest at-risk ($500) → first
    expect(s.byCompany[0]).toMatchObject({ company: 'Beta', atRiskAmount: 500 });
    expect(s.oldestDays).toBeGreaterThan(500);
  });

  test('empty input', () => {
    const s = summarizeUnbilled([], asOf);
    expect(s).toMatchObject({ totalCount: 0, totalAmount: 0, atRiskAmount: 0 });
  });
});
