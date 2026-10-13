-- 0013_call_stats — the console's hourly traffic counts, kept across restarts.
--
-- The MCP counts, per hour, in memory (services/call-log.ts):
--   read      per Autotask entity: reads answered by Autotask vs the read cache vs
--             the Postgres shadow, plus writes and which tools caused the reads
--             (console → Calls → Reads by entity: what to cache or mirror next)
--   gap       per raw_request shape (e.g. "POST /Tickets/query"): calls, failures,
--             callers (console → Calls → Tool gaps: which tools to build)
--   fallback  a tool failed and the same caller then used raw_request
-- Without this table those counts reset on every restart / deploy. The server
-- writes the current hour every few minutes and reads the last 7 days back at
-- start. Rows older than 8 days are deleted.

CREATE TABLE IF NOT EXISTS mcp_call_stat_hour (
  hour        integer     NOT NULL,   -- hours since the Unix epoch (UTC)
  kind        text        NOT NULL CHECK (kind IN ('read', 'gap', 'fallback')),
  key         text        NOT NULL,   -- entity, raw_request shape, or "tool|raw shape"
  data        jsonb       NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (hour, kind, key)
);

CREATE INDEX IF NOT EXISTS mcp_call_stat_hour_hour ON mcp_call_stat_hour (hour);
