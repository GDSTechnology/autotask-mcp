# Admin console

A small web console for whoever runs the MCP. It shows how the server is doing,
lets administrators switch features on and off **without a restart**, and keeps a
log of every sign-in and change.

| You can… | Administrator | Read-only |
|---|:---:|:---:|
| See the dashboard: version, Autotask API usage, Postgres shadow health, busiest calls, audit ledger | ✓ | ✓ |
| See every setting and its default | ✓ | ✓ |
| Change settings (read-only mode, tool groups, shadow, read cache) | ✓ | |
| Start a shadow sync now | ✓ | |
| Add, disable, delete users; reset passwords; sign users out | ✓ | |
| See the activity log | ✓ | |

Give the **read-only** role to anyone who only needs the metrics.

## How it is put together

- The console runs **inside the MCP container**, on its **own port**
  (`MCP_ADMIN_PORT`, default `8090`). The MCP endpoint (`/mcp`) and the webhook
  receiver stay on `8080`. Publishing the console never publishes those.
- Users, sessions, settings and the activity log are stored in the MCP's
  **Postgres** database (migration `0004_admin.sql`). The console needs the
  Postgres layer (`MCP_PG_ENABLED=true`); see [POSTGRES.md](POSTGRES.md) and
  DEPLOY.md §8.
- **Secrets never reach the browser.** Autotask credentials, database passwords
  and the webhook secret stay in the env file; the console only shows whether each
  one is set.

## Setup (wizard)

Run the wizard on the Docker host, over SSH. Take the copy from the image you are
running, so it always matches your version:

```bash
docker run --rm --entrypoint cat ghcr.io/gdstechnology/autotask-mcp:latest /app/deploy/admin-setup.sh > admin-setup.sh
```

Read the script first, then run it from the compose project directory:

```bash
bash admin-setup.sh
```

It walks through six steps and changes nothing until you confirm:

1. **Find the MCP**: the compose directory and service (default `autotask-mcp`).
2. **Check Postgres**: stops with instructions if the Postgres layer is off.
3. **Turn the console on**: adds `MCP_ADMIN_ENABLED=true` and `MCP_ADMIN_PORT`
   to the service's env file. A backup copy of the file is saved first.
4. **Migrate and restart**: runs the migrations and recreates the service, then
   waits until the console answers.
5. **First administrator**: creates `admin` (or a name you choose) with a
   **generated password, printed once** in your SSH session. You must choose your
   own password at first sign-in.
6. **Cloudflare Tunnel** (optional): see below.

Re-running is safe. Settings already in place are kept, migrations apply only
what is new, and step 5 never overwrites an existing user.

For an unattended run, take every default and choose the tunnel up front:

```bash
bash admin-setup.sh --yes --tunnel none
```

`--help` lists every option.

### Publishing with Cloudflare Tunnel

The wizard offers three choices:

1. **New tunnel container.** In Cloudflare Zero Trust, go to **Networks → Tunnels
   → Create a tunnel → Cloudflared** and copy the token. The wizard:
   - asks for the token with hidden input and saves it to
     `autotask-mcp-admin-tunnel/.env` (mode 600);
   - writes a small compose file that joins the MCP's Docker network;
   - starts `cloudflared`.
2. **Existing cloudflared.** The wizard prints the route to add, plus the
   `docker network connect` command if your cloudflared can't reach the MCP
   container yet.
3. **Skip.** The console stays private and the wizard prints the SSH
   port-forward recipe.

For choices 1 and 2, add a **public hostname** to the tunnel:

| Field | Value |
|---|---|
| Subdomain / domain | e.g. `mcp-admin.your-domain.com` |
| Service | `HTTP` → `autotask-mcp:8090` (service name and console port) |

**Recommended:** add Cloudflare Access in front of the hostname as a second lock:
**Access → Applications → Self-hosted**, the same hostname, with a policy that
allows only your team's e-mail addresses (one-time PIN or your SSO). The console
still asks for its own sign-in behind it.

## Day-to-day

Sign in and change the temporary password. Then open **Users → Add a user**: each
new user gets a generated password shown once, and they choose their own at
first sign-in.

### Settings

| Setting | What it does | Default from |
|---|---|---|
| Allow write tools | Off = **read-only MCP**: every tool that creates, updates or deletes is hidden from agents and refused if called | always on |
| Disabled tool groups | Hide whole groups (e.g. `financial`, `webhooks`) from agents | none |
| Scheduled sync | Pause the shadow's background sync | on |
| Serve searches from the shadow | Answer searches from Postgres while it is fresh | `MCP_PG_SHADOW_SERVE_READS` |
| Max mirror age (seconds) | How stale the shadow may be and still answer | `MCP_PG_SHADOW_MAX_AGE_SECONDS` |
| Pause sync at API usage % | Skip sync runs while tenant usage is high | `MCP_PG_SHADOW_PAUSE_AT_PCT` |
| Read cache | The short-lived Autotask read cache | `AUTOTASK_CACHE` |

Changes apply at once and are kept in Postgres, so they survive restarts.
**Reset to default** returns a setting to the env file's value. A server without
the console behaves exactly as its env file says.

How tool switches reach agents:

- Agents that connect after a change see the new tool list.
- Agents that are already connected get a clear error, "disabled by an
  administrator", if they call a switched-off tool.
- Discovery tools (`list_categories`, `execute_tool`, `router`, `whoami`,
  `test_connection`) are never switched off.

### Locked out?

On the host:

```bash
docker compose exec autotask-mcp node dist/admin/cli.js reset-password admin
```

This prints a new temporary password and signs that user out everywhere. Other
commands:

| Command | What it does |
|---|---|
| `init [username]` | Create the first administrator |
| `create-user <username> [admin\|viewer]` | Add a user |
| `enable <username>` | Re-enable a disabled user |
| `list-users` | List the users |

## Security

**Passwords**
- Stored as scrypt hashes.
- Generated passwords are about 117 bits and never logged.
- Chosen passwords need at least 12 characters and may not contain the username.

**Sessions**
- The session is a random token in an `HttpOnly`, `SameSite=Strict` cookie, which
  is `Secure` and `__Host-` behind HTTPS.
- Only a SHA-256 of the token is stored.
- Sessions expire after 12 h idle or 7 days.
- Changing a password signs out the user's other sessions. Disabling a user signs
  them out everywhere.

**Requests**
- **Cross-site requests are refused.** Every change needs the `X-Atmcp` header,
  which a foreign page can't send, and a same-host `Origin`.
- **Sign-ins are throttled:** 6 failures per username, or 20 per IP, in 15 minutes.
- **Strict Content-Security-Policy:** no inline script, nothing loaded from other
  sites, and the page can't be framed.

**Admin accounts**
- The last active administrator can't be demoted, disabled or deleted.

## Environment

| Var | Default | Purpose |
|---|---|---|
| `MCP_ADMIN_ENABLED` | `false` | Start the console (HTTP transport + Postgres layer required) |
| `MCP_ADMIN_PORT` | `8090` | Console port inside the container |
| `MCP_ADMIN_HOST` | `0.0.0.0` | Bind address |
| `MCP_ADMIN_COOKIE_SECURE` | `auto` | `auto` = Secure cookie when the proxy says HTTPS (`X-Forwarded-Proto`); `true` / `false` to force |
| `MCP_ADMIN_TRUST_PROXY` | `true` | Use `CF-Connecting-IP` / `X-Forwarded-For` for the client IP (throttling, activity log). Set `false` if the port is reachable without a proxy |
