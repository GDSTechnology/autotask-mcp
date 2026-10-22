// A preparation's reads wait out Autotask throttling instead of failing. Preparing a bulk job is
// read-only and takes minutes; a 429 (the tenant's 10,000 calls/hour used up — e.g. another
// integration's burst) used to fail it outright (2026-10-22 00:22: an email-to-ticket burst).
// Now a throttled read waits and is retried, up to a total wait; anything else still fails the
// preparation (fail closed — a history check is never assumed empty).

import type { QueryFn } from '../vendors/contract-io.js';

export const THROTTLE_WAIT_MS = 60_000;
export const MAX_THROTTLE_WAIT_MS = 3 * 3_600_000;

export const isThrottled = (e: unknown): boolean => {
  const st = (e as { status?: number })?.status;
  return st === 429 || /\b429\b|threshold exceeded|cooldown/i.test(String((e as Error)?.message ?? e));
};

export interface PatientOpts {
  /** Called once per wait (for the job's status line). */
  onWait?: (info: { waitedMs: number; untilIso: string; error: string }) => void | Promise<void>;
  waitMs?: number; maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>; now?: () => number;
}

/** Wrap a query function: throttled reads wait (waitMs each) and retry until maxWaitMs in all, then fail. */
export function patientQuery(q: QueryFn, o: PatientOpts = {}): QueryFn {
  const waitMs = o.waitMs ?? THROTTLE_WAIT_MS, maxWaitMs = o.maxWaitMs ?? MAX_THROTTLE_WAIT_MS;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? (() => Date.now());
  let waited = 0;
  return (async <T>(entity: string, filters: Parameters<QueryFn>[1], opts: Parameters<QueryFn>[2]) => {
    for (;;) {
      try { return await q<T>(entity, filters, opts); }
      catch (e) {
        if (!isThrottled(e)) throw e;
        if (waited + waitMs > maxWaitMs) throw new Error(`Autotask kept throttling (HTTP 429) for ${Math.round(waited / 60_000)} min — nothing prepared; prepare it again later`, { cause: e });
        await o.onWait?.({ waitedMs: waited, untilIso: new Date(now() + waitMs).toISOString(), error: (e instanceof Error ? e.message : String(e)).slice(0, 160) });
        await sleep(waitMs);
        waited += waitMs;
      }
    }
  }) as QueryFn;
}
