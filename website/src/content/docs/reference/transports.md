---
title: Transport Reference
description: Available transport options for connecting to the MCP server.
---

PSArelay supports two transport mechanisms for communicating with MCP clients.

## stdio (Default)

The standard transport for local MCP clients. Communication happens over stdin/stdout using JSON-RPC messages.

### Configuration

```json
{
  "mcpServers": {
    "psarelay": {
      "command": "npx",
      "args": ["-y", "github:GDSTechnology/psarelay"],
      "env": {
        "AUTOTASK_USERNAME": "...",
        "AUTOTASK_SECRET": "...",
        "AUTOTASK_INTEGRATION_CODE": "..."
      }
    }
  }
}
```

### When to use

- Claude Desktop or other local MCP clients
- Single-user setups
- Development and testing

## HTTP (Streamable)

An HTTP-based transport that serves the MCP protocol over a web server. Supports multiple concurrent clients.

### Configuration

Set environment variables:

```bash
MCP_TRANSPORT=http
MCP_HTTP_PORT=8080      # Default: 8080
MCP_HTTP_HOST=0.0.0.0   # Default: 0.0.0.0
```

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/mcp` | POST | MCP protocol endpoint (JSON-RPC) |
| `/health` | GET | Health check |

### Health Check Response

```json
{
  "status": "ok",
  "version": "3.87.0",
  "mcpTransport": "http",
  "authMode": "env",
  "timestamp": "2026-10-24T13:35:53.409Z",
  "apiUsage": { "upstreamLastHour": 483, "upstreamLastFiveMinutes": 45, "savedPct": 26.1, "rateLimited": 0, "cacheEnabled": true },
  "shadow": { "enabled": true, "serveReads": true, "lastRunAt": "2026-10-24T13:34:06.691Z", "lastRunCalls": 15 },
  "admin": { "enabled": true, "running": true, "port": 8090, "schemaReady": true },
  "backpressure": { "level": "ok", "reasons": [], "retryAfterSeconds": null, "usedPct": 18.1 }
}
```

`version` is the running release; `apiUsage` is this server's own Autotask traffic; `backpressure` is the
same ok / slow / stop verdict as `autotask_get_backpressure`, with the tenant's latest API usage (`usedPct`).

### When to use

- Remote or shared deployments
- Multi-client access
- Container/Docker deployments
- Load-balanced environments

### Example: Docker deployment

```bash
docker run -d \
  -e AUTOTASK_USERNAME=user@example.com \
  -e AUTOTASK_SECRET=secret \
  -e AUTOTASK_INTEGRATION_CODE=code \
  -e MCP_TRANSPORT=http \
  -e MCP_HTTP_PORT=8080 \
  -p 8080:8080 \
  ghcr.io/gdstechnology/psarelay:latest
```

### Session Management

The HTTP transport uses session IDs to track client connections. Each client receives a unique session ID on first connection, which is included in subsequent requests for continuity.
