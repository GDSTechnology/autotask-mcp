---
title: Safety model
description: What stops a bad write — partial updates, dry runs, change plans, bulk-job approvals, the read-only switch, login protection and throttling.
---

The server assumes two things: it is connected to a **live production tenant**, and its clients — people and
language models — **sometimes guess**. Every layer below exists because of a real incident or a real API quirk.

## Writes change only what you asked

- **Partial updates.** Typed update tools send `PATCH` with just the fields given. Autotask's `PUT` replaces the
  whole record and **blanks every field left out** — a router once blanked hundreds of tickets' fields that way.
  The typed tools never use it.
- **Name guards.** A company can't be created or renamed to "Gmail", a greeting or marketing text; contacts get
  the same care. Company 0 — the tenant's own company — can't be renamed, reclassified or inactivated.
- **Read-only fields are known.** Fields Autotask silently ignores (e.g. `hoursToBill`, a service line's price)
  are refused with the field you *can* change instead of "succeeding" with no effect.

## Risky changes are reviewed first

- **Dry runs and confirmation.** Destructive and bulk tools default to a dry run and need an explicit
  `confirm` / `dryRun:false`; their descriptions say so, and CI checks that they do.
- **Change plans.** Pricing, contract-line, catalog and merge changes are built as a **plan** with a hash.
  A person reviews it; execution re-checks the hash, is safe to re-run, and can be reverted where the API allows.
  Plans that need the Autotask UI (merges) are turned into numbered UI steps with deep links and verified
  afterwards.
- **Customer notices.** Customer-facing billing changes are held until a price-change notice is recorded.

## Mass changes are paced and approved

[Bulk jobs](/autotask-mcp/guides/bulk-cleanup/) are prepared from the mirror (reads only), approved **by hash** by a
person, run a **50-record canary** and pause for a check, then a background worker writes at a set pace — slower in
business hours, nothing in **quiet hours**, half pace from 40% tenant usage and a stop from 65%. Records with
history are excluded, and every email address is checked tenant-wide so real people are kept.

## The tenant is protected

- **Read-only switch** in the console stops every write — tool calls and background jobs alike.
- **Login protection.** A rejected login pauses all calls; after two failed test logins the tenant is **held**
  until an administrator presses *Retry now*. A wrong secret can't lock the API user by retrying.
- **Throttling.** A 429 starts a local cooldown instead of a retry storm; concurrency per endpoint is capped;
  background work yields first. See [Throttling](/autotask-mcp/guides/throttling/).

## Everything is accounted for

- **Operation log.** Every write is recorded per tool call — tool, caller, the records it touched — with durable
  idempotency keys so a retried call never writes twice.
- **Actors.** Ticket history and the activity feed classify who made a change — a person, an integration, this
  MCP, or the system — so automation is never counted as a technician's work.
