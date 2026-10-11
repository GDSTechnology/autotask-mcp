# Vendor purchasing & billing reconciliation

Goal: feed in what vendors charge GDS, compare it with what each customer's Autotask contracts bill, and see where we lose money. This is all done from chat, without opening every contract.

Requirements: *GDS Vendor-Agnostic Purchasing, Pricing & Billing Reconciliation v1.0* (2026-10-11).

| Phase | What it does | Status |
|---|---|---|
| **P0a** | Import + identity mappings | **this release** — read-only toward Autotask |
| P0b | Reconciliation: line ↔ contract ↔ contract service ↔ billed units; exceptions; Excel | next |
| P0c | Versioned change plans, row-level approval, verified contract writes, audit, sync-drift | after P0b |

Everything is stored in the MCP's Postgres (migration `0010_vendor_billing.sql`).

## The model: the product, not the sales channel

GDS contracts never mention the vendor. A Pax8 line and an Autotask contract service are matched on the **manufacturer's product** (a *canonical offering*, e.g. `Microsoft | Microsoft 365 Business Standard`) plus the **term** it is sold on. Switching distributor means remapping that vendor's SKUs to the same offerings; contracts, matching and approvals are untouched.

```
vendor line ──SKU──▶ offering ◀──link── Autotask Service (one per term: MM / AM / AA / monthly / annual)
     │                                         ▲
     └─customer──▶ Autotask company ──▶ every ACTIVE contract ──▶ its contract services
```

- **Terms.** MM = monthly commitment, billed monthly. AM = annual commitment, billed monthly. AA = annual, billed annually. Other vendors use plain `monthly` / `annual` / `one_time`.
  - An unstated term stays **unknown**. It is never assumed to be MM.
- **Charge classes.** Every line is kept and classified:
  - `recurring`, `usage` (arrears / metered), `one_time`, `proration`, `credit`
  - `minimum_commitment`, `vendor_fee` (e.g. the card surcharge), `nfr_internal`
- **The vendor's suggested price is reference only.** It is never treated as GDS revenue.

## Step by step (chat)

1. **Import the invoices.** Use `autotask_vendor_import_invoice` with the Pax8 invoice CSV export (Billing → Invoices → export CSV), file name `csv-p<account>-<invoice>-<date>.csv`.
   - Every line is imported, and each customer's subtotal is checked against the one Pax8 printed. *"Every line accounted for"* means they all match.
   - Re-importing the same file is a no-op.
2. **Import the customer crosswalk.** This is the Pax8 company report (PSA admin → Mappings → **Download company report**). It is Pax8's own Pax8-company → Autotask-company mapping, which is not always the same name. For example, *Cathy Sell Real Estate Services, LLC* → **Ben Carter Enterprises**.
3. **Customers.** Run `autotask_reconcile_resolve_mapping kind=customers action=propose`.
   - The crosswalk gives `high` confidence. A crosswalk company that is **inactive** in Autotask drops to `medium`, with a warning.
   - Your own company (id 0) is proposed as `internal`.
   - An exact Autotask name match is `medium`.
   - Anything else is shown as unmatched. It is never guessed.
   - Then run `action=accept` (saves the high-confidence proposals) or `action=set` for individual decisions.
4. **SKUs → offerings.** Use `kind=offerings`. Vendor fees are proposed as `not_billable`.
5. **Autotask services → offerings.** Use `kind=catalog`. Each service's term is read from its name, e.g. *"[NCE] Annual - Billed Monthly"* = AM.
   - A service whose name doesn't state its term is `medium`; confirm the term.
   - Similar names (renames, *Office 365 E5* vs *Microsoft 365 E5*) are only **suggested**. Link them with `action=set`.
6. **Check coverage** with `autotask_vendor_list_sources`, and look at lines with `autotask_vendor_get_lines` (`unmappedOnly: true` shows what still needs a decision).

Every mapping decision is **versioned**: a change supersedes the previous row, recording who decided and when. Nothing in Autotask is written in this phase.

## Adding a vendor

Write an adapter (`src/vendors/<vendor>.ts`, implementing `VendorAdapter`) that turns its invoice format into `VendorLine`s, and register it in `ADAPTERS`. Matching, reconciliation, approvals and reporting need no change.

## Standardizing the Autotask service catalog (change plans)

The goal is **one Autotask Service per product and term**, named to one standard, so every vendor line matches cleanly. This needs migration `0011_change_plans.sql`.

**Naming standard.** The term code goes in the name; the description and invoice description spell it out.

| Name | Description / invoice description |
|---|---|
| `Microsoft 365 Business Standard [NCE] - MM` | Monthly commitment, billed monthly |
| `Microsoft 365 Business Standard [NCE] - AM` | Annual commitment, billed monthly |
| `Microsoft 365 Business Standard [NCE] - AA` | Annual commitment, billed annually (Autotask period: Yearly) |
| `NinjaOne SaaS Backup Standard - Monthly` | Month to month, billed monthly |

