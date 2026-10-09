-- 0009_history_backfill — resumable, budgeted historical backfill jobs
-- (autotask_backfill_history, gap register MCP-006).
--
-- A job walks the tickets COMPLETED in [range_from, range_to) in id order and
-- stores their history, notes and time entries in audit_event (the ledger the
-- activity feed reads). Each tool call advances the job by at most its
-- maxApiCalls; `cursor` is the last ticket id fully processed, so a job resumes
-- exactly where it stopped and re-running a step is idempotent.

CREATE TABLE IF NOT EXISTS history_backfill_job (
  id               uuid        PRIMARY KEY,
  range_from       timestamptz NOT NULL,
  range_to         timestamptz NOT NULL,
  sources          text[]      NOT NULL,
  cursor           bigint      NOT NULL DEFAULT 0,
  status           text        NOT NULL,          -- running | done | failed
  tickets_total    integer,
  tickets_done     integer     NOT NULL DEFAULT 0,
  events_ingested  integer     NOT NULL DEFAULT 0,
  api_calls        integer     NOT NULL DEFAULT 0,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
