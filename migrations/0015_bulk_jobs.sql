-- 0015_bulk_jobs — mass changes staged against the mirror, pushed to Autotask at a set pace.
--
-- A bulk job is prepared from the Postgres shadow (selection and exclusion checks cost no
-- Autotask writes), reviewed, approved by its hash (the exact list of records), then a
-- background worker pushes one write per item at rate_per_hour, pausing itself on
-- backpressure / 429 / auth trouble, starting with a canary batch. Every item keeps its
-- before-state, result and error, so a job is resumable and auditable.
--   bulk_job        status: preparing → ready → approved → running ⇄ paused → done
--                   (canary: running → paused 'canary' after canary_size items) | cancelled | failed
--   bulk_job_item   one write: entity + record id + action; pending → done | skipped | failed;
--                   excluded items (records with history) are kept for the report, never written.

CREATE TABLE IF NOT EXISTS bulk_job (
  id            uuid        PRIMARY KEY,
  kind          text        NOT NULL,               -- e.g. inactivate_placeholders
  title         text        NOT NULL,
  params        jsonb       NOT NULL DEFAULT '{}',
  status        text        NOT NULL,
  hash          text,
  rate_per_hour integer     NOT NULL DEFAULT 3000,
  canary_size   integer     NOT NULL DEFAULT 50,
  pause_reason  text,
  last_error    text,
  stats         jsonb       NOT NULL DEFAULT '{}',
  created_by    text,
  approved_by   text,
  approved_at   timestamptz,
  started_at    timestamptz,
  finished_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bulk_job_item (
  job_id     uuid        NOT NULL REFERENCES bulk_job (id) ON DELETE CASCADE,
  seq        integer     NOT NULL,
  entity     text        NOT NULL,                  -- Companies | Contacts
  record_id  bigint      NOT NULL,
  parent_id  bigint,                                -- a contact's company (the child route needs it)
  action     text        NOT NULL,                  -- inactivate
  status     text        NOT NULL DEFAULT 'pending', -- pending | done | skipped | failed | excluded
  reason     text,                                  -- why excluded / skipped
  attempts   integer     NOT NULL DEFAULT 0,
  before     jsonb,
  error      text,
  done_at    timestamptz,
  PRIMARY KEY (job_id, seq)
);
CREATE INDEX IF NOT EXISTS bulk_job_item_next ON bulk_job_item (job_id, status, seq);