**Steps:**
1. `autotask_vendor_prices action=refresh` records the cost and suggested price per SKU and term from the imported invoices. For terms you haven't bought yet, add prices with `action=set` (e.g. from the Pax8 catalog).
2. `autotask_catalog_plan_standardize` builds a **frozen, numbered plan** (id + hash) and writes nothing. For each product we sell and each of its terms (Microsoft NCE: MM / AM / AA; month-to-month products: Monthly):
   - **Keep** the service most active contracts use, and **rename** it to the standard.
   - **Deactivate** duplicates, but only when no active contract uses them. An in-use duplicate is listed and left alone; move those contract lines first.
   - **Create** missing terms from the vendor cost and suggested price, copying a sibling service's work type.
   - **Blocked** rows (shown, never approvable):
     - no price for that term yet;
     - the vendor's suggested price is **below its cost** (set a GDS price);
     - a service whose name doesn't state its term (decide it with `resolve_mapping kind=catalog action=set`).
   - **Catalog price rows** update the service's reference cost and price. They are reference only: **customer contract prices never change here.**
3. `autotask_change_plan_review action=get` shows the rows. Then use `action=approve` with the plan hash and rows (`"all"`, `"3-15"`, `"1,4,7-9"`), or `action=exclude`.
4. `autotask_change_plan_execute planId confirm:true` is **FINANCIAL**. It applies approved rows only, 25 per call.
   - It re-reads each service first. If the service changed since the plan, the row is **stale**: skipped, never overwritten. Rebuild the plan.
   - It writes only that row's fields, then reads back and verifies.
   - Re-running is safe, and an Autotask 401 / 429 stops the run.
   - New and renamed services are linked to their offering automatically.

**Renames** (e.g. Dropsuite → NinjaOne SaaS Backup) work the same way. Link the old services to the new offering (`resolve_mapping kind=catalog action=set`), and the plan renames them to the approved name.

Autotask can't change a service's period (monthly / yearly) after creation, so an AA service must be created as Yearly. A monthly-billed service is never renamed into an AA one.

## Reconciling vendor lines to customer contracts

This needs migration `0012_reconciliation.sql`. Every step below reads Autotask only; nothing changes until a person approves the rows of a change plan.

1. `autotask_reconcile_vendor_to_autotask invoiceNumber=…` matches each vendor line to the customer's contract service for the same product and term, across **all** of that customer's active contracts. Lines are matched by the manufacturer offering, never the sales channel.
   - **Cost Should Be** is the vendor's landed unit cost (quantity-weighted, plus processing fees when the policy allocates them).
   - **Price Should Be** comes from the pricing policy.
   - **Billed** is the posted recurring BillingItem for that month. A loss counts as *confirmed* only when an invoice was posted; otherwise it is *unverified*.
   - The run is saved, and a run with critical rows sends the `reconcile.critical` notification.
2. Exceptions, by severity:

   | Severity | Exceptions |
   |---|---|
   | critical | `below_cost`, `not_billed` |
   | high | `qty_short`, `term_mismatch`, `cost_stale`, `inactive_company` |
   | review | `below_target`, `margin_below_policy`, `negotiated`, `qty_over`, `billed_on_multiple_lines`, `unmapped_customer`, `unmapped_sku`, `proration_credit` |
   | info | `not_customer_billable` (internal / NFR) |

   `autotask_reconcile_get_exceptions` lists them and can update one (status `open` | `acknowledged` | `resolved` | `accepted`, plus an owner and a note). Each update is kept in the exception's history. An exception that comes back in a later run reopens.
3. `autotask_vendor_pricing_policy` sets the policy and is versioned. Policy can be set globally, per manufacturer or per offering:
   - **Modes:** `vendor_suggested`, `margin`, `markup`.
   - **Margin floor:** the lowest margin allowed.
   - **Fees:** `overhead` or `allocate` (allocated fees are spread into the landed cost).
   - **Negotiated prices:** `set_negotiated` records one per customer. A negotiated price always wins and is never changed by a plan.
   - Price Should Be is never below cost.
4. `autotask_reconcile_export_workbook` returns the Excel workbook (`contentBase64`). Its sheets are Executive Summary, Exceptions, All Vendor Lines, Customer Contracts, Unmatched Internal NFR, Approved Changes, Execution Audit and Pricing Policy.
5. `autotask_pricing_build_change_plan` builds a frozen contract plan from the run. The effective date defaults to the 1st of next month. Then use `autotask_change_plan_review` and `autotask_change_plan_execute`, the same as for the catalog. Row types:
   - **Cost:** updates `ContractServices.unitCost`.
   - **Price:** creates a `ContractServiceAdjustments` row with the new unit price. `ContractServices.unitPrice` is read-only in the API.
   - **Quantity:** creates an adjustment with the unit change.
   - **Missing line:** adds the contract service.
   - **Blocked rows:**
     - a negotiated price;
     - the effective date is outside the contract dates;
     - the period has already been invoiced;
     - no standard service exists yet (run the catalog plan first);
     - the customer has no contract to add it to, or more than one (pass `contractChoices`).
   - **Term mismatches** are information only: a person changes the term.
6. `autotask_reconcile_check_sync_drift` re-reads what an executed plan wrote. If something changed it back (for example the Pax8 PSA sync), it records the drift and sends the `sync.drift` notification.

## Pax8 API (optional)

`autotask_vendor_sync` is off until the Pax8 API credentials are set. To set them up, generate an API key in Pax8 under Integrations → Credentials, then set `PAX8_CLIENT_ID` and `PAX8_CLIENT_SECRET` in the server env. The tool then supports three actions:
- `what=invoices` imports invoices through the same parser as the CSV export.
- `what=pricing` records the cost and suggested price for every mapped SKU and term.
- `what=status` shows the configuration.

The CSV export path keeps working without credentials.
