#!/usr/bin/env bash
# Autotask MCP — admin console setup wizard.
#
# Run on the Docker host that runs the MCP (over SSH). It:
#   1. finds the MCP service in your compose project,
#   2. checks the Postgres layer is on (the console stores users there),
#   3. turns the console on (MCP_ADMIN_ENABLED / MCP_ADMIN_PORT in the env file),
#   4. runs the database migrations and restarts the MCP,
#   5. creates the first administrator with a GENERATED password (shown once),
#   6. optionally publishes the console through a Cloudflare Tunnel.
#
# Get the copy that matches your running image (no download from the internet):
#   docker run --rm --entrypoint cat ghcr.io/gdstechnology/autotask-mcp:latest /app/deploy/admin-setup.sh > admin-setup.sh
#   less admin-setup.sh        # read it first
#   bash admin-setup.sh
#
# Re-running is safe: settings already in place are kept, migrations only apply
# what is new, and the first-admin step never overwrites an existing user.
#
# Options (all optional; the wizard asks for anything not given):
#   --dir <path>          compose project directory     (default: current dir)
#   --service <name>      MCP compose service           (default: autotask-mcp)
#   --env-file <path>     env file the service reads    (default: detected)
#   --port <n>            console port in the container (default: 8090)
#   --admin <username>    first administrator           (default: admin)
#   --tunnel new|existing|none
#   -y, --yes             accept defaults, ask nothing that has a default

set -euo pipefail

# ── output helpers ─────────────────────────────────────────────────────────
if [ -t 1 ]; then B=$'\e[1m'; D=$'\e[2m'; G=$'\e[32m'; Y=$'\e[33m'; R=$'\e[31m'; C=$'\e[36m'; N=$'\e[0m'; else B= D= G= Y= R= C= N=; fi
step()  { printf '\n%s━━ %s%s\n' "$B$C" "$1" "$N"; }
ok()    { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
warn()  { printf '  %s!%s %s\n' "$Y" "$N" "$1"; }
fail()  { printf '\n  %s✗ %s%s\n\n' "$R" "$1" "$N" >&2; exit 1; }
info()  { printf '  %s\n' "$1"; }

DIR="" SERVICE="" ENV_FILE="" PORT="" ADMIN_USER="" TUNNEL="" YES=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --admin) ADMIN_USER="$2"; shift 2 ;;
    --tunnel) TUNNEL="$2"; shift 2 ;;
    -y|--yes) YES=1; shift ;;
    -h|--help) sed -n '2,32p' "$0"; exit 0 ;;
    *) fail "Unknown option: $1 (see --help)" ;;
  esac
done

# ask VAR "Question" "default"
ask() {
  local __var="$1" __q="$2" __def="${3:-}" __ans
  if [ -n "${!__var:-}" ]; then return; fi
  if [ "$YES" = 1 ] && [ -n "$__def" ]; then printf -v "$__var" '%s' "$__def"; return; fi
  read -r -p "  $__q${__def:+ [$__def]}: " __ans </dev/tty || true
  printf -v "$__var" '%s' "${__ans:-$__def}"
}
confirm() { # confirm "Question" (default yes)
  [ "$YES" = 1 ] && return 0
  local a; read -r -p "  $1 [Y/n]: " a </dev/tty || true
  [[ -z "$a" || "$a" =~ ^[Yy] ]]
}

printf '\n%sAutotask MCP — admin console setup%s\n' "$B" "$N"
info "${D}Nothing is changed until you confirm. Secrets are never printed.${N}"

# ── 1. find the service ────────────────────────────────────────────────────
step "1/6  Find the MCP"
command -v docker >/dev/null || fail "docker is not installed or not on PATH."
docker compose version >/dev/null 2>&1 || fail "The Docker Compose plugin (docker compose) is required."
docker info >/dev/null 2>&1 || fail "Cannot talk to Docker. Run as a user in the docker group, or with sudo."

ask DIR "Compose project directory" "$(pwd)"
[ -d "$DIR" ] || fail "No such directory: $DIR"
cd "$DIR"
ls docker-compose.y*ml compose.y*ml >/dev/null 2>&1 || fail "No docker-compose.yml / compose.yml in $DIR."
ask SERVICE "MCP service name" "autotask-mcp"
CID="$(docker compose ps -q "$SERVICE" 2>/dev/null || true)"
[ -n "$CID" ] || fail "Service '$SERVICE' is not running in $DIR. Start it first (docker compose up -d $SERVICE)."
ok "Found '$SERVICE' (container $(docker inspect -f '{{.Name}}' "$CID" | sed 's#^/##'))"

dexec() { docker compose exec -T "$SERVICE" "$@"; }
dexec test -f dist/admin/cli.js 2>/dev/null || fail "This image has no admin console. Deploy a newer release first (see DEPLOY.md §4), then re-run."
ok "Image includes the admin console ($(dexec node -e "process.stdout.write(require('./package.json').version)" 2>/dev/null || echo '?'))"

