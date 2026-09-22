// #46 §7 — classify_project: deterministic keyword scoring against caller-provided
// archetypes; ranked scores, confidence, explainable rationale. Pure.

import { classifyProject } from '../src/utils/project-classification';

const ARCHETYPES = [
  { name: 'Construction / Low-Voltage', keywords: ['cabling', 'cat6', 'drops', 'conduit', 'terminate', 'rack'] },
  { name: 'Tech Deployment', keywords: ['deployment', 'install workstations', 'migration', 'rollout', 'imaging'] },
  { name: 'Recurring Consulting', keywords: ['monthly', 'retainer', 'advisory', 'ongoing support'] },
];

describe('classifyProject', () => {
  test('picks the archetype with the most keyword hits', () => {
    const r = classifyProject({
      archetypes: ARCHETYPES,
      text: 'Cat6 cabling project: pull drops, terminate, and mount the rack',
    });
    expect(r.classification).toBe('Construction / Low-Voltage');
    expect(r.scores[0].matched).toEqual(expect.arrayContaining(['cat6', 'cabling', 'drops', 'terminate', 'rack']));
    expect(r.confidence).toBe('high'); // score 5, margin huge
  });

  test('mines the scope (included / quantities) for signals', () => {
    const r = classifyProject({
      archetypes: ARCHETYPES,
      scope: { included: ['Workstation imaging', 'Data migration'], quantities: [{ item: 'rollout waves' }] },
    });
    expect(r.classification).toBe('Tech Deployment');
    expect(r.scores[0].matched).toEqual(expect.arrayContaining(['migration', 'rollout', 'imaging']));
  });

  test('below minScore stays default with a reason', () => {
    const r = classifyProject({ archetypes: ARCHETYPES, text: 'General handyman visit', minScore: 1 });
    expect(r.classification).toBe('Unclassified');
    expect(r.confidence).toBe('none');
    expect(r.rationale).toMatch(/minimum score/);
  });

  test('custom default archetype name', () => {
    const r = classifyProject({ archetypes: ARCHETYPES, text: 'nothing relevant', defaultArchetype: 'Needs Review' });
    expect(r.classification).toBe('Needs Review');
  });

  test('weight lets one strong keyword outweigh several weak ones', () => {
    const r = classifyProject({
      archetypes: [
        { name: 'Weak', keywords: ['a', 'b', 'c'] },           // 3 hits × 1 = 3
        { name: 'Strong', keywords: ['compliance'], weight: 5 }, // 1 hit × 5 = 5
      ],
      text: 'a b c compliance',
    });
    expect(r.classification).toBe('Strong');
    expect(r.scores[0].score).toBe(5);
  });

  test('ties are surfaced in the rationale', () => {
    const r = classifyProject({
      archetypes: [{ name: 'X', keywords: ['foo'] }, { name: 'Y', keywords: ['bar'] }],
      text: 'foo bar',
    });
    expect(r.scores[0].score).toBe(r.scores[1].score);
    expect(r.rationale).toMatch(/tie/);
  });

  test('no archetypes / no text → explained, default returned', () => {
    expect(classifyProject({ archetypes: [], text: 'x' }).rationale).toMatch(/No archetypes/);
    expect(classifyProject({ archetypes: ARCHETYPES }).rationale).toMatch(/No text or scope/);
  });
});
