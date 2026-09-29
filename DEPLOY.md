# GDS Autotask MCP — Deploy & Rollback Runbook

Production target: **the production host** (the existing GDS environment — do not
introduce a second VPS). This runbook covers deploying the published image and
rolling it back. It follows the traceability rules in the implementation brief
§7.34: the deployed version is proven from the running container's `/health`,
never inferred from a repo/tag alone.

## Current production layout (verified 2026-09-29)

| What | Value |
|---|---|
| Host | the production host |
| Compose project | `n8n`, file `/opt/n8n/docker-compose.yml` |
| Service / container | `autotask-mcp` / `n8n-autotask-mcp-1` |
| Port | `127.0.0.1:18080 -> 8080` |
| Image | `ghcr.io/gdstechnology/autotask-mcp:latest` |
| Sibling containers | `gds-openai-autotask-tunnel` (`ghcr.io/openai/tunnel-client:v0.0.11`), `n8n-autotask-cron-scheduler-1` |

Prod runs a **single** MCP instance that serves every consumer (ChatGPT via the
tunnel, n8n, cron). There is **no** `autotask-mcp-gpt` / `:18081` instance.
[`deploy/docker-compose.prod.yml`](deploy/docker-compose.prod.yml) describes a
two-instance split as the reference **target** design, not what is running.

## 0. Traceability principle

Every release records **three** facts, baked into the image at build time and
reported by `/health`:

- `VERSION` — the release version
- `COMMIT_SHA` — the exact source commit
- `BUILD_DATE` — UTC build timestamp

The dependency `autotask-node` is the **public** `github:GDSTechnology/autotask-node`
fork, so the image builds with **no registry token**.

## 1. Prerequisites

- A shell on the production host with Docker + the compose plugin, and pull access to
  `ghcr.io/gdstechnology/autotask-mcp`.
- A published release: `.github/workflows/release.yml` (semantic-release) builds
  and pushes `:<version>` **and** `:latest` on every releasable push to `main`,
  baking in VERSION/COMMIT_SHA/BUILD_DATE. Note the version it released (GitHub
  Release / tag) — that is what `/health` must report after the deploy.
- The Autotask API credentials for the GDS tenant (below), already configured for
  the `autotask-mcp` service in the `n8n` compose project.

## 2. Environment variables

Required (Autotask API):

| Var | Purpose |
|---|---|
| `AUTOTASK_USERNAME` | API user |
| `AUTOTASK_SECRET` | API secret |
| `AUTOTASK_INTEGRATION_CODE` | Integration code |
| `AUTOTASK_API_URL` | Optional — pin the zone URL to skip zone lookup |

Behavior / safety (set as needed):

| Var | Purpose |
|---|---|
| `AUTOTASK_DEFAULT_OWNER_RESOURCE_ID` | Default company owner when a create omits `ownerResourceID` (§6.1) |
| `AUTOTASK_PROTECTED_COMPANY_IDS` | Comma-separated extra protected company IDs (company `0` is always protected, §7.31) |
| `AUTH_MODE` | `env` (single-tenant, default) or `gateway` (hosted multi-tenant) |
| `MCP_TRANSPORT` | `http` for the server deployment |
| `MCP_HTTP_PORT` / `MCP_HTTP_HOST` | Default `8080` / `0.0.0.0` |
| `LOG_LEVEL` / `LOG_FORMAT` | `info` / `json` in production |
| `LAZY_LOADING` | Progressive tool discovery (optional) |

Keep secrets in the server's env file / secret store — never in the image.

## 3. Where the image comes from

The routine path needs no manual build: the release workflow publishes
`ghcr.io/gdstechnology/autotask-mcp:<version>` and `:latest` from the release
commit with VERSION/COMMIT_SHA/BUILD_DATE baked in. The GitHub Release records
the version + commit.

`scripts/build-image.sh <version>` remains for out-of-band builds (e.g. an
air-gapped `docker save` / `docker load` transfer). It bakes the same three facts
and prints the digest, but it is **not** part of the routine deploy.

