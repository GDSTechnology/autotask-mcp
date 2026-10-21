// Bulk placeholder cleanup: prepared from the mirror (paging, history exclusions, never a
// real company), paced writes (business hours slower, backpressure, canary pause, failure
// handling), approval by hash, and the tool's guards.

import { preparePlaceholderJob } from '../src/bulk/prepare';
import { prepareCompanyContactsJob } from '../src/bulk/prepare-contacts';
import { activityProfile, currentRate, inBusinessHours, suggestWindow, weeklyCapacity, DEFAULT_SCHEDULE } from '../src/bulk/schedule';
import { profileFromRows } from '../src/bulk/activity';
import { BulkWorker, BULK_THRESHOLDS, applyItem, writeGapMs } from '../src/bulk/worker';
import { assessBackpressure } from '../src/services/backpressure';
import { itemsHash, type BulkItem, type BulkJob } from '../src/bulk/store';
import { bulkToolHandlers } from '../src/bulk/tools';

type Row = Record<string, any>;
function fakeQ(tables: Record<string, Row[]>, o: { fail?: string } = {}) {
  const calls: Array<[string, any[]]> = [];
  const q = async <T>(entity: string, filters: Array<{ op: string; field: string; value: any }>, opts: { maxRecords?: number }) => {
    calls.push([entity, filters]);
    if (o.fail === entity) throw new Error(`${entity}: field not queryable`);
    let rows = tables[entity] ?? [];
    for (const f of filters) rows = rows.filter((r) => f.op === 'eq' ? r[f.field] === f.value : f.op === 'gt' ? r[f.field] > f.value : f.op === 'in' ? f.value.includes(r[f.field]) : true);
    return rows.sort((a, b) => a.id - b.id).slice(0, opts.maxRecords ?? 500) as T[];
  };
  return { q, calls };
}

describe('prepare', () => {
  const companies = Array.from({ length: 6000 }, (_, i) => ({ id: 100000 + i, companyName: 'Gmail', isActive: i !== 5, createDate: '2026-09-01', createdByResourceID: 77 }));
  const contacts = companies.map((c, i) => ({ id: 500000 + i, companyID: c.id, isActive: i !== 7, firstName: 'Unknown', lastName: 'Contact' }));
  contacts[9] = { ...contacts[9]!, firstName: 'Avery', lastName: 'Lee' }; // a real-looking person on company 100009
  const tables = { Companies: companies, Contacts: contacts, Tickets: [{ id: 1, companyID: 100003 }, { id: 2, companyID: 100003 }], Invoices: [{ id: 3, companyID: 100004 }] };

  test('pages past 4,999, excludes companies with history or a real-named contact, inactivates contacts before their company', async () => {
    const { q, calls } = fakeQ(tables);
    const r = await preparePlaceholderJob(q, { companyName: 'Gmail' });
    expect(calls.filter(([e, f]) => e === 'Companies' && f.some((x: any) => x.op === 'gt')).length).toBe(2); // 4,999 + 1,001
    expect(r.stats).toMatchObject({ companies: 6000, excludedCompanies: 3, companiesAlreadyInactive: 1 });
    const ex = r.items.filter((i) => i.status === 'excluded');
    expect(ex.map((i) => [i.recordId, i.reason])).toEqual([[100003, '2 tickets'], [100004, '1 invoices'], [100009, expect.stringMatching(/real name/)]]);
    // company 100005 is already inactive: its contact is inactivated, the company is not written
    expect(r.items.filter((i) => i.recordId === 100005 || i.parentId === 100005).map((i) => i.entity)).toEqual(['Contacts']);
    // contact of 100007 is already inactive: only the company
    expect(r.items.filter((i) => i.recordId === 100007 || i.parentId === 100007).map((i) => i.entity)).toEqual(['Companies']);
    // order: contact first, then its company
    const k = r.items.findIndex((i) => i.recordId === 100000);
    expect(r.items[k - 1]).toMatchObject({ entity: 'Contacts', parentId: 100000 });
    expect(r.stats.writes).toBe((r.stats.companyWrites as number) + (r.stats.contactWrites as number));
  });

  test('a history check that fails stops everything — never "no history"', async () => {
    const { q } = fakeQ(tables, { fail: 'Quotes' });
    await expect(preparePlaceholderJob(q, { companyName: 'Gmail' })).rejects.toThrow(/history check on quotes failed/);
  });

  test('a selection that includes a real company is refused', async () => {
    const { q } = fakeQ({ Companies: [{ id: 1, companyName: 'Contoso Office Centers', isActive: true }] });
    await expect(preparePlaceholderJob(q, { companyName: 'Contoso Office Centers' })).rejects.toThrow(/not placeholders/);
  });

  test('the approval hash binds the records to write (excluded ones are not part of it)', () => {
    const a = [{ entity: 'Companies' as const, recordId: 1, action: 'inactivate' as const }, { entity: 'Companies' as const, recordId: 2, action: 'inactivate' as const, status: 'excluded' as const }];
    expect(itemsHash('k', a)).toBe(itemsHash('k', [a[0]!]));
    expect(itemsHash('k', a)).not.toBe(itemsHash('k', [{ ...a[0]!, recordId: 3 }]));
  });
});

