# Admin console

A small web console for whoever runs the MCP. It shows how the server is doing,
lets administrators switch features on and off **without a restart**, and keeps a
log of every sign-in and change.

| You can… | Administrator | Read-only |
|---|:---:|:---:|
| See the dashboard: version, Autotask API usage, Postgres shadow health, busiest calls, audit ledger | ✓ | ✓ |
| See the Calls log: who is calling, recent tool calls and the Autotask calls each one made | ✓ | ✓ |
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

## Setup

### 0. Get a version with the console onto the server

The console ships inside the MCP image, so the server has to be running a
release that includes it before anything else:

1. The change is merged to `main`. The release workflow then publishes a new
   image. Wait for the **last** release run to finish.
2. Deploy it with the routine command in DEPLOY.md §4. It pulls the image, runs
   the database migrations and restarts the MCP.
3. Check that `/health` reports the new `version`.

The console stays **off** after this step. Nothing changes for agents until you
run the wizard.

### 1. Run the wizard

Over SSH on the Docker host, from the compose project directory. Take the
wizard out of the image you just deployed, so it always matches your version:

```bash
docker run --rm --entrypoint cat ghcr.io/gdstechnology/autotask-mcp:latest /app/deploy/admin-setup.sh > admin-setup.sh
```

Read the script first, then run it:

```bash
bash admin-setup.sh
```

It walks through six steps and changes nothing until you confirm:

1. **Find the MCP**: the compose directory and service (default `autotask-mcp`).
   Stops if the running image is too old to have the console.
2. **Check Postgres**: stops with instructions if the Postgres layer is off.
3. **Turn the console on**: adds `MCP_ADMIN_ENABLED=true` and `MCP_ADMIN_PORT`
   to the service's env file. A backup copy of the file is saved first.
4. **Migrate and restart**: runs the migrations and recreates the service, then
   waits until the console answers.
5. **First administrator**: creates `admin` (or a name you choose) with a
   **generated password, printed once** in your SSH session. You must choose your
   own password at first sign-in.
6. **Cloudflare Tunnel** (optional): a guided walkthrough. It shows each
   Cloudflare dashboard step, waits for you, and then checks the result from the
   server. The same steps, in more detail, follow below.

Re-running is safe, so you can stop at any point and come back later:
- settings already in place are kept;
- migrations apply only what is new;
- step 5 never overwrites an existing user;
- a saved tunnel token can be kept.

`--help` lists every option.

## Cloudflare Tunnel, step by step

A tunnel lets people open the console at an address like
`https://mcp-admin.your-company.com`. No port is opened on the server's
firewall: the server makes an outbound connection to Cloudflare.

Cloudflare renames dashboard menus from time to time. Where a newer name is
known, it is given in brackets.

### What you need first

- **A Cloudflare account.** The free plan is fine:
  <https://dash.cloudflare.com/sign-up>.
- **A domain whose DNS is hosted on Cloudflare.**
  - In the dashboard, open the domain → **Overview**. The status must say
    **Active**.
  - If the domain isn't on Cloudflare yet: **Add a domain**, then change the
    nameservers at your registrar to the two that Cloudflare shows. This can take
    up to a day to switch over.
  - A subdomain such as `mcp-admin` is created for you later, so you don't add a
    DNS record yourself.
- **Zero Trust switched on.** You only do this once per account.
  1. Open **Zero Trust** from the dashboard's left menu.
  2. Choose a team name, e.g. `your-company`.
  3. Choose the **Free** plan. Cloudflare may ask for a payment card even on the
     Free plan; it is not charged.

### Step 1: Create the tunnel

1. **Zero Trust → Networks → Tunnels** [Networking → Tunnels] → **Create a
   tunnel**.
2. Connector type: **Cloudflared** → **Next**.
3. Name: `autotask-mcp-admin` → **Save tunnel**.
4. The next page shows install commands. Pick the **Docker** tab. The command
   looks like this:

   ```text
   docker run cloudflare/cloudflared:latest tunnel --no-autoupdate run --token eyJhIjoi...
   ```

5. Copy **only the long value after `--token`**. Treat it like a password: anyone
   who has it can attach to your tunnel.
6. **Don't run that command.** The wizard runs `cloudflared` for you, on the
   MCP's Docker network. If you started it by hand, it couldn't reach the MCP
   container.

### Step 2: Give the token to the wizard

In the wizard, at step 6, choose **1) Set up a NEW Cloudflare Tunnel** and paste
the token when asked. The input is hidden. The wizard:

