-- 0017_commerce — sell, bill and deliver through Autotask: an offering catalog and orders.
--
-- An OFFERING is something you sell: a recurring plan or add-on (billed on a recurring service
-- contract as an Autotask service, per unit — e.g. per user) or a one-time service (a charge on the
-- delivery ticket, with a material billing code). Each can carry how it is delivered (a ticket in a
-- queue) and which modules it unlocks on a hosted platform.
-- An ORDER is one sign-up: the customer (an existing company or a new one), their users (contacts),
-- the lines bought and the start date. Placing an order builds ONE change plan (kind commerce_order)
-- that a person approves by hash and the executor runs: company → contacts → contract → services →
-- delivery ticket → charges. Payment is recorded on the order; invoicing stays in Autotask / the
-- billing portal.

CREATE TABLE IF NOT EXISTS commerce_offering (
  code                text        PRIMARY KEY,            -- e.g. psarelay-pro, security-audit
  platform            text,                               -- grouping, e.g. psarelay
  name                text        NOT NULL,
  kind                text        NOT NULL,               -- recurring | one_time
  per_unit            boolean     NOT NULL DEFAULT false, -- price × quantity (e.g. per user)
  unit_label          text        NOT NULL DEFAULT 'user',
  autotask_service_id bigint,                             -- recurring: the Autotask Service billed
  billing_code_id     bigint,                             -- one-time: material cost code of the charge
  unit_price          numeric(12,4),                      -- one-time price; recurring: optional override of the service price
  delivery            jsonb,                              -- { queueID, status, priority, issueType, subIssueType, title, description, estimatedHours }
  contract            jsonb,                              -- recurring: { contractCategory, termMonths, ...extra Contracts fields }
  charge              jsonb,                              -- one-time: { chargeType, status, ...extra TicketCharges fields }
  modules             jsonb       NOT NULL DEFAULT '[]',  -- platform modules this unlocks
  active              boolean     NOT NULL DEFAULT true,
  updated_by          text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS commerce_order (
  id          uuid        PRIMARY KEY,
  status      text        NOT NULL,                       -- planned | provisioning | provisioned | failed | cancelled
  customer    jsonb       NOT NULL,                       -- { companyId } or { companyName, phone, address… }
  contacts    jsonb       NOT NULL DEFAULT '[]',
  lines       jsonb       NOT NULL,                       -- [{ offering, quantity, unitPrice, … }] as quoted
  totals      jsonb,
  start_date  date        NOT NULL,
  plan_id     uuid,
  company_id  bigint,
  contract_id bigint,
  ticket_ids  jsonb       NOT NULL DEFAULT '[]',
  payment     jsonb       NOT NULL DEFAULT '{"status":"unpaid"}',  -- { status: unpaid|paid|invoiced, method, reference, amount, at, by }
  notes       text,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS commerce_order_created ON commerce_order (created_at DESC);
CREATE INDEX IF NOT EXISTS commerce_order_plan ON commerce_order (plan_id);
