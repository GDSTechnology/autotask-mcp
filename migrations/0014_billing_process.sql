-- 0014_billing_process — the monthly billing process around the reconciliation:
--
--   reconciliation_exception_state (+ due_on, reference)
--             an exception's OUTCOME: absorbed (GDS carries the cost), billed_elsewhere
--             (reference says where), fix_planned (reference = the plan), with an owner
--             and a due date; overdue ones are reported by the vendor monitor.
--   price_change_notice
--             a customer was told about the price changes in a contract plan (or the
--             notice was waived). Executing a plan's customer-facing rows (price
--             increases, new lines, back-bills, term moves) waits until it is recorded.
--   capability_gap
--             what the MCP couldn't do: reported by an agent (autotask_report_gap), by
--             a person in the console, or captured automatically (an unknown tool was
--             called). Console → Requests; status open | planned | built | declined | duplicate.

ALTER TABLE reconciliation_exception_state ADD COLUMN IF NOT EXISTS due_on date;
ALTER TABLE reconciliation_exception_state ADD COLUMN IF NOT EXISTS reference text;

CREATE TABLE IF NOT EXISTS price_change_notice (
  plan_id      uuid        NOT NULL,
  company_id   bigint      NOT NULL,
  sent_on      date        NOT NULL,
  method       text        NOT NULL,   -- email | letter | portal | call | waived | other
  note         text,
  recorded_by  text,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (plan_id, company_id)
);

CREATE TABLE IF NOT EXISTS capability_gap (
  id           bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dedupe_key   text        NOT NULL UNIQUE,
  title        text        NOT NULL,
  detail       text,
  source       text        NOT NULL,   -- agent | console | auto
  reporter     text,
  tool_tried   text,
  example      jsonb,
  status       text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'planned', 'built', 'declined', 'duplicate')),
  priority     text        NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high')),
  resolution   text,
  occurrences  integer     NOT NULL DEFAULT 1,
  first_seen   timestamptz NOT NULL DEFAULT now(),
  last_seen    timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  updated_by   text
);
CREATE INDEX IF NOT EXISTS capability_gap_status ON capability_gap (status, last_seen DESC);