- saves the token to `autotask-mcp-admin-tunnel/.env`, readable only by its
  owner;
- writes `autotask-mcp-admin-tunnel/docker-compose.yml` and starts
  `cloudflared`;
- waits for **"Registered tunnel connection"**.

Back in the dashboard, refresh **Tunnels**. The tunnel should show **HEALTHY**.

### Step 3: Point a hostname at the console

1. Click the tunnel → **Edit** → **Public hostname** tab → **Add a public
   hostname** [the tunnel's **Routes** → **Add route** → **Published
   application**].
2. Fill in:

   | Field | Value |
   |---|---|
   | Subdomain | `mcp-admin` (any name) |
   | Domain | your domain, picked from the list |
   | Path | leave empty |
   | Service type | **HTTP** (not HTTPS: the tunnel already encrypts the traffic) |
   | URL | `autotask-mcp:8090` (the MCP service name, then the console port) |

3. **Save**. Cloudflare creates the DNS record.

The wizard then asks for the hostname and tests it from the server. Open
`https://mcp-admin.your-domain.com` in a browser: you should see the console's
sign-in page.

### Step 4 (strongly recommended): Cloudflare Access

Access adds a second lock: people must prove their e-mail address to Cloudflare
before they even see the console's sign-in page.

1. **Zero Trust → Access → Applications** [Access controls → Applications] →
   **Add an application** → **Self-hosted**.
2. Application name: `Autotask MCP Admin`. Session duration: `24 hours`.
3. **Add public hostname**: the same subdomain and domain as in Step 3.
4. **Next**, then **Add a policy**:

   | Field | Value |
   |---|---|
   | Policy name | `Team` |
   | Action | **Allow** |
   | Include | **Emails ending in** → `@your-company.com`, or **Emails** → the exact addresses |

5. **Next**, keep the defaults, then **Add application**.
6. Choose how people sign in to Access: **Zero Trust → Settings →
   Authentication**.
   - **One-time PIN** works with no setup: Cloudflare e-mails a code.
   - Microsoft Entra ID or Google can be added here later.

Test in a private browser window. You should get Cloudflare's "enter your
e-mail" page first, then the console's sign-in page. The wizard's check reports
"protected by Cloudflare Access" when this works.

### If it doesn't work

| What you see | Cause | Fix |
|---|---|---|
| Error **1033** / HTTP **530** | The tunnel isn't connected | `docker compose -f autotask-mcp-admin-tunnel/docker-compose.yml logs --tail 30`. "Unauthorized" means a bad token: re-run the wizard and paste it again |
| HTTP **502** / "Bad gateway" | Cloudflare can't reach the console | The route's URL must be `autotask-mcp:8090` with type **HTTP**. Check that the console is on: `/health` shows `"admin": {"running": true}` |
| The address doesn't resolve | No DNS record | The domain must be **Active** on Cloudflare DNS. Re-save the hostname route |
| The Access page loops or says "not authorized" | The Access policy doesn't match | Check the e-mail domain or list in the policy |
| The console says "admin tables are missing" | Migrations not run | `docker compose run --rm --no-deps -T autotask-mcp node dist/db/migrate.js` |

### Other choices in the wizard

- **2) I already run cloudflared**:
  - the wizard prints the `docker network connect` command that lets your
    existing `cloudflared` reach the MCP container;
  - then you follow Steps 3–4.
- **3) Skip**: the console stays private. The wizard prints how to reach it
  through an SSH port-forward instead.

## Updates

**Updating the MCP keeps your console.** The routine deploy (DEPLOY.md §4)
replaces only the MCP container. The console's web pages are part of the image,
so they update along with it.

| What | Where it lives | Changed by an update? |
|---|---|---|
| Console on/off and port | the env file (`autotask-mcp.env`) | No |
| Users, settings, activity log | the MCP's Postgres volume | No (migrations only add tables) |
| Cloudflare Tunnel and its token | `autotask-mcp-admin-tunnel/`, its own compose project | No |

After a deploy, `/health` should include `"admin": {"enabled": true, "running": true, "schemaReady": true}`.

To update `cloudflared` itself, now and then:

```bash
docker compose -f autotask-mcp-admin-tunnel/docker-compose.yml pull && docker compose -f autotask-mcp-admin-tunnel/docker-compose.yml up -d
```

**Never** run `docker compose down -v` in the MCP's compose directory. The `-v`
deletes the volumes, and with them the console's users and the shadow.

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

### Calls (diagnostics)

The **Calls** page shows whether the MCP is working and who is using it.
It refreshes every 10 seconds.

