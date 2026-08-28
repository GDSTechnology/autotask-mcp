# Integration cheatsheet (n8n / Hermes / ChatGPT)

Practical notes for calling the Autotask MCP from an automation. Covers the tool
result shape, caller identity, the safety gates, and the gotchas that bite
first-time integrators. Generic — no tenant-specific values.

## Tool result shape

Every tool returns MCP content whose `text` is a JSON envelope. Parse it and read
`data`:

```js
const payload = JSON.parse(result.content[0].text); // { message, data }
const data = payload.data;
```

- **Success:** `data` is the record, an array, or a create result (below).
- **Control outcomes:** `data.status` is set — check it before treating a call as
  success. See [Control outcomes](#control-outcomes).
- **Errors:** the envelope carries `error` (and `tool`); the result may set
  `isError: true`. Rate-limit errors set `error_type: "rate_limited"` — **do not
  retry**, narrow the query instead.

## Create results — one shape for everything

Every create tool normalizes to:

```json
{ "id": 12345, "entityType": "contact", "parentType": "Companies", "parentId": 678 }
```

Read `data.id`. Don't special-case `itemId` vs `item.id` vs `item` — that's handled
server-side. **Trust the returned `id`; don't immediately GET the record back** to
"confirm" it — Autotask is eventually consistent and a read-after-create can 404
briefly even though the create succeeded. If you need the full record, fetch it on
the next step, not in a tight loop.

## Child-route entities

Some entities are created through their parent and **require the parent id**:
contacts (`companyID`), ticket/task/project notes, ticket charges, time entries,
to-dos, quote items, checklist items. The MCP uses the correct child route
internally — you just supply the parent id. For contacts specifically,
`autotask_create_contact` **requires `companyID`** and returns `{ id }`; root
contact creation is not used (some zones reject it).

## Caller identity — pass `_context`

The Autotask API user is only the transport identity, not the person acting. Pass
per-request caller context so the server can audit, resolve "act as me", and (when
enabled) apply permissions. Use the MCP request `_meta`, or a reserved `_context`
argument on any tool call:

```json
{
  "_context": {
    "source": "hermes-teams",          // chatgpt | hermes-teams | telegram
    "requestingUserEmail": "jane@corp.com",
    "conversationId": "conv-42",         // enables safe idempotent retries
    "idempotencyKey": "optional-explicit-key",
    "intent": "create time entry"
  },
  "...tool args...": "..."
}
```

`_context` is stripped before the tool runs. `autotask_whoami` resolves the caller
to an Autotask resource; if it can't map them it returns
`status: "user_identification_required"` — surface the prompt and ask the human,
don't guess.

### Act-as-me (proxy input)

For tools that write a resource field (time entries, to-dos), pass
`currentUser: true` instead of a resource id and the server fills in the caller's
resource. If the caller can't be mapped you get the identity prompt above.

## Control outcomes — always check `data.status`

| `data.status` | Meaning | What to do |
|---|---|---|
| `confirmation_required` | A destructive/financial mutation needs explicit sign-off | Re-call with `confirm: true` once the human approves |
| `permission_denied` | Caller's role can't perform this (when permissions are enabled) | Surface the reason; escalate to an authorized user |
| `user_identification_required` | Caller couldn't be mapped to a resource | Ask the human who they are; cache the answer |
| `raw_request_denied` | `autotask_raw_request` blocked by policy | Use a typed tool; raw is admin-only / DELETE-gated |

## Confirmation gate

Financial and destructive tools (contract/quote/charge writes, every `delete_*`)
require `confirm: true`. Without it you get `confirmation_required` and **nothing
runs**. Automated flows that are pre-authorized simply include `confirm: true`;
interactive assistants show the message to the human first.

## Idempotency (safe retries)

Mutations are de-duplicated when they carry a key. Provide an `idempotencyKey` in
`_context`, or just pass a stable `conversationId` — a repeated identical call
replays the prior result instead of creating a second record. With neither, two
identical calls both run. Give retried steps the same key/conversation so a
network blip doesn't double-book a ticket, note, or time entry.

## "Already processed by automation" gates

When a workflow must not re-touch a record it already handled, gate on a
**deterministic marker**, never a fuzzy title match:

- Write a note with a **unique, structured title prefix** no human would type
  (e.g. `myflow:triage:v1 – …`), and/or a hidden token in the body, and/or a UDF.
- Detect prior processing by **`createdByResourceID === <your automation's API
  user>` AND `title.startsWith("<your prefix>")`** — match the **prefix**, not an
  exact title, so variants still count.
- This cleanly separates your notes from staff notes and Autotask Workflow-Rule
  notes (which use different note types and creators).

Fuzzy title matching collides with staff notes and either blocks first-touch or
causes duplicate touches.

## Reference resolution

Read/lookup tools accept ids, entity display numbers (e.g. `T20260827.0108`),
emails, and names. Ambiguous references come back as a short candidate list rather
than a guess — present the choices, don't pick blindly. `autotask_router` maps a
free-text intent to a suggested tool.

## Rate limits

On HTTP 429 the server returns a typed `error_type: "rate_limited"` envelope with
`retry_after_seconds` and enters a short fail-fast cooldown. **Do not auto-retry.**
Narrow the request (filter by date range, company, or id) and pace bulk work;
prefer specific lookups over broad scans.

## Quick gotcha list

- Parse `result.content[0].text` as JSON; the payload is in `.data`.
- Check `data.status` before assuming success.
- Contacts need `companyID`; trust the returned `id`, skip the read-after-create.
- Pass `_context` (source + requesting user + conversation) on every call.
- `confirm: true` for financial/destructive tools.
- Same `idempotencyKey`/`conversationId` on retries.
- Deterministic note markers for "already processed" gates.
- Don't retry on `rate_limited` — narrow and pace.
