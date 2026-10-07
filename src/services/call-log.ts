// Recent-calls log for diagnostics (admin console "Calls" page): the last tool
// calls (who called, outcome, duration, how many Autotask calls each made) and
// the last Autotask API calls (status, duration, which tool call caused them —
// or which background job).
//
// In memory only, bounded ring buffers (reset on restart). Never records tool
// arguments or response bodies: tool name, caller, outcome, timings, and a
// truncated error message only. Autotask paths are logged without host or
// query string.

import { AsyncLocalStorage } from 'node:async_hooks';

export interface ToolCallRecord {
  id: number;
  at: string;
  tool: string;
  /** 'running' until the call finishes. */
  outcome: string;
  durationMs: number | null;
  source: string | null;
  user: string | null;
  ip: string | null;
  userAgent: string | null;
  error: string | null;
  /** Autotask calls this tool call sent upstream / answered from the read cache / from the Postgres shadow. */
  apiCalls: number;
  cacheHits: number;
  shadowReads: number;
}

export interface ApiCallRecord {
  id: number;
  at: string;
  method: string;
  path: string;
  /** HTTP status; 0 = network error / timeout. */
  status: number | null;
  durationMs: number | null;
  /** The tool call that caused it, if any. */
  toolCallId: number | null;
  tool: string | null;
  /** Background job that caused it (e.g. "shadow sync"), when not a tool call. */
  job: string | null;
  error: string | null;
}

const MAX_TOOLS = 500;
const MAX_API = 2000;
const tools: ToolCallRecord[] = [];
const api: ApiCallRecord[] = [];
let nextTool = 1, nextApi = 1;

type Scope = { tool?: ToolCallRecord; job?: string };
const scope = new AsyncLocalStorage<Scope>();

const push = <T>(arr: T[], v: T, max: number) => { arr.push(v); if (arr.length > max) arr.splice(0, arr.length - max); };
const clip = (s: string | undefined | null, n = 300): string | null => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : null);

/** Autotask path for the log: no host, no zone prefix, no query string. */
export function cleanPath(path: string): string {
  let p = path;
  if (p.startsWith('http')) { try { p = new URL(p).pathname; } catch { /* keep */ } }
  p = p.split('?')[0]!.replace(/^.*?\/v1\.0/i, '');
  return p.startsWith('/') ? p : `/${p}`;
}

