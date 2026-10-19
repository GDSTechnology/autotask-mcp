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

## Not yet

- API consolidation of placeholder records with no history (moving links, then inactivating).
- Bulk progress tracking beyond the plan's steps.
- Search-before-create locks for the integrations that create contacts.
