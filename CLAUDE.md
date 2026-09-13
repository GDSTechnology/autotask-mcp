# autotask-mcp

Task management: Task Master (`task-master` CLI; config in `.taskmaster/`).
Workflow defaults (commits, changelog, memory) come from the global `~/.claude/CLAUDE.md`.

## Learnings
<!-- Record non-obvious discoveries as dated entries: "## Learnings - YYYY-MM-DD" -->

## Learnings - 2026-09-11

- The `AutotaskHttpClient` read path now FAILS CLOSED (`AutotaskResponseError`, retryable): a 2xx whose body is empty / aborted mid-read / not valid JSON (truncation) throws instead of collapsing to `null`/`[]`. Void writes opt into an empty 2xx via `allowEmptyBody`. Don't reintroduce "return undefined on parse failure" — it masquerades as not-found/zero-records.
- Autotask returns **HTTP 200 `{item:null}`** for a missing-by-id GET on several entities (not a 404). `get()`/`childGet()` route through `unwrapEntity()` which maps that to `null`; the old `res?.item ?? res` returned the truthy wrapper.
- Read-after-write: a freshly-created entity can briefly 404 (replication lag). `getWithRetry()` retries a genuine null but never a payload anomaly. Create tools flagged `verifyRead` in `CREATE_TOOL_META` (project/task/phase) attach `verified`+`item`; the create's itemId stays authoritative, so verification never fails a successful create (avoids duplicate-on-rerun).
- `TaskPredecessor` live schema (verified via entityInformation): only 4 fields — `id`, `lagDays`, `predecessorTaskID`, `successorTaskID`. The two task refs are **readonly**, so `update_task_predecessor` can only change `lagDays`; re-point = delete + recreate. Partial surface (`list`/`add`/`remove_task_predecessor`) already shipped in #46 — `get`/`search`/`update` were the real gaps (another stale-doc / #237 pattern).

## Learnings - 2026-08-10

- Issue asks can be stale: #237 claimed "no Contracts tools" but search/create/update already existed (added after the issue was filed). Always scope against `src/handlers/tool.definitions.ts` before implementing "missing" tools.
- `TOOL_CATEGORIES` in `tool.definitions.ts` is hand-maintained and drifts from `TOOL_DEFINITIONS` — nothing enforces parity (the contract write tools were absent from `financial` for months). A parity test would prevent this class of drift.
- The intent router's entity regexes (`tool.handler.ts` `routeIntent`) matched only singular nouns (`\bcontract\b` missed "contracts") until #238 added `s?`; check the other entity branches if router misses are reported.
- `exactOptionalPropertyTypes` is on: optional result-object fields need explicit `| undefined` in their type when assigned from possibly-undefined sources.
