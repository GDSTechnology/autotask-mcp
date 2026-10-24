# Safe company and contact merges

Duplicate companies and contacts are merged with **Autotask's own merge in the web UI**, then the old record is deleted in **Admin**. Autotask's REST API has no merge endpoint, and Companies can't be deleted through it, so the MCP never imitates a merge with a series of updates.

The MCP does everything around the merge:

1. **Finds** the duplicates.
2. **Inventories** what is attached to each record.
3. **Builds an ID-only work list** of UI steps, with direct links.
4. **Verifies** afterwards that the old record is gone and nothing was left on it.

## The rules

- **Numeric IDs only.** A company merge is `survivorCompanyId` + `sourceCompanyIds`; a contact merge is `survivorContactId` + `sourceContactIds`. Names, emails and searches find *candidates*; they are never accepted as a merge identifier.
- **One kind per plan.** A company merge never merges contacts. The contacts on the merged companies get their own contact plans, after review.
- **Same email ≠ same person.** Two contacts sharing an address are candidates; a person confirms.
- **Never choose the survivor automatically.** Discovery gives *hints* (real, active, oldest). The survivor must be a real, active record, never a placeholder like "Gmail" or "Unknown Contact".
- **Fail closed:** the plan is refused for
  - unknown, repeated or zero IDs;
  - a survivor listed among its own sources;
  - a chain (A→B while B→C);
  - an ID that isn't that kind of record.

## Step by step

### 1. Discover: `autotask_merge_discover` (read-only)

Search by `email`, `name` (exact company name, e.g. `"Gmail"`), `companyIds` or `contactIds`.

- **Email** searches all three contact email fields, active and inactive, every page: no 200 cap.
- **Totals** are exact: contacts, companies, active, placeholders, and companies with one contact.
- **Who and when:** who created the records (`createdByResourceID` → name), and on which days, with the first and latest creation dates. Use this to find the integration or workflow that is creating duplicates.
- Each company comes with its contact ids and a deep link.

### 2. Inventory: `autotask_merge_dependency_inventory` (read-only)

Per company or contact id, this lists every record pointing at it:

- **For a company:** contacts, tickets, projects, contracts (active ones counted), opportunities, quotes, sales orders, configuration items, service calls, notes, to-dos, locations, alerts, invoices and billing items, and child companies.
- **For a contact:** tickets, projects, contracts, opportunities, quotes, configuration items and to-dos.

It also says whether the API could change each link, read from live field info. **Blockers** need a person first:
- active contracts (billing review);
- financial history;
- the record is the parent of other companies;
- anything that couldn't be checked.

### 3. Plan: `autotask_merge_build_plan`

Two ways to give it the IDs:

- **One merge:** `{ entityType: "company", survivorCompanyId, sourceCompanyIds: [...] }`. For contacts, use `entityType: "contact"` with the contact fields.
- **A batch from a CSV:**
  - `csv` takes two columns per line, **old id, correct id**, with an optional header.
  - Several old ids may point at the same correct id.
  - `mappings: [{ sourceId, survivorId }]` works the same way.

The plan is a **work list** saved with a hash. For each source, it lists:

1. **MERGE #source → #survivor** in the Autotask UI, with links to both. This step is *blocked* while the source has active contracts, until you rebuild with `billingReviewed: true`.
2. **DELETE #source in Admin**, only after the merge and once verify shows nothing left on it.
3. **Suggestions:** survivor fields that are empty and that a real source could fill. They are never applied automatically, and placeholder values are never proposed.

`autotask_change_plan_review` shows the plan. `autotask_change_plan_execute` **refuses** it, because nothing in a merge plan is written by the MCP.

### 4. Do it in Autotask

1. Open each pair from the links.
2. Merge the source into the survivor.
3. After verify confirms nothing is left on the source, delete it in Admin.

### 5. Verify: `autotask_merge_verify { planId }`

This re-reads every survivor and source, and everything that pointed at the sources. Per source:

| Result | Meaning |
|---|---|
| **gone** | Merged and deleted: done |
| **nothing left, still there** | Delete it in Admin |
| **records still attached** | Not merged yet, or the merge left them (listed per entity) |

- Verify **fails** if a survivor is missing or inactive (merged the wrong way round?).
- It marks the plan's steps as done and returns `passed`, `partial`, `not_started` or `failed`.
- Deactivating a record is never reported as a merge.

## Placeholder records and prevention

A record is treated as a placeholder when its name is:
- a webmail provider: `Gmail`, `Yahoo`, `Outlook`…;
- a greeting or marketing text;
- `Unknown…`, `N/A` or `None`.

- **Guard on creation:** `autotask_create_company` and `raw_request` writes to `/Companies` refuse to create (or rename to) a company with such a name.
- **Consumer domains:** a consumer email domain never identifies a company.

Before cleaning up a burst of placeholders, find and stop whatever creates them. Discovery reports the creating resource and the dates for exactly that.

## Bulk cleanup of placeholder companies: `autotask_bulk_inactivate`

For junk at scale (tens of thousands of "Gmail" companies, each with one "Unknown Contact"), merging by hand isn't possible. This tool stages the cleanup in Postgres and pushes it to Autotask at a set pace. No chat ever loops thousands of writes.

