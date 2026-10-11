-- 0012_reconciliation — vendor ↔ customer-contract reconciliation runs,
-- durable exception tracking, pricing policy, and sync-drift events
-- (GDS reconciliation requirements §4–§9).
--
--   reconciliation_run       one run: which vendor invoice, when, by whom, summary
--   reconciliation_row       every matched / unmatched vendor group in the run, with
--                            the full comparison (the report + workbook rows)
--   reconciliation_exception_state  an exception's owner / status / history ACROSS runs,
--                            keyed by a stable exception key (same issue next month =
--                            same row, its history kept)
--   pricing_policy           how "Price Should Be" is set, per manufacturer / offering
--   customer_pricing_exception  a negotiated customer price (kept, not flagged every month)
--   sync_drift_event         an approved change that something reverted / overwrote

CREATE TABLE IF NOT EXISTS reconciliation_run (
  id             uuid        PRIMARY KEY,
  vendor         text        NOT NULL,
  document_id    bigint      REFERENCES vendor_source_document (id),
  invoice_number text,
  period_start   date,
  period_end     date,
  params         jsonb,
  summary        jsonb,
  created_by     text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reconciliation_row (
  run_id         uuid        NOT NULL REFERENCES reconciliation_run (id) ON DELETE CASCADE,
  row_no         integer     NOT NULL,
  exception_key  text,
  severity       text        NOT NULL,     -- critical | high | review | info | ok
  exception_type text,                     -- below_cost | not_billed | qty_short | term_mismatch | …
  company_id     bigint,
  contract_id    bigint,
  contract_service_id bigint,
  offering_id    bigint,
  data           jsonb       NOT NULL,     -- every column of the report
  PRIMARY KEY (run_id, row_no)
);
CREATE INDEX IF NOT EXISTS reconciliation_row_key ON reconciliation_row (exception_key);

CREATE TABLE IF NOT EXISTS reconciliation_exception_state (
  exception_key  text        PRIMARY KEY,
  status         text        NOT NULL DEFAULT 'open',  -- open | acknowledged | resolved | accepted
  owner          text,
  history        jsonb       NOT NULL DEFAULT '[]',    -- [{ at, by, status, owner, note }]
  first_seen_run uuid,
  last_seen_run  uuid,
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pricing_policy (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- scope: '*' (default) | manufacturer name | 'offering:<id>'
  scope         text        NOT NULL,
  -- vendor_suggested | margin (price = cost / (1 - pct)) | markup (price = cost × (1 + pct))
  mode          text        NOT NULL,
  pct           numeric(6, 4),
  -- never propose below this margin (fraction) whatever the mode
  margin_floor  numeric(6, 4),
  -- how vendor fees (e.g. the card surcharge) count: overhead | allocate (into landed cost)
  fee_policy    text        NOT NULL DEFAULT 'overhead',
  note          text,
  decided_by    text,
  decided_at    timestamptz NOT NULL DEFAULT now(),
  superseded_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS pricing_policy_current ON pricing_policy (scope) WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS customer_pricing_exception (
  id                  bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  autotask_company_id bigint      NOT NULL,
  offering_id         bigint      NOT NULL REFERENCES canonical_offering (id),
  cadence             text        NOT NULL DEFAULT '',
  agreed_unit_price   numeric(14, 6) NOT NULL,
  reason              text        NOT NULL,
  expires_on          date,
  decided_by          text,
  decided_at          timestamptz NOT NULL DEFAULT now(),
  superseded_at       timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS customer_pricing_exception_current ON customer_pricing_exception (autotask_company_id, offering_id, cadence) WHERE superseded_at IS NULL;

CREATE TABLE IF NOT EXISTS sync_drift_event (
  id            bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  plan_id       uuid        NOT NULL,
  row_no        integer     NOT NULL,
  entity        text        NOT NULL,
  target_id     bigint,
  field         text        NOT NULL,
  approved_value text,
  current_value text,
  detected_at   timestamptz NOT NULL DEFAULT now(),
  resolved_at   timestamptz,
  UNIQUE (plan_id, row_no, field, current_value)
);