## 4. Deploy on the production host

**Back up what is running first** (so rollback is trivial). Record the image ID
of the live container, the version it reports, and a copy of the compose file:

```bash
docker inspect n8n-autotask-mcp-1 --format '{{.Image}}' > ~/autotask-mcp-prev-image.txt
curl -s http://127.0.0.1:18080/health > ~/autotask-mcp-prev-health.json
cp /opt/n8n/docker-compose.yml ~/n8n-docker-compose.yml.bak
```

`{{.Image}}` is the local image ID (`sha256:...`). It is immutable and stays in
the local image store after `:latest` moves on, so it is what rollback pins to.
(Don't `docker image prune` between the deploy and the verify.)

Pull and recreate **only** the `autotask-mcp` service — the tunnel and cron
scheduler are left untouched:

```bash
cd /opt/n8n && docker compose pull autotask-mcp && docker compose up -d autotask-mcp && sleep 3 && curl -s http://127.0.0.1:18080/health
```

The health JSON reports `version` — it must equal the version the release
workflow just published.

## 5. Verify (acceptance — brief §7.34)

More than a health ping:

```bash
# 1. Version matches the release that was published
curl -s http://127.0.0.1:18080/health | jq '{status, version}'
#    -> version must equal the new release version

# 2. The container is running the newly pulled image
docker inspect n8n-autotask-mcp-1 --format '{{.Image}}'
#    -> differs from ~/autotask-mcp-prev-image.txt (unless nothing new was released)

# 3. A real MCP read works end-to-end (initialize + a read tool), not just /health.
#    From the ChatGPT connector / n8n, call autotask_test_connection (read-only,
#    changes nothing) and confirm a successful response.
```

Then confirm the **MCP tunnel (`gds-openai-autotask-tunnel`) and the ChatGPT
connector** reach the server and list tools. For the n8n path, confirm it calls
this MCP directly (no Hermes/LLM hop) and that a controlled run verifies business
fields + audit-note readback.

## 6. Rollback

If verification fails, re-pin the previous image ID in the compose file and
recreate the service. `:latest` already points at the bad build, so rolling back
means replacing the tag — re-pulling it would fetch the same bad image.

```bash
cat ~/autotask-mcp-prev-image.txt      # sha256:...
```

Edit `/opt/n8n/docker-compose.yml` and set the `autotask-mcp` service's image to
that ID:

```yaml
  autotask-mcp:
    image: sha256:<id from ~/autotask-mcp-prev-image.txt>   # ROLLBACK — was ghcr.io/gdstechnology/autotask-mcp:latest
```

Recreate **without pulling** and confirm the old version is back:

```bash
cd /opt/n8n && docker compose up -d autotask-mcp && sleep 3 && curl -s http://127.0.0.1:18080/health
```

`version` must match `~/autotask-mcp-prev-health.json`. Because the previous
image is referenced by its immutable ID, rollback needs no rebuild and no
registry. (A version tag, `ghcr.io/gdstechnology/autotask-mcp:<prev-version>`,
is an equivalent portable pin — the release workflow keeps every version tag.)

**While pinned, `docker compose pull` will not pick up new releases.** Once a
fixed release is published, restore
`image: ghcr.io/gdstechnology/autotask-mcp:latest` (or restore
`~/n8n-docker-compose.yml.bak`) and run the §4 deploy again.

## 7. Release checklist

- [ ] `main` green in CI; release workflow published `:<version>` + `:latest`.
- [ ] Released VERSION + COMMIT_SHA recorded (GitHub Release).
- [ ] Backed up `docker inspect n8n-autotask-mcp-1 --format '{{.Image}}'`, the
      current `/health`, and `/opt/n8n/docker-compose.yml`.
- [ ] `docker compose pull autotask-mcp && docker compose up -d autotask-mcp` in `/opt/n8n`.
- [ ] `/health` on `127.0.0.1:18080` reports the expected version.
- [ ] `autotask_test_connection` succeeds through the ChatGPT connector.
- [ ] Rollback available (previous image ID saved; compose file backed up).
