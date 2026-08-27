# GDS Autotask MCP — Deploy & Rollback Runbook

Production target: **the production host** (the existing GDS environment — do not
introduce a second VPS). This runbook covers building a traceable, pinned image
and deploying it with a documented rollback. It follows the traceability rules in
the implementation brief §7.34: the deployed version is proven from the running
container's `/health`, never inferred from a repo/tag alone.

## 0. Traceability principle

Every release records **three** facts, baked into the image at build time and
reported by `/health`:

- `VERSION` — the release version
- `COMMIT_SHA` — the exact source commit
- `BUILD_DATE` — UTC build timestamp

The dependency `autotask-node` is the **public** `github:GDSTechnology/autotask-node`
fork, so the image builds with **no registry token**.

## 1. Prerequisites

- Docker on the build host and on the production host.
- Access to push/pull the image registry (default `ghcr.io/gdstechnology/autotask-mcp`;
  override with `IMAGE_NAME`). For an air-gapped path you can `docker save`/`load`
  instead of a registry — see step 4.
- The Autotask API credentials for the GDS tenant (below).

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

## 3. Build a traceable image

From a **clean checkout of the release commit on `main`**:

```bash
scripts/build-image.sh 2.19.0            # or your chosen version
```

It bakes VERSION/COMMIT_SHA/BUILD_DATE, tags the image by both version and short
SHA, and prints the image **digest** to pin. Record the version + commit + digest
in the release notes.

Push (or export for transfer):

```bash
docker push ghcr.io/gdstechnology/autotask-mcp:2.19.0
docker push ghcr.io/gdstechnology/autotask-mcp:<short-sha>
# air-gapped alternative:
# docker save ghcr.io/gdstechnology/autotask-mcp:2.19.0 | gzip > autotask-mcp-2.19.0.tar.gz
```

## 4. Deploy on the production host

**Back up the current deployment first** (so rollback is trivial):

```bash
# record what is running now
docker inspect autotask-mcp --format '{{.Config.Image}}' > ~/autotask-mcp-prev-image.txt
docker inspect autotask-mcp --format '{{index .Config.Env}}' > ~/autotask-mcp-prev-env.txt
cp /path/to/autotask-mcp.env ~/autotask-mcp.env.bak   # your env file
```

Pull (or `docker load`) the new image, then run it **pinned by digest** (not a
floating tag):

```bash
docker pull ghcr.io/gdstechnology/autotask-mcp:2.19.0
DIGEST=$(docker inspect ghcr.io/gdstechnology/autotask-mcp:2.19.0 --format '{{index .RepoDigests 0}}')

docker rm -f autotask-mcp 2>/dev/null || true
docker run -d --name autotask-mcp \
  --restart unless-stopped \
  --env-file /path/to/autotask-mcp.env \
  -p 8080:8080 \
  "$DIGEST"
```

Pinning to `$DIGEST` (e.g. `...@sha256:...`) is what makes the deploy immutable —
a re-pull of `:2.19.0` can never silently change what runs.

## 5. Verify (acceptance — brief §7.34)

More than a health ping:

```bash
# 1. Version matches the release you built
curl -s http://localhost:8080/health | jq '{status, version}'
#    -> version must equal 2.19.0

# 2. A real MCP read works end-to-end (initialize + a read tool), not just /health.
#    From the ChatGPT connector / n8n, call autotask_test_connection (read-only,
#    changes nothing) and confirm a successful response.
```

Then confirm the **MCP tunnel and the ChatGPT connector** reach the server and
list tools. For the n8n path, confirm it calls this MCP directly (no Hermes/LLM
hop) and that a controlled run verifies business fields + audit-note readback.

## 6. Rollback

If verification fails, roll straight back to the previous image:

```bash
PREV=$(cat ~/autotask-mcp-prev-image.txt)
docker rm -f autotask-mcp
docker run -d --name autotask-mcp \
  --restart unless-stopped \
  --env-file ~/autotask-mcp.env.bak \
  -p 8080:8080 \
  "$PREV"
curl -s http://localhost:8080/health | jq '{status, version}'   # confirm old version restored
```

Because the previous image is referenced by its digest/ID and the env file is
backed up, rollback is a single `docker run` with no rebuild.

## 7. Release checklist

- [ ] `main` green in CI (unit tests + Docker build).
- [ ] Built from a clean checkout; recorded VERSION + COMMIT_SHA + digest.
- [ ] Backed up current image + env on the production host.
- [ ] Deployed pinned by digest.
- [ ] `/health` reports the expected version.
- [ ] `autotask_test_connection` succeeds through the ChatGPT connector.
- [ ] Rollback steps confirmed available (previous digest + env saved).
