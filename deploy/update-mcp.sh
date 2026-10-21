#!/usr/bin/env bash
# Autotask MCP — update the running server to the latest published image.
#
# Run on the Docker host, as the user that runs the compose project. It:
#   1. refuses while a bulk job is PREPARING (a restart would fail the preparation;
#      running / paused jobs are fine and continue after the restart),
#   2. pulls the image; if nothing new, says so and changes nothing,
#   3. tags the image it is replacing as :rollback (before anything is pruned),
#   4. runs the database migrations (only what is new),
#   5. restarts the MCP, prunes old images, waits for /health and prints the version,
#   6. refreshes this script from the new image.
#
# Install once (the copy in the image — no download from the internet):
#   docker run --rm --entrypoint cat ghcr.io/gdstechnology/autotask-mcp:latest /app/deploy/update-mcp.sh > /usr/local/bin/update-mcp
#   chmod +x /usr/local/bin/update-mcp
# Then:   update-mcp
#
# Options:
#   --recreate     restart even without a new image (after an env-file change)
#   --rollback     go back to the :rollback image (the one the last update replaced)
#   --force        update even while a bulk job is preparing
#   --dir <path>   compose project directory          (default: /opt/n8n, or MCP_DIR)
#   --service <s>  MCP compose service                (default: autotask-mcp)
#   --container <c> MCP container                     (default: <project>-<service>-1)
#   --port <n>     host port of /health               (default: 18080)
#   --image <ref>  image repository                   (default: ghcr.io/gdstechnology/autotask-mcp)

set -euo pipefail

DIR="${MCP_DIR:-/opt/n8n}"; SERVICE="autotask-mcp"; CONTAINER=""; PORT="18080"
IMAGE="ghcr.io/gdstechnology/autotask-mcp"; RECREATE=0; ROLLBACK=0; FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --recreate) RECREATE=1 ;;
    --rollback) ROLLBACK=1 ;;
    --force) FORCE=1 ;;
    --dir) DIR="$2"; shift ;;
    --service) SERVICE="$2"; shift ;;
    --container) CONTAINER="$2"; shift ;;
    --port) PORT="$2"; shift ;;
    --image) IMAGE="$2"; shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

cd "$DIR"
[ -n "$CONTAINER" ] || CONTAINER="$(basename "$DIR")-${SERVICE}-1"
say() { printf '\n== %s\n' "$*"; }
health() {
  local i out
  for i in $(seq 1 30); do
    out="$(curl -s --max-time 3 "http://127.0.0.1:${PORT}/health" || true)"
    if [ -n "$out" ]; then
      printf '%s\n' "$out" | sed -n 's/.*"version":"\([^"]*\)".*/version: \1/p'
      printf '%s\n' "$out" | sed -n 's/.*"backpressure":{"level":"\([a-z]*\)".*"usedPct":\([0-9.]*\).*/backpressure: \1, Autotask API usage \2%/p'
      return 0
    fi
    sleep 2
  done
  echo "/health did not answer within 60 s — check: docker compose logs --tail 50 ${SERVICE}" >&2
  return 1
}
running_version() { curl -s --max-time 3 "http://127.0.0.1:${PORT}/health" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p' || true; }

# Bulk jobs still preparing? (asked inside the running MCP, with its own database settings)
preparing() {
  docker exec -w /app "$CONTAINER" node --input-type=module -e "
    const { getPool } = await import('/app/dist/db/pool.js');
    const quiet = { info() {}, warn() {}, error() {}, debug() {} };
    const p = getPool(quiet);
    if (!p) { console.log(0); process.exit(0); }
    try { const r = await p.query(\"SELECT count(*)::int n FROM bulk_job WHERE status = 'preparing'\"); console.log(r.rows[0].n); }
    catch { console.log(0); }
    await p.end();" 2>/dev/null || echo 0
}

if [ "$ROLLBACK" = 1 ]; then
  docker image inspect "${IMAGE}:rollback" >/dev/null 2>&1 || { echo "No ${IMAGE}:rollback image on this host." >&2; exit 1; }
  say "Rolling back from $(running_version) to the :rollback image"
  echo "Set the ${SERVICE} image to ${IMAGE}:rollback in ${DIR}/docker-compose.yml, then run:"
  echo "  cd ${DIR} && docker compose up -d ${SERVICE}"
  echo "(The compose file is yours to edit; this script does not change it. Put :latest back afterwards.)"
  exit 0
fi

say "Running now: $(running_version || echo unknown)"
if [ "$FORCE" = 0 ]; then
  n="$(preparing)"
  if [ "${n:-0}" != "0" ]; then
    echo "${n} bulk job(s) are PREPARING — a restart would fail them. Wait until they are 'Ready' (console → Bulk jobs), or re-run with --force." >&2
    exit 1
  fi
fi

say "Pulling ${IMAGE}:latest"
OLD="$(docker inspect "$CONTAINER" --format '{{.Image}}')"
docker compose pull "$SERVICE"
NEW="$(docker image inspect "${IMAGE}:latest" --format '{{.Id}}')"

if [ "$OLD" = "$NEW" ] && [ "$RECREATE" = 0 ]; then
  say "Already on the latest image — nothing changed"
  health
  exit 0
fi

if [ "$OLD" != "$NEW" ]; then
  say "New image: keeping the current one as :rollback"
  docker tag "$OLD" "${IMAGE}:rollback"
  say "Database migrations"
  docker compose run --rm --no-deps -T "$SERVICE" node dist/db/migrate.js
  say "Restarting ${SERVICE}"
  docker compose up -d "$SERVICE"
  docker image prune -f >/dev/null
else
  say "Same image — recreating ${SERVICE} (--recreate, e.g. after an env change)"
  docker compose up -d --force-recreate "$SERVICE"
fi

say "Health"
health

# Keep this script current: take the copy from the image that now runs.
SELF="$(readlink -f "$0" 2>/dev/null || echo "$0")"
if [ -w "$SELF" ] && docker run --rm --entrypoint cat "${IMAGE}:latest" /app/deploy/update-mcp.sh > "${SELF}.new" 2>/dev/null && [ -s "${SELF}.new" ]; then
  if ! cmp -s "${SELF}.new" "$SELF"; then chmod +x "${SELF}.new" && mv "${SELF}.new" "$SELF" && echo "(update-mcp itself was updated from the new image)"; else rm -f "${SELF}.new"; fi
else rm -f "${SELF}.new" 2>/dev/null || true; fi