describe('business hours', () => {
  const s = DEFAULT_SCHEDULE; // Mon–Fri 07:00–18:59 America/New_York, 1,000/hour
  test('slower inside the window, full rate outside; time-zone aware', () => {
    expect(inBusinessHours(new Date('2026-10-20T14:00:00Z'), s)).toBe(true);   // Tue 10:00 EDT
    expect(inBusinessHours(new Date('2026-10-20T23:30:00Z'), s)).toBe(false);  // Tue 19:30 EDT
    expect(inBusinessHours(new Date('2026-10-18T14:00:00Z'), s)).toBe(false);  // Sunday
    expect(currentRate(new Date('2026-10-20T14:00:00Z'), 3000, s)).toEqual({ rate: 1000, business: true });
    expect(currentRate(new Date('2026-10-20T02:00:00Z'), 3000, s)).toEqual({ rate: 3000, business: false });
    expect(currentRate(new Date('2026-10-20T14:00:00Z'), 3000, null)).toEqual({ rate: 3000, business: false });
    expect(weeklyCapacity(3000, s)).toBe(60 * 1000 + 108 * 3000);
  });
  test('activity profile suggests the busy weekday window from traffic', () => {
    // Weekdays: busy 08:00–17:59 local (12–21 UTC in EDT), quiet otherwise.
    const hourly = [];
    for (let d = 0; d < 5; d++) for (let h = 0; h < 24; h++) { const t = Date.UTC(2026, 9, 19 + d, h) / 3_600_000; hourly.push({ hour: t, upstream: h >= 12 && h <= 21 ? 2000 : 200, writes: 0 }); }
    const p = activityProfile(hourly, 'America/New_York') as { suggested: { start: number; end: number } };
    expect(p.suggested).toMatchObject({ start: 8, end: 18 });
  });
  test('bulk worker writes never shape the profile; a flat profile suggests nothing (it used to say 00:00–24:00)', () => {
    const hourly = [];
    for (let d = 0; d < 5; d++) for (let h = 0; h < 24; h++) { const t = Date.UTC(2026, 9, 19 + d, h) / 3_600_000; hourly.push({ hour: t, upstream: 100, writes: h >= 23 || h <= 3 ? 3000 : 1000, byTools: 100 }); }
    expect((activityProfile(hourly, 'America/New_York') as { suggested: unknown }).suggested).toBeNull();
    expect(suggestWindow(new Array(24).fill(5))).toBeNull();
    expect(suggestWindow([0, 0, 0, 0, 0, 0, 0, 1, 9, 10, 12, 11, 8, 10, 11, 9, 7, 2, 1, 0, 0, 0, 0, 0])).toEqual({ days: [1, 2, 3, 4, 5], start: 8, end: 17 });
  });
  test('team activity: people, integrations and writes via this MCP apart; only people set the window', () => {
    // 101 = a person, 202 = an API user, 303 = a person whose notes were also written through this MCP at night.
    const classify = (id: number) => (id === 202 ? { name: 'RMM Z - API', kind: 'integration' as const } : { name: id === 101 ? 'Avery Lee' : 'Sam Roe', kind: 'person' as const });
    const rows: Array<{ dow: number; hour: number; who: string; via: string | null; n: number; events: number }> = [];
    for (let dow = 1; dow <= 5; dow++) for (let hour = 8; hour < 17; hour++) rows.push({ dow, hour, who: '101', via: null, n: 4, events: 40 });
    for (let dow = 1; dow <= 5; dow++) for (let hour = 0; hour < 24; hour++) rows.push({ dow, hour, who: '202', via: null, n: 4, events: 20 });
    rows.push({ dow: 1, hour: 23, who: '303', via: 'n8n', n: 4, events: 400 });
    const p = profileFromRows(rows, 'America/New_York', classify, 28) as Record<string, any>;
    const byKey = Object.fromEntries(p.series.map((s: any) => [s.key, s]));
    expect(byKey['person:101']).toMatchObject({ label: 'Avery Lee', kind: 'person' });
    expect(byKey['integration:202']).toMatchObject({ label: 'RMM Z - API', kind: 'integration' });
    expect(byKey['mcp:303']).toMatchObject({ label: 'Sam Roe via this MCP (n8n)', kind: 'mcp' });
    expect(byKey['person:101'].weekday[9]).toBe(10); // 200 records over 20 weekdays
    expect(p.peopleActivePerHour[9]).toBe(1); // 20 person-days over 20 weekdays
    expect(p.peopleActivePerHour[23]).toBe(0); // the MCP's night writes are not people working
    expect(p.suggested).toEqual({ days: [1, 2, 3, 4, 5], start: 8, end: 17 }); // integrations run 24h: ignored
    expect((profileFromRows([{ dow: 1, hour: 9, who: '101', via: null, n: 5, events: 5 }], 'UTC', classify) as Record<string, any>).suggested).toBeNull(); // too little to say
    // More than 8 of a kind fold into "Other …".
    const many = Array.from({ length: 12 }, (_, k) => ({ dow: 2, hour: 10, who: String(500 + k), via: null, n: 1, events: 12 - k }));
    const q = profileFromRows(many, 'UTC', () => ({ name: null, kind: 'person' }), 28) as Record<string, any>;
    expect(q.series.map((s: any) => s.label).slice(-1)).toEqual(['Other people (4)']);
  });
  test('background jobs (the nightly mirror check) do not make 3 AM look like business hours', () => {
    const hourly = [];
    for (let d = 0; d < 5; d++) for (let h = 0; h < 24; h++) { const t = Date.UTC(2026, 9, 19 + d, h) / 3_600_000; hourly.push({ hour: t, upstream: h === 8 ? 9000 : h >= 12 && h <= 21 ? 1500 : 100, writes: 0, byTools: h >= 12 && h <= 21 ? 1400 : 50 }); }
    expect((activityProfile(hourly, 'America/New_York') as { suggested: { start: number; end: number } }).suggested).toMatchObject({ start: 8, end: 18 });
  });
});

