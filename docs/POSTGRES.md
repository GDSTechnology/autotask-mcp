# Optional PostgreSQL layer — dev setup & operations

Phase 2 of the Expansion & Deployment spec (§17, issue #18). PostgreSQL is an
**optional** cache / correlation / history / work-buffer layer. Autotask stays
authoritative; every operational mutation still commits to Autotask. The whole
layer is **disabled by default** (`MCP_PG_ENABLED=false`) and every capability is
behind its own flag, so the server runs exactly as before with no database.

## Isolation (non-negotiable)

- Dedicated database **`gds_autotask_mcp`**, schema **`autotask_mcp`**.
- Three roles: **owner** (owns objects, NOLOGIN), **migrator** (LOGIN, runs DDL),
  **app** (LOGIN, DML only — the MCP's runtime identity, never DDL).
- **Never** reuse the n8n / Hermes / control-plane databases, schemas, or roles,
  and never point this at those. The prod target is its own VPS DB.

## Local test database (dev machine)

A standalone, opt-in Postgres in `dev-postgres/` — separate from the app compose so
it can never ship to production. Host port **5433** (avoids clashing with any other
local Postgres); the role model matches prod.

Bring it up:

```bash
docker compose -f dev-postgres/docker-compose.yml up -d
```

Verify roles, schema, and app-role connectivity:

```bash
docker exec gds-autotask-mcp-devpg psql -U gds_autotask_mcp_app -d gds_autotask_mcp -c "select current_user, current_schema; \du"
```

Tear down and wipe (also required before re-running the init script):

```bash
docker compose -f dev-postgres/docker-compose.yml down -v
```

Dev-only credentials (defaults in `dev-postgres/docker-compose.yml`, override via
its own env): superuser `postgres` / `devsuperpass`, migrator
`gds_autotask_mcp_migrator` / `devmigrate`, app `gds_autotask_mcp_app` / `devapp`.
These are throwaway local values — **never** used in production.

## Staged local database — no Docker required (Windows dev)

When Docker isn't available, `dev-postgres/local-db.ps1` runs a **portable Postgres**
staged under a gitignored runtime dir (`dev-postgres/.runtime/`), so the binaries
download **once** and the cluster persists between sessions — spin up/down on demand
without wasting cycles.

```powershell
./dev-postgres/local-db.ps1 provision   # one-time: download, initdb, roles/schema, migrate
./dev-postgres/local-db.ps1 up          # start (fast; provisions if needed)
./dev-postgres/local-db.ps1 status      # running? + audit_log row count
./dev-postgres/local-db.ps1 migrate     # build + run migrations
./dev-postgres/local-db.ps1 psql -- -c "select * from autotask_mcp.audit_log"
./dev-postgres/local-db.ps1 down        # stop, keep everything staged
./dev-postgres/local-db.ps1 reset       # drop + recreate the DB, re-migrate
./dev-postgres/local-db.ps1 purge       # delete the runtime dir (forces re-download)
```

Same DB/schema/role model as prod (owner/migrator/app, app = DML only). Dev-only
credentials are baked into the script and never used in production.

## Connecting the MCP

Copy the PG block from `.env.dev-pg.example` into the MCP's `.env` and set
`MCP_PG_ENABLED=true` plus whichever capability flags you're testing. For the local
test DB:

```
MCP_PG_ENABLED=true
MCP_PG_HOST=localhost
MCP_PG_PORT=5433
MCP_PG_DATABASE=gds_autotask_mcp
MCP_PG_SCHEMA=autotask_mcp
MCP_PG_USER=gds_autotask_mcp_app
MCP_PG_PASSWORD=devapp
MCP_PG_SSL=false
```

Production points the same vars at the VPS with `MCP_PG_SSL=require` and real
secrets. Migrations run as the **migrator** role (`MCP_PG_MIGRATOR_USER` /
`MCP_PG_MIGRATOR_PASSWORD`), separate from the runtime app role.

## Degraded modes (spec §24)

PG disabled → live Autotask only. PG outage → safe live ops continue, cached/job
features degrade. Schema behind the code → newer-schema features disable
themselves. The server must never hard-fail because Postgres is unavailable.

## Shadow — read-only Autotask mirror (`MCP_PG_SHADOW_ENABLED`)

Heavy reads (thousands of tickets / time entries, contract and labor sweeps,
reports) cost Autotask API calls, and every integration on the tenant shares one
**10,000 requests/hour** budget per database, with Autotask adding **0.5 s** of
latency per call past 50% and **1 s** past 75%, plus a **3 concurrent threads per
endpoint** limit. The shadow keeps a read-only copy of the busiest entities in
Postgres so those reads cost **0** Autotask calls. Autotask stays authoritative:
every write still goes to Autotask.

**Mirrored:** Tickets, TimeEntries, Companies, Contacts, Contracts (incremental, by
their last-modified field), ContractServices, ContractBlocks, Resources (small;
refreshed in full hourly). One table, `shadow_record (entity, id, data jsonb, …)`,
plus `shadow_sync_state` (migration `0002_shadow.sql`).

**How it stays fresh**
- **Backfill** — first load walks `id > cursor` in 500-row pages (Autotask returns
  ≤ 500 rows sorted by id), resumable across runs. About 750 calls for the whole
  tenant, spread over several runs.
- **Incremental** — every `MCP_PG_SHADOW_INTERVAL_SECONDS` (300): rows modified or
  created since the watermark (minus 2 min overlap). Typically a handful of calls.
- **Own writes** — rows the MCP writes are re-read at the start of the next run.
- **Deletions** — a nightly id-only sweep (`MCP_PG_SHADOW_RECONCILE_HOUR_UTC`).
- **Budget** — at most `MCP_PG_SHADOW_MAX_CALLS_PER_RUN` (100) calls per run; a
  run is **skipped** when tenant usage ≥ `MCP_PG_SHADOW_PAUSE_AT_PCT` (50 — below
  Autotask's latency zone). Calls are strictly sequential (1 of the 3 threads).
- **One instance** — a Postgres advisory lock means only one MCP syncs.

**Using it**
- `autotask_shadow_query` / `autotask_shadow_aggregate` — SQL over the mirror with
  the same filter format as the Autotask API; every answer reports data age.
- `MCP_PG_SHADOW_SERVE_READS=true` — the regular `search_*` tools (tickets, time
  entries, companies, contacts, resources, …) are answered from the shadow while
  the entity is backfilled and younger than `MCP_PG_SHADOW_MAX_AGE_SECONDS` (900);
  otherwise, or for any filter the shadow can't translate, they go live.
  Verified: same ids, order and `hasMore` as the live API.
- `autotask_shadow_status` — rows, backfill progress, age, calls spent, errors.
- `autotask_shadow_sync` — run now / re-read ids / reconcile one entity.
- `/health` shows `shadow.lastRunAt` / `lastRunCalls` (no DB round-trip).
