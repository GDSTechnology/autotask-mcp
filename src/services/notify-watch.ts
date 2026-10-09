// Turns the MCP's own state into notifications (admin console → Notifications).
// Polls every 20 s — no hooks threaded through the HTTP client — and raises an
// event on a TRANSITION, so a condition that persists is reported once (plus
// the notifier's per-channel cooldown):
//   login protection: paused / held / working again
//   backpressure: → stop, and back to ok
//   a new 429 cooldown
//   a mirror (shadow) sync run with an entity error
//   a mirror consistency check that needs attention
//   5+ tool errors in 5 minutes
// "A write failed after writing" is raised where it happens (tool handler).

import { backpressure, type Backpressure } from './backpressure.js';
import { recentToolCalls } from './call-log.js';
import { notify as defaultNotify, type NotifyEvent } from './notifier.js';
import type { RunReport } from '../db/shadow-sync.js';
import type { VerifyReport } from '../db/shadow-verify.js';

export interface WatchSources {
  backpressure: () => Backpressure;
  lastRun: () => { at: string; report: RunReport } | null;
  lastVerify: () => VerifyReport | null;
  toolErrors: (sinceMs: number) => Array<{ tool: string; error: string | null; at: string }>;
}

export interface WatchState { auth: 'ok' | 'paused' | 'held'; level: Backpressure['level']; cooldown: boolean; runAt: string | null; verifyAt: string | null; errorBurstAt: number }

export const initialWatchState = (): WatchState => ({ auth: 'ok', level: 'ok', cooldown: false, runAt: null, verifyAt: null, errorBurstAt: 0 });