describe('worker', () => {
  const mkJob = (o: Partial<BulkJob> = {}): BulkJob => ({ id: 'j', kind: 'inactivate_placeholders', title: 't', params: { schedule: null }, status: 'running', hash: 'h', ratePerHour: 3600, canarySize: 2, pauseReason: null, lastError: null, stats: {}, createdBy: null, approvedBy: 'u', approvedAt: 'x', startedAt: 'x', finishedAt: null, createdAt: 'x', updatedAt: 'x', ...o });
  const item = (seq: number, o: Partial<BulkItem> = {}): BulkItem => ({ seq, entity: 'Companies', recordId: 1000 + seq, parentId: null, action: 'inactivate', status: 'pending', reason: null, attempts: 0, before: null, error: null, doneAt: null, ...o });
  function harness(items: BulkItem[], job = mkJob(), fail: (it: BulkItem) => Error | null = () => null) {
    const state = { job, items };
    const writes: string[] = [];
    let now = 0;
    const store = {
      running: async () => (state.job.status === 'running' ? [state.job] : []),
      next: async () => state.items.filter((i) => i.status === 'pending').slice(0, 1),
      markItem: async (_: string, seq: number, status: any, o: any = {}) => { const i = state.items.find((x) => x.seq === seq)!; i.status = status; i.attempts++; i.error = o.error ?? null; i.reason = o.reason ?? i.reason; },
      retryLater: async (_: string, seq: number, error: string) => { const i = state.items.find((x) => x.seq === seq)!; i.attempts++; i.error = error; },
      setStatus: async (_: string, status: any, o: any = {}) => { state.job = { ...state.job, status, ...(o.pauseReason !== undefined ? { pauseReason: o.pauseReason } : {}), ...(o.lastError !== undefined ? { lastError: o.lastError } : {}), stats: { ...state.job.stats, ...(o.stats ?? {}) } }; },
      counts: async () => ({}),
    };
    const fns = {
      inactivateCompany: async (id: number) => { const e = fail(state.items.find((i) => i.recordId === id)!); if (e) throw e; writes.push(`co:${id}`); },
      inactivateContact: async (id: number, co: number) => { writes.push(`ct:${id}@${co}`); },
    };
    let level: 'ok' | 'slow' | 'stop' = 'ok';
    const w = new BulkWorker({ store: store as never, fns, level: () => level, now: () => now, notify: () => undefined });
    return { w, state, writes, advance: (ms: number) => { now += ms; }, setLevel: (l: typeof level) => { level = l; } };
  }

  test('paced: at most one write per gap; canary pauses after its size; resume continues; done at the end', async () => {
    const h = harness([item(1), item(2), item(3)]);
    h.advance(10_000);
    expect(await h.w.tick()).toBe('done');      // item 1 written (outcome 'done')
    expect(await h.w.tick()).toBe('pacing');    // 3,600/hour → 1 s gap
    h.advance(1000); expect(await h.w.tick()).toBe('done');
    h.advance(1000); expect(await h.w.tick()).toBe('canary-pause');
    expect(h.state.job.status).toBe('paused');
    h.state.job = { ...h.state.job, status: 'running' };
    h.advance(1000); await h.w.tick();
    h.advance(1000); expect(await h.w.tick()).toBe('done'); // nothing pending → job done
    expect(h.state.job.status).toBe('done');
    expect(h.writes).toEqual(['co:1001', 'co:1002', 'co:1003']);
  });

  test('backpressure: "slow" doubles the gap, "stop" writes nothing', async () => {
    expect(writeGapMs(3000, 'ok')).toBe(1200);
    expect(writeGapMs(3000, 'slow')).toBe(2400);
    expect(writeGapMs(3000, 'stop')).toBeNull();
    const h = harness([item(1)]); h.setLevel('stop'); h.advance(10_000);
    expect(await h.w.tick()).toBe('backpressure-stop');
    expect(h.writes).toEqual([]);
  });

  test('a 401 pauses the job (item kept); 404 is skipped; transient errors retry, then fail after 3 tries', async () => {
    const err = (st: number, m = `HTTP ${st}`) => Object.assign(new Error(m), { status: st });
    expect(await applyItem(item(1), { inactivateCompany: async () => { throw err(401); }, inactivateContact: async () => undefined })).toMatchObject({ status: 'pause' });
    expect(await applyItem(item(1), { inactivateCompany: async () => { throw err(404); }, inactivateContact: async () => undefined })).toMatchObject({ status: 'skipped' });
    expect(await applyItem(item(1), { inactivateCompany: async () => { throw err(500); }, inactivateContact: async () => undefined })).toMatchObject({ status: 'retry' });
    expect(await applyItem(item(1, { attempts: 2 }), { inactivateCompany: async () => { throw err(500); }, inactivateContact: async () => undefined })).toMatchObject({ status: 'failed' });
    const h = harness([item(1), item(2)], mkJob({ canarySize: 99 }), (it) => (it.seq === 1 ? err(401) : null));
    h.advance(10_000); expect(await h.w.tick()).toBe('paused');
    expect(h.state.job.status).toBe('paused');
    expect(h.state.items[0]!.status).toBe('pending');
    expect(h.writes).toEqual([]);
  });

  test('a 429 is a wait, not a failure: no attempt used, no failure streak, the record stays pending', async () => {
    const t429 = () => Object.assign(new Error('Autotask API threshold exceeded (HTTP 429) — this tenant is in a 30s cooldown'), { status: 429 });
    expect(await applyItem(item(1, { attempts: 2 }), { inactivateCompany: async () => { throw t429(); }, inactivateContact: async () => undefined })).toMatchObject({ status: 'wait' });
    let throttled = true;
    const h = harness([item(1), item(2)], mkJob({ canarySize: 99 }), () => (throttled ? t429() : null));
    for (let i = 0; i < 30; i++) { h.advance(61_000); await h.w.tick(); }
    expect(h.state.job.status).toBe('running'); // 30 throttled writes never trip the 20-in-a-row pause
    expect(h.state.job.lastError).toMatch(/^\[\d{4}-\d\d-\d\d \d\d:\d\d UTC\] waiting out Autotask throttling/);
    expect(h.state.items.map((x) => [x.status, x.attempts])).toEqual([['pending', 0], ['pending', 0]]);
    h.advance(1000); expect(await h.w.tick()).toBe('pacing'); // waits after a throttled write
    throttled = false; h.advance(61_000);
    expect(await h.w.tick()).toBe('done');
    expect(h.writes).toEqual(['co:1001']);
    expect(h.state.job.lastError).toBeNull(); // a write that went through clears it (it used to stay on the card for days)
  });

  test('a contact is inactivated through its company (the child route)', async () => {
    const h = harness([item(1, { entity: 'Contacts', recordId: 31, parentId: 900 })], mkJob({ canarySize: 99 }));
    h.advance(10_000); await h.w.tick();
    expect(h.writes).toEqual(['ct:31@900']);
  });
});

