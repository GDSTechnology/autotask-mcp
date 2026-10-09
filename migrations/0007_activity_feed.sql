-- 0007_activity_feed — checkpoints for the incremental activity feed
-- (autotask_get_activity_feed, gap register MCP-002 / MCP-003).
--
-- The feed is served from audit_event in INGESTION order: audit_event.id is
-- the cursor, so an event that arrives late (a ticket whose history is read
-- after newer events were stored) still gets a higher id and is never skipped
-- by a reader that already passed its occurred_at. Re-ingesting is idempotent
-- (event_key is unique).
--
-- One row per ingested source (tickets / ticketNotes / timeEntries):
--   watermark     source timestamp everything before which is in audit_event
--                 (re-scanned with an overlap, so late shadow syncs are caught)
--   covered_from  earliest instant the feed has ingested for this source;
--                 a reader asking for earlier events is told so, not served gaps

CREATE TABLE IF NOT EXISTS activity_feed_checkpoint (
  source        text        PRIMARY KEY,
  watermark     timestamptz NOT NULL,
  covered_from  timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Feed reads by ticket: a ticket's own events (entity) and its notes / time (parent).
CREATE INDEX IF NOT EXISTS audit_event_parent ON audit_event (parent_entity_type, parent_entity_id);
