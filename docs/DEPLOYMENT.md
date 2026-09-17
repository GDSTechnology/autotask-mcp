# Deployment & caller-container attribution

How to answer "which container is making this request?" on a shared server, and
how impersonation is scoped per deployment.

## The three attribution signals

Every audit record now carries up to three independent signals, most-trusted
first:

| Field (audit log)        | Source            | Trust | Set by |
|--------------------------|-------------------|-------|--------|
| `instanceLabel`          | operator env      | high  | `MCP_INSTANCE_LABEL` on the container |
| `originRemoteAddr` / `originForwardedFor` / `originUserAgent` | transport | medium | captured server-side from the HTTP request |
| `source`                 | client `_meta`    | low   | the calling app declares it (`chatgpt`, `hermes-teams`, `n8n`, `cron`, …) |

- **`instanceLabel`** is the reliable answer to "which of my containers": the
  operator sets it per compose service, so it can't be spoofed by a caller.
- **origin** is what actually connected — the peer address (an internal Docker
  IP on the compose network, or a tunnel address), the first `X-Forwarded-For`
  hop a tunnel/proxy adds, and the `User-Agent`. Captured automatically; no
  config. Logged, never used for authorization.
- **`source`** is what the client *says* it is. Useful, but only as trustworthy
  as the caller — which is why impersonation is gated by instance, not by source.

`impersonationMode` is also recorded on every entry so you can see the posture
the serving instance enforced.

## Impersonation posture — per instance

Set `AUTOTASK_IMPERSONATION_MODE` on each container:

| Mode      | Behaviour |
|-----------|-----------|
| `off` (default) | Never impersonate. Writes are attributed to the integration (API) user. Use for n8n / cron / any unattended automation. |
| `caller`  | Resolve the calling user (from `requestingUserEmail` / bound identity) and tunnel writes as them via `ImpersonationResourceId`. Degrades to the integration user when the caller can't be identified — never blocks. Use for the ChatGPT / Teams instance. |
| `gateway` | Impersonate **only** from the trusted, S2S-verified gateway header (`x-acting-resource-id` / `x-acting-user-email`). The client payload never selects the acting user. Use behind the conduit gateway. |

Legacy `AUTOTASK_IMPERSONATION=on` (no mode set) maps to `caller`; unset maps to
`off`. Native impersonation also requires the API user's Autotask security level
to permit it.

Optional, `caller` mode only: `AUTOTASK_IMPERSONATION_SOURCES` is a
comma-separated allowlist of declared sources permitted to impersonate on a
shared instance (e.g. `chatgpt,hermes-teams`). Unset = all sources allowed.
Belt-and-suspenders on top of instance isolation.

## Recommended topology: one instance per consumer class

Rather than sniff the network to tell consumers apart, isolate them by instance.
See [`deploy/docker-compose.prod.yml`](../deploy/docker-compose.prod.yml):

- `autotask-mcp` (`:18080`) — n8n + cron. `AUTOTASK_IMPERSONATION_MODE=off`,
  `MCP_INSTANCE_LABEL=n8n-cron`. Physically cannot impersonate.
- `autotask-mcp-gpt` (`:18081`) — ChatGPT + Teams.
  `AUTOTASK_IMPERSONATION_MODE=caller`, `MCP_INSTANCE_LABEL=gpt-teams`.

"Which container" = which port received it, and the security boundary is set by
config, not by a spoofable field.

## Rollout on the server (MA-BOS-S-KVM1)

Commands below run **on the KVM host**, in the compose project directory.

1. Add the second service and the new env keys to the live `docker-compose.yml`
   (model it on `deploy/docker-compose.prod.yml`), keeping the existing
   `autotask-mcp` service but adding `MCP_INSTANCE_LABEL` and
   `AUTOTASK_IMPERSONATION_MODE=off` to it.
2. Pull the release that carries per-instance mode (>= 3.2.0) and start:

   ```bash
   docker compose pull
   docker compose up -d
   ```
3. Point the ChatGPT connector / Teams relay at `:18081`; leave n8n and cron on
   `:18080`.
4. Verify attribution — each instance stamps its label:

   ```bash
   docker compose logs -f autotask-mcp-gpt | grep '"audit":true'
   ```
   You should see `instanceLabel`, `impersonationMode`, and the `origin*` fields
   on each call.

To validate write-attribution end-to-end you need a real POST from the
identified user (the read-only test account can't write); confirm the created
record's `createdByResourceID` is the impersonated user, not the API user.
