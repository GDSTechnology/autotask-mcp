# GDS Autotask MCP — Fork Changelog

This file records the GDS-specific divergence of this fork from upstream
(`WYRE-AI/autotask-mcp`). It is maintained by hand (the automated `CHANGELOG.md`
is managed by semantic-release) so the "what shipped and why" survives
independently of GitHub PR pages — e.g. after leaving the fork network.

Each entry lists the merge commit and the PR number. Brief section references
(§x.y) point at the GDS Autotask MCP Fork Implementation Brief.

---

## Unreleased — Phase 2 P0 repair & foundation

Addresses the P0 "Repair & Foundation" block of the Phase 2 Development &
Testing punch list (2026-09-16). Two defects were reported; both turned out to
be instances of a wider class, and the audit is what this entry mostly records.

### Pagination — MCP-DEF-001 / MCP-CORE-001
- **`page` was accepted and discarded by 7 of the 9 search tools that advertised it.**
  Only `searchCompanies` and `searchTasks` honored it; every other search read
  `pageSize` into `maxRecords` and ignored `page`, so page 2 re-issued the same
  first-N query and returned page 1's records while reporting itself as page 2.
  Reported against `autotask_search_time_entries`; also affected tickets,
  contacts, projects, resources, billing items and approval levels. `page` is now
  also exposed on `search_service_calls` and `list_phases`, whose services gained
  paging here.
- Added `AutotaskService.paginate()` / `queryPaged()` — one implementation of the
  fetch-and-slice pattern Autotask's cursor-only API forces (no offset parameter),
  replacing the copy that existed in two methods and was missing from eight.
- Search methods now return `PagedResult<T>` (`items`, `page`, `pageSize`,
  `hasMore`) instead of a bare array, and the handler carries that metadata into
  the compact response. **`hasMore` is now honest:** it comes from over-fetching a
  single record past the window, not from `items.length >= pageSize`, which
  reported every exactly-full final page as "there is more".

### Service call date filtering — MCP-DEF-002 / MCP-CORE-002
- `autotask_search_service_calls` advertised `startAfter`/`startBefore`/`companyId`
  while the service only read `startDate`/`endDate`. Every filter was dropped and
  the query fell through to the MATCH_ALL sentinel — a request scoped to 2026
  returned service calls from 2007. Both bounds now constrain `startDateTime`
  (the old upper bound filtered `endDateTime`, dropping any call that started
  inside the window but ran past it); `startDate`/`endDate` remain as aliases.
- `searchResources` likewise dropped the advertised `isActive` and `resourceType`.

### Tool catalog parity — MCP-CORE-003
- 8 registered business tools were unreachable through category discovery:
  `update_contact`, `find_or_create_contact`, `update_project`,
  `get_invoice_details` and the four `ticket_checklist_item` tools. All are now
  categorized; the 5 remaining uncategorized tools are meta-tools (discovery,
  router, raw escape hatch) and are allowlisted as deliberate.

### Tests
- `tests/phase2-pagination-contract.test.ts` — table-driven across all 10
  paginated searches: page advances, no duplicate ids across pages, the walk
  terminates, `pageSize` is respected, a full final page reports `hasMore: false`,
  and a page past the end is empty rather than a repeat of page 1. Plus an
  end-to-end check that the metadata survives into the tool response.
- `tests/phase2-date-filter-contract.test.ts` — asserts on the filter payload sent
  upstream, so a rename on either side of the schema/service boundary fails here
  instead of silently returning the whole table.
- `tests/phase2-tool-catalog-parity.test.ts` — registered tools == category union
  (minus the meta-tool allowlist), no phantom or duplicated entries. Closes the
  drift class that had gone unenforced for months.

---

## 2.19.0-gds — 2026-08-26 — First GDS production release

Cut over live on **the production host** (docker-compose, local build from this fork,
`/health` → `2.19.0-gds`), replacing the upstream `ghcr.io/wyre-technology/autotask-mcp`
pinned image. All items below verified against the code with mocked-HTTP unit
tests (316 passing at release).

### Route & payload correctness (Phase 1)
- **#2 (`fd69545`) — child-route creates + ticket role (§4.2–4.4).**
  `createContact` → `POST /Companies/{companyID}/Contacts` (companyID required);
  `createServiceCallTicket` → `POST /ServiceCalls/{id}/Tickets`;
  `createServiceCallTicketResource` → `POST /ServiceCallTickets/{id}/Resources`;
  restored `assignedResourceRoleID` to the ticket writable-field allowlist so
  typed assignment updates keep the role Autotask requires.

