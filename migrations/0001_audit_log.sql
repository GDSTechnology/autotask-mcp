-- 0001_audit_log — persistent audit trail (Expansion Spec §23, #18).
--
-- One row per tool invocation. Mirrors the structured log record emitted by
-- utils/audit.ts (the source of truth). Written by the app role when
-- MCP_PG_AUDIT_ENABLED=true; the structured stderr log is always emitted too.
-- Runs as the owner role (the migration runner SET ROLEs to owner), so the app
-- role's default INSERT/SELECT privileges apply automatically.

CREATE TABLE IF NOT EXISTS audit_log (
  id                     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at            timestamptz NOT NULL DEFAULT now(),
  tool                   text        NOT NULL,
  outcome                text        NOT NULL,
  duration_ms            integer     NOT NULL,
  source                 text        NOT NULL,
  correlation_id         text,
  requesting_user_email  text,
  autotask_resource_id   bigint,
  conversation_id        text,
  idempotency_key        text,
  intent                 text,
  result_id              bigint,
  error                  text
);

CREATE INDEX IF NOT EXISTS audit_log_occurred_at_idx  ON audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_tool_idx          ON audit_log (tool);
CREATE INDEX IF NOT EXISTS audit_log_correlation_idx   ON audit_log (correlation_id);
CREATE INDEX IF NOT EXISTS audit_log_user_idx          ON audit_log (requesting_user_email);
