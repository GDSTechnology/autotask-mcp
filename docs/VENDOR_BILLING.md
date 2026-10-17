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
2. **Import the customer crosswalk.** This is the Pax8 company report (PSA admin → Mappings → **Download company report**). It is Pax8's own Pax8-company → Autotask-company mapping, which is not always the same name. For example, a Pax8 company named after the billing contact can map to the customer's legal entity in Autotask.
3. **Customers.** Run `autotask_reconcile_resolve_mapping kind=customers action=propose`.
   - The crosswalk gives `high` confidence. A crosswalk company that is **inactive** in Autotask drops to `medium`, with a warning.
   - Your own company (id 0) is proposed as `internal`.
   - An exact Autotask name match is `medium`.
   - Anything else is shown as unmatched. It is never guessed.
   - Then run `action=accept` (saves the high-confidence proposals) or `action=set` for individual decisions.
4. **SKUs → offerings.** Use `kind=offerings`. Vendor fees are proposed as `not_billable`.
5. **Autotask services → offerings.** Use `kind=catalog`. Each service's term is read from its name, e.g. *"[NCE] Annual - Billed Monthly"* = AM.
   - A service whose name doesn't state its term is `medium`; confirm the term.
   - A known manufacturer rename (*Project Plan 5* → *Planner and Project Plan 5*, *Microsoft 365 Domestic Calling Plan* → *Microsoft Teams Domestic Calling Plan*, *Business Apps* → *Microsoft 365 Apps for Business*) is proposed at `medium`; confirm it.
   - Other similar names (*Office 365 E5* vs *Microsoft 365 E5*, a different product) are only **suggested**. Link them with `action=set`.
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
   - **Catalog price** = the vendor cost and, once a pricing policy is set, the policy target (retail ± uplift, never below the margin floor on cost); with no policy, the vendor’s suggested price.
   - **Create** missing terms from the vendor cost and suggested price, copying a sibling service's work type (any service of the same manufacturer; "NinjaOne (Dropsuite)" counts as NinjaOne).
   - A term with no service, no vendor price and no vendor line is **not offered**: it is skipped (counted in the summary), not a blocked create. Add a price for it to have it created.
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

1. `autotask_reconcile_vendor_to_autotask invoiceNumber=…` matches each vendor line to the customer's contract lines for the same product and term. Lines are matched by the manufacturer offering, never the sales channel.
   - **Which contracts:** every *Recurring Service* contract of the customer that is active and in effect for the invoice month. A matching line on a contract that starts later, ended earlier or is another type is named in the reason, not matched. For example, a renewal that starts next year means the current month is not billed.
   - **Bundles:** a service bundle on a contract covers each of its component services. The components count toward quantity. The bundle gets its own row comparing its price with the landed cost of its parts: the vendor cost where this vendor supplies the part, otherwise the service's catalog cost.
   - **Cost Should Be** is the vendor's landed unit cost (quantity-weighted, plus processing fees when the policy allocates them).
   - **Price Should Be** comes from the pricing policy.
   - **Billed** is the posted recurring BillingItem for that month. A loss counts as *confirmed* only when an invoice was posted; otherwise it is *unverified*.
   - **The other direction:** a contract line is `not_purchased` when it bills a product this vendor supplies but the vendor has no charge for that customer. This is usually a cancelled subscription still billed to the customer. Annual-billed (AA) subscriptions appear on one invoice a year, so those are checked against the last 13 months of imports.
   - **Not billed, two checks first:** if the customer has a line on a contract in effect whose service has a similar name but is not linked to a product, the row is `review` + `unlinked_service` ("link it and re-run"), not critical. If a back-bill charge (named "… — back-bill <month> [– <month>]") covers the invoice month, a `not_billed` or `qty_short` row becomes `info` + `backbilled`, with no exposure, and the plan proposes no second back-bill.
   - The run is saved, and a run with critical rows sends the `reconcile.critical` notification.
