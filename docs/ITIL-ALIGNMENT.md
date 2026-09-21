# Autotask ITIL / ITSM Alignment Framework

> **What this is:** A tenant-agnostic guide to configuring **any Autotask PSA instance**
> to align with ITIL 4 / ITSM, and to using this MCP as the layer that *enforces and
> measures* that alignment.
>
> **What this is not:** Tenant-specific configuration. All numbers below (SLA targets,
> priority names, service hours) are **ITIL-typical starting templates** — tune them to
> the deployment. Nothing here assumes a particular customer, tenant, or dataset.
>
> **The core split:** Autotask keeps the definitions that matter most — priorities, SLAs,
> business hours, SLA→contract links — as **UI-only** configuration. The API (and
> therefore this MCP) can *read, enforce, and measure* them, but cannot *create* them.
> Plan the definition work as UI work; plan the MCP as the instrument
> (see [Appendix A](#appendix-a--autotask-configuration-surface)).

---

## How Autotask maps to ITIL out of the box

Autotask is already ITIL-shaped in one important place and silent in others. Knowing which
is which tells you where the configuration effort goes.

| ITIL concept | Autotask mechanism | Native? |
|---|---|---|
| Incident / Request / Problem / Change | `ticketType` (native values) | ✅ Present |
| Priority | Single `priority` picklist | ⚠️ Present but usually needs restructuring |
| Impact / Urgency | *No native field* | ❌ Encode the result into priority (see §2) |
| SLA targets | First-response / resolution-plan / resolution due-date fields | ⚠️ Fields exist; targets must be defined |
| Service hours | Internal Info / business-hours config | ⚠️ Must be defined |
| Queues / workflow | Queues, statuses, workflow rules | ✅ Present, configurable |

The pattern across most Autotask tenants: **types are fine, priority is a mixed bag, and no
SLA is defined**. This framework addresses all three.

---

## 01 · Ticket classification

ITIL splits demand into distinct **practices** because they have different goals, owners,
and clocks. Autotask's `ticketType` maps to them almost one-to-one. The rule: **every
ticket gets the right type at intake**, and type drives the workflow that follows.

| Type | `ticketType` | Goal | Signal |
|---|---|---|---|
| **Incident** | 2 | Restore service fast, even with a workaround | "It's broken / down / slow." Tight SLAs live here |
| **Service Request** | 1 | Fulfil predictably from the catalog | Onboarding, access, new device, "how do I…" |
| **Problem** | 3 | Eliminate recurrence (root cause) | Internal investigation; links to the incidents it explains |
| **Change Request** | 4 | Change safely, with approval | Firewall rule, migration, planned upgrade |
| **Alert** | 5 | Triage to an incident or auto-close | RMM/monitoring signal; must be filtered, never queued raw |

An **Incident** and a **Service Request** are not the same thing and must never share a
clock. If the type is wrong at intake, every metric downstream is wrong.

> **Enforce it:** Autotask's out-of-box types match ITIL, but a tenant rarely *enforces*
> them. Make `ticketType` required on intake forms, and set per-channel defaults
> (email-to-ticket, portal, RMM) so alerts and requests don't all land as generic tickets.

---

## 02 · Priority — from an ad-hoc list to Impact × Urgency

ITIL derives priority from **Impact** (how much is affected) and **Urgency** (how fast it
needs fixing). Autotask has no impact/urgency fields, so you encode the *result* of the
matrix as a clean four-level priority picklist. Dispatch runs the matrix; the ticket stores
the answer.

### The matrix

| Impact ↓ \ Urgency → | High (urgent) | Medium | Low (can wait) |
|---|:---:|:---:|:---:|
| **High** (site / all users) | **P1** | **P2** | **P3** |
| **Medium** (team / many) | **P2** | **P3** | **P4** |
| **Low** (one user) | **P3** | **P4** | **P4** |

### Auditing an existing priority picklist

Most tenants inherit a priority list that has drifted — it mixes three different concepts
into one field. Before adopting P1–P4, sort every existing value into one of these buckets:

| If the value expresses… | It is not priority — move it to… |
|---|---|
| **Severity** (Critical / High / Medium / Low) | Keep — this maps to **P1–P4** |
| **Response time** (e.g. "Same Day", "Next Day") | The **SLA**, not the priority (see §3) |
| **Work type** (e.g. "Repairs", "Install") | Issue/Sub-issue or a **Queue** |
| **Planned work** (e.g. "Scheduled Maintenance") | `ticketType` = **Change** |

Collapse the severity values into P1–P4 and relocate the rest. Keep old values live until
open tickets are migrated, then retire them so new tickets can't pick them.

> **UI-only:** The priority picklist can't be rewritten via the API. Do this in
> **Admin → Features & Settings → Service Desk → Priorities**.

---

## 03 · SLA targets (template)

Autotask tracks three SLA clocks per ticket — **First Response**, **Resolution Plan**, and
**Resolution**. Set a target for each, per priority. The table below is an ITIL-typical MSP
**starting template** — replace every value with what the deployment can actually commit to.

**Incidents** (business hours unless noted):

| Priority | First response | Resolution plan | Resolution / restore | Coverage |
|---|---|---|---|---|
| **P1 Critical** | 15 min | 1 hour | 4 hours | 24×7 |
| **P2 High** | 30 min | 4 hours | 8 bus. hours | Business hrs |
| **P3 Medium** | 1 hour | 8 bus. hours | 3 bus. days | Business hrs |
| **P4 Low** | 4 bus. hours | 1 bus. day | 5 bus. days | Business hrs |

**Service Requests run on the catalog, not this matrix.** Each catalog item carries its own
agreed fulfilment time (e.g. new-hire setup = 3 business days). Reserve the aggressive
clocks above for *Incidents*, where speed is the whole point.

> **Tip:** Set targets against *observed* performance, not aspiration. Pull your actual
> first-response and resolution medians first (this MCP's SLA report surfaces them even when
> no targets are configured), then set targets you can defend.

> **UI-only:** SLA records and their contract links are defined in
> **Admin → Service Desk → Service Level Management**, then attached to each contract. Once
> attached, Autotask auto-populates `firstResponseDueDateTime` / `resolvedDueDateTime`, and
> this MCP's SLA compliance report measures against real targets instead of just actuals.

---

## 04 · Service hours & customer tiers

An SLA clock is meaningless without defined hours-of-operation and a way to differentiate
what each customer is entitled to.

- **Define business hours & holidays** so "8 business hours" is computed correctly across
  evenings, weekends, and holidays — not wall-clock time.
- **Tie coverage to the contract.** A managed-services customer's P1 might get 24×7; a
  break-fix customer's P1 gets business-hours. The contract's SLA carries this — don't bake
  it into priority.
- **Use SLA per tier, not per ticket.** Create a small number of SLAs (e.g. *Managed 24×7*,
  *Managed Business-Hours*, *Break-Fix*) and assign the matching one to each contract,
  rather than hand-tuning tickets.
- **Keep priority customer-agnostic.** P1 always means the same severity; the *response you
  owe* for that P1 comes from their tier. This keeps reporting comparable across the book.

---

## 05 · Queues, assignment & escalation

ITIL's tiered support model maps onto Autotask queues and workflow rules. The aim: a
ticket's *type + priority* routes it automatically and escalates **before** an SLA breaches.

- **Route by type & skill** — queues for Triage → Tier 1 → Tier 2/Field → Projects. Alerts
  land in a triage queue and are promoted to Incidents; they never sit in a human queue raw.
- **Escalate before breach** — workflow rules that fire at ~75% of the response clock
  (notify a lead, bump the queue) so a P1 gets eyes before the target passes, not after.
- **Close the loop on service calls** — a common Autotask trap: an open service call keeps a
  ticket effectively live, and changing the ticket owner can cascade onto the open service
  call (reassigning or clearing it). Auto-complete the service call when the ticket completes
  (**never delete**) so time entries and assignment stay intact.
- **One owner, always** — every ticket has a single accountable resource at every moment.
  Unassigned or shared-ownership tickets are where SLAs quietly die.

> **Note:** Workflow rules and notification templates are configurable in the UI and
> partially via API. This is the one area where the MCP can help drive setup — but the
> SLA/priority definitions it enforces must exist first.

---

## 06 · Problem, Change & Knowledge

The ITIL practices most service desks skip — and the ones that stop the same fire being
fought twice. None needs new Autotask fields; they need the existing types used with
discipline.

- **Problem management** — when the same incident recurs, open a **Problem** and link the
  incidents to it. Track root cause and permanent fix separately from the firefight. Success
  metric: *fewer repeat incidents*, not faster ones.
- **Change enablement** — environment changes run as **Change** tickets through a lightweight
  approval (a standard / normal / emergency split suits most teams). A change that causes an
  incident should be visible as the cause.
- **Request catalog** — standardize common Service Requests (onboarding, offboarding, access,
  new device) as catalog items with fixed steps and fulfilment times. Predictable requests
  stop competing with incidents for attention.
- **Knowledge management** — every resolved Problem and repeated request leaves a knowledge
  article behind. Tier 1 resolving more at first touch is the payoff — and it directly
  improves first-response SLA compliance.

---

## 07 · Measure & improve (CSI)

ITIL's Continual Service Improvement is a loop: measure against the targets you set, review,
adjust. Once §2 and §3 are configured, these become real KPIs instead of vanity numbers —
and this is where the MCP reporting layer plugs in.

| KPI | What it tells you | Target signal |
|---|---|---|
| SLA compliance % | Are we keeping the promises we set | ≥ 95% per priority |
| First-response time | Triage responsiveness | Within priority target |
| First-contact resolution | Tier-1 effectiveness / knowledge quality | Trending up |
| Reopen rate | Are we closing too early | Trending down |
| Repeat-incident rate | Whether Problem mgmt is working | Trending down |
| Backlog age by priority | Where SLAs are about to breach | No aged P1/P2 |

> **How the MCP fits:** It computes SLA compliance, response/resolution actuals, and breach
> queues from live ticket data. With no SLA targets configured it reports *actuals* only;
> the moment SLAs are defined (§3), the same report becomes a true compliance scorecard —
> no code change needed. Reporting is designed to be driven outside the MCP (e.g. via n8n)
> with the MCP as the Autotask REST handler.

---

## 08 · Adoption roadmap

Sequenced so each phase makes the next one measurable. This is genuinely ordered — don't set
SLAs before the priority scheme is clean, or you'll be measuring against a moving target.

1. **Phase 1 · Foundation — Fix the taxonomy.** Rebuild the priority picklist to P1–P4 and
   migrate open tickets (§2). Make `ticketType` required at intake with per-channel defaults
   (§1). *Effort: low · UI config · biggest single payoff.*
2. **Phase 2 · Commitments — Define SLAs & service hours.** Build the tiered SLAs, set
   business hours/holidays, attach an SLA to every contract (§3, §4). Due-date fields start
   populating automatically. *Effort: medium · UI config + contract review.*
3. **Phase 3 · Flow — Route & escalate.** Queue structure, assignment rules, pre-breach
   escalation, and the service-call close-out fix (§5). *Effort: medium · workflow rules.*
4. **Phase 4 · Maturity — Problem, Change & Catalog.** Problem linking, lightweight change
   approval, top service-request catalog items (§6). *Effort: medium · process + light config.*
5. **Phase 5 · Improve — Review cadence.** Weekly SLA/backlog review, monthly KPI review,
   quarterly SLA re-tune. Reports come from the MCP layer (§7). *Effort: ongoing · the CSI loop.*

---

## Appendix A · Autotask configuration surface

The parts of ITIL that matter most here are **defined by hand in the Autotask UI**. The API
(and therefore this MCP) can read and enforce them, but cannot create them. Plan the
definition work as UI work.

| Element | Where it's set | API / MCP can… |
|---|---|---|
| Priority picklist | UI only | Read & report; not create values |
| SLA definitions | UI only | Read due-dates & measure compliance |
| SLA → contract link | UI only | Read the link |
| Business hours / holidays | UI only | — |
| Ticket types | Native (present) | Read & set on tickets |
| Queues / statuses | UI (values) | Read & route tickets |
| Workflow & notification rules | UI · partial API | Read; drive some automation |
| Ticket type / priority on a ticket | API-writable | Read & write freely |

**Bottom line:** This MCP *enforces and measures* ITIL; it can't *define* it. This framework
is the human/UI side of that split — do the configuration in Autotask, and the MCP's
classification, SLA, and P&L reporting all light up against real targets.