/** One check: the events due given the previous state; returns the new state. Pure apart from the sources. */
export function checkOnce(src: WatchSources, prev: WatchState, now = Date.now()): { state: WatchState; events: NotifyEvent[] } {
  const events: NotifyEvent[] = [];
  const state: WatchState = { ...prev };
  const at = new Date(now).toISOString();

  const bp = src.backpressure();
  const auth: WatchState['auth'] = bp.auth?.held ? 'held' : bp.auth?.blockedUntil ? 'paused' : 'ok';
  if (auth !== prev.auth) {
    if (auth === 'held') events.push({ type: 'auth.held', severity: 'critical', title: 'Autotask login HELD', detail: 'Autotask kept rejecting the API login, so the MCP stopped trying. Fix the API user (password / lock / integration code), then press **Retry now** on the console Overview.', fields: { failures: String(bp.auth?.failures ?? '?'), 'last error': bp.auth?.lastError ?? '' }, at });
    else if (auth === 'paused') events.push({ type: 'auth.paused', severity: 'warning', title: 'Autotask login paused', detail: `Autotask rejected the API login. All calls are paused until ${bp.auth?.blockedUntil ?? '?'}; the MCP then makes one test call.`, fields: { failures: String(bp.auth?.failures ?? '?'), 'last error': bp.auth?.lastError ?? '' }, at });
    else events.push({ type: 'auth.cleared', severity: 'info', title: 'Autotask login working again', detail: 'The API login is accepted; calls are flowing.', at });
    state.auth = auth;
  }
  // state.level remembers "stopped" through a slow spell until it is fully ok again.
  if (bp.level === 'stop' && prev.level !== 'stop') {
    events.push({ type: 'backpressure.stop', severity: 'warning', title: 'Autotask backpressure: STOP', detail: bp.reasons.join('\n') || 'stop', fields: { 'retry after': bp.retryAfterSeconds != null ? `${bp.retryAfterSeconds}s` : 'until fixed', 'tenant usage': bp.autotask.usedPct != null ? `${bp.autotask.usedPct}%` : 'unknown' }, at, dedupeKey: 'backpressure.stop' });
  } else if (bp.level === 'ok' && prev.level === 'stop') {
    events.push({ type: 'backpressure.recovered', severity: 'info', title: 'Autotask backpressure back to OK', detail: 'Dispatchers can send work again.', fields: { 'tenant usage': bp.autotask.usedPct != null ? `${bp.autotask.usedPct}%` : 'unknown' }, at });
  }
  state.level = bp.level === 'slow' ? (prev.level === 'stop' ? 'stop' : 'slow') : bp.level;
  const cooldown = bp.rateLimitCooldownSeconds > 0;
  if (cooldown && !prev.cooldown) events.push({ type: 'ratelimit.hit', severity: 'warning', title: 'Autotask 429 — API threshold exceeded', detail: `Autotask refused a call (rate limit). Calls fail locally for ${bp.rateLimitCooldownSeconds}s instead of piling on.`, fields: { 'tenant usage': bp.autotask.usedPct != null ? `${bp.autotask.usedPct}%` : 'unknown' }, at });
  state.cooldown = cooldown;

  const run = src.lastRun();
  if (run && run.at !== prev.runAt) {
    for (const e of run.report.entities.filter((x) => x.error && x.error !== 'run budget spent')) {
      events.push({ type: 'shadow.sync_error', severity: 'warning', title: `Mirror sync error: ${e.entity}`, detail: e.error!, fields: { entity: e.entity, mode: e.mode }, at, dedupeKey: `shadow.sync_error:${e.entity}:${e.error!.slice(0, 80)}` });
    }
    state.runAt = run.at;
  }
  const v = src.lastVerify();
  if (v && v.at !== prev.verifyAt) {
    if (v.status === 'attention') {
      const bad = v.entities.filter((e) => e.differs || e.missing || e.countOk === false || e.error);
      events.push({ type: 'shadow.verify_failed', severity: 'warning', title: 'Mirror consistency check needs attention', detail: bad.map((e) => `${e.entity}: ${e.error ?? `${e.differs} differ, ${e.missing} missing${e.countOk === false ? `, count ${e.mirrorCount} vs ${e.autotaskCount}` : ''}`}`).join('\n') || 'See the console Mirror page.', fields: { trigger: v.trigger, repaired: String(v.entities.reduce((n, e) => n + e.repaired, 0)) }, at, dedupeKey: `shadow.verify_failed:${v.at}` });
    }
    state.verifyAt = v.at;
  }

  const errs = src.toolErrors(now - 5 * 60_000);
  if (errs.length >= 5 && now - prev.errorBurstAt > 15 * 60_000) {
    const byTool = new Map<string, number>();
    for (const e of errs) byTool.set(e.tool, (byTool.get(e.tool) ?? 0) + 1);
    events.push({ type: 'tool.errors', severity: 'warning', title: `${errs.length} tool errors in 5 minutes`, detail: errs.slice(0, 3).map((e) => `${e.tool}: ${(e.error ?? '').slice(0, 160)}`).join('\n'), fields: Object.fromEntries([...byTool.entries()].slice(0, 6).map(([k, n]) => [k, String(n)])), at });
    state.errorBurstAt = now;
  }
  return { state, events };
}

/** Start watching (http transport). Returns a stop function. */
export function startNotifyWatch(o: { tenant: string; lastRun: WatchSources['lastRun']; lastVerify: WatchSources['lastVerify']; intervalMs?: number; notify?: (e: NotifyEvent) => void }): () => void {
  const src: WatchSources = {
    backpressure: () => backpressure(o.tenant),
    lastRun: o.lastRun,
    lastVerify: o.lastVerify,
    toolErrors: (since) => recentToolCalls({ errorsOnly: true, limit: 200 }).filter((c) => c.outcome === 'error' && Date.parse(c.at) >= since).map((c) => ({ tool: c.tool, error: c.error, at: c.at })),
  };
  // Start from the current state, so a restart doesn't re-announce what is already known.
  let state = checkOnce(src, initialWatchState()).state;
  const send = o.notify ?? defaultNotify;
  const t = setInterval(() => {
    try { const r = checkOnce(src, state); state = r.state; for (const e of r.events) send(e); } catch { /* never let the watcher crash the server */ }
  }, o.intervalMs ?? 20_000);
  t.unref?.();
  return () => clearInterval(t);
}