2. Exceptions, by severity:

   | Severity | Exceptions |
   |---|---|
   | critical | `below_cost`, `not_billed` |
   | high | `qty_short`, `term_mismatch`, `cost_stale`, `inactive_company`, `not_purchased` |
   | review | `below_target`, `margin_below_policy`, `negotiated`, `qty_over`, `billed_on_multiple_lines`, `unmapped_customer`, `unmapped_sku`, `unlinked_service`, `proration_credit` |
   | info | `not_customer_billable` (internal / NFR), `backbilled` |

   `autotask_reconcile_get_exceptions` lists them and can update one (status `open` | `acknowledged` | `resolved` | `accepted`, plus an owner and a note). Each update is kept in the exception's history. An exception that comes back in a later run reopens. Mark a `not_purchased` line `accepted` when the customer buys that product from another vendor.
3. `autotask_vendor_pricing_policy` sets the policy and is versioned. Policy can be set globally, per manufacturer or per offering:
   - **Modes:** `vendor_suggested`, `margin`, `markup`.
     - `vendor_suggested` is the vendor’s suggested retail price. With `pct` it is retail plus that percentage (`pct: 5` = 5% over retail).
     - Example, "retail or a small margin over it": `mode: vendor_suggested, pct: 5, marginFloor: 10` prices at retail + 5%, but never below a 10% margin on cost (for products whose retail is at or below cost).
   - **Margin floor:** the lowest margin allowed. Bundles use the global floor.
   - **Fees:** `overhead` or `allocate` (allocated fees are spread into the landed cost).
   - **Negotiated prices:** `set_negotiated` records one per customer. A negotiated price always wins: it becomes the target, and a plan moves billing up to it, never past it or away from it.
   - Price Should Be is never below cost.
4. `autotask_reconcile_export_workbook` returns the Excel workbook (`contentBase64`). Its sheets are Executive Summary, Exceptions, All Vendor Lines, Customer Contracts, Unmatched Internal NFR, Approved Changes, Execution Audit and Pricing Policy.
5. `autotask_pricing_build_change_plan` builds a frozen contract plan from the run. The effective date defaults to the 1st of next month; earlier months are never back-billed. Then use `autotask_change_plan_review` and `autotask_change_plan_execute`, the same as for the catalog. Row kinds (`include`):
   - **cost:** updates `ContractServices.unitCost` (cost only).
   - **price:** an adjustment with the new unit price, on a contract service or a bundle. `ContractServices.unitPrice` is read-only in the API.
   - **quantity:** the primary line follows the vendor quantity, up *or down*. Seats beyond a bundle's units are added as a standalone line next to it. A bundle is never shrunk automatically.
   - **missing_line:** one adjustment that adds the standard service to the customer's contract, with its units and price.
   - **term:** a line on a different term than the vendor sells moves to the standard service for the vendor's term. This takes two rows: add the new line, then end the old one. The second row runs only after the first is in. The move changes the customer's commitment, so agree it with them first.
   - **end_line:** sets units to 0 on a `not_purchased` line. Approve it only once you know the subscription was cancelled.
   - **Blocked rows:**
     - the contract isn't a Recurring Service contract in effect on the effective date (renew it first);
     - the period has already been invoiced;
     - no standard service exists yet (run the catalog plan first);
     - the customer has no contract to add it to, or more than one (pass `contractChoices`);
     - fewer vendor seats than a bundle's units (change the bundle by hand).
6. `autotask_reconcile_check_sync_drift` re-reads what executed plans wrote. Only the latest approved write to a field or line has to hold; a later plan, or an undo, supersedes an earlier one. If something changed a value back (for example the Pax8 PSA sync), the tool records the drift and sends the `sync.drift` notification.

## Billing that stopped, and back-billing

A contract line that is still on a contract in effect but has **no billing period** for the month bills nothing. This happens when a line was ended, or its contract was set inactive while the vendor kept charging. Reconciliation counts such a line as 0 units ("the line has no billing period for this month"), so it shows as `qty_short`.

To fix it in one plan:
1. If the contract carrying the line was set inactive by mistake, reactivate it (`autotask_update_contract status=1`). Contracts that aren't active are not considered.
2. Re-run `autotask_reconcile_vendor_to_autotask`.
3. Run `autotask_pricing_build_change_plan backbillFrom=YYYY-MM rows=[…]`. Pass the report rows of that customer so other customers' unbilled rows don't come along.