# ── 2. Postgres ────────────────────────────────────────────────────────────
step "2/6  Check Postgres"
if [ "$(dexec printenv MCP_PG_ENABLED 2>/dev/null | tr -d '\r' | tr 'A-Z' 'a-z')" != "true" ]; then
  fail "The Postgres layer is off for '$SERVICE' (MCP_PG_ENABLED is not true).
    The console keeps its users and settings in Postgres. Set Postgres up first —
    docs/POSTGRES.md and DEPLOY.md (\"Postgres shadow\") — then re-run this wizard."
fi
[ -n "$(dexec printenv MCP_PG_MIGRATOR_PASSWORD 2>/dev/null)" ] || fail "MCP_PG_MIGRATOR_PASSWORD is not set for '$SERVICE' — migrations need it (see docs/POSTGRES.md)."
ok "Postgres layer is on"

# ── 3. env file ────────────────────────────────────────────────────────────
step "3/6  Turn the console on"
if [ -z "$ENV_FILE" ]; then
  DETECTED="$(docker compose config 2>/dev/null | awk -v s="  $SERVICE:" '
    $0==s {in_s=1; next}
    in_s && /^  [^ ]/ {in_s=0}
    in_s && /env_file:/ {in_e=1; next}
    in_s && in_e && /path:/ {sub(/.*path: */,""); gsub(/"/,""); print; exit}
    in_s && in_e && /^ +- / {sub(/^ +- /,""); gsub(/"/,""); print; exit}
    in_s && in_e && !/^ +(- |path:|required:)/ {in_e=0}')"
  if [ -z "$DETECTED" ]; then
    for f in "$DIR/autotask-mcp.env" "$DIR/.env"; do [ -f "$f" ] && { DETECTED="$f"; break; }; done
  fi
  ask ENV_FILE "Env file the service reads (its env_file)" "${DETECTED:-$DIR/autotask-mcp.env}"
fi
[ -f "$ENV_FILE" ] || fail "Env file not found: $ENV_FILE"
ask PORT "Console port inside the container" "8090"
[[ "$PORT" =~ ^[0-9]+$ ]] && [ "$PORT" -ge 1024 ] && [ "$PORT" -le 65535 ] || fail "Port must be 1024–65535."
[ "$PORT" != "$(dexec printenv MCP_HTTP_PORT 2>/dev/null | tr -d '\r' || echo 8080)" ] || fail "Port $PORT is the MCP's own port — pick another (default 8090)."

current() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }
set_var() {
  if grep -qE "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"; fi
}
if [ "$(current MCP_ADMIN_ENABLED)" = "true" ] && [ "$(current MCP_ADMIN_PORT)" = "$PORT" ]; then
  ok "Already enabled in $(basename "$ENV_FILE") (port $PORT)"
  CHANGED=0
else
  info "Will set in $ENV_FILE:"
  info "  ${B}MCP_ADMIN_ENABLED=true${N}"
  info "  ${B}MCP_ADMIN_PORT=$PORT${N}"
  confirm "Apply (a backup copy is saved next to it)?" || fail "Stopped — nothing changed."
  cp -p "$ENV_FILE" "$ENV_FILE.bak-$(date +%Y%m%d%H%M%S)"
  [ -n "$(tail -c1 "$ENV_FILE")" ] && echo >> "$ENV_FILE"
  grep -q '^# Admin console' "$ENV_FILE" || printf '# Admin console (admin-setup.sh)\n' >> "$ENV_FILE"
  set_var MCP_ADMIN_ENABLED true
  set_var MCP_ADMIN_PORT "$PORT"
  ok "Updated $(basename "$ENV_FILE") (backup kept)"
  CHANGED=1
fi

# ── 4. migrate + restart ───────────────────────────────────────────────────
step "4/6  Database migrations and restart"
docker compose run --rm --no-deps -T "$SERVICE" node dist/db/migrate.js 2>&1 | sed 's/^/    /' || fail "Migrations failed (output above)."
ok "Migrations applied"
if [ "$CHANGED" = 1 ] || ! dexec wget -qO- "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  docker compose up -d "$SERVICE" 2>&1 | sed 's/^/    /'
fi
printf '  Waiting for the console'
for _ in $(seq 1 30); do
  if dexec wget -qO- "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then printf '\n'; ok "Console is up on port $PORT inside the container"; UP=1; break; fi
  printf '.'; sleep 2
done
[ "${UP:-0}" = 1 ] || fail "The console did not come up. Check: docker compose logs --tail 50 $SERVICE
    (If '$SERVICE' does not read $(basename "$ENV_FILE") as its env_file, the setting never reached it.)"

# ── 5. first administrator ─────────────────────────────────────────────────
step "5/6  First administrator"
ask ADMIN_USER "Administrator username" "admin"
set +e
dexec node dist/admin/cli.js init "$ADMIN_USER"
RC=$?
set -e
case "$RC" in
  0) ok "Write the password down now — it is not stored anywhere readable and will not be shown again." ;;
  3) warn "Users already exist, so no new administrator was created."
     info "Lost the password? Run: docker compose exec $SERVICE node dist/admin/cli.js reset-password <username>" ;;
  *) fail "Could not create the administrator (exit $RC)." ;;
esac

# ── 6. Cloudflare Tunnel ───────────────────────────────────────────────────
step "6/6  Publish with Cloudflare Tunnel (optional)"
NET="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' "$CID" | head -1)"
if [ -z "$TUNNEL" ]; then
  info "1) Run a new cloudflared container for the console (you have a tunnel token)"
  info "2) I already run cloudflared — show me the route to add"
  info "3) Skip — keep the console private (SSH port-forward only)"
  ask CHOICE "Choose" "3"
  case "${CHOICE:-3}" in 1) TUNNEL=new ;; 2) TUNNEL=existing ;; *) TUNNEL=none ;; esac
