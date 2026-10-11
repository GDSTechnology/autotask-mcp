-- 0011_change_plans — frozen, row-approved change plans for Autotask catalog
-- and pricing changes (GDS reconciliation requirements §3 / §8), plus the
-- vendor price reference the plans price from.
--
-- A plan is built read-only, then FROZEN: its rows (before → after for each
-- target) and a hash never change. A person approves rows (all, or "3-15
-- except 9") — natural-language discussion alone never writes. Execution
-- re-reads every target first; a row whose target changed since the plan was
-- built is skipped as STALE (rebuild the plan), never written over. Every row
-- records who approved it, the write, and the read-back verification.

CREATE TABLE IF NOT EXISTS change_plan (
  id           uuid        PRIMARY KEY,
  kind         text        NOT NULL,            -- catalog_standardize | contract_pricing | …
  title        text        NOT NULL,
  params       jsonb,
  hash         text        NOT NULL,
  status       text        NOT NULL,            -- open | executing | done | superseded
  created_by   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS change_plan_row (
  plan_id      uuid        NOT NULL REFERENCES change_plan (id) ON DELETE CASCADE,
  row_no       integer     NOT NULL,
  action       text        NOT NULL,            -- create | update | deactivate | info
  entity       text        NOT NULL,            -- Services | ContractServices | …
  target_id    bigint,                          -- null for create
  label        text        NOT NULL,            -- human summary of the row
  before       jsonb,                           -- the fields this row changes, as read when planned
  after        jsonb,                           -- what they become
  reason       text,
  blocked      text,                            -- why the row cannot run (missing price, in use, …) — never approvable
  status       text        NOT NULL DEFAULT 'pending',  -- pending | approved | excluded | applied | failed | stale | skipped
  approved_by  text,
  approved_at  timestamptz,
  result       jsonb,                           -- written id, read-back, error
  executed_at  timestamptz,
  meta         jsonb,                           -- bookkeeping for after the write; never sent to Autotask
  PRIMARY KEY (plan_id, row_no)
);

-- Vendor price reference: partner cost and the vendor's suggested price per SKU
-- and term, with where each came from (an invoice line, a price list, manual).
CREATE TABLE IF NOT EXISTS vendor_price (
  id              bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  vendor          text        NOT NULL,
  sku             text        NOT NULL,
  cadence         text        NOT NULL,         -- MM | AM | AA | monthly | annual
  unit_cost       numeric(14, 6),
  suggested_price numeric(14, 6),
  -- per what? 'month' for MM / AM / monthly; 'year' for AA / annual
  per             text        NOT NULL,
  currency        text        NOT NULL DEFAULT 'USD',
  source          text        NOT NULL,         -- invoice:<number> | price_list | manual
  effective_date  date        NOT NULL,
  recorded_by     text,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (vendor, sku, cadence, effective_date, source)
);
CREATE INDEX IF NOT EXISTS vendor_price_lookup ON vendor_price (vendor, sku, cadence, effective_date DESC);