**Who is calling (last hour).** One row per caller, with how many tool calls it
made, how many failed, and how many Autotask calls they cost. A caller is the
`source` the client declares (`n8n`, `chatgpt`, `cron`), plus the IP address
and client name the request actually came from.
Background work, such as the shadow sync and the console's own usage check, is
listed separately.

**Tool calls.** Each tool call with its result and how long it took. Click a row
to see every Autotask request that call made, with each request's status code
and duration. Each row also shows how many requests were answered from the read
cache or the Postgres shadow instead of going to Autotask.

**Reads by entity (what to cache next).** For each Autotask entity (Invoices,
Tickets, BillingItems…), where its reads were answered over the last 1, 6 or 24
hours:

- **Autotask reads:** sent to Autotask.
- **From cache:** answered by the short-lived read cache.
- **From shadow:** answered by the Postgres mirror.

Each row also shows how the entity is kept locally today: whether it is mirrored
and serving reads, and the read cache's time-to-live for it. It names the tools
or jobs that caused its Autotask reads.

An entity is marked **Candidate to mirror** when it meets all three:
- 50 or more Autotask reads per 24 hours;
- under 50% answered locally;
- not mirrored yet.

Those are the ones worth adding to the shadow next. The table can also be
downloaded as a CSV and is part of the diagnostics bundle.

**Autotask API calls.** Every request sent to Autotask, with its status code and
the tool call or job that caused it.

What the log reads like:

- **401 errors** usually mean the API credentials are wrong. Each 401 shows up
  as two requests, because the MCP retries once after looking up the tenant's
  Autotask address again.
- **429 errors** mean Autotask is throttling the tenant.
- **"No answer"** is a network error or a timeout.

What the log keeps:

- It is held in memory: the last 500 tool calls and 2,000 Autotask calls since
  the server started. A restart clears it.
- Tool arguments and response bodies are **never** recorded. It keeps the tool
  name, caller, result, timings, and a shortened error message.

### Autotask login protection

Autotask **locks an API user** after repeated failed logins. Every client of this
MCP (n8n, cron, ChatGPT) shares that one user, so a lock stops all of them.

What the MCP does when Autotask rejects the credentials (HTTP 401):

1. **It checks it's really the login.** The MCP makes one request that any API
   user can make (Autotask's usage counter). If that request succeeds, the 401 was
   only about one entity the user isn't allowed to see, and nothing is paused.
2. **It pauses.** Every Autotask call for that API user stops at the MCP and
   fails at once with "credentials rejected, calls paused". None of them reaches
   Autotask, so they add no further failed logins.
3. **It tests again later.** When the pause ends, the next call is a **single
   test call**; every other call waits for its answer.
   - If the test call works, normal service resumes.
   - If it fails, the pause starts again, twice as long: 5 → 10 → 20 → 40 →
     60 minutes.
4. **It shows up in the console.**
   - The **Dashboard** shows a red banner with the error, when the pause ends,
     and a **Retry now** button (administrators).
   - `/health` gains an `autotaskAuth` block.

**After a lock:**

1. Unlock the API user in Autotask, or, if the secret changed, update it in the
   env file and recreate the MCP.
2. Press **Retry now**.
3. Watch the **Calls** page: new Autotask calls should show **200**.

**Settings:**
- `AUTOTASK_AUTH_PAUSE_SECONDS` sets the first pause (default `300`).
- `0` turns the protection off; that is not recommended.

### Export (testing and issue tracking)

The **Calls** page has download links:

| Download | Contents |
|---|---|
| **Diagnostics bundle (JSON)** | One file for a support ticket or a bug report: <br>- dashboard status and settings <br>- callers for the last 24 hours <br>- every logged tool call and Autotask call <br>- the server log <br>- for administrators, the console activity log |
| **Tool calls / Autotask calls / Server log (CSV)** | For a spreadsheet |

**Server log tab:** the warnings and errors the server logged since it started
(the last 500). This is the same text `docker compose logs` shows, without
SSH. Fields whose names look like credentials are replaced with
`[redacted]`.

**What exports never contain:** credentials, tool arguments, or response
bodies. Every export is recorded in the activity log.

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
| `AUTOTASK_AUTH_PAUSE_SECONDS` | `300` | First pause after Autotask rejects the API credentials (doubles per repeat, max 60 min); `0` disables. See "Autotask login protection" |
| `MCP_ADMIN_TRUST_PROXY` | `true` | Use `CF-Connecting-IP` / `X-Forwarded-For` for the client IP (throttling, activity log). Set `false` if the port is reachable without a proxy |
