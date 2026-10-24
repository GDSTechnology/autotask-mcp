---
title: Commerce — sell, set up, get paid
description: An offering catalog and orders that set a customer up in Autotask in one approved plan, then track the order to its invoice and payment.
---

Sell recurring plans, add-ons and one-time services. One sign-up becomes **one change plan** that creates, in
order: the **company** (new customers), its **users**, a **recurring contract**, the **services** (per user, from
the start date — Autotask prorates), a **delivery ticket** and any **one-time charges**. Each step uses the ids the
earlier steps created, and an interrupted run picks up where it stopped.

Then PSArelay follows the order — from Autotask, every 5 minutes — through **provisioned → invoiced → paid**
(the invoice's paid date, set when the payment syncs back) and notifies each step. A webhook on
`commerce.order_paid` is all a portal needs to build the account and start onboarding.

| Tool | |
|---|---|
| `autotask_commerce_offerings` | the catalog: recurring plans and add-ons (an Autotask Service, per unit), one-time services (a material billing code and a price), delivery ticket, contract defaults, modules unlocked |
| `autotask_commerce_quote` | price an order: lines, one-time and recurring totals, modules |
| `autotask_commerce_order` | place it (one plan), follow it (`status`, `track`), list what waits for an invoice (`invoice_queue`), record an outside payment, cancel before set-up |

Autotask's API can't create invoices, so invoicing stays Autotask's step; everything before and after it is automatic.

Full details: [docs/COMMERCE.md](https://github.com/GDSTechnology/psarelay/blob/main/docs/COMMERCE.md).