describe('tool guards', () => {
  const h = new Map(bulkToolHandlers({} as never, () => ({ query: async () => ({ rows: [] }) }) as never)).get('autotask_bulk_inactivate')!;
  const ctx = { source: 'chatgpt' } as never;
  test('never a real company name; start without confirm writes nothing', async () => {
    expect((await h({ action: 'prepare', companyName: 'Contoso Office Centers' }, ctx)).message).toMatch(/not a placeholder/);
    expect((await h({ action: 'prepare' }, ctx)).message).toMatch(/companyName/);
  });
});

describe('job actions (console + tool share them)', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { jobAction, scheduleOf } = require('../src/bulk/service');
  const mk = (status: string) => {
    const calls: string[] = [];
    const job = { id: 'j', kind: 'k', title: 't', params: {}, status, hash: itemsHash('k', [{ entity: 'Companies', recordId: 1, action: 'inactivate' }]), ratePerHour: 3000, canarySize: 50, pauseReason: null, lastError: null, stats: {} };
    const st = { allItemKeys: async () => [{ entity: 'Companies', recordId: 1, action: 'inactivate', status: 'pending' }], setStatus: async (_: string, s: string) => { calls.push(s); }, requeueFailed: async () => 3 };
    return { job, st, calls };
  };
  test('approve needs ready + the exact hash; start needs approved; resume needs paused; cancel not twice', async () => {
    let m = mk('ready');
    expect(await jobAction(m.st, m.job, 'approve', { hash: 'nope', by: 'a' })).toMatchObject({ ok: false, status: 'hash_mismatch' });
    expect(await jobAction(m.st, m.job, 'approve', { hash: m.job.hash, by: 'a' })).toMatchObject({ ok: true, status: 'approved' });
    expect(m.calls).toEqual(['approved']);
    m = mk('ready'); expect(await jobAction(m.st, m.job, 'start', { by: 'a' })).toMatchObject({ ok: false });
    m = mk('approved'); expect(await jobAction(m.st, m.job, 'start', { by: 'a' })).toMatchObject({ ok: true, status: 'running' });
    m = mk('running'); expect(await jobAction(m.st, m.job, 'resume', { by: 'a' })).toMatchObject({ ok: false });
    m = mk('paused'); expect(await jobAction(m.st, m.job, 'resume', { by: 'a' })).toMatchObject({ ok: true, status: 'running' });
    m = mk('done'); expect(await jobAction(m.st, m.job, 'cancel', { by: 'a' })).toMatchObject({ ok: false });
    m = mk('paused'); expect((await jobAction(m.st, m.job, 'retry_failed', { by: 'a' })).message).toMatch(/3 failed item\(s\) back in the queue — resume/);
  });
  test('business hours: defaults, custom, or off', () => {
    expect(scheduleOf({})).toEqual(DEFAULT_SCHEDULE);
    expect(scheduleOf({ businessHours: false })).toBeNull();
    expect(scheduleOf({ businessHours: { start: 8, end: 17, days: [1, 2] }, businessRate: 500 })).toMatchObject({ start: 8, end: 17, days: [1, 2], businessRate: 500, tz: 'America/New_York' });
  });
});

