---
title: Vendor billing reconciliation
description: Compare what vendors charge you with what your Autotask contracts bill, find the losses, and fix them with reviewed plans.
---

The vendor-billing tools answer a question that otherwise takes days of opening contracts: **are we billing
customers for everything the vendor charges us — and at the right price?** Pax8 is the first vendor adapter.

## The flow

1. **Import** vendor invoices (`autotask_vendor_import_invoice`, or a scheduled `autotask_vendor_sync`). Every line
   is kept with its charge class and cadence. Nothing in Autotask changes.
2. **Map** vendor customers and SKUs to Autotask companies and products; suggestions come with evidence.
3. **Reconcile** (`autotask_reconcile_vendor_to_autotask`): per customer and product — billed correctly, not billed,
   quantity differs, priced under cost, unlinked service — confirmed against posted billing items, not just contract
   prices.
4. **Price** with a policy (`autotask_vendor_pricing_policy`): e.g. vendor list price plus a percentage, with a
   margin floor when list is below cost.
5. **Fix** with change plans: price adjustments, missing contract lines, back-bills — each reviewed by hash before
   execution, with customer **price-change notices** recorded before customer-facing changes run.
6. **Before invoicing**, `autotask_billing_preinvoice_check` catches duplicates and gaps; exceptions get an
   outcome (absorbed, billed elsewhere, fix planned), an owner and a due date, and the monitor flags overdue ones.

Full details: [docs/VENDOR_BILLING.md](https://github.com/GDSTechnology/psarelay/blob/main/docs/VENDOR_BILLING.md).
