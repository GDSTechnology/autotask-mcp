// Notification triggers: events fire on TRANSITIONS only (a persisting
// condition is reported once), from the MCP's own state.

import { checkOnce, initialWatchState, type WatchSources } from '../src/services/notify-watch';
import { assessBackpressure } from '../src/services/backpressure';

const NOW = Date.parse('2026-10-09T12:00:00Z');
function src(o: { auth?: any; usedPct?: number; cooldown?: number; run?: any; verify?: any; errors?: number } = {}): WatchSources {
  return {
    backpressure: () => assessBackpressure({ usage: o.usedPct != null ? { usedPct: o.usedPct, used: 1, limit: 10_000, at: new Date(NOW).toISOString() } : null, auth: o.auth ?? null, cooldownSeconds: o.cooldown ?? 0, queued: 0, now: NOW }),
    lastRun: () => o.run ?? null,
    lastVerify: () => o.verify ?? null,
    toolErrors: () => Array.from({ length: o.errors ?? 0 }, (_, i) => ({ tool: i % 2 ? 'autotask_update_ticket' : 'autotask_raw_request', error: 'boom', at: 'x' })),
  };
}
const held = { tenant: 't', since: 'x', failures: 3, lastError: '401', blockedUntil: null, probing: false, held: true };
const paused = { ...held, held: false, blockedUntil: new Date(NOW + 60_000).toISOString() };
const types = (r: { events: Array<{ type: string }> }) => r.events.map((e) => e.type);

test('login: paused → held → working again, each reported once', () => {
  let s = initialWatchState();
  let r = checkOnce(src({ auth: paused }), s, NOW); s = r.state;
  expect(types(r)).toEqual(expect.arrayContaining(['auth.paused', 'backpressure.stop']));
  r = checkOnce(src({ auth: paused }), s, NOW); s = r.state;
  expect(types(r)).toEqual([]); // still paused: nothing new
  r = checkOnce(src({ auth: held }), s, NOW); s = r.state;
  expect(types(r)).toEqual(['auth.held']);
  r = checkOnce(src({}), s, NOW);
  expect(types(r)).toEqual(['auth.cleared', 'backpressure.recovered']);
});

test('backpressure: stop once, recovered only when fully ok (not on stop → slow)', () => {
  let s = initialWatchState();
  let r = checkOnce(src({ usedPct: 93 }), s, NOW); s = r.state;
  expect(types(r)).toEqual(['backpressure.stop']);
  r = checkOnce(src({ usedPct: 60 }), s, NOW); s = r.state;
  expect(types(r)).toEqual([]);
  r = checkOnce(src({ usedPct: 20 }), s, NOW);
  expect(types(r)).toEqual(['backpressure.recovered']);
  expect(types(checkOnce(src({ usedPct: 60 }), initialWatchState(), NOW))).toEqual([]); // ok → slow: silent
});

test('a new 429 cooldown is reported once', () => {
  const r1 = checkOnce(src({ cooldown: 40 }), initialWatchState(), NOW);
  expect(types(r1)).toEqual(expect.arrayContaining(['ratelimit.hit']));
  expect(types(checkOnce(src({ cooldown: 30 }), r1.state, NOW))).not.toContain('ratelimit.hit');
});

test('mirror: each new run with entity errors, and each new check needing attention', () => {
  const run = { at: 'r1', report: { calls: 3, entities: [{ entity: 'TicketNotes', mode: 'skip', calls: 1, rows: 0, error: 'field lastActivityDate not queryable' }, { entity: 'Tickets', mode: 'skip', calls: 0, rows: 0, error: 'run budget spent' }] } };
  const verify = { at: 'v1', trigger: 'nightly', status: 'attention', calls: 4, sample: 20, entities: [{ entity: 'Tickets', sampled: 20, ok: 18, changed: 0, pending: 0, differs: 2, missing: 0, repaired: 2, mirrorCount: 1, autotaskCount: 1, countDelta: 0, countOk: true, examples: [], calls: 2 }] };
  const r = checkOnce(src({ run, verify }), initialWatchState(), NOW);
  expect(r.events.map((e) => [e.type, e.title])).toEqual([['shadow.sync_error', 'Mirror sync error: TicketNotes'], ['shadow.verify_failed', 'Mirror consistency check needs attention']]);
  expect(r.events[1]!.detail).toMatch(/Tickets: 2 differ/);
  expect(types(checkOnce(src({ run, verify }), r.state, NOW))).toEqual([]); // same run / check: not again
});

test('tool errors: 5+ in 5 min, then quiet for 15 min', () => {
  const r = checkOnce(src({ errors: 6 }), initialWatchState(), NOW);
  expect(r.events[0]).toMatchObject({ type: 'tool.errors', title: '6 tool errors in 5 minutes', fields: { autotask_raw_request: '3', autotask_update_ticket: '3' } });
  expect(types(checkOnce(src({ errors: 6 }), r.state, NOW + 60_000))).toEqual([]);
  expect(types(checkOnce(src({ errors: 6 }), r.state, NOW + 16 * 60_000))).toEqual(['tool.errors']);
  expect(types(checkOnce(src({ errors: 4 }), initialWatchState(), NOW))).toEqual([]);
});
