// Canonical resolution layer (Expansion Spec §3.3, issue #16). Parses any
// reference form into a typed hint, and collapses candidates into one id + name
// or a choice list.

import {
  parseReference,
  resolveCanonical,
  pickCanonicalName,
  CanonicalRef,
} from '../src/utils/canonical';

describe('parseReference', () => {
  test('numbers and numeric strings → id', () => {
    expect(parseReference(12345)).toEqual({ kind: 'id', raw: '12345', id: 12345 });
    expect(parseReference(' 678 ')).toEqual({ kind: 'id', raw: '678', id: 678 });
  });

  test('Autotask deep-link URL → entity + id', () => {
    const p = parseReference('https://ww15.autotask.net/Mvc/ServiceDesk/TicketDetail.mvc?ticketId=204722');
    expect(p).toMatchObject({ kind: 'url', entity: 'ticket', id: 204722 });
  });

  test('URL with an unknown param → url without an id', () => {
    const p = parseReference('https://example.com/thing?foo=bar');
    expect(p.kind).toBe('url');
    expect(p.id).toBeUndefined();
  });

  test('accountId maps to company', () => {
    expect(parseReference('https://ww15.autotask.net/x?accountId=29684773')).toMatchObject({ entity: 'company', id: 29684773 });
  });

  test('email → email', () => {
    expect(parseReference('jf@gds.com')).toEqual({ kind: 'email', raw: 'jf@gds.com', email: 'jf@gds.com' });
  });

  test('ticket/task display number → entity-number, entity left unset', () => {
    const p = parseReference('T20260825.0006');
    expect(p.kind).toBe('entity-number');
    expect(p.number).toBe('T20260825.0006');
    expect(p.entity).toBeUndefined();
  });

  test('free text → name', () => {
    expect(parseReference('Acme Corporation')).toEqual({ kind: 'name', raw: 'Acme Corporation' });
  });
});

describe('resolveCanonical', () => {
  const a: CanonicalRef = { id: 1, canonicalName: 'Acme' };
  const b: CanonicalRef = { id: 2, canonicalName: 'Acme Holdings' };

  test('one candidate → matched', () => {
    expect(resolveCanonical('acme', [a])).toEqual({ status: 'matched', reference: 'acme', match: a });
  });

  test('none → not-found', () => {
    expect(resolveCanonical('acme', [])).toEqual({ status: 'not-found', reference: 'acme' });
  });

  test('many → ambiguous with the choice list', () => {
    const r = resolveCanonical('acme', [a, b]);
    expect(r.status).toBe('ambiguous');
    expect(r.candidates).toEqual([a, b]);
    expect(r.match).toBeUndefined();
  });
});

describe('pickCanonicalName', () => {
  test('number + title', () => {
    expect(pickCanonicalName({ ticketNumber: 'T20260825.0006', title: 'Server down' })).toBe('T20260825.0006 — Server down');
  });
  test('company name', () => {
    expect(pickCanonicalName({ companyName: 'Acme' })).toBe('Acme');
  });
  test('person first + last', () => {
    expect(pickCanonicalName({ firstName: 'Jonathan', lastName: 'Fitzgerald' })).toBe('Jonathan Fitzgerald');
  });
  test('email fallback', () => {
    expect(pickCanonicalName({ emailAddress: 'jf@gds.com' })).toBe('jf@gds.com');
  });
  test('id fallback when nothing else', () => {
    expect(pickCanonicalName({ id: 99 })).toBe('#99');
  });
});
