---
title: Introduction
description: What the Autotask MCP Server is, who it is for, and how it is put together.
---

The Autotask MCP Server connects AI assistants and automation to **Kaseya Autotask PSA** through the
[Model Context Protocol](https://modelcontextprotocol.io/). ChatGPT, Claude, n8n — anything that speaks MCP — gets
nearly 300 typed tools for the work an MSP does in Autotask every day.

It runs in production as the automation layer of an Autotask MSP, so most of what sits around the tools exists
because a live tenant needed it: Autotask's API quirks, its shared hourly limit, and clients that sometimes guess.

## Who it is for

- **MSPs on Autotask** who want technicians and managers to ask questions and log work from chat.
- **Automation builders** (n8n, cron, agents) who need reliable, typed Autotask operations with clear results
  and safety gates instead of raw REST calls.
- **Operations / billing** — vendor invoice reconciliation, unbilled work, contract changes, data cleanup.

## How it is put together

| Part | Role |
|---|---|
| **Tools** | Typed operations with validation, ID-to-name enrichment and consistent result shapes. Writes are partial (`PATCH`), risky ones dry-run first. |
| **Postgres layer** (optional, recommended) | A mirror of 18 entities that answers most reads, plus change plans, bulk jobs, the operation log and audit history. |
| **Bulk-job worker** | Pushes approved mass changes to Autotask at a set pace, canary first, respecting quiet hours and tenant usage. |
| **Admin console** (optional) | A small web UI for the people running the server. |

## Where to go next

- [Installation](/autotask-mcp/getting-started/installation/) — Claude Desktop, Claude Code, Docker, production.
- [Safety model](/autotask-mcp/guides/safety/) — what stops a bad write.
- [Tools reference](/autotask-mcp/reference/tools/) — every tool, generated from the code.
- [Prompt examples](/autotask-mcp/examples/overview/) — what to ask.

The project began as a fork of [WYRE-AI/autotask-mcp](https://github.com/WYRE-AI/autotask-mcp) by WYRE Technology
and Aaron Sachs, the baseline this work is founded on. Apache-2.0.
