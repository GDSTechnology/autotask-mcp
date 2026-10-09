# Throttling, backoff and backpressure

What the MCP does on its own to protect the Autotask tenant, and how a
dispatcher (n8n, Hermes, cron) should react. Gap register **MCP-008**.

Autotask's limits, per the official docs:
- **10,000 requests per hour per database**, shared by every integration.
- **Added latency** per call: 0.5 s at 50–75% of the hourly limit, 1 s above 75%.
- **3 concurrent requests per integration per object endpoint.** The 4th gets a 429.

## What the MCP does

| Situation | MCP behaviour | Retries? |
|---|---|---|
| **401** (login rejected) | Login protection: the first 401 pauses **all** calls for the tenant (`AUTOTASK_AUTH_PAUSE_SECONDS`, default 300 s, doubling up to 1 h). The zone is re-looked-up, and the request is retried once only if the zone changed. At most `AUTOTASK_AUTH_MAX_PROBES` (2) single test calls follow; if those fail, the tenant is **held** until an administrator presses **Retry now** in the console. The pause is saved in Postgres, so restarts and deploys keep it. | Never automatic beyond the probes |
| **429** (threshold) | A cooldown starts for the `Retry-After` time (default 60 s, capped at 5 min). Every call for that tenant fails **locally**, with no upstream request, until it passes. The error says "Do NOT retry". | No |
| **Concurrency** | Each endpoint has a gate, `AUTOTASK_MAX_CONCURRENT_PER_ENDPOINT` (default 2, max 3). Extra calls **queue**; they do not fail. Cached and coalesced reads take no slot. | n/a |
| **Truncated / empty 2xx body** | Fails closed with a retryable `AutotaskResponseError`. It is never treated as "no records". | Caller decides |
| **Shadow sync** | Skips a run when tenant usage is at or above `MCP_PG_SHADOW_PAUSE_AT_PCT` (default 50%). Each run is capped at `MCP_PG_SHADOW_MAX_CALLS_PER_RUN`. | Next run |
| **Bulk tools** | The activity feed, history backfill and audit tools take `maxApiCalls` and report anything they cut off as pending. The backfill also pauses at `pauseAtUsagePct`. | Caller continues |

There is **no per-client call budget**. Budgets are per call (`maxApiCalls`)
and per sync run. Use the console's **Calls** page to see which caller sends
what.

## What a dispatcher should do

Check backpressure before a batch, and after any error, using one of:
- `GET /health` → `backpressure: { level, reasons, retryAfterSeconds, usedPct }`, with no MCP auth and no Autotask call;
- the tool `autotask_get_backpressure`, which gives the full detail. `refresh: true` takes a fresh usage reading, which costs 1 call.

| level | Meaning | Do |
|---|---|---|
| `ok` | No pressure | Proceed normally |
| `slow` | Usage ≥ 50% (Autotask is adding latency), a login re-test is in progress, or requests are queuing | Essential calls only, one at a time. Postpone backfills, bulk syncs and reports. |
| `stop` | Login paused or held, a 429 cooldown, or usage ≥ 90% | Send nothing. Queue the work and retry after `retryAfterSeconds`. If the login is **held** (`retryAfterSeconds: null`), wait for an administrator. |

**Errors returned by tools:**
- `error_type: rate_limited` carries `retry_after_seconds`. Wait that long and don't retry before.
- A 401 / login-paused error means stop. Don't loop: every retry while paused fails locally anyway.
- For writes, send `_meta.idempotencyKey` (see [POSTGRES.md](POSTGRES.md#operation-log--correlation--durable-idempotency-autotask_get_operations)). A retry after an unclear failure then replays, or is refused, instead of writing twice.
