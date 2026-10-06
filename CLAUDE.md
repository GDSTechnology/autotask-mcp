# autotask-mcp

Task management: Task Master (`task-master` CLI; config in `.taskmaster/`).
Workflow defaults (commits, changelog, memory) come from the global `~/.claude/CLAUDE.md`.

## Learnings
## Learnings - 2026-10-06

- **Autotask API limits** (official docs): **10,000 requests/hour per DATABASE**
  across all integrations; usage-based latency +0.5 s/call at 50–75%, +1 s past
  75%; **3 concurrent threads per integration per object endpoint** (4th → 429);
  queries return ≤ 500 rows **sorted by id** — loop on `id > max seen`.
- The "gds-n8n" integration in Autotask's API report IS this MCP (n8n and cron
  call Autotask through it) — ~88% of tenant calls, ~2,300/h around the clock.
- Postgres shadow (`src/db/shadow-*`, migration 0002): entity watermark fields
  verified live — Tickets `lastTrackedModificationDateTime`, TimeEntries
  `lastModifiedDateTime`, Companies `lastTrackedModifiedDateTime`, Contacts
  `lastModifiedDate`, Contracts `lastModifiedDateTime`; ContractServices /
  ContractBlocks / Resources have none (full refresh). Whole-tenant backfill ≈
  750 calls. Bulk walks pass `noCache` so pages don't sit in the HTTP cache.
- `searchContracts` uses `http.query` directly, not `queryPaged`, so it is NOT
  served from the shadow — route it through `queryPaged` to get that.

## Learnings - 2026-10-05

- **Email-created tickets keep the original message**: the email processor
  attaches it as a `message/rfc822` TicketAttachment titled "Originating
  Email" — real From / Reply-To / To / Subject / Authentication-Results.
  `utils/rfc822.ts` parses it. Which mailbox / processor rule made the ticket
  is NOT exposed by the API.
- **`GET /TicketAttachments/{id}` answers in the QUERY shape**
  `{ items: [record], pageDetails }`, not `{ item }`. `unwrapEntity` handled
  only `{ item }`, so `get_ticket_attachment` includeData returned the wrapper
  and silently skipped its parent-scope check and size cap. Fixed in
  `unwrapEntity`; check new by-id GETs for this shape.
- **TicketHistory** rows are `{action, date, detail, resourceID}`; `detail` is
  "X changed from A to B" (values may contain " to " — anchor on picklist
  labels). Actor 4 = system (workflow/triage rules); the MCP's API user shows
  up as itself. ~40% of rows are timestamp-only noise.
- Ticket UDF definitions (with list values) come from
  `Tickets/entityInformation/userDefinedFields` (`http.udfInfo`).

## Learnings - 2026-10-02

- **`ServiceCalls` has no resource field.** "My service calls on a day" is
  calls-in-window → `ServiceCallTickets` (`in` serviceCallID) →
  `ServiceCallTicketResources` (`in` serviceCallTicketID + resourceID). Scope
  the calls by date FIRST; a resource's assignment history is unbounded.
- **Open `CompanyToDos` pile up**: a live tech had 500+ never-completed To-Dos,
  all 1–12 months old, nearly all ticket-linked. "Open and due" is noise —
  window by `startDateTime` (my_day uses 7 days).
- A ticket can sit on **two service calls the same day**; a per-call gap list
  double-counts it. Gaps are per ticket.
- Status / note picklists resolve by **label** (`utils/staff-tools.ts`
  `matchPicklist`): exact label wins over a partial ("Waiting Customer" vs
  "Waiting Customer stage 2"); an ambiguous partial ("waiting") returns the
  choices. TicketNotes publish: 1 All Autotask Users (client-visible),
  2 Internal Project Team, 4 Internal & Co-Managed.

## Learnings - 2026-09-30

- **`TimeEntries.hoursToBill` is read-only** (entityInformation `isReadOnly`).
  Autotask derives it from `hoursWorked − offsetHours` plus contract/work-type
  rounding and silently ignores a supplied value — an update "succeeds" and
  changes nothing. `offsetHours` is the only API lever (#139).
- **`ResourceRoles` is query-only** (no create/update/delete) and has an
  `isActive` column. Roles 110/112 on many resources are hidden system roles:
  the `Roles` entity doesn't return them. Resolve role names with an exact
  `in` lookup of the resource's roleIDs, not one capped Roles page (#141).
- **Resource 4 is "Autotask Administrator"**, the built-in system account. It
  writes workflow-rule notes AND "Notification sent via Workflow Rule" notes
  as `noteType` 1 (the human type), so note type alone can't spot system notes.
  `noteType` 2 ("Task Detail") is almost all automation (#143/#144).
- Techs record their work in **time-entry summaries**, not ticket notes — a
  ticket can have 17 notes and none human. Anything summarising "what was
  done" must read TimeEntries (#144).
- **Notifications can't be sent through the API**: `NotificationHistory` is
  query-only and no create call triggers the UI's "notify" emails. But
  **workflow rules DO fire on API edits** (verified: API closes of client
  tickets in business hours fired "Ticket Closed - Billing Cross Check"), so
  close notifications belong in an Autotask workflow rule, not in code.
- The timesheet lock on a time-entry **create** is only knowable from the
  error (no timesheet entity); `utils/time-entry-errors.ts` maps it. Its exact
  create-time wording is still unconfirmed — extend the classifier from the
  first real case.
- GitHub occasionally **drops the push event of a merge** (no CI, no Release).
  `release.yml` has `workflow_dispatch` for that; semantic-release refuses to
  publish from a commit behind `main`, so a later merge releases everything
  since the last tag (#142).
- Ticket deep link: `<webUrl>Autotask/AutotaskExtend/ExecuteCommand.aspx?Code=OpenTicketDetail&TicketID=<id>`;
  `webUrl` comes from zoneInformation (cached with the API url).

## Learnings - 2026-09-16

- Search-tool params drift from their schemas in two directions, and **nothing
  caught either**: (a) `page` was advertised by 9 tools and honored by 2 —
  the rest read `pageSize` into `maxRecords` and dropped `page`, so page 2 returned
  page 1; (b) `search_service_calls` advertised `startAfter`/`startBefore`/`companyId`
  while the service read `startDate`/`endDate`, so every filter fell through to the
  MATCH_ALL sentinel and a 2026 query returned 2007 records. When adding a search
  tool, assert on the **filter payload sent upstream**, not on the returned rows —
  a dropped filter looks like a successful broad search.
- Autotask has **no offset parameter**; `page` is emulated by fetching `page*pageSize`
  and slicing (`AutotaskService.paginate`/`queryPaged`). Cost is O(page), so deep
  paging is expensive by construction — scope by date range first.
- `hasMore` must come from over-fetching one record past the window. The old
  `items.length >= pageSize` heuristic reported every exactly-full final page as
  "there is more".
- `childQuery` does NOT walk `nextPageUrl` — child reads (e.g. project Phases) are
  capped at one 500-record page, so paging over a child collection has a ceiling.
- `return somePromise` inside `try/catch` does not catch the rejection. The search
  methods need `return await` to keep their `catch` logging.
- `TOOL_CATEGORIES` drift is now enforced by `tests/phase2-tool-catalog-parity.test.ts`
  (registered == category union minus a meta-tool allowlist). It had silently hidden
  8 business tools from discovery, `update_contact` among them.
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
