// Transport-derived request origin (issue: caller-container attribution).
//
// The `source` on CallerContext (chatgpt / hermes-teams / n8n / …) is what the
// CLIENT declares in `_meta` — useful, but spoofable and absent on plain calls.
// When several consumers (ChatGPT via the Cloudflare tunnel, n8n on the compose
// network, the cron scheduler on the host) share ONE MCP instance, the reliable
// "which container connected" signal is the transport itself: the peer address,
// the X-Forwarded-For chain a tunnel/proxy adds, and the User-Agent.
//
// This is captured server-side at the HTTP entry (never from client payload),
// carried per-request via AsyncLocalStorage, and written to the audit trail
// alongside the declared source — so an operator can see both what the caller
// SAID it was and where it actually came from. Purely observational; it does
// not by itself grant or deny anything.

import type { IncomingMessage } from 'node:http';

export interface RequestOrigin {
  /** Immediate peer address (socket). On the compose network this is the
   *  container's internal IP; behind a tunnel it's the tunnel's address. */
  remoteAddr?: string;
  /** First hop of X-Forwarded-For, if a proxy/tunnel set it (the real client). */
  forwardedFor?: string;
  /** Client User-Agent, if sent — often identifies the consumer (n8n, curl, …). */
  userAgent?: string;
}

function firstHeader(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Build a RequestOrigin from a Node HTTP request, or undefined when no signal
 * is available (e.g. stdio). Only the first X-Forwarded-For hop is kept — the
 * rest is proxy chain — and it is never trusted for authorization, only logged.
 */
export function extractRequestOrigin(req: IncomingMessage): RequestOrigin | undefined {
  const origin: RequestOrigin = {};

  const remote = req.socket?.remoteAddress;
  if (remote) origin.remoteAddr = remote;

  const xff = firstHeader(req.headers['x-forwarded-for']);
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) origin.forwardedFor = first;
  }

  const ua = firstHeader(req.headers['user-agent']);
  if (ua && ua.trim() !== '') origin.userAgent = ua.trim();

  return origin.remoteAddr || origin.forwardedFor || origin.userAgent ? origin : undefined;
}
