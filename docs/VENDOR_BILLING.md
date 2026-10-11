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
