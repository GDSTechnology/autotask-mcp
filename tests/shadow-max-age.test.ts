// Scheduled (full / window refresh) mirrors are trusted for their refresh interval;
// incremental ones keep the global serve limit.
import { maxAgeFor } from '../src/db/shadow-runtime';

test('Resources (full refresh every 60 min) serves for 65 min; Tickets (incremental) keeps the global limit', () => {
  const rt = { maxAgeSeconds: 900 };
  expect(maxAgeFor(rt, 'Resources')).toBe(65 * 60);
  expect(maxAgeFor(rt, 'ContractServices')).toBe(65 * 60);
  expect(maxAgeFor(rt, 'Tickets')).toBe(900);
  expect(maxAgeFor({ maxAgeSeconds: 7200 }, 'Resources')).toBe(7200); // a larger global limit wins
});