/** Run one tool call with its log record in scope. */
export async function runToolCall<T extends { isError?: boolean }>(tool: string, fn: () => Promise<T>): Promise<T> {
  const rec: ToolCallRecord = { id: nextTool++, at: new Date().toISOString(), tool, outcome: 'running', durationMs: null, source: null, user: null, ip: null, userAgent: null, error: null, apiCalls: 0, cacheHits: 0, shadowReads: 0 };
  push(tools, rec, MAX_TOOLS);
  const started = Date.now();
  try {
    const r = await scope.run({ tool: rec }, fn);
    if (rec.outcome === 'running') rec.outcome = r?.isError ? 'error' : 'ok';
    return r;
  } catch (err) {
    rec.outcome = 'error';
    rec.error ??= clip(err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    rec.durationMs ??= Date.now() - started;
  }
}

/** Run background work (e.g. the shadow sync) so its Autotask calls are labelled. */
export function runJob<T>(job: string, fn: () => Promise<T>): Promise<T> {
  return scope.run({ job }, fn);
}

/** Fill the current tool call's caller + outcome (from the audit record). */
export function noteToolAudit(info: { outcome: string; durationMs: number; source?: string; user?: string | undefined; ip?: string | undefined; userAgent?: string | undefined; error?: string | undefined }): void {
  const rec = scope.getStore()?.tool;
  if (!rec) return;
  rec.outcome = info.outcome;
  rec.durationMs = info.durationMs;
  rec.source = info.source ?? null;
  rec.user = info.user ?? null;
  rec.ip = info.ip ?? null;
  rec.userAgent = clip(info.userAgent, 120);
  rec.error = clip(info.error);
}

export function noteCacheHit(): void { const r = scope.getStore()?.tool; if (r) r.cacheHits++; }
export function noteShadowRead(): void { const r = scope.getStore()?.tool; if (r) r.shadowReads++; }

/** Start an upstream Autotask call; call the returned function when it ends. */
export function startApiCall(method: string, path: string): (status: number, error?: string) => void {
  const s = scope.getStore();
  const rec: ApiCallRecord = { id: nextApi++, at: new Date().toISOString(), method: method.toUpperCase(), path: cleanPath(path), status: null, durationMs: null, toolCallId: s?.tool?.id ?? null, tool: s?.tool?.tool ?? null, job: s?.job ?? null, error: null };
  push(api, rec, MAX_API);
  if (s?.tool) s.tool.apiCalls++;
  const started = Date.now();
  return (status, error) => { rec.status = status; rec.durationMs = Date.now() - started; rec.error = clip(error, 200); };
}

export interface CallQuery { limit?: number; beforeId?: number; tool?: string; source?: string; errorsOnly?: boolean; toolCallId?: number }

const isErr = (o: string) => o !== 'ok' && o !== 'running' && o !== 'idempotent-replay';

/** Newest first. */
export function recentToolCalls(q: CallQuery = {}): ToolCallRecord[] {
  const limit = Math.min(Math.max(q.limit ?? 100, 1), MAX_TOOLS);
  const tool = q.tool?.toLowerCase();
  const out: ToolCallRecord[] = [];
  for (let i = tools.length - 1; i >= 0 && out.length < limit; i--) {
    const r = tools[i]!;
    if (q.beforeId && r.id >= q.beforeId) continue;
    if (tool && !r.tool.toLowerCase().includes(tool)) continue;
    if (q.source && (r.source ?? 'unknown') !== q.source) continue;
    if (q.errorsOnly && !isErr(r.outcome)) continue;
    out.push({ ...r });
  }
  return out;
}

export function recentApiCalls(q: CallQuery = {}): ApiCallRecord[] {
  const limit = Math.min(Math.max(q.limit ?? 100, 1), MAX_API);
  const tool = q.tool?.toLowerCase();
  const out: ApiCallRecord[] = [];
  for (let i = api.length - 1; i >= 0 && out.length < limit; i--) {
    const r = api[i]!;
    if (q.beforeId && r.id >= q.beforeId) continue;
    if (q.toolCallId && r.toolCallId !== q.toolCallId) continue;
    if (tool && !(r.tool ?? r.job ?? '').toLowerCase().includes(tool) && !r.path.toLowerCase().includes(tool)) continue;
    if (q.errorsOnly && !(r.status === 0 || (r.status != null && r.status >= 400))) continue;
    out.push({ ...r });
  }
  return out;
}

export interface CallerSummary { caller: string; source: string; ip: string | null; userAgent: string | null; calls: number; errors: number; apiCalls: number; lastAt: string; lastTool: string }

/** Who has been calling in the last `minutes`, grouped by declared source + origin. */
export function callerSummary(minutes = 60): { callers: CallerSummary[]; background: Array<{ job: string; apiCalls: number; errors: number; lastAt: string }>; since: string; oldest: string | null } {
  const since = Date.now() - minutes * 60_000;
  const m = new Map<string, CallerSummary>();
  for (const r of tools) {
    if (Date.parse(r.at) < since) continue;
    const source = r.source ?? 'unknown';
    const key = `${source}|${r.ip ?? ''}|${r.userAgent ?? ''}`;
    const c = m.get(key) ?? { caller: key, source, ip: r.ip, userAgent: r.userAgent, calls: 0, errors: 0, apiCalls: 0, lastAt: r.at, lastTool: r.tool };
    c.calls++; c.apiCalls += r.apiCalls; if (isErr(r.outcome)) c.errors++;
    if (r.at >= c.lastAt) { c.lastAt = r.at; c.lastTool = r.tool; }
    m.set(key, c);
  }
  const bg = new Map<string, { job: string; apiCalls: number; errors: number; lastAt: string }>();
  for (const r of api) {
    if (r.toolCallId || Date.parse(r.at) < since) continue;
    const job = r.job ?? 'other background';
    const b = bg.get(job) ?? { job, apiCalls: 0, errors: 0, lastAt: r.at };
    b.apiCalls++; if (r.status === 0 || (r.status ?? 0) >= 400) b.errors++; if (r.at > b.lastAt) b.lastAt = r.at;
    bg.set(job, b);
  }
  return {
    callers: [...m.values()].sort((a, b) => b.calls - a.calls),
    background: [...bg.values()].sort((a, b) => b.apiCalls - a.apiCalls),
    since: new Date(since).toISOString(),
    oldest: tools[0]?.at ?? null,
  };
}

/** Tests only. */
export function _resetCallLog(): void { tools.length = 0; api.length = 0; nextTool = 1; nextApi = 1; }
