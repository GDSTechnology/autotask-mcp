// Per-request context carried across async calls (#42 native impersonation).
//
// Autotask supports acting "on behalf of" a standard user via the
// `ImpersonationResourceId` header on the outbound REST call — the integration
// (API) user tunnels the write so Autotask attributes it to that resource
// (createdByResourceID / last-modified-by / audit), even though standard users
// have no API access.
//
// The acting resource id is resolved once per tool call (from the caller's
// identity) and must reach AutotaskHttpClient.headers() without threading it
// through every method signature — and without leaking between concurrent
// requests that share one client (env mode). AsyncLocalStorage gives us exactly
// that: a store scoped to the async execution of one tool dispatch.

import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  /** Autotask resource id to impersonate on outbound writes, if any. */
  impersonationResourceId?: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with the given per-request context in scope. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/** The impersonation resource id for the current async context, if set. */
export function getImpersonationResourceId(): number | undefined {
  return storage.getStore()?.impersonationResourceId;
}

/**
 * Whether native Autotask impersonation is enabled for this deployment.
 * Off by default — the API user's security level must permit impersonation, so
 * it stays inert until an operator opts in via AUTOTASK_IMPERSONATION.
 */
export function isImpersonationEnabled(): boolean {
  const v = (process.env.AUTOTASK_IMPERSONATION || '').trim().toLowerCase();
  return v === 'on' || v === 'true' || v === '1' || v === 'yes';
}
