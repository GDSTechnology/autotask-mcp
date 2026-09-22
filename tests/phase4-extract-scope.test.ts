// #46 §8 — extract_project_scope: deterministic SOW → normalized scope envelope.
// Section parsing, quantity extraction, partial-scope merge, warnings. Pure.

import { extractProjectScope } from '../src/utils/project-scope';

const SOW = `
Scope of Work:
- Install (48) Cat6 data drops
- 12x wireless access points
- Terminate and test all runs

Out of Scope:
- Electrical work
- Painting or patching

By Others:
- Conduit and backboxes provided by the electrician

Assumptions:
- Ceilings are accessible
- Work performed during business hours

Customer Provided:
- Rack space in the MDF

Milestones:
- Rough-in complete 2026-10-15
- Final testing and closeout on November 20, 2026
`;

describe('extractProjectScope', () => {
  test('section-parses the SOW into canonical buckets', () => {
    const r = extractProjectScope({ sowText: SOW });
    expect(r.included).toEqual(['Install (48) Cat6 data drops', '12x wireless access points', 'Terminate and test all runs']);
    expect(r.excluded).toEqual(['Electrical work', 'Painting or patching']);
    expect(r.byOthers).toEqual(['Conduit and backboxes provided by the electrician']);
    expect(r.assumptions).toHaveLength(2);
    expect(r.customerProvided).toEqual(['Rack space in the MDF']);
  });

  test('extracts BOM quantities from in-scope lines', () => {
    const r = extractProjectScope({ sowText: SOW });
    const drops = r.quantities.find((q) => /Cat6 data drops/i.test(q.item));
    const aps = r.quantities.find((q) => /access points/i.test(q.item));
    expect(drops).toMatchObject({ quantity: 48, source: 'included' });
    expect(aps).toMatchObject({ quantity: 12 });
  });

  test('parses milestone dates (ISO and "Month DD, YYYY")', () => {
    const r = extractProjectScope({ sowText: SOW });
    const iso = r.milestones.find((m) => m.date === '2026-10-15');
    const md = r.milestones.find((m) => m.date === '2026-11-20');
    expect(iso).toBeTruthy();
    expect(md).toBeTruthy();
    expect(md!.text.toLowerCase()).toContain('final testing');
  });

  test('never infers: unrecognized headings leave lines unclassified + warn', () => {
    const r = extractProjectScope({ sowText: 'Do some cabling\nAnd some cameras' });
    expect(r.included).toHaveLength(0);
    expect(r.unclassified).toEqual(['Do some cabling', 'And some cameras']);
    expect(r.warnings.some((w) => /No recognized SOW section headings/.test(w))).toBe(true);
  });

  test('merges a caller-supplied partial scope and dedupes', () => {
    const r = extractProjectScope({
      sowText: 'Included:\n- Install cameras',
      scope: { included: ['Install cameras', 'Program NVR'], excluded: ['Trenching'] },
    });
    expect(r.included).toEqual(['Install cameras', 'Program NVR']); // deduped
    expect(r.excluded).toEqual(['Trenching']);
  });

  test('distinguishes "Out of Scope" from generic "Scope"', () => {
    const r = extractProjectScope({ sowText: 'Scope:\n- A\nOut of Scope:\n- B' });
    expect(r.included).toEqual(['A']);
    expect(r.excluded).toEqual(['B']);
  });

  test('warns on missing in-scope / exclusions', () => {
    const r = extractProjectScope({ scope: { assumptions: ['x'] } });
    expect(r.warnings.some((w) => /No in-scope items/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /No exclusions/.test(w))).toBe(true);
  });

  test('records source provenance', () => {
    const r = extractProjectScope({ sowText: 'Included:\n- A', source: 'SOW-2026-114.pdf' });
    expect(r.source).toBe('SOW-2026-114.pdf');
  });
});