The plan then holds:
- **from the effective date:** the units are restored. When the price is also below cost or target, a single **PRICE + QUANTITY** adjustment carries both. Two adjustments on the same line and date would leave whichever price came last.
- **for the months before:** a **BACK-BILL** row, a one-time contract charge (`ContractCharges`) linked to the line and on the service's billing code. It charges units missing × months × the contract price (`backbillPrice=target` for the new price) and bills at the next Approve & Post.
  - The charge assumes the same shortfall each month; check it against the vendor invoices for those months.
  - When the line did bill inside the window, the charge still covers only the missing units, and the row says so.
  - A re-run never charges twice: a charge with the same name on the contract counts as done.
  - The undo plan can't remove a charge; delete it in Autotask before it is billed.

To make a price above cost stick, set the price first: `autotask_vendor_pricing_policy` with a margin, or `set_negotiated` for that customer. Then build the plan.

## Contract lines: moves, invoice wording, undo

Autotask can't change a contract line's service, and contract price and unit changes exist only as adjustments. These tools build plans; nothing is written until rows are approved and executed.

- **`autotask_contract_plan_move_lines`** moves lines onto another service, keeping the customer's units and price. Each move is two rows: add (or top up) the target service on the same contract, then end the old line. The second row runs only after the first, so the customer is never without the service.
  - `source=duplicates` (default) moves lines from a service that duplicates the standard service for its product and term onto the standard service. Run it after the catalog plan. Then rebuild the catalog plan, which can now deactivate the emptied duplicates: a line with no units from today on no longer counts as "in use".
  - `source=lines` takes explicit `[{ contractServiceId, toServiceId }]`.
- **`autotask_contract_plan_wording`** updates the invoice text of existing contract lines and contract bundles to the catalog's current wording. A contract line keeps the text it had when it was added, so after a rename (Dropsuite → NinjaOne) customers would still see the old name. `match` limits it to lines that mention a word. Exclude rows whose customer-specific wording is intended.
- **`autotask_change_plan_revert planId`** builds an undo plan from the before-values an executed plan kept:
  - fields go back (skipped if they were changed again since);
  - created services are deactivated, because Autotask can't delete them;
  - contract adjustments get a counter-adjustment from the revert date.

  Months already invoiced stay invoiced; credits are a separate decision.

**How writes are verified.** `ContractServiceAdjustments` and `ContractServiceBundleAdjustments` are create-only and nothing on them can be queried, so an adjustment can't be read back. The executor verifies it by its *effect*: the line's unit period from the effective date must show the planned units and price.
- An adjustment written before Autotask shows that period is reported "not verifiable yet". The drift check confirms it later.
- A re-run sees an applied adjustment by the same effect and doesn't create it twice.

**Pilot first.** No contract adjustment has been written through this MCP yet. Before running a batch:
1. Approve the plan.
2. Run one row with `autotask_change_plan_execute rows="<n>"`.
3. Check the line in Autotask.

Good first pilots are one price row, then one missing-line row. A missing-line row adds a service through an adjustment that names the contract and the service but no line, which is the API's way to add a service mid-contract.

## The monthly billing process

Who does what each month. The AI client (e.g. ChatGPT) runs the tools and prepares everything; a person approves. Nothing reaches Autotask until a plan is approved and executed.