1. **Prepare:** `action: "prepare", companyName: "Gmail"`. You can narrow it with `createdByResourceId`, `createdFrom` and `createdTo`.
   - The name must be a placeholder name; a real company is never targeted.
   - Runs in the background. Companies and contacts are read page by page from the mirror.
   - **History check:** tickets, projects, contracts, opportunities, quotes, sales orders, configuration items, service calls, invoices, billing items and child companies. Other entities are read at the job's pace.
   - A company with history, or with a contact who has a real name, is **excluded**. Those go to the UI merge.
   - **Email safeguard** (personal mail is what real people use too): every address on those contacts is checked across the whole tenant. A ticket on **any** contact with that address keeps its placeholder companies (excluded); so does an address listed in `excludeEmails` (console: "Keep these email addresses"). An address that also belongs to a contact on a **real** company is a duplicate: the placeholder copy is inactivated, the real contact is never touched. The job card's **Email addresses** table (`stats.emailReview`) shows each address, its copies, the decision and why, kept ones first: review it before approving.
   - A history check that can't run **fails the preparation**; it never counts as "no history".
   - **Throttling is not a failure:** a read that gets HTTP 429 (the tenant's hourly limit used up, e.g. another integration's burst) waits a minute and is retried, for up to 3 hours in all. The job shows "Waiting: … continues by itself after HH:MM UTC" meanwhile.
2. **Review:** `action: "status"` shows the counts, exclusions by reason (`action: "excluded"` lists them), the writes, and an ETA.
3. **Approve** with the job's hash. The hash binds the exact records to be written. A person approves on the console's **Bulk jobs** page (Approve, Start, Pause, Resume, Retry failed, Cancel, with progress and record lists). The tool's `action: "approve"` does the same for clients allowed to.
4. **Start:** `action: "start", confirm: true` is required.
   - The worker inactivates **each active contact, then its company**, one write at a time.
   - It runs the **canary** first (default 50) and pauses so you can check the records in Autotask. Then you **resume**.
5. **Pace:**
   - **Off hours:** `ratePerHour` (default 3,000).
   - **Business hours:** `businessRate` (default 1,000/hour), during `businessHours` (default Mon–Fri 07:00–19:00 America/New_York; `false` turns it off).
   - `action: "activity"` shows when the team works (time entries and ticket notes by people, per local hour, last 28 days, from the mirror) and suggests the window.
   - **Quiet hours:** no writes at all in these local hours (default **00:00–04:00 and 21:00–22:00**, `quietHours: "0-4, 21-22"`; `"none"` for none): another integration's burst window. Autotask's *API Activity By Hour* report (Admin → Extensions & Integrations) shows which integration uses which hours. Jobs prepared before quiet hours existed get the defaults.
   - While writing, the worker takes a fresh tenant-usage reading **every minute** (60 calls/hour), so a burst from another integration is seen within a minute.
   - Tenant usage from **40%** halves the pace; from **65%** it waits (`MCP_BULK_SLOW_AT_PCT` / `MCP_BULK_STOP_AT_PCT`). A 429 cooldown, a login pause and the console's read-only switch also stop it. It resumes by itself.
6. **Pause conditions:** a login problem, 20 failures in a row, or `action: "pause"`. A 429 (Autotask throttling) is not a failure: the record stays pending with no attempt used, and the worker waits out the cooldown plus a minute. Failed items are listed (`action: "failed"`) and can be re-queued (`action: "retry_failed"`).
   - The job continues after a server restart.
   - A preparation interrupted by a restart is marked failed; prepare it again.

Inactivated records stay in Autotask (Companies can't be deleted through the API). For a purge, ask Kaseya support with the job's company list.

### Junk contacts on one real company: `companyId`

A real customer account can also collect contacts that don't belong to it (spam senders, webmail addresses, a mail lane that filed everyone under one account). Same tool, same approval and pacing, one company:

1. **Prepare:** `action: "prepare", companyId: <id>`, then either:
   - `contactIds: [...]`: exactly these contacts (every id must be on that company), or
   - the **domain rule**: every active contact whose email domain is not the company's own. The company's own domains are its web address, `keepDomains`, and the (non-webmail) domains of contacts with history. Narrow it with `onlyDomains` (e.g. `["gmail.com"]`), `createdFrom` / `createdTo`. Contacts with no email are kept unless `includeNoEmail: true`.
2. **Always excluded:** the primary contact, and contacts with projects, contracts, opportunities, quotes, configuration items or to-dos. Contacts on **tickets** are excluded too, unless `ticketsOk: true` (a spam sender is usually the contact on its own spam tickets; inactivating it leaves the tickets as they are). Without `ticketsOk`, a junk domain with tickets is treated as the company's own, so check `stats.companyDomains`.
3. **Review:** `action: "status"` → `stats.byDomain` (per domain: inactivate / kept / excluded / already inactive) and `stats.companyDomains` (what was kept as the company's own, and why). The console shows both on the job card.
4. **Approve, start, canary** (default 25), **pace**: as above. Only contacts are written; the company is never touched.

Company 0 (your own company) is refused.

## Not yet

- Moving links of placeholder records (the API marks a contact's company read-only; only the UI merge moves contacts).
- Bulk progress tracking beyond the plan's steps.
- Search-before-create locks for the integrations that create contacts.