fi

route_help() {
  info "In Cloudflare Zero Trust → ${B}Networks → Tunnels${N} → your tunnel → ${B}Public hostnames → Add${N}:"
  info "    Subdomain / domain : e.g. ${B}mcp-admin${N} . your-domain.com"
  info "    Service            : ${B}HTTP${N}  →  ${B}$SERVICE:$PORT${N}"
  info "Only the console is published: the MCP endpoint (/mcp) and webhook receiver"
  info "live on a different port, so they stay unreachable through this hostname."
  info ""
  info "${Y}Strongly recommended:${N} put Cloudflare Access in front as a second lock —"
  info "Zero Trust → ${B}Access → Applications → Add → Self-hosted${N}, the same hostname,"
  info "with a policy allowing only your team's e-mails (one-time PIN or your SSO)."
}

case "$TUNNEL" in
  new)
    TDIR="$DIR/autotask-mcp-admin-tunnel"
    info "Create a tunnel first: Zero Trust → Networks → Tunnels → ${B}Create a tunnel${N} → Cloudflared,"
    info "name it (e.g. autotask-mcp-admin), and copy the ${B}token${N} from the Docker install command"
    info "(the long string after --token)."
    TOKEN=""
    if [ -f "$TDIR/.env" ] && grep -q '^TUNNEL_TOKEN=.' "$TDIR/.env" && confirm "A tunnel token is already saved in $TDIR/.env — keep it?"; then
      ok "Keeping the saved token"
    else
      read -r -s -p "  Paste the tunnel token (input hidden): " TOKEN </dev/tty; echo
      TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]')"
      TOKEN="${TOKEN#--token}"
      [ "${#TOKEN}" -ge 80 ] || fail "That does not look like a tunnel token (too short)."
      [[ "$TOKEN" =~ ^[A-Za-z0-9+/=_-]+$ ]] || fail "That does not look like a tunnel token (unexpected characters)."
      mkdir -p "$TDIR"; umask 077
      printf 'TUNNEL_TOKEN=%s\n' "$TOKEN" > "$TDIR/.env"; chmod 600 "$TDIR/.env"; umask 022
      unset TOKEN
      ok "Token saved to $TDIR/.env (mode 600)"
    fi
    cat > "$TDIR/docker-compose.yml" <<YAML
# Cloudflare Tunnel for the Autotask MCP admin console (written by admin-setup.sh).
# Joins the MCP's Docker network so it can reach $SERVICE:$PORT by name.
# The token is in .env next to this file (chmod 600) — never commit it.
name: autotask-mcp-admin-tunnel
services:
  cloudflared:
    image: cloudflare/cloudflared:latest
    command: tunnel --no-autoupdate run
    environment:
      TUNNEL_TOKEN: \${TUNNEL_TOKEN}
    restart: unless-stopped
    networks: [mcp]
networks:
  mcp:
    external: true
    name: $NET
YAML
    (cd "$TDIR" && docker compose up -d 2>&1 | sed 's/^/    /')
    sleep 4
    if docker compose -f "$TDIR/docker-compose.yml" logs --tail 30 cloudflared 2>&1 | grep -qi 'Registered tunnel connection'; then ok "Tunnel connected to Cloudflare"
    else warn "Tunnel started; check it with: docker compose -f $TDIR/docker-compose.yml logs -f"; fi
    route_help ;;
  existing)
    info "Your cloudflared must be able to reach the MCP container. Attach it to the"
    info "MCP's network if it is not already:  ${B}docker network connect $NET <cloudflared-container>${N}"
    info ""
    route_help ;;
  *)
    LP=$(( PORT < 10000 ? 10000 + PORT : PORT ))
    info "The console is not published. To use it privately, publish the port on"
    info "localhost only — in the compose file, under '$SERVICE:', add to ports:"
    info "    ${B}- \"127.0.0.1:$LP:$PORT\"${N}     (then: docker compose up -d $SERVICE)"
    info "and from your workstation:  ${B}ssh -L $LP:127.0.0.1:$LP <this-host>${N}"
    info "then open http://localhost:$LP" ;;
esac

printf '\n%s✓ Done.%s Sign in as %s%s%s, choose your own password, then add users under\n' "$G$B" "$N" "$B" "$ADMIN_USER" "$N"
printf '  Users (choose "Read-only" for people who only need the metrics).\n\n'
