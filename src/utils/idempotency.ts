// Idempotency for mutating tools (Expansion Spec §4.4, issue #14).
//
// A repeated *logical* action (a client retry, a double-submit) should not create
// a second Autotask record. We key each mutation and replay the prior result on a
// repeat instead of mutating again.
//
// A key is formed from a caller-supplied `idempotencyKey`, or derived from
// source + actor + conversation + tool + normalized payload when the caller
// carries a conversation context. With neither (e.g. a context-free CLI call)
// there is no key and no dedup — two identical deliberate calls both run, which is
// the correct default when we can't tell a retry from a genuine repeat.
//
// In-memory store first; the PG-backed `jobs_*` store lands in Phase 2 behind
// MCP_PG_JOBS_ENABLED, reusing this interface.

import { createHash } from 'crypto';
import { CallerContext } from '../types/context';

/** Minimal shape of a cached tool result; structurally compatible with the handler's McpToolResult. */
export interface CachedToolResult {
  content: Array<{ type: string; text: string; [k: string]: unknown }>;
  isError?: boolean;
  [k: string]: unknown;
}

// Read tools must never be deduped — a repeated read in the same conversation has
// to see current data, not a replay. Annotations (readOnlyHint) are an incomplete
// signal across the catalog, so idempotency keys off the tool name directly.
const READ_TOOL_PREFIXES = [
  'autotask_get_',
  'autotask_search_',
  'autotask_list_',
  'autotask_find_',
  'autotask_query_',
  'autotask_count_',
];
const NON_MUTATING_TOOLS = new Set<string>([
  'autotask_router',
  'autotask_whoami',
  'autotask_test_connection',
  'autotask_execute_tool', // passthrough — the inner tool is guarded on its own dispatch
]);

/** True when a tool mutates Autotask state and is therefore eligible for idempotency. */
export function isMutatingTool(name: string): boolean {
  if (NON_MUTATING_TOOLS.has(name)) return false;
  if (READ_TOOL_PREFIXES.some((p) => name.startsWith(p))) return false;
  return true;
}

/** Deterministic JSON: object keys sorted recursively so payload order can't change the key. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * Derive the idempotency key for this call, or `undefined` when the action can't
 * be safely deduped. A caller-supplied key always wins; otherwise a conversation
 * context is required.
 */
export function deriveIdempotencyKey(
  ctx: CallerContext,
  tool: string,
  args: Record<string, unknown>
): string | undefined {
  if (ctx.idempotencyKey) return `k:${ctx.idempotencyKey}`;
  if (!ctx.conversationId) return undefined;
  const actor = ctx.autotaskResourceId ?? ctx.requestingUserEmail ?? 'anon';
  const digest = createHash('sha256').update(stableStringify(args)).digest('hex').slice(0, 32);
  return `d:${ctx.source}|${actor}|${ctx.conversationId}|${tool}|${digest}`;
}

interface IdempotencyRecord<T> {
  result: T;
  at: number;
}

/** Bounded, TTL'd in-memory idempotency store (FIFO eviction). */
export class InMemoryIdempotencyStore<T = CachedToolResult> {
  private map = new Map<string, IdempotencyRecord<T>>();

  constructor(
    private readonly maxEntries = 1000,
    private readonly ttlMs = 24 * 60 * 60 * 1000
  ) {}

  get(key: string): T | undefined {
    const rec = this.map.get(key);
    if (!rec) return undefined;
    if (Date.now() - rec.at > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return rec.result;
  }

  set(key: string, result: T): void {
    if (!this.map.has(key) && this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value; // insertion order
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { result, at: Date.now() });
  }

  get size(): number {
    return this.map.size;
  }
}
