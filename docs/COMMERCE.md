# Commerce: sell, set up and track through Autotask

Sell recurring plans, add-ons and one-time services, and let one sign-up set the customer up in Autotask:
company, users, contract, services, delivery ticket and charges — then follow it to its invoice and payment.
The order tools return everything as data, so a website or portal can drive the whole flow.

## Offerings

`autotask_commerce_offerings action=set` saves an offering (Postgres; nothing in Autotask changes):

| Field | |
|---|---|
| `code`, `name`, `platform` | e.g. `psarelay-pro`, "PSArelay Pro", `PSArelay` |
| `kind` | `recurring` (a plan or add-on) or `one_time` (a service delivered once) |
| `perUnit`, `unitLabel` | price × quantity, e.g. per `user` |
| `autotaskServiceId` | recurring: the Autotask Service billed (its price is used unless `unitPrice` overrides it) |
| `billingCodeId`, `unitPrice` | one-time: a **material** cost code (BillingCodes useType 4) and the price of the charge |
| `delivery` | `{ queueID, status, priority, issueType, subIssueType, title, description, estimatedHours }` — a ticket per order; `title` / `description` may use `{company}` `{quantity}` `{unitLabel}` `{offering}` |
| `contract` | recurring: `{ contractCategory (required by Autotask), termMonths, …other Contracts fields }` |
| `charge` | one-time: extra TicketCharges fields (`chargeType`, `status`, …) |
| `modules` | the platform modules it unlocks |

`set` checks what the offering points at (reads only): the Service exists and is active, the billing code is a
material code. `archive` / `restore` take an offering off sale without touching existing orders.

## Quote and order

`autotask_commerce_quote { lines: [{ offering, quantity }] }` prices an order: each line, one-time and recurring
totals, the modules it unlocks.

`autotask_commerce_order action=create` places it:

```json
{
  "customer": { "companyName": "Example Dental", "phone": "555-0100", "city": "Atlanta" },
  "contacts": [
    { "firstName": "Avery", "lastName": "Lee", "emailAddress": "avery@example.com" },
    { "firstName": "Sam", "lastName": "Roe", "emailAddress": "sam@example.com" }
  ],
  "lines": [{ "offering": "psarelay-pro", "quantity": 2 }, { "offering": "security-audit" }],
  "startDate": "2026-11-01"
}
```

It builds **one change plan** (kind `commerce_order`):

1. **Company** — new customers only. Refused when a company with that name exists (order with its `companyId`).
2. **Users** — a contact per person; the first is the primary contact.
3. **Contract** — a recurring service contract for the recurring lines (or `contractId` to use an existing one).
4. **Services** — each recurring line is added by a contract service **adjustment**: units = quantity, from the
   start date (Autotask prorates the period). Verified by its effect on the contract's unit periods.
5. **Delivery tickets** — one per offering that has `delivery`.
6. **One-time charges** — on their delivery ticket.

Rows use the ids that earlier rows create (`meta.refs`), and every step is re-run safe: an interrupted run picks up
where it stopped without creating anything twice. Approve the plan by its hash (`autotask_change_plan_review`) and run
it (`autotask_change_plan_execute`) like any other plan.

## Tracking to invoice and payment

Every 5 minutes (and on `action=status`) each open order is followed, from Autotask, with no writes:

| Status | Means |
|---|---|
| `planned` | plan placed, not run yet |
| `provisioning` / `failed` | plan partly run / a row failed or went stale |
| `provisioned` | company, users, contract and tickets are in Autotask — waiting for the invoice |
| `invoiced` | its charges / contract lines are on an Autotask invoice (BillingItems → Invoices) |
| `paid` | the invoice has a `paidDate` (set when the payment syncs back from the payment platform) |

Each change sends a notification — `commerce.order_ready`, `commerce.order_invoiced`, `commerce.order_paid`,
`commerce.order_failed`. Subscribe a **generic webhook** channel (console → Notifications) and a control plane can build
the customer's account, send onboarding and offer a call the moment an order is paid.

`action=invoice_queue` lists orders set up and waiting for their invoice; `mark_paid` records a payment taken outside
Autotask; `cancel` stops an order before it is set up.

## Invoicing

Autotask's REST API can't create invoices or approve and post billing items — that stays an Autotask step
(Approve & Post, then invoice, or a technician's invoice from the ticket). The order flow is built so that step is
the only one: everything before it is created by the plan, everything after it is tracked automatically. An
automated invoice runner (a dedicated, limited Autotask user driving that step for exactly the order's items) can
work from `invoice_queue`.
