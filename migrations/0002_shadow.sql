-- 0002_shadow — read-only mirror of selected Autotask entities (Expansion Spec
-- §21.1, issue #18). Autotask stays authoritative: every write still goes to
-- Autotask; these rows are a cache that heavy reads / reports query instead of
-- spending the shared Autotask API budget. Rows carry when they were synced so
-- every answer can say how fresh it is.
--
-- One generic table keyed by (entity, id) holding the record as jsonb. Equality
-- filters use jsonb containment (data @> {"field": value}), served by the GIN
-- index; ranges use the expression indexes below on the hot fields.

CREATE TABLE IF NOT EXISTS shadow_record (
  entity       text        NOT NULL,
  id           bigint      NOT NULL,
  data         jsonb       NOT NULL,
  modified_at  timestamptz,
  synced_at    timestamptz NOT NULL DEFAULT now(),
  deleted_at   timestamptz,
  PRIMARY KEY (entity, id)
);

CREATE INDEX IF NOT EXISTS shadow_record_data_gin   ON shadow_record USING gin (data jsonb_path_ops);
CREATE INDEX IF NOT EXISTS shadow_record_modified   ON shadow_record (entity, modified_at);
CREATE INDEX IF NOT EXISTS shadow_record_company    ON shadow_record (entity, ((data->>'companyID')));
CREATE INDEX IF NOT EXISTS shadow_record_ticket     ON shadow_record (entity, ((data->>'ticketID')));
CREATE INDEX IF NOT EXISTS shadow_record_contract   ON shadow_record (entity, ((data->>'contractID')));
CREATE INDEX IF NOT EXISTS shadow_record_resource   ON shadow_record (entity, ((data->>'resourceID')));
CREATE INDEX IF NOT EXISTS shadow_record_dateworked ON shadow_record (entity, ((data->>'dateWorked')));
CREATE INDEX IF NOT EXISTS shadow_record_createdate ON shadow_record (entity, ((data->>'createDate')));

-- Per-entity sync bookkeeping: the incremental watermark, the backfill cursor,
-- and when each kind of run last succeeded.
CREATE TABLE IF NOT EXISTS shadow_sync_state (
  entity              text PRIMARY KEY,
  watermark           timestamptz,
  backfill_cursor     bigint      NOT NULL DEFAULT 0,
  backfill_done       boolean     NOT NULL DEFAULT false,
  -- History window the backfill covered (null = everything). Reads asking for
  -- older data than this go live.
  window_from         timestamptz,
  last_backfill_at    timestamptz,
  last_incremental_at timestamptz,
  last_full_at        timestamptz,
  last_reconcile_at   timestamptz,
  row_count           bigint      NOT NULL DEFAULT 0,
  api_calls_total     bigint      NOT NULL DEFAULT 0,
  last_error          text,
  last_error_at       timestamptz,
  updated_at          timestamptz NOT NULL DEFAULT now()
);