describe('bulk thresholds', () => {
  test('bulk jobs yield before dispatchers: slow from 40%, stop at 65%', () => {
    const lvl = (pct: number) => assessBackpressure({ usage: { usedPct: pct, used: pct * 100, limit: 10000, at: new Date().toISOString() }, auth: null, cooldownSeconds: 0, queued: 0 }, BULK_THRESHOLDS).level;
    expect([lvl(39), lvl(40), lvl(64), lvl(65)]).toEqual(['ok', 'slow', 'slow', 'stop']);
  });
});

describe('junk contacts on one company', () => {
  const company = { id: 4242, companyName: 'Example Insurance', isActive: true, webAddress: 'https://www.example-ins.com' };
  const ct = (id: number, email: string | null, extra: Row = {}) => ({ id, companyID: 4242, isActive: 1, firstName: 'P', lastName: String(id), emailAddress: email, createDate: '2026-09-10T12:00:00', ...extra });
  const contacts = [
    ct(1, 'owner@example-ins.com', { primaryContact: true }),
    ct(2, 'agent@example-ins.com'),
    ct(3, 'random1@gmail.com'),
    ct(4, 'spam@junkmail.biz'),
    ct(5, 'spam2@junkmail.biz'),
    ct(6, 'partner@broker-partner.com'),
    ct(7, null),
    ct(8, 'old@hotmail.com', { isActive: 0 }),
    ct(9, 'quoted@gmail.com'),
    ct(10, 'early@gmail.com', { createDate: '2025-01-01T00:00:00' }),
    { ...ct(11, 'other@gmail.com'), companyID: 999 },
  ];
  const tables = { Companies: [company], Contacts: contacts, Tickets: [{ id: 70, contactID: 4 }, { id: 71, contactID: 6 }], Quotes: [{ id: 80, contactID: 9 }] };

  test('domain rule: keeps the company domains (web address + history), excludes primary / history, skips no-email and inactive', async () => {
    const { q } = fakeQ(tables);
    const r = await prepareCompanyContactsJob(q, { companyId: 4242 });
    const write = r.items.filter((i: Row) => i.status !== 'excluded').map((i: Row) => i.recordId);
    const excluded = Object.fromEntries(r.items.filter((i: Row) => i.status === 'excluded').map((i: Row) => [i.recordId, i.reason]));
    // 6 is on a ticket → its domain counts as the company's own; 4's junk domain too (tickets aren't ok by default)
    expect(r.stats.companyDomains).toMatchObject({ 'example-ins.com': 'web address', 'broker-partner.com': expect.stringMatching(/history/) });
    expect(write).toEqual([3, 10]);
    expect(excluded).toEqual({ 9: '1 quotes' });
    expect(r.items.every((i: Row) => i.parentId === 4242 && i.entity === 'Contacts')).toBe(true);
    expect(r.stats.kept).toMatchObject({ 'company domain': 5, 'no email address': 1 });
    expect((r.stats.byDomain as Row)['gmail.com']).toMatchObject({ inactivate: 2, excluded: 1 });
  });

  test('ticketsOk: ticket-only history neither protects the contact nor its domain; window and onlyDomains narrow it', async () => {
    const { q } = fakeQ(tables);
    const r = await prepareCompanyContactsJob(q, { companyId: 4242, ticketsOk: true, createdFrom: '2026-09-01' });
    expect(r.items.filter((i: Row) => i.status !== 'excluded').map((i: Row) => i.recordId)).toEqual([3, 4, 5, 6]);
    expect(r.items.find((i: Row) => i.recordId === 4)!.before).toMatchObject({ tickets: 1, email: 'spam@junkmail.biz' });
    const only = await prepareCompanyContactsJob(fakeQ(tables).q, { companyId: 4242, ticketsOk: true, onlyDomains: ['junkmail.biz'], keepDomains: ['broker-partner.com'] });
    expect(only.items.filter((i: Row) => i.status !== 'excluded').map((i: Row) => i.recordId)).toEqual([4, 5]);
  });

  test('explicit list: only those, still never the primary contact; ids from another company refuse the job', async () => {
    const r = await prepareCompanyContactsJob(fakeQ(tables).q, { companyId: 4242, contactIds: [1, 2, 7] });
    expect(r.items.map((i: Row) => [i.recordId, i.status ?? 'pending'])).toEqual([[1, 'excluded'], [2, 'pending'], [7, 'pending']]);
    await expect(prepareCompanyContactsJob(fakeQ(tables).q, { companyId: 4242, contactIds: [2, 11] })).rejects.toThrow(/not on company 4242/);
    await expect(prepareCompanyContactsJob(fakeQ(tables).q, { companyId: 0 })).rejects.toThrow(/your own company/);
  });

  test('a failed history check prepares nothing', async () => {
    await expect(prepareCompanyContactsJob(fakeQ(tables, { fail: 'Opportunities' }).q, { companyId: 4242 })).rejects.toThrow(/history check on opportunities failed/);
  });
});