### HTTP layer
- **#3 (`bf78601`) — batched `in` query helper (§7.19).** `AutotaskHttpClient.queryByIds()`:
  dedupe + sort IDs → 200-per-chunk `in` queries under bounded concurrency →
  paginate each chunk → dedupe by id → surface per-chunk failures. (Cursor
  pagination §7.18 and 429/threshold handling §7.2 already existed in `query()`/`request()`.)

### Safety & resolution
- **#4 (`ad108a8`) — canonical reference resolver + protected-company guards (§7.30–7.31).**
  Read-only `autotask_resolve_record_reference` resolves a `T…` number to a
  single Ticket **or** Task (queries both, never infers from the prefix;
  matched/ambiguous/not-found). `utils/company-guard.ts`: `updateCompany` refuses
  to rename/reclassify/deactivate protected accounts (company `0` +
  `AUTOTASK_PROTECTED_COMPANY_IDS`); `createCompany` rejects non-company names
  (webmail/greeting/CTA/sentence).

### Response normalization
- **#5 (`3eabb99`) — one create-result contract (§5/§7.1).** Every create tool
  returns `{ id, entityType, parentType?, parentId? }` as `data`, normalized once
  centrally in `callTool` via `utils/create-result.ts` + `CREATE_TOOL_META`. (BREAKING:
  create `data` was a bare number → now `data.id`.)
- `c5cddf9` — follow-up: register `autotask_create_company_todo` in `CREATE_TOOL_META`.

### Calendar / executive-assistant objects (Phase 2)
- **#6 (`57618c4`) — CompanyToDos + router intent (§4.1/§4.10).** Six typed tools
  (get/search/create/update/complete/delete) via company child routes; actionType
  resolved from live picklist metadata (default "General"); `completedDate`
  completion; open-only search. Router matches a To-Do/follow-up intent before
  time-tracking so "sales follow-up To-Do" no longer misroutes to a time entry.

### Validation & tenant-aware resolution
- **#8 (`f65543e`) — owner / note limit / name search / opportunity update (§6.1–6.3, §4.7).**
  `createCompany` resolves `ownerResourceID` (supplied or
  `AUTOTASK_DEFAULT_OWNER_RESOURCE_ID`) and fails fast otherwise; contact `note`
  validated to 50 chars (opt-in `truncateNote`); contact search builds a combined
  firstName+lastName group + exact-email match; added `updateOpportunity` +
  `autotask_update_opportunity` via collection `PATCH /Opportunities`.

### Ticket & time completeness (Phase 3)
- **#9 (`355c50c`) — ticket-create fields, move-ticket, time-entry CRUD (§4.5/4.6/4.8).**
  Added `dueDateTime`/`companyLocationID`/`configurationItemID` to ticket create/update;
  `autotask_move_ticket_to_company` (resolves the target company's primary
  `CompanyLocations`, sets companyID+companyLocationID together, clears the
  contact unless supplied, refuses to move a CI-linked ticket unless forced,
  reads back); `autotask_get_time_entry` + `autotask_update_time_entry` (fractional
  hours, `hoursWorked` vs `hoursToBill`, `showOnInvoice`/`billingCodeID`).

### Build, dependency & release (Phase 5)
- **#7 (`7cdd90f`) — dependency source (deps).** Repointed dev-only `autotask-node`
  from the private `@wyre-technology` GitHub Packages alias to the public
  `github:GDSTechnology/autotask-node` fork (pinned), so `npm ci` needs no
  registry token.
- **#10 (`d088931`) — token-free Docker + release tooling (Phase 5).** Dockerfile
  drops the private-registry `.npmrc`/`GITHUB_TOKEN`; `scripts/build-image.sh`
  builds a traceable image (VERSION/COMMIT_SHA/BUILD_DATE → `/health`);
  `DEPLOY.md` deploy + rollback runbook for the production host.

### Housekeeping
- `fa5918f` — removed a stray `file:../autotask-node` link + lockfile churn that
  the initial Phase-1 PR (#1, `e476e5b`/`701c7df`) had bundled onto `main`.

---

### Notes
- **autotask-node** is a public GDS fork (`github:GDSTechnology/autotask-node`),
  dev-only — the runtime is a native-`fetch` client; the SDK is pruned from the
  production image.
- **Independent project:** this is a standalone GDS Technology project, originally
  derived from `WYRE-AI/autotask-mcp` (Apache-2.0) and now developed separately.
  The GitHub fork relationship and the `upstream` tracking remote have been
  removed; the codebases have diverged and are no longer reconciled.