| # | Step | Tool | Who |
|---|---|---|---|
| 1 | The vendor invoice arrives: import it (CSV + the customer report) | `autotask_vendor_import_invoice` (or `autotask_vendor_sync`) | AI client |
| 2 | Reconcile it against the customers' contracts | `autotask_reconcile_vendor_to_autotask` | AI client |
| 3 | Decide every critical / high exception: give it an outcome, an owner and a due date | `autotask_reconcile_get_exceptions action=update` | Person decides, AI records |
| 4 | Build the contract plan; tell each customer about their invoice changes | `autotask_pricing_build_change_plan`, `autotask_pricing_customer_notices` | AI builds, person sends the notices |
| 5 | Review and approve the plan rows | `autotask_change_plan_review` | Person |
| 6 | Execute (customer-facing rows wait for the customer's notice) | `autotask_change_plan_execute` | AI, after approval |
| 7 | Before Approve & Post in Autotask: the pre-invoice check | `autotask_billing_preinvoice_check` | AI, then person posts |
| 8 | After posting: next month's reconcile and the drift check confirm it | `autotask_reconcile_check_sync_drift` | AI |

The daily monitor (`autotask_vendor_monitor`) covers the gaps between: a missing import, renewals, contracts ending, overdue exceptions, notices due and drift.

### Step 3: exception outcomes

Every exception ends with an outcome (`autotask_reconcile_get_exceptions action=update keys=[…] status=…`):

| Status | Meaning | Needs |
|---|---|---|
| `open` / `acknowledged` | Still to decide | — |
| `fix_planned` | A change plan fixes it | `reference` = the plan id |
| `billed_elsewhere` | Billed on another company, contract or invoice | `reference` = where |
| `absorbed` | GDS carries the cost (a write-off) | `note` = why |
| `accepted` | An expected variance (e.g. the customer buys it elsewhere) | — |
| `resolved` | Fixed in Autotask | — |

- `owner` and `dueOn` (YYYY-MM-DD) say who decides by when. `overdue: true` lists the ones past due and still undecided, and the monitor sends `vendor.exception_overdue` for them.
- The list splits **open exposure** from **absorbed exposure**, so write-offs stay visible without counting as open.
- A `resolved` exception that comes back next month reopens. The other outcomes stand.

### Step 4: customer notices

`autotask_pricing_customer_notices` reads a contract pricing plan (default: the newest open one):

- **`list`:** per customer, every invoice change the plan makes: price increases, new lines, back-bill charges, term moves and more seats. Each shows old → new, the monthly and one-time difference, the effective date, and whether the notice was recorded and how many days ahead.
- **`export`:** the same as CSV, for a mail merge.
- **`mark_sent`:** records the notice: `{ companyIds | "all", sentOn, method: email | letter | portal | call | waived | other }`. `waived` needs a note. A notice shorter than 30 days before the effective date is flagged.
- **`unmark`:** removes the record.

**Execution waits for it.** An approved row that changes what a customer is invoiced runs only once that customer's notice (or waiver) is recorded. Other rows run. Cost updates, fewer seats and line ends need no notice. The monitor sends `vendor.notice_due` when such a change takes effect within 30 days and nothing is recorded.

### Step 7: the pre-invoice check

Run `autotask_billing_preinvoice_check` (optional `throughDate`, `companyId`) before **Approve & Post**. It only reads. For the posting month it lists:

- **Pending charges:** unbilled contract charges that bill at this posting, with $0 and below-cost warnings.
- **Double billing (STOP):** a back-bill charge for months another line of the same product already bills, for example a prepaid annual line next to a back-bill. Delete the charge in Autotask, or confirm the line is a different seat.
- **Duplicate lines:** one customer billed for the same product on two lines this month.
- **Price changes** taking effect this month, and whether the customer notice is recorded.
- **Undecided critical exceptions** from the latest reconciliation.

The verdict is `stop` (double billing), `review` (anything else) or `ready`. It checks the customers with pending charges plus the latest reconciliation's customers.

## Monitoring

`autotask_vendor_monitor` runs one pass and sends each finding once:
- a vendor with no invoice imported for 35+ days;
- subscriptions on the latest invoice renewing within 30 days (annual commitments can only be reduced at renewal);
- contracts in the latest reconciliation that end within 45 days (plans are blocked past a contract's end);
- sync drift on applied plan changes.
- reconciliation exceptions past their due date and still undecided;
- customer-facing plan changes taking effect within 30 days with no customer notice recorded.

Set `MCP_VENDOR_MONITOR_HOUR_UTC` (0–23) to run it daily at that hour. It is off when unset, and it only reads Autotask.

## Pax8 API (optional)

`autotask_vendor_sync` is off until the Pax8 API credentials are set. To set them up, generate an API key in Pax8 under Integrations → Credentials, then set `PAX8_CLIENT_ID` and `PAX8_CLIENT_SECRET` in the server env. The tool then supports three actions:
- `what=invoices` imports invoices through the same parser as the CSV export.
- `what=pricing` records the cost and suggested price for every mapped SKU and term.
- `what=status` shows the configuration.

The CSV export path keeps working without credentials.
