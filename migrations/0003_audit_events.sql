-- 0003_audit_events — normalized Autotask audit event ledger (resource
-- activity / daily labor reconciliation).
--
-- One row per attributable event, from several sources, each tagged:
--   ticket_history  TicketHistory rows (fetched per ticket, cached here — a past
--                   day's history never changes, so it is fetched once)
--   webhook         Autotask webhook callouts (PersonID = who acted in the UI)
--   row_diff        a mirrored row changed between syncs (old → new; the
--                   editor is unknown unless the entity records it)
-- Events derived from records (notes, time entries, service calls, …) are
-- computed on demand from the shadow / live API and not stored here.

CREATE TABLE IF NOT EXISTS audit_event (
  id                 bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_key          text        NOT NULL UNIQUE,
  occurred_at        timestamptz NOT NULL,
  resource_id        bigint,
  action             text        NOT NULL,
  entity_type        text        NOT NULL,
  entity_id          bigint      NOT NULL,
  entity_reference   text,
  parent_entity_type text,
  parent_entity_id   bigint,
  company_id         bigint,
  field              text,
  old_value          text,
  new_value          text,
  source             text        NOT NULL,
  system_generated   boolean     NOT NULL DEFAULT false,
  details            jsonb,
  ingested_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_event_resource_time ON audit_event (resource_id, occurred_at);
CREATE INDEX IF NOT EXISTS audit_event_time          ON audit_event (occurred_at);
CREATE INDEX IF NOT EXISTS audit_event_entity        ON audit_event (entity_type, entity_id);

-- Which tickets' history is already in audit_event, and as of when: a ticket is
-- re-read only when it changed after that (lastTrackedModificationDateTime).
CREATE TABLE IF NOT EXISTS ticket_history_fetch (
  ticket_id   bigint      PRIMARY KEY,
  fetched_at  timestamptz NOT NULL
);
